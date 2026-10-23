'use strict';
// L1 secrets scan: gitleaks over the full git history of one system's repo, turned into findings in the store.
//   node scripts/l1-secrets.cjs --project <slug> --system <id> [--repo <path>] [--input <gitleaks.json>] [--json]
// --repo overrides the path recorded for this machine; --input skips the tool and normalizes a report you already have.
// Exit 0: the run is done. Exit 2: the run was skipped (gitleaks missing, failed or timed out, or the report was
// unusable) or the arguments were bad. Exit 1: anything unexpected.
//
// gitleaks exits 0 when the history is clean and 1 when it found leaks; both are a finished scan. Any other exit code,
// a timeout, or a missing binary is a skipped run with the reason recorded, never a crash and never a false "clean".
// Nothing from a report except counts and file paths is ever printed, and the stored copy of the report is redacted.

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { machineId, runDir } = require('./lib/paths.cjs');
const { redact } = require('./lib/redact.cjs');
const { which, run: runTool } = require('./lib/exec.cjs');
const { fromGitleaks } = require('./normalize.cjs');
const store = require('./store.cjs');

const RAW_NAME = 'gitleaks.json';
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const VERSION_TIMEOUT_MS = 10 * 1000;
const REASON_LINE_MAX = 200;
const CLEAN_EXIT = 0;
const LEAKS_EXIT = 1;

const emptyCounts = () => ({ added: 0, updated: 0, unchanged: 0, regressed: 0 });

// ---- scan ---------------------------------------------------------------------------------

// Everything that can be wrong with the arguments is checked here, before a run exists, so a typo leaves nothing behind.
function resolveTarget({ project, system, repoPath, input }) {
  const proj = store.readProject(project); // a slug of the wrong shape is a RangeError from the store
  if (!proj) throw new RangeError(`project ${project} not found`);
  const sys = proj.systems.find((s) => s.id === system);
  if (!sys) throw new RangeError(`project ${project} has no system ${system}`);

  if (input !== undefined) {
    let reportText;
    try {
      reportText = fs.readFileSync(input, 'utf8');
    } catch {
      throw new RangeError('--input file cannot be read');
    }
    return { reportText };
  }
  const stored = sys.repo && sys.repo.paths && sys.repo.paths[machineId()];
  const repo = repoPath || stored;
  if (!repo) throw new RangeError(`system ${system} has no repo path for this machine (${machineId()}); pass --repo`);
  const resolved = path.resolve(repo);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new RangeError(`repo path is not a directory: ${resolved}`);
  }
  return { repo: resolved };
}

// First non-empty line of the tool's stderr, redacted first and cut second so a cut never leaves half a token behind.
function firstLine(text) {
  const line = redact(String(text || '')).split(/\r?\n/).find((l) => l.trim() !== '');
  return line === undefined ? '' : line.trim().slice(0, REASON_LINE_MAX);
}

const withDetail = (reason, stderr) => {
  const line = firstLine(stderr);
  return line ? `${reason}: ${line}` : reason;
};

// "gitleaks version" prints the bare version. Optional: any trouble just means the run records no version.
function toolVersion(bin) {
  try {
    const r = runTool(bin, ['version'], { timeoutMs: VERSION_TIMEOUT_MS });
    const found = r.code === 0 ? /\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(r.stdout) : null;
    return found ? found[1] : undefined;
  } catch {
    return undefined;
  }
}

// Run gitleaks over repo, writing its report to reportFile. Returns {skip: reason} or {version}.
function detect(bin, repo, reportFile, timeoutMs, scrub) {
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  const args = [
    'detect', '--source', repo, '--report-format', 'json', '--report-path', reportFile,
    '--no-banner', '--redact', '--exit-code', String(LEAKS_EXIT),
  ];
  let result;
  try {
    result = runTool(bin, args, { timeoutMs });
  } catch (err) {
    return { skip: err.code === 'ENOENT' ? 'gitleaks not found' : `gitleaks could not be started (${err.code || err.name})` };
  }
  const reportText = scrub(); // whatever gitleaks left behind is redacted in place, whatever the exit code was
  if (result.timedOut) return { skip: withDetail('gitleaks timed out', result.stderr) };
  if (result.code !== CLEAN_EXIT && result.code !== LEAKS_EXIT) {
    const reason = result.code === null ? 'gitleaks exited without an exit code' : `gitleaks exited ${result.code}`;
    return { skip: withDetail(reason, result.stderr) };
  }
  if (reportText === null) return { skip: withDetail(`gitleaks wrote no report (exit ${result.code})`, result.stderr) };
  return { reportText, version: toolVersion(bin) };
}

