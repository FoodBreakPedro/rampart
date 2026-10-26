'use strict';
// The sync planner (live dashboard, Plan 3): works out what the local store must write to the dashboard DB, and what to
// take from the DB, without ever touching the network. The recipe (skills/rampart/jobs/dashboard.md) moves the files
// to and from the ArtifactData tool; this script only plans and merges.
//   planPush(slug, {since, versions, now}) -> {docs, batches, cursor}
//     docs: [{collection, id, data}] for every project, finding and run summary changed at or after `since` (all, when absent).
//     batches: the same docs as ArtifactData batch entries {op, collection, doc_id, data, if_version?}, at most 50 each.
//       op is 'update' with if_version when versions has "<collection>/<id>", else 'set'.
//     cursor: the time the plan started; pass it as `since` next time.
//   applyPull(slug, docs) -> {applied, skipped}
//     docs: [{collection, id, data}] read from the DB. Jobs are mirrored to ~/.rampart/jobs, project settings and
//     finding dispositions are merged by the rules below. Other collections are ignored (neither applied nor skipped).
// Merge rule: a disposition made in the page (by is not 'rampart') beats local automation, except that a page fixed or open
// loses to an automated change (regression, close) made after it; accepted_risk and false_positive always win. Between two
// decisions by people the later one stands; the same decision pulled twice applies once; an automated (by 'rampart') page disposition applies only when its doc is newer than the
// local finding; for jobs and project settings the newer updatedAt wins.
// Nothing private is planned: projects go through publicProject, findings are the stored (redacted) records, and a run doc
// carries its summary and REPORT.md, never raw tool output. Packs docs are not planned yet (Plan 2 owns packs).
// CLI: node scripts/sync-plan.cjs push --project <slug> [--since <iso>] [--versions <file.json>] --out <dir>
//      node scripts/sync-plan.cjs pull --project <slug> --in <file-or-dir>
// push writes <dir>/docs/<collection>/<id>.json per doc and <dir>/batches.json = {cursor, batches: [[{op, collection,
// doc_id, file_path, if_version?}, ...]]}. pull reads a JSON array of docs or a tree <dir>/<collection>/<id>.json whose
// files are bare bodies or {id, data, version} wrappers. Exit 0 ok, 1 anything else, 2 bad arguments.
//      node scripts/sync-plan.cjs versions --in <dir> --out <file.json>
//        the push --versions map {"<collection>/<doc_id>": version} from an ArtifactData out_dir tree read just before the
//        push (the same snapshot the pull read). Each file is a {id, data, version} wrapper or a body with version or _version
//        beside its fields; a file with no integer version fails (exit 1, naming it) rather than leaving a doc unpinned.
//      node scripts/sync-plan.cjs page-hash [--file <page.html>]
//        sha256:<hex> of the live page (default the plugin's dashboard/index.html), for config.json dashboard.pageHash.
//      node scripts/sync-plan.cjs meta-sync --in <dir> [--cursor <iso> [--full]]
//        without --cursor: {machineId, pushCursor, version} from <dir>/meta/sync.json (null when none). With it: the data
//        for meta/sync, this machine's entry only {pushedAt, pulledAt, pushCursor, pullCursor}; pushCursor moves to --cursor
//        only with --full (every project pushed), so a one-project sync never skips another project's changes.

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const util = require('node:util');
const store = require('./store.cjs');
const { publicProject, publicFinding, projectScore, redactDeep } = require('./render-static.cjs');
const { runDir, machineId } = require('./lib/paths.cjs');
const { redact } = require('./lib/redact.cjs');
const { writeAtomic } = require('./lib/atomic.cjs');

const BATCH_SIZE = 50;
const DOC_MAX_BYTES = 256 * 1024; // the DB's cap on one document
const DOC_MARGIN_BYTES = 4096; // headroom for what the DB wraps around it
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T|$)/;
const PAGE_STATUSES = ['open', 'fixed', 'false_positive', 'accepted_risk'];
const EXECUTORS = ['local', 'cloud'];
const EFFORTS = ['low', 'medium', 'high'];
const PULLED = ['jobs', 'projects', 'findings'];
const COLLECTION_RE = /^[a-z]+$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ms = (stamp) => (typeof stamp === 'string' ? Date.parse(stamp) : NaN);

