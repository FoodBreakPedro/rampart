const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const store = require('../scripts/store.cjs');
const { findingId } = require('../scripts/lib/id.cjs');
const { importClaudeSecurity } = require('../scripts/import-claude-security.cjs');

const CLI = path.join(__dirname, '..', 'scripts', 'import-claude-security.cjs');
// The fixture sits outside a CLAUDE-SECURITY-* directory (the repo's .gitignore skips those); each test copies it into one.
const FIXTURE_FILE = path.join(__dirname, 'fixtures', 'claude-security', 'CLAUDE-SECURITY-RESULTS.jsonl');
let FIXTURE_DIR;
const RESULTS = 'CLAUDE-SECURITY-RESULTS.jsonl';
const SLUG = 'example-app';
const SYSTEM = 'mobile';
// Text in the fixture records that must never reach the store.
const NEVER_STORED = ['FAKE-SNIPPET-SECRET-9f8e7d6c5b4a39281706', 'IMPACT-MARKER', 'DESCRIPTION-MARKER', 'EXPLOIT-MARKER', 'PRECONDITION-MARKER'];

const saved = process.env.RAMPART_HOME;
let home;
let scratch;
test.beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart store '));
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart report '));
  process.env.RAMPART_HOME = home;
  FIXTURE_DIR = path.join(scratch, 'fixture');
  fs.mkdirSync(path.join(FIXTURE_DIR, 'CLAUDE-SECURITY-2026-10-20-101500'), { recursive: true });
  fs.copyFileSync(FIXTURE_FILE, path.join(FIXTURE_DIR, 'CLAUDE-SECURITY-2026-10-20-101500', RESULTS));
  const { created, updated, ...project } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'project.valid.json'), 'utf8'));
  store.writeProject(project);
});
test.afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
  if (saved === undefined) delete process.env.RAMPART_HOME;
  else process.env.RAMPART_HOME = saved;
});

// A Rampart finding that the first fixture record (CWE-639 at src/api/orders.ts:getOrder) should merge into.
function seedExisting(overrides = {}) {
  const location = { path: 'src/api/orders.ts', symbol: 'getOrder' };
  const ruleId = 'supabase/rls-missing';
  const finding = {
    id: findingId({ project: SLUG, system: SYSTEM, ruleId, location }),
    project: SLUG, system: SYSTEM, layer: 'L3', source: 'rampart-hunter', pack: 'supabase@1.0.0', ruleId,
    title: 'Orders readable across tenants', severity: 'CRITICAL', confidence: 'HIGH', cwe: ['CWE-639'], class: 'verified',
    location, evidence: 'own evidence', verification: { verifiers: 3, confirmed: 3, run: '2026-10-01T00-00-00Z' },
    status: 'open', externalIds: { claudeSecurityPluginFindingId: null, cve: null },
    ...overrides,
  };
  const run = store.createRun(SLUG, { job: 'audit', layers: ['L3'], systems: [SYSTEM], executor: 'local' });
  store.upsertFindings(SLUG, [finding], run.runId);
  return finding;
}
const importFixture = (extra = {}) => importClaudeSecurity({ project: SLUG, system: SYSTEM, layer: 'L3', dir: FIXTURE_DIR, ...extra });
// A report directory under scratch holding the given lines.
function writeReport(name, lines) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, RESULTS), lines.join('\n'));
  return dir;
}
const fixtureLines = () => fs.readFileSync(FIXTURE_FILE, 'utf8').trim().split('\n');

test('three records: two added, one merged into the existing finding', () => {
  const existing = seedExisting();
  const { run, counts } = importFixture();
  assert.equal(run.status, 'done');
  assert.equal(run.job, 'import');
  assert.equal(counts.imported, 3);
  assert.equal(counts.added, 2);
  assert.equal(counts.merged, 1);
  const findings = store.readFindings(SLUG);
  assert.equal(findings.length, 3);
  const merged = findings.find((f) => f.id === existing.id);
  assert.equal(merged.title, existing.title, 'merge keeps the existing text');
  assert.equal(merged.source, 'rampart-hunter');
  assert.equal(merged.externalIds.claudeSecurityPluginFindingId, 'cs-0001');
  assert.equal(merged.verification.confirmed, 3, 'the higher verification count wins');
  const added = findings.filter((f) => f.source === 'claude-security');
  assert.equal(added.length, 2);
  for (const f of added) {
    assert.equal(f.class, 'verified');
    assert.equal(f.layer, 'L3');
    assert.deepEqual(f.verification, { verifiers: 3, confirmed: 2, run: run.runId });
    assert.match(f.ruleId, /^claude-security\/CWE-\d+$/);
  }
  const sql = added.find((f) => f.externalIds.claudeSecurityPluginFindingId === 'cs-0003');
  assert.equal(sql.severity, 'CRITICAL');
  assert.equal(sql.confidence, 'LOW');
  assert.equal(sql.location.symbol, null);
  assert.equal(sql.location.line, 88);
});

