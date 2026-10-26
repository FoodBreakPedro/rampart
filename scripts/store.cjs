'use strict';
// The per-user store (spec 5.2): plain JSON and JSONL under RAMPART_HOME (default ~/.rampart).
//   config.json
//   projects/<slug>/project.json, findings.jsonl, dispositions.json, scores.jsonl
//   projects/<slug>/runs/<runId>/run.json, raw/<name>
// Every slug and runId is checked against its format before it reaches a path, and every rewrite goes through a
// temp file in the same directory plus a rename, so a crash never leaves half a file.
// CLI: node scripts/store.cjs <verb> ... (see USAGE). Exit 0 ok, 1 data rejected or not found, 2 usage error.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { rampartHome, machineId, projectDir, runDir, newRunId } = require('./lib/paths.cjs');
const { validate, loadSchema } = require('./lib/validate.cjs');
const { redact } = require('./lib/redact.cjs');
const { writeAtomic } = require('./lib/atomic.cjs');

const SLUG_RE = /^[a-z0-9-]{2,40}$/;
const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;
const RAW_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const DISPOSITIONS = ['fixed', 'false_positive', 'accepted_risk', 'open'];
const FINDING_STATUSES = ['open', 'fixed', 'false_positive', 'accepted_risk', 'regressed'];
const CLASSES = ['verified', 'tool', 'hardening'];
const FINAL_RUN_STATUSES = ['done', 'skipped', 'failed'];
// Fields an upsert replaces on an existing finding. Everything else (id, project, system, layer, source, ruleId,
// status, firstSeen, lastSeen, fixedIn) belongs to the store or to the finding's identity. One exception inside
// the list: a verified finding re-reported as a plain tool hit keeps its class and evidence (see upsertFindings).
const MUTABLE = [
  'title', 'severity', 'confidence', 'cwe', 'location', 'evidence', 'exploitScenario',
  'preconditions', 'recommendation', 'verification', 'externalIds', 'class', 'pack',
];
// A finding's free text: redacted on the way in (upsertFindings).
const TEXT_FIELDS = ['title', 'evidence', 'exploitScenario', 'preconditions', 'recommendation'];

const now = () => new Date().toISOString();
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- guards and file helpers --------------------------------------------------------------

function checkSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new RangeError('slug must be 2 to 40 characters of a-z, 0-9 and "-"');
  }
  return slug;
}

function checkRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    throw new RangeError('runId must look like 2026-10-23T18-02-11Z');
  }
  return runId;
}

const projectFile = (slug, name) => path.join(projectDir(checkSlug(slug)), name);
const runFile = (slug, runId) => path.join(runDir(checkSlug(slug), checkRunId(runId)), 'run.json');

