const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const store = require('../scripts/store.cjs');
const { diagnose, parseVersion, countPacks } = require('../scripts/doctor.cjs');

const CLI = path.join(__dirname, '..', 'scripts', 'doctor.cjs');
const REPO_ROOT = path.join(__dirname, '..');
const TOOLS = ['gitleaks', 'trivy', 'python3', 'gh', 'ssh', 'git'];
const MISSING = {
  gitleaks: 'gitleaks not found: L1 secrets history scan will be skipped',
  trivy: 'trivy not found: dependency audit falls back to npm/pnpm audit (yarn unsupported)',
  python3: 'python3 not found: the claude-security plugin cannot run',
  gh: 'gh not found: pull-request lookups are unavailable',
  ssh: 'ssh not found: INFRA probes over SSH will be skipped',
  git: 'git not found: repository remotes and change scans are unavailable',
};

// Environment variables a test changes, put back afterwards (undefined means "was not set"). HOME and USERPROFILE are
// both pointed at a temp dir (os.homedir reads one or the other), PATH is emptied, and CLAUDE_CONFIG_DIR is removed, so
// the real ~/.claude and ~/.rampart can never be read, and no tool on this machine can be found by accident.
const TOUCHED = [
  'HOME', 'USERPROFILE', 'PATH', 'CLAUDE_CONFIG_DIR', 'RAMPART_HOME',
  'RAMPART_GITLEAKS', 'RAMPART_TRIVY', 'RAMPART_GIT', 'RAMPART_NPM', 'RAMPART_PNPM',
  'FAKE_ARGV_OUT',
];
const saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));

let tmp; // holds the fake home, the rampart home and the shims
let fakeHome;
let rampartHome;
test.beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart doctor '));
  fakeHome = path.join(tmp, 'home');
  rampartHome = path.join(tmp, 'rampart-home');
  fs.mkdirSync(fakeHome);
  for (const k of TOUCHED) delete process.env[k];
  Object.assign(process.env, { HOME: fakeHome, USERPROFILE: fakeHome, PATH: '', RAMPART_HOME: rampartHome });
});
test.afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// A stand-in for a tool: a script that records its argv (when FAKE_ARGV_OUT is set), prints the given text and exits.
// Returns the "node:<script>" form exec.run takes as a tool override.
function shim(name, { stdout = '', stderr = '', code = 0, sleepMs = 0 } = {}) {
  const file = path.join(tmp, `${name}.cjs`);
  fs.writeFileSync(file, [
    "'use strict';",
    "const fs = require('node:fs');",
    "if (process.env.FAKE_ARGV_OUT) fs.appendFileSync(process.env.FAKE_ARGV_OUT, JSON.stringify(process.argv.slice(2)) + '\\n');",
    `const go = () => { process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = ${code}; };`,
    `if (${sleepMs} > 0) setTimeout(go, ${sleepMs}); else go();`,
  ].join('\n'));
  return `node:${file}`;
}

function writeInstalledPlugins(dir, plugins) {
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }));
}

const entry = [{ scope: 'user', version: '1.0.0' }];

// ---- nothing installed ----------------------------------------------------------------------

test('with an empty PATH every tool is reported missing, one sentence each, and nothing throws', () => {
  const report = diagnose();
  assert.deepEqual(Object.keys(report.tools), TOOLS);
  for (const name of TOOLS) assert.deepEqual(report.tools[name], { found: false, path: null, version: null }, name);
  assert.ok(report.degraded.length >= 6);
  for (const name of TOOLS) assert.ok(report.degraded.includes(MISSING[name]), MISSING[name]);
  assert.equal(report.degraded.length, TOOLS.length);
  assert.equal(report.plugins.claudeSecurity, false);
  assert.deepEqual(report.engines, { l2l3Unattended: 'rampart', l2l3Attended: 'rampart' });
});

test('the report has exactly the documented top-level keys', () => {
  assert.deepEqual(Object.keys(diagnose()).sort(), ['degraded', 'engines', 'node', 'packs', 'plugins', 'store', 'tools']);
});

