const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const store = require('../scripts/store.cjs');
const { readPack } = require('../scripts/packs.cjs');
const cov = require('../scripts/coverage.cjs');

const CLI = path.join(__dirname, '..', 'scripts', 'coverage.cjs');
const TARGET = path.join(__dirname, 'fixtures', 'repos', 'hunt-target');
const SLUG = 'example-app';

let home;
const savedHome = process.env.RAMPART_HOME;
test.beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart cov '));
  process.env.RAMPART_HOME = home;
});
test.afterEach(() => {
  if (savedHome === undefined) delete process.env.RAMPART_HOME;
  else process.env.RAMPART_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const ids = (units) => units.map((u) => u.id);

// ---- unitOf / isIgnored -------------------------------------------------------------------

test('unitOf truncates the directory to maxDepth + 1 segments', () => {
  assert.equal(cov.unitOf('app/api/users/route.ts'), 'app/api/users');
  assert.equal(cov.unitOf('lib/db.ts'), 'lib');
  assert.equal(cov.unitOf('a/b/c/d/e.ts'), 'a/b/c');
  assert.equal(cov.unitOf('a/b/c/d/e.ts', 0), 'a');
  assert.equal(cov.unitOf('a/b/c/d/e.ts', 1), 'a/b');
});

test('unitOf maps a root-level file to "." and accepts backslashes', () => {
  assert.equal(cov.unitOf('middleware.ts'), '.');
  assert.equal(cov.unitOf('app\\api\\users\\route.ts'), 'app/api/users');
  assert.equal(cov.unitOf('./lib/db.ts'), 'lib');
});

test('isIgnored matches plain names on any segment and globs on the basename', () => {
  assert.equal(cov.isIgnored('node_modules/x/index.js'), true);
  assert.equal(cov.isIgnored('app/node_modules/x.js'), true);
  assert.equal(cov.isIgnored('src\\tests\\a.ts'), true);
  assert.equal(cov.isIgnored('package-lock.lock'), true);
  assert.equal(cov.isIgnored('web/dist/app.min.js'), true);
  assert.equal(cov.isIgnored('web/app.min.js'), true);
  assert.equal(cov.isIgnored('app/api/users/route.ts'), false);
  assert.equal(cov.isIgnored('lib/lockfile.ts'), false);
  assert.equal(cov.isIgnored('x.ts', ['x.ts']), true);
});

// ---- unitsForRepo on the fixture ----------------------------------------------------------

test('unitsForRepo lists the fixture directories and leaves ignored ones out', () => {
  const units = cov.unitsForRepo(TARGET);
  assert.deepEqual(ids(units), ['.', 'app/api/export', 'app/api/invoices', 'app/api/users', 'lib']);
  const byId = Object.fromEntries(units.map((u) => [u.id, u]));
  assert.deepEqual(byId['app/api/users'], { id: 'app/api/users', kind: 'dir', files: 1, reachable: true });
  assert.equal(byId['app/api/export'].files, 1);
  assert.equal(byId.lib.files, 2);
  assert.equal(byId['.'].files, 2); // middleware.ts, package.json
  for (const bad of ['node_modules', 'node_modules/x', 'public', 'tests']) assert.ok(!(bad in byId), bad);
});

test('unitsForRepo honours maxDepth and a custom ignore', () => {
  assert.deepEqual(ids(cov.unitsForRepo(TARGET, { maxDepth: 0 })), ['.', 'app', 'lib']);
  const all = cov.unitsForRepo(TARGET, { ignore: [] });
  assert.ok(ids(all).includes('tests'));
  assert.ok(ids(all).includes('public'));
  assert.ok(ids(all).includes('node_modules/x'));
});

test('background roots (docs, scripts) are units with reachable false; ignored roots produce none', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart repo '));
  try {
    for (const f of ['docs/a.md', 'scripts/b.sh', 'src/c.ts', 'tests/d.ts', 'vendor/e.js']) {
      fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
      fs.writeFileSync(path.join(repo, f), 'x');
    }
    const units = cov.unitsForRepo(repo);
    assert.deepEqual(units.map((u) => [u.id, u.reachable]), [['docs', false], ['scripts', false], ['src', true]]);
    const withTests = cov.unitsForRepo(repo, { ignore: [] }).find((u) => u.id === 'tests');
    assert.equal(withTests.reachable, false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---- unitsForHost -------------------------------------------------------------------------

test('unitsForHost gives one probe unit per probe', () => {
  const pack = readPack('docker-host');
  const units = cov.unitsForHost({ id: 'home' }, pack);
  assert.equal(units.length, pack.probes.length);
  assert.ok(units.length > 5);
  assert.deepEqual(units[0], { id: `probe:${pack.probes[0].id}`, kind: 'probe', reachable: true });
  assert.ok(units.every((u) => u.kind === 'probe' && u.id.startsWith('probe:')));
});

// ---- ledger -------------------------------------------------------------------------------

const PACKS = { 'web-nextjs': '1.0.0' };
const base = () => ({ project: SLUG, units: {} });

test('gaps lists every unit of an empty ledger', () => {
  const units = cov.unitsForRepo(TARGET);
  assert.deepEqual(ids(cov.gaps(base(), { system: 'web', layer: 'L2', units, packs: PACKS })), ids(units));
});

test('markCovered is pure, stamps lastRun and pack versions, and closes the gaps', () => {
  const units = cov.unitsForRepo(TARGET);
  const before = base();
  const after = cov.markCovered(before, { system: 'web', layer: 'L2', units, runId: 'R1', packs: PACKS });
  assert.deepEqual(before, base());
  const entry = after.units['web|L2|app/api/users'];
  assert.deepEqual(entry, { system: 'web', layer: 'L2', lastRun: 'R1', packVersions: PACKS, status: 'covered' });
  assert.deepEqual(cov.gaps(after, { system: 'web', layer: 'L2', units, packs: PACKS }), []);
  // another system or layer is untouched
  assert.equal(cov.gaps(after, { system: 'web', layer: 'L3', units, packs: PACKS }).length, units.length);
  assert.equal(cov.gaps(after, { system: 'api', layer: 'L2', units, packs: PACKS }).length, units.length);
});

test('a pack version bump makes every unit a gap; an unrelated pack does not', () => {
  const units = cov.unitsForRepo(TARGET);
  const led = cov.markCovered(base(), { system: 'web', layer: 'L2', units, runId: 'R1', packs: PACKS });
  const bumped = cov.gaps(led, { system: 'web', layer: 'L2', units, packs: { 'web-nextjs': '1.1.0' } });
  assert.deepEqual(ids(bumped), ids(units));
  const added = cov.gaps(led, { system: 'web', layer: 'L2', units, packs: { ...PACKS, 'node-api': '1.0.0' } });
  assert.equal(added.length, units.length);
  assert.deepEqual(cov.gaps(led, { system: 'web', layer: 'L2', units, packs: {} }), []);
});

test('status failed is a gap; skipped is not; a later covered mark clears the failure', () => {
  const units = cov.unitsForRepo(TARGET);
  const one = units.filter((u) => u.id === 'lib');
  let led = cov.markCovered(base(), { system: 'web', layer: 'L2', units, runId: 'R1', packs: PACKS });
  led = cov.markCovered(led, { system: 'web', layer: 'L2', units: one, runId: 'R2', packs: PACKS, status: 'failed' });
  assert.equal(led.units['web|L2|lib'].lastRun, 'R2');
  assert.deepEqual(ids(cov.gaps(led, { system: 'web', layer: 'L2', units, packs: PACKS })), ['lib']);
  led = cov.markCovered(led, { system: 'web', layer: 'L2', units: one, runId: 'R3', packs: PACKS, status: 'skipped' });
  assert.deepEqual(cov.gaps(led, { system: 'web', layer: 'L2', units, packs: PACKS }), []);
  led = cov.markCovered(led, { system: 'web', layer: 'L2', units: one, runId: 'R4', packs: PACKS });
  assert.equal(led.units['web|L2|lib'].status, 'covered');
});

test('markCovered rejects a bad status', () => {
  assert.throws(() => cov.markCovered(base(), { system: 'web', layer: 'L2', units: [], runId: 'R', packs: {}, status: 'done' }), /status/);
});

// ---- store round-trip ---------------------------------------------------------------------

test('readCoverage is empty when absent; write then read round-trips', () => {
  assert.deepEqual(store.readCoverage(SLUG), { project: SLUG, units: {} });
  const units = cov.unitsForRepo(TARGET);
  const led = cov.markCovered(store.readCoverage(SLUG), { system: 'web', layer: 'L2', units, runId: 'R1', packs: PACKS });
  store.writeCoverage(SLUG, led);
  assert.deepEqual(store.readCoverage(SLUG), led);
  assert.ok(fs.existsSync(path.join(home, 'projects', SLUG, 'coverage.json')));
});

test('writeCoverage rejects a malformed ledger and a mismatched project', () => {
  assert.throws(() => store.writeCoverage(SLUG, { project: SLUG, units: { k: { system: 'a' } } }), /invalid/);
  assert.throws(() => store.writeCoverage(SLUG, { project: 'other-app', units: {} }), /project/);
  assert.throws(() => store.writeCoverage('BAD SLUG', { project: 'x', units: {} }));
});

// ---- CLI ----------------------------------------------------------------------------------

const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, RAMPART_HOME: home } });

function seedProject() {
  const p = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'project.valid.json'), 'utf8'));
  delete p.created;
  delete p.updated;
  return p;
}

