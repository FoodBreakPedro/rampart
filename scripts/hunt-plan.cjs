'use strict';
// What an L2 or L3 hunt dispatches, decided before any agent runs. The coverage ledger, L2 diff scoping, the score and the dashboard
// stay keyed on the fine-grained directory units (coverage.cjs); this module only decides how those units are handed to hunters.
//
//   packGroups(units, {budget})       hunt groups: the units, in sorted order so siblings stay together, packed under a byte budget
//                                     of hunt-worthy source (GROUP_BUDGET_BYTES). A unit over the budget is split by files into
//                                     groups of its own; reachable and background units never share a group. Each group is
//                                     {id: 'g01', units: [ids], paths: [files], bytes, reachable}. Deterministic: the same units
//                                     always give the same groups.
//   bundleClasses(classes, {size})    class bundles: the classes in pack order, cut into the fewest bundles of at most BUNDLE_SIZE,
//                                     as even as possible (12 -> 6 + 6, 7 -> 4 + 3), never mixing two packs (so a bundle never holds
//                                     one class id twice). {id: 'b1', pack, packVersion, classIds}.
//   changedUnits(repo, units, {...})  per unit, whether its source changed since the run that last covered it and whether it can be
//                                     skipped: covered completely, by this hunt engine (HUNT_ENGINE), at these pack versions, with
//                                     every class of the effort, within the layer's cadence, and with no cross-cutting file
//                                     (CROSS_CUTTING) changed anywhere in the repository since.
//   isCrossCutting(path)              true for a file whose change can open a flaw in code elsewhere: middleware, routing and app
//                                     entry files, auth and policy code, config, migrations and SQL, manifests and lockfiles.
//   estimate(groups, bundles, classes) the honest cost estimate of a plan: tokens per hunter from its group's source, and verifiers
//                                     from an expected candidate rate (ESTIMATE). An estimate, never a budget.
// Pure except changedUnits, which runs read-only git commands in the repository.

const { unitOf, classifyFile, LOCKFILES } = require('./coverage.cjs');
const { run: runCmd } = require('./lib/exec.cjs');

// About 120 KB of source per hunter: roughly 30k tokens of reading, which leaves a hunter room to trace callers outside its group.
const GROUP_BUDGET_BYTES = 120 * 1024;
// Classes one hunter hunts in one pass over its group. Low effort's five logic-bug classes are one bundle; twelve are two.
const BUNDLE_SIZE = 6;
const GIT_TIMEOUT_MS = 60000;
// The version of the hunt engine: what decides what a hunter read and how (the source filter of coverage.cjs, grouping, bundle
// size, the hunter prompt and agent definition, the hunter model). A ledger entry records it; a unit is skipped as unchanged only
// when the run that covered it ran this same engine. Bump it with any change to those. 0.4 entries have none and never qualify.
const HUNT_ENGINE = '0.5.0-2';
// A unit skipped as unchanged is hunted again once its last hunt is older than this many days, unless the system's layer sets
// its own cadence (layers.L3.cadenceDays): a skip cannot see flaws that changes elsewhere opened.
const DEFAULT_SKIP_MAX_AGE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

