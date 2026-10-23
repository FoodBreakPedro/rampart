const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { rampartHome, machineId, projectDir, runDir, newRunId } = require('../scripts/lib/paths.cjs');
const { normalizeLocation, findingId } = require('../scripts/lib/id.cjs');

const saved = process.env.RAMPART_HOME;
test.afterEach(() => {
  if (saved === undefined) delete process.env.RAMPART_HOME;
  else process.env.RAMPART_HOME = saved;
});

test('rampartHome honours RAMPART_HOME', () => {
  process.env.RAMPART_HOME = 'X';
  assert.equal(rampartHome(), 'X');
});

test('rampartHome defaults to ~/.rampart when RAMPART_HOME is unset', () => {
  delete process.env.RAMPART_HOME;
  assert.equal(rampartHome(), path.join(os.homedir(), '.rampart'));
});

test('machineId is the first 12 hex of sha256(hostname)', () => {
  assert.match(machineId(), /^[0-9a-f]{12}$/);
  assert.equal(machineId(), crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 12));
});

test('projectDir and runDir nest under the store root', () => {
  process.env.RAMPART_HOME = path.join('store', 'root');
  assert.equal(projectDir('my-app'), path.join('store', 'root', 'projects', 'my-app'));
  assert.equal(
    runDir('my-app', '2026-10-23T18-02-11Z'),
    path.join('store', 'root', 'projects', 'my-app', 'runs', '2026-10-23T18-02-11Z'),
  );
});

test('newRunId format', () => assert.match(newRunId(new Date('2026-10-23T18:02:11Z')), /^2026-10-23T18-02-11Z$/));

test('newRunId defaults to now and keeps the same shape', () => {
  assert.match(newRunId(), /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
});

test('normalizeLocation code uses posix path and symbol, ignores line', () =>
  assert.equal(normalizeLocation({ path: 'src\\auth\\login.ts', symbol: 'handler', line: 42 }), 'src/auth/login.ts:handler'));

test('normalizeLocation code without a symbol keeps the trailing colon', () =>
  assert.equal(normalizeLocation({ path: 'a.ts' }), 'a.ts:'));

test('normalizeLocation host', () => assert.equal(normalizeLocation({ host: '192.0.2.10', service: 'auth', setting: 'X' }), '192.0.2.10|auth|X'));

test('normalizeLocation host without service or setting', () =>
  assert.equal(normalizeLocation({ host: '192.0.2.10' }), '192.0.2.10||'));

test('normalizeLocation url', () => {
  assert.equal(normalizeLocation({ url: 'https://example.com/', header: 'content-security-policy' }), 'https://example.com/|content-security-policy');
  assert.equal(normalizeLocation({ url: 'https://example.com/' }), 'https://example.com/|');
});

test('normalizeLocation package', () => {
  assert.equal(normalizeLocation({ package: 'left-pad', ecosystem: 'npm' }), 'npm:left-pad');
  assert.equal(normalizeLocation({ package: 'left-pad' }), ':left-pad');
});

test('normalizeLocation package ignores a manifest path: the package decides the shape', () => {
  assert.equal(normalizeLocation({ package: 'lodash', ecosystem: 'npm', path: 'package-lock.json' }), 'npm:lodash');
  assert.equal(normalizeLocation({ package: 'lodash', path: 'package-lock.json' }), ':lodash');
  // The same package in two lockfiles normalizes to the same string; a ruleId that names the lockfile tells them apart.
  assert.equal(
    normalizeLocation({ package: 'lodash', ecosystem: 'npm', path: 'web/package-lock.json' }),
    normalizeLocation({ package: 'lodash', ecosystem: 'npm', path: 'package-lock.json' }),
  );
  // A code location is still a code location.
  assert.equal(normalizeLocation({ path: 'package-lock.json', symbol: 'lodash' }), 'package-lock.json:lodash');
});

test('findingId is 12 hex and stable across line changes', () => {
  const a = findingId({ project: 'p', system: 's', ruleId: 'r', location: { path: 'a.ts', symbol: 'f', line: 1 } });
  const b = findingId({ project: 'p', system: 's', ruleId: 'r', location: { path: 'a.ts', symbol: 'f', line: 99 } });
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(a, b);
});

test('findingId hashes project|system|ruleId|normalizedLocation with sha256', () => {
  const expected = crypto.createHash('sha256').update('p|s|r|a.ts:f').digest('hex').slice(0, 12);
  assert.equal(findingId({ project: 'p', system: 's', ruleId: 'r', location: { path: 'a.ts', symbol: 'f' } }), expected);
});

test('findingId is stable across path separator style and the commit field', () => {
  const a = findingId({ project: 'p', system: 's', ruleId: 'r', location: { path: 'src\\a.ts', symbol: 'f' } });
  const b = findingId({ project: 'p', system: 's', ruleId: 'r', location: { path: 'src/a.ts', symbol: 'f', commit: 'abc123' } });
  assert.equal(a, b);
});

test('findingId changes when project, system, rule or location changes', () => {
  const base = { project: 'p', system: 's', ruleId: 'r', location: { path: 'a.ts', symbol: 'f' } };
  const id = findingId(base);
  assert.notEqual(findingId({ ...base, project: 'q' }), id);
  assert.notEqual(findingId({ ...base, system: 't' }), id);
  assert.notEqual(findingId({ ...base, ruleId: 'x' }), id);
  assert.notEqual(findingId({ ...base, location: { path: 'a.ts', symbol: 'g' } }), id);
});
