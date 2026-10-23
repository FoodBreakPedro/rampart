const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const store = require('../scripts/store.cjs');
const { machineId } = require('../scripts/lib/paths.cjs');
const { scanDeps, auditCommand } = require('../scripts/l1-deps.cjs');

const CLI = path.join(__dirname, '..', 'scripts', 'l1-deps.cjs');
const TRIVY_SHIM = path.join(__dirname, 'fixtures', 'bin', 'fake-trivy.cjs');
const NPM_SHIM = path.join(__dirname, 'fixtures', 'bin', 'fake-npm.cjs');
const SLUG = 'example-app';
const fixturePath = (name) => path.join(__dirname, 'fixtures', name);
const fixture = (name) => JSON.parse(fs.readFileSync(fixturePath(name), 'utf8'));
const TOKEN = 'ghp_depsdepsdepsdepsdepsdeps99999';
const ZERO = { added: 0, updated: 0, unchanged: 0, regressed: 0 };
const DONE_ZERO = { ...ZERO, closed: 0 }; // a done run adds how many findings it closed

// Environment variables a test changes, put back afterwards (undefined means "was not set").
const TOUCHED = [
  'RAMPART_HOME', 'RAMPART_TRIVY', 'RAMPART_NPM', 'RAMPART_PNPM', 'PATH',
  'FAKE_EXIT', 'FAKE_REPORT', 'FAKE_STDOUT', 'FAKE_NO_REPORT', 'FAKE_STDERR', 'FAKE_SLEEP_MS', 'FAKE_ARGV_OUT',
];
const saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));

// Every test gets a fresh store root and a fresh repo directory, both with a space in the name, a project with one
// repo system whose path for this machine is that directory, and the fake trivy, npm and pnpm wired in as the tools.
// The repo starts with no lockfile: each test says which it has.
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
    RAMPART_TRIVY: `node:${TRIVY_SHIM}`,
    RAMPART_NPM: `node:${NPM_SHIM}`,
    RAMPART_PNPM: `node:${NPM_SHIM}`,
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

const lock = (...names) => names.forEach((name) => fs.writeFileSync(path.join(repo, name), '{}\n'));
// Trivy is not installed: no override and nothing on PATH. npm and pnpm still resolve through their overrides.
const noTrivy = () => {
  delete process.env.RAMPART_TRIVY;
  process.env.PATH = '';
};
const noTools = () => {
  for (const k of ['RAMPART_TRIVY', 'RAMPART_NPM', 'RAMPART_PNPM']) delete process.env[k];
  process.env.PATH = '';
};

