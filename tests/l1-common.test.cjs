const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../scripts/store.cjs');
const { machineId } = require('../scripts/lib/paths.cjs');
const {
  parseArgs, firstLine, withDetail, runCli, UsageError,
  resolveSystem, resolveRepo, readInput, parseReport, skipped, markFailed,
} = require('../scripts/lib/l1-common.cjs');

const TOKEN = 'ghp_commoncommoncommoncommon99999';
const BASE = ['--project', 'example-app', '--system', 'mobile'];

// ---- parseArgs ----------------------------------------------------------------------------

test('parseArgs: a value with spaces stays one token, and every common flag is read', () => {
  const values = parseArgs([
    '--project', 'example-app', '--system', 'mobile', '--repo', 'C:\\My Projects\\some repo', '--input', 'a report.json', '--json',
  ]);
  assert.equal(values.project, 'example-app');
  assert.equal(values.system, 'mobile');
  assert.equal(values.repo, 'C:\\My Projects\\some repo');
  assert.equal(values.input, 'a report.json');
  assert.equal(values.json, true);
  assert.equal(values.format, undefined);
});

test('parseArgs: --format is a flag only for the CLI that asks for it', () => {
  assert.equal(parseArgs([...BASE, '--format', 'trivy'], { format: true }).format, 'trivy');
  assert.throws(() => parseArgs([...BASE, '--format', 'trivy']), UsageError);
});

test('parseArgs: an unknown flag, a stray positional or a missing value is a usage error naming the problem', () => {
  assert.throws(() => parseArgs([...BASE, '--bogus']), (err) => err instanceof UsageError && /bogus/.test(err.message) && !err.message.includes('\n'));
  assert.throws(() => parseArgs([...BASE, 'extra']), UsageError);
  assert.throws(() => parseArgs([...BASE, '--repo']), UsageError);
});

test('parseArgs: --project and --system are required', () => {
  assert.throws(() => parseArgs([]), (err) => err instanceof UsageError && /--project is required/.test(err.message));
  assert.throws(() => parseArgs(['--system', 'mobile']), /--project is required/);
  assert.throws(() => parseArgs(['--project', 'example-app']), (err) => err instanceof UsageError && /--system is required/.test(err.message));
});

// ---- firstLine / withDetail ---------------------------------------------------------------

test('firstLine: takes the first non-empty line and cuts at the newline', () => {
  assert.equal(firstLine('first line\nsecond line'), 'first line');
  assert.equal(firstLine('\r\n  \n   padded line  \r\nnext'), 'padded line');
  assert.equal(firstLine(''), '');
  assert.equal(firstLine(undefined), '');
  assert.equal(firstLine(null), '');
  assert.equal(firstLine('\n\n  \n'), '');
});

test('firstLine: redacts credentials', () => {
  const line = firstLine(`fatal: bad token ${TOKEN} in config\nsecond line`);
  assert.match(line, /^fatal: bad token \[REDACTED\] in config$/);
  assert.ok(!line.includes(TOKEN));
});

test('firstLine: cuts to 200 characters after redacting, so a cut never leaves part of a credential', () => {
  const cut = firstLine(`${'a'.repeat(195)}${TOKEN}`);
  assert.equal(cut.length, 200);
  assert.ok(!cut.includes('ghp_') && !cut.includes('common'));
  assert.equal(firstLine('b'.repeat(500)).length, 200);
});

test('withDetail: appends the first stderr line to the reason, or leaves the reason alone', () => {
  assert.equal(withDetail('trivy exited 2', 'boom\nmore'), 'trivy exited 2: boom');
  assert.equal(withDetail('trivy exited 2', ''), 'trivy exited 2');
  assert.equal(withDetail('trivy exited 2'), 'trivy exited 2');
});

// ---- runCli: how a result becomes output and an exit code ----------------------------------

const sink = () => {
  let text = '';
  return { write: (chunk) => { text += chunk; }, get text() { return text; } };
};
const doneRun = { project: 'example-app', runId: 'r1', status: 'done' };
const counts = { added: 1, updated: 0, unchanged: 2, regressed: 0 };
const spec = (scan, extra = {}) => ({
  name: 'l1-fake', usage: 'usage: l1-fake ...', scan, details: (result) => [`found: ${result.counts.added}`], ...extra,
});
function cli(specOverride, argv = BASE) {
  const stdout = sink();
  const stderr = sink();
  const code = runCli(specOverride, argv, { stdout, stderr });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

test('runCli: a done run exits 0 and prints the head and the details; stderr stays empty', () => {
  const r = cli(spec(() => ({ run: doneRun, counts })));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'l1-fake example-app/mobile: done (run r1)\nfound: 1\n');
  assert.equal(r.stderr, '');
});

test('runCli: a skipped run exits 2 and prints the reason', () => {
  const r = cli(spec(() => ({ run: { ...doneRun, status: 'skipped', reason: 'tool not found' }, counts })));
  assert.equal(r.code, 2);
  assert.equal(r.stdout, 'l1-fake example-app/mobile: skipped (run r1)\nreason: tool not found\n');
  assert.equal(r.stderr, '');
});