// ---- node -----------------------------------------------------------------------------------

test('node reports this version and is ok from major 18', () => {
  const { node, degraded } = diagnose();
  assert.equal(node.version, process.versions.node);
  assert.equal(node.ok, Number.parseInt(process.versions.node, 10) >= 18);
  assert.equal(degraded.some((line) => line.startsWith('Node ')), !node.ok);

  assert.deepEqual(diagnose({ nodeVersion: '18.0.0' }).node, { version: '18.0.0', ok: true });
  assert.deepEqual(diagnose({ nodeVersion: '22.4.1' }).node, { version: '22.4.1', ok: true });
});

test('a node below 18 is not ok and is the first degraded line', () => {
  const report = diagnose({ nodeVersion: '16.20.2' });
  assert.deepEqual(report.node, { version: '16.20.2', ok: false });
  assert.equal(report.degraded[0], 'Node 16.20.2 is below 18');
  assert.equal(report.degraded.length, TOOLS.length + 1);
  assert.equal(diagnose({ nodeVersion: '17.9.1' }).node.ok, false);
});

// ---- the claude-security plugin -------------------------------------------------------------

test('claudeSecurity is true when installed_plugins.json has a claude-security@ key, and the attended engine follows', () => {
  writeInstalledPlugins(path.join(fakeHome, '.claude'), { 'other@market': entry, 'claude-security@x': entry });
  const report = diagnose();
  assert.equal(report.plugins.claudeSecurity, true);
  assert.deepEqual(report.engines, { l2l3Unattended: 'rampart', l2l3Attended: 'claude-security' });
});

test('claudeSecurity needs the key to start with "claude-security@" under "plugins"', () => {
  const dir = path.join(fakeHome, '.claude');
  writeInstalledPlugins(dir, { 'other@market': entry, 'claude-security-extra@x': entry, 'my-claude-security@x': entry });
  assert.equal(diagnose().plugins.claudeSecurity, false);

  fs.writeFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ 'claude-security@x': entry }));
  assert.equal(diagnose().plugins.claudeSecurity, false, 'a key outside "plugins" does not count');

  fs.writeFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: ['claude-security@x'] }));
  assert.equal(diagnose().plugins.claudeSecurity, false, 'a list is not a map of plugins');
});

test('claudeSecurity is false, never an error, for a missing, empty, unparseable or odd installed_plugins.json', () => {
  const dir = path.join(fakeHome, '.claude');
  assert.equal(diagnose().plugins.claudeSecurity, false, 'no file');
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  const file = path.join(dir, 'plugins', 'installed_plugins.json');
  for (const text of ['', '{not json', 'null', '[]', '"claude-security@x"', '{"plugins":null}']) {
    fs.writeFileSync(file, text);
    assert.equal(diagnose().plugins.claudeSecurity, false, JSON.stringify(text));
  }
  fs.rmSync(file);
  fs.mkdirSync(file); // a directory where the file should be
  assert.equal(diagnose().plugins.claudeSecurity, false, 'a directory instead of a file');
});

test('a leading BOM in installed_plugins.json is ignored', () => {
  const dir = path.join(fakeHome, '.claude');
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), `﻿${JSON.stringify({ plugins: { 'claude-security@x': entry } })}`);
  assert.equal(diagnose().plugins.claudeSecurity, true);
});

test('CLAUDE_CONFIG_DIR, when set, replaces ~/.claude', () => {
  const elsewhere = path.join(tmp, 'elsewhere');
  writeInstalledPlugins(path.join(fakeHome, '.claude'), { 'claude-security@x': entry });
  process.env.CLAUDE_CONFIG_DIR = elsewhere;
  assert.equal(diagnose().plugins.claudeSecurity, false, '~/.claude is ignored once CLAUDE_CONFIG_DIR is set');
  writeInstalledPlugins(elsewhere, { 'claude-security@x': entry });
  assert.equal(diagnose().plugins.claudeSecurity, true);
});

// ---- tool overrides and versions ------------------------------------------------------------