const runsDir = () => path.join(home, 'projects', SLUG, 'runs');
const rawFile = (run) => path.join(runsDir(), run.runId, 'raw', 'deps.json');
const readRun = (run) => JSON.parse(fs.readFileSync(path.join(runsDir(), run.runId, 'run.json'), 'utf8'));
const calls = () => (fs.existsSync(argvOut) ? fs.readFileSync(argvOut, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
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

// A skipped run: the status, the reason, no counts, run.json on disk equal to the returned run, and nothing ingested
// (the store still holds only the findings it held before, `stored` of them).
function assertSkipped({ run, counts }, reason, stored = 0) {
  assert.equal(run.status, 'skipped');
  if (typeof reason === 'string') assert.equal(run.reason, reason);
  else assert.match(run.reason, reason);
  assert.ok(run.finishedAt);
  assert.deepEqual(counts, ZERO);
  assert.deepEqual(readRun(run), run);
  assert.equal(store.readFindings(SLUG).length, stored, 'nothing from a skipped run is ingested');
}

// ---- the five cases from the brief --------------------------------------------------------

test('(a) trivy: two vulnerable packages become two findings, the run is done and names trivy', () => {
  lock('package-lock.json');
  const { run, counts } = scanDeps({ project: SLUG, system: 'mobile' });

  assert.ok(home.includes(' ') && repo.includes(' '), 'store root and repo path have a space in them');
  assert.equal(run.status, 'done');
  assert.equal(run.reason, undefined);
  assert.equal(run.job, 'audit');
  assert.deepEqual(run.layers, ['L1']);
  assert.deepEqual(run.systems, ['mobile']);
  assert.equal(run.executor, 'local');
  assert.equal(run.tool.name, 'trivy');
  assert.deepEqual(run.tool, { name: 'trivy' }, 'no version is recorded, and a null would not validate');
  assert.ok(run.finishedAt);
  assert.deepEqual(counts, { added: 2, updated: 0, unchanged: 0, regressed: 0, closed: 0 });
  assert.deepEqual(run.counts, { added: 2, updated: 0, unchanged: 0, hardening: 0, regressed: 0, closed: 0 });
  assert.deepEqual(readRun(run), run, 'run.json on disk is the returned run');

  const findings = store.readFindings(SLUG);
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map((f) => f.source), ['trivy', 'trivy']);
  assert.deepEqual(findings.map((f) => f.location.package).sort(), ['lodash', 'minimist']);
  assert.ok(findings.every((f) => f.system === 'mobile' && f.layer === 'L1' && f.status === 'open'));

  assert.deepEqual(JSON.parse(fs.readFileSync(rawFile(run), 'utf8')), fixture('trivy.json'), 'the raw report is kept under raw/');
});

test('(a) the repo path with a space reaches trivy as one argument, in the pinned command', () => {
  lock('package-lock.json');
  scanDeps({ project: SLUG, system: 'mobile' });
  const [call, ...rest] = calls();
  assert.deepEqual(rest, [], 'one trivy invocation and nothing else');
  assert.equal(call.tool, 'trivy');
  assert.deepEqual(call.argv, ['fs', '--scanners', 'vuln', '--format', 'json', '--quiet', repo]);
  assert.ok(call.argv[6].includes(' '));
});

test('(a) --repo overrides the stored path', () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart other repo '));
  try {
    fs.writeFileSync(path.join(other, 'package-lock.json'), '{}\n');
    const { run } = scanDeps({ project: SLUG, system: 'mobile', repoPath: other });
    assert.equal(run.status, 'done', 'the lockfile is looked for in --repo, not in the stored path (which has none)');
    assert.equal(calls().find((c) => c.tool === 'trivy').argv[6], other);
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('(b) no trivy, an npm lockfile, npm exiting 1: two findings and a done run that names npm', () => {
  noTrivy();
  lock('package-lock.json');
  const { run, counts } = scanDeps({ project: SLUG, system: 'mobile' }); // the shim exits 1, as npm audit does with vulnerabilities
  assert.equal(run.status, 'done');
  assert.equal(run.reason, undefined);
  assert.deepEqual(run.tool, { name: 'npm' });
  assert.deepEqual(counts, { added: 2, updated: 0, unchanged: 0, regressed: 0, closed: 0 });
  assert.deepEqual(run.counts, { added: 2, updated: 0, unchanged: 0, hardening: 0, regressed: 0, closed: 0 });
  assert.deepEqual(readRun(run), run);

  const findings = store.readFindings(SLUG);
  assert.deepEqual(findings.map((f) => f.source), ['npm-audit', 'npm-audit']);
  assert.deepEqual(findings.map((f) => f.location.package).sort(), ['lodash', 'qs']);
  assert.deepEqual(JSON.parse(fs.readFileSync(rawFile(run), 'utf8')), fixture('npm-audit.json'));

  const [call, ...rest] = calls();
  assert.deepEqual(rest, [], 'one npm invocation and nothing else');
  assert.deepEqual(call.argv, ['audit', '--json']);
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(repo), 'npm runs in the repo, whose path has a space');
});

test('(c) the empty npm report with exit 0 is a done run with nothing added', () => {
  noTrivy();
  lock('package-lock.json');
  process.env.FAKE_EXIT = '0';
  process.env.FAKE_REPORT = 'npm-audit.empty.json';
  const { run, counts } = scanDeps({ project: SLUG, system: 'mobile' });
  assert.equal(run.status, 'done');
  assert.deepEqual(run.tool, { name: 'npm' });
  assert.deepEqual(counts, DONE_ZERO);
  assert.deepEqual(store.readFindings(SLUG), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(rawFile(run), 'utf8')), fixture('npm-audit.empty.json'));
});

test('(c) the empty trivy report (no Results) with exit 0 is also a done run with nothing added', () => {
  lock('package-lock.json');
  process.env.FAKE_REPORT = 'trivy.empty.json';
  const { run, counts } = scanDeps({ project: SLUG, system: 'mobile' });
  assert.equal(run.status, 'done');
  assert.deepEqual(counts, DONE_ZERO);
  assert.deepEqual(store.readFindings(SLUG), []);
});

test('(d) a yarn lockfile and no trivy is a skipped run: yarn audit is unsupported', () => {
  noTrivy();
  lock('yarn.lock');
  const result = scanDeps({ project: SLUG, system: 'mobile' });
  assertSkipped(result, 'yarn audit unsupported in v0.1; install trivy');
  assert.deepEqual(calls(), [], 'no tool was started');
});

test('(d) a yarn lockfile with trivy installed is scanned by trivy', () => {
  lock('yarn.lock');
  const { run, counts } = scanDeps({ project: SLUG, system: 'mobile' });
  assert.equal(run.status, 'done');
  assert.equal(run.tool.name, 'trivy');
  assert.equal(counts.added, 2);
});

test('(e) --input --format trivy normalizes the given report without invoking any tool, with none installed', () => {
  noTools();
  const { run, counts } = scanDeps({ project: SLUG, system: 'mobile', input: fixturePath('trivy.json'), format: 'trivy' });
  assert.equal(run.status, 'done');
  assert.equal(counts.added, 2);
  assert.deepEqual(run.tool, { name: 'trivy' });
  assert.equal(run.job, 'audit');
  assert.deepEqual(run.layers, ['L1']);
  assert.deepEqual(store.readFindings(SLUG).map((f) => f.source), ['trivy', 'trivy']);
  assert.deepEqual(JSON.parse(fs.readFileSync(rawFile(run), 'utf8')), fixture('trivy.json'));
  assert.deepEqual(calls(), []);
});

test('(e) --input --format npm needs no lockfile and no tool either', () => {
  noTools();
  const { run, counts } = scanDeps({ project: SLUG, system: 'mobile', input: fixturePath('npm-audit.json'), format: 'npm' });
  assert.equal(run.status, 'done');
  assert.equal(counts.added, 2);
  assert.deepEqual(run.tool, { name: 'npm' });
  assert.deepEqual(store.readFindings(SLUG).map((f) => f.source), ['npm-audit', 'npm-audit']);
  assert.deepEqual(calls(), []);
});

// ---- lockfile detection -------------------------------------------------------------------

test('no lockfile at the repo root is a skipped run, even with trivy installed', () => {
  assertSkipped(scanDeps({ project: SLUG, system: 'mobile' }), 'no lockfile found');
  assert.deepEqual(calls(), []);
});

test('a lockfile in a subdirectory is not a lockfile at the root', () => {
  fs.mkdirSync(path.join(repo, 'packages'));
  fs.writeFileSync(path.join(repo, 'packages', 'package-lock.json'), '{}\n');
  assertSkipped(scanDeps({ project: SLUG, system: 'mobile' }), 'no lockfile found');
});

test('with several lockfiles pnpm wins over yarn over npm', () => {
  noTrivy();
  lock('package-lock.json', 'yarn.lock', 'pnpm-lock.yaml');
  const first = scanDeps({ project: SLUG, system: 'mobile' });
  assert.equal(first.run.status, 'done');
  assert.deepEqual(first.run.tool, { name: 'pnpm' });

  fs.rmSync(path.join(repo, 'pnpm-lock.yaml'));
  assertSkipped(scanDeps({ project: SLUG, system: 'mobile' }), 'yarn audit unsupported in v0.1; install trivy', 2);

  fs.rmSync(path.join(repo, 'yarn.lock'));
  assert.deepEqual(scanDeps({ project: SLUG, system: 'mobile' }).run.tool, { name: 'npm' });
});

// ---- trivy: exit codes and failures -------------------------------------------------------

test('trivy: any exit code but 0 is a skipped run naming the code, never a crash or a false clean', () => {
  lock('package-lock.json');
  process.env.FAKE_EXIT = '1';
  const result = scanDeps({ project: SLUG, system: 'mobile' });
  assertSkipped(result, 'trivy exited 1');
  assert.ok(fs.existsSync(rawFile(result.run)), 'what the failed run printed is kept under raw/');

  process.env.FAKE_EXIT = '2';
  assertSkipped(scanDeps({ project: SLUG, system: 'mobile' }), 'trivy exited 2');
});

test('trivy: the first line of stderr is appended to the reason, redacted', () => {
  lock('package-lock.json');
  process.env.FAKE_EXIT = '2';
  process.env.FAKE_STDERR = `FATAL: bad token ${TOKEN} in config\nsecond line stays out`;
  const { run } = scanDeps({ project: SLUG, system: 'mobile' });
  assert.equal(run.status, 'skipped');
  assert.match(run.reason, /^trivy exited 2: FATAL: bad token /);
  assert.ok(!run.reason.includes(TOKEN));
  assert.ok(!run.reason.includes('second line'));
  assert.match(run.reason, /\[REDACTED\]/);
});

test('trivy: exit 0 with output that is not JSON is a skipped run that does not quote the output', () => {
  lock('package-lock.json');
  process.env.FAKE_STDOUT = `Error: {"token": "${TOKEN}", broken`;
  const result = scanDeps({ project: SLUG, system: 'mobile' });
  assertSkipped(result, 'trivy report is not valid JSON');
  assert.ok(!fs.readFileSync(rawFile(result.run), 'utf8').includes(TOKEN), 'the raw copy is redacted');
});

test('trivy: exit 0 with nothing on stdout is a skipped run, not a clean one', () => {
  lock('package-lock.json');
  process.env.FAKE_NO_REPORT = '1';
  assertSkipped(scanDeps({ project: SLUG, system: 'mobile' }), 'trivy report is not valid JSON');
});

test('trivy: exit 0 with a report that is not an object is a skipped run', () => {
  lock('package-lock.json');
  process.env.FAKE_STDOUT = '[]';
  assertSkipped(scanDeps({ project: SLUG, system: 'mobile' }), /report must be an object/);
});

test('trivy: a scan that outlives the timeout is a skipped run, "trivy timed out"', () => {
  lock('package-lock.json');
  process.env.FAKE_SLEEP_MS = '20000';
  const started = Date.now();
  const result = scanDeps({ project: SLUG, system: 'mobile', timeoutMs: 400 });
  assertSkipped(result, /^trivy timed out/);
  assert.ok(Date.now() - started < 10000);
});

test('trivy: a RAMPART_TRIVY that points at a missing binary is a skipped run, "trivy not found"', () => {
  lock('package-lock.json');
  process.env.RAMPART_TRIVY = path.join(home, 'no such trivy');
  assertSkipped(scanDeps({ project: SLUG, system: 'mobile' }), 'trivy not found');
});

test('the raw copy of a report is redacted whatever it holds', () => {
  noTools();
  const report = fixture('trivy.json');
  report.Results[0].Vulnerabilities[0].Title = `leaked ${TOKEN}`;
  const withToken = path.join(home, 'with token.json');
  fs.writeFileSync(withToken, JSON.stringify(report));
  const { run } = scanDeps({ project: SLUG, system: 'mobile', input: withToken, format: 'trivy' });
  assert.equal(run.status, 'done');
  assert.ok(fs.readFileSync(rawFile(run), 'utf8').includes('nodejs-lodash'), 'it is still the report');
  for (const [file, text] of everyStoredText()) assert.ok(!text.includes(TOKEN), `${file} holds a credential value`);
});

// ---- npm and pnpm: exit codes and failures ------------------------------------------------

test('npm: exit 0 with vulnerabilities in the report is still a done run (a configured audit level can do that)', () => {
  noTrivy();
  lock('package-lock.json');
  process.env.FAKE_EXIT = '0';
  const { run, counts } = scanDeps({ project: SLUG, system: 'mobile' });
  assert.equal(run.status, 'done');
  assert.equal(counts.added, 2);
});

test('npm: any exit code but 0 and 1 is a skipped run naming the code, with the first stderr line, redacted', () => {
  noTrivy();
  lock('package-lock.json');
  process.env.FAKE_EXIT = '2';
  process.env.FAKE_STDERR = `npm error code ENOLOCK ${TOKEN}\nsecond line stays out`;
  const { run } = scanDeps({ project: SLUG, system: 'mobile' });
  assert.equal(run.status, 'skipped');
  assert.match(run.reason, /^npm exited 2: npm error code ENOLOCK /);
  assert.ok(!run.reason.includes(TOKEN) && !run.reason.includes('second line'));
  assert.deepEqual(store.readFindings(SLUG), [], 'a report from a failed run is not ingested');
});

test('npm: exit 1 with stdout that is not JSON is a skipped run, not "vulnerabilities found"', () => {
  noTrivy();
  lock('package-lock.json');
  process.env.FAKE_EXIT = '1';
  process.env.FAKE_STDOUT = 'npm ERR! this is not json\n';
  process.env.FAKE_STDERR = 'npm ERR! audit endpoint returned an error';
  const result = scanDeps({ project: SLUG, system: 'mobile' });
  assertSkipped(result, 'npm report is not valid JSON: npm ERR! audit endpoint returned an error');
  assert.ok(fs.existsSync(rawFile(result.run)), 'the output is kept under raw/ for diagnosis');
});

test('npm: exit 1 with nothing on stdout is a skipped run', () => {
  noTrivy();
  lock('package-lock.json');
  process.env.FAKE_NO_REPORT = '1';
  assertSkipped(scanDeps({ project: SLUG, system: 'mobile' }), 'npm report is not valid JSON');
});

test('npm: a malformed v2 report makes the normalizer throw, and that is a skipped run, never a clean one', () => {
  noTrivy();
  lock('package-lock.json');
  for (const [stdout, message] of [
    ['{"auditReportVersion": 2}', /report\.vulnerabilities must be an object/],
    ['{"auditReportVersion": 2, "vulnerabilities": []}', /report\.vulnerabilities must be an object/],
    ['{"auditReportVersion": 1, "vulnerabilities": {}}', /unsupported npm audit report version/],
    ['{"advisories": {}, "metadata": {}}', /unsupported npm audit report version/],
    ['[]', /report must be an object/],
  ]) {
    for (const exit of ['0', '1']) {
      process.env.FAKE_STDOUT = stdout;
      process.env.FAKE_EXIT = exit;
      assertSkipped(scanDeps({ project: SLUG, system: 'mobile' }), message);
    }
  }
});

test('npm: an audit error report (offline, say) is a skipped run, not a clean one', () => {
  noTrivy();
  lock('package-lock.json');
  process.env.FAKE_EXIT = '1';
  process.env.FAKE_STDOUT = JSON.stringify({ error: { code: 'ENOTFOUND', summary: 'request failed', detail: 'getaddrinfo ENOTFOUND registry.npmjs.org' } });
  assertSkipped(scanDeps({ project: SLUG, system: 'mobile' }), /npm audit error report/);
});

test('npm: exit 1 with a valid report that lists no vulnerabilities is a skipped run, not a clean one', () => {
  noTrivy();
  lock('package-lock.json');
  process.env.FAKE_EXIT = '1';
  process.env.FAKE_REPORT = 'npm-audit.empty.json';
  process.env.FAKE_STDERR = 'npm error something went wrong';
  assertSkipped(scanDeps({ project: SLUG, system: 'mobile' }), 'npm exited 1 but reported no vulnerabilities; the audit may have failed: npm error something went wrong');
});

test('npm: an audit that outlives the timeout is a skipped run, "npm timed out"', () => {
  noTrivy();
  lock('package-lock.json');
  process.env.FAKE_SLEEP_MS = '20000';
  assertSkipped(scanDeps({ project: SLUG, system: 'mobile', timeoutMs: 400 }), /^npm timed out/);
});

test('npm: no RAMPART_NPM and nothing on PATH is a skipped run, "npm not found"', () => {
  noTools();
  lock('package-lock.json');
  assertSkipped(scanDeps({ project: SLUG, system: 'mobile' }), 'npm not found');
  assert.deepEqual(calls(), []);
});

test('pnpm: a pnpm lockfile and no trivy runs `pnpm audit --json` in the repo, same exit-code handling', () => {
  noTrivy();
  lock('pnpm-lock.yaml');
  const { run, counts } = scanDeps({ project: SLUG, system: 'mobile' }); // exit 1 with vulnerabilities
  assert.equal(run.status, 'done');
  assert.deepEqual(run.tool, { name: 'pnpm' });
  assert.equal(counts.added, 2);
  const [call] = calls();
  assert.deepEqual(call.argv, ['audit', '--json']);
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(repo));
  assert.deepEqual(JSON.parse(fs.readFileSync(rawFile(run), 'utf8')), fixture('npm-audit.json'));

  process.env.FAKE_EXIT = '0';
  process.env.FAKE_REPORT = 'npm-audit.empty.json';
  assert.equal(scanDeps({ project: SLUG, system: 'mobile' }).run.status, 'done');

  process.env.FAKE_EXIT = '2';
  assertSkipped(scanDeps({ project: SLUG, system: 'mobile' }), 'pnpm exited 2', 2);
});

