'use strict';
// L1 dependency audit: trivy over one system's repo, or the package manager's own audit when trivy is not installed,
// turned into findings in the store.
//   node scripts/l1-deps.cjs --project <slug> --system <id> [--repo <path>] [--input <report.json> --format trivy|npm] [--json]
// --repo overrides the path recorded for this machine; --input skips the tool and normalizes a report you already have
// (--format says which: trivy, or npm for npm audit and pnpm audit output).
// Exit 0: the run is done. Exit 2: the run was skipped (no lockfile, no usable tool, the tool failed or timed out, or the
// report was unusable) or the arguments were bad. Exit 1: anything unexpected.
//
// The repo root decides the package manager: pnpm-lock.yaml, then yarn.lock, then package-lock.json (the first that exists).
// With trivy installed (RAMPART_TRIVY or PATH) trivy does the scan whatever the manager. Without it npm and pnpm run their
// own `audit --json`; yarn has no native audit here and is skipped.
//
// Exit codes: trivy exits 0 for a finished scan and anything else is a skipped run. npm and pnpm exit 0 for a clean audit
// and 1 when they found vulnerabilities; both are a finished scan when stdout is a v2 audit report. Any other code, a
// timeout, a missing binary, stdout that is not a report, or a report the normalizer rejects (an npm error report, an
// unsupported version) is a skipped run with the reason recorded, never a crash and never a false "clean".
// Nothing from a report except counts and file paths is ever printed, and the stored copy of the report is redacted.

const fs = require('node:fs');
const path = require('node:path');
const { runDir } = require('./lib/paths.cjs');
const { which, run: runTool } = require('./lib/exec.cjs');
const common = require('./lib/l1-common.cjs');
const { fromTrivy, fromNpmAudit } = require('./normalize.cjs');
const store = require('./store.cjs');

const { resolveSystem, resolveRepo, readInput, parseReport, withDetail, markFailed, UsageError, parseArgs, runCli } = common;

const RAW_NAME = 'deps.json';
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const CLEAN_EXIT = 0;
const VULNERABILITIES_EXIT = 1; // `npm audit` and `pnpm audit`; trivy never exits with it on success
const NODE_PREFIX = 'node:'; // exec.run's form for "run this script with the current node"

// In order of precedence: the first one that exists at the repo root decides the manager.
const LOCKFILES = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'package-lock.json', manager: 'npm' },
];
// What --format names. npm covers pnpm's output too, which has the same shape.
const INPUT_FORMATS = {
  trivy: { tool: 'trivy', normalize: fromTrivy },
  npm: { tool: 'npm', normalize: fromNpmAudit },
};
const NATIVE_ENV = { npm: 'RAMPART_NPM', pnpm: 'RAMPART_PNPM' };

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// ---- scan ---------------------------------------------------------------------------------

// Everything that can be wrong with the arguments is checked here, before a run exists, so a typo leaves nothing behind.
function resolveTarget({ project, system, repoPath, input, format }) {
  const resolved = resolveSystem(project, system);
  if (input !== undefined) {
    if (typeof format !== 'string' || !hasOwn(INPUT_FORMATS, format)) {
      throw new RangeError(`--input needs --format ${Object.keys(INPUT_FORMATS).join(' or ')}`);
    }
    return { reportText: readInput(input), format };
  }
  if (format !== undefined) throw new RangeError('--format needs --input');
  return { repo: resolveRepo(resolved, repoPath) };
}

function findLockfile(repo) {
  return LOCKFILES.find(({ file }) => {
    try {
      return fs.statSync(path.join(repo, file)).isFile();
    } catch {
      return false;
    }
  });
}

// How to start the package manager's audit. bin is what `which` found: a binary path, or the "node:<script>" form (the
// override tests use). Returns {cmd} for exec.run, or {skip: reason} when the manager cannot be started from Node.
// Node refuses to start a .cmd or .bat without a shell (EINVAL), and a shell is never used here because the repo path is
// user input. On Windows npm is only ever found as npm.cmd, so npm's own script, which ships next to node.exe, is run under
// node instead. pnpm has no such script to fall back on; pnpm.exe is fine, the pnpm.cmd shim is not.
function auditCommand(manager, bin, { execPath = process.execPath, platform = process.platform } = {}) {
  if (bin.startsWith(NODE_PREFIX)) return { cmd: bin };
  const needsShell = /\.(cmd|bat)$/i.test(bin) || (platform === 'win32' && !/\.(exe|com)$/i.test(bin));
  if (!needsShell) return { cmd: bin };
  if (manager === 'npm') {
    const cli = path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(cli)) return { cmd: `${NODE_PREFIX}${cli}` };
  }
  return { skip: `${manager} not runnable from Node on this platform; install trivy or set ${NATIVE_ENV[manager]}` };
}

// Run one tool and judge its exit code. okCodes are the exit codes that mean "finished". Returns
// {skip, stdout?} when the run is to be skipped (stdout, when there was any, is for the raw copy), or
// {stdout, stderr, code} for a finished one.
function execute(name, cmd, args, { cwd, timeoutMs, okCodes }) {
  let result;
  try {
    result = runTool(cmd, args, { cwd, timeoutMs });
  } catch (err) {
    return { skip: err.code === 'ENOENT' ? `${name} not found` : `${name} could not be started (${err.code || err.name})` };
  }
  const { code, stdout, stderr, timedOut } = result;
  if (timedOut) return { skip: withDetail(`${name} timed out`, stderr), stdout };
  if (!okCodes.includes(code)) {
    return { skip: withDetail(code === null ? `${name} exited without an exit code` : `${name} exited ${code}`, stderr), stdout };
  }
  return { stdout, stderr, code };
}