// ---- push ---------------------------------------------------------------------------------

// The cut-off in ms (-Infinity for no cut-off).
function sinceMs(since) {
  if (since === undefined || since === null) return -Infinity;
  const value = typeof since === 'string' && ISO_DATE_RE.test(since) ? Date.parse(since) : NaN;
  if (!Number.isFinite(value)) throw new RangeError('since must be an ISO date-time, such as 2026-10-23T18:02:11.000Z');
  return value;
}

// True when any stamp is at or after the cut-off (inclusive, so a doc stamped in the cursor's own millisecond is never missed;
// pushing it twice is harmless). With no cut-off every stamped doc counts.
const changedAfter = (cut, ...stamps) => stamps.some((s) => typeof s === 'string' && (cut === -Infinity || ms(s) >= cut));

// A stored decision as the finding doc carries it. dispositions.json also holds 'regressed' (an automated status the
// finding itself already shows), which the doc's disposition field does not allow, so it becomes null.
function pageDisposition(record) {
  if (!isObject(record) || !PAGE_STATUSES.includes(record.status)) return null;
  return { status: record.status, reason: String(record.reason ?? ''), by: String(record.by ?? ''), at: String(record.at ?? '') };
}

// REPORT.md of a run, redacted, or null when the run has none (the cut to the doc cap is fitReport's).
function readReport(slug, runId) {
  let text;
  try {
    text = fs.readFileSync(path.join(runDir(slug, runId), 'REPORT.md'), 'utf8').replace(/^﻿/, '');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  return redact(text);
}

const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value));

// The longest start of the report that keeps the serialized doc inside the cap, measured in bytes of the JSON (multi-byte
// characters and escaped newlines both cost more than one byte). Never ends on half a surrogate pair.
function fitReport(text, data) {
  const limit = DOC_MAX_BYTES - DOC_MARGIN_BYTES;
  const head = (n) => {
    const cut = text.slice(0, n);
    return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  };
  const fits = (n) => jsonBytes({ ...data, reportMd: head(n) }) <= limit;
  if (fits(text.length)) return text;
  let lo = 0;
  let hi = text.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return head(lo);
}

function projectDoc(slug, project, findings, runs, now) {
  // cadenceOverrides: null clears a page override the last pull already applied, so it does not linger in the DB.
  const data = {
    ...publicProject(project), score: projectScore(slug, project, findings, runs, now), cadenceOverrides: null, updatedAt: project.updated,
  };
  return { collection: 'projects', id: slug, data: redactDeep(data) };
}

function findingDoc(f, dispositions) {
  const data = { ...publicFinding(f), disposition: pageDisposition(dispositions[f.id]), updatedAt: f.updatedAt || f.lastSeen };
  return { collection: 'findings', id: f.id, data: redactDeep(data) };
}

function runDoc(slug, run) {
  const { raw, ...summary } = run;
  const data = { ...summary, updatedAt: run.updatedAt || run.finishedAt };
  const report = readReport(slug, run.runId);
  if (report !== null) data.reportMd = fitReport(report, data);
  return { collection: 'runs', id: run.runId, data: redactDeep(data) };
}

// The ArtifactData batch entries for the docs, in batches of BATCH_SIZE.
function toBatches(docs, versions) {
  const entries = docs.map((d) => {
    const version = versions[`${d.collection}/${d.id}`];
    const entry = { op: version === undefined ? 'set' : 'update', collection: d.collection, doc_id: d.id, data: d.data };
    if (version !== undefined) entry.if_version = version;
    return entry;
  });
  const batches = [];
  for (let i = 0; i < entries.length; i += BATCH_SIZE) batches.push(entries.slice(i, i + BATCH_SIZE));
  return batches;
}