test('pnpm: it uses RAMPART_PNPM, not RAMPART_NPM, and a missing pnpm is "pnpm not found"', () => {
  noTrivy();
  lock('pnpm-lock.yaml');
  delete process.env.RAMPART_PNPM;
  assertSkipped(scanDeps({ project: SLUG, system: 'mobile' }), 'pnpm not found');
  assert.deepEqual(calls(), [], 'npm is not a stand-in for pnpm');
});

test('pnpm: a malformed report is a skipped run, not a clean one', () => {
  noTrivy();
  lock('pnpm-lock.yaml');
  process.env.FAKE_STDOUT = '{"advisories": {}, "metadata": {}}';
  assertSkipped(scanDeps({ project: SLUG, system: 'mobile' }), /unsupported npm audit report version/);
});

// ---- how npm and pnpm are started ---------------------------------------------------------

test('auditCommand: a node: override is started as it is, on any platform', () => {
  assert.deepEqual(auditCommand('npm', 'node:/x/fake npm.cjs', { platform: 'win32' }), { cmd: 'node:/x/fake npm.cjs' });
  assert.deepEqual(auditCommand('pnpm', 'node:/x/fake pnpm.cjs', { platform: 'win32' }), { cmd: 'node:/x/fake pnpm.cjs' });
});

