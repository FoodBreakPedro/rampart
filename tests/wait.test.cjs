const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'scripts', 'wait.cjs');
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('wait sleeps the given seconds, then exits 0', () => {
  const started = Date.now();
  const r = run('1');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - started >= 900);
  assert.match(r.stdout, /waited 1s/);
});

test('wait refuses anything but a whole number of seconds from 1 to 60 (exit 2)', () => {
  for (const bad of [['0'], ['61'], ['1.5'], ['abc'], ['1', '2'], ['--json']]) {
    const r = run(...bad);
    assert.equal(r.status, 2, bad.join(' '));
    assert.match(r.stderr, /usage/);
  }
});
