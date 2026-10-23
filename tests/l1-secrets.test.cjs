const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const store = require('../scripts/store.cjs');
const { machineId } = require('../scripts/lib/paths.cjs');
const { scanSecrets } = require('../scripts/l1-secrets.cjs');

const CLI = path.join(__dirname, '..', 'scripts', 'l1-secrets.cjs');
const SHIM = path.join(__dirname, 'fixtures', 'bin', 'fake-gitleaks.cjs');
const SLUG = 'example-app';
const fixturePath = (name) => path.join(__dirname, 'fixtures', name);
const fixture = (name) => JSON.parse(fs.readFileSync(fixturePath(name), 'utf8'));
// The credential values in the gitleaks fixture: none of them may reach a file in the store or a line of output.
const SECRETS = fixture('gitleaks.json').map((leak) => leak.Secret);
const TOKEN_IN_STDERR = 'ghp_stderrstderrstderrstderrstderr9999';

// Environment variables a test changes, put back afterwards (undefined means "was not set").
const TOUCHED = [
  'RAMPART_HOME', 'RAMPART_GITLEAKS', 'PATH',
  'FAKE_EXIT', 'FAKE_REPORT', 'FAKE_NO_REPORT', 'FAKE_STDERR', 'FAKE_SLEEP_MS', 'FAKE_ARGV_OUT',
];
const saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));

// Every test gets a fresh store root and a fresh repo directory, both with a space in the name, a project with one
// repo system whose path for this machine is that directory, and the fake gitleaks wired in as the tool.
let home;
let repo;
let argvOut;
test.beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart store '));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart repo '));
  argvOut = path.join(home, 'argv.jsonl');
  for (const k of TOUCHED) delete process.env[k];
  Object.assign(process.env, {
    PATH: saved.PATH,
    RAMPART_HOME: home,
    RAMPART_GITLEAKS: `node:${SHIM}`,
    FAKE_ARGV_OUT: argvOut,
  });
  const { created, updated, ...project } = fixture('project.valid.json');
  project.systems[0].repo.paths = { [machineId()]: repo };
  store.writeProject(project);
});
test.afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const runsDir = () => path.join(home, 'projects', SLUG, 'runs');
const rawFile = (run) => path.join(runsDir(), run.runId, 'raw', 'gitleaks.json');
const readRun = (run) => JSON.parse(fs.readFileSync(path.join(runsDir(), run.runId, 'run.json'), 'utf8'));
const argvCalls = () => (fs.existsSync(argvOut) ? fs.readFileSync(argvOut, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const noSecrets = (text, label) => {
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `${label} holds a credential value`);
};
const everyStoredText = () => {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (full !== argvOut) out.push([full, fs.readFileSync(full, 'utf8')]);
    }
  };
  walk(path.join(home, 'projects'));
  return out;
};

// The CLI in a child process. env entries override the current environment; a null value removes the variable.
function cli(args, env = {}) {
  const childEnv = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    for (const existing of Object.keys(childEnv)) if (existing.toUpperCase() === k.toUpperCase()) delete childEnv[existing];
    if (v !== null) childEnv[k] = v;
  }
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: childEnv, windowsHide: true });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ---- the five cases from the brief --------------------------------------------------------