test('auditCommand: off Windows the binary found is started as it is', () => {
  assert.deepEqual(auditCommand('npm', '/usr/bin/npm', { platform: 'linux' }), { cmd: '/usr/bin/npm' });
  assert.deepEqual(auditCommand('pnpm', '/usr/local/bin/pnpm', { platform: 'darwin' }), { cmd: '/usr/local/bin/pnpm' });
});

test('auditCommand: npm.cmd is never started directly; npm-cli.js next to node runs under node instead', () => {
  const nodeDir = path.join(home, 'node install');
  const cliJs = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  fs.mkdirSync(path.dirname(cliJs), { recursive: true });
  fs.writeFileSync(cliJs, '');
  const execPath = path.join(nodeDir, 'node.exe');
  const want = { cmd: `node:${cliJs}` };
  assert.deepEqual(auditCommand('npm', 'C:\\Program Files\\nodejs\\npm.cmd', { platform: 'win32', execPath }), want);
  assert.deepEqual(auditCommand('npm', 'C:\\Program Files\\nodejs\\NPM.CMD', { platform: 'win32', execPath }), want);
  assert.deepEqual(auditCommand('npm', 'C:\\x\\npm.bat', { platform: 'linux', execPath }), want, 'a .bat or .cmd is never started directly, whatever the platform');
  assert.deepEqual(auditCommand('npm', 'C:\\Program Files\\nodejs\\npm', { platform: 'win32', execPath }), want, 'nor is anything on Windows that is not an .exe');
  assert.deepEqual(auditCommand('npm', 'C:\\tools\\npm.exe', { platform: 'win32', execPath }), { cmd: 'C:\\tools\\npm.exe' });
});