test('RAMPART_GITLEAKS is honoured: found, its path, and the version it prints', () => {
  const argvOut = path.join(tmp, 'argv.jsonl');
  process.env.FAKE_ARGV_OUT = argvOut;
  process.env.RAMPART_GITLEAKS = shim('gitleaks', { stdout: 'gitleaks version 8.18.4\n' });
  const { tools, degraded } = diagnose();
  assert.deepEqual(tools.gitleaks, { found: true, path: process.env.RAMPART_GITLEAKS, version: '8.18.4' });
  assert.equal(degraded.includes(MISSING.gitleaks), false);
  assert.equal(tools.trivy.found, false, 'a tool without an override is still looked up on PATH');
  const calls = fs.readFileSync(argvOut, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(calls, [['version']], 'gitleaks is asked with the "version" subcommand');
});

test('RAMPART_TRIVY and RAMPART_GIT are honoured and asked with --version', () => {
  const argvOut = path.join(tmp, 'argv.jsonl');
  process.env.FAKE_ARGV_OUT = argvOut;
  process.env.RAMPART_TRIVY = shim('trivy', { stdout: 'Version: 0.48.0\nVulnerability DB:\n  Version: 2\n' });
  process.env.RAMPART_GIT = shim('git', { stdout: 'git version 2.43.0.windows.1\n' });
  const { tools, degraded } = diagnose();
  assert.deepEqual(tools.trivy, { found: true, path: process.env.RAMPART_TRIVY, version: '0.48.0' });
  assert.deepEqual(tools.git, { found: true, path: process.env.RAMPART_GIT, version: '2.43.0' });
  assert.equal(degraded.includes(MISSING.trivy), false);
  assert.equal(degraded.includes(MISSING.git), false);
  const calls = fs.readFileSync(argvOut, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(calls, [['--version'], ['--version']]);
});

test('a version printed on stderr only (ssh -V does this) is found too', () => {
  process.env.RAMPART_GIT = shim('git', { stderr: 'OpenSSH_9.6p1 Ubuntu-3ubuntu13, OpenSSL 3.0.13 30 Jan 2024\n' });
  assert.equal(diagnose().tools.git.version, '9.6');
});

test('a tool that runs but prints no version is found with version null', () => {
  process.env.RAMPART_GITLEAKS = shim('gitleaks', { stdout: 'dev build\n' });
  assert.deepEqual(diagnose().tools.gitleaks, { found: true, path: process.env.RAMPART_GITLEAKS, version: null });
});

test('a tool that exits non-zero gets no version, even if its error text has numbers in it', () => {
  process.env.RAMPART_TRIVY = shim('trivy', { stderr: 'error 404.5: not available\n', code: 3 });
  assert.deepEqual(diagnose().tools.trivy, { found: true, path: process.env.RAMPART_TRIVY, version: null });
});

test('a tool that hangs is cut off at the timeout: found, no version, no throw', () => {
  process.env.RAMPART_GITLEAKS = shim('gitleaks', { stdout: 'gitleaks version 8.18.4\n', sleepMs: 5000 });
  const started = Date.now();
  const { tools } = diagnose({ timeoutMs: 300 });
  assert.deepEqual(tools.gitleaks, { found: true, path: process.env.RAMPART_GITLEAKS, version: null });
  assert.ok(Date.now() - started < 4000, 'did not wait for the tool to finish');
});

test('an override that names a file that is not there is reported missing, as the scanners would find it', () => {
  process.env.RAMPART_GITLEAKS = path.join(tmp, 'no such dir', 'gitleaks');
  const { tools, degraded } = diagnose();
  assert.deepEqual(tools.gitleaks, { found: false, path: null, version: null });
  assert.ok(degraded.includes(MISSING.gitleaks));
});

test('an override that exists but cannot be started is found with no version, not an error', () => {
  const win = process.platform === 'win32';
  const file = path.join(tmp, win ? 'tool.cmd' : 'tool');
  fs.writeFileSync(file, win ? '@echo off\r\necho 1.2.3\r\n' : '#!/bin/sh\necho 1.2.3\n', { mode: 0o644 });
  process.env.RAMPART_TRIVY = file;
  assert.deepEqual(diagnose().tools.trivy, { found: true, path: file, version: null });
});

test('parseVersion takes the first dotted number from the text', () => {
  assert.equal(parseVersion('gitleaks version 8.18.4'), '8.18.4');
  assert.equal(parseVersion('v8.18.4'), '8.18.4');
  assert.equal(parseVersion('git version 2.43.0.windows.1'), '2.43.0');
  assert.equal(parseVersion('Python 3.12.1'), '3.12.1');
  assert.equal(parseVersion('gh version 2.40.1 (2023-12-13)\nhttps://github.com/cli/cli/releases/tag/v2.40.1'), '2.40.1');
  assert.equal(parseVersion('OpenSSH_9.6p1, OpenSSL 3.0.13'), '9.6');
  assert.equal(parseVersion('version 7'), null);
  assert.equal(parseVersion('no digits here'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion(undefined), null);
});

// ---- store and packs ------------------------------------------------------------------------

test('store: a home that does not exist yet has no projects', () => {
  assert.deepEqual(diagnose().store, { home: rampartHome, exists: false, projects: 0 });
});

test('store: counts the projects in the home', () => {
  fs.mkdirSync(rampartHome);
  assert.deepEqual(diagnose().store, { home: rampartHome, exists: true, projects: 0 });
  const { created, updated, ...project } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'project.valid.json'), 'utf8'));
  store.writeProject(project);
  store.writeProject({ ...project, slug: 'second-app', name: 'Second app' });
  assert.deepEqual(diagnose().store, { home: rampartHome, exists: true, projects: 2 });
});

