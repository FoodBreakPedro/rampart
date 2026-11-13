'use strict';
// Job progress (skills/rampart/specs/progress.md): a small document per project that says which job is running, its
// steps in order, and how far each one has got, so the dashboard can show the work as it happens. The recipe calls this
// script at each stage boundary and writes the printed document to the live dashboard's database (progress/<slug>); the
// static page reads the same file from the store (render-static.cjs).
//   planSteps({job, layer, systems, live})   -> the fixed step list for a job, every step pending
//   startPlan(slug, opts, now)                -> a new document, saved; it replaces the last job's
//   markStep(slug, stepId, patch, now)        -> the document with that step changed, saved
//   huntCounts(slug, runId)                   -> {hunters: {done, total}, verify: {done, total}} counted from the run's files
//   applyHunt(slug, runId, now)               -> the document with the hunt (or compare) and verify steps set from huntCounts, saved
//   finishPlan(slug, {status, note}, now)     -> the document closed: pending steps skipped, state done or failed, saved
//   readProgress(slug)                        -> the saved document, or null
//   summarize(steps)                          -> {done, total, percent}
// State lives at <store>/projects/<slug>/progress.json, written whole through lib/atomic.cjs. Nothing from a repository
// reaches the document: labels are fixed text, notes are the recipe's own words (redacted, at most 200 characters), and
// the hunt counts come from file names and array lengths only.
// units.json is read defensively: hunters[].key (g03__b1 for a group hunter, <unit>__<class> for a run before 0.5.0,
// <system>__infra-prober for INFRA) and the units' status (`unchanged`, `not-hunted`: planned but given no hunter) are all
// that matter, so a planner that adds fields changes nothing here. A hunter has returned when candidates/<fileKey(key)>.json
// exists; a possible problem has been double-checked when at least one votes/<fileKey(key)>__<ref>__<n>.json names it, with
// refs c1 to c20 as hunt-io allows. A verify run has no units.json: its candidates files are written up front, so only its
// double-checks count.
// CLI (every command prints the document as JSON, the data for an ArtifactData write; --out <file> also writes it there):
//   node scripts/progress.cjs start  --project <slug> --job audit|inventory|verify [--layer L1|L2|L3|INFRA] [--system <id>]
//                                    [--run <runId>] [--job-id <id>] [--live]
//   node scripts/progress.cjs step   --project <slug> --step <id> --status pending|running|done|skipped|failed
//                                    [--done <n>] [--total <n>] [--note <text>]
//   node scripts/progress.cjs hunt   --project <slug> --run <runId>
//   node scripts/progress.cjs finish --project <slug> [--status done|failed] [--note <text>]
//   node scripts/progress.cjs show   --project <slug>
// --now <iso> fixes the clock (tests). Exit 0 ok, 2 bad arguments (an unknown step, no plan to change, a bad slug or run id), 1 anything else.

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { projectDir, runDir } = require('./lib/paths.cjs');
const { writeAtomic } = require('./lib/atomic.cjs');
const { redact } = require('./lib/redact.cjs');

const SLUG_RE = /^[a-z0-9-]{2,40}$/;
const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;
const JOB_ID_RE = /^job-\d{8}-\d{6}-[0-9a-f]{4}$/;
const SYSTEM_RE = /^[A-Za-z0-9._-]{1,64}$/;
const JOBS = Object.freeze(['audit', 'inventory', 'verify']);
const LAYERS = Object.freeze(['L1', 'L2', 'L3', 'INFRA']);
const STEP_STATUSES = Object.freeze(['pending', 'running', 'done', 'skipped', 'failed']);
const FINISHED = Object.freeze(['done', 'skipped', 'failed']);
const NOTE_MAX = 200;
// How long the page waits for the next update before it says the job stopped responding. The recipe updates the
// document at every stage boundary and every few minutes while it waits on a workflow, so 15 minutes is generous.
const STALE_AFTER_SEC = 900;

// Plain names for each layer, as the dashboard uses them.
const LAYER_NAMES = Object.freeze({ L1: 'Basic checks', L2: 'Change review', L3: 'Deep review', INFRA: 'Server check' });

class UsageError extends Error {}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fileKey = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, '+');
const progressFile = (slug) => path.join(projectDir(checkSlug(slug)), 'progress.json');

function checkSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw new UsageError('slug must be 2 to 40 characters of a-z, 0-9 and "-"');
  return slug;
}

function checkRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) throw new UsageError('run id must look like 2026-10-23T18-02-11Z');
  return runId;
}

function isoOf(now) {
  const d = now === undefined ? new Date() : new Date(now);
  if (Number.isNaN(d.getTime())) throw new TypeError('now must be a valid time');
  return d.toISOString();
}

// A note as the document may carry it: one line, redacted, at most NOTE_MAX characters; null for nothing.
function cleanNote(note) {
  if (note === undefined || note === null) return null;
  const text = redact(String(note)).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, NOTE_MAX) : null;
}

const step = (id, label, unit = null) => ({ id, label, status: 'pending', done: null, total: null, unit, note: null });

// The steps of a job, in the order the recipe runs them. L1 checks are planned per system, from what each one has: a repo
// gets the secrets and dependency checks, a live URL the headers check. A system with neither gets none (the recipe says so).
function planSteps({ job, layer = null, systems = [], live = false } = {}) {
  const steps = [];
  const many = systems.length > 1;
  const named = (label, sys) => (many ? `${label}: ${sys.name || sys.id}` : label);
  if (job === 'inventory') {
    steps.push(step('scan', 'Looking through the folder'), step('map', 'Naming the parts it found'),
      step('questions', 'Waiting for your answers'), step('save', 'Saving the project'));
  } else if (job === 'verify') {
    steps.push(step('plan', 'Getting the problems ready to re-check'),
      step('verify', 'AI checkers re-checking each problem in the current code', 'problems'),
      step('assemble', 'Recording the outcome'));
  } else if (layer === 'L1') {
    for (const sys of systems) {
      const key = fileKey(sys.id);
      if (isObject(sys.repo)) {
        steps.push(step(`secrets:${key}`, named('Looking for leaked keys and passwords', sys)));
        steps.push(step(`deps:${key}`, named('Checking libraries for known security holes', sys)));
      }
      if (isObject(sys.live) && typeof sys.live.url === 'string') steps.push(step(`headers:${key}`, named("Checking the website's security settings", sys)));
    }
    steps.push(step('triage', 'Sorting real keys from test values'));
  } else if (layer === 'L2' || layer === 'L3') {
    steps.push(step('plan', layer === 'L2' ? 'Finding what changed and splitting it into code groups' : 'Splitting the code into groups'),
      step('hunt', layer === 'L2' ? 'AI reviewers reading the changed code' : 'AI reviewers reading the code groups', 'AI reviewers'),
      step('verify', 'AI checkers double-checking possible problems', 'possible problems'),
      step('assemble', 'Deciding what counts'),
      step('report', 'Writing the report'));
  } else if (layer === 'INFRA') {
    steps.push(step('probe', "Reading the server's settings"),
      step('compare', 'An AI agent comparing them with safe settings', 'AI agents'),
      step('verify', 'AI checkers double-checking possible problems', 'possible problems'),
      step('assemble', 'Deciding what counts'),
      step('report', 'Writing the report'));
  } else {
    throw new UsageError('an audit needs --layer L1, L2, L3 or INFRA');
  }
  steps.push(step('score', 'Scoring'));
  if (live) steps.push(step('sync', 'Updating the live dashboard'));
  return steps;
}

// {done, total, percent}: done counts the finished steps (done, skipped or failed); percent also credits a running step's
// own share when it has counts.
function summarize(steps) {
  const all = Array.isArray(steps) ? steps : [];
  let credit = 0;
  let done = 0;
  for (const s of all) {
    if (FINISHED.includes(s.status)) {
      credit += 1;
      done += 1;
    } else if (s.status === 'running' && Number.isInteger(s.total) && s.total > 0 && Number.isInteger(s.done)) {
      credit += Math.min(1, Math.max(0, s.done / s.total));
    }
  }
  return { done, total: all.length, percent: all.length ? Math.round((credit / all.length) * 100) : 0 };
}

