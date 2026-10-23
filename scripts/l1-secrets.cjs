'use strict';
// L1 secrets scan: gitleaks over the full git history of one system's repo, turned into findings in the store.
//   node scripts/l1-secrets.cjs --project <slug> --system <id> [--repo <path>] [--input <gitleaks.json>] [--json]
// --repo overrides the path recorded for this machine; --input skips the tool and normalizes a report you already have.
// Exit 0: the run is done. Exit 2: the run was skipped (gitleaks missing, failed or timed out, or the report was
// unusable) or the arguments were bad. Exit 1: anything unexpected.
//
// gitleaks exits 0 when the history is clean and 1 when it found leaks; both are a finished scan, except that exit 1 with
// no findings in the report is a skipped run (gitleaks also exits 1 when the scan itself fails). Any other exit code, a
// timeout, or a missing binary is a skipped run with the reason recorded, never a crash and never a false "clean".
// Nothing from a report except counts and file paths is ever printed. The stored copy of the report (from gitleaks or from
// --input) loses the fields that hold the matched value and the author (CREDENTIAL_FIELDS) before it is written, and the
// store redacts what is left: redact() alone knows only some token formats, and a report written without --redact carries
// the value in Match and Line as well as in Secret.

const fs = require('node:fs');
const path = require('node:path');
const { runDir } = require('./lib/paths.cjs');
const { which, run: runTool } = require('./lib/exec.cjs');
const common = require('./lib/l1-common.cjs');
const { fromGitleaks } = require('./normalize.cjs');
const store = require('./store.cjs');

const { resolveSystem, resolveRepo, readInput, parseReport, withDetail, markFailed, runCli } = common;

const RAW_NAME = 'gitleaks.json';
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const VERSION_TIMEOUT_MS = 10 * 1000;
const CLEAN_EXIT = 0;
const LEAKS_EXIT = 1;
// gitleaks report fields that hold the matched value (Secret, Match, Line) or a person (Author, Email). They are dropped from
// the stored copy of every report; nothing reads them (the normalizer uses RuleID, Description, File and Commit).
const CREDENTIAL_FIELDS = ['Secret', 'Match', 'Line', 'Author', 'Email'];
// The same fields as "Key": "value" in a report that does not parse (a truncated file), up to the closing quote or the end.
const CREDENTIAL_FIELD_TEXT = new RegExp(String.raw`"(${CREDENTIAL_FIELDS.join('|')})"\s*:\s*"(?:[^"\\]|\\[\s\S])*(?:"|$)`, 'g');

// ---- the stored copy ----------------------------------------------------------------------

// A copy of value with every CREDENTIAL_FIELDS key removed, at any depth.
function withoutCredentialFields(value) {
  if (Array.isArray(value)) return value.map(withoutCredentialFields);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !CREDENTIAL_FIELDS.includes(key)).map(([key, v]) => [key, withoutCredentialFields(v)])
  );
}

// The report text as it is kept under raw/: parsed and written back without the credential fields, or, for text that is not
// JSON, with those fields' string values cut out. The store then redacts the result as it writes it.
function storedReport(text) {
  let parsed;
  try {
    parsed = parseReport(text, 'gitleaks');
  } catch {
    return text.replace(CREDENTIAL_FIELD_TEXT, '"$1": "[REMOVED]"');
  }
  return `${JSON.stringify(withoutCredentialFields(parsed), null, 2)}\n`;
}

// ---- scan ---------------------------------------------------------------------------------

// Everything that can be wrong with the arguments is checked here, before a run exists, so a typo leaves nothing behind.
function resolveTarget({ project, system, repoPath, input }) {
  const resolved = resolveSystem(project, system);
  if (input !== undefined) return { reportText: readInput(input) };
  return { repo: resolveRepo(resolved, repoPath) };
}

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