test('auditCommand: with no npm-cli.js beside node, npm is a skip that says what to do', () => {
  const execPath = path.join(home, 'bare node dir', 'node.exe');
  assert.deepEqual(auditCommand('npm', 'C:\\nodejs\\npm.cmd', { platform: 'win32', execPath }), {
    skip: 'npm not runnable from Node on this platform; install trivy or set RAMPART_NPM',
  });
});

test('auditCommand: pnpm.cmd cannot be started and has no script to fall back on: a skip that says what to do', () => {
  const expected = { skip: 'pnpm not runnable from Node on this platform; install trivy or set RAMPART_PNPM' };
  assert.deepEqual(auditCommand('pnpm', 'C:\\Users\\x\\AppData\\Roaming\\npm\\pnpm.CMD', { platform: 'win32' }), expected);
  assert.deepEqual(auditCommand('pnpm', 'C:\\Users\\x\\pnpm.ps1', { platform: 'win32' }), expected);
  assert.deepEqual(auditCommand('pnpm', 'C:\\Users\\x\\pnpm.exe', { platform: 'win32' }), { cmd: 'C:\\Users\\x\\pnpm.exe' });
});

// ---- behaviour around the cases -----------------------------------------------------------

test('a second scan of the same dependencies changes nothing: unchanged 2, same ids and firstSeen, run id recorded', () => {
  lock('package-lock.json');
  const first = scanDeps({ project: SLUG, system: 'mobile' });
  const before = store.readFindings(SLUG);
  const { run, counts } = scanDeps({ project: SLUG, system: 'mobile' });
  assert.equal(run.status, 'done');
  assert.notEqual(run.runId, first.run.runId);
  assert.deepEqual(counts, { added: 0, updated: 0, unchanged: 2, regressed: 0, closed: 0 });
  const after = store.readFindings(SLUG);
  assert.deepEqual(after.map((f) => f.id), before.map((f) => f.id));
  assert.deepEqual(after.map((f) => f.firstSeen), before.map((f) => f.firstSeen));
  assert.ok(after.every((f) => f.verification.run === run.runId));
});