function readProgress(slug) {
  let text;
  try {
    text = fs.readFileSync(progressFile(slug), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const doc = JSON.parse(text);
    return isObject(doc) && Array.isArray(doc.steps) ? doc : null;
  } catch {
    throw new Error(`progress.json of ${slug} is not valid JSON`);
  }
}

function save(slug, doc, now) {
  const at = isoOf(now);
  const out = { ...doc, updatedAt: at, overall: summarize(doc.steps) };
  writeAtomic(progressFile(slug), `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

// The project's systems in scope, from the store (only what a label needs: id, name, repo, live).
function systemsInScope(slug, systemId) {
  let project = null;
  try {
    project = require('./store.cjs').readProject(slug);
  } catch {
    project = null;
  }
  const systems = isObject(project) && Array.isArray(project.systems) ? project.systems.filter(isObject) : [];
  const picked = systemId ? systems.filter((s) => s.id === systemId) : systems;
  return { project, systems: picked };
}

function titleOf(job, layer, project, system) {
  const what = job === 'inventory' ? 'Mapping the project' : job === 'verify' ? 'Re-checking a problem' : LAYER_NAMES[layer];
  const where = system ? system.name || system.id : isObject(project) ? project.name || project.slug : null;
  return where ? `${what}: ${where}` : what;
}

function startPlan(slug, { job, layer = null, system = null, runId = null, jobId = null, live = false } = {}, now) {
  checkSlug(slug);
  if (!JOBS.includes(job)) throw new UsageError(`--job must be one of ${JOBS.join(', ')}`);
  if (layer !== null && !LAYERS.includes(layer)) throw new UsageError(`--layer must be one of ${LAYERS.join(', ')}`);
  if (job === 'audit' && layer === null) throw new UsageError('an audit needs --layer');
  if (system !== null && !SYSTEM_RE.test(system)) throw new UsageError('--system must be a system id');
  if (runId !== null) checkRunId(runId);
  if (jobId !== null && !JOB_ID_RE.test(jobId)) throw new UsageError('--job-id must look like job-20261023-120000-abcd');
  const { project, systems } = systemsInScope(slug, system);
  const steps = planSteps({ job, layer, systems, live });
  const at = isoOf(now);
  const doc = {
    project: slug,
    job,
    layer: job === 'audit' ? layer : null,
    system,
    runId,
    jobId,
    title: titleOf(job, layer, project, system ? systems[0] : null),
    state: 'running',
    startedAt: at,
    updatedAt: at,
    finishedAt: null,
    staleAfterSec: STALE_AFTER_SEC,
    overall: summarize(steps),
    steps,
  };
  return save(slug, doc, at);
}

function requirePlan(slug) {
  const doc = readProgress(slug);
  if (!doc) throw new UsageError(`no progress plan for ${slug}; run start first`);
  return doc;
}

function count(value, name) {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`${name} must be a whole number`);
  return n;
}

// Change one step. A step that starts running stamps startedAt; one that finishes stamps finishedAt. Counts and the
// note are replaced only when given. A plan that already finished is reopened (a recipe that marks a late step).
function markStep(slug, stepId, { status, done, total, note } = {}, now) {
  const doc = requirePlan(slug);
  const at = isoOf(now);
  const i = doc.steps.findIndex((s) => s.id === stepId);
  if (i === -1) throw new UsageError(`no step ${JSON.stringify(String(stepId))} in this plan (it has ${doc.steps.map((s) => s.id).join(', ')})`);
  if (status !== undefined && !STEP_STATUSES.includes(status)) throw new UsageError(`--status must be one of ${STEP_STATUSES.join(', ')}`);
  const next = { ...doc.steps[i] };
  if (status !== undefined) {
    if (status === 'running' && next.status !== 'running') next.startedAt = at;
    if (FINISHED.includes(status)) next.finishedAt = at;
    next.status = status;
  }
  const d = count(done, '--done');
  const t = count(total, '--total');
  if (d !== undefined) next.done = d;
  if (t !== undefined) next.total = t;
  if (note !== undefined) next.note = cleanNote(note);
  const steps = doc.steps.slice();
  steps[i] = next;
  const state = doc.state === 'running' || status === undefined ? doc.state : 'running';
  return save(slug, { ...doc, steps, state, finishedAt: state === 'running' ? null : doc.finishedAt }, at);
}

const listDir = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

// Hunt-io's names: a vote file is <hunterKey>__<ref>__<n>.json with refs c1 to c20 (hunt-io VOTE_FILE_RE).
const VOTE_FILE_RE = /^(.+)__(c(?:[1-9]|1[0-9]|20))__([1-9][0-9]*)\.json$/;

// Counted from the run directory: hunters planned (units.json hunters[].key) against candidate files present, the
// possible problems in those files against the ones a vote names, and the units planned without a hunter (`unchanged`
// since their last review, `not-hunted` because all their source is over the size cap). Anything unreadable counts as
// nothing, never an error.
function huntCounts(slug, runId) {
  const dir = runDir(checkSlug(slug), checkRunId(runId));
  let units = null;
  try {
    units = JSON.parse(fs.readFileSync(path.join(dir, 'units.json'), 'utf8'));
  } catch {
    units = null;
  }
  const keys = new Set();
  for (const h of isObject(units) && Array.isArray(units.hunters) ? units.hunters : []) {
    if (isObject(h) && typeof h.key === 'string' && h.key !== '') keys.add(fileKey(h.key));
  }
  const files = new Set(listDir(path.join(dir, 'candidates')).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)));
  // INFRA plans no hunters: its one prober writes <system>__infra-prober.json.
  if (keys.size === 0 && isObject(units) && units.layer === 'INFRA' && typeof units.system === 'string') keys.add(`${fileKey(units.system)}__infra-prober`);
  let returned = 0;
  for (const k of keys) if (files.has(k)) returned += 1;
  const skipped = { unchanged: 0, notHunted: 0 };
  for (const u of isObject(units) && Array.isArray(units.units) ? units.units : []) {
    if (isObject(u) && u.status === 'unchanged') skipped.unchanged += 1;
    else if (isObject(u) && u.status === 'not-hunted') skipped.notHunted += 1;
  }
  const refs = new Set();
  for (const name of files) {
    let list;
    try {
      list = JSON.parse(fs.readFileSync(path.join(dir, 'candidates', `${name}.json`), 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    list.forEach((c, i) => refs.add(`${name}__${isObject(c) && typeof c.ref === 'string' ? c.ref : `c${i + 1}`}`));
  }
  const voted = new Set();
  for (const name of listDir(path.join(dir, 'votes'))) {
    const m = VOTE_FILE_RE.exec(name);
    if (m && refs.has(`${m[1]}__${m[2]}`)) voted.add(`${m[1]}__${m[2]}`);
  }
  return { hunters: { done: returned, total: keys.size }, verify: { done: voted.size, total: refs.size }, skipped };
}

// The hunt step's note for the units planned without a hunter, in the dashboard's words; null when there are none.
function skippedNote({ unchanged, notHunted }) {
  const parts = [];
  if (unchanged) parts.push(`${unchanged} ${unchanged === 1 ? 'area' : 'areas'} of code unchanged since the last review skipped`);
  if (notHunted) parts.push(`${notHunted} too large to read`);
  return parts.length ? parts.join('; ') : null;
}

// The hunt (L2, L3) or compare (INFRA) step and the verify step set from the run's files. A step with all its work
// returned is left running: the recipe marks it done when the workflow has finished, since a hunter can still be writing.
// Units skipped as unchanged or too large to read go in the hunt step's note.
function applyHunt(slug, runId, now) {
  const doc = requirePlan(slug);
  const c = huntCounts(slug, runId);
  const at = isoOf(now);
  const note = skippedNote(c.skipped);
  const steps = doc.steps.map((s) => {
    if ((s.id === 'hunt' || s.id === 'compare') && !FINISHED.includes(s.status)) {
      const out = { ...s, status: 'running', startedAt: s.startedAt || at, done: c.hunters.done, total: c.hunters.total };
      if (note) out.note = note;
      return out;
    }
    if (s.id === 'verify' && !FINISHED.includes(s.status) && c.verify.total > 0) {
      return { ...s, status: c.verify.done > 0 ? 'running' : s.status, startedAt: s.startedAt || (c.verify.done > 0 ? at : undefined), done: c.verify.done, total: c.verify.total };
    }
    return s;
  });
  return save(slug, { ...doc, runId: doc.runId || runId, steps }, at);
}

// Close the plan: steps never reached are skipped (a running one becomes done, or failed when the job failed).
function finishPlan(slug, { status = 'done', note } = {}, now) {
  if (status !== 'done' && status !== 'failed') throw new UsageError('--status must be done or failed');
  const doc = requirePlan(slug);
  const at = isoOf(now);
  const steps = doc.steps.map((s) => {
    if (s.status === 'pending') return { ...s, status: 'skipped', finishedAt: at };
    if (s.status === 'running') return { ...s, status: status === 'failed' ? 'failed' : 'done', finishedAt: at };
    return s;
  });
  const out = { ...doc, steps, state: status, finishedAt: at };
  if (note !== undefined) out.note = cleanNote(note);
  return save(slug, out, at);
}

// ---- CLI ----------------------------------------------------------------------------------

const USAGE = [
  'usage: node scripts/progress.cjs start --project <slug> --job audit|inventory|verify [--layer <L>] [--system <id>] [--run <runId>] [--job-id <id>] [--live] [--out <file>]',
  '       node scripts/progress.cjs step --project <slug> --step <id> --status pending|running|done|skipped|failed [--done <n>] [--total <n>] [--note <text>] [--out <file>]',
  '       node scripts/progress.cjs hunt --project <slug> --run <runId> [--out <file>]',
  '       node scripts/progress.cjs finish --project <slug> [--status done|failed] [--note <text>] [--out <file>]',
  '       node scripts/progress.cjs show --project <slug> [--out <file>]',
].join('\n');

function parseArgs(argv) {
  let parsed;
  try {
    parsed = util.parseArgs({
      args: argv,
      options: {
        project: { type: 'string' }, job: { type: 'string' }, layer: { type: 'string' }, system: { type: 'string' },
        run: { type: 'string' }, 'job-id': { type: 'string' }, live: { type: 'boolean' }, step: { type: 'string' },
        status: { type: 'string' }, done: { type: 'string' }, total: { type: 'string' }, note: { type: 'string' },
        out: { type: 'string' }, now: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    throw new UsageError(err.message.split('\n')[0]);
  }
  const [command, ...rest] = parsed.positionals;
  if (rest.length) throw new UsageError('one command at a time');
  if (!['start', 'step', 'hunt', 'finish', 'show'].includes(command)) throw new UsageError('command must be start, step, hunt, finish or show');
  if (!parsed.values.project) throw new UsageError('--project is required');
  return { command, ...parsed.values };
}

function run(o) {
  const now = o.now;
  if (o.command === 'start') {
    return startPlan(o.project, {
      job: o.job, layer: o.layer ?? null, system: o.system ?? null, runId: o.run ?? null, jobId: o['job-id'] ?? null, live: o.live === true,
    }, now);
  }
  if (o.command === 'step') {
    if (!o.step) throw new UsageError('--step is required');
    if (o.status === undefined && o.done === undefined && o.total === undefined && o.note === undefined) throw new UsageError('nothing to change: give --status, --done, --total or --note');
    return markStep(o.project, o.step, { status: o.status, done: o.done, total: o.total, note: o.note }, now);
  }
  if (o.command === 'hunt') {
    if (!o.run) throw new UsageError('--run is required');
    return applyHunt(o.project, o.run, now);
  }
  if (o.command === 'finish') return finishPlan(o.project, { status: o.status ?? 'done', note: o.note }, now);
  checkSlug(o.project);
  const doc = readProgress(o.project);
  if (!doc) throw new UsageError(`no progress plan for ${o.project}`);
  return doc;
}

function main(argv) {
  const o = parseArgs(argv);
  const doc = run(o);
  const text = `${JSON.stringify(doc)}\n`;
  if (o.out) writeAtomic(path.resolve(o.out), `${JSON.stringify(doc, null, 2)}\n`);
  process.stdout.write(text);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    const usage = err instanceof UsageError;
    process.exitCode = usage ? 2 : 1;
    process.stderr.write(`progress: ${redact(err.message)}\n`);
    if (usage) process.stderr.write(`${USAGE}\n`);
  }
}

module.exports = {
  planSteps, startPlan, markStep, huntCounts, applyHunt, finishPlan, readProgress, summarize, fileKey,
  LAYER_NAMES, STEP_STATUSES, STALE_AFTER_SEC, UsageError,
};