// Files whose change can open a flaw in code of another unit (an auth middleware removed, a route re-registered, an RLS policy
// dropped, a dependency bumped). A change to any of them since a unit's last hunt makes every unit changed. Deliberately wide.
const CROSS_CUTTING = Object.freeze({
  // basename stems (case-insensitive, before the first dot): entry, routing, auth and policy, config
  stems: /^(middleware|proxy|routes?|router|routing|urls|app|server|main|entry|bootstrap|index|gateway|kernel|startup|program|setup|init|_app|_document|_?layout|hooks?\.server|auth.*|.*auth|login|session.*|passport|guards?|policy|policies|permissions?|rbac|acl|roles?|security|csrf|cors|helmet|config.*|.*config|settings|env|environment|constants|firebase|supabase|database|db)$/i,
  // folder names anywhere in the path
  dirs: new Set(['middleware', 'middlewares', 'auth', 'authentication', 'authorization', 'policies', 'policy', 'guards', 'security', 'permissions', 'migrations', 'migrate', 'supabase', 'prisma', 'drizzle', 'schema', 'schemas', 'config', 'configs', 'settings', '.github', 'infra', 'deploy', 'k8s', 'helm', 'terraform']),
  // extensions
  exts: new Set(['sql', 'rules', 'prisma', 'graphql', 'gql', 'tf', 'tfvars', 'hcl', 'bicep', 'rego', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'plist', 'entitlements', 'xml', 'gradle', 'properties', 'env']),
  // manifests (exact basenames); lockfiles come from coverage.LOCKFILES
  names: new Set(['package.json', 'requirements.txt', 'pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile', 'Gemfile', 'go.mod', 'Cargo.toml', 'composer.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'Podfile', 'Package.swift', 'pubspec.yaml', 'mix.exs', 'deno.json', 'tsconfig.json', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'Procfile', 'vercel.json', 'netlify.toml', 'wrangler.toml', 'wrangler.json', 'firebase.json', 'app.json', 'eas.json', '.htaccess', 'nginx.conf', 'Caddyfile', 'AndroidManifest.xml', 'Info.plist']),
});

function isCrossCutting(relPath) {
  const segs = String(relPath).replace(/\\/g, '/').split('/').filter((x) => x && x !== '.');
  const base = segs[segs.length - 1] || '';
  if (segs.length === 1) return true; // a root-level file: config, an entry point or a manifest, more often than not
  if (CROSS_CUTTING.names.has(base) || LOCKFILES.includes(base) || /^\.env/.test(base) || /^Dockerfile/.test(base)) return true;
  if (segs.slice(0, -1).some((d) => CROSS_CUTTING.dirs.has(d.toLowerCase()))) return true;
  const dot = base.lastIndexOf('.');
  if (dot > 0 && CROSS_CUTTING.exts.has(base.slice(dot + 1).toLowerCase())) return true;
  const stem = base.split('.')[0];
  return CROSS_CUTTING.stems.test(stem) || CROSS_CUTTING.stems.test(base.replace(/\.[^.]*$/, ''));
}

// The constants behind estimate(). All are rough averages, documented so the figure can be checked and tuned:
//   bytesPerToken      source text is about 4 bytes per token.
//   hunterBase         the agent definition, the dispatch prompt, the reply and the file listing: about 6k tokens.
//   tracePerHunter     reads outside the group (callers, middleware, config, migrations) and Grep output: about 20k tokens.
//   tracePerClass      the per-class confirm and disprove passes over what was read: about 4k tokens per class.
//   candidatesPerHunter the expected candidates per hunter. A measured medium run of 976 one-class hunters produced 1 candidate;
//                      a bundle hunter reads more code and more classes, so 0.1 is still generous.
// The token figure is a rough context-size estimate: what the agents read once. Real multi-turn runs resend context on every turn
// and can use several times more.
//   verifiersPerCandidate two votes per candidate and a third on a split HIGH or CRITICAL one.
//   verifierTokens     one verifier run: the candidate file, the class text and the traced path, about 50k tokens.
const ESTIMATE = Object.freeze({
  bytesPerToken: 4,
  hunterBase: 6000,
  tracePerHunter: 20000,
  tracePerClass: 4000,
  candidatesPerHunter: 0.1,
  verifiersPerCandidate: 2.2,
  verifierTokens: 50000,
});

const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const pad = (n, width) => String(n).padStart(width, '0');

// ---- packing ------------------------------------------------------------------------------

// The files of one unit as [{path, bytes}], from its paths and sizes (a unit without sizes counts 0 bytes per file).
const filesOf = (u) => (u.paths || []).map((p, i) => ({ path: p, bytes: Array.isArray(u.sizes) && Number.isFinite(u.sizes[i]) ? u.sizes[i] : 0 }));
const bytesOf = (u) => (Number.isFinite(u.bytes) ? u.bytes : filesOf(u).reduce((n, f) => n + f.bytes, 0));

function packGroups(units, { budget = GROUP_BUDGET_BYTES } = {}) {
  if (!Number.isFinite(budget) || budget <= 0) throw new RangeError('budget must be a positive number of bytes');
  const sorted = [...units].sort((a, b) => byString(a.id, b.id));
  const raw = [];
  for (const reachable of [true, false]) {
    let cur = null;
    const close = () => {
      if (cur && cur.paths.length) raw.push(cur);
      cur = null;
    };
    for (const u of sorted.filter((x) => Boolean(x.reachable) === reachable)) {
      const files = filesOf(u);
      if (!files.length) continue;
      const size = bytesOf(u);
      if (size > budget) {
        // A unit over the budget: its files, in order, cut into groups of its own.
        close();
        let part = null;
        for (const f of files) {
          if (part && part.bytes + f.bytes > budget) {
            raw.push(part);
            part = null;
          }
          if (!part) part = { units: [u.id], paths: [], present: raw.some((g) => g.units.includes(u.id)) ? [] : [...(u.present || [])], bytes: 0, reachable };
          part.paths.push(f.path);
          part.bytes += f.bytes;
        }
        if (part) raw.push(part);
        continue;
      }
      if (cur && cur.bytes + size > budget) close();
      if (!cur) cur = { units: [], paths: [], present: [], bytes: 0, reachable };
      cur.units.push(u.id);
      cur.paths.push(...files.map((f) => f.path));
      cur.present.push(...(u.present || []));
      cur.bytes += size;
    }
    close();
  }
  const width = Math.max(2, String(raw.length).length);
  return raw.map((g, i) => ({ id: `g${pad(i + 1, width)}`, ...g }));
}

// ---- bundling -----------------------------------------------------------------------------

function bundleClasses(classes, { size = BUNDLE_SIZE } = {}) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('bundle size must be a positive integer');
  const packs = [];
  for (const c of classes) {
    const last = packs[packs.length - 1];
    if (last && last.pack === c.pack) last.classes.push(c);
    else packs.push({ pack: c.pack, packVersion: c.packVersion, classes: [c] });
  }
  const bundles = [];
  for (const p of packs) {
    const count = Math.ceil(p.classes.length / size);
    const base = Math.floor(p.classes.length / count);
    let extra = p.classes.length % count;
    let at = 0;
    for (let i = 0; i < count; i++) {
      const n = base + (extra > 0 ? 1 : 0);
      if (extra > 0) extra -= 1;
      bundles.push({ pack: p.pack, packVersion: p.packVersion, classIds: p.classes.slice(at, at + n).map((c) => c.classId) });
      at += n;
    }
  }
  return bundles.map((b, i) => ({ id: `b${i + 1}`, ...b }));
}

// ---- incremental --------------------------------------------------------------------------

function git(repo, args) {
  try {
    return runCmd('git', ['-C', repo, '-c', 'core.quotepath=off', ...args], { timeoutMs: GIT_TIMEOUT_MS });
  } catch {
    return { code: -1, stdout: '', stderr: '' };
  }
}

// The repo-relative paths that may differ between commit and the working tree: committed since, staged, unstaged, deleted, the
// untracked files git does not ignore, and every file marked assume-unchanged or skip-worktree (git hides local edits to those).
// null when the commit is unknown or unreachable or git fails ("changed": hunt again).
function changedSince(repo, commit) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{7,64}$/i.test(commit)) return null;
  if (git(repo, ['cat-file', '-e', `${commit}^{commit}`]).code !== 0) return null;
  const diff = git(repo, ['diff', '--relative', '--name-only', '--no-renames', '-z', commit, '--', '.']);
  const others = git(repo, ['ls-files', '-z', '--others', '--exclude-standard', '--', '.']);
  const flagged = git(repo, ['ls-files', '-z', '-v', '--', '.']);
  if (diff.code !== 0 || others.code !== 0 || flagged.code !== 0) return null;
  // `ls-files -v` tags an assume-unchanged file with a lowercase letter and a skip-worktree one with S.
  const hidden = flagged.stdout.split('\0').filter((l) => /^([a-z]|S) /.test(l)).map((l) => l.slice(2));
  return new Set([...diff.stdout.split('\0'), ...others.stdout.split('\0'), ...hidden].filter(Boolean));
}