// Scan the repo with whatever tool there is. Returns what execute returns plus {tool, normalize} for a finished one.
function audit(manager, repo, timeoutMs) {
  const trivy = which('trivy', 'RAMPART_TRIVY');
  if (trivy) {
    const out = execute('trivy', trivy, ['fs', '--scanners', 'vuln', '--format', 'json', '--quiet', repo], { timeoutMs, okCodes: [CLEAN_EXIT] });
    return { ...out, tool: 'trivy', normalize: fromTrivy };
  }
  if (manager === 'yarn') return { skip: 'yarn audit unsupported in v0.1; install trivy' };
  const bin = which(manager, NATIVE_ENV[manager]);
  if (!bin) return { skip: `${manager} not found` };
  const command = auditCommand(manager, bin);
  if (command.skip) return { skip: command.skip };
  const out = execute(manager, command.cmd, ['audit', '--json'], { cwd: repo, timeoutMs, okCodes: [CLEAN_EXIT, VULNERABILITIES_EXIT] });
  return { ...out, tool: manager, normalize: fromNpmAudit };
}

// The report as findings. Messages name what is wrong and never quote the report, which may hold anything.
function toFindings(reportText, label, normalize, ctx) {
  return normalize(parseReport(reportText, label), ctx);
}

// Scan one system and record the outcome as a run. Returns {run, counts, lockfile}: the finished run, the findings upsert
// counts ({added, updated, unchanged, regressed}, all zero for a skipped run) and the lockfile that chose the manager
// (absent for --input, and when there was none). Throws RangeError for a project, system, path or option that does not
// resolve (no run is created). Anything else that goes wrong after the run exists marks it failed and is rethrown.
function scan({ project, system, repoPath, input, format, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const target = resolveTarget({ project, system, repoPath, input, format });
  const run = store.createRun(project, { job: 'audit', layers: ['L1'], systems: [system], executor: 'local' });
  let lockfile;
  const skipped = (reason) => ({ ...common.skipped(run, reason), lockfile });

  try {
    let tool;
    let normalize;
    let reportText;
    let exitCode; // the tool's own, absent for --input
    let stderr = '';
    if (target.reportText !== undefined) {
      ({ tool, normalize } = INPUT_FORMATS[target.format]);
      reportText = target.reportText;
      store.writeRaw(project, run.runId, RAW_NAME, reportText);
    } else {
      const found = findLockfile(target.repo);
      if (!found) return skipped('no lockfile found');
      lockfile = found.file;
      const outcome = audit(found.manager, target.repo, timeoutMs);
      // What the tool printed is kept (redacted by the store) whether or not the run goes on, for diagnosis.
      if (outcome.stdout) store.writeRaw(project, run.runId, RAW_NAME, outcome.stdout);
      if (outcome.skip) return skipped(outcome.skip);
      ({ tool, normalize, stdout: reportText, code: exitCode, stderr } = outcome);
    }

    let findings;
    try {
      findings = toFindings(reportText, tool, normalize, { project, system, runId: run.runId });
    } catch (err) {
      if (err instanceof TypeError) return skipped(withDetail(err.message, stderr));
      throw err;
    }
    // npm and pnpm exit 1 for vulnerabilities, but also when the audit itself fails. Exit 1 with nothing in the report is
    // not evidence of a clean tree.
    if (exitCode === VULNERABILITIES_EXIT && findings.length === 0) {
      return skipped(withDetail(`${tool} exited 1 but reported no vulnerabilities; the audit may have failed`, stderr));
    }
    const counts = store.upsertFindings(project, findings, run.runId);
    return { run: store.finishRun(project, run.runId, { status: 'done', counts, tool: { name: tool } }), counts, lockfile };
  } catch (err) {
    markFailed(run, err);
    throw err;
  }
}

// The public result is {run, counts}.
function scanDeps(options) {
  const { run, counts } = scan(options);
  return { run, counts };
}

// ---- CLI ----------------------------------------------------------------------------------

const USAGE = 'usage: node scripts/l1-deps.cjs --project <slug> --system <id> [--repo <path>] [--input <report.json> --format trivy|npm] [--json]';

// The common flags plus --format, which goes with --input and with nothing else.
function parse(argv) {
  const values = parseArgs(argv, { format: true });
  if ((values.input === undefined) !== (values.format === undefined)) throw new UsageError('--input and --format go together');
  return values;
}

// The lines under the head of a done run.
function details({ run, counts, lockfile }) {
  const { added, updated, unchanged, regressed } = counts;
  return [
    `tool: ${run.tool.name}${lockfile ? `, lockfile: ${lockfile}` : ' (report given with --input)'}`,
    `dependencies: ${added} new, ${updated} updated, ${unchanged} unchanged, ${regressed} regressed`,
    `raw report: ${path.join(runDir(run.project, run.runId), 'raw', RAW_NAME)}`,
  ];
}

if (require.main === module) {
  process.exitCode = runCli({
    name: 'l1-deps',
    usage: USAGE,
    parse,
    details,
    scan: (opts) => scan({ project: opts.project, system: opts.system, repoPath: opts.repo, input: opts.input, format: opts.format }),
  }, process.argv.slice(2));
}

module.exports = { scanDeps, auditCommand };