// ---- findings that no longer reproduce ----------------------------------------------------

const statuses = () => Object.fromEntries(store.readFindings(SLUG).map((f) => [f.location.package, f.status]));

test('a finished scan that no longer lists a package closes its finding, with a disposition naming the run', () => {
  lock('package-lock.json');
  assert.equal(scanDeps({ project: SLUG, system: 'mobile' }).counts.added, 2);
  assert.deepEqual(statuses(), { lodash: 'open', minimist: 'open' });

  const onlyLodash = fixture('trivy.json');
  onlyLodash.Results[0].Vulnerabilities = onlyLodash.Results[0].Vulnerabilities.filter((v) => v.PkgName === 'lodash');
  process.env.FAKE_STDOUT = JSON.stringify(onlyLodash);
  const { run, counts } = scanDeps({ project: SLUG, system: 'mobile' });
  assert.equal(run.status, 'done');
  assert.deepEqual(counts, { added: 0, updated: 0, unchanged: 1, regressed: 0, closed: 1 });
  assert.equal(run.counts.closed, 1);
  assert.deepEqual(readRun(run), run);
  assert.deepEqual(statuses(), { lodash: 'open', minimist: 'fixed' });
  const closed = store.readFindings(SLUG).find((f) => f.location.package === 'minimist');
  const { at, ...record } = store.readDispositions(SLUG)[closed.id];
  assert.deepEqual(record, { status: 'fixed', reason: `not reproduced in run ${run.runId}`, by: 'rampart' });
  assert.ok(at);
});

test('an empty report closes everything of that source, and a package that comes back is a regression', () => {
  lock('package-lock.json');
  scanDeps({ project: SLUG, system: 'mobile' });
  process.env.FAKE_REPORT = 'trivy.empty.json';
  const clean = scanDeps({ project: SLUG, system: 'mobile' });
  assert.deepEqual(clean.counts, { added: 0, updated: 0, unchanged: 0, regressed: 0, closed: 2 });
  assert.deepEqual(statuses(), { lodash: 'fixed', minimist: 'fixed' });

  delete process.env.FAKE_REPORT;
  const again = scanDeps({ project: SLUG, system: 'mobile' });
  assert.deepEqual(again.counts, { added: 0, updated: 0, unchanged: 0, regressed: 2, closed: 0 });
  assert.deepEqual(statuses(), { lodash: 'regressed', minimist: 'regressed' });
});

test('findings a person triaged are not closed by a clean scan', () => {
  lock('package-lock.json');
  scanDeps({ project: SLUG, system: 'mobile' });
  const [first, second] = store.readFindings(SLUG);
  store.setDisposition(SLUG, first.id, { status: 'false_positive', reason: 'dev dependency', by: 'pedro' });
  store.setDisposition(SLUG, second.id, { status: 'accepted_risk', reason: 'not reachable', by: 'pedro' });
  process.env.FAKE_REPORT = 'trivy.empty.json';
  assert.equal(scanDeps({ project: SLUG, system: 'mobile' }).counts.closed, 0);
  assert.deepEqual(store.readFindings(SLUG).map((f) => f.status), ['false_positive', 'accepted_risk']);
});

test('a skipped run closes nothing', () => {
  lock('package-lock.json');
  scanDeps({ project: SLUG, system: 'mobile' }); // trivy: two findings
  process.env.FAKE_EXIT = '2';
  assertSkipped(scanDeps({ project: SLUG, system: 'mobile' }), 'trivy exited 2', 2);
  assert.deepEqual(statuses(), { lodash: 'open', minimist: 'open' }, 'a failed scan says nothing about what is gone');
});

// Ruling (final review I2): one dependency scan is the whole answer for a system's dependencies, whichever tool ran.
const bySource = () => store.readFindings(SLUG).map((f) => `${f.source}:${f.location.package}:${f.status}`).sort();