test('(a) exit 1 means leaks found: the run is done, both leaks are stored, the raw report is redacted', () => {
  process.env.FAKE_EXIT = '1';
  const { run, counts } = scanSecrets({ project: SLUG, system: 'mobile' });

  assert.ok(home.includes(' ') && repo.includes(' '), 'store root and repo path have a space in them');
  assert.equal(run.status, 'done');
  assert.equal(run.reason, undefined);
  assert.equal(run.job, 'audit');
  assert.deepEqual(run.layers, ['L1']);
  assert.deepEqual(run.systems, ['mobile']);
  assert.equal(run.executor, 'local');
  assert.deepEqual(run.tool, { name: 'gitleaks', version: '8.99.0-fake' });
  assert.ok(run.finishedAt);
  assert.deepEqual(counts, { added: 2, updated: 0, unchanged: 0, regressed: 0 });
  assert.deepEqual(run.counts, { added: 2, updated: 0, unchanged: 0, hardening: 0, regressed: 0 });
  assert.deepEqual(readRun(run), run, 'run.json on disk is the returned run');

  const findings = store.readFindings(SLUG);
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map((f) => f.source), ['gitleaks', 'gitleaks']);
  assert.ok(findings.every((f) => f.system === 'mobile' && f.layer === 'L1' && f.status === 'open'));

  assert.ok(fs.existsSync(rawFile(run)), 'the raw report is kept under raw/');
  const raw = fs.readFileSync(rawFile(run), 'utf8');
  assert.ok(raw.includes('aws-access-token'), 'it is still the report, not an empty file');
  noSecrets(raw, 'raw/gitleaks.json');
  for (const [file, text] of everyStoredText()) noSecrets(text, file);
});

test('(a) the repo path with a space reaches gitleaks as one argument, in the pinned command', () => {
  const { run } = scanSecrets({ project: SLUG, system: 'mobile' });
  const detect = argvCalls().find((argv) => argv[0] === 'detect');
  assert.deepEqual(detect, [
    'detect', '--source', repo, '--report-format', 'json', '--report-path', rawFile(run),
    '--no-banner', '--redact', '--exit-code', '1',
  ]);
  assert.ok(detect[2].includes(' '));
});

