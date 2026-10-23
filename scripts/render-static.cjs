'use strict';
// The static dashboard (spec 5.7, "Without claude.ai"): dashboard/index.html with the store's data inlined, written to
// ~/.rampart/dashboard.html. The page reads the <script id="rampart-data" type="application/json"> slot on load.
//   buildPage(now) -> {generatedAt, machineId, projects: [{project, score, findings, runs, dispositions}]}  (buildData is the old name)
//   publicProject(project) -> the project without what must not leave the machine (the live dashboard's DB gets the same copy)
//   renderStatic(outPath?) -> the absolute path written
// The page data holds no ownerAttestation, no repo.paths, no ssh user or port and no query string on a live URL (publicProject).
// Every string in the data goes through redact() first. The store redacts finding text as it arrives, but other fields
// (a run's reason, a disposition) come from elsewhere, and this page is the copy most likely to be shared, so it is the last
// place a credential can be stopped. In the slot every "<" is written as <, so no text in the data can close the
// script element; JSON.parse reads it back unchanged.
// The template is the artifact page, which the artifact host wraps in a document skeleton when it publishes it. The local
// file gets the same skeleton here, so it renders in standards mode with the same reset.
// CLI: node scripts/render-static.cjs [--out <path>] [--open]. Prints the path. --open hands the file to the OS opener
// (RAMPART_OPENER overrides it; tests use it), and a missing or failing opener is a note on stderr, never a failed render.
// Exit 0 ok, 2 bad arguments, 1 anything else (a corrupt store, say).

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const store = require('./store.cjs');
const { scoreProject } = require('./score.cjs');
const { machineId, rampartHome } = require('./lib/paths.cjs');
const { redact } = require('./lib/redact.cjs');
const { writeAtomic } = require('./lib/atomic.cjs');
const exec = require('./lib/exec.cjs');

const TEMPLATE = path.join(__dirname, '..', 'dashboard', 'index.html');
const SLOT_RE = /(<script id="rampart-data" type="application\/json">)[\s\S]*?(<\/script>)/;
const OPEN_TIMEOUT_MS = 15000;

const SKELETON_HEAD = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}' +
    'body{margin:0;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>',
  '</head>',
  '<body>',
  '',
].join('\n');
const SKELETON_TAIL = '\n</body>\n</html>\n';

// A copy of value with every string redacted.
function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}

// The score with the trend the user was told. Every job runs score.cjs, which saves a snapshot, and then renders, so a trend
// computed here against the latest snapshot would always read 0. When the latest project snapshot has this same score, the
// trend it was saved with is the one to show (null when it was the first); when the score has moved since, the change since
// that snapshot is (scoreProject's own trend). A snapshot from before snapshots kept their trend has none to offer.
function withSavedTrend(slug, score) {
  const latest = store.readScores(slug).filter((s) => s && s.kind === 'project' && Number.isFinite(s.score)).pop();
  const saved = latest && (latest.trend === null || Number.isFinite(latest.trend));
  return saved && latest.score === score.score ? { ...score, trend: latest.trend } : score;
}

// The score the page shows for one project (see withSavedTrend). Throws when it cannot be scored (a bad cadence, a finding the
// score table does not know), as score.cjs does: a page that quietly left it out would look better than it is.
const projectScore = (slug, project, findings, runs, now) => withSavedTrend(slug, scoreProject(project, findings, runs, now));

// The host name in an ssh target: user@host, user@host:port, ssh://user@host:port/, [v6]:port or a bare host. No user, no port.
function hostnameOf(ssh) {
  if (typeof ssh !== 'string') return '';
  let target = ssh.trim().replace(/^ssh:\/\//i, '');
  target = target.slice(target.lastIndexOf('@') + 1).split(/[/?#]/)[0];
  const v6 = /^\[([^\]]*)\]/.exec(target);
  if (v6) return v6[1];
  return target.split(':').length === 2 ? target.split(':')[0] : target;
}

// A live URL as origin + pathname: no userinfo, query or fragment. Anything that is not an http(s) URL gives ''.
function publicUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin + u.pathname : '';
  } catch {
    return '';
  }
}

// A repo remote with any userinfo before the host removed (https://token@github.com/o/r becomes https://github.com/o/r).
const publicRemote = (remote) => remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, '$1');

// A system with only the fields a viewer needs. An allowlist, because the system schema is open: a field added later stays
// private until it is listed here.
function publicSystem(system) {
  const out = {};
  for (const key of ['id', 'type', 'name', 'packs', 'criticality', 'executor', 'source', 'layers']) {
    if (system[key] !== undefined) out[key] = system[key];
  }
  if (system.repo && typeof system.repo === 'object') {
    out.repo = {};
    if (typeof system.repo.remote === 'string') out.repo.remote = publicRemote(system.repo.remote);
    if (typeof system.repo.defaultBranch === 'string') out.repo.defaultBranch = system.repo.defaultBranch;
  }
  if (system.host && typeof system.host === 'object') out.host = { hostname: hostnameOf(system.host.ssh) };
  if (system.live && typeof system.live === 'object') {
    const url = publicUrl(system.live.url);
    if (url) out.live = { url };
  }
  return out;
}