test('store: a home that is a file is not a store and does not throw', () => {
  fs.writeFileSync(rampartHome, 'not a directory');
  assert.deepEqual(diagnose().store, { home: rampartHome, exists: false, projects: 0 });
});

test('store: without RAMPART_HOME it is ~/.rampart under the (fake) home', () => {
  delete process.env.RAMPART_HOME;
  assert.deepEqual(diagnose().store, { home: path.join(fakeHome, '.rampart'), exists: false, projects: 0 });
});

test('packs: the directory is packs/ at the plugin root, and a missing one counts zero', () => {
  const { packs } = diagnose();
  assert.equal(packs.dir, path.join(REPO_ROOT, 'packs'));
  assert.equal(typeof packs.exists, 'boolean');
  assert.equal(Number.isInteger(packs.count) && packs.count >= 0, true);
  assert.equal(packs.exists, fs.existsSync(packs.dir));
  if (!packs.exists) assert.equal(packs.count, 0);
});

test('countPacks counts *.md files, leaving out _template.md, other files and folders', () => {
  const dir = path.join(tmp, 'packs');
  assert.deepEqual(countPacks(dir), { dir, exists: false, count: 0 });
  fs.mkdirSync(dir);
  assert.deepEqual(countPacks(dir), { dir, exists: true, count: 0 });
  for (const name of ['nextjs.md', 'supabase.md', '_template.md', 'README.txt', 'notes.md.bak']) fs.writeFileSync(path.join(dir, name), '# pack\n');
  fs.mkdirSync(path.join(dir, 'folder.md'));
  assert.deepEqual(countPacks(dir), { dir, exists: true, count: 2 });
  const file = path.join(tmp, 'packs-is-a-file');
  fs.writeFileSync(file, 'x');
  assert.deepEqual(countPacks(file), { dir: file, exists: false, count: 0 });
});

// ---- the command line -----------------------------------------------------------------------

