const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const store = require('../scripts/store.cjs');
const { validate, loadSchema } = require('../scripts/lib/validate.cjs');

const STORE = path.join(__dirname, '..', 'scripts', 'store.cjs');
const SLUG = 'example-app';
const RUN = '2026-10-23T18-02-11Z';
const ID_A = 'a3f9c21be0d4'; // the id in the finding fixture
const ID_B = 'b'.repeat(12);
const ID_C = 'c'.repeat(12);
const RUN_ARGS = { job: 'audit', layers: ['L1'], systems: ['mobile'], executor: 'local' };

const fixturePath = (name) => path.join(__dirname, 'fixtures', name);
const fixture = (name) => JSON.parse(fs.readFileSync(fixturePath(name), 'utf8'));
// The fixture carries created and updated; the store stamps both, so tests start without them.
const project = (over = {}) => {
  const { created, updated, ...rest } = fixture('project.valid.json');
  return { ...rest, ...over };
};
const finding = (over = {}) => ({ ...fixture('finding.valid.json'), ...over });
const iso = () => new Date().toISOString();
// Wait until the clock moves to a new millisecond, so two stamps taken around it differ.
const tick = () => { const t = Date.now(); while (Date.now() === t); };

// Each test gets a fresh store root; its name contains a space to prove paths round-trip.
const savedHome = process.env.RAMPART_HOME;
let home;
test.beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart store '));
  process.env.RAMPART_HOME = home;
});
test.afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.RAMPART_HOME;
  else process.env.RAMPART_HOME = savedHome;
});

const projectPath = (...parts) => path.join(home, 'projects', SLUG, ...parts);
const readText = (p) => fs.readFileSync(p, 'utf8');
const readJsonFile = (p) => JSON.parse(readText(p));
const readJsonlFile = (p) => readText(p).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const tmpFiles = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));

// ---- projects -----------------------------------------------------------------------------

test('writeProject and readProject round-trip, stamp created and updated, and keep paths with spaces', () => {
  const spaced = 'C:\\Users\\Some One\\Documents\\Github Repos\\example app';
  const input = project();
  input.systems[0].repo.paths = { abc123def456: spaced };
  const snapshot = JSON.parse(JSON.stringify(input));
  const before = iso();
  const written = store.writeProject(input);
  const after = iso();

  assert.ok(home.includes(' '), 'the store root has a space in it');
  assert.deepEqual(input, snapshot, "the caller's object is not mutated");
  assert.equal(written.slug, SLUG);
  assert.ok(written.updated >= before && written.updated <= after);
  assert.ok(written.created >= before && written.created <= after);
  assert.equal(written.systems[0].repo.paths.abc123def456, spaced);
  assert.deepEqual(store.readProject(SLUG), written);
  assert.deepEqual(readJsonFile(projectPath('project.json')), written);
  assert.deepEqual(store.listProjects(), [SLUG]);
  assert.equal(store.readProject('no-such-project'), null);
});

test('writeProject keeps created across rewrites, moves updated, and honours a created the caller supplies', () => {
  const first = store.writeProject(project());
  tick();
  const second = store.writeProject(project({ name: 'Renamed' }));
  assert.equal(second.created, first.created);
  assert.ok(second.updated > first.updated);
  assert.equal(store.readProject(SLUG).name, 'Renamed');

  const pinned = store.writeProject(project({ created: '2020-01-01T00:00:00Z' }));
  assert.equal(pinned.created, '2020-01-01T00:00:00Z');
});

test('writeProject throws on an invalid project, listing the errors, and writes nothing', () => {
  const bad = project({ criticality: 'extreme' });
  delete bad.name;
  assert.throws(
    () => store.writeProject(bad),
    (e) => e instanceof Error && /name/.test(e.message) && /criticality/.test(e.message)
  );
  assert.throws(() => store.writeProject(null), Error);
  assert.throws(() => store.writeProject(project({ slug: '../escape' })), Error);
  assert.equal(store.readProject(SLUG), null);
  assert.deepEqual(fs.readdirSync(home), []);
  assert.ok(!fs.existsSync(path.join(path.dirname(home), 'escape')));
});

test('listProjects lists only directories that hold a project.json, sorted', () => {
  assert.deepEqual(store.listProjects(), []);
  store.writeProject(project({ slug: 'zeta-app' }));
  store.writeProject(project({ slug: 'alpha-app' }));
  fs.mkdirSync(path.join(home, 'projects', 'no-project-file'), { recursive: true });
  fs.mkdirSync(path.join(home, 'projects', 'Not A Slug'), { recursive: true });
  assert.deepEqual(store.listProjects(), ['alpha-app', 'zeta-app']);
});

// ---- guards -------------------------------------------------------------------------------

test('every function that takes a slug rejects one that could leave the store', () => {
  const calls = {
    readProject: (s) => store.readProject(s),
    readFindings: (s) => store.readFindings(s),
    upsertFindings: (s) => store.upsertFindings(s, [finding()], RUN),
    closeMissing: (s) => store.closeMissing(s, { system: 'web', source: 'headers', runId: RUN, seenIds: [] }),
    readDispositions: (s) => store.readDispositions(s),
    setDisposition: (s) => store.setDisposition(s, ID_A, { status: 'fixed', reason: 'r', by: 'b' }),
    setClass: (s) => store.setClass(s, ID_A, 'verified', 'n'),
    createRun: (s) => store.createRun(s, RUN_ARGS),
    finishRun: (s) => store.finishRun(s, RUN, { status: 'done' }),
    writeRaw: (s) => store.writeRaw(s, RUN, 'x.json', '{}'),
    appendScore: (s) => store.appendScore(s, { score: 1 }),
    readScores: (s) => store.readScores(s),
  };
  const badSlugs = ['../..', '..', '.', 'a/b', 'a\\b', 'A-B', 'a', 'x'.repeat(41), '', 'ab\n', 'ab cd', undefined, null, 7];
  for (const [name, call] of Object.entries(calls)) {
    for (const bad of badSlugs) {
      assert.throws(
        () => call(bad),
        (e) => e instanceof RangeError && /slug/.test(e.message) && !e.message.includes('../..'),
        `${name}(${JSON.stringify(bad)}) should throw a RangeError about the slug`
      );
    }
  }
  assert.deepEqual(fs.readdirSync(home), [], 'a rejected slug writes nothing');
});

