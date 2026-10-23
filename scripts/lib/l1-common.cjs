'use strict';
// What the L1 CLIs (l1-secrets, l1-deps, ...) have in common: resolving the system and repo to scan, the reasons recorded for a
// skipped run, closing a run out, reading a report, and the command line (flags, output, exit codes).
//
// A CLI built on this has the same contract as the others: exit 0 when the run is done, 2 when it was skipped or the arguments
// were bad (a UsageError, or a RangeError for a name or path that does not resolve), 1 for anything unexpected. Nothing from a
// report except counts and file paths is ever printed.

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { machineId } = require('./paths.cjs');
const { redact } = require('./redact.cjs');
const store = require('../store.cjs');

const REASON_LINE_MAX = 200;
const BYTE_ORDER_MARK = 0xfeff; // a UTF-8 BOM at the start of a report file does not matter

const emptyCounts = () => ({ added: 0, updated: 0, unchanged: 0, regressed: 0 });

// ---- resolving what to scan ---------------------------------------------------------------

// The project and system a CLI was asked about, and the repo path recorded for this machine (undefined when there is none).
// Throws RangeError when the project or the system does not exist; a slug of the wrong shape is a RangeError from the store.
// Call it before creating a run, so a typo leaves nothing behind.
function resolveSystem(slug, systemId) {
  const project = store.readProject(slug);
  if (!project) throw new RangeError(`project ${slug} not found`);
  const system = project.systems.find((s) => s.id === systemId);
  if (!system) throw new RangeError(`project ${slug} has no system ${systemId}`);
  const repo = system.repo && system.repo.paths && system.repo.paths[machineId()];
  return { project, system, repo };
}

// The directory to scan: the --repo override, else the path recorded for this machine, as an absolute path (so a tool can
// never read it as an option). Throws RangeError when there is no path or it is not a directory.
function resolveRepo({ system, repo }, override) {
  const chosen = override || repo;
  if (!chosen) throw new RangeError(`system ${system.id} has no repo path for this machine (${machineId()}); pass --repo`);
  const resolved = path.resolve(chosen);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new RangeError(`repo path is not a directory: ${resolved}`);
  }
  return resolved;
}

// The text of a report given with --input. Throws RangeError when it cannot be read.
function readInput(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    throw new RangeError('--input file cannot be read');
  }
}

// A report as an object (a leading BOM is skipped). The message names the tool and never quotes the report, because
// JSON.parse's own message includes a snippet of the text, which may hold a credential. Throws TypeError.
function parseReport(text, label) {
  try {
    return JSON.parse(text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text);
  } catch {
    throw new TypeError(`${label} report is not valid JSON`);
  }
}

// ---- reasons and run outcomes -------------------------------------------------------------

// First non-empty line of the tool's stderr, redacted first and cut second so a cut never leaves half a token behind.
function firstLine(text) {
  const line = redact(String(text || '')).split(/\r?\n/).find((l) => l.trim() !== '');
  return line === undefined ? '' : line.trim().slice(0, REASON_LINE_MAX);
}

// reason, with the first line of stderr after it when there is one.
function withDetail(reason, stderr) {
  const line = firstLine(stderr);
  return line ? `${reason}: ${line}` : reason;
}

// Finish a run as skipped, with the reason recorded (redacted). Returns {run, counts}, the counts all zero.
function skipped(run, reason) {
  return {
    run: store.finishRun(run.project, run.runId, { status: 'skipped', reason: redact(reason) }),
    counts: emptyCounts(),
  };
}

// Finish a run as failed after an unexpected error, so none is left "running". The caller rethrows err: if closing the run
// goes wrong too, the original error is the one worth seeing.
function markFailed(run, err) {
  try {
    store.finishRun(run.project, run.runId, { status: 'failed', reason: redact(`${err.name}: ${err.message}`) });
  } catch {
    // see above
  }
}

// ---- the command line ---------------------------------------------------------------------

class UsageError extends Error {}

// The flags the L1 CLIs share: --project and --system (required), --repo, --input, --json. { format: true } adds --format,
// for a CLI that has more than one report format. Anything else, a stray positional or a flag without its value is a UsageError.
// Returns the values; absent flags are undefined.
function parseArgs(argv, { format = false } = {}) {
  const options = {
    project: { type: 'string' }, system: { type: 'string' }, repo: { type: 'string' }, input: { type: 'string' }, json: { type: 'boolean' },
  };
  if (format) options.format = { type: 'string' };
  let values;
  try {
    ({ values } = util.parseArgs({ args: argv, options, strict: true, allowPositionals: false }));
  } catch (err) {
    throw new UsageError(err.message.split('\n')[0]);
  }
  for (const name of ['project', 'system']) {
    if (values[name] === undefined) throw new UsageError(`--${name} is required`);
  }
  return values;
}

function summary(name, result, system, details) {
  const { run } = result;
  const head = `${name} ${run.project}/${system}: ${run.status} (run ${run.runId})`;
  return run.status === 'done' ? [head, ...details(result)].join('\n') : `${head}\nreason: ${run.reason}`;
}

// Run a CLI: parse argv, scan, print, and return the exit code (the caller sets process.exitCode).
//   name     the command, as it prefixes the output and error lines ("l1-secrets")
//   usage    the line printed after a usage error
//   scan     (opts) => {run, counts, ...}, with opts as parse returns them; or a promise of that (l1-headers awaits fetch)
//   details  (result) => the lines printed under the head of a done run
//   parse    (argv) => opts; defaults to parseArgs. It throws UsageError for bad arguments.
// --json prints {run, counts}, whatever else the result carries. An error is written to stderr, redacted, as "<name>: <message>".
// A scan that returns a promise makes runCli return a promise of the exit code, by the same rules (a rejection counts as a
// throw). That promise does not reject. Wait for it before setting process.exitCode.
function runCli({ name, usage, scan, details, parse = parseArgs }, argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const fail = (err) => {
    stderr.write(`${name}: ${redact(err.message)}\n`);
    if (err instanceof UsageError) stderr.write(`${usage}\n`);
    return err instanceof UsageError || err instanceof RangeError ? 2 : 1;
  };
  try {
    const opts = parse(argv);
    const finish = (result) => {
      stdout.write(`${opts.json ? JSON.stringify({ run: result.run, counts: result.counts }, null, 2) : summary(name, result, opts.system, details)}\n`);
      return result.run.status === 'done' ? 0 : 2;
    };
    const result = scan(opts);
    return result && typeof result.then === 'function' ? Promise.resolve(result).then(finish).catch(fail) : finish(result);
  } catch (err) {
    return fail(err);
  }
}

module.exports = {
  emptyCounts, resolveSystem, resolveRepo, readInput, parseReport,
  firstLine, withDetail, skipped, markFailed,
  UsageError, parseArgs, runCli,
};