// The docs changed since the cut-off, for one project. The cursor is read before the store and `since` is inclusive, so a write
// that lands during the plan is pushed again next time (it is never lost). A project doc is also planned when its latest score snapshot is new,
// because the score travels in it.
function planPush(slug, { since, versions = {}, now = new Date() } = {}) {
  const cut = sinceMs(since);
  const cursor = new Date().toISOString();
  const project = store.readProject(slug);
  if (!project) throw new Error(`project ${slug} not found`);
  if (!isObject(versions)) throw new TypeError('versions must be an object');
  const findings = store.readFindings(slug);
  const runs = store.readRuns(slug);
  const dispositions = store.readDispositions(slug);
  const lastScore = store.readScores(slug).filter((s) => s && s.kind === 'project').pop();

  const docs = [];
  if (changedAfter(cut, project.updated, lastScore && lastScore.at)) docs.push(projectDoc(slug, project, findings, runs, now));
  for (const f of findings) if (changedAfter(cut, f.updatedAt, f.lastSeen)) docs.push(findingDoc(f, dispositions));
  for (const run of runs) if (changedAfter(cut, run.updatedAt, run.finishedAt)) docs.push(runDoc(slug, run));
  return { docs, batches: toBatches(docs, versions), cursor };
}

// ---- pull ---------------------------------------------------------------------------------

// A job from the page: mirrored for the watch loop unless the local copy is as new or newer.
function pullJob(slug, data) {
  if (!isObject(data) || data.project !== slug) return false;
  let local;
  try {
    local = store.readJob(data.id);
  } catch (err) {
    if (err instanceof RangeError) return false; // an id that cannot be a file name
    throw err;
  }
  if (local && !(ms(data.updatedAt) > ms(local.updatedAt))) return false;
  try {
    store.writeJob(data);
    return true;
  } catch {
    return false; // not a valid job
  }
}

// The settings the page may write, merged into project.json when the doc is newer than the project. Returns the next project
// or null when nothing would change.
function mergedSettings(project, data) {
  const next = { ...project };
  if (typeof data.cloudAllowed === 'boolean') next.cloudAllowed = data.cloudAllowed;
  if (EXECUTORS.includes(data.defaultExecutor)) next.defaultExecutor = data.defaultExecutor;
  if (EFFORTS.includes(data.huntEffort)) next.huntEffort = data.huntEffort;
  if (isObject(data.cadenceOverrides)) {
    // Only a layer the system already has: an override changes a cadence, it never switches a layer on.
    next.systems = project.systems.map((system) => {
      const overrides = data.cadenceOverrides[system.id];
      if (!isObject(overrides)) return system;
      const layers = { ...system.layers };
      for (const [layer, days] of Object.entries(overrides)) {
        if (isObject(layers[layer]) && Number.isInteger(days) && days >= 1) layers[layer] = { ...layers[layer], cadenceDays: days };
      }
      return { ...system, layers };
    });
  }
  return JSON.stringify(next) === JSON.stringify(project) ? null : next;
}

function pullProject(slug, id, data) {
  if (!isObject(data) || id !== slug) return false;
  const local = store.readProject(slug);
  if (!local || !(ms(data.updatedAt) > ms(local.updated))) return false;
  const next = mergedSettings(local, data);
  if (!next) return false;
  try {
    store.writeProject(next); // stamps updated, so this doc is not applied twice
    return true;
  } catch {
    return false;
  }
}

// A finding doc matters here only for its disposition: the page changes nothing else on a finding.
function pullFinding(slug, data) {
  if (!isObject(data) || data.project !== slug || !isObject(data.disposition)) return false;
  const page = data.disposition;
  if (!PAGE_STATUSES.includes(page.status) || typeof page.by !== 'string' || page.by === '') return false;
  const finding = store.readFindings(slug).find((f) => f.id === data.id);
  if (!finding) return false;
  const local = store.readDispositions(slug)[data.id];
  if (local && local.status === page.status && local.by === page.by && local.at === page.at) return false; // already applied
  const localByPerson = isObject(local) && local.by !== 'rampart';
  if (page.by !== 'rampart') {
    // A person in the page. Against another person the later decision wins. Against local automation (a regression, a close)
    // the page's judgments (accepted_risk, false_positive) always win, but fixed and open only win while no later scan has
    // changed the finding: a later regression or close is new evidence, and re-applying the stale decision on every pull
    // would hide it for good.
    if (localByPerson && ms(local.at) > ms(page.at)) return false; // the next push carries the later local decision
    const judgment = page.status === 'accepted_risk' || page.status === 'false_positive';
    if (!localByPerson && !judgment && isObject(local) && ms(local.at) > ms(page.at)) return false;
  } else if (localByPerson || !(ms(data.updatedAt || page.at) > ms(finding.updatedAt || finding.lastSeen))) {
    return false; // an automated change never beats a person, nor a newer local state
  }
  store.setDisposition(slug, data.id, { status: page.status, reason: page.reason, by: page.by, at: page.at });
  return true;
}