const samePacks = (a, b) => {
  const ka = Object.keys(a || {});
  return ka.length === Object.keys(b || {}).length && ka.every((k) => a[k] === b[k]);
};

// For each unit: {id, changed, skippable, coveredBy?, reason}. A unit is skippable only when all of these hold:
// - the ledger has it covered for this system and layer, `complete` (no capped hunter, no invalid candidate, every candidate
//   decided with at least two votes), by this hunt engine (HUNT_ENGINE), at exactly these pack versions, with every class in classIds;
// - the run that covered it recorded a clean revision whose commit is still in the repository, and finished no more than
//   maxAgeDays before now;
// - none of the unit's own source files changed since that commit, and no cross-cutting file (isCrossCutting) changed anywhere.
// Anything unknown counts as changed. `changed` (the unit's source or a cross-cutting file differs) is also what assemble uses to
// decide whether earlier classes still count, so it is computed even when the unit is not skippable.
function changedUnits(repo, units, { ledger, runs, system, layer, packs, classIds, maxDepth, maxAgeDays = DEFAULT_SKIP_MAX_AGE_DAYS, now = Date.now() } = {}) {
  const runById = new Map((runs || []).map((r) => [r.runId, r]));
  // Per commit: null (unknown: everything changed), or {all: a cross-cutting file changed, units: Set of changed unit ids}.
  const cache = new Map();
  const changesAt = (commit) => {
    if (!cache.has(commit)) {
      const paths = changedSince(repo, commit);
      if (paths === null) cache.set(commit, null);
      else {
        const list = [...paths].filter((p) => classifyFile(p).kind !== 'excluded' || isCrossCutting(p));
        cache.set(commit, { all: list.some(isCrossCutting), units: new Set(list.map((p) => unitOf(p, maxDepth))) });
      }
    }
    return cache.get(commit);
  };
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  return units.map((u) => {
    const entry = ledger && ledger.units ? ledger.units[`${system}|${layer}|${u.id}`] : undefined;
    if (!entry || entry.status !== 'covered') return { id: u.id, changed: true, skippable: false, reason: 'not covered yet' };
    const run = runById.get(entry.lastRun);
    const rev = run && run.revision;
    let changed = true;
    let why = 'the run that covered it recorded no revision';
    if (rev && rev.commit && rev.dirty === true) why = 'the run that covered it hunted uncommitted changes';
    else if (rev && rev.commit) {
      const at = changesAt(rev.commit);
      if (at === null) why = 'the commit it was hunted at is not in this checkout';
      else if (at.all) why = 'a cross-cutting file (middleware, routing, auth, config, migrations, manifests) changed since its last hunt';
      else {
        changed = at.units.has(u.id);
        why = changed ? 'source changed since its last hunt' : 'unchanged since its last hunt';
      }
    }
    const stamp = run && (run.finishedAt || run.startedAt);
    const age = typeof stamp === 'string' ? (nowMs - Date.parse(stamp)) / DAY_MS : NaN;
    const hunted = new Set(Array.isArray(entry.classes) ? entry.classes : []);
    const checks = [
      [entry.engine === HUNT_ENGINE, 'hunted by another version of the hunt engine'],
      [entry.complete === true, 'its last hunt was incomplete (capped, invalid or undecided candidates, or missing votes)'],
      [samePacks(entry.packVersions, packs), 'covered against other pack versions'],
      [(classIds || []).every((c) => hunted.has(c)), 'not every class of this effort was hunted on it'],
      [Number.isFinite(age) && age <= maxAgeDays, `its last hunt is older than ${maxAgeDays} days`],
    ];
    const failed = checks.find(([ok]) => !ok);
    const skippable = !changed && !failed;
    return { id: u.id, changed, skippable, coveredBy: entry.lastRun, reason: changed ? why : failed ? failed[1] : why };
  });
}