test('runId is checked against the run id format wherever it is accepted', () => {
  const badRunIds = ['../x', '..', '2026-10-23', `${RUN}/..`, '2026-10-23T18:02:11Z', `${RUN}\n`, '', undefined, null];
  for (const bad of badRunIds) {
    const label = JSON.stringify(bad);
    const aboutRunId = (e) => e instanceof RangeError && /runId/.test(e.message) && !e.message.includes('..');
    assert.throws(() => store.upsertFindings(SLUG, [finding()], bad), aboutRunId, `upsertFindings ${label}`);
    assert.throws(() => store.closeMissing(SLUG, { system: 'web', source: 'headers', runId: bad, seenIds: [] }), aboutRunId, `closeMissing ${label}`);
    assert.throws(() => store.finishRun(SLUG, bad, { status: 'done' }), aboutRunId, `finishRun ${label}`);
    assert.throws(() => store.writeRaw(SLUG, bad, 'x.json', '{}'), aboutRunId, `writeRaw ${label}`);
  }
  assert.deepEqual(fs.readdirSync(home), []);
});

// ---- upsertFindings -----------------------------------------------------------------------

test('upsert: a new finding is added as open with firstSeen = lastSeen = now', () => {
  const before = iso();
  const res = store.upsertFindings(SLUG, [finding({ status: 'fixed', firstSeen: '2001-01-01T00:00:00Z' })], RUN);
  const after = iso();
  assert.deepEqual(res, { added: 1, updated: 0, unchanged: 0, regressed: 0 });

  const rows = readJsonlFile(projectPath('findings.jsonl'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, ID_A);
  assert.equal(rows[0].status, 'open');
  assert.equal(rows[0].firstSeen, rows[0].lastSeen);
  assert.ok(rows[0].firstSeen >= before && rows[0].firstSeen <= after);
  assert.deepEqual(store.readFindings(SLUG), rows);
  assert.deepEqual(store.readFindings('some-other-app'), []);
});

test('upsert twice: the second pass is unchanged, firstSeen stays and lastSeen moves', () => {
  store.upsertFindings(SLUG, [finding()], RUN);
  const first = store.readFindings(SLUG)[0];
  tick();
  const res = store.upsertFindings(SLUG, [finding()], RUN);
  assert.deepEqual(res, { added: 0, updated: 0, unchanged: 1, regressed: 0 });

  const rows = readJsonlFile(projectPath('findings.jsonl'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].firstSeen, first.firstSeen);
  assert.ok(rows[0].lastSeen > first.lastSeen);
  assert.deepEqual({ ...rows[0], lastSeen: 0 }, { ...first, lastSeen: 0 });
});

// verification.run names the run that last looked at a finding, so it moves on every scan. It is stored, but a finding
// whose only difference is that run id has not changed.
const NEXT_RUN = '2026-10-23T18-09-45Z';
const seenIn = (runId, over = {}) => finding({ verification: { ...finding().verification, run: runId }, ...over });

test('upsert: a different verification.run alone is unchanged, and the stored run is the new one', () => {
  store.upsertFindings(SLUG, [seenIn(RUN)], RUN);
  const res = store.upsertFindings(SLUG, [seenIn(NEXT_RUN)], NEXT_RUN);
  assert.deepEqual(res, { added: 0, updated: 0, unchanged: 1, regressed: 0 });
  const row = readJsonlFile(projectPath('findings.jsonl'))[0];
  assert.deepEqual(row.verification, { ...finding().verification, run: NEXT_RUN });
});

test('upsert: a verification change beyond the run id still counts as updated, and any other change alongside the run id does too', () => {
  store.upsertFindings(SLUG, [seenIn(RUN)], RUN);
  const verifiers = { ...finding().verification, verifiers: 5, run: NEXT_RUN };
  assert.deepEqual(store.upsertFindings(SLUG, [finding({ verification: verifiers })], NEXT_RUN), { added: 0, updated: 1, unchanged: 0, regressed: 0 });
  assert.deepEqual(store.readFindings(SLUG)[0].verification, verifiers);

  const third = '2026-10-23T18-15-00Z';
  assert.deepEqual(store.upsertFindings(SLUG, [seenIn(third, { severity: 'LOW' })], third), { added: 0, updated: 1, unchanged: 0, regressed: 0 });
  const row = store.readFindings(SLUG)[0];
  assert.equal(row.severity, 'LOW');
  assert.equal(row.verification.run, third);
});

test('upsert: a fixed finding that comes back under a new run is regressed and records that run', () => {
  store.upsertFindings(SLUG, [seenIn(RUN)], RUN);
  store.setDisposition(SLUG, ID_A, { status: 'fixed', reason: 'patched', by: 'pedro' });
  const res = store.upsertFindings(SLUG, [seenIn(NEXT_RUN)], NEXT_RUN);
  assert.deepEqual(res, { added: 0, updated: 0, unchanged: 0, regressed: 1 });
  const row = store.readFindings(SLUG)[0];
  assert.equal(row.status, 'regressed');
  assert.equal(row.verification.run, NEXT_RUN);
});

test('upsert: changed mutable fields are replaced and counted as updated; store-owned fields are not', () => {
  store.upsertFindings(SLUG, [finding()], RUN);
  const first = store.readFindings(SLUG)[0];
  const incoming = finding({
    severity: 'CRITICAL',
    confidence: 'MEDIUM',
    title: 'New title',
    evidence: 'new evidence',
    cwe: ['CWE-287'],
    class: 'hardening',
    pack: 'supabase@1.3.0',
    location: { host: '192.0.2.10', service: 'supabase-auth', setting: 'OTHER_SETTING' },
    system: 'other-system',
    fixedIn: 'abc123',
    status: 'fixed',
    firstSeen: '2001-01-01T00:00:00Z',
  });
  const res = store.upsertFindings(SLUG, [incoming], RUN);
  assert.deepEqual(res, { added: 0, updated: 1, unchanged: 0, regressed: 0 });

  const row = readJsonlFile(projectPath('findings.jsonl'))[0];
  assert.equal(row.severity, 'CRITICAL');
  assert.equal(row.confidence, 'MEDIUM');
  assert.equal(row.title, 'New title');
  assert.equal(row.evidence, 'new evidence');
  assert.deepEqual(row.cwe, ['CWE-287']);
  assert.equal(row.class, 'hardening');
  assert.equal(row.pack, 'supabase@1.3.0');
  assert.equal(row.location.setting, 'OTHER_SETTING');
  assert.equal(row.system, first.system);
  assert.equal(row.fixedIn, first.fixedIn);
  assert.equal(row.status, 'open');
  assert.equal(row.firstSeen, first.firstSeen);
});

test('upsert: key order inside nested fields is not a change', () => {
  store.upsertFindings(SLUG, [finding()], RUN);
  const f = finding();
  f.location = { setting: f.location.setting, service: f.location.service, host: f.location.host };
  f.verification = { run: f.verification.run, confirmed: f.verification.confirmed, verifiers: f.verification.verifiers };
  const res = store.upsertFindings(SLUG, [f], RUN);
  assert.deepEqual(res, { added: 0, updated: 0, unchanged: 1, regressed: 0 });
});

test('upsert: a mutable field the incoming finding leaves out keeps its stored value', () => {
  store.upsertFindings(SLUG, [finding()], RUN);
  const lean = finding();
  delete lean.exploitScenario;
  delete lean.verification;
  const res = store.upsertFindings(SLUG, [lean], RUN);
  assert.deepEqual(res, { added: 0, updated: 0, unchanged: 1, regressed: 0 });
  const row = store.readFindings(SLUG)[0];
  assert.equal(row.exploitScenario, finding().exploitScenario);
  assert.deepEqual(row.verification, finding().verification);
});

test('upsert: a fixed finding that comes back is regressed, keeping its original firstSeen', () => {
  store.upsertFindings(SLUG, [finding()], RUN);
  const original = store.readFindings(SLUG)[0];
  tick();

  const fixed = store.setDisposition(SLUG, ID_A, { status: 'fixed', reason: 'patched in abc123', by: 'pedro' });
  assert.equal(fixed.status, 'fixed');
  assert.equal(readJsonlFile(projectPath('findings.jsonl'))[0].status, 'fixed');
  tick();

  const res = store.upsertFindings(SLUG, [finding()], RUN);
  assert.deepEqual(res, { added: 0, updated: 0, unchanged: 0, regressed: 1 });
  const row = readJsonlFile(projectPath('findings.jsonl'))[0];
  assert.equal(row.status, 'regressed');
  assert.equal(row.firstSeen, original.firstSeen);
  assert.ok(row.lastSeen > original.lastSeen);

  // Seen again while still regressed: it stays regressed and counts as an ordinary sighting.
  const again = store.upsertFindings(SLUG, [finding()], RUN);
  assert.deepEqual(again, { added: 0, updated: 0, unchanged: 1, regressed: 0 });
  assert.equal(store.readFindings(SLUG)[0].status, 'regressed');
});

test('upsert: a regression rewrites the disposition record, so dispositions.json never says fixed for it', () => {
  store.upsertFindings(SLUG, [finding(), finding({ id: ID_B })], RUN);
  store.setDisposition(SLUG, ID_A, { status: 'fixed', reason: 'patched in abc123', by: 'pedro' });
  store.setDisposition(SLUG, ID_B, { status: 'fixed', reason: 'patched in def456', by: 'pedro' });
  const untouched = store.readDispositions(SLUG)[ID_B];
  tick();

  // Only A comes back; B stays fixed and keeps its record.
  const run2 = '2026-10-24T09-30-00Z';
  const before = iso();
  store.upsertFindings(SLUG, [finding()], run2);
  const after = iso();

  const disp = readJsonFile(projectPath('dispositions.json'));
  const { at, ...rest } = disp[ID_A];
  assert.deepEqual(rest, { status: 'regressed', reason: `reappeared in run ${run2}`, by: 'rampart' });
  assert.ok(at >= before && at <= after);
  assert.deepEqual(disp[ID_B], untouched);
  assert.deepEqual(store.readDispositions(SLUG), disp);
  const rows = readJsonlFile(projectPath('findings.jsonl'));
  assert.equal(rows[0].status, 'regressed');
  assert.equal(rows[1].status, 'fixed');

  // Seen again while regressed: no new regression, so the record is not rewritten.
  tick();
  store.upsertFindings(SLUG, [finding()], '2026-10-25T09-30-00Z');
  assert.deepEqual(readJsonFile(projectPath('dispositions.json'))[ID_A], disp[ID_A]);

  // A person can still close it again.
  store.setDisposition(SLUG, ID_A, { status: 'fixed', reason: 'patched again', by: 'pedro' });
  assert.equal(store.readDispositions(SLUG)[ID_A].status, 'fixed');
});

test('upsert: a regression with no earlier disposition record still writes one', () => {
  store.upsertFindings(SLUG, [finding()], RUN);
  // Mark it fixed directly in findings.jsonl, as an import or an older store might have.
  const rows = store.readFindings(SLUG);
  rows[0].status = 'fixed';
  fs.writeFileSync(projectPath('findings.jsonl'), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  assert.ok(!fs.existsSync(projectPath('dispositions.json')));

  assert.deepEqual(store.upsertFindings(SLUG, [finding()], RUN), { added: 0, updated: 0, unchanged: 0, regressed: 1 });
  assert.equal(store.readDispositions(SLUG)[ID_A].status, 'regressed');
});

test('upsert: a promotion survives re-scans (verified is not reset to tool, evidence is kept)', () => {
  const scan = () => finding({ class: 'tool', evidence: 'gitleaks: generic-api-key at config.ts' });
  store.upsertFindings(SLUG, [scan()], RUN);
  store.setClass(SLUG, ID_A, 'verified', 'triage: real key');
  const promoted = store.readFindings(SLUG)[0];
  assert.equal(promoted.class, 'verified');
  assert.ok(promoted.evidence.endsWith('; triage: real key'));
  tick();

  // The scanner reports the same hit again, as a plain tool finding.
  const res = store.upsertFindings(SLUG, [scan()], RUN);
  assert.deepEqual(res, { added: 0, updated: 0, unchanged: 1, regressed: 0 });
  const row = readJsonlFile(projectPath('findings.jsonl'))[0];
  assert.equal(row.class, 'verified');
  assert.equal(row.evidence, promoted.evidence);
  assert.ok(row.evidence.endsWith('; triage: real key'));
  assert.ok(row.lastSeen > promoted.lastSeen);

  // Another mutable field that did change still updates; class and evidence are still kept.
  const res2 = store.upsertFindings(SLUG, [{ ...scan(), severity: 'LOW', title: 'Renamed rule' }], RUN);
  assert.deepEqual(res2, { added: 0, updated: 1, unchanged: 0, regressed: 0 });
  const row2 = store.readFindings(SLUG)[0];
  assert.equal(row2.severity, 'LOW');
  assert.equal(row2.title, 'Renamed rule');
  assert.equal(row2.class, 'verified');
  assert.equal(row2.evidence, promoted.evidence);
});

test('upsert: a fixed verified finding re-reported as a tool hit regresses but keeps its promotion', () => {
  store.upsertFindings(SLUG, [finding({ class: 'tool', evidence: 'scanner says so' })], RUN);
  store.setClass(SLUG, ID_A, 'verified', 'triage: real key');
  const promoted = store.readFindings(SLUG)[0];
  store.setDisposition(SLUG, ID_A, { status: 'fixed', reason: 'key rotated', by: 'pedro' });

  const res = store.upsertFindings(SLUG, [finding({ class: 'tool', evidence: 'scanner says so' })], RUN);
  assert.deepEqual(res, { added: 0, updated: 0, unchanged: 0, regressed: 1 });
  const row = store.readFindings(SLUG)[0];
  assert.equal(row.status, 'regressed');
  assert.equal(row.class, 'verified');
  assert.equal(row.evidence, promoted.evidence);
});

test('upsert: every other class transition follows the incoming finding', () => {
  const cases = [
    ['verified', 'hardening'],
    ['verified', 'verified'],
    ['tool', 'verified'],
    ['tool', 'hardening'],
    ['tool', 'tool'],
    ['hardening', 'verified'],
    ['hardening', 'tool'],
  ];
  for (const [stored, incoming] of cases) {
    const slug = `class-${stored}-to-${incoming}`;
    store.upsertFindings(slug, [finding({ class: stored, evidence: 'old evidence' })], RUN);
    const res = store.upsertFindings(slug, [finding({ class: incoming, evidence: 'new evidence' })], RUN);
    const row = store.readFindings(slug)[0];
    const label = `${stored} -> ${incoming}`;
    assert.equal(row.class, incoming, label);
    assert.equal(row.evidence, 'new evidence', label);
    assert.deepEqual(res, { added: 0, updated: 1, unchanged: 0, regressed: 0 }, label);
  }
});

for (const status of ['false_positive', 'accepted_risk']) {
  test(`upsert: a ${status} finding keeps its status and fields; only lastSeen moves`, () => {
    store.upsertFindings(SLUG, [finding()], RUN);
    store.setDisposition(SLUG, ID_A, { status, reason: 'reviewed', by: 'pedro' });
    const before = store.readFindings(SLUG)[0];
    tick();

    const res = store.upsertFindings(SLUG, [finding({ severity: 'LOW', evidence: 'changed' })], RUN);
    assert.deepEqual(res, { added: 0, updated: 0, unchanged: 1, regressed: 0 });
    const row = readJsonlFile(projectPath('findings.jsonl'))[0];
    assert.equal(row.status, status);
    assert.equal(row.severity, before.severity);
    assert.equal(row.evidence, before.evidence);
    assert.equal(row.firstSeen, before.firstSeen);
    assert.ok(row.lastSeen > before.lastSeen);
  });
}

test('upsert: a mixed batch is counted per finding, stored order is kept and new findings go last', () => {
  store.upsertFindings(SLUG, [finding(), finding({ id: ID_B })], RUN);
  const res = store.upsertFindings(
    SLUG,
    [finding({ id: ID_C }), finding({ id: ID_B, severity: 'LOW' }), finding()],
    RUN
  );
  assert.deepEqual(res, { added: 1, updated: 1, unchanged: 1, regressed: 0 });
  const rows = readJsonlFile(projectPath('findings.jsonl'));
  assert.deepEqual(rows.map((r) => r.id), [ID_A, ID_B, ID_C]);
  assert.equal(rows[1].severity, 'LOW');
});

test('upsert: the same id twice in one batch counts once; an empty batch writes nothing', () => {
  const res = store.upsertFindings(SLUG, [finding(), finding({ title: 'Later copy wins' })], RUN);
  assert.deepEqual(res, { added: 1, updated: 0, unchanged: 0, regressed: 0 });
  const rows = store.readFindings(SLUG);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Later copy wins');

  assert.deepEqual(store.upsertFindings('empty-batch', [], RUN), { added: 0, updated: 0, unchanged: 0, regressed: 0 });
  assert.ok(!fs.existsSync(path.join(home, 'projects', 'empty-batch')));
});

test('upsert validates every finding before it writes anything', () => {
  const bad = finding({ id: ID_B });
  delete bad.title;
  assert.throws(
    () => store.upsertFindings(SLUG, [finding(), bad], RUN),
    (e) => e instanceof Error && /findings\[1\]/.test(e.message) && /title/.test(e.message)
  );
  assert.throws(() => store.upsertFindings(SLUG, finding(), RUN), TypeError);
  assert.ok(!fs.existsSync(projectPath('findings.jsonl')));
});

test('findings.jsonl is replaced atomically: a temp file in the same directory, renamed over the target', () => {
  store.upsertFindings(SLUG, [finding()], RUN);
  const target = projectPath('findings.jsonl');
  const renames = [];
  const real = fs.renameSync;
  fs.renameSync = (from, to) => { renames.push([from, to]); return real(from, to); };
  try {
    store.upsertFindings(SLUG, [finding({ id: ID_B })], RUN);
  } finally {
    fs.renameSync = real;
  }
  assert.equal(renames.length, 1);
  assert.equal(renames[0][1], target);
  assert.notEqual(renames[0][0], target);
  assert.equal(path.dirname(renames[0][0]), path.dirname(target));
  assert.deepEqual(tmpFiles(projectPath()), []);
  assert.equal(readJsonlFile(target).length, 2);
});

test('a write that fails leaves findings.jsonl as it was and no temp file behind', () => {
  store.upsertFindings(SLUG, [finding()], RUN);
  const target = projectPath('findings.jsonl');
  const before = readText(target);
  const real = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  try {
    assert.throws(() => store.upsertFindings(SLUG, [finding({ id: ID_B })], RUN), /disk full/);
  } finally {
    fs.renameSync = real;
  }
  assert.equal(readText(target), before);
  assert.deepEqual(tmpFiles(projectPath()), []);
});

test('a corrupt findings.jsonl line is reported by line number without echoing its content', () => {
  fs.mkdirSync(projectPath(), { recursive: true });
  fs.writeFileSync(projectPath('findings.jsonl'), '{"id":"a3f9c21be0d4"}\n\nPASSWORD=abcdefghij {oops\n');
  assert.throws(
    () => store.readFindings(SLUG),
    (e) => /line 3/.test(e.message) && !e.message.includes('abcdefghij')
  );
});

// ---- closeMissing -------------------------------------------------------------------------

const ID_D = 'd'.repeat(12);
const ID_E = 'e'.repeat(12);
const ID_F = 'f'.repeat(12);
const ID_G = '1'.repeat(12);
const ID_H = '2'.repeat(12);
const CLOSE_RUN = '2026-10-24T09-30-00Z';
const closeArgs = (over = {}) => ({ system: 'web', source: 'headers', runId: CLOSE_RUN, seenIds: [ID_A], ...over });

// web/headers: A (still reported), B (open), C (regressed), D (false positive), E (accepted risk), F (fixed by Pedro);
// api/headers: G; web/trivy: H.
function seedClosable() {
  const web = (id, over = {}) => finding({ id, system: 'web', source: 'headers', ...over });
  store.upsertFindings(SLUG, [
    web(ID_A), web(ID_B), web(ID_C), web(ID_D), web(ID_E), web(ID_F),
    web(ID_G, { system: 'api' }), web(ID_H, { source: 'trivy' }),
  ], RUN);
  store.setDisposition(SLUG, ID_D, { status: 'false_positive', reason: 'scanner quirk', by: 'pedro' });
  store.setDisposition(SLUG, ID_E, { status: 'accepted_risk', reason: 'internal only', by: 'pedro' });
  store.setDisposition(SLUG, ID_F, { status: 'fixed', reason: 'patched in abc123', by: 'pedro' });
  store.setDisposition(SLUG, ID_C, { status: 'fixed', reason: 'patched in def456', by: 'pedro' });
  store.upsertFindings(SLUG, [web(ID_C)], '2026-10-23T20-00-00Z'); // C comes back: regressed
  assert.equal(store.readFindings(SLUG).find((f) => f.id === ID_C).status, 'regressed');
}
const byId = () => Object.fromEntries(store.readFindings(SLUG).map((f) => [f.id, f]));

test('closeMissing: only the open or regressed findings of that system and source that were not seen are fixed, with a disposition', () => {
  seedClosable();
  const before = byId();
  const dispBefore = store.readDispositions(SLUG);
  tick();
  const started = iso();
  const res = store.closeMissing(SLUG, closeArgs());
  const finished = iso();

  assert.deepEqual(res, { closed: 2 });
  const after = byId();
  assert.equal(after[ID_A].status, 'open', 'still reported');
  assert.equal(after[ID_B].status, 'fixed');
  assert.equal(after[ID_C].status, 'fixed', 'a regressed finding closes too');
  assert.equal(after[ID_D].status, 'false_positive');
  assert.equal(after[ID_E].status, 'accepted_risk');
  assert.equal(after[ID_F].status, 'fixed');
  assert.equal(after[ID_G].status, 'open', 'another system');
  assert.equal(after[ID_H].status, 'open', 'another source');
  for (const [id, row] of Object.entries(after)) {
    assert.deepEqual({ ...row, status: undefined }, { ...before[id], status: undefined }, `${id}: only the status changes (lastSeen too)`);
  }

  const disp = store.readDispositions(SLUG);
  for (const id of [ID_B, ID_C]) {
    const { at, ...rest } = disp[id];
    assert.deepEqual(rest, { status: 'fixed', reason: `not reproduced in run ${CLOSE_RUN}`, by: 'rampart' });
    assert.ok(at >= started && at <= finished);
  }
  for (const id of [ID_D, ID_E, ID_F]) assert.deepEqual(disp[id], dispBefore[id], `${id}: the person's record is untouched`);
  for (const id of [ID_A, ID_G, ID_H]) assert.equal(disp[id], undefined, `${id}: no record`);
  assert.deepEqual(readJsonFile(projectPath('dispositions.json')), disp);
  assert.deepEqual(tmpFiles(projectPath()), []);
});

test('closeMissing: a second call changes nothing, and seenIds may be a Set or empty', () => {
  seedClosable();
  assert.deepEqual(store.closeMissing(SLUG, closeArgs({ seenIds: new Set([ID_A]) })), { closed: 2 });
  const rows = readText(projectPath('findings.jsonl'));
  const disp = readText(projectPath('dispositions.json'));
  assert.deepEqual(store.closeMissing(SLUG, closeArgs({ runId: '2026-10-25T09-30-00Z' })), { closed: 0 });
  assert.equal(readText(projectPath('findings.jsonl')), rows);
  assert.equal(readText(projectPath('dispositions.json')), disp, 'the reason still names the run that closed it');

  assert.deepEqual(store.closeMissing(SLUG, closeArgs({ seenIds: [] })), { closed: 1 }, 'with nothing seen, A closes as well');
  assert.equal(byId()[ID_A].status, 'fixed');
});

test('closeMissing: a filter narrows the candidates further, and only sees the findings that qualify otherwise', () => {
  seedClosable();
  const seenByFilter = [];
  const res = store.closeMissing(SLUG, closeArgs({ filter: (f) => { seenByFilter.push(f.id); return f.id === ID_C; } }));
  assert.deepEqual(res, { closed: 1 });
  assert.deepEqual(seenByFilter.sort(), [ID_B, ID_C].sort(), 'not A (seen), D, E, F (triaged or fixed), G (other system) or H (other source)');
  const after = byId();
  assert.equal(after[ID_B].status, 'open', 'the filter kept it');
  assert.equal(after[ID_C].status, 'fixed');
  assert.equal(store.readDispositions(SLUG)[ID_B], undefined);

  const rows = readText(projectPath('findings.jsonl'));
  assert.deepEqual(store.closeMissing(SLUG, closeArgs({ filter: () => false })), { closed: 0 });
  assert.equal(readText(projectPath('findings.jsonl')), rows, 'nothing closes, nothing is rewritten');
  assert.deepEqual(store.closeMissing(SLUG, closeArgs({ filter: () => true })), { closed: 1 }, 'a filter that takes all is no filter');
  assert.equal(byId()[ID_B].status, 'fixed');
});

test('closeMissing: a closed finding that comes back is regressed by the next upsert, which rewrites its record', () => {
  store.upsertFindings(SLUG, [finding({ source: 'headers' })], RUN);
  store.closeMissing(SLUG, { system: 'db', source: 'headers', runId: CLOSE_RUN, seenIds: [] });
  assert.equal(byId()[ID_A].status, 'fixed');
  assert.deepEqual(store.upsertFindings(SLUG, [finding({ source: 'headers' })], '2026-10-25T09-30-00Z'), { added: 0, updated: 0, unchanged: 0, regressed: 1 });
  assert.equal(byId()[ID_A].status, 'regressed');
  assert.equal(store.readDispositions(SLUG)[ID_A].status, 'regressed');
});

test('closeMissing: a project with no findings is {closed: 0} and writes nothing', () => {
  assert.deepEqual(store.closeMissing(SLUG, closeArgs()), { closed: 0 });
  assert.ok(!fs.existsSync(projectPath('findings.jsonl')));
  assert.ok(!fs.existsSync(projectPath('dispositions.json')));
});

test('closeMissing: a bad slug, run id or argument is rejected and nothing is written', () => {
  store.upsertFindings(SLUG, [finding({ system: 'web', source: 'headers' })], RUN);
  const rows = readText(projectPath('findings.jsonl'));
  assert.throws(() => store.closeMissing('../..', closeArgs()), RangeError);
  assert.throws(() => store.closeMissing(SLUG, closeArgs({ runId: '../x' })), /runId/);
  for (const bad of [{ system: undefined }, { system: '' }, { source: undefined }, { source: 7 }, { seenIds: undefined }, { seenIds: null }, { seenIds: 'abc' }, { seenIds: 5 }, { filter: 'yes' }, { filter: null }]) {
    assert.throws(() => store.closeMissing(SLUG, closeArgs(bad)), TypeError, JSON.stringify(bad));
  }
  assert.throws(() => store.closeMissing(SLUG), RangeError, "no arguments is no run id");
  assert.equal(readText(projectPath('findings.jsonl')), rows);
  assert.ok(!fs.existsSync(projectPath('dispositions.json')));
});

// ---- dispositions -------------------------------------------------------------------------

test('setDisposition writes dispositions.json and sets the finding status to the same value', () => {
  store.upsertFindings(SLUG, [finding(), finding({ id: ID_B })], RUN);
  assert.deepEqual(store.readDispositions(SLUG), {});
  const before = iso();
  const res = store.setDisposition(SLUG, ID_A, { status: 'accepted_risk', reason: 'internal only', by: 'pedro' });
  const after = iso();

  assert.equal(res.id, ID_A);
  assert.equal(res.status, 'accepted_risk');
  const disp = readJsonFile(projectPath('dispositions.json'));
  assert.deepEqual(Object.keys(disp), [ID_A]);
  const { at, ...rest } = disp[ID_A];
  assert.deepEqual(rest, { status: 'accepted_risk', reason: 'internal only', by: 'pedro' });
  assert.ok(at >= before && at <= after);
  assert.deepEqual(store.readDispositions(SLUG), disp);

  const rows = readJsonlFile(projectPath('findings.jsonl'));
  assert.equal(rows[0].status, 'accepted_risk');
  assert.equal(rows[1].status, 'open', 'other findings are untouched');
});

test('setDisposition takes all four statuses, including open to reopen a finding', () => {
  store.upsertFindings(SLUG, [finding()], RUN);
  for (const status of ['fixed', 'false_positive', 'accepted_risk', 'open']) {
    const res = store.setDisposition(SLUG, ID_A, { status, reason: `now ${status}`, by: 'pedro' });
    assert.equal(res.status, status);
    assert.equal(store.readFindings(SLUG)[0].status, status);
    assert.equal(store.readDispositions(SLUG)[ID_A].status, status);
  }
});

test('setDisposition rejects an unknown status or finding id and changes nothing', () => {
  store.upsertFindings(SLUG, [finding()], RUN);
  assert.throws(() => store.setDisposition(SLUG, ID_A, { status: 'wontfix', reason: 'x', by: 'y' }), /status/);
  assert.throws(() => store.setDisposition(SLUG, ID_A, { status: 'regressed', reason: 'x', by: 'y' }), /status/);
  assert.throws(() => store.setDisposition(SLUG, 'f'.repeat(12), { status: 'fixed', reason: 'x', by: 'y' }), /finding/);
  assert.ok(!fs.existsSync(projectPath('dispositions.json')));
  assert.equal(store.readFindings(SLUG)[0].status, 'open');
});

test('setDisposition redacts credentials out of the reason', () => {
  store.upsertFindings(SLUG, [finding()], RUN);
  store.setDisposition(SLUG, ID_A, { status: 'false_positive', reason: 'test fixture, PASSWORD=abcdefghij', by: 'pedro' });
  const text = readText(projectPath('dispositions.json'));
  assert.ok(text.includes('[REDACTED]'));
  assert.ok(!text.includes('abcdefghij'));
});

// ---- setClass -----------------------------------------------------------------------------

test('setClass changes class and appends the note to evidence', () => {
  const tool = finding({ class: 'tool', evidence: 'gitleaks: generic-api-key at config.ts' });
  store.upsertFindings(SLUG, [tool, finding({ id: ID_B, class: 'tool' })], RUN);
  const untouched = store.readFindings(SLUG)[1];

  const res = store.setClass(SLUG, ID_A, 'verified', 'triage: real key pattern');
  assert.equal(res.class, 'verified');
  assert.equal(res.evidence, 'gitleaks: generic-api-key at config.ts; triage: real key pattern');
  const rows = readJsonlFile(projectPath('findings.jsonl'));
  assert.deepEqual(rows[0], res);
  assert.deepEqual(rows[1], untouched);

  const demoted = store.setClass(SLUG, ID_A, 'hardening', 'saw PASSWORD=abcdefghij in the file');
  assert.equal(demoted.class, 'hardening');
  assert.ok(demoted.evidence.endsWith('; saw PASSWORD=[REDACTED] in the file'));
  assert.ok(!readText(projectPath('findings.jsonl')).includes('abcdefghij'));
});

test('setClass rejects an unknown class or finding id and changes nothing', () => {
  store.upsertFindings(SLUG, [finding({ class: 'tool' })], RUN);
  const before = readText(projectPath('findings.jsonl'));
  assert.throws(() => store.setClass(SLUG, ID_A, 'critical', 'x'), /class/);
  assert.throws(() => store.setClass(SLUG, 'f'.repeat(12), 'verified', 'x'), /finding/);
  assert.equal(readText(projectPath('findings.jsonl')), before);
});

// ---- runs ---------------------------------------------------------------------------------

test('createRun writes a valid running run.json; finishRun merges the patch and stamps finishedAt', () => {
  const before = iso();
  const run = store.createRun(SLUG, RUN_ARGS);
  const after = iso();
  assert.match(run.runId, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
  assert.equal(run.project, SLUG);
  assert.equal(run.status, 'running');
  assert.deepEqual(run.counts, { added: 0, updated: 0, unchanged: 0, hardening: 0 });
  assert.ok(run.startedAt >= before && run.startedAt <= after);
  assert.equal(run.finishedAt, undefined);

  const file = projectPath('runs', run.runId, 'run.json');
  assert.deepEqual(readJsonFile(file), run);
  assert.deepEqual(validate(loadSchema('run'), readJsonFile(file)), { ok: true, errors: [] });

  const counts = { added: 2, updated: 1, unchanged: 0, hardening: 3 };
  const done = store.finishRun(SLUG, run.runId, { status: 'done', counts, revision: { commit: 'abc123', dirty: false } });
  assert.equal(done.status, 'done');
  assert.ok(done.finishedAt >= run.startedAt);
  assert.deepEqual(done.counts, counts);
  assert.equal(done.job, 'audit');
  assert.equal(done.startedAt, run.startedAt);
  assert.deepEqual(readJsonFile(file), done);
  assert.deepEqual(validate(loadSchema('run'), readJsonFile(file)), { ok: true, errors: [] });
});

test('finishRun: counts merge into the existing counts, and only a final status stamps finishedAt', () => {
  const run = store.createRun(SLUG, RUN_ARGS);
  const mid = store.finishRun(SLUG, run.runId, { counts: { added: 4 } });
  assert.deepEqual(mid.counts, { added: 4, updated: 0, unchanged: 0, hardening: 0 });
  assert.equal(mid.status, 'running');
  assert.equal(mid.finishedAt, undefined);

  for (const status of ['done', 'skipped', 'failed']) {
    const r = store.createRun(SLUG, RUN_ARGS);
    const fin = store.finishRun(SLUG, r.runId, { status, reason: status === 'done' ? undefined : 'because' });
    assert.equal(fin.status, status);
    assert.equal(typeof fin.finishedAt, 'string', `${status} stamps finishedAt`);
    assert.equal(readJsonFile(projectPath('runs', r.runId, 'run.json')).finishedAt, fin.finishedAt);
  }
});

test('finishRun cannot rewrite runId or project, and rejects a bad patch or an unknown run', () => {
  const run = store.createRun(SLUG, RUN_ARGS);
  const file = projectPath('runs', run.runId, 'run.json');
  const before = readText(file);

  const res = store.finishRun(SLUG, run.runId, { runId: 'bad', project: 'other-project', reason: 'note' });
  assert.equal(res.runId, run.runId);
  assert.equal(res.project, SLUG);

  const mid = readText(file);
  assert.throws(() => store.finishRun(SLUG, run.runId, { status: 'paused' }), /status/);
  assert.throws(() => store.finishRun(SLUG, run.runId, { counts: { added: -1 } }), /added/);
  assert.equal(readText(file), mid);
  assert.notEqual(before, mid);

  assert.throws(() => store.finishRun(SLUG, RUN, { status: 'done' }), /no run/);
  assert.throws(() => store.finishRun(SLUG, run.runId, null), TypeError);
});

test('createRun never reuses a run id, even for runs started in the same second', () => {
  const ids = new Set();
  for (let i = 0; i < 3; i++) ids.add(store.createRun(SLUG, RUN_ARGS).runId);
  assert.equal(ids.size, 3);
  for (const id of ids) assert.ok(fs.existsSync(projectPath('runs', id, 'run.json')));
});

test('createRun rejects an invalid run and creates no run directory', () => {
  assert.throws(() => store.createRun(SLUG, { ...RUN_ARGS, job: 'launch' }), /job/);
  assert.throws(() => store.createRun(SLUG, { ...RUN_ARGS, executor: 'either' }), /executor/);
  assert.throws(() => store.createRun(SLUG, { job: 'audit' }), /layers/);
  assert.throws(() => store.createRun(SLUG), Error);
  assert.ok(!fs.existsSync(projectPath('runs')));
});

// ---- raw output ---------------------------------------------------------------------------

test('writeRaw redacts credentials and writes under runs/<runId>/raw/', () => {
  const p = store.writeRaw(SLUG, RUN, 'gitleaks.json', 'found PASSWORD=abcdefghij in .env\nsecond line');
  assert.equal(p, projectPath('runs', RUN, 'raw', 'gitleaks.json'));
  const text = readText(p);
  assert.ok(text.includes('[REDACTED]'));
  assert.ok(!text.includes('abcdefghij'));
  assert.ok(text.includes('second line'));

  store.writeRaw(SLUG, RUN, 'gitleaks.json', 'replaced');
  assert.equal(readText(p), 'replaced');
  assert.equal(store.writeRaw(SLUG, RUN, 'CLAUDE-SECURITY-1.jsonl', '{}').endsWith('CLAUDE-SECURITY-1.jsonl'), true);
});

test('writeRaw takes a bare file name only and a string body', () => {
  const badNames = ['../x.json', 'a/b.json', 'a\\b.json', '..', '.', '', '.hidden', 'c:evil', 'x\0y', ' x', 5, null, undefined];
  for (const bad of badNames) {
    assert.throws(
      () => store.writeRaw(SLUG, RUN, bad, 'x'),
      (e) => e instanceof RangeError && /name/.test(e.message),
      `writeRaw name ${JSON.stringify(bad)}`
    );
  }
  assert.throws(() => store.writeRaw(SLUG, RUN, 'a.json', { a: 1 }), TypeError);
  assert.deepEqual(fs.readdirSync(home), []);
});

// ---- config and scores --------------------------------------------------------------------

test('config.json: readConfig is {} until written, writeConfig replaces it', () => {
  assert.deepEqual(store.readConfig(), {});
  const cfg = { defaultExecutor: 'local', dashboardUrl: 'https://claude.ai/artifact/example' };
  store.writeConfig(cfg);
  assert.deepEqual(readJsonFile(path.join(home, 'config.json')), cfg);
  assert.deepEqual(store.readConfig(), cfg);
  store.writeConfig({ only: 1 });
  assert.deepEqual(store.readConfig(), { only: 1 });
  for (const bad of [[], null, 'x', 3]) assert.throws(() => store.writeConfig(bad), TypeError);
  assert.deepEqual(tmpFiles(home), []);
});

test('scores.jsonl: appendScore adds one line each and stamps at; readScores returns them in order', () => {
  assert.deepEqual(store.readScores(SLUG), []);
  const before = iso();
  const a = store.appendScore(SLUG, { score: 92, open: 3 });
  store.appendScore(SLUG, { score: 95, open: 1, at: '2026-10-22T00:00:00Z' });

  const lines = readText(projectPath('scores.jsonl')).split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[2], '');
  const rows = store.readScores(SLUG);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].score, 92);
  assert.ok(rows[0].at >= before);
  assert.deepEqual(rows[0], a);
  assert.equal(rows[1].at, '2026-10-22T00:00:00Z');
  for (const bad of [null, [], 'x']) assert.throws(() => store.appendScore(SLUG, bad), TypeError);
});