test('runCli: --json prints {run, counts} and nothing else, whatever else the result carries', () => {
  const r = cli(spec(() => ({ run: doneRun, counts, lockfile: 'package-lock.json' })), [...BASE, '--json']);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), { run: doneRun, counts });
  assert.deepEqual(Object.keys(JSON.parse(r.stdout)), ['run', 'counts']);
});

test('runCli: the scan gets the parsed options', () => {
  let seen;
  cli(spec((opts) => { seen = opts; return { run: doneRun, counts }; }), [...BASE, '--repo', 'a b', '--json']);
  assert.deepEqual({ ...seen }, { project: 'example-app', system: 'mobile', repo: 'a b', json: true });
});

test('runCli: a usage error exits 2 with the message and the usage line on stderr, nothing on stdout, and the scan never runs', () => {
  let ran = false;
  const r = cli(spec(() => { ran = true; }), ['--project', 'example-app']);
  assert.equal(r.code, 2);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'l1-fake: --system is required\nusage: l1-fake ...\n');
  assert.equal(ran, false);
});

test('runCli: a RangeError exits 2 with the message only; any other error exits 1; messages are redacted', () => {
  const range = cli(spec(() => { throw new RangeError(`project ${TOKEN} not found`); }));
  assert.equal(range.code, 2);
  assert.equal(range.stdout, '');
  assert.equal(range.stderr, 'l1-fake: project [REDACTED] not found\n');

  const other = cli(spec(() => { throw new Error('disk on fire'); }));
  assert.equal(other.code, 1);
  assert.equal(other.stdout, '');
  assert.equal(other.stderr, 'l1-fake: disk on fire\n');

  const type = cli(spec(() => { throw new TypeError('a bug'); }));
  assert.equal(type.code, 1, 'a TypeError is unexpected, not a usage problem');
});

test('runCli: a CLI can bring its own parser', () => {
  const r = cli(spec(() => ({ run: doneRun, counts }), { parse: () => { throw new UsageError('--input and --format go together'); } }));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^l1-fake: --input and --format go together\nusage: /);
});

// A scan that returns a promise (l1-headers awaits fetch): runCli hands back a promise of the same exit code, with the same
// output and exit-code rules; a scan that returns a plain result still gets a plain exit code.
async function cliAsync(specOverride, argv = BASE) {
  const stdout = sink();
  const stderr = sink();
  const pending = runCli(specOverride, argv, { stdout, stderr });
  assert.ok(pending instanceof Promise, 'a promise-returning scan makes runCli return a promise');
  assert.equal(stdout.text + stderr.text, '', 'nothing is printed before the scan settles');
  const code = await pending;
  return { code, stdout: stdout.text, stderr: stderr.text };
}

test('runCli: a sync scan still returns the exit code itself, not a promise', () => {
  const stdout = sink();
  const code = runCli(spec(() => ({ run: doneRun, counts })), BASE, { stdout, stderr: sink() });
  assert.equal(code, 0);
  assert.equal(typeof code, 'number');
});

test('runCli: an async scan resolves to the exit code, 0 for done and 2 for skipped, with the same output', async () => {
  const done = await cliAsync(spec(async () => ({ run: doneRun, counts })));
  assert.equal(done.code, 0);
  assert.equal(done.stdout, 'l1-fake example-app/mobile: done (run r1)\nfound: 1\n');
  assert.equal(done.stderr, '');

  const skip = await cliAsync(spec(async () => ({ run: { ...doneRun, status: 'skipped', reason: 'timed out' }, counts })));
  assert.equal(skip.code, 2);
  assert.equal(skip.stdout, 'l1-fake example-app/mobile: skipped (run r1)\nreason: timed out\n');

  const json = await cliAsync(spec(async () => ({ run: doneRun, counts, grade: 'A' })), [...BASE, '--json']);
  assert.deepEqual(JSON.parse(json.stdout), { run: doneRun, counts });
});

test('runCli: an async scan that rejects is mapped like a sync throw: RangeError 2, anything else 1, redacted', async () => {
  const range = await cliAsync(spec(async () => { throw new RangeError(`url ${TOKEN} not found`); }));
  assert.equal(range.code, 2);
  assert.equal(range.stdout, '');
  assert.equal(range.stderr, 'l1-fake: url [REDACTED] not found\n');

  const other = await cliAsync(spec(() => Promise.reject(new Error('disk on fire'))));
  assert.equal(other.code, 1);
  assert.equal(other.stderr, 'l1-fake: disk on fire\n');
});

test('runCli: details that throw after an async scan are an unexpected error (1), not an unhandled rejection', async () => {
  const r = await cliAsync(spec(async () => ({ run: doneRun, counts }), { details: () => { throw new Error('bad details'); } }));
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'l1-fake: bad details\n');
});

// ---- reading what to scan -----------------------------------------------------------------