test('I2: an npm audit then a trivy scan closes the npm-audit findings trivy no longer lists, so nothing is counted twice', () => {
  lock('package-lock.json');
  noTrivy();
  const npm = scanDeps({ project: SLUG, system: 'mobile' }); // npm audit: two findings
  assert.equal(npm.run.status, 'done');
  assert.ok(npm.counts.added > 0);
  assert.ok(bySource().every((row) => row.startsWith('npm-audit:') && row.endsWith(':open')));

  process.env.RAMPART_TRIVY = `node:${TRIVY_SHIM}`; // the user installs trivy, as doctor recommends
  delete process.env.FAKE_STDOUT;
  delete process.env.FAKE_REPORT;
  delete process.env.FAKE_EXIT;
  const trivy = scanDeps({ project: SLUG, system: 'mobile' });
  assert.equal(trivy.run.status, 'done');
  assert.equal(trivy.run.tool.name, 'trivy');
  assert.equal(trivy.counts.closed, npm.counts.added, 'every npm-audit finding closes');
  const rows = bySource();
  assert.ok(rows.filter((r) => r.startsWith('npm-audit:')).every((r) => r.endsWith(':fixed')), rows.join(', '));
  assert.deepEqual(rows.filter((r) => r.startsWith('trivy:')), ['trivy:lodash:open', 'trivy:minimist:open']);
  const disp = store.readDispositions(SLUG);
  for (const f of store.readFindings(SLUG).filter((x) => x.source === 'npm-audit')) {
    assert.equal(disp[f.id].reason, `not reproduced in run ${trivy.run.runId}`);
  }
});

test('I2: a clean scan with either tool closes every dependency source of that system, and only of that system', () => {
  lock('package-lock.json');
  scanDeps({ project: SLUG, system: 'mobile' }); // trivy: two findings
  const other = { ...store.readFindings(SLUG)[0], id: 'abcdefabcdef', system: 'db', source: 'pnpm-audit' };
  store.upsertFindings(SLUG, [other], '2026-10-23T00-00-00Z');
  noTrivy();
  process.env.FAKE_REPORT = 'npm-audit.empty.json';
  process.env.FAKE_EXIT = '0';
  const npm = scanDeps({ project: SLUG, system: 'mobile' }); // npm audit: clean
  assert.equal(npm.run.status, 'done');
  assert.equal(npm.counts.closed, 2, 'the trivy findings close');
  const rows = store.readFindings(SLUG).map((f) => `${f.system}:${f.source}:${f.status}`).sort();
  assert.deepEqual(rows, ['db:pnpm-audit:open', 'mobile:trivy:fixed', 'mobile:trivy:fixed']);
});

test('--input: a report that is not JSON, or does not fit the format, is a skipped run whose reason does not quote it', () => {
  noTools();
  const bad = path.join(home, 'bad report.json');
  fs.writeFileSync(bad, `{"token": "${TOKEN}", broken`);
  const broken = scanDeps({ project: SLUG, system: 'mobile', input: bad, format: 'npm' });
  assertSkipped(broken, 'npm report is not valid JSON');
  assert.ok(!fs.readFileSync(rawFile(broken.run), 'utf8').includes(TOKEN));

  const asTrivy = scanDeps({ project: SLUG, system: 'mobile', input: bad, format: 'trivy' });
  assertSkipped(asTrivy, 'trivy report is not valid JSON');
  assert.ok(!fs.readFileSync(rawFile(asTrivy.run), 'utf8').includes(TOKEN));
});

test('--input: a trivy report read as an npm report is a skipped run, not an empty one', () => {
  noTools();
  assertSkipped(scanDeps({ project: SLUG, system: 'mobile', input: fixturePath('trivy.json'), format: 'npm' }), /report\.vulnerabilities must be an object/);
});

test('--input: a UTF-8 BOM at the start of the report does not matter', () => {
  noTools();
  const withBom = path.join(home, 'bom.json');
  fs.writeFileSync(withBom, `\uFEFF${fs.readFileSync(fixturePath('trivy.json'), 'utf8')}`);
  const { run, counts } = scanDeps({ project: SLUG, system: 'mobile', input: withBom, format: 'trivy' });
  assert.equal(run.status, 'done');
  assert.equal(counts.added, 2);
});

test('a project, system, path, input or format that does not resolve is a RangeError and leaves no run behind', () => {
  lock('package-lock.json');
  const input = fixturePath('trivy.json');
  assert.throws(() => scanDeps({ project: 'no-such-app', system: 'mobile' }), RangeError);
  assert.throws(() => scanDeps({ project: 'Bad Slug!', system: 'mobile' }), RangeError);
  assert.throws(() => scanDeps({ project: SLUG, system: 'nope' }), RangeError);
  assert.throws(() => scanDeps({ project: SLUG, system: 'db' }), /no repo path for this machine/, 'db has no repo');
  assert.throws(() => scanDeps({ project: SLUG, system: 'mobile', repoPath: path.join(home, 'missing') }), RangeError);
  assert.throws(() => scanDeps({ project: SLUG, system: 'mobile', input: path.join(home, 'missing.json'), format: 'trivy' }), RangeError);
  assert.throws(() => scanDeps({ project: SLUG, system: 'mobile', input }), /--input needs --format/);
  assert.throws(() => scanDeps({ project: SLUG, system: 'mobile', input, format: 'yarn' }), /--input needs --format/);
  assert.throws(() => scanDeps({ project: SLUG, system: 'mobile', input, format: '__proto__' }), RangeError);
  assert.throws(() => scanDeps({ project: SLUG, system: 'mobile', format: 'trivy' }), /--format needs --input/);
  assert.ok(!fs.existsSync(runsDir()) || fs.readdirSync(runsDir()).length === 0);
  assert.deepEqual(calls(), []);
});

