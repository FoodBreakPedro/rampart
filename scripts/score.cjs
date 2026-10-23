'use strict';
// The score sheet (spec 5.6). Per system, two parts:
//   coverage, 40 points: for each layer the system declares, 1 when its last successful run is inside the layer's cadence
//     window, 0.5 inside two windows, 0 beyond or never run; 40 times the mean. No layers means nothing is missing: 40.
//   findings, 60 points: start at 60, subtract WEIGHTS[class][severity] for each open or regressed finding of the system,
//     floor 0. `hardening` costs nothing and is counted beside the grade instead.
// score = coverage + findings, one decimal; grade A >= 90, B >= 75, C >= 60, D >= 40, F below (judged on the rounded score,
// so a sheet never shows 90.0 beside a B). The project score is the mean of its systems' scores weighted by criticality,
// and its trend is the change since the last saved project snapshot.
// CLI: node scripts/score.cjs <slug> [--json] [--no-save]. Prints the sheet (counts and dates only, never finding text)
// and appends {kind: 'project', score, grade, at} to scores.jsonl unless --no-save. Exit 0 ok, 2 for a missing project, a bad
// slug or bad arguments, 1 for anything unexpected (a corrupt store, say).

const util = require('node:util');
const store = require('./store.cjs');
const { redact } = require('./lib/redact.cjs');

const DAY_MS = 24 * 60 * 60 * 1000;
const COVERAGE_POINTS = 40;
const FINDINGS_POINTS = 60;
const COUNTED_STATUSES = ['open', 'regressed'];
const GRADES = [[90, 'A'], [75, 'B'], [60, 'C'], [40, 'D']];

const deepFreeze = (value) => {
  for (const v of Object.values(value)) if (v !== null && typeof v === 'object') deepFreeze(v);
  return Object.freeze(value);
};

// Points deducted per open finding, by class then severity. `tool` is half of `verified`.
const WEIGHTS = deepFreeze({
  verified: { CRITICAL: 25, HIGH: 12, MEDIUM: 5, LOW: 1 },
  tool: { CRITICAL: 12.5, HIGH: 6, MEDIUM: 2.5, LOW: 0.5 },
  hardening: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
});

// How much a system counts in the project score. A system with no criticality (or one not in this table) weighs as public.
const CRITICALITY_WEIGHT = deepFreeze({ auth: 3, billing: 3, data: 3, public: 2, internal: 1 });

const round1 = (n) => Math.round(n * 10) / 10;

function checkNow(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  return now.getTime();
}

function checkCadence(cadenceDays) {
  if (typeof cadenceDays !== 'number' || !Number.isFinite(cadenceDays) || cadenceDays <= 0) {
    throw new TypeError('cadenceDays must be a positive number');
  }
  return cadenceDays;
}

// ---- grade and credit ---------------------------------------------------------------------

function gradeFor(score) {
  if (typeof score !== 'number' || Number.isNaN(score)) throw new TypeError('score must be a number');
  const hit = GRADES.find(([floor]) => score >= floor);
  return hit ? hit[1] : 'F';
}

// 1 when the last run is no older than the cadence, 0.5 when no older than twice the cadence, else 0. A layer that never ran
// (null) or whose time cannot be read has no credit; a time in the future (clock skew) counts as fresh.
function layerCredit(lastRunAt, cadenceDays, now) {
  const at = checkNow(now);
  checkCadence(cadenceDays);
  const last = typeof lastRunAt === 'string' ? Date.parse(lastRunAt) : NaN;
  if (Number.isNaN(last)) return 0;
  const ageDays = (at - last) / DAY_MS;
  if (ageDays <= cadenceDays) return 1;
  return ageDays <= 2 * cadenceDays ? 0.5 : 0;
}

// ---- one system ---------------------------------------------------------------------------

// When the latest successful run of this layer on this system finished (the stored finishedAt, else startedAt), or null.
// A run counts when it is done and names both the system and the layer; one whose time cannot be read is skipped.
function lastRunOf(runs, systemId, layer) {
  let best = null;
  let bestAt = -Infinity;
  for (const r of runs) {
    if (!r || r.status !== 'done' || !Array.isArray(r.systems) || !r.systems.includes(systemId)) continue;
    if (!Array.isArray(r.layers) || !r.layers.includes(layer)) continue;
    const stamp = r.finishedAt || r.startedAt;
    const at = typeof stamp === 'string' ? Date.parse(stamp) : NaN;
    if (!Number.isNaN(at) && at > bestAt) {
      best = stamp;
      bestAt = at;
    }
  }
  return best;
}

function deduction(f) {
  const bySeverity = Object.hasOwn(WEIGHTS, f.class) ? WEIGHTS[f.class] : undefined;
  if (!bySeverity || !Object.hasOwn(bySeverity, f.severity)) {
    // Skipping it would raise the score of a system with something wrong in its record.
    throw new TypeError(`finding ${String(f.id)} has a class or severity the score table does not know`);
  }
  return bySeverity[f.severity];
}