// ---- CLI ----------------------------------------------------------------------------------

const cli = (...args) =>
  spawnSync(process.execPath, [STORE, ...args], { env: { ...process.env, RAMPART_HOME: home }, encoding: 'utf8' });

test('CLI project-save prints the slug of the valid fixture and stores it', () => {
  const r = cli('project-save', fixturePath('project.valid.json'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'example-app\n');
  assert.equal(r.stderr, '');
  assert.equal(store.readProject('example-app').name, 'Example App');

  const before = iso();
  const j = cli('project-save', fixturePath('project.valid.json'), '--json');
  assert.equal(j.status, 0, j.stderr);
  const saved = JSON.parse(j.stdout);
  assert.equal(saved.slug, 'example-app');
  const supplied = fixture('project.valid.json');
  assert.equal(saved.created, supplied.created, 'a created the file brings is kept');
  assert.notEqual(saved.updated, supplied.updated, 'updated is always re-stamped');
  assert.ok(saved.updated >= before && saved.updated <= iso());
});

test('CLI project-save exits 1 on an invalid project or a file that is not JSON, without echoing the file', () => {
  const invalid = path.join(home, 'invalid project.json');
  const bad = project();
  delete bad.name;
  fs.writeFileSync(invalid, JSON.stringify(bad));
  const r = cli('project-save', invalid);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /name/);
  assert.equal(store.readProject(SLUG), null);

  const junk = path.join(home, 'junk.json');
  fs.writeFileSync(junk, 'PASSWORD=abcdefghij {nope');
  const j = cli('project-save', junk);
  assert.equal(j.status, 1);
  assert.ok(!j.stderr.includes('abcdefghij'));
  assert.match(j.stderr, /JSON/);
});

