'use strict';
// Jobs (spec 5.7): ids, cost estimates, routing and the patches an executor writes. Pure logic; the DB itself is the
// recipes' business (a claim is an ArtifactData get, a check that the job is queued, then an update with if_version).
//   newJobId(now, rand?)                      -> 'job-<YYYYMMDD-HHmmss>-<4 hex>' in UTC, so ids sort by time
//   costEstimate({type, layer, units?, effort?, classes?, probes?, openVerified?}) -> {agents, note}
//   route({project, system, type, layer})     -> {executorKind: 'local' | 'cloud', reason}
//   claimPatch(job, executorId, now)          -> {status: 'claimed', claimedBy, claimedAt, updatedAt}; throws unless queued
//   completionPatch(job, {runId, status, resultSummary}, now) -> status done|failed with finishedAt, updatedAt; the summary redacted, 500 chars
//   refusalPatch(job, now)                    -> a failed job that was not created by the owner
// `now` is a Date, an ISO string or milliseconds. Cost is an estimate of subagents, not money.
//
// The dashboard page has no module loader, so it embeds copies of PAGE_FUNCTIONS (Task 6 tests the copies against these).
// Those are plain function declarations: no require, no Node-only global, no reference to anything outside the list. The page
// never completes a job, so completionPatch (which needs the Node redactor) is not among them.
//
// CLI (each command prints JSON with --json; claim-patch, completion-patch and refusal-patch always do):
//   node scripts/jobs.cjs new-id [--now <iso>]
//   node scripts/jobs.cjs cost --type <t> [--layer <L>] [--units n] [--effort low|medium|high] [--classes n] [--probes n] [--open-verified n]
//   node scripts/jobs.cjs route (--project <slug> | --project-file <file>) --system <id> [--type <t>] [--layer <L>]
//   node scripts/jobs.cjs claim-patch --job <file> --executor <id> [--now <iso>]
//   node scripts/jobs.cjs completion-patch --job <file> --status done|failed [--run-id <id>] [--summary <text>] [--now <iso>]
//   node scripts/jobs.cjs refusal-patch --job <file> [--now <iso>]
// Exit 0 ok, 2 bad arguments, 1 anything else (a job that is not queued, a missing file).

const fs = require('node:fs');
const util = require('node:util');
const { redact } = require('./lib/redact.cjs');

// ---- the page functions ---------------------------------------------------------------------

// A time as an ISO string. Throws on null, on anything that is not a valid time and on a year outside 0000-9999 (its ISO
// string would carry a sign or more digits, and an id built from it would be malformed).
function toIsoTime(now) {
  if (now === null) throw new TypeError('now must be a valid time');
  const d = now === undefined ? new Date() : new Date(now);
  const iso = Number.isNaN(d.getTime()) ? '' : d.toISOString();
  if (!/^\d{4}-/.test(iso)) throw new TypeError('now must be a valid time');
  return iso;
}