// The project as the page, and the live dashboard's DB, may hold it: no ownerAttestation, and every system through publicSystem.
function publicProject(project) {
  const { ownerAttestation, ...rest } = project;
  return { ...rest, systems: (Array.isArray(project.systems) ? project.systems : []).map(publicSystem) };
}

// A run without any raw-output field. run.json holds none today; this keeps it that way if one is ever added.
const publicRun = ({ raw, ...run }) => run;

// Everything the page shows, for every project in the store, in slug order. Runs are the run.json objects (raw tool
// output is never read); findings are the stored records.
function buildPage(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  const projects = store.listProjects().map((slug) => {
    const project = store.readProject(slug);
    const findings = store.readFindings(slug);
    const runs = store.readRuns(slug);
    const dispositions = store.readDispositions(slug);
    const score = projectScore(slug, project, findings, runs, now);
    return redactDeep({ project: publicProject(project), score, findings, runs: runs.map(publicRun), dispositions });
  });
  return { generatedAt: now.toISOString(), machineId: machineId(), projects };
}

// JSON that is safe as the text of a script element.
const slotText = (data) => JSON.stringify(data).replace(/</g, '\\u003c');

// The template with the slot filled, inside the document skeleton.
function fillTemplate(template, data) {
  if (!SLOT_RE.test(template)) throw new Error('dashboard/index.html has no rampart-data slot');
  // A function replacement, so "$&" or "$1" in the data is never read as a pattern.
  const page = template.replace(SLOT_RE, (match, open, close) => `${open}${slotText(data)}${close}`);
  return `${SKELETON_HEAD}${page}${SKELETON_TAIL}`;
}

// The page is written through a temp file and a rename (lib/atomic.cjs), so a reader never sees half a page.
function renderStatic(outPath) {
  const file = outPath ? path.resolve(outPath) : path.join(rampartHome(), 'dashboard.html');
  const html = fillTemplate(fs.readFileSync(TEMPLATE, 'utf8'), buildPage());
  writeAtomic(file, html);
  return file;
}

// The platform's "open this file" command. No shell is involved (exec.run), so Windows cannot use `start`.
function opener(file) {
  if (process.platform === 'win32') return { bin: 'rundll32', args: ['url.dll,FileProtocolHandler', file] };
  if (process.platform === 'darwin') return { bin: 'open', args: [file] };
  return { bin: 'xdg-open', args: [file] };
}

// {opened: true} or {opened: false, reason}. Never throws.
function openFile(file) {
  const { bin, args } = opener(file);
  const cmd = exec.which(bin, 'RAMPART_OPENER');
  if (!cmd) return { opened: false, reason: `${bin} was not found` };
  try {
    const r = exec.run(cmd, args, { timeoutMs: OPEN_TIMEOUT_MS });
    if (r.timedOut) return { opened: false, reason: `${bin} did not finish` };
    if (r.code !== 0) return { opened: false, reason: `${bin} exited with ${r.code}` };
    return { opened: true };
  } catch (err) {
    return { opened: false, reason: `${bin} could not be started (${err.code || err.name})` };
  }
}

// ---- CLI ----------------------------------------------------------------------------------

class UsageError extends Error {}

const USAGE = 'usage: node scripts/render-static.cjs [--out <path>] [--open]';

function parseArgs(argv) {
  let parsed;
  try {
    parsed = util.parseArgs({
      args: argv,
      options: { out: { type: 'string' }, open: { type: 'boolean' } },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    throw new UsageError(err.message.split('\n')[0]);
  }
  if (parsed.values.out === '') throw new UsageError('--out needs a path');
  return { out: parsed.values.out, open: parsed.values.open === true };
}

function main(argv) {
  const { out, open } = parseArgs(argv);
  const file = renderStatic(out);
  process.stdout.write(`${file}\n`);
  if (open) {
    const result = openFile(file);
    if (!result.opened) process.stderr.write(`render-static: could not open the dashboard: ${result.reason}; open ${file} in a browser\n`);
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.exitCode = err instanceof UsageError ? 2 : 1;
    process.stderr.write(`render-static: ${redact(err.message)}\n`);
    if (err instanceof UsageError) process.stderr.write(`${USAGE}\n`);
  }
}

module.exports = { buildPage, buildData: buildPage, publicProject, projectScore, redactDeep, renderStatic };