test('CLI projects and project print the store contents, as text or with --json', () => {
  assert.equal(cli('projects').stdout, '');
  assert.deepEqual(JSON.parse(cli('projects', '--json').stdout), []);
  store.writeProject(project());

  assert.equal(cli('projects').stdout, 'example-app\n');
  assert.deepEqual(JSON.parse(cli('projects', '--json').stdout), ['example-app']);

  const text = cli('project', SLUG);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /example-app/);
  assert.match(text.stdout, /Example App/);
  assert.deepEqual(JSON.parse(cli('project', SLUG, '--json').stdout), store.readProject(SLUG));

  const missing = cli('project', 'no-such-project');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /not found/);
});

test('CLI findings lists findings and filters by --status', () => {
  store.upsertFindings(SLUG, [finding(), finding({ id: ID_B, title: 'Second one' })], RUN);
  store.setDisposition(SLUG, ID_B, { status: 'fixed', reason: 'done', by: 'pedro' });

  const all = cli('findings', SLUG);
  assert.equal(all.status, 0, all.stderr);
  assert.equal(all.stdout.trim().split('\n').length, 2);

  const open = cli('findings', SLUG, '--status', 'open');
  assert.equal(open.stdout.trim().split('\n').length, 1);
  assert.ok(open.stdout.includes(ID_A));

  const fixed = JSON.parse(cli('findings', SLUG, '--status=fixed', '--json').stdout);
  assert.deepEqual(fixed.map((f) => f.id), [ID_B]);

  assert.equal(cli('findings', SLUG, '--status', 'bogus').status, 2);
  assert.equal(cli('findings', 'no-such-project').stdout, '');
});