// A non-negative whole number, or the default when the value is absent.
function wholeCount(value, name, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative whole number`);
  return value;
}

// True for a github.com remote in the forms git uses: github.com/o/r, github.com:o/r, https://github.com/o/r,
// ssh://git@github.com/o/r and git@github.com:o/r.git. The host must be exactly github.com.
function isGithubRemote(remote) {
  if (typeof remote !== 'string') return false;
  const bare = remote.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^/@]*@/, '');
  return /^github\.com[/:]/i.test(bare);
}

// job-<YYYYMMDD-HHmmss>-<4 hex>, UTC. rand() gives an integer 0..65535; the default is crypto.getRandomValues when the
// runtime has it (Node 20 and every browser do), else Math.random.
function newJobId(now, rand) {
  const iso = toIsoTime(now);
  const pick =
    rand ||
    function () {
      const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
      if (c && typeof c.getRandomValues === 'function') return c.getRandomValues(new Uint16Array(1))[0];
      return Math.floor(Math.random() * 65536);
    };
  const n = pick();
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new RangeError('rand must give a whole number from 0 to 65535');
  const stamp = iso.slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return `job-${stamp}-${n.toString(16).padStart(4, '0')}`;
}

// The estimated number of subagents a job spawns, and a note that states the numbers. L1 runs scripts only; L2 is
// min(units, 10) x 5 classes x 2 verifiers; L3 is units x 5|10|classes by effort x 2; INFRA is probes + 2; verify is one agent per
// open verified finding; inventory is one. Defaults: 10 units, 15 classes, 6 probes, 0 open verified findings, medium effort.
function costEstimate(input) {
  if (!input || typeof input !== 'object') throw new TypeError('costEstimate needs {type, layer, ...}');
  const type = input.type;
  const known = ['inventory', 'audit', 'verify', 'fix', 'apply', 'dashboard', 'doctor', 'import'];
  if (!known.includes(type)) throw new RangeError(`unknown job type ${JSON.stringify(type)}`);
  if (type === 'inventory') return { agents: 1, note: 'inventory: 1 agent (estimate)' };
  if (type === 'verify') {
    const open = wholeCount(input.openVerified, 'openVerified', 0);
    return { agents: open, note: `verify: ${open} open verified findings, 1 agent each = ${open} agents (estimate)` };
  }
  if (type === 'fix') return { agents: 1, note: 'fix: 1 agent session (estimate)' };
  if (type === 'apply') return { agents: 0, note: 'apply: applies a reviewed change, no agents (estimate)' };
  if (type !== 'audit') return { agents: 0, note: `${type}: scripts only, no agents (estimate)` };

  const layer = input.layer;
  if (layer === 'L1') return { agents: 0, note: 'L1: scripts only, ~1 min, 0 agents (estimate)' };
  if (layer === 'INFRA') {
    const probes = wholeCount(input.probes, 'probes', 6);
    return { agents: probes + 2, note: `INFRA: ${probes} probes + 2 = ${probes + 2} agents (estimate)` };
  }
  if (layer === 'L2') {
    const units = Math.min(wholeCount(input.units, 'units', 10), 10);
    return { agents: units * 5 * 2, note: `L2: ${units} units × 5 classes × 2 verifiers = ${units * 5 * 2} agents (estimate)` };
  }
  if (layer === 'L3') {
    const units = wholeCount(input.units, 'units', 10);
    const effort = input.effort === undefined ? 'medium' : input.effort;
    if (effort !== 'low' && effort !== 'medium' && effort !== 'high') throw new RangeError('effort must be low, medium or high');
    const classes = effort === 'low' ? 5 : effort === 'medium' ? 10 : wholeCount(input.classes, 'classes', 15);
    return { agents: units * classes * 2, note: `L3 (${effort}): ${units} units × ${classes} classes × 2 verifiers = ${units * classes * 2} agents (estimate)` };
  }
  throw new RangeError('layer must be L1, L2, L3 or INFRA for an audit');
}

// Where a job runs. Cloud only when the project allows it, the system has no host (a host is reached from here), the repo is on
// github.com and the work is not INFRA or apply. Anything else, and anything unreadable, is local.
function route(args) {
  const a = args || {};
  const project = a.project || {};
  const system = a.system || {};
  if (a.type === 'apply') return { executorKind: 'local', reason: 'apply changes run locally' };
  if (a.layer === 'INFRA') return { executorKind: 'local', reason: 'infra checks need the local network, so they run locally' };
  if (system.host) return { executorKind: 'local', reason: 'this system is reached through a host, so it runs locally' };
  if (system.executor === 'local') return { executorKind: 'local', reason: 'this system is set to run locally' };
  if (project.cloudAllowed !== true) return { executorKind: 'local', reason: 'cloud is not allowed for this project' };
  if (!isGithubRemote(system.repo && system.repo.remote)) return { executorKind: 'local', reason: 'cloud needs a repo on github.com' };
  return { executorKind: 'cloud', reason: 'repo on github.com and the project allows cloud' };
}

// The patch that claims a queued job. The recipe applies it with if_version, so a second executor loses the race.
function claimPatch(job, executorId, now) {
  if (!job || typeof job !== 'object') throw new TypeError('claimPatch needs a job');
  if (job.status !== 'queued') throw new Error(`job ${job.id} is ${job.status}, not queued`);
  if (typeof executorId !== 'string' || executorId === '') throw new TypeError('claimPatch needs an executor id');
  const at = toIsoTime(now);
  return { status: 'claimed', claimedBy: executorId, claimedAt: at, updatedAt: at };
}

// The patch for a job someone other than the owner queued: refused, never run.
function refusalPatch(job, now) {
  if (!job || typeof job !== 'object') throw new TypeError('refusalPatch needs a job');
  const at = toIsoTime(now);
  return { status: 'failed', resultSummary: 'not created by the owner', finishedAt: at, updatedAt: at };
}

// ---- Node only ------------------------------------------------------------------------------

const SUMMARY_MAX = 500;

// Redacted first, then capped, so a credential cut by the cap cannot leave a fragment of itself behind.
function summaryText(text) {
  const clean = redact(String(text));
  if (clean.length <= SUMMARY_MAX) return clean;
  let cut = clean.slice(0, SUMMARY_MAX - 1);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

// The patch that finishes a job: done or failed only.
function completionPatch(job, result, now) {
  if (!job || typeof job !== 'object') throw new TypeError('completionPatch needs a job');
  if (!result || typeof result !== 'object') throw new TypeError('completionPatch needs {runId, status, resultSummary}');
  if (result.status !== 'done' && result.status !== 'failed') throw new RangeError('status must be done or failed');
  const at = toIsoTime(now);
  const patch = { status: result.status };
  if (result.runId !== undefined && result.runId !== null) patch.runId = String(result.runId);
  if (result.resultSummary !== undefined && result.resultSummary !== null) patch.resultSummary = summaryText(result.resultSummary);
  patch.finishedAt = at;
  patch.updatedAt = at;
  return patch;
}

const PAGE_FUNCTIONS = ['toIsoTime', 'wholeCount', 'isGithubRemote', 'newJobId', 'costEstimate', 'route', 'claimPatch', 'refusalPatch'];

// ---- CLI ------------------------------------------------------------------------------------

class UsageError extends Error {}

const USAGE = [
  'usage: node scripts/jobs.cjs <command> [options]',
  '  new-id [--now <iso>]',
  '  cost --type <t> [--layer L1|L2|L3|INFRA] [--units n] [--effort low|medium|high] [--classes n] [--probes n] [--open-verified n]',
  '  route (--project <slug> | --project-file <file>) --system <id> [--type <t>] [--layer <L>]',
  '  claim-patch --job <file> --executor <id> [--now <iso>]',
  '  completion-patch --job <file> --status done|failed [--run-id <id>] [--summary <text>] [--now <iso>]',
  '  refusal-patch --job <file> [--now <iso>]',
  'add --json for JSON output',
].join('\n');

const OPTIONS = {
  json: { type: 'boolean' },
  now: { type: 'string' },
  type: { type: 'string' },
  layer: { type: 'string' },
  units: { type: 'string' },
  effort: { type: 'string' },
  classes: { type: 'string' },
  probes: { type: 'string' },
  'open-verified': { type: 'string' },
  project: { type: 'string' },
  'project-file': { type: 'string' },
  system: { type: 'string' },
  job: { type: 'string' },
  executor: { type: 'string' },
  'run-id': { type: 'string' },
  status: { type: 'string' },
  summary: { type: 'string' },
};

function parseArgs(argv) {
  let parsed;
  try {
    parsed = util.parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err.message.split('\n')[0]);
  }
  const [command, ...extra] = parsed.positionals;
  if (extra.length) throw new UsageError(`unexpected argument ${extra[0]}`);
  return { command, opts: parsed.values };
}

const need = (opts, name) => {
  if (opts[name] === undefined || opts[name] === '') throw new UsageError(`--${name} is required`);
  return opts[name];
};

function count(opts, name) {
  if (opts[name] === undefined) return undefined;
  if (!/^\d+$/.test(opts[name])) throw new UsageError(`--${name} must be a whole number`);
  return Number(opts[name]);
}

function nowOf(opts) {
  if (opts.now === undefined) return new Date();
  try {
    return toIsoTime(opts.now);
  } catch {
    throw new UsageError('--now must be a time such as 2026-10-23T12:00:00Z');
  }
}

function readJsonFile(file, what) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`could not read ${what} ${file}: ${err.code || 'not valid JSON'}`);
  }
}

function readProjectFor(opts) {
  if (opts['project-file'] !== undefined) return readJsonFile(opts['project-file'], 'the project file');
  const slug = need(opts, 'project');
  const project = require('./store.cjs').readProject(slug);
  if (!project) throw new Error(`no project ${slug} in the store`);
  return project;
}

function runCommand(command, opts) {
  switch (command) {
    case 'new-id': {
      const id = newJobId(nowOf(opts));
      return { value: { id }, text: id };
    }
    case 'cost': {
      const input = {
        type: need(opts, 'type'),
        layer: opts.layer,
        units: count(opts, 'units'),
        effort: opts.effort,
        classes: count(opts, 'classes'),
        probes: count(opts, 'probes'),
        openVerified: count(opts, 'open-verified'),
      };
      try {
        const c = costEstimate(input);
        return { value: c, text: `${c.agents} agents. ${c.note}` };
      } catch (err) {
        throw new UsageError(err.message);
      }
    }
    case 'route': {
      const systemId = need(opts, 'system');
      const project = readProjectFor(opts);
      const system = (Array.isArray(project.systems) ? project.systems : []).find((s) => s && s.id === systemId);
      if (!system) throw new Error(`the project has no system "${systemId}"`);
      const r = route({ project, system, type: opts.type, layer: opts.layer });
      return { value: r, text: `${r.executorKind}: ${r.reason}` };
    }
    case 'claim-patch': {
      const file = need(opts, 'job');
      const executor = need(opts, 'executor');
      const now = nowOf(opts);
      const job = readJsonFile(file, 'the job');
      return { value: claimPatch(job, executor, now), always: true };
    }
    case 'completion-patch': {
      const file = need(opts, 'job');
      const status = need(opts, 'status');
      if (status !== 'done' && status !== 'failed') throw new UsageError('--status must be done or failed');
      const now = nowOf(opts);
      const job = readJsonFile(file, 'the job');
      const result = { runId: opts['run-id'], status, resultSummary: opts.summary };
      return { value: completionPatch(job, result, now), always: true };
    }
    case 'refusal-patch': {
      const file = need(opts, 'job');
      const now = nowOf(opts);
      const job = readJsonFile(file, 'the job');
      return { value: refusalPatch(job, now), always: true };
    }
    case undefined:
      throw new UsageError('a command is required');
    default:
      throw new UsageError(`unknown command ${command}`);
  }
}

function main(argv) {
  const { command, opts } = parseArgs(argv);
  const out = runCommand(command, opts);
  process.stdout.write(`${opts.json || out.always ? JSON.stringify(out.value) : out.text}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.exitCode = err instanceof UsageError ? 2 : 1;
    process.stderr.write(`jobs: ${redact(err.message)}\n`);
    if (err instanceof UsageError) process.stderr.write(`${USAGE}\n`);
  }
}

module.exports = {
  newJobId,
  costEstimate,
  route,
  claimPatch,
  completionPatch,
  refusalPatch,
  toIsoTime,
  wholeCount,
  isGithubRemote,
  PAGE_FUNCTIONS,
};