test('(a) --repo overrides the stored path', () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart other repo '));
  try {
    scanSecrets({ project: SLUG, system: 'mobile', repoPath: other });
    assert.equal(argvCalls().find((argv) => argv[0] === 'detect')[2], other);
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('(b) exit 0 with an empty report is a done run with nothing added', () => {
  process.env.FAKE_EXIT = '0';
  process.env.FAKE_REPORT = 'gitleaks.empty.json';
  const { run, counts } = scanSecrets({ project: SLUG, system: 'mobile' });
  assert.equal(run.status, 'done');
  assert.deepEqual(counts, { added: 0, updated: 0, unchanged: 0, regressed: 0 });
  assert.deepEqual(store.readFindings(SLUG), []);
  assert.equal(fs.readFileSync(rawFile(run), 'utf8').trim(), '[]');
});

test('(c) any other exit code is a skipped run naming the code, never a crash or a false clean', () => {
  process.env.FAKE_EXIT = '3';
  const { run, counts } = scanSecrets({ project: SLUG, system: 'mobile' });
  assert.equal(run.status, 'skipped');
  assert.match(run.reason, /gitleaks exited 3/);
  assert.ok(run.finishedAt);
  assert.deepEqual(counts, { added: 0, updated: 0, unchanged: 0, regressed: 0 });
  assert.deepEqual(readRun(run), run);
  assert.deepEqual(store.readFindings(SLUG), [], 'a report from a failed run is not ingested');
  assert.ok(fs.existsSync(rawFile(run)), 'the report the failed run left is kept under raw/');
  const raw = fs.readFileSync(rawFile(run), 'utf8');
  assert.ok(raw.includes('aws-access-token'), 'it is still the report');
  noSecrets(raw, 'raw/gitleaks.json');
});

test('(c) the first line of stderr is appended to the reason, redacted', () => {
  process.env.FAKE_EXIT = '2';
  process.env.FAKE_STDERR = `fatal: bad token ${TOKEN_IN_STDERR} in config\nsecond line stays out`;
  const { run } = scanSecrets({ project: SLUG, system: 'mobile' });
  assert.equal(run.status, 'skipped');
  assert.match(run.reason, /^gitleaks exited 2: fatal: bad token /);
  assert.ok(!run.reason.includes(TOKEN_IN_STDERR));
  assert.ok(!run.reason.includes('second line'));
  assert.match(run.reason, /\[REDACTED\]/);
});

test('(c) exit 1 with a zero-finding report is a skipped run, not a clean one: gitleaks also exits 1 when the scan fails', () => {
  process.env.FAKE_EXIT = '1';
  process.env.FAKE_REPORT = 'gitleaks.empty.json';
  process.env.FAKE_STDERR = `fatal: detected dubious ownership, token ${TOKEN_IN_STDERR}\nsecond line stays out`;
  const { run, counts } = scanSecrets({ project: SLUG, system: 'mobile' });
  assert.equal(run.status, 'skipped');
  assert.match(run.reason, /^gitleaks exited 1 but reported no findings; the scan may have failed: fatal: detected dubious ownership, token /);
  assert.ok(!run.reason.includes(TOKEN_IN_STDERR));
  assert.ok(!run.reason.includes('second line'));
  assert.deepEqual(counts, { added: 0, updated: 0, unchanged: 0, regressed: 0 });
  assert.deepEqual(readRun(run), run);
  assert.deepEqual(store.readFindings(SLUG), []);

  const viaCli = cli(['--project', SLUG, '--system', 'mobile', '--json']);
  assert.equal(viaCli.code, 2, viaCli.stderr);
  assert.equal(JSON.parse(viaCli.stdout).run.status, 'skipped');
});

test('(c) the same empty report with exit 0 is still a clean, done run', () => {
  process.env.FAKE_EXIT = '0';
  process.env.FAKE_REPORT = 'gitleaks.empty.json';
  assert.equal(scanSecrets({ project: SLUG, system: 'mobile' }).run.status, 'done');
});

test('(d) no RAMPART_GITLEAKS and nothing on PATH is a skipped run, "gitleaks not found"', () => {
  delete process.env.RAMPART_GITLEAKS;
  process.env.PATH = '';
  const { run, counts } = scanSecrets({ project: SLUG, system: 'mobile' });
  assert.equal(run.status, 'skipped');
  assert.equal(run.reason, 'gitleaks not found');
  assert.deepEqual(counts, { added: 0, updated: 0, unchanged: 0, regressed: 0 });
  assert.deepEqual(readRun(run), run);
  assert.deepEqual(argvCalls(), []);
});

test('(d) a RAMPART_GITLEAKS that points at a missing binary is also "gitleaks not found"', () => {
  process.env.RAMPART_GITLEAKS = path.join(home, 'no such gitleaks');
  const { run } = scanSecrets({ project: SLUG, system: 'mobile' });
  assert.equal(run.status, 'skipped');
  assert.equal(run.reason, 'gitleaks not found');
});

test('(e) --input normalizes the given report without invoking any binary', () => {
  const { run, counts } = scanSecrets({ project: SLUG, system: 'mobile', input: fixturePath('gitleaks.json') });
  assert.equal(run.status, 'done');
  assert.equal(counts.added, 2);
  assert.equal(store.readFindings(SLUG).length, 2);
  assert.deepEqual(argvCalls(), [], 'the shim was never started');
  assert.equal(run.tool.name, 'gitleaks');
  assert.equal(run.tool.version, undefined);
  noSecrets(fs.readFileSync(rawFile(run), 'utf8'), 'raw/gitleaks.json');
  for (const [file, text] of everyStoredText()) noSecrets(text, file);
});

test('(e) --input works with no tool installed at all', () => {
  delete process.env.RAMPART_GITLEAKS;
  process.env.PATH = '';
  const { run, counts } = scanSecrets({ project: SLUG, system: 'mobile', input: fixturePath('gitleaks.json') });
  assert.equal(run.status, 'done');
  assert.equal(counts.added, 2);
});

// ---- behaviour around the cases -----------------------------------------------------------

test('a second scan of the same leaks changes nothing: unchanged 2, same findings and firstSeen, run id recorded', () => {
  const first = scanSecrets({ project: SLUG, system: 'mobile' });
  const before = store.readFindings(SLUG);
  const { run, counts } = scanSecrets({ project: SLUG, system: 'mobile' });
  assert.equal(run.status, 'done');
  assert.notEqual(run.runId, first.run.runId);
  assert.deepEqual(counts, { added: 0, updated: 0, unchanged: 2, regressed: 0 });
  assert.deepEqual(run.counts, { added: 0, updated: 0, unchanged: 2, hardening: 0, regressed: 0 });
  const after = store.readFindings(SLUG);
  assert.deepEqual(after.map((f) => f.id), before.map((f) => f.id));
  assert.deepEqual(after.map((f) => f.firstSeen), before.map((f) => f.firstSeen));
  assert.ok(after.every((f) => f.verification.run === run.runId), 'the stored finding names the latest run');
});

test('a later clean scan closes nothing: a leak stays in the history, so its finding stays open', () => {
  scanSecrets({ project: SLUG, system: 'mobile' });
  process.env.FAKE_EXIT = '0';
  process.env.FAKE_REPORT = 'gitleaks.empty.json';
  const { run, counts } = scanSecrets({ project: SLUG, system: 'mobile' });
  assert.equal(run.status, 'done');
  assert.deepEqual(counts, { added: 0, updated: 0, unchanged: 0, regressed: 0 }, 'no closed count');
  assert.deepEqual(store.readFindings(SLUG).map((f) => f.status), ['open', 'open']);
  assert.deepEqual(store.readDispositions(SLUG), {});
});

test('a scan that outlives the timeout is a skipped run, "gitleaks timed out"', () => {
  process.env.FAKE_SLEEP_MS = '20000';
  const started = Date.now();
  const { run, counts } = scanSecrets({ project: SLUG, system: 'mobile', timeoutMs: 400 });
  assert.equal(run.status, 'skipped');
  assert.match(run.reason, /^gitleaks timed out/);
  assert.deepEqual(counts, { added: 0, updated: 0, unchanged: 0, regressed: 0 });
  assert.ok(Date.now() - started < 10000);
});

test('exit 1 with no readable report is a skipped run: a gitleaks crash is not "leaks found"', () => {
  process.env.FAKE_EXIT = '1';
  process.env.FAKE_NO_REPORT = '1';
  process.env.FAKE_STDERR = 'fatal: not a git repository';
  const { run } = scanSecrets({ project: SLUG, system: 'mobile' });
  assert.equal(run.status, 'skipped');
  assert.match(run.reason, /no report/);
  assert.match(run.reason, /not a git repository/);
  assert.deepEqual(store.readFindings(SLUG), []);
});

test('exit 0 with no report is a skipped run, not a clean one', () => {
  process.env.FAKE_EXIT = '0';
  process.env.FAKE_NO_REPORT = '1';
  const { run } = scanSecrets({ project: SLUG, system: 'mobile' });
  assert.equal(run.status, 'skipped');
  assert.match(run.reason, /no report/);
});

test('a report that is not JSON is a skipped run whose reason does not quote the report', () => {
  const bad = path.join(home, 'bad report.json');
  fs.writeFileSync(bad, `{"Secret": "${TOKEN_IN_STDERR}", broken`);
  const { run } = scanSecrets({ project: SLUG, system: 'mobile', input: bad });
  assert.equal(run.status, 'skipped');
  assert.equal(run.reason, 'gitleaks report is not valid JSON');
  assert.ok(!fs.readFileSync(rawFile(run), 'utf8').includes(TOKEN_IN_STDERR), 'the raw copy is redacted');
});

test('a report entry without a RuleID and File is a skipped run', () => {
  const bad = path.join(home, 'bad entry.json');
  fs.writeFileSync(bad, JSON.stringify([{ Description: 'no rule here' }]));
  const { run } = scanSecrets({ project: SLUG, system: 'mobile', input: bad });
  assert.equal(run.status, 'skipped');
  assert.match(run.reason, /entry 0 needs a RuleID and a File/);
  assert.deepEqual(store.readFindings(SLUG), []);
});

test('a UTF-8 BOM at the start of the report does not matter', () => {
  const withBom = path.join(home, 'bom.json');
  fs.writeFileSync(withBom, `\uFEFF${fs.readFileSync(fixturePath('gitleaks.json'), 'utf8')}`);
  const { run, counts } = scanSecrets({ project: SLUG, system: 'mobile', input: withBom });
  assert.equal(run.status, 'done');
  assert.equal(counts.added, 2);
});

// A report written without --redact (gitleaks' default) carries each value in Secret, Match and Line. These two values are
// outside redact()'s prefix and keyword lists, so only dropping those fields keeps them out of the store. They are built here,
// not committed in a fixture, so this repository holds no token-shaped string.
const UNLISTED_TOKEN = `glpat-${'Zq7Xw2Vr9Ks4Lm8Np3Tb'}`;
const UNLISTED_VALUE = `${'Hx81kQzv'}${'Wp0rT3nB'}${'cY6sDm2L'}`;
function unredactedReport(file) {
  fs.writeFileSync(file, JSON.stringify([
    {
      RuleID: 'gitlab-pat', Description: 'GitLab Personal Access Token', File: 'ci/release.sh', Commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      StartLine: 3, Match: `GL=${UNLISTED_TOKEN}`, Secret: UNLISTED_TOKEN, Line: `export GL=${UNLISTED_TOKEN}`,
      Author: 'Someone Real', Email: 'someone.real@example.invalid',
    },
    {
      RuleID: 'generic-api-key', Description: 'Generic API Key', File: 'src/settings.py', Commit: 'b1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      StartLine: 9, Match: `credential = "${UNLISTED_VALUE}"`, Secret: UNLISTED_VALUE, Line: `credential = "${UNLISTED_VALUE}"`,
      Author: 'Someone Real', Email: 'someone.real@example.invalid',
    },
  ], null, 2));
  return file;
}
const noUnlisted = (text, label) => {
  for (const value of [UNLISTED_TOKEN, UNLISTED_VALUE, 'someone.real@example.invalid', 'Someone Real']) {
    assert.ok(!text.includes(value), `${label} holds ${value.slice(0, 6)}...`);
  }
};

test('C1: an --input report without --redact is stored without Secret, Match, Line, Author or Email, whatever the token format', () => {
  const { run, counts } = scanSecrets({ project: SLUG, system: 'mobile', input: unredactedReport(path.join(home, 'unredacted gitleaks.json')) });
  assert.equal(run.status, 'done');
  assert.equal(counts.added, 2);
  const raw = JSON.parse(fs.readFileSync(rawFile(run), 'utf8'));
  assert.deepEqual(raw.map((e) => e.RuleID), ['gitlab-pat', 'generic-api-key'], 'still the report');
  for (const entry of raw) {
    for (const field of ['Secret', 'Match', 'Line', 'Author', 'Email']) assert.ok(!(field in entry), `${field} is dropped`);
  }
  for (const [file, text] of everyStoredText()) noUnlisted(text, file);
});

test('C1: a real run that leaves an unredacted report is stored the same way, and so is one that does not parse', () => {
  process.env.FAKE_REPORT = unredactedReport(path.join(home, 'tool report.json'));
  const done = scanSecrets({ project: SLUG, system: 'mobile' });
  assert.equal(done.run.status, 'done');
  assert.equal(done.counts.added, 2);
  const truncated = path.join(home, 'truncated.json');
  fs.writeFileSync(truncated, fs.readFileSync(process.env.FAKE_REPORT, 'utf8').slice(0, 400));
  assert.ok(fs.readFileSync(truncated, 'utf8').includes(UNLISTED_TOKEN), 'the cut still holds the value');
  process.env.FAKE_REPORT = truncated;
  const broken = scanSecrets({ project: SLUG, system: 'mobile' });
  assert.equal(broken.run.status, 'skipped');
  assert.deepEqual(JSON.parse(fs.readFileSync(rawFile(broken.run), 'utf8')), { stored: false, reason: 'not a gitleaks JSON report' });
  for (const [file, text] of everyStoredText()) noUnlisted(text, file);
});

test('C1: the stored copy keeps only the allowlisted entry fields, so a field gitleaks may add later is never kept', () => {
  const report = path.join(home, 'extra fields.json');
  fs.writeFileSync(report, JSON.stringify([{
    RuleID: 'gitlab-pat', Description: 'GitLab PAT', File: 'ci/release.sh', Commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    StartLine: 3, EndLine: 3, StartColumn: 1, EndColumn: 30, SymlinkFile: '', Entropy: 4.2, Date: '2026-10-01T00:00:00Z',
    Tags: ['key'], Fingerprint: 'a1b2c3d4:ci/release.sh:gitlab-pat:3',
    Message: `rotate ${UNLISTED_TOKEN}`, Context: UNLISTED_TOKEN, Secret: UNLISTED_TOKEN,
  }]));
  const { run } = scanSecrets({ project: SLUG, system: 'mobile', input: report });
  assert.equal(run.status, 'done');
  const [entry] = JSON.parse(fs.readFileSync(rawFile(run), 'utf8'));
  assert.deepEqual(Object.keys(entry).sort(), [
    'Commit', 'Date', 'Description', 'EndColumn', 'EndLine', 'Entropy', 'File', 'Fingerprint', 'RuleID', 'StartColumn',
    'StartLine', 'SymlinkFile', 'Tags',
  ]);
  for (const [file, text] of everyStoredText()) noUnlisted(text, file);
});

// A gitleaks SARIF and CSV export of the same leak: neither is the JSON report, so the run is skipped and raw/ gets a stub.
const sarifReport = () => JSON.stringify({
  version: '2.1.0',
  runs: [{
    tool: { driver: { name: 'gitleaks', rules: [{ id: 'gitlab-pat' }] } },
    results: [{
      ruleId: 'gitlab-pat', message: { text: 'gitlab-pat has detected secret for file ci/release.sh.' },
      locations: [{ physicalLocation: { artifactLocation: { uri: 'ci/release.sh' }, region: { startLine: 3, snippet: { text: UNLISTED_TOKEN } } } }],
      partialFingerprints: { commitSha: 'a1b2c3d4e5f6', author: 'Someone Real', email: 'someone.real@example.invalid' },
    }],
  }],
});
const csvReport = () => [
  'RuleID,Commit,File,SymlinkFile,Secret,Match,StartLine,EndLine,StartColumn,EndColumn,Author,Message,Date,Email,Fingerprint,Tags',
  `gitlab-pat,a1b2c3d4e5f6,ci/release.sh,,${UNLISTED_TOKEN},GL=${UNLISTED_TOKEN},3,3,1,30,Someone Real,ci,2026-10-01T00:00:00Z,someone.real@example.invalid,a1b2c3d4:ci/release.sh:gitlab-pat:3,`,
].join('\n');

for (const [format, body] of [['SARIF', sarifReport], ['CSV', csvReport]]) {
  test(`C1: a gitleaks ${format} export passed with --input is a skipped run, and its token reaches no stored file`, () => {
    const input = path.join(home, `report.${format.toLowerCase()}`);
    fs.writeFileSync(input, body());
    assert.ok(fs.readFileSync(input, 'utf8').includes(UNLISTED_TOKEN));
    const { run } = scanSecrets({ project: SLUG, system: 'mobile', input });
    assert.equal(run.status, 'skipped');
    assert.deepEqual(JSON.parse(fs.readFileSync(rawFile(run), 'utf8')), { stored: false, reason: 'not a gitleaks JSON report' });
    assert.deepEqual(store.readFindings(SLUG), []);
    for (const [file, text] of everyStoredText()) noUnlisted(text, file);
  });
}

test('a project, system or repo path that does not resolve is a RangeError and leaves no run behind', () => {
  assert.throws(() => scanSecrets({ project: 'no-such-app', system: 'mobile' }), RangeError);
  assert.throws(() => scanSecrets({ project: 'Bad Slug!', system: 'mobile' }), RangeError);
  assert.throws(() => scanSecrets({ project: SLUG, system: 'nope' }), RangeError);
  assert.throws(() => scanSecrets({ project: SLUG, system: 'db' }), /no repo path for this machine/, 'db has no repo');
  assert.throws(() => scanSecrets({ project: SLUG, system: 'mobile', repoPath: path.join(home, 'missing') }), RangeError);
  assert.throws(() => scanSecrets({ project: SLUG, system: 'mobile', input: path.join(home, 'missing.json') }), RangeError);
  assert.ok(!fs.existsSync(runsDir()) || fs.readdirSync(runsDir()).length === 0);
  assert.deepEqual(argvCalls(), []);
});

// ---- the CLI ------------------------------------------------------------------------------

test('cli: a finished scan exits 0 and prints counts and a path, never a credential', () => {
  const r = cli(['--project', SLUG, '--system', 'mobile'], { FAKE_EXIT: '1' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /example-app\/mobile: done/);
  assert.match(r.stdout, /2 new/);
  assert.match(r.stdout, /raw[\\/]gitleaks\.json/);
  noSecrets(r.stdout + r.stderr, 'cli output');
  assert.equal(r.stderr, '');
  assert.equal(store.readFindings(SLUG).length, 2);
});

test('cli: --json prints {run, counts} and nothing else', () => {
  const r = cli(['--project', SLUG, '--system', 'mobile', '--json'], { FAKE_EXIT: '1' });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out).sort(), ['counts', 'run']);
  assert.equal(out.run.status, 'done');
  assert.equal(out.counts.added, 2);
  noSecrets(r.stdout, 'cli json');
});

test('cli: --repo with a space in the path reaches gitleaks as one argument, end to end', () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart cli repo '));
  try {
    assert.ok(other.includes(' '));
    const r = cli(['--project', SLUG, '--system', 'mobile', '--repo', other, '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.run.status, 'done');
    assert.equal(out.counts.added, 2);
    const detect = argvCalls().find((argv) => argv[0] === 'detect');
    assert.equal(detect[detect.indexOf('--source') + 1], other);
    assert.equal(detect.length, 11, 'no argument was split');
    assert.notEqual(other, repo);
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('cli: --input and --json work together and call no binary', () => {
  const r = cli(['--project', SLUG, '--system', 'mobile', '--input', fixturePath('gitleaks.json'), '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).counts.added, 2);
  assert.deepEqual(argvCalls(), []);
});

test('cli: a skipped run exits 2 and says why', () => {
  const r = cli(['--project', SLUG, '--system', 'mobile'], { RAMPART_GITLEAKS: null, PATH: '' });
  assert.equal(r.code, 2);
  assert.match(r.stdout, /skipped/);
  assert.match(r.stdout, /gitleaks not found/);

  const failed = cli(['--project', SLUG, '--system', 'mobile', '--json'], { FAKE_EXIT: '3' });
  assert.equal(failed.code, 2);
  const out = JSON.parse(failed.stdout);
  assert.equal(out.run.status, 'skipped');
  assert.match(out.run.reason, /exited 3/);
});

test('cli: usage errors and unresolved names exit 2 with a message on stderr', () => {
  for (const args of [
    [],
    ['--project', SLUG],
    ['--system', 'mobile'],
    ['--project', SLUG, '--system', 'mobile', '--bogus'],
    ['--project', SLUG, '--system', 'mobile', 'extra'],
    ['--project', SLUG, '--system', 'nope'],
    ['--project', 'no-such-app', '--system', 'mobile'],
    ['--project', SLUG, '--system', 'mobile', '--input', path.join(home, 'missing.json')],
  ]) {
    const r = cli(args);
    assert.equal(r.code, 2, `args ${JSON.stringify(args)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^l1-secrets: /);
    assert.equal(r.stdout, '');
  }
  assert.deepEqual(argvCalls(), []);
});
