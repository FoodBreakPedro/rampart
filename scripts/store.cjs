'use strict';
// The per-user store (spec 5.2): plain JSON and JSONL under RAMPART_HOME (default ~/.rampart).
//   config.json
//   projects/<slug>/project.json, findings.jsonl, dispositions.json, scores.jsonl
//   projects/<slug>/runs/<runId>/run.json, raw/<name>
// Every slug and runId is checked against its format before it reaches a path, and every rewrite goes through a
// temp file in the same directory plus a rename, so a crash never leaves half a file.
// CLI: node scripts/store.cjs <verb> ... (see USAGE). Exit 0 ok, 1 data rejected or not found, 2 usage error.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { rampartHome, projectDir, runDir, newRunId } = require('./lib/paths.cjs');
const { validate, loadSchema } = require('./lib/validate.cjs');
const { redact } = require('./lib/redact.cjs');

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

// Write to a temp file next to the target, then rename over it. A failed write removes the temp file.
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// Text of a file with any BOM removed, or null when it does not exist.
function readOptional(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
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

function readJsonl(file) {
  const text = readOptional(file);
  if (text === null) return [];
  const rows = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new Error(`${path.basename(file)} line ${i + 1} is not valid JSON`);
    }
  });
  return rows;
}

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

// Stamps updated (always) and created (when absent: the stored one if the project exists, else now), validates,
// writes. The caller's object is left alone.
function writeProject(project) {
  const stamp = now();
  const probe = isObject(project) ? { ...project, created: project.created || stamp, updated: stamp } : project;
  assertValid('project', probe, 'project');
  const slug = checkSlug(probe.slug);
  const created = project.created || (readProject(slug) || {}).created || stamp;
  const saved = { ...probe, created };
  writeAtomic(projectFile(slug, 'project.json'), toJson(saved));
  return saved;
}

// ---- findings -----------------------------------------------------------------------------

const readFindings = (slug) => readJsonl(projectFile(slug, 'findings.jsonl'));
const writeFindings = (slug, rows) => writeAtomic(projectFile(slug, 'findings.jsonl'), toJsonl(rows));

// Merge incoming findings into findings.jsonl by id. runId is checked and named in the disposition of a regressed
// finding; a finding itself has no field for it.
// A promotion survives re-scans: if the stored class is 'verified' and the incoming one is 'tool' (the scanner
// re-reporting what triage already confirmed), the stored class and evidence are kept. Other class changes follow
// the incoming finding.
// When a fixed finding reappears, its record in dispositions.json becomes 'regressed' too, so the file never says
// 'fixed' for a regressed finding.
// A finding whose only difference is verification.run counts as unchanged, but the stored verification still moves to the
// incoming one, so it always names the latest run that saw the finding.
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
  for (const incoming of new Map(findings.map((f) => [f.id, f])).values()) {
    const cur = byId.get(incoming.id);
    if (!cur) {
      byId.set(incoming.id, { ...incoming, status: 'open', firstSeen: stamp, lastSeen: stamp });
      counts.added++;
    } else if (cur.status === 'false_positive' || cur.status === 'accepted_risk') {
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

function loadFinding(slug, id) {
  const findings = readFindings(slug);
  const finding = findings.find((f) => f.id === id);
  if (!finding) throw new Error(`no finding ${String(id)} in project ${slug}`);
  return { findings, finding };
}

const readDispositions = (slug) => readJson(projectFile(slug, 'dispositions.json'), {});

// Record the decision in dispositions.json and set the finding's status to match.
function setDisposition(slug, id, { status, reason, by } = {}) {
  checkSlug(slug);
  if (!DISPOSITIONS.includes(status)) throw new Error(`status must be one of ${DISPOSITIONS.join(', ')}`);
  const { findings, finding } = loadFinding(slug, id);
  const dispositions = readDispositions(slug);
  dispositions[id] = { status, reason: redact(String(reason ?? '')), by: String(by ?? ''), at: now() };
  writeAtomic(projectFile(slug, 'dispositions.json'), toJson(dispositions));
  finding.status = status;
  writeFindings(slug, findings);
  return finding;
}

// Promote or demote a finding (the L1 secrets triage uses it); the note is appended to evidence.
function setClass(slug, id, cls, note) {
  checkSlug(slug);
  if (!CLASSES.includes(cls)) throw new Error(`class must be one of ${CLASSES.join(', ')}`);
  const { findings, finding } = loadFinding(slug, id);
  finding.class = cls;
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
  const merged = { ...run, ...patch, runId: run.runId, project: run.project, counts };
  if (FINAL_RUN_STATUSES.includes(patch.status)) merged.finishedAt = patch.finishedAt || now();
  assertValid('run', merged, 'run');
  writeAtomic(file, toJson(merged));
  return merged;
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

function appendScore(slug, snapshot) {
  const file = projectFile(slug, 'scores.jsonl');
  if (!isObject(snapshot)) throw new TypeError('snapshot must be an object');
  const row = { ...snapshot, at: snapshot.at || now() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, toJsonl([row]));
  return row;
}

const readScores = (slug) => readJsonl(projectFile(slug, 'scores.jsonl'));

// ---- CLI ----------------------------------------------------------------------------------

class UsageError extends Error {}

const USAGE = [
  'usage: node scripts/store.cjs <verb> [args] [--json]',
  '  projects',
  '  project <slug>',
  '  project-save <file.json>',
  '  findings <slug> [--status <status>]',
  '  disposition <slug> <id> <status> --reason "<text>" [--by <name>]',
  '  set-class <slug> <id> <class> --note "<text>"',
].join('\n');

const VALUE_FLAGS = ['status', 'reason', 'by', 'note'];
const VERBS = {
  projects: { args: [], flags: [] },
  project: { args: ['slug'], flags: [] },
  'project-save': { args: ['file.json'], flags: [] },
  findings: { args: ['slug'], flags: ['status'] },
  disposition: { args: ['slug', 'id', 'status'], flags: ['reason', 'by'], required: ['reason'] },
  'set-class': { args: ['slug', 'id', 'class'], flags: ['note'], required: ['note'] },
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
    if (name === 'json' && eq === -1) {
      flags.json = true;
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
    return { text: [`${p.slug}: ${p.name} (criticality ${p.criticality}, executor ${p.defaultExecutor})`, ...systems].join('\n'), json: p };
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
  findings: ([slug], { status }) => {
    if (status !== undefined && !FINDING_STATUSES.includes(status)) {
      throw new UsageError(`--status must be one of ${FINDING_STATUSES.join(', ')}`);
    }
    const rows = readFindings(slug).filter((f) => status === undefined || f.status === status);
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
  readFindings, upsertFindings, readDispositions, setDisposition, setClass,
  createRun, finishRun, writeRaw,
  readConfig, writeConfig, appendScore, readScores,
};