function applyPull(slug, docs) {
  if (!Array.isArray(docs)) throw new TypeError('docs must be an array');
  let applied = 0;
  let skipped = 0;
  const order = (d) => PULLED.indexOf(d.collection); // jobs first, then project settings, then dispositions
  const wanted = docs.filter((d) => isObject(d) && PULLED.includes(d.collection)).sort((a, b) => order(a) - order(b));
  for (const doc of wanted) {
    const id = doc.id ?? doc.doc_id;
    // A doc filed under one id but holding another is not trusted: nothing is written for it.
    const consistent = doc.collection === 'projects' || id === undefined || (isObject(doc.data) && doc.data.id === id);
    const done = !consistent ? false :
      doc.collection === 'jobs' ? pullJob(slug, doc.data)
        : doc.collection === 'projects' ? pullProject(slug, id, doc.data)
          : pullFinding(slug, doc.data);
    if (done) applied++;
    else skipped++;
  }
  return { applied, skipped };
}

// ---- CLI ----------------------------------------------------------------------------------

class UsageError extends Error {}

const USAGE = [
  'usage: node scripts/sync-plan.cjs push --project <slug> [--since <iso>] [--versions <file.json>] --out <dir>',
  '       node scripts/sync-plan.cjs pull --project <slug> --in <file.json | dir>',
  '       node scripts/sync-plan.cjs versions --in <dir> --out <file.json>',
  '       node scripts/sync-plan.cjs page-hash [--file <page.html>]',
  '       node scripts/sync-plan.cjs meta-sync --in <dir> [--cursor <iso> [--full]]',
].join('\n');