// The CLI as a child process with the same isolated environment (PATH empty, fake home), plus any extras.
function cli(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('--json prints one parseable document with the documented keys and exits 0', () => {
  const { code, stdout, stderr } = cli(['--json']);
  assert.equal(code, 0);
  assert.equal(stderr, '');
  const report = JSON.parse(stdout);
  assert.deepEqual(Object.keys(report), ['node', 'tools', 'plugins', 'store', 'packs', 'engines', 'degraded']);
  assert.equal(report.plugins.claudeSecurity, false);
  assert.equal(report.degraded.length >= 6, true);
  assert.equal(report.store.home, rampartHome);
});

test('the CLI reports the same overrides the scanners honour', () => {
  const { code, stdout } = cli(['--json'], { RAMPART_GITLEAKS: shim('gitleaks', { stdout: 'gitleaks version 8.18.4\n' }) });
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).tools.gitleaks.version, '8.18.4');
});

test('the human output is a table, the store, packs and engines lines, and the degraded list; exit 0', () => {
  writeInstalledPlugins(path.join(fakeHome, '.claude'), { 'claude-security@x': entry });
  const { code, stdout, stderr } = cli([], { RAMPART_GITLEAKS: shim('gitleaks', { stdout: 'gitleaks version 8.18.4\n' }) });
  assert.equal(code, 0);
  assert.equal(stderr, '');
  const lines = stdout.split('\n');
  const header = lines.find((l) => /^tool\s+found\s+version\s+path$/.test(l));
  assert.ok(header, `table header in:\n${stdout}`);
  for (const name of TOOLS) assert.ok(lines.some((l) => l.startsWith(`${name} `)), `row for ${name}`);
  assert.match(lines.find((l) => l.startsWith('gitleaks ')), /^gitleaks\s+yes\s+8\.18\.4\s+node:/);
  assert.match(lines.find((l) => l.startsWith('trivy ')), /^trivy\s+no\s+-\s+-$/);
  assert.ok(stdout.includes(`node ${process.versions.node}`));
  assert.match(stdout, /^node .*\bok\b/m);
  assert.match(stdout, /^plugins: claude-security installed$/m);
  assert.ok(stdout.includes(`store: ${rampartHome} (not created yet)`));
  assert.match(stdout, /^packs: /m);
  assert.match(stdout, /^engines: .*unattended.*rampart.*attended.*claude-security/m);
  assert.match(stdout, /^degraded:$/m);
  assert.ok(stdout.includes(`- ${MISSING.trivy}`));
  assert.equal(stdout.includes(MISSING.gitleaks), false);
  assert.ok(stdout.endsWith('\n') && !stdout.endsWith('\n\n'));
});

test('when nothing is degraded the output says so', () => {
  const ok = (name) => shim(name, { stdout: `${name} version 1.2.3\n` });
  // python3, gh and ssh have no override, so a fake PATH directory holds files for them: scripts with the execute bit, or on
  // Windows .cmd files (found through PATHEXT; Node cannot start those without a shell, which is fine: found is the point here).
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['python3', 'gh', 'ssh']) {
    if (process.platform === 'win32') fs.writeFileSync(path.join(bin, `${name}.cmd`), '@echo off\r\necho x 1.2.3\r\n');
    else fs.writeFileSync(path.join(bin, name), '#!/bin/sh\necho "x 1.2.3"\n', { mode: 0o755 });
  }
  const { code, stdout } = cli([], {
    PATH: bin, RAMPART_GITLEAKS: ok('gitleaks'), RAMPART_TRIVY: ok('trivy'), RAMPART_GIT: ok('git'),
  });
  assert.equal(code, 0);
  assert.match(stdout, /^degraded: nothing/m);
  assert.doesNotMatch(stdout, /^- /m, 'no degraded list items');
  for (const name of ['python3', 'gh', 'ssh']) assert.match(stdout, new RegExp(`^${name}\\s+yes\\s`, 'm'));
});

test('an unknown flag or a stray argument is a usage error: exit 2, usage on stderr, nothing on stdout', () => {
  for (const args of [['--bogus'], ['--json', '--bogus'], ['extra'], ['--json=1']]) {
    const { code, stdout, stderr } = cli(args);
    assert.equal(code, 2, args.join(' '));
    assert.equal(stdout, '', args.join(' '));
    assert.match(stderr, /^doctor: /, args.join(' '));
    assert.match(stderr, /usage: node scripts\/doctor\.cjs \[--json\]/, args.join(' '));
  }
});