// ---- estimate -----------------------------------------------------------------------------

const tokensOfText = (s) => Math.ceil((typeof s === 'string' ? s.length : 0) / ESTIMATE.bytesPerToken);

// {hunters, hunterTokens, candidates, verifiers, verifierTokens, agents, tokens, sourceBytes}. Every hunter is one group x one
// bundle; its tokens are the group's source plus a fixed overhead and the bundle's class text. Verifiers are not one per hunter:
// they follow the candidates, which are rare.
function estimate(groups, bundles, classes = []) {
  const textOf = new Map(classes.map((c) => [`${c.pack}/${c.classId}`, `${c.title || ''}\n${c.text || ''}`]));
  let hunterTokens = 0;
  for (const g of groups) {
    for (const b of bundles) {
      const classText = b.classIds.reduce((n, id) => n + tokensOfText(textOf.get(`${b.pack}/${id}`)), 0);
      hunterTokens += ESTIMATE.hunterBase + ESTIMATE.tracePerHunter + ESTIMATE.tracePerClass * b.classIds.length + classText
        + Math.ceil(g.bytes / ESTIMATE.bytesPerToken);
    }
  }
  const hunters = groups.length * bundles.length;
  const candidates = hunters * ESTIMATE.candidatesPerHunter;
  const verifiers = Math.ceil(candidates * ESTIMATE.verifiersPerCandidate);
  const verifierTokens = verifiers * ESTIMATE.verifierTokens;
  return {
    hunters, hunterTokens, candidates: Math.round(candidates * 10) / 10, verifiers, verifierTokens,
    agents: hunters + verifiers, tokens: hunterTokens + verifierTokens, sourceBytes: groups.reduce((n, g) => n + g.bytes, 0),
  };
}

module.exports = {
  GROUP_BUDGET_BYTES, BUNDLE_SIZE, ESTIMATE, HUNT_ENGINE, DEFAULT_SKIP_MAX_AGE_DAYS, CROSS_CUTTING, isCrossCutting,
  packGroups, bundleClasses, changedSince, changedUnits, estimate,
};