test('CLI disposition records the decision; set-class promotes a finding', () => {
  store.upsertFindings(SLUG, [finding({ class: 'tool' })], RUN);

  const d = cli('disposition', SLUG, ID_A, 'fixed', '--reason', 'patched in abc123', '--by', 'pedro');
  assert.equal(d.status, 0, d.stderr);
  assert.equal(store.readFindings(SLUG)[0].status, 'fixed');
  const rec = store.readDispositions(SLUG)[ID_A];
  assert.equal(rec.reason, 'patched in abc123');
  assert.equal(rec.by, 'pedro');

  const anon = cli('disposition', SLUG, ID_A, 'open', '--reason', 'reopened', '--json');
  assert.equal(anon.status, 0, anon.stderr);
  assert.equal(JSON.parse(anon.stdout).status, 'open');
  assert.ok(store.readDispositions(SLUG)[ID_A].by.length > 0, '--by defaults to the OS user');

  const c = cli('set-class', SLUG, ID_A, 'verified', '--note', 'triage: real key pattern');
  assert.equal(c.status, 0, c.stderr);
  const row = store.readFindings(SLUG)[0];
  assert.equal(row.class, 'verified');
  assert.ok(row.evidence.endsWith('; triage: real key pattern'));
});

test('CLI exits 1 for a bad status, class or unknown finding id, and 2 for usage errors', () => {
  store.upsertFindings(SLUG, [finding()], RUN);
  const before = readText(projectPath('findings.jsonl'));

  assert.equal(cli('disposition', SLUG, ID_A, 'wontfix', '--reason', 'x').status, 1);
  assert.equal(cli('disposition', SLUG, ID_C, 'fixed', '--reason', 'x').status, 1);
  assert.equal(cli('set-class', SLUG, ID_A, 'critical', '--note', 'x').status, 1);
  assert.equal(cli('set-class', SLUG, ID_C, 'verified', '--note', 'x').status, 1);
  assert.equal(readText(projectPath('findings.jsonl')), before);

  const usage = [
    [],
    ['frobnicate'],
    ['constructor'],
    ['projects', 'extra'],
    ['projects', '--nope'],
    ['project'],
    ['project', '../x'],
    ['findings', SLUG, 'extra'],
    ['findings', SLUG, '--status'],
    ['findings', SLUG, '--reason', 'x'],
    ['disposition', SLUG, ID_A, 'fixed'],
    ['disposition', SLUG, ID_A, '--reason', 'x'],
    ['set-class', SLUG, ID_A, 'verified'],
    ['project-save'],
    ['project-save', path.join(home, 'missing.json')],
  ];
  for (const args of usage) {
    const r = cli(...args);
    assert.equal(r.status, 2, `node store.cjs ${args.join(' ')}`);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.length > 0);
  }
  assert.equal(readText(projectPath('findings.jsonl')), before);
});