// Text of a file with any BOM removed, or null when it does not exist.
function readOptional(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Parse errors name the file (and line) but never quote the text: it may hold a credential.
function readJson(file, fallback) {
  const text = readOptional(file);
  if (text === null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path.basename(file)} is not valid JSON`);
  }
}

// One row per line; a line that does not parse is corruption and throws. With { tornTail: true } (scores.jsonl only), a last
// line with no newline after it that does not parse is a torn append instead (appendScore is the one write that is not
// atomic, and a crash can cut it short): it is left out rather than blocking every reader, and the next appendScore drops it.
// findings.jsonl is always rewritten whole and atomically, so a cut-off last line there is real damage and throws.
function readJsonl(file, { tornTail = false } = {}) {
  const text = readOptional(file);
  if (text === null) return [];
  const rows = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      rows.push(JSON.parse(line));
    } catch {
      if (tornTail && i === lines.length - 1) return; // the text did not end with a newline: a torn last line
      throw new Error(`${path.basename(file)} line ${i + 1} is not valid JSON`);
    }
  });
  return rows;
}

const parses = (text) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

const toJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const toJsonl = (rows) => rows.map((row) => `${JSON.stringify(row)}\n`).join('');

function assertValid(schemaName, value, label) {
  const { ok, errors } = validate(loadSchema(schemaName), value);
  if (!ok) throw new Error(`${label} is invalid: ${errors.join('; ')}`);
}

// JSON with object keys sorted, so key order alone never counts as a change.
const canon = (value) =>
  JSON.stringify(value, (key, v) =>
    isObject(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v
  );

// What an upsert compares for one mutable field. verification.run names the run that last looked at the finding, so it
// changes on every scan: it is stored (see upsertFindings) but is not a change by itself.
const comparable = (key, value) => (key === 'verification' && isObject(value) ? { ...value, run: undefined } : value);

// ---- projects -----------------------------------------------------------------------------

function listProjects() {
  const root = path.join(rampartHome(), 'projects');
  let names;
  try {
    names = fs.readdirSync(root);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names.filter((n) => SLUG_RE.test(n) && fs.existsSync(path.join(projectDir(n), 'project.json'))).sort();
}

const readProject = (slug) => readJson(projectFile(slug, 'project.json'), null);

// Where a project holds a credential in a field meant for an address: a live.url with userinfo (scheme://user:pass@host, or
// a token as the user) or a host.ssh with a password (user:pass@host). Returns the paths, as the validator names them.
function credentialPaths(project) {
  const found = [];
  (Array.isArray(project.systems) ? project.systems : []).forEach((s, i) => {
    if (!isObject(s)) return;
    const url = isObject(s.live) ? s.live.url : undefined;
    if (typeof url === 'string' && /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(url.trim())) {
      found.push(`systems[${i}].live.url: must not contain credentials (user:password@ or token@ before the host)`);
    }
    const ssh = isObject(s.host) ? s.host.ssh : undefined;
    if (typeof ssh === 'string') {
      const target = ssh.trim().replace(/^ssh:\/\//i, '');
      const at = target.lastIndexOf('@');
      if (at !== -1 && target.slice(0, at).includes(':')) {
        found.push(`systems[${i}].host.ssh: must not contain a password (write user@host)`);
      }
    }
  });
  return found;
}

// Stamps updated (always) and created (when absent: the stored one if the project exists, else now), validates,
// writes. The caller's object is left alone. A credential in live.url or host.ssh is refused like any invalid field: the
// message names the path, never the value, and nothing is written.
function writeProject(project) {
  const stamp = now();
  const probe = isObject(project) ? { ...project, created: project.created || stamp, updated: stamp } : project;
  assertValid('project', probe, 'project');
  const credentials = credentialPaths(probe);
  if (credentials.length) throw new Error(`project is invalid: ${credentials.join('; ')}`);
  const slug = checkSlug(probe.slug);
  const created = project.created || (readProject(slug) || {}).created || stamp;
  const saved = { ...probe, created };
  writeAtomic(projectFile(slug, 'project.json'), toJson(saved));
  return saved;
}

// ---- findings -----------------------------------------------------------------------------

const readFindings = (slug) => readJsonl(projectFile(slug, 'findings.jsonl'));
const writeFindings = (slug, rows) => writeAtomic(projectFile(slug, 'findings.jsonl'), toJsonl(rows));

// A copy of a finding with its free-text fields redacted, so a credential a tool or a model wrote into one never lands.
function redactText(finding) {
  const out = { ...finding };
  for (const key of TEXT_FIELDS) if (typeof out[key] === 'string') out[key] = redact(out[key]);
  return out;
}

// A gitleaks history hit (it names a commit) that was marked fixed: see upsertFindings.
const isRotatedHistoryLeak = (f) =>
  f.status === 'fixed' && f.source === 'gitleaks' && isObject(f.location) && typeof f.location.commit === 'string' && f.location.commit !== '';

// Merge incoming findings into findings.jsonl by id. runId is checked and named in the disposition of a regressed
// finding; a finding itself has no field for it.
// A promotion survives re-scans: if the stored class is 'verified' and the incoming one is 'tool' (the scanner
// re-reporting what triage already confirmed), the stored class and evidence are kept. Other class changes follow
// the incoming finding.
// When a fixed finding reappears it becomes 'regressed', and its record in dispositions.json becomes 'regressed' too, so the
// file never says 'fixed' for a regressed finding. One exception (ruling, final review M3): a gitleaks finding pinned to a
// commit stays fixed when gitleaks reports it again. gitleaks reads the whole history, which cannot un-leak, so for such a
// finding "fixed" means the credential was rotated; it only gets a new lastSeen and counts as unchanged. A secret committed
// again lands at another commit, which is another id and so a new finding.
// A finding whose only difference is verification.run counts as unchanged, but the stored verification still moves to the
// incoming one, so it always names the latest run that saw the finding.
// The free-text fields (TEXT_FIELDS) of every incoming finding are redacted before they are compared or stored.
function upsertFindings(slug, findings, runId) {
  checkSlug(slug);
  checkRunId(runId);
  if (!Array.isArray(findings)) throw new TypeError('findings must be an array');
  findings.forEach((f, i) => assertValid('finding', f, `findings[${i}]`));
  const counts = { added: 0, updated: 0, unchanged: 0, regressed: 0 };
  if (!findings.length) return counts;

  const stamp = now();
  const byId = new Map(readFindings(slug).map((f) => [f.id, f]));
  const regressed = [];
  // The same id twice in one batch is one sighting; the later copy wins.
  for (const incoming of new Map(findings.map((f) => [f.id, redactText(f)])).values()) {
    const cur = byId.get(incoming.id);
    if (!cur) {
      byId.set(incoming.id, { ...incoming, status: 'open', firstSeen: stamp, lastSeen: stamp, updatedAt: stamp });
      counts.added++;
    } else if (cur.status === 'false_positive' || cur.status === 'accepted_risk' || isRotatedHistoryLeak(cur)) {
      cur.lastSeen = stamp;
      counts.unchanged++;
    } else {
      const keepTriage = cur.class === 'verified' && incoming.class === 'tool';
      const changed = MUTABLE.filter(
        (k) =>
          !(keepTriage && (k === 'class' || k === 'evidence')) &&
          incoming[k] !== undefined &&
          canon(comparable(k, incoming[k])) !== canon(comparable(k, cur[k]))
      );
      for (const k of changed) cur[k] = incoming[k];
      if (incoming.verification !== undefined) cur.verification = incoming.verification;
      cur.lastSeen = stamp;
      if (changed.length || cur.status === 'fixed') cur.updatedAt = stamp; // the sync planner pushes on updatedAt
      if (cur.status === 'fixed') {
        cur.status = 'regressed';
        regressed.push(cur.id);
        counts.regressed++;
      } else if (changed.length) counts.updated++;
      else counts.unchanged++;
    }
  }
  if (regressed.length) {
    const dispositions = readDispositions(slug);
    for (const id of regressed) {
      dispositions[id] = { status: 'regressed', reason: `reappeared in run ${runId}`, by: 'rampart', at: stamp };
    }
    writeAtomic(projectFile(slug, 'dispositions.json'), toJson(dispositions));
  }
  writeFindings(slug, [...byId.values()]);
  return counts;
}

// Close the findings a fresh scan of one system no longer reports. Every stored finding with that system and source whose
// status is open or regressed and whose id is not in seenIds (an array or a Set of the ids the scan just reported) becomes
// fixed, and dispositions.json records why: "not reproduced in run <runId>", by rampart. Findings a person triaged
// (false_positive, accepted_risk) and findings already fixed are left alone, as are other systems and other sources.
// source is one source, or a non-empty array of sources the scan answers for together (a dependency scan speaks for every
// dependency tool's findings, whichever tool ran).
// Call it only after a scan that finished: a scan that was skipped says nothing about what is gone. If the finding comes
// back, upsertFindings regresses it like any other fixed finding. An optional filter(finding) narrows the candidates further
// (it only sees findings that qualify otherwise): a scan that covers one page of a system, say, closes only that page's.
// Returns {closed: <number of findings closed>}.
function closeMissing(slug, { system, source, runId, seenIds, filter } = {}) {
  checkSlug(slug);
  checkRunId(runId);
  if (typeof system !== 'string' || system === '') throw new TypeError('system must be a non-empty string');
  const sources = Array.isArray(source) ? source : [source];
  if (!sources.length || sources.some((s) => typeof s !== 'string' || s === '')) {
    throw new TypeError('source must be a non-empty string or a non-empty array of them');
  }
  if (seenIds === null || typeof seenIds !== 'object' || typeof seenIds[Symbol.iterator] !== 'function') {
    throw new TypeError('seenIds must be an array or a Set of finding ids');
  }
  if (filter !== undefined && typeof filter !== 'function') throw new TypeError('filter must be a function');
  const seen = new Set(seenIds);
  const findings = readFindings(slug);
  const candidate = (f) =>
    f.system === system && sources.includes(f.source) && (f.status === 'open' || f.status === 'regressed') && !seen.has(f.id);
  const closing = findings.filter((f) => candidate(f) && (!filter || filter(f)));
  if (!closing.length) return { closed: 0 };

  const stamp = now();
  const dispositions = readDispositions(slug);
  for (const f of closing) {
    f.status = 'fixed';
    f.updatedAt = stamp;
    dispositions[f.id] = { status: 'fixed', reason: `not reproduced in run ${runId}`, by: 'rampart', at: stamp };
  }
  // Records first, as upsertFindings does: a crash in between leaves a record that findings.jsonl does not yet agree with,
  // which the next scan puts right, not a closed finding with no reason.
  writeAtomic(projectFile(slug, 'dispositions.json'), toJson(dispositions));
  writeFindings(slug, findings);
  return { closed: closing.length };
}

function loadFinding(slug, id) {
  const findings = readFindings(slug);
  const finding = findings.find((f) => f.id === id);
  if (!finding) throw new Error(`no finding ${String(id)} in project ${slug}`);
  return { findings, finding };
}

const readDispositions = (slug) => readJson(projectFile(slug, 'dispositions.json'), {});

// Record the decision in dispositions.json and set the finding's status to match.
function setDisposition(slug, id, { status, reason, by, at } = {}) {
  checkSlug(slug);
  if (!DISPOSITIONS.includes(status)) throw new Error(`status must be one of ${DISPOSITIONS.join(', ')}`);
  const { findings, finding } = loadFinding(slug, id);
  const dispositions = readDispositions(slug);
  // A pulled page decision keeps the time it was made (at); anything unparseable falls back to now.
  const when = typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : now();
  dispositions[id] = { status, reason: redact(String(reason ?? '')), by: String(by ?? ''), at: when };
  writeAtomic(projectFile(slug, 'dispositions.json'), toJson(dispositions));
  finding.status = status;
  finding.updatedAt = now(); // the status changed now, whatever time the decision was made (the record keeps that), so a push never misses it
  writeFindings(slug, findings);
  return finding;
}

// Promote or demote a finding (the L1 secrets triage uses it); the note is appended to evidence.
function setClass(slug, id, cls, note) {
  checkSlug(slug);
  if (!CLASSES.includes(cls)) throw new Error(`class must be one of ${CLASSES.join(', ')}`);
  const { findings, finding } = loadFinding(slug, id);
  finding.class = cls;
  finding.updatedAt = now();
  if (note) finding.evidence = `${finding.evidence}; ${redact(String(note))}`;
  writeFindings(slug, findings);
  return finding;
}

// ---- runs ---------------------------------------------------------------------------------

function createRun(slug, { job, layers, systems, executor } = {}) {
  checkSlug(slug);
  const draft = {
    runId: newRunId(), project: slug, job, layers, systems, executor, status: 'running', startedAt: now(),
    counts: { added: 0, updated: 0, unchanged: 0, hardening: 0 },
  };
  assertValid('run', draft, 'run');
  fs.mkdirSync(path.join(projectDir(slug), 'runs'), { recursive: true });
  // The run directory is the claim on the id: if it exists, try the next second.
  for (let t = Date.now(); ; t += 1000) {
    const runId = newRunId(new Date(t));
    try {
      fs.mkdirSync(runDir(slug, runId));
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw err;
    }
    const run = { ...draft, runId };
    writeAtomic(runFile(slug, runId), toJson(run));
    return run;
  }
}

// Merge a patch into run.json. runId and project cannot change; counts merge key by key; a final status stamps
// finishedAt unless the patch brings its own.
function finishRun(slug, runId, patch = {}) {
  const file = runFile(slug, runId);
  if (!isObject(patch)) throw new TypeError('patch must be an object');
  const run = readJson(file, null);
  if (!run) throw new Error(`no run ${runId} in project ${slug}`);
  const counts = isObject(patch.counts) ? { ...run.counts, ...patch.counts } : patch.counts ?? run.counts;
  const merged = { ...run, ...patch, runId: run.runId, project: run.project, counts, updatedAt: patch.updatedAt || now() };
  if (FINAL_RUN_STATUSES.includes(patch.status)) merged.finishedAt = patch.finishedAt || now();
  assertValid('run', merged, 'run');
  writeAtomic(file, toJson(merged));
  return merged;
}

// Every run.json of a project, oldest first (a run id sorts as time). A directory not named like a run id is not a run, and a
// run directory with no run.json (a crash between mkdir and write) has nothing to read; a run.json that is not valid JSON
// throws, naming the run, because a score computed without it would quietly be too low.
function readRuns(slug) {
  checkSlug(slug);
  let entries;
  try {
    entries = fs.readdirSync(path.join(projectDir(slug), 'runs'), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const runs = [];
  for (const runId of entries.filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name)).map((e) => e.name).sort()) {
    let run;
    try {
      run = readJson(runFile(slug, runId), null);
    } catch (err) {
      throw new Error(`run ${runId}: ${err.message}`);
    }
    if (isObject(run)) runs.push(run);
  }
  return runs;
}

// Tool output for a run. The text is redacted before it lands; name must be a bare file name.
function writeRaw(slug, runId, name, text) {
  checkSlug(slug);
  checkRunId(runId);
  if (typeof name !== 'string' || !RAW_NAME_RE.test(name)) {
    throw new RangeError('raw file name must be a bare file name of letters, digits, ".", "_" and "-"');
  }
  if (typeof text !== 'string') throw new TypeError('raw text must be a string');
  const file = path.join(runDir(slug, runId), 'raw', name);
  writeAtomic(file, redact(text));
  return file;
}

// ---- config and scores --------------------------------------------------------------------

const configFile = () => path.join(rampartHome(), 'config.json');
const readConfig = () => readJson(configFile(), {});

function writeConfig(obj) {
  if (!isObject(obj)) throw new TypeError('config must be an object');
  writeAtomic(configFile(), toJson(obj));
  return obj;
}

// Append one snapshot line. A file that does not end with a newline is first put right (atomically): a last line that parses
// gets its newline, and a torn one (an append a crash cut short) is dropped, so the new line never glues onto it.
function appendScore(slug, snapshot) {
  const file = projectFile(slug, 'scores.jsonl');
  if (!isObject(snapshot)) throw new TypeError('snapshot must be an object');
  const row = { ...snapshot, at: snapshot.at || now() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = readOptional(file);
  if (text && !text.endsWith('\n')) {
    const cut = text.lastIndexOf('\n') + 1;
    writeAtomic(file, parses(text.slice(cut)) ? `${text}\n` : text.slice(0, cut));
  }
  fs.appendFileSync(file, toJsonl([row]));
  return row;
}

const readScores = (slug) => readJsonl(projectFile(slug, 'scores.jsonl'), { tornTail: true });

// ---- jobs (mirrored from the dashboard DB for the watch loop) -----------------------------

const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const jobsDir = () => path.join(rampartHome(), 'jobs');

function jobFile(id) {
  if (typeof id !== 'string' || !JOB_ID_RE.test(id)) throw new RangeError('job id must be 1 to 64 characters of letters, digits, "-" and "_"');
  return path.join(jobsDir(), `${id}.json`);
}

// Validates against job-schema.json and writes ~/.rampart/jobs/<id>.json. The job keeps its own updatedAt (the page's).
function writeJob(job) {
  assertValid('job', job, 'job');
  writeAtomic(jobFile(job.id), toJson(job));
  return job;
}

const readJob = (id) => readJson(jobFile(id), null);

// Every mirrored job, oldest first by updatedAt; only those of one project when slug is given.
function readJobs(slug) {
  let names;
  try {
    names = fs.readdirSync(jobsDir());
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const jobs = names
    .filter((n) => n.endsWith('.json') && JOB_ID_RE.test(n.slice(0, -5)))
    .map((n) => readJson(path.join(jobsDir(), n), null))
    .filter((j) => isObject(j) && (slug === undefined || j.project === slug));
  return jobs.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0));
}

// ---- the live dashboard's settings (config.json "dashboard") ------------------------------

// Each field with the check its value must pass. url is the artifact's claude.ai link; ownerId is the page owner's opaque user
// id (from the DB's meta/owner); pageHash names the published page version; scheduleId is the scheduled task that runs watch;
// mcp is false when the page had to be published without the Claude Code Remote connector, so a republish leaves it out too.
const OPAQUE_ID_RE = /^[A-Za-z0-9_.:@|+=-]{1,200}$/;
const DASHBOARD_FIELDS = {
  url: (v) => typeof v === 'string' && /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]{1,128}$/.test(v),
  ownerId: (v) => typeof v === 'string' && OPAQUE_ID_RE.test(v),
  publishedAt: (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v)),
  pageHash: (v) => typeof v === 'string' && /^[A-Za-z0-9_:+/=-]{8,200}$/.test(v),
  remoteControl: (v) => typeof v === 'boolean',
  scheduleId: (v) => typeof v === 'string' && OPAQUE_ID_RE.test(v),
  mcp: (v) => typeof v === 'boolean',
};
const DASHBOARD_HINTS = {
  url: 'an https://claude.ai/artifact/<id> or https://claude.ai/code/artifact/<id> link',
  ownerId: 'an opaque id (letters, digits and _ . : @ | + = -, up to 200)',
  publishedAt: 'an ISO date-time',
  pageHash: 'a hash of 8 to 200 characters (letters, digits and _ : + / = -)',
  remoteControl: 'true or false',
  scheduleId: 'an opaque id (letters, digits and _ . : @ | + = -, up to 200)',
  mcp: 'true or false',
};

// Every dashboard field, null when unset or when the stored value does not pass its check (a hand-edited config never
// hands a recipe a malformed URL or owner id).
function readDashboard() {
  const cfg = readConfig();
  const stored = isObject(cfg.dashboard) ? cfg.dashboard : {};
  const out = {};
  for (const [key, ok] of Object.entries(DASHBOARD_FIELDS)) out[key] = Object.hasOwn(stored, key) && ok(stored[key]) ? stored[key] : null;
  return out;
}

// Sets only the given fields, each checked first (nothing is written when one fails), and keeps the rest of config.json.
function setDashboard(patch) {
  if (!isObject(patch) || !Object.keys(patch).length) throw new TypeError('setDashboard needs at least one field');
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(DASHBOARD_FIELDS, key)) throw new RangeError(`unknown dashboard field ${key}`);
    if (!DASHBOARD_FIELDS[key](value)) throw new RangeError(`dashboard ${key} must be ${DASHBOARD_HINTS[key]}`);
  }
  const cfg = readConfig();
  const stored = isObject(cfg.dashboard) ? cfg.dashboard : {};
  writeConfig({ ...cfg, dashboard: { ...stored, ...patch } });
  return readDashboard();
}

// ---- CLI ----------------------------------------------------------------------------------

class UsageError extends Error {}

const USAGE = [
  'usage: node scripts/store.cjs <verb> [args] [--json]',
  '  projects',
  '  project <slug>                (--json adds machineId: this machine\'s key in repo.paths)',
  '  project-save <file.json>',
  '  findings <slug> [--status <status>] [--source <source>] [--system <id>] [--class <class>] [--since <iso>]',
  '                  [--new-since <iso>] [--id <id>] [--ids]',
  '  disposition <slug> <id> <status> --reason "<text>" [--by <name>]',
  '  set-class <slug> <id> <class> --note "<text>"',
  '  dashboard                     (the live dashboard\'s settings; --json prints every field, null when unset)',
  '  dashboard-set [--url <link>] [--owner-id <id>] [--published-at <iso>] [--page-hash <hash>]',
  '                [--remote-control true|false] [--schedule-id <id>] [--mcp true|false]   (sets only the fields given)',
].join('\n');

const VALUE_FLAGS = ['status', 'reason', 'by', 'note', 'source', 'system', 'class', 'since', 'new-since', 'id'];
const DASHBOARD_FLAGS = {
  url: 'url', 'owner-id': 'ownerId', 'published-at': 'publishedAt', 'page-hash': 'pageHash', 'remote-control': 'remoteControl', 'schedule-id': 'scheduleId', mcp: 'mcp',
};
VALUE_FLAGS.push(...Object.keys(DASHBOARD_FLAGS));
const BOOLEAN_FLAGS = ['json', 'ids'];
const FINDING_FILTERS = ['status', 'source', 'system', 'class', 'since', 'new-since', 'id'];
const FINDING_ID_RE = /^[0-9a-f]{12}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T|$)/;
const VERBS = {
  projects: { args: [], flags: [] },
  project: { args: ['slug'], flags: [] },
  'project-save': { args: ['file.json'], flags: [] },
  findings: { args: ['slug'], flags: [...FINDING_FILTERS, 'ids'] },
  disposition: { args: ['slug', 'id', 'status'], flags: ['reason', 'by'], required: ['reason'] },
  'set-class': { args: ['slug', 'id', 'class'], flags: ['note'], required: ['note'] },
  dashboard: { args: [], flags: [] },
  'dashboard-set': { args: [], flags: Object.keys(DASHBOARD_FLAGS) },
};

function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      args.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (BOOLEAN_FLAGS.includes(name) && eq === -1) {
      flags[name] = true;
    } else if (VALUE_FLAGS.includes(name)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      flags[name] = value;
    } else {
      throw new UsageError(`unknown option --${name}`);
    }
  }
  return { args, flags };
}

// A time given to --since or --new-since, in ms. It must start like an ISO date (YYYY-MM-DD) and parse.
function filterTime(name, value) {
  const ms = ISO_DATE_RE.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new UsageError(`--${name} must be an ISO date-time, such as 2026-10-23T18:02:11.000Z`);
  return ms;
}

// The findings filters, AND-combined, as one predicate. --since keeps findings last seen at or after the time (every
// sighting moves lastSeen, so it means "reported by a scan since then"); --new-since keeps those first seen at or after it.
// A finding whose time cannot be read does not pass a time filter.
function findingFilter(flags) {
  for (const name of FINDING_FILTERS) {
    if (flags[name] === '') throw new UsageError(`--${name} needs a value`);
  }
  const { status, source, system, id } = flags;
  const cls = flags.class;
  if (status !== undefined && !FINDING_STATUSES.includes(status)) {
    throw new UsageError(`--status must be one of ${FINDING_STATUSES.join(', ')}`);
  }
  if (cls !== undefined && !CLASSES.includes(cls)) throw new UsageError(`--class must be one of ${CLASSES.join(', ')}`);
  const sources = loadSchema('finding').properties.source.enum;
  if (source !== undefined && !sources.includes(source)) throw new UsageError(`--source must be one of ${sources.join(', ')}`);
  if (id !== undefined && !FINDING_ID_RE.test(id)) throw new UsageError('--id must be a finding id (12 hex characters)');
  const since = flags.since === undefined ? null : filterTime('since', flags.since);
  const newSince = flags['new-since'] === undefined ? null : filterTime('new-since', flags['new-since']);
  const atOrAfter = (stamp, ms) => typeof stamp === 'string' && Date.parse(stamp) >= ms;
  return (f) =>
    (status === undefined || f.status === status) &&
    (source === undefined || f.source === source) &&
    (system === undefined || f.system === system) &&
    (cls === undefined || f.class === cls) &&
    (id === undefined || f.id === id) &&
    (since === null || atOrAfter(f.lastSeen, since)) &&
    (newSince === null || atOrAfter(f.firstSeen, newSince));
}

function defaultBy() {
  try {
    return os.userInfo().username;
  } catch {
    return 'unknown';
  }
}

const HANDLERS = {
  projects: () => {
    const slugs = listProjects();
    return { text: slugs.join('\n'), json: slugs };
  },
  project: ([slug]) => {
    const p = readProject(slug);
    if (!p) throw new Error(`project ${slug} not found`);
    const systems = p.systems.map((s) => `  ${s.id}  ${s.type}  ${s.name}`);
    // machineId is not part of the project: it tells the reader which repo.paths entry is this machine's.
    return {
      text: [`${p.slug}: ${p.name} (criticality ${p.criticality}, executor ${p.defaultExecutor})`, ...systems].join('\n'),
      json: { ...p, machineId: machineId() },
    };
  },
  'project-save': ([file]) => {
    const text = readOptional(file);
    if (text === null) throw new UsageError('project-save: file not found');
    let project;
    try {
      project = JSON.parse(text);
    } catch {
      throw new Error('project-save: file is not valid JSON');
    }
    const saved = writeProject(project);
    return { text: saved.slug, json: saved };
  },
  findings: ([slug], flags) => {
    const rows = readFindings(slug).filter(findingFilter(flags));
    // --ids prints only the ids (one per line, or a JSON array), so a long list stays short.
    if (flags.ids) return { text: rows.map((f) => f.id).join('\n'), json: rows.map((f) => f.id) };
    return { text: rows.map((f) => [f.id, f.severity, f.status, f.class, f.title].join('  ')).join('\n'), json: rows };
  },
  disposition: ([slug, id, status], { reason, by }) => {
    const f = setDisposition(slug, id, { status, reason, by: by ?? defaultBy() });
    return { text: `${f.id}  ${f.status}`, json: f };
  },
  'set-class': ([slug, id, cls], { note }) => {
    const f = setClass(slug, id, cls, note);
    return { text: `${f.id}  ${f.class}`, json: f };
  },
  dashboard: () => {
    const d = readDashboard();
    return { text: Object.entries(d).map(([k, v]) => `${k}: ${v === null ? '(unset)' : v}`).join('\n'), json: d };
  },
  'dashboard-set': (_args, flags) => {
    const patch = {};
    for (const [flag, key] of Object.entries(DASHBOARD_FLAGS)) {
      if (flags[flag] === undefined) continue;
      if (key !== 'remoteControl' && key !== 'mcp') patch[key] = flags[flag];
      else if (flags[flag] === 'true' || flags[flag] === 'false') patch[key] = flags[flag] === 'true';
      else throw new UsageError(`--${flag} must be true or false`);
    }
    if (!Object.keys(patch).length) {
      throw new UsageError(`dashboard-set needs at least one of ${Object.keys(DASHBOARD_FLAGS).map((f) => `--${f}`).join(', ')}`);
    }
    const d = setDashboard(patch);
    return { text: `${Object.keys(patch).join(', ')} set`, json: d };
  },
};

function main(argv) {
  const { args, flags } = parseArgs(argv);
  const verb = args.shift();
  if (!verb) throw new UsageError('missing verb');
  if (!Object.hasOwn(VERBS, verb)) throw new UsageError(`unknown verb ${verb}`);
  const spec = VERBS[verb];
  if (args.length !== spec.args.length) {
    throw new UsageError(`${verb} takes ${spec.args.length ? spec.args.map((a) => `<${a}>`).join(' ') : 'no arguments'}`);
  }
  for (const name of Object.keys(flags)) {
    if (name !== 'json' && !spec.flags.includes(name)) throw new UsageError(`${verb} does not take --${name}`);
  }
  for (const name of spec.required || []) {
    if (flags[name] === undefined) throw new UsageError(`${verb} needs --${name}`);
  }
  const { text, json } = HANDLERS[verb](args, flags);
  const out = flags.json ? JSON.stringify(json, null, 2) : text;
  if (out) process.stdout.write(`${out}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    // A slug or run id of the wrong shape is a bad argument (2); rejected data or an unknown id is a failure (1).
    process.exitCode = err instanceof UsageError || err instanceof RangeError ? 2 : 1;
    process.stderr.write(`store: ${err.message}\n`);
    if (err instanceof UsageError) process.stderr.write(`${USAGE}\n`);
  }
}

module.exports = {
  listProjects, readProject, writeProject,
  readFindings, upsertFindings, closeMissing, readDispositions, setDisposition, setClass,
  createRun, finishRun, readRuns, writeRaw,
  readConfig, writeConfig, appendScore, readScores,
  writeJob, readJob, readJobs,
  readDashboard, setDashboard,
};