function parseArgs(argv) {
  let parsed;
  try {
    parsed = util.parseArgs({
      args: argv,
      options: {
        project: { type: 'string' }, since: { type: 'string' }, versions: { type: 'string' }, out: { type: 'string' }, in: { type: 'string' },
        file: { type: 'string' }, cursor: { type: 'string' }, full: { type: 'boolean' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    throw new UsageError(err.message.split('\n')[0]);
  }
  const { values, positionals } = parsed;
  for (const [name, value] of Object.entries(values)) if (value === '') throw new UsageError(`--${name} needs a value`);
  if (positionals.length !== 1) throw new UsageError('missing verb (push, pull, versions, page-hash or meta-sync)');
  return { verb: positionals[0], values };
}

function readJsonFile(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch (err) {
    if (err.code === 'ENOENT') throw new UsageError(`${what}: file not found`);
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what}: ${path.basename(file)} is not valid JSON`);
  }
}

const safeName = (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id);

// Makes <out> ready for a new plan. A missing or empty folder is ready. A folder holding the batches.json of an earlier push
// has just the files that plan listed removed (only below <out>/docs), and the folders that leaves empty. Anything else is
// refused, so --out . in a project cannot delete the project's own docs/.
function clearEarlierPlan(out) {
  let entries;
  try {
    entries = fs.readdirSync(out);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    if (err.code === 'ENOTDIR') throw new UsageError('push: --out is not a folder');
    throw err;
  }
  if (!entries.length) return;
  let listed = null;
  try {
    const plan = JSON.parse(fs.readFileSync(path.join(out, 'batches.json'), 'utf8'));
    if (isObject(plan) && Array.isArray(plan.batches) && plan.batches.every(Array.isArray)) listed = plan.batches.flat();
  } catch {
    listed = null;
  }
  if (!listed) throw new UsageError('push: --out exists and is not empty; give a new or empty folder (or one an earlier push wrote)');
  const docsDir = path.join(out, 'docs');
  const inside = (p) => {
    const rel = path.relative(docsDir, p);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  for (const entry of listed) {
    if (!isObject(entry) || typeof entry.file_path !== 'string' || !inside(path.resolve(entry.file_path))) continue;
    const file = path.resolve(entry.file_path);
    try {
      fs.unlinkSync(file); // a file only: unlink never removes a folder
    } catch {
      continue;
    }
    for (let dir = path.dirname(file); dir === docsDir || inside(dir); dir = path.dirname(dir)) {
      try {
        fs.rmdirSync(dir); // fails while the folder still holds anything
      } catch {
        break;
      }
      if (dir === docsDir) break;
    }
  }
}

// Writes the plan as files so no store data passes through the conversation: one body per doc, and batches.json naming them.
function writePlan(plan, out) {
  clearEarlierPlan(out);
  const batches = plan.batches.map((batch) =>
    batch.map((entry) => {
      if (!safeName(entry.doc_id) || !COLLECTION_RE.test(entry.collection)) throw new Error('a doc id cannot be a file name');
      const file = path.join(out, 'docs', entry.collection, `${entry.doc_id}.json`);
      writeAtomic(file, `${JSON.stringify(entry.data, null, 2)}\n`);
      const { data, ...rest } = entry;
      return { ...rest, file_path: file };
    })
  );
  writeAtomic(path.join(out, 'batches.json'), `${JSON.stringify({ cursor: plan.cursor, batches }, null, 2)}\n`);
  return batches;
}

// A document from a pulled file: either {collection, id|doc_id, data} already, or a bare body / {id, data, version} wrapper
// found at <collection>/<id>.json.
// A bare body may carry its version beside its fields (version or _version); that is the DB's, not the document's, so it is
// dropped before the body is applied (a job with an extra field would not pass its schema).
function docFromFile(collection, id, content) {
  const wrapped = isObject(content) && isObject(content.data) && !('project' in content) && !('slug' in content);
  if (wrapped) return { collection, id: content.id !== undefined ? content.id : id, data: content.data };
  let data = content;
  if (isObject(content) && ('_version' in content || Number.isInteger(content.version))) {
    const { _version, ...rest } = content;
    if (Number.isInteger(rest.version)) delete rest.version;
    data = rest;
  }
  return { collection, id, data };
}

// The version an out_dir file carries, or undefined: a wrapper's version, else _version or version beside the fields.
function versionOf(content) {
  if (!isObject(content)) return undefined;
  const v = '_version' in content ? content._version : content.version;
  return Number.isInteger(v) && v >= 1 ? v : undefined;
}

// Every <dir>/<collection>/<doc_id>.json of an ArtifactData out_dir tree, as [collection, docId, file], sorted.
function treeFiles(dir) {
  const out = [];
  for (const collection of fs.readdirSync(dir).filter((n) => COLLECTION_RE.test(n)).sort()) {
    const sub = path.join(dir, collection);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const name of fs.readdirSync(sub).filter((n) => n.endsWith('.json')).sort()) out.push([collection, name.slice(0, -5), path.join(sub, name)]);
  }
  return out;
}

function buildVersions(dir) {
  const map = {};
  for (const [collection, docId, file] of treeFiles(dir)) {
    const version = versionOf(readJsonFile(file, 'versions'));
    if (version === undefined) throw new Error(`versions: ${collection}/${docId}.json carries no version; the read's file format is not the one expected`);
    map[`${collection}/${docId}`] = version;
  }
  return map;
}

function pageHash(file) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') throw new UsageError('page-hash: file not found');
    throw err;
  }
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

// This machine's entry of meta/sync in an out_dir tree (null when none) and the document's version (null when absent).
function syncEntry(dir) {
  const file = path.join(dir, 'meta', 'sync.json');
  if (!fs.existsSync(file)) return { entry: null, version: null };
  const content = readJsonFile(file, 'meta-sync');
  const { data } = docFromFile('meta', 'sync', content);
  const entry = isObject(data) && isObject(data[machineId()]) ? data[machineId()] : null;
  return { entry, version: versionOf(content) ?? null };
}

function metaSync(dir, cursor, full) {
  const { entry, version } = syncEntry(dir);
  const previous = entry && typeof entry.pushCursor === 'string' && ISO_DATE_RE.test(entry.pushCursor) ? entry.pushCursor : null;
  if (cursor === undefined) return { machineId: machineId(), pushCursor: previous, version };
  const now = new Date().toISOString();
  return { [machineId()]: { pushedAt: now, pulledAt: now, pushCursor: full ? cursor : previous, pullCursor: now } };
}

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// The verbs that take no project.
function mainTool(verb, values) {
  const allowed = { versions: ['in', 'out'], 'page-hash': ['file'], 'meta-sync': ['in', 'cursor', 'full'] }[verb];
  const extra = Object.keys(values).find((k) => !allowed.includes(k));
  if (extra) throw new UsageError(`${verb} does not take --${extra}`);
  if (verb === 'page-hash') {
    process.stdout.write(`${pageHash(path.resolve(values.file || path.join(__dirname, '..', 'dashboard', 'index.html')))}\n`);
    return;
  }
  if (!values.in) throw new UsageError(`${verb} needs --in`);
  const dir = path.resolve(values.in);
  if (!isDir(dir)) throw new UsageError(`${verb}: --in is not a folder`);
  if (verb === 'versions') {
    if (!values.out) throw new UsageError('versions needs --out');
    const map = buildVersions(dir);
    writeAtomic(path.resolve(values.out), `${JSON.stringify(map, null, 2)}\n`);
    process.stdout.write(`${Object.keys(map).length} versions\n`);
    return;
  }
  if (values.full && values.cursor === undefined) throw new UsageError('--full needs --cursor');
  if (values.cursor !== undefined && !(ISO_DATE_RE.test(values.cursor) && Number.isFinite(Date.parse(values.cursor)))) {
    throw new UsageError('--cursor must be an ISO date-time');
  }
  process.stdout.write(`${JSON.stringify(metaSync(dir, values.cursor, values.full === true))}\n`);
}

function readPullInput(input) {
  let stat;
  try {
    stat = fs.statSync(input);
  } catch {
    throw new UsageError('pull: --in not found');
  }
  if (stat.isFile()) {
    const content = readJsonFile(input, 'pull');
    const list = Array.isArray(content) ? content : isObject(content) && Array.isArray(content.docs) ? content.docs : null;
    if (!list) throw new Error('pull: the input file must hold a JSON array of docs');
    return list;
  }
  const docs = [];
  for (const collection of PULLED) {
    const dir = path.join(input, collection);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
      docs.push(docFromFile(collection, name.slice(0, -5), readJsonFile(path.join(dir, name), 'pull')));
    }
  }
  return docs;
}

function main(argv) {
  const { verb, values } = parseArgs(argv);
  if (['versions', 'page-hash', 'meta-sync'].includes(verb)) return mainTool(verb, values);
  if (verb !== 'push' && verb !== 'pull') throw new UsageError(`unknown verb ${verb}`);
  for (const flag of ['file', 'cursor', 'full']) if (values[flag] !== undefined) throw new UsageError(`${verb} does not take --${flag}`);
  if (!values.project) throw new UsageError(`${verb} needs --project`);
  if (verb === 'push') {
    if (!values.out) throw new UsageError('push needs --out');
    if (values.in) throw new UsageError('push does not take --in');
    const versions = values.versions ? readJsonFile(values.versions, 'push') : {};
    if (!isObject(versions)) throw new UsageError('--versions must hold a JSON object');
    const plan = planPush(values.project, { since: values.since, versions });
    const batches = writePlan(plan, path.resolve(values.out));
    process.stdout.write(`${plan.docs.length} docs in ${batches.length} batches, cursor ${plan.cursor}\n`);
    return;
  }
  if (!values.in) throw new UsageError('pull needs --in');
  if (values.out || values.since || values.versions) throw new UsageError('pull takes only --project and --in');
  const { applied, skipped } = applyPull(values.project, readPullInput(path.resolve(values.in)));
  process.stdout.write(`applied ${applied}, skipped ${skipped}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    // A slug or --since of the wrong shape is a bad argument (2); a missing project or a corrupt store is a failure (1).
    process.exitCode = err instanceof UsageError || err instanceof RangeError ? 2 : 1;
    process.stderr.write(`sync-plan: ${redact(err.message)}\n`);
    if (err instanceof UsageError) process.stderr.write(`${USAGE}\n`);
  }
}

module.exports = { planPush, applyPull };