test('CLI units, gaps and show work end to end with --repo', () => {
  const p = seedProject();
  const sys = p.systems[0];
  store.writeProject(p);
  let r = run(['units', '--project', p.slug, '--system', sys.id, '--repo', TARGET, '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ids(JSON.parse(r.stdout)), ['.', 'app/api/export', 'app/api/invoices', 'app/api/users', 'lib']);
  r = run(['gaps', '--project', p.slug, '--system', sys.id, '--repo', TARGET, '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).length, 5);
  const units = cov.unitsForRepo(TARGET);
  const packs = Object.fromEntries(require('../scripts/packs.cjs').packsFor(sys).map((k) => [k.name, k.version]));
  store.writeCoverage(p.slug, cov.markCovered(store.readCoverage(p.slug), { system: sys.id, layer: 'L2', units, runId: 'R1', packs }));
  r = run(['gaps', '--project', p.slug, '--system', sys.id, '--repo', TARGET, '--json']);
  assert.deepEqual(JSON.parse(r.stdout), []);
  r = run(['show', '--project', p.slug, '--system', sys.id, '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(Object.keys(JSON.parse(r.stdout).units).length, 5);
});

test('CLI exits 2 on usage errors', () => {
  assert.equal(run([]).status, 2);
  assert.equal(run(['bogus']).status, 2);
  assert.equal(run(['units', '--project', SLUG]).status, 2);
  assert.equal(run(['units', '--project', SLUG, '--system', 'x']).status, 2); // no such project
  assert.equal(run(['units', '--project', SLUG, '--system', 'x', '--layer', 'L9']).status, 2);
});