// ---- the CLI ------------------------------------------------------------------------------

test('cli: a finished scan exits 0 and prints the tool, the lockfile, counts and a path, and nothing on stderr', () => {
  lock('package-lock.json', 'yarn.lock', 'pnpm-lock.yaml');
  const r = cli(['--project', SLUG, '--system', 'mobile']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /example-app\/mobile: done/);
  assert.match(r.stdout, /trivy/);
  assert.match(r.stdout, /pnpm-lock\.yaml/, 'the lockfile that was chosen is reported');
  assert.match(r.stdout, /2 new/);
  assert.match(r.stdout, /0 closed/);
  assert.match(r.stdout, /raw[\\/]deps\.json/);
  assert.equal(r.stderr, '');
  assert.equal(store.readFindings(SLUG).length, 2);
});

test('cli: the summary names npm and the lockfile it audited', () => {
  lock('package-lock.json');
  const r = cli(['--project', SLUG, '--system', 'mobile'], { RAMPART_TRIVY: null, PATH: '' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /npm/);
  assert.match(r.stdout, /package-lock\.json/);
});

test('cli: --json prints {run, counts} and nothing else', () => {
  lock('package-lock.json');
  const r = cli(['--project', SLUG, '--system', 'mobile', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out).sort(), ['counts', 'run']);
  assert.equal(out.run.status, 'done');
  assert.equal(out.run.tool.name, 'trivy');
  assert.equal(out.counts.added, 2);
});

test('cli: --repo with a space in the path reaches trivy as one argument, end to end', () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart cli repo '));
  try {
    assert.ok(other.includes(' '));
    fs.writeFileSync(path.join(other, 'package-lock.json'), '{}\n');
    const r = cli(['--project', SLUG, '--system', 'mobile', '--repo', other, '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).counts.added, 2);
    const [call] = calls();
    assert.equal(call.argv[call.argv.indexOf('--quiet') + 1], other);
    assert.equal(call.argv.length, 7, 'no argument was split');
    assert.notEqual(other, repo);
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('cli: --input with --format and --json works and calls no tool', () => {
  const r = cli(['--project', SLUG, '--system', 'mobile', '--input', fixturePath('trivy.json'), '--format', 'trivy', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).counts.added, 2);
  const npm = cli(['--project', SLUG, '--system', 'mobile', '--input', fixturePath('npm-audit.json'), '--format', 'npm', '--json']);
  assert.equal(npm.code, 0, npm.stderr);
  assert.equal(JSON.parse(npm.stdout).run.tool.name, 'npm');
  assert.deepEqual(calls(), []);
});

test('cli: a skipped run exits 2 and says why', () => {
  const noLock = cli(['--project', SLUG, '--system', 'mobile']);
  assert.equal(noLock.code, 2);
  assert.match(noLock.stdout, /skipped/);
  assert.match(noLock.stdout, /no lockfile found/);

  lock('yarn.lock');
  const yarn = cli(['--project', SLUG, '--system', 'mobile', '--json'], { RAMPART_TRIVY: null, PATH: '' });
  assert.equal(yarn.code, 2);
  const out = JSON.parse(yarn.stdout);
  assert.equal(out.run.status, 'skipped');
  assert.match(out.run.reason, /yarn audit unsupported/);

  const failed = cli(['--project', SLUG, '--system', 'mobile', '--json'], { FAKE_EXIT: '3' });
  assert.equal(failed.code, 2);
  assert.match(JSON.parse(failed.stdout).run.reason, /trivy exited 3/);
});

test('cli: usage errors and unresolved names exit 2 with a message on stderr', () => {
  const input = fixturePath('trivy.json');
  for (const args of [
    [],
    ['--project', SLUG],
    ['--system', 'mobile'],
    ['--project', SLUG, '--system', 'mobile', '--bogus'],
    ['--project', SLUG, '--system', 'mobile', 'extra'],
    ['--project', SLUG, '--system', 'nope'],
    ['--project', 'no-such-app', '--system', 'mobile'],
    ['--project', SLUG, '--system', 'mobile', '--input', input],
    ['--project', SLUG, '--system', 'mobile', '--format', 'trivy'],
    ['--project', SLUG, '--system', 'mobile', '--input', input, '--format', 'yarn'],
    ['--project', SLUG, '--system', 'mobile', '--input', path.join(home, 'missing.json'), '--format', 'trivy'],
  ]) {
    const r = cli(args);
    assert.equal(r.code, 2, `args ${JSON.stringify(args)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^l1-deps: /);
    assert.equal(r.stdout, '');
  }
  assert.deepEqual(calls(), []);
  assert.ok(!fs.existsSync(runsDir()) || fs.readdirSync(runsDir()).length === 0);
});
