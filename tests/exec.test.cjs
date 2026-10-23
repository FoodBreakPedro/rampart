const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { which, run } = require('../scripts/lib/exec.cjs');

const SHIM = path.join(__dirname, 'fixtures', 'bin', 'fake-gitleaks.cjs');
const IS_WIN = process.platform === 'win32';

// Environment variables a test changes, put back afterwards (undefined means "was not set").
const TOUCHED = ['PATH', 'RAMPART_FAKE_TOOL', 'FAKE_EXIT', 'FAKE_STDERR', 'FAKE_ARGV_OUT', 'FAKE_REPORT', 'FAKE_NO_REPORT', 'FAKE_SLEEP_MS'];
const saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
let tmp;
test.beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart exec '));
  for (const k of TOUCHED.slice(1)) delete process.env[k];
});
test.afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// A tiny "tool" the PATH search can find: toolx.exe on Windows (PATHEXT), an executable toolx elsewhere.
function plantTool(dir, name = 'toolx', mode = 0o755) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, IS_WIN ? `${name}.exe` : name);
  fs.writeFileSync(file, 'not a real binary');
  if (!IS_WIN) fs.chmodSync(file, mode);
  return file;
}
const sameFile = (a, b) => (IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b);

// ---- which --------------------------------------------------------------------------------

test('which returns the environment override verbatim, without checking that it exists', () => {
  process.env.RAMPART_FAKE_TOOL = `node:${path.join(tmp, 'does not exist.cjs')}`;
  assert.equal(which('toolx', 'RAMPART_FAKE_TOOL'), process.env.RAMPART_FAKE_TOOL);
  process.env.PATH = '';
  assert.equal(which('toolx', 'RAMPART_FAKE_TOOL'), process.env.RAMPART_FAKE_TOOL);
});

test('which ignores an unset or empty override and falls back to PATH', () => {
  const file = plantTool(path.join(tmp, 'bin dir'));
  process.env.PATH = path.join(tmp, 'bin dir');
  process.env.RAMPART_FAKE_TOOL = '';
  assert.ok(sameFile(which('toolx', 'RAMPART_FAKE_TOOL'), file));
  delete process.env.RAMPART_FAKE_TOOL;
  assert.ok(sameFile(which('toolx', 'RAMPART_FAKE_TOOL'), file));
  assert.ok(sameFile(which('toolx'), file));
});

test('which takes the first match on PATH and skips empty and quoted entries', () => {
  const first = plantTool(path.join(tmp, 'first'));
  plantTool(path.join(tmp, 'second'));
  process.env.PATH = ['', `"${path.join(tmp, 'missing dir')}"`, `"${path.join(tmp, 'first')}"`, path.join(tmp, 'second')].join(path.delimiter);
  assert.ok(sameFile(which('toolx'), first));
});

test('which returns null when nothing matches, PATH is empty, or the file cannot be executed', () => {
  process.env.PATH = path.join(tmp, 'nowhere');
  assert.equal(which('toolx'), null);
  process.env.PATH = '';
  assert.equal(which('toolx'), null);
  assert.equal(which('toolx', 'RAMPART_FAKE_TOOL'), null);
  if (!IS_WIN) {
    plantTool(path.join(tmp, 'plain'), 'toolx', 0o644);
    process.env.PATH = path.join(tmp, 'plain');
    assert.equal(which('toolx'), null, 'a file without the execute bit is not a tool');
  }
});

test('which honours PATHEXT on Windows', { skip: !IS_WIN }, () => {
  const dir = path.join(tmp, 'ext');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'toolx.cmd'), '@echo off\r\n');
  fs.writeFileSync(path.join(dir, 'tooly.bat'), '@echo off\r\n');
  process.env.PATH = dir;
  assert.ok(sameFile(which('toolx'), path.join(dir, 'toolx.cmd')));
  assert.ok(sameFile(which('tooly'), path.join(dir, 'tooly.bat')));
  assert.ok(sameFile(which('toolx.cmd'), path.join(dir, 'toolx.cmd')));
});

// ---- run ----------------------------------------------------------------------------------

test('run returns code, stdout and stderr and does not throw on a non-zero exit', () => {
  const r = run(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)']);
  assert.deepEqual(r, { code: 3, stdout: 'out', stderr: 'err', timedOut: false });
  assert.deepEqual(run(process.execPath, ['-e', '']), { code: 0, stdout: '', stderr: '', timedOut: false });
});

test('run passes every argument as one argv element, spaces and quotes included', () => {
  const args = ['a b', 'C:\\Program Files\\Some App\\x y', '--flag=v w', 'say "hi"', ''];
  const r = run(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args]);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), args);
});

test('run executes a node: command through the current node binary', () => {
  process.env.FAKE_ARGV_OUT = path.join(tmp, 'argv.jsonl');
  const r = run(`node:${SHIM}`, ['version']);
  assert.deepEqual(r, { code: 0, stdout: '8.99.0-fake\n', stderr: '', timedOut: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(process.env.FAKE_ARGV_OUT, 'utf8')), ['version']);
});

test('run merges env over the current environment and honours cwd', () => {
  const r = run(process.execPath, ['-e', 'process.stdout.write(`${process.env.RAMPART_PROBE}|${process.env.PATH ? "path" : "nopath"}|${process.cwd()}`)'], {
    env: { RAMPART_PROBE: 'yes' },
    cwd: tmp,
  });
  const [probe, hasPath, cwd] = r.stdout.split('|');
  assert.equal(probe, 'yes');
  assert.equal(hasPath, 'path');
  assert.equal(fs.realpathSync(cwd), fs.realpathSync(tmp));
});

test('run reports a timeout instead of throwing', () => {
  const started = Date.now();
  const r = run(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 400 });
  assert.equal(r.timedOut, true);
  assert.equal(r.code, null);
  assert.ok(Date.now() - started < 10000, 'the child was killed, not waited for');
});

test('run throws when the binary cannot be started', () => {
  assert.throws(() => run(path.join(tmp, 'no such binary'), []), (err) => err.code === 'ENOENT');
});

test('run throws EINVAL for a .cmd it refuses to start without a shell', { skip: !IS_WIN }, () => {
  const file = path.join(tmp, 'tool.cmd');
  fs.writeFileSync(file, '@echo off\r\n');
  assert.throws(() => run(file, []), (err) => err.code === 'EINVAL');
});