// Run gitleaks over repo, writing its report to reportFile. Returns {skip: reason}, or {reportText, version, code, stderr}
// for an exit of 0 or 1 with a report.
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
    scrub(); // normally nothing is there; if something is, it does not stay unredacted
    return { skip: err.code === 'ENOENT' ? 'gitleaks not found' : `gitleaks could not be started (${err.code || err.name})` };
  }
  const reportText = scrub(); // whatever gitleaks left behind is redacted in place, whatever the exit code was
  if (result.timedOut) return { skip: withDetail('gitleaks timed out', result.stderr) };
  if (result.code !== CLEAN_EXIT && result.code !== LEAKS_EXIT) {
    const reason = result.code === null ? 'gitleaks exited without an exit code' : `gitleaks exited ${result.code}`;
    return { skip: withDetail(reason, result.stderr) };
  }
  if (reportText === null) return { skip: withDetail(`gitleaks wrote no report (exit ${result.code})`, result.stderr) };
  return { reportText, version: toolVersion(bin), code: result.code, stderr: result.stderr };
}

// The report as findings. Messages name what is wrong and never quote the report, which may hold a credential.
function toFindings(reportText, ctx) {
  return fromGitleaks(parseReport(reportText, 'gitleaks'), ctx);
}

// Scan one system and record the outcome as a run. Returns {run, counts}: the finished run and the findings
// upsert counts ({added, updated, unchanged, regressed}, all zero for a skipped run).
// Throws RangeError for a project, system or path that does not resolve (no run is created). Anything else that goes
// wrong after the run exists marks it failed and is rethrown.
function scanSecrets({ project, system, repoPath, input, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const target = resolveTarget({ project, system, repoPath, input });
  const run = store.createRun(project, { job: 'audit', layers: ['L1'], systems: [system], executor: 'local' });
  const reportFile = path.join(runDir(project, run.runId), 'raw', RAW_NAME);
  const skipped = (reason) => common.skipped(run, reason);
  // Re-write the report at reportFile through the store, without its credential fields and redacted. Returns the original
  // text, or null if absent.
  const scrub = () => {
    let text;
    try {
      text = fs.readFileSync(reportFile, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    store.writeRaw(project, run.runId, RAW_NAME, storedReport(text));
    return text;
  };

  try {
    let reportText;
    let version;
    let exitCode; // gitleaks' own, absent for --input
    let stderr = '';
    if (target.reportText !== undefined) {
      reportText = target.reportText;
      store.writeRaw(project, run.runId, RAW_NAME, storedReport(reportText));
    } else {
      const bin = which('gitleaks', 'RAMPART_GITLEAKS');
      if (!bin) return skipped('gitleaks not found');
      const outcome = detect(bin, target.repo, reportFile, timeoutMs, scrub);
      if (outcome.skip) return skipped(outcome.skip);
      ({ reportText, version, code: exitCode, stderr } = outcome);
    }

    let findings;
    try {
      findings = toFindings(reportText, { project, system, runId: run.runId });
    } catch (err) {
      if (err instanceof TypeError) return skipped(err.message);
      throw err;
    }
    // gitleaks exits 1 for leaks, but also when the scan itself fails (a source that is not a git repo, dubious ownership),
    // sometimes leaving an empty or partial report. Exit 1 with nothing in the report is not evidence of a clean history.
    if (exitCode === LEAKS_EXIT && findings.length === 0) {
      return skipped(withDetail('gitleaks exited 1 but reported no findings; the scan may have failed', stderr));
    }
    const counts = store.upsertFindings(project, findings, run.runId);
    const tool = version ? { name: 'gitleaks', version } : { name: 'gitleaks' };
    return { run: store.finishRun(project, run.runId, { status: 'done', counts, tool }), counts };
  } catch (err) {
    markFailed(run, err);
    throw err;
  }
}

// ---- CLI ----------------------------------------------------------------------------------

const USAGE = 'usage: node scripts/l1-secrets.cjs --project <slug> --system <id> [--repo <path>] [--input <gitleaks.json>] [--json]';

// The lines under the head of a done run.
function details({ run, counts }) {
  const { added, updated, unchanged, regressed } = counts;
  return [
    `secrets: ${added} new, ${updated} updated, ${unchanged} unchanged, ${regressed} regressed`,
    `raw report: ${path.join(runDir(run.project, run.runId), 'raw', RAW_NAME)}`,
  ];
}

if (require.main === module) {
  process.exitCode = runCli({
    name: 'l1-secrets',
    usage: USAGE,
    details,
    scan: (opts) => scanSecrets({ project: opts.project, system: opts.system, repoPath: opts.repo, input: opts.input }),
  }, process.argv.slice(2));
}

module.exports = { scanSecrets, storedReport };