// {coverage, findingsScore, hardening, score, grade, layers}. Throws TypeError for a bad now, a bad cadence or a finding the
// table cannot weigh. Nothing it is given is changed.
function scoreSystem(system, findings, runs, now) {
  checkNow(now);
  const layers = {};
  let credits = 0;
  let layerCount = 0;
  for (const [layer, config] of Object.entries(system.layers || {})) {
    const cadenceDays = config && config.cadenceDays;
    try {
      checkCadence(cadenceDays);
    } catch (err) {
      throw new TypeError(`system ${system.id} layer ${layer}: ${err.message}`);
    }
    const lastRun = lastRunOf(runs, system.id, layer);
    const credit = layerCredit(lastRun, cadenceDays, now);
    const nextDue = lastRun === null ? null : new Date(Date.parse(lastRun) + cadenceDays * DAY_MS).toISOString();
    layers[layer] = { lastRun, nextDue, credit };
    credits += credit;
    layerCount++;
  }
  const coverage = layerCount === 0 ? COVERAGE_POINTS : (COVERAGE_POINTS * credits) / layerCount;

  let deducted = 0;
  let hardening = 0;
  for (const f of findings) {
    if (!f || f.system !== system.id || !COUNTED_STATUSES.includes(f.status)) continue;
    if (f.class === 'hardening') hardening++;
    deducted += deduction(f);
  }
  const findingsScore = Math.max(0, FINDINGS_POINTS - deducted);

  const score = round1(coverage + findingsScore);
  return { coverage: round1(coverage), findingsScore: round1(findingsScore), hardening, score, grade: gradeFor(score), layers };
}

// ---- the project --------------------------------------------------------------------------

const criticalityWeight = (system) =>
  Object.hasOwn(CRITICALITY_WEIGHT, system.criticality) ? CRITICALITY_WEIGHT[system.criticality] : CRITICALITY_WEIGHT.public;

// {score, grade, systems, trend}. The project score is the mean of the systems' (rounded) scores weighted by criticality; a
// project with no systems has measured nothing and scores 0. trend is this score minus the score of the latest saved project
// snapshot in scores.jsonl (snapshots of other kinds, such as the headers check's, are not part of this history), or null
// when there is none. Reads the store; writes nothing.
function scoreProject(project, findings, runs, now) {
  const systems = {};
  let weighted = 0;
  let weights = 0;
  for (const system of project.systems || []) {
    const s = scoreSystem(system, findings, runs, now);
    systems[system.id] = s;
    const w = criticalityWeight(system);
    weighted += s.score * w;
    weights += w;
  }
  const score = weights === 0 ? 0 : round1(weighted / weights);
  const previous = store.readScores(project.slug).filter((s) => s && s.kind === 'project' && Number.isFinite(s.score)).pop();
  return { score, grade: gradeFor(score), systems, trend: previous ? round1(score - previous.score) : null };
}

// ---- CLI ----------------------------------------------------------------------------------

class UsageError extends Error {}

const USAGE = 'usage: node scripts/score.cjs <slug> [--json] [--no-save]';

function parseArgs(argv) {
  let parsed;
  try {
    parsed = util.parseArgs({
      args: argv,
      options: { json: { type: 'boolean' }, 'no-save': { type: 'boolean' } },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    throw new UsageError(err.message.split('\n')[0]);
  }
  if (parsed.positionals.length !== 1) throw new UsageError('score takes exactly one <slug>');
  return { slug: parsed.positionals[0], json: parsed.values.json === true, save: parsed.values['no-save'] !== true };
}

const day = (iso) => new Date(iso).toISOString().slice(0, 10);
const signed = (n) => (n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1));

// Columns padded to the widest cell; the last column is left unpadded.
function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] + 2))).join('')).join('\n');
}

// Counts, grades, scores and dates only: nothing a finding says reaches the output.
function render(slug, result) {
  const trend = result.trend === null ? 'none' : signed(result.trend);
  const lines = [`${slug}: grade ${result.grade}, score ${result.score.toFixed(1)}, trend ${trend}`];
  const ids = Object.keys(result.systems);
  if (ids.length === 0) return [...lines, 'no systems in the inventory yet'].join('\n');
  lines.push('', table([
    ['SYSTEM', 'GRADE', 'SCORE', 'COVERAGE', 'FINDINGS', 'HARDENING'],
    ...ids.map((id) => {
      const s = result.systems[id];
      return [id, s.grade, s.score.toFixed(1), s.coverage.toFixed(1), s.findingsScore.toFixed(1), String(s.hardening)];
    }),
  ]));
  for (const id of ids) {
    const layers = Object.entries(result.systems[id].layers);
    if (layers.length === 0) continue;
    lines.push('', `${id} layers`);
    for (const [layer, l] of layers) {
      lines.push(`  ${layer.padEnd(5)} last ${l.lastRun === null ? 'never' : day(l.lastRun)}  next due ${l.nextDue === null ? 'now' : day(l.nextDue)}  credit ${l.credit}`);
    }
  }
  return lines.join('\n');
}

function main(argv) {
  const { slug, json, save } = parseArgs(argv);
  const project = store.readProject(slug);
  if (!project) throw new RangeError(`project ${slug} not found`);
  const now = new Date();
  const result = scoreProject(project, store.readFindings(slug), store.readRuns(slug), now);
  const at = now.toISOString();
  // The trend above is against the previous snapshot, so this one is saved only after it is computed.
  if (save) store.appendScore(slug, { kind: 'project', score: result.score, grade: result.grade, at });
  process.stdout.write(`${json ? JSON.stringify({ project: slug, at, ...result }, null, 2) : render(slug, result)}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    // A slug of the wrong shape or a project that is not there is a bad argument (2); anything else is a failure (1).
    process.exitCode = err instanceof UsageError || err instanceof RangeError ? 2 : 1;
    process.stderr.write(`score: ${redact(err.message)}\n`);
    if (err instanceof UsageError) process.stderr.write(`${USAGE}\n`);
  }
}

module.exports = { layerCredit, scoreSystem, scoreProject, gradeFor, WEIGHTS, CRITICALITY_WEIGHT };