test('merge takes the record verification when the existing finding has fewer confirmations', () => {
  const existing = seedExisting({ verification: { verifiers: 1, confirmed: 1, run: '2026-10-01T00-00-00Z' } });
  importFixture();
  const merged = store.readFindings(SLUG).find((f) => f.id === existing.id);
  assert.equal(merged.verification.confirmed, 2);
  assert.equal(merged.verification.verifiers, 3);
});

test('re-import reports everything unchanged', () => {
  seedExisting();
  importFixture();
  const before = fs.readFileSync(path.join(home, 'projects', SLUG, 'findings.jsonl'), 'utf8').split('\n').length;
  const { counts } = importFixture();
  assert.equal(counts.added, 0);
  assert.equal(counts.merged, 3);
  assert.equal(counts.unchanged, 3);
  assert.equal(counts.updated, 0);
  assert.equal(store.readFindings(SLUG).length, 3);
  assert.equal(fs.readFileSync(path.join(home, 'projects', SLUG, 'findings.jsonl'), 'utf8').split('\n').length, before);
});

test('records without a usable file, and malformed lines, are skipped with a reason', () => {
  const [good] = fixtureLines();
  const base = JSON.parse(good);
  const bad = (o) => JSON.stringify({ ...base, claudeSecurityPluginFindingId: 'x', ...o });
  const dir = writeReport('CLAUDE-SECURITY-2026-10-21-000000', [
    good,
    bad({ file: undefined }),
    bad({ file: '' }),
    bad({ file: '/etc/passwd' }),
    bad({ file: '../outside.ts' }),
    '{not json FAKE-SNIPPET-SECRET-9f8e7d6c5b4a39281706',
    '',
  ]);
  const { counts, skipped } = importClaudeSecurity({ project: SLUG, system: SYSTEM, layer: 'L2', dir });
  assert.equal(counts.imported, 1);
  assert.equal(counts.skippedRecords, 5);
  assert.equal(skipped.length, 5);
  assert.deepEqual(skipped.map((s) => s.line), [2, 3, 4, 5, 6]);
  assert.match(skipped[0].reason, /file/);
  assert.match(skipped[4].reason, /malformed/);
  for (const s of skipped) assert.ok(!s.reason.includes('FAKE-SNIPPET'));
  assert.equal(store.readFindings(SLUG).length, 1);
});

test('nothing from snippet, description, impact or exploit scenario is stored', () => {
  seedExisting();
  importFixture();
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const files = walk(home);
  assert.ok(files.length > 0);
  for (const file of files) {
    const body = fs.readFileSync(file, 'utf8');
    for (const marker of NEVER_STORED) assert.ok(!body.includes(marker), `${path.basename(file)} holds ${marker}`);
  }
});

test('the newest report directory is the one read', () => {
  const [a, b] = fixtureLines().map((l) => JSON.parse(l));
  writeReport('CLAUDE-SECURITY-2026-10-01-000000', [JSON.stringify(a)]);
  writeReport('CLAUDE-SECURITY-2026-10-22-000000', [JSON.stringify(b)]);
  fs.mkdirSync(path.join(scratch, 'CLAUDE-SECURITY-2026-10-30-000000')); // newer, but no results file
  const { counts, file } = importClaudeSecurity({ project: SLUG, system: SYSTEM, layer: 'L3', dir: scratch });
  assert.equal(counts.imported, 1);
  assert.ok(file.includes('2026-10-22'));
  assert.equal(store.readFindings(SLUG)[0].externalIds.claudeSecurityPluginFindingId, 'cs-0002');
});

test('gates: no attestation, unknown system, bad layer, no report', () => {
  assert.throws(() => importFixture({ layer: 'L1' }), RangeError);
  assert.throws(() => importFixture({ system: 'nope' }), RangeError);
  assert.throws(() => importClaudeSecurity({ project: SLUG, system: SYSTEM, layer: 'L3', dir: scratch }), /no CLAUDE-SECURITY/);
  // The store refuses to write a project without an attestation, so strip it from the file directly.
  const file = path.join(home, 'projects', SLUG, 'project.json');
  const { ownerAttestation, ...bare } = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify(bare));
  assert.throws(() => importFixture(), /ownerAttestation/);
  assert.equal(store.readRuns(SLUG).length, 0, 'a refused import leaves no run');
});