// The report as findings. Messages name what is wrong and never quote the report, which may hold a credential.
function toFindings(reportText, ctx) {
  let report;
  try {
    report = JSON.parse(reportText.replace(/^﻿/, ''));
  } catch {
    throw new TypeError('gitleaks report is not valid JSON');
  }
  return fromGitleaks(report, ctx);
}

// Scan one system and record the outcome as a run. Returns {run, counts}: the finished run and the findings
// upsert counts ({added, updated, unchanged, regressed}, all zero for a skipped run).
// Throws RangeError for a project, system or path that does not resolve (no run is created). Anything else that goes
// wrong after the run exists marks it failed and is rethrown.
function scanSecrets({ project, system, repoPath, input, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const target = resolveTarget({ project, system, repoPath, input });
  const run = store.createRun(project, { job: 'audit', layers: ['L1'], systems: [system], executor: 'local' });
  const reportFile = path.join(runDir(project, run.runId), 'raw', RAW_NAME);
  const skipped = (reason) => ({ run: store.finishRun(project, run.runId, { status: 'skipped', reason: redact(reason) }), counts: emptyCounts() });
  // Re-write the report at reportFile through the store, which redacts it. Returns the original text, or null if absent.
  const scrub = () => {
    let text;
    try {
      text = fs.readFileSync(reportFile, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    store.writeRaw(project, run.runId, RAW_NAME, text);
    return text;
  };

  try {
    let reportText;
    let version;
    if (target.reportText !== undefined) {
      reportText = target.reportText;
      store.writeRaw(project, run.runId, RAW_NAME, reportText);
    } else {
      const bin = which('gitleaks', 'RAMPART_GITLEAKS');
      if (!bin) return skipped('gitleaks not found');
      const outcome = detect(bin, target.repo, reportFile, timeoutMs, scrub);
      if (outcome.skip) return skipped(outcome.skip);
      ({ reportText, version } = outcome);
    }

    let findings;
    try {
      findings = toFindings(reportText, { project, system, runId: run.runId });
    } catch (err) {
      if (err instanceof TypeError) return skipped(err.message);
      throw err;
    }
    const counts = store.upsertFindings(project, findings, run.runId);
    const tool = version ? { name: 'gitleaks', version } : { name: 'gitleaks' };
    return { run: store.finishRun(project, run.runId, { status: 'done', counts, tool }), counts };
  } catch (err) {
    try {
      store.finishRun(project, run.runId, { status: 'failed', reason: redact(`${err.name}: ${err.message}`) });
    } catch {
      // the original error is the one worth seeing
    }
    throw err;
  }
}

// ---- CLI ----------------------------------------------------------------------------------

class UsageError extends Error {}

const USAGE = 'usage: node scripts/l1-secrets.cjs --project <slug> --system <id> [--repo <path>] [--input <gitleaks.json>] [--json]';

function parseCli(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        project: { type: 'string' }, system: { type: 'string' }, repo: { type: 'string' }, input: { type: 'string' }, json: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new UsageError(err.message.split('\n')[0]);
  }
  for (const name of ['project', 'system']) {
    if (values[name] === undefined) throw new UsageError(`--${name} is required`);
  }
  return values;
}

function summary({ run, counts }, system) {
  const head = `l1-secrets ${run.project}/${system}: ${run.status} (run ${run.runId})`;
  if (run.status !== 'done') return `${head}\nreason: ${run.reason}`;
  const { added, updated, unchanged, regressed } = counts;
  return [
    head,
    `secrets: ${added} new, ${updated} updated, ${unchanged} unchanged, ${regressed} regressed`,
    `raw report: ${path.join(runDir(run.project, run.runId), 'raw', RAW_NAME)}`,
  ].join('\n');
}

function main(argv) {
  const opts = parseCli(argv);
  const result = scanSecrets({ project: opts.project, system: opts.system, repoPath: opts.repo, input: opts.input });
  process.stdout.write(`${opts.json ? JSON.stringify(result, null, 2) : summary(result, opts.system)}\n`);
  return result.run.status === 'done' ? 0 : 2;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.exitCode = err instanceof UsageError || err instanceof RangeError ? 2 : 1;
    process.stderr.write(`l1-secrets: ${redact(err.message)}\n`);
    if (err instanceof UsageError) process.stderr.write(`${USAGE}\n`);
  }
}

module.exports = { scanSecrets };