test('parseReport: JSON with or without a BOM; a bad report is a TypeError that does not quote it', () => {
  assert.deepEqual(parseReport('{"a": 1}', 'trivy'), { a: 1 });
  assert.deepEqual(parseReport(`${String.fromCharCode(0xfeff)}[1]`, 'trivy'), [1]);
  assert.throws(() => parseReport(`{"token": "${TOKEN}", broken`, 'gitleaks'), (err) => (
    err instanceof TypeError && err.message === 'gitleaks report is not valid JSON' && !err.message.includes(TOKEN)
  ));
  assert.throws(() => parseReport('', 'npm'), /^TypeError: npm report is not valid JSON$/);
});

// A fresh store root, a repo directory and a project, all with a space in the name.
let home;
let repo;
const saved = process.env.RAMPART_HOME;
test.beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart common '));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart common repo '));
  process.env.RAMPART_HOME = home;
  const { created, updated, ...project } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'project.valid.json'), 'utf8'));
  project.systems[0].repo.paths = { [machineId()]: repo };
  store.writeProject(project);
});
test.afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  if (saved === undefined) delete process.env.RAMPART_HOME;
  else process.env.RAMPART_HOME = saved;
});

test('readInput: the text of the file; a file that cannot be read is a RangeError', () => {
  const file = path.join(home, 'a report.json');
  fs.writeFileSync(file, '{"x": 1}');
  assert.equal(readInput(file), '{"x": 1}');
  assert.throws(() => readInput(path.join(home, 'missing.json')), (err) => err instanceof RangeError && err.message === '--input file cannot be read');
});

test('resolveSystem: the project, the system and the repo path recorded for this machine', () => {
  const found = resolveSystem('example-app', 'mobile');
  assert.equal(found.project.slug, 'example-app');
  assert.equal(found.system.id, 'mobile');
  assert.equal(found.repo, repo);
  assert.equal(resolveSystem('example-app', 'db').repo, undefined, 'a system without a repo has no path');
});

test('resolveSystem: an unknown project, a malformed slug or an unknown system is a RangeError', () => {
  assert.throws(() => resolveSystem('no-such-app', 'mobile'), (err) => err instanceof RangeError && err.message === 'project no-such-app not found');
  assert.throws(() => resolveSystem('Bad Slug!', 'mobile'), RangeError);
  assert.throws(() => resolveSystem('example-app', 'nope'), (err) => err instanceof RangeError && err.message === 'project example-app has no system nope');
});

test('resolveRepo: the --repo override wins over the recorded path, and the result is absolute', () => {
  const resolved = resolveSystem('example-app', 'mobile');
  assert.equal(resolveRepo(resolved), repo);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart common other '));
  try {
    assert.equal(resolveRepo(resolved, other), other);
    const relative = path.relative(process.cwd(), other);
    assert.ok(!path.isAbsolute(relative));
    assert.equal(resolveRepo(resolved, relative), other, 'a relative --repo becomes an absolute path');
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('resolveRepo: no path, a missing path or a file is a RangeError', () => {
  assert.throws(() => resolveRepo(resolveSystem('example-app', 'db')), (err) => (
    err instanceof RangeError && err.message === `system db has no repo path for this machine (${machineId()}); pass --repo`
  ));
  const missing = path.join(home, 'missing');
  assert.throws(() => resolveRepo(resolveSystem('example-app', 'mobile'), missing), (err) => (
    err instanceof RangeError && err.message === `repo path is not a directory: ${missing}`
  ));
  const file = path.join(home, 'a file');
  fs.writeFileSync(file, '');
  assert.throws(() => resolveRepo(resolveSystem('example-app', 'mobile'), file), RangeError);
});

// ---- closing a run out --------------------------------------------------------------------

const newRun = () => store.createRun('example-app', { job: 'audit', layers: ['L1'], systems: ['mobile'], executor: 'local' });
const readRun = (run) => JSON.parse(fs.readFileSync(path.join(home, 'projects', 'example-app', 'runs', run.runId, 'run.json'), 'utf8'));

test('skipped: the run is finished as skipped with the reason redacted; the counts are zero', () => {
  const run = newRun();
  const result = skipped(run, `tool said ${TOKEN}`);
  assert.deepEqual(Object.keys(result), ['run', 'counts']);
  assert.equal(result.run.status, 'skipped');
  assert.equal(result.run.reason, 'tool said [REDACTED]');
  assert.ok(result.run.finishedAt);
  assert.deepEqual(result.counts, { added: 0, updated: 0, unchanged: 0, regressed: 0 });
  assert.deepEqual(readRun(run), result.run, 'run.json on disk is the returned run');
});

test('markFailed: the run is finished as failed with the error named and redacted; it does not throw', () => {
  const run = newRun();
  markFailed(run, new TypeError(`bad ${TOKEN}`));
  const after = readRun(run);
  assert.equal(after.status, 'failed');
  assert.equal(after.reason, 'TypeError: bad [REDACTED]');
  assert.ok(after.finishedAt);
  assert.doesNotThrow(() => markFailed({ project: 'example-app', runId: '2000-01-01T00-00-00Z' }, new Error('no such run')), 'the original error is the one worth seeing');
});