test('CLI --json prints the run and counts; bad arguments exit 2', () => {
  seedExisting();
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, RAMPART_HOME: home } });
  const ok = run(['--project', SLUG, '--system', SYSTEM, '--layer', 'L3', '--dir', FIXTURE_DIR, '--json']);
  assert.equal(ok.status, 0, ok.stderr);
  const out = JSON.parse(ok.stdout);
  assert.equal(out.run.status, 'done');
  assert.equal(out.counts.added, 2);
  assert.equal(out.counts.merged, 1);
  for (const marker of NEVER_STORED) assert.ok(!ok.stdout.includes(marker));
  const text = run(['--project', SLUG, '--system', SYSTEM, '--layer', 'L3', '--dir', FIXTURE_DIR]);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /0 added, 3 merged/);
  assert.equal(run(['--project', SLUG, '--system', SYSTEM]).status, 2);
  assert.equal(run(['--project', SLUG, '--system', SYSTEM, '--layer', 'L1']).status, 2);
});

test('an import never changes a status: fixed and accepted_risk targets only gain the external id', () => {
  const fixed = seedExisting();
  const location = { path: 'src/auth/reset.ts', symbol: 'sendReset' };
  const ruleId = 'logging/token';
  const risk = {
    id: findingId({ project: SLUG, system: SYSTEM, ruleId, location }),
    project: SLUG, system: SYSTEM, layer: 'L3', source: 'rampart-hunter', pack: null, ruleId, title: 'Reset token logged',
    severity: 'MEDIUM', confidence: 'HIGH', cwe: ['CWE-532'], class: 'verified', location, evidence: 'e',
    status: 'open', externalIds: { claudeSecurityPluginFindingId: null, cve: null },
  };
  const seedRun = store.createRun(SLUG, { job: 'audit', layers: ['L3'], systems: [SYSTEM], executor: 'local' });
  store.upsertFindings(SLUG, [risk], seedRun.runId);
  store.setDisposition(SLUG, fixed.id, { status: 'fixed', reason: 'patched', by: 'me' });
  store.setDisposition(SLUG, risk.id, { status: 'accepted_risk', reason: 'known', by: 'me' });
  const before = store.readFindings(SLUG);
  const dispositions = JSON.stringify(store.readDispositions(SLUG));

  const first = importFixture().counts;
  assert.equal(first.merged, 2);
  assert.equal(first.added, 1);
  assert.equal(first.regressed, 0);
  const after = store.readFindings(SLUG);
  for (const f of [fixed, risk]) {
    const was = before.find((b) => b.id === f.id);
    const now = after.find((a) => a.id === f.id);
    assert.equal(now.status, was.status);
    assert.equal(now.lastSeen, was.lastSeen);
    assert.ok(now.externalIds.claudeSecurityPluginFindingId);
  }
  assert.equal(JSON.stringify(store.readDispositions(SLUG)), dispositions);

  const again = importFixture().counts;
  assert.equal(again.updated, 0);
  assert.equal(again.unchanged, 3);
  assert.equal(again.regressed, 0);
  assert.deepEqual(store.readFindings(SLUG).map((f) => [f.id, f.status, f.lastSeen]).slice(0, 2), after.map((f) => [f.id, f.status, f.lastSeen]).slice(0, 2));
});

test('records of one report that resolve to the same finding count once, keeping the stronger', () => {
  const base = JSON.parse(fixtureLines()[1]);
  const weak = JSON.stringify({ ...base, severity: 'LOW', confidence: 'low', claudeSecurityPluginFindingId: 'dup-1' });
  const strong = JSON.stringify({ ...base, severity: 'CRITICAL', confidence: 'high', claudeSecurityPluginFindingId: 'dup-2' });
  const dir = writeReport('CLAUDE-SECURITY-2026-10-23-000000', [weak, strong, weak]);
  const { counts } = importClaudeSecurity({ project: SLUG, system: SYSTEM, layer: 'L3', dir });
  assert.equal(counts.imported, 3);
  assert.equal(counts.added, 1);
  assert.equal(counts.duplicates, 2);
  const all = store.readFindings(SLUG);
  assert.equal(all.length, 1);
  assert.equal(all[0].severity, 'CRITICAL');
});

test('CLI --json includes skipped lines with their fixed reasons', () => {
  const base = JSON.parse(fixtureLines()[0]);
  const dir = writeReport('CLAUDE-SECURITY-2026-10-24-000000', [JSON.stringify({ ...base, file: '' }), 'garbage FAKE-SNIPPET-SECRET']);
  const r = spawnSync(process.execPath, [CLI, '--project', SLUG, '--system', SYSTEM, '--layer', 'L3', '--dir', dir, '--json'], { encoding: 'utf8', env: { ...process.env, RAMPART_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.skipped.map((s) => s.line), [1, 2]);
  assert.ok(!r.stdout.includes('FAKE-SNIPPET'));
});
