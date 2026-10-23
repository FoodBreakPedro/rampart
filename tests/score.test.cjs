const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const store = require('../scripts/store.cjs');
const { layerCredit, scoreSystem, scoreProject, gradeFor, WEIGHTS, CRITICALITY_WEIGHT } = require('../scripts/score.cjs');

const SCORE = path.join(__dirname, '..', 'scripts', 'score.cjs');
const SLUG = 'example-app';
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-23T12:00:00.000Z');
const ago = (days) => new Date(NOW.getTime() - days * DAY).toISOString();

// ---- fixtures built in the test ---------------------------------------------------------------

const ALL_LAYERS = { L1: { cadenceDays: 7 }, L2: { cadenceDays: 30 }, L3: { cadenceDays: 90 }, INFRA: { cadenceDays: 30 } };
const system = (over = {}) => ({
  id: 'web', type: 'web-nextjs', name: 'Web', packs: [], executor: 'either', layers: { ...ALL_LAYERS }, ...over,
});
const COUNTS = { added: 0, updated: 0, unchanged: 0, hardening: 0 };
let runSeq = 0;
const run = (over = {}) => {
  const n = String(++runSeq).padStart(2, '0');
  return {
    runId: `2026-10-23T10-00-${n}Z`, project: SLUG, job: 'audit', layers: Object.keys(ALL_LAYERS), systems: ['web'],
    executor: 'local', status: 'done', startedAt: ago(1), finishedAt: ago(1), counts: COUNTS, ...over,
  };
};
const FRESH = () => [run()]; // every layer of system "web" ran a day ago, inside every cadence window
let findingSeq = 0;
const finding = (over = {}) => {
  const id = (++findingSeq).toString(16).padStart(12, '0');
  return {
    id, project: SLUG, system: 'web', layer: 'L3', source: 'rampart-hunter', ruleId: `rule/${id}`, title: `finding ${id}`,
    severity: 'HIGH', confidence: 'HIGH', class: 'verified', location: { path: 'src/a.ts' }, evidence: 'e', status: 'open', ...over,
  };
};
const score = (findings = [], runs = FRESH(), sys = system()) => scoreSystem(sys, findings, runs, NOW);

// Each test gets a fresh store root; its name contains a space to prove paths round-trip.
const savedHome = process.env.RAMPART_HOME;
let home;
test.beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart score '));
  process.env.RAMPART_HOME = home;
});
test.afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.RAMPART_HOME;
  else process.env.RAMPART_HOME = savedHome;
});

// ---- layerCredit ------------------------------------------------------------------------------

test('layerCredit: inside the cadence window is 1, inside two windows is 0.5, beyond is 0, never run is 0', () => {
  assert.equal(layerCredit(ago(3), 7, NOW), 1);
  assert.equal(layerCredit(ago(10), 7, NOW), 0.5);
  assert.equal(layerCredit(ago(20), 7, NOW), 0);
  assert.equal(layerCredit(null, 7, NOW), 0);
});

test('layerCredit: the window edges belong to the better credit', () => {
  assert.equal(layerCredit(ago(0), 7, NOW), 1, 'just now');
  assert.equal(layerCredit(ago(7), 7, NOW), 1, 'exactly one window');
  assert.equal(layerCredit(new Date(NOW.getTime() - 7 * DAY - 1).toISOString(), 7, NOW), 0.5, 'a millisecond past one window');
  assert.equal(layerCredit(ago(14), 7, NOW), 0.5, 'exactly two windows');
  assert.equal(layerCredit(new Date(NOW.getTime() - 14 * DAY - 1).toISOString(), 7, NOW), 0, 'a millisecond past two windows');
});

test('layerCredit: a timestamp in the future counts as fresh, an unreadable one as never run', () => {
  assert.equal(layerCredit(new Date(NOW.getTime() + DAY).toISOString(), 7, NOW), 1);
  assert.equal(layerCredit('yesterday-ish', 7, NOW), 0);
  assert.equal(layerCredit('', 7, NOW), 0);
  assert.equal(layerCredit(undefined, 7, NOW), 0);
});

test('layerCredit rejects a cadence that is not a positive number and a now that is not a date', () => {
  for (const bad of [0, -7, NaN, Infinity, '7', null, undefined]) {
    assert.throws(() => layerCredit(ago(1), bad, NOW), TypeError, `cadenceDays ${String(bad)}`);
  }
  for (const bad of [new Date('nope'), '2026-10-23', 0, null, undefined]) {
    assert.throws(() => layerCredit(ago(1), 7, bad), TypeError, `now ${String(bad)}`);
  }
});

// ---- gradeFor and the tables ------------------------------------------------------------------

test('gradeFor: A at 90, B at 75, C at 60, D at 40, F below, and the edges belong to the higher grade', () => {
  const cases = [
    [100, 'A'], [90, 'A'], [89.9, 'B'], [75, 'B'], [74.9, 'C'], [60, 'C'], [59.9, 'D'], [40, 'D'], [39.9, 'F'], [0, 'F'],
  ];
  for (const [value, grade] of cases) assert.equal(gradeFor(value), grade, String(value));
  for (const bad of [NaN, '90', null, undefined]) assert.throws(() => gradeFor(bad), TypeError, String(bad));
});

test('WEIGHTS and CRITICALITY_WEIGHT are the spec tables', () => {
  assert.deepEqual(WEIGHTS, {
    verified: { CRITICAL: 25, HIGH: 12, MEDIUM: 5, LOW: 1 },
    tool: { CRITICAL: 12.5, HIGH: 6, MEDIUM: 2.5, LOW: 0.5 },
    hardening: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
  });
  assert.deepEqual(CRITICALITY_WEIGHT, { auth: 3, billing: 3, data: 3, public: 2, internal: 1 });
  assert.ok(Object.isFrozen(WEIGHTS) && Object.isFrozen(WEIGHTS.tool) && Object.isFrozen(CRITICALITY_WEIGHT), 'nothing can retune them at run time');
});

// ---- scoreSystem: the worked examples ---------------------------------------------------------

test('scoreSystem: all layers fresh and no findings is 100 and an A', () => {
  const s = score();
  assert.equal(s.coverage, 40);
  assert.equal(s.findingsScore, 60);
  assert.equal(s.hardening, 0);
  assert.equal(s.score, 100);
  assert.equal(s.grade, 'A');
  assert.deepEqual(Object.keys(s.layers).sort(), ['INFRA', 'L1', 'L2', 'L3']);
});

test('scoreSystem: one verified HIGH and two tool MEDIUM, all fresh, is 40 + (60 - 12 - 2.5 - 2.5) = 83 and a B', () => {
  const s = score([
    finding({ severity: 'HIGH', class: 'verified' }),
    finding({ severity: 'MEDIUM', class: 'tool' }),
    finding({ severity: 'MEDIUM', class: 'tool' }),
  ]);
  assert.equal(s.coverage, 40);
  assert.equal(s.findingsScore, 43);
  assert.equal(s.score, 83);
  assert.equal(s.grade, 'B');
});

test('scoreSystem: four tool HIGH, all fresh, is 40 + (60 - 24) = 76 and a B (the typical Node repo)', () => {
  const s = score(Array.from({ length: 4 }, () => finding({ severity: 'HIGH', class: 'tool' })));
  assert.equal(s.findingsScore, 36);
  assert.equal(s.score, 76);
  assert.equal(s.grade, 'B');
});

test('scoreSystem: four verified HIGH, all fresh, is 40 + 12 = 52 and a D', () => {
  const s = score(Array.from({ length: 4 }, () => finding({ severity: 'HIGH', class: 'verified' })));
  assert.equal(s.findingsScore, 12);
  assert.equal(s.score, 52);
  assert.equal(s.grade, 'D');
});

test('scoreSystem: every class and severity deducts exactly its table entry', () => {
  for (const [cls, bySeverity] of Object.entries(WEIGHTS)) {
    for (const [severity, deduction] of Object.entries(bySeverity)) {
      const s = score([finding({ class: cls, severity })]);
      assert.equal(s.findingsScore, 60 - deduction, `${cls} ${severity}`);
    }
  }
  assert.equal(score([finding({ class: 'verified', severity: 'CRITICAL' })]).findingsScore, 35);
  assert.equal(score([finding({ class: 'tool', severity: 'CRITICAL' })]).findingsScore, 47.5);
  assert.equal(score([finding({ class: 'tool', severity: 'LOW' })]).findingsScore, 59.5);
});

test('scoreSystem: the findings score floors at 0, so the system still has its coverage points', () => {
  const s = score([
    finding({ severity: 'CRITICAL' }), finding({ severity: 'CRITICAL' }), finding({ severity: 'CRITICAL' }),
  ]);
  assert.equal(s.findingsScore, 0);
  assert.equal(s.score, 40);
  assert.equal(s.grade, 'D');
});

// ---- scoreSystem: which findings count --------------------------------------------------------

test('scoreSystem: only open and regressed findings of this system are deducted', () => {
  const counted = [finding({ status: 'open' }), finding({ status: 'regressed' })];
  const ignored = [
    finding({ status: 'fixed' }), finding({ status: 'false_positive' }), finding({ status: 'accepted_risk' }),
    finding({ system: 'db' }), finding({ system: 'web-2' }), finding({ system: 'WEB' }),
  ];
  const s = score([...ignored, ...counted]);
  assert.equal(s.findingsScore, 60 - 12 - 12);
  assert.equal(score(ignored).findingsScore, 60);
});

test('scoreSystem: hardening findings are counted per system, never deducted, and only while open or regressed', () => {
  const s = score([
    finding({ class: 'hardening', severity: 'MEDIUM', status: 'open' }),
    finding({ class: 'hardening', severity: 'CRITICAL', status: 'regressed' }),
    finding({ class: 'hardening', severity: 'LOW', status: 'fixed' }),
    finding({ class: 'hardening', severity: 'LOW', status: 'accepted_risk' }),
    finding({ class: 'hardening', severity: 'LOW', status: 'false_positive' }),
    finding({ class: 'hardening', severity: 'LOW', system: 'db' }),
    finding({ class: 'tool', severity: 'LOW' }),
    finding({ class: 'verified', severity: 'LOW' }),
  ]);
  assert.equal(s.hardening, 2);
  assert.equal(s.findingsScore, 60 - 0.5 - 1, 'only the tool and verified LOW findings cost points');
  assert.equal(s.score, 98.5);
});

test('scoreSystem: a finding with a class or severity outside the tables is an error, not a free pass', () => {
  assert.throws(() => score([finding({ class: 'maybe' })]), /class|severity/);
  assert.throws(() => score([finding({ severity: 'SEVERE' })]), /class|severity/);
  assert.throws(() => score([finding({ class: 'constructor' })]), /class|severity/);
});

// ---- scoreSystem: coverage --------------------------------------------------------------------

test('scoreSystem: coverage is 40 times the mean credit of the system\'s own layers', () => {
  const sys = system({ layers: { L1: { cadenceDays: 7 }, L2: { cadenceDays: 30 }, L3: { cadenceDays: 90 } } });
  const runs = [
    run({ layers: ['L1'], finishedAt: ago(3) }), // 3 of 7 days: 1
    run({ layers: ['L2'], finishedAt: ago(45) }), // 45 of 30 days: 0.5
    // L3 never ran: 0
  ];
  const s = scoreSystem(sys, [], runs, NOW);
  assert.deepEqual(Object.keys(s.layers), ['L1', 'L2', 'L3']);
  assert.deepEqual(s.layers.L1, { lastRun: ago(3), nextDue: ago(3 - 7), credit: 1 });
  assert.deepEqual(s.layers.L2, { lastRun: ago(45), nextDue: ago(45 - 30), credit: 0.5 });
  assert.deepEqual(s.layers.L3, { lastRun: null, nextDue: null, credit: 0 });
  assert.equal(s.coverage, 20);
  assert.equal(s.score, 80);
  assert.equal(s.grade, 'B');
});

test('scoreSystem: coverage, findings and score are rounded to one decimal', () => {
  const sys = system({ layers: { L1: { cadenceDays: 7 }, L2: { cadenceDays: 30 }, L3: { cadenceDays: 90 } } });
  const runs = [run({ layers: ['L1', 'L2'], finishedAt: ago(1) }), run({ layers: ['L3'], finishedAt: ago(120) })];
  const s = scoreSystem(sys, [], runs, NOW);
  assert.equal(s.layers.L3.credit, 0.5);
  assert.equal(s.coverage, 33.3);
  assert.equal(s.score, 93.3);
  assert.equal(s.grade, 'A');
  assert.equal(scoreSystem(sys, [finding({ class: 'tool', severity: 'LOW' })], runs, NOW).score, 92.8);
});

test('scoreSystem: a system with no layers has nothing missing, so full coverage', () => {
  for (const sys of [system({ layers: {} }), (({ layers, ...rest }) => rest)(system())]) {
    const s = scoreSystem(sys, [], [], NOW);
    assert.equal(s.coverage, 40);
    assert.equal(s.score, 100);
    assert.deepEqual(s.layers, {});
  }
});

test('scoreSystem: only the layers the system declares take part, whatever the runs cover', () => {
  const sys = system({ layers: { L1: { cadenceDays: 7 } } });
  const s = scoreSystem(sys, [], [run({ layers: ['L1', 'L3', 'INFRA'] })], NOW);
  assert.deepEqual(Object.keys(s.layers), ['L1']);
  assert.equal(s.coverage, 40);
});

test('scoreSystem: a run counts for a layer only when it is done and names both the system and the layer', () => {
  const sys = system({ layers: { L1: { cadenceDays: 7 } } });
  const credit = (runs) => scoreSystem(sys, [], runs, NOW).layers.L1;
  assert.equal(credit([run({ layers: ['L1'] })]).credit, 1, 'the baseline counts');
  for (const status of ['running', 'skipped', 'failed']) {
    assert.deepEqual(credit([run({ layers: ['L1'], status })]), { lastRun: null, nextDue: null, credit: 0 }, status);
  }
  assert.equal(credit([run({ layers: ['L1'], systems: ['db'] })]).credit, 0, 'another system');
  assert.equal(credit([run({ layers: ['L1'], systems: ['web-2', 'WEB'] })]).credit, 0, 'a lookalike system');
  assert.equal(credit([run({ layers: ['L2', 'L3', 'INFRA'] })]).credit, 0, 'another layer');
  assert.equal(credit([run({ layers: [] })]).credit, 0, 'no layers');
  assert.equal(credit([run({ layers: ['L1'], systems: ['db', 'web'] })]).credit, 1, 'one of several systems');
  assert.equal(credit([]).credit, 0);
});

test('scoreSystem: the latest qualifying run sets lastRun, whatever order the runs arrive in, and a failure after it changes nothing', () => {
  const sys = system({ layers: { L1: { cadenceDays: 7 } } });
  const runs = [
    run({ layers: ['L1'], finishedAt: ago(2) }),
    run({ layers: ['L1'], finishedAt: ago(30) }),
    run({ layers: ['L1'], finishedAt: ago(5) }),
    run({ layers: ['L1'], finishedAt: ago(0.5), status: 'failed' }),
    run({ layers: ['L1'], finishedAt: ago(0.25), systems: ['db'] }),
  ];
  for (const order of [runs, [...runs].reverse()]) {
    const l1 = scoreSystem(sys, [], order, NOW).layers.L1;
    assert.equal(l1.lastRun, ago(2));
    assert.equal(l1.nextDue, ago(2 - 7));
    assert.equal(l1.credit, 1);
  }
});

test('scoreSystem: lastRun is finishedAt, else startedAt; a run with no readable time is ignored', () => {
  const sys = system({ layers: { L1: { cadenceDays: 7 } } });
  const l1 = (r) => scoreSystem(sys, [], [r], NOW).layers.L1;
  const noFinish = run({ layers: ['L1'], startedAt: ago(4) });
  delete noFinish.finishedAt;
  assert.equal(l1(noFinish).lastRun, ago(4));
  assert.equal(l1(run({ layers: ['L1'], startedAt: ago(20), finishedAt: ago(1) })).lastRun, ago(1), 'finishedAt wins over startedAt');
  assert.equal(l1(run({ layers: ['L1'], startedAt: 'garbage', finishedAt: 'garbage' })).lastRun, null);
  assert.equal(l1(run({ layers: ['L1'], startedAt: ago(4), finishedAt: '' })).lastRun, ago(4), 'an empty finishedAt falls back');
});

test('scoreSystem: nextDue is lastRun plus the cadence, as an ISO string, even when it is already past', () => {
  const sys = system({ layers: { L1: { cadenceDays: 7 }, L2: { cadenceDays: 30 } } });
  const runs = [run({ layers: ['L1'], finishedAt: '2026-10-01T08:30:00Z' }), run({ layers: ['L2'], finishedAt: '2026-10-20T00:00:00.000Z' })];
  const s = scoreSystem(sys, [], runs, NOW);
  assert.equal(s.layers.L1.lastRun, '2026-10-01T08:30:00Z', 'lastRun is the stored string');
  assert.equal(s.layers.L1.nextDue, '2026-10-08T08:30:00.000Z');
  assert.equal(s.layers.L1.credit, 0, '22 days since a 7-day cadence');
  assert.equal(s.layers.L2.nextDue, '2026-11-19T00:00:00.000Z');
});

test('scoreSystem: a layer with a bad cadence is an error that names the system and layer', () => {
  const sys = system({ id: 'billing', layers: { L1: { cadenceDays: 0 } } });
  assert.throws(() => scoreSystem(sys, [], [], NOW), /billing.*L1.*cadenceDays/);
  assert.throws(() => scoreSystem(system({ layers: { L2: {} } }), [], [], NOW), /L2.*cadenceDays/);
  assert.throws(() => scoreSystem(system(), [], [], 'now'), TypeError);
});

test('scoreSystem does not change what it is given', () => {
  const sys = system();
  const findings = [finding(), finding({ class: 'hardening' })];
  const runs = [run()];
  const before = JSON.stringify([sys, findings, runs]);
  score(findings, runs, sys);
  assert.equal(JSON.stringify([sys, findings, runs]), before);
});

// ---- scoreProject -----------------------------------------------------------------------------

const project = (systems, over = {}) => ({
  slug: SLUG, name: 'Example', criticality: 'high', ownerAttestation: { statement: 's', by: 'b', at: 'a' },
  defaultExecutor: 'local', cloudAllowed: false, systems, ...over,
});
const noLayers = (id, criticality, extra = {}) => system({ id, layers: {}, ...(criticality ? { criticality } : {}), ...extra });
// A system with no layers scores 40 + 60 - deductions: pass the deduction wanted as verified findings.
const costing = (id, points) => {
  const out = [];
  let left = points;
  for (const [severity, weight] of [['CRITICAL', 25], ['HIGH', 12], ['MEDIUM', 5], ['LOW', 1]]) {
    for (; left >= weight; left -= weight) out.push(finding({ system: id, severity, class: 'verified' }));
  }
  assert.equal(left, 0);
  return out;
};

test('scoreProject: the project score is the mean of its systems weighted by criticality: auth 50 and public 100 is 70', () => {
  const p = project([noLayers('login', 'auth'), noLayers('site', 'public')]);
  const result = scoreProject(p, costing('login', 50), [], NOW);
  assert.equal(result.systems.login.score, 50);
  assert.equal(result.systems.site.score, 100);
  assert.equal(result.score, 70);
  assert.equal(result.grade, 'C');
  assert.equal(result.trend, null);
  assert.deepEqual(Object.keys(result.systems), ['login', 'site']);
});

test('scoreProject: auth, billing and data weigh 3, public 2, internal 1, and a system with no criticality weighs as public', () => {
  const at = (criticality, other) => {
    // The system under test scores 50, a public companion 100: 50w + 200 over w + 2.
    const p = project([noLayers('s', criticality), noLayers('other', other)]);
    return scoreProject(p, costing('s', 50), [], NOW).score;
  };
  assert.equal(at('auth', 'public'), 70);
  assert.equal(at('billing', 'public'), 70);
  assert.equal(at('data', 'public'), 70);
  assert.equal(at('public', 'public'), 75);
  assert.equal(at(undefined, 'public'), 75, 'no criticality is public');
  assert.equal(at('internal', 'public'), 83.3); // (50 + 200) / 3
  assert.equal(at('mystery', 'public'), 75, 'an unknown tag is public too');
});

test('scoreProject: the weighted mean is rounded to one decimal', () => {
  const p = project([noLayers('a', 'auth'), noLayers('b', 'public'), noLayers('c', 'internal')]);
  const result = scoreProject(p, costing('c', 50), [], NOW); // (100 * 3 + 100 * 2 + 50 * 1) / 6
  assert.equal(result.score, 91.7);
  assert.equal(result.grade, 'A');
});

test('scoreProject: the grade is of the rounded score, so a sheet never shows 90.0 with a B', () => {
  // a and b score 90 (no layers, 10 points of deductions); c scores 89.8 (credits 1, 1, 0.5 and 3.5 points of deductions).
  const c = system({ id: 'c', criticality: 'internal', layers: { L1: { cadenceDays: 7 }, L2: { cadenceDays: 30 }, L3: { cadenceDays: 90 } } });
  const p = project([noLayers('a', 'auth'), noLayers('b', 'public'), c]);
  const findings = [
    ...costing('a', 10), ...costing('b', 10),
    finding({ system: 'c', class: 'tool', severity: 'MEDIUM' }), finding({ system: 'c', class: 'verified', severity: 'LOW' }),
  ];
  const runs = [run({ systems: ['c'], layers: ['L1', 'L2'] }), run({ systems: ['c'], layers: ['L3'], finishedAt: ago(120) })];
  const result = scoreProject(p, findings, runs, NOW);
  assert.deepEqual([result.systems.a.score, result.systems.b.score, result.systems.c.score], [90, 90, 89.8]);
  assert.equal(result.score, 90); // 539.8 / 6 = 89.97
  assert.equal(result.grade, 'A');
});

test('scoreProject: each system is scored on its own findings and its own runs', () => {
  const p = project([
    system({ id: 'web', criticality: 'public', layers: { L1: { cadenceDays: 7 } } }),
    system({ id: 'db', criticality: 'data', layers: { L1: { cadenceDays: 7 } } }),
  ]);
  const findings = [finding({ system: 'db', severity: 'HIGH' })];
  const runs = [run({ systems: ['web'], layers: ['L1'] })];
  const result = scoreProject(p, findings, runs, NOW);
  assert.deepEqual(result.systems.web, scoreSystem(p.systems[0], findings, runs, NOW));
  assert.deepEqual(result.systems.db, scoreSystem(p.systems[1], findings, runs, NOW));
  assert.equal(result.systems.web.score, 100);
  assert.equal(result.systems.db.score, 48, 'never run: no coverage, one verified HIGH');
  assert.equal(result.score, 68.8); // (100 * 2 + 48 * 3) / 5
  assert.equal(result.grade, 'C');
});

test('scoreProject: a project with no systems scores 0 and an F, not NaN', () => {
  const result = scoreProject(project([]), [], [], NOW);
  assert.deepEqual(result, { score: 0, grade: 'F', systems: {}, trend: null });
});

// ---- scoreProject: trend ----------------------------------------------------------------------

const projectScore = (score, over = {}) => store.appendScore(SLUG, { kind: 'project', score, grade: gradeFor(score), ...over });
const scoresFile = () => path.join(home, 'projects', SLUG, 'scores.jsonl');

test('scoreProject: trend is this score minus the latest project snapshot, and null before there is one', () => {
  const p = project([noLayers('site', 'public')]); // scores 100
  assert.equal(scoreProject(p, [], [], NOW).trend, null);

  projectScore(60);
  assert.equal(scoreProject(p, [], [], NOW).trend, 40);

  projectScore(40);
  projectScore(65);
  assert.equal(scoreProject(p, [], [], NOW).trend, 35, 'the latest snapshot, not the first or the best');

  projectScore(100);
  assert.equal(scoreProject(p, [], [], NOW).trend, 0);
  projectScore(100.0);
  const worse = scoreProject(p, costing('site', 12), [], NOW);
  assert.equal(worse.score, 88);
  assert.equal(worse.trend, -12);
});

test('scoreProject: headers snapshots and unreadable ones are not project snapshots', () => {
  const p = project([noLayers('site', 'public')]);
  projectScore(70);
  store.appendScore(SLUG, { kind: 'headers', system: 'site', score: 20, grade: 'F' });
  store.appendScore(SLUG, { score: 5 });
  store.appendScore(SLUG, { kind: 'project', score: '99' });
  store.appendScore(SLUG, { kind: 'project', score: null });
  assert.equal(scoreProject(p, [], [], NOW).trend, 30);

  fs.rmSync(scoresFile());
  store.appendScore(SLUG, { kind: 'headers', system: 'site', score: 20, grade: 'F' });
  assert.equal(scoreProject(p, [], [], NOW).trend, null, 'only a headers snapshot: still no project history');
});

test('scoreProject: the trend is rounded to one decimal, and scoring writes nothing', () => {
  const p = project([noLayers('site', 'public')]);
  projectScore(99.9);
  assert.equal(scoreProject(p, [], [], NOW).trend, 0.1);
  projectScore(87.3);
  assert.equal(scoreProject(p, [], [], NOW).trend, 12.7);
  const before = fs.readFileSync(scoresFile(), 'utf8');
  scoreProject(p, [], [], NOW);
  assert.equal(fs.readFileSync(scoresFile(), 'utf8'), before);
});

// ---- the CLI ----------------------------------------------------------------------------------

const cli = (...args) => spawnSync(process.execPath, [SCORE, ...args], { env: { ...process.env, RAMPART_HOME: home }, encoding: 'utf8' });
const snapshots = () => (fs.existsSync(scoresFile()) ? fs.readFileSync(scoresFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const CANARY = 'CANARY-do-not-print-7f3a';

// Two systems: "web" (public, L1 and L2) and "db" (data, INFRA). Real runs and findings through the store, stamped now.
function seed({ withFinding = false } = {}) {
  store.writeProject(project([
    system({ id: 'web', criticality: 'public', layers: { L1: { cadenceDays: 7 }, L2: { cadenceDays: 30 } } }),
    system({ id: 'db', criticality: 'data', layers: { INFRA: { cadenceDays: 30 } } }),
  ]));
  const l1 = store.createRun(SLUG, { job: 'audit', layers: ['L1'], systems: ['web'], executor: 'local' });
  store.finishRun(SLUG, l1.runId, { status: 'done' });
  if (withFinding) {
    const f = finding({ system: 'db', layer: 'INFRA', source: 'infra-probe', title: CANARY, evidence: CANARY, ruleId: `rule/${CANARY}` });
    store.upsertFindings(SLUG, [f, finding({ system: 'web', class: 'hardening', severity: 'LOW', title: CANARY })], l1.runId);
  }
  return l1;
}

test('CLI prints the sheet, appends one project snapshot, and exits 0', () => {
  const l1 = seed({ withFinding: true });
  const r = cli(SLUG);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');

  // web: L1 fresh (1), L2 never run (0) -> coverage 20, no deductions; db: INFRA never run -> coverage 0, one verified HIGH.
  // project = (80 * 2 + 48 * 3) / 5 = 60.8
  const lines = r.stdout.split('\n');
  assert.match(lines[0], /^example-app\b.*\bgrade C\b.*\bscore 60\.8\b.*\btrend none\b/);
  const row = (id) => lines.find((l) => l.startsWith(id));
  assert.match(row('web'), /^web\s+B\s+80\.0\s+20\.0\s+60\.0\s+1\s*$/);
  assert.match(row('db'), /^db\s+D\s+48\.0\s+0\.0\s+48\.0\s+0\s*$/);
  assert.match(lines.find((l) => /^SYSTEM\s+GRADE\s+SCORE\s+COVERAGE\s+FINDINGS\s+HARDENING/.test(l)), /^SYSTEM/);

  const finished = store.readRuns(SLUG).find((x) => x.runId === l1.runId).finishedAt;
  const day = finished.slice(0, 10);
  const nextWeek = new Date(Date.parse(finished) + 7 * DAY).toISOString().slice(0, 10);
  assert.ok(lines.some((l) => new RegExp(`^\\s+L1\\s+last ${day}\\s+next due ${nextWeek}\\s+credit 1\\s*$`).test(l)), r.stdout);
  assert.ok(lines.some((l) => /^\s+L2\s+last never\s+next due now\s+credit 0\s*$/.test(l)), r.stdout);
  assert.ok(lines.some((l) => /^\s+INFRA\s+last never\s+next due now\s+credit 0\s*$/.test(l)), r.stdout);

  const saved = snapshots();
  assert.equal(saved.length, 1);
  assert.deepEqual(Object.keys(saved[0]).sort(), ['at', 'grade', 'kind', 'score', 'trend']);
  assert.equal(saved[0].kind, 'project');
  assert.equal(saved[0].score, 60.8);
  assert.equal(saved[0].grade, 'C');
  assert.equal(saved[0].trend, null, 'the first snapshot has no trend');
  assert.ok(Math.abs(Date.now() - Date.parse(saved[0].at)) < 60000);
});

test('CLI never prints finding text, only counts', () => {
  seed({ withFinding: true });
  for (const args of [[SLUG], [SLUG, '--json'], [SLUG, '--no-save']]) {
    const r = cli(...args);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(CANARY) && !r.stderr.includes(CANARY), args.join(' '));
    assert.ok(!r.stdout.includes('rule/') && !r.stdout.includes('src/a.ts'), 'no rule ids or locations either');
  }
});

test('CLI --json prints the project result, and still saves', () => {
  seed();
  const r = cli(SLUG, '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.project, SLUG);
  assert.equal(typeof out.at, 'string');
  assert.equal(out.score, 68); // web 80 (L1 fresh, L2 never run), db 60 (INFRA never run, no findings): (80 * 2 + 60 * 3) / 5
  assert.deepEqual(Object.keys(out.systems), ['web', 'db']);
  assert.equal(out.trend, null);
  assert.equal(out.systems.web.layers.L2.lastRun, null);
  assert.equal(snapshots().length, 1);
  assert.equal(snapshots()[0].at, out.at);
});

test('CLI --no-save leaves scores.jsonl alone', () => {
  seed();
  const r = cli(SLUG, '--no-save');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('example-app'));
  assert.equal(fs.existsSync(scoresFile()), false);

  cli(SLUG);
  const before = fs.readFileSync(scoresFile(), 'utf8');
  assert.equal(cli(SLUG, '--no-save', '--json').status, 0);
  assert.equal(fs.readFileSync(scoresFile(), 'utf8'), before);
});

test('CLI: the trend is against the previous project snapshot, taken before this one is saved, and headers snapshots do not count', () => {
  seed();
  assert.equal(JSON.parse(cli(SLUG, '--json').stdout).trend, null);
  assert.equal(JSON.parse(cli(SLUG, '--json').stdout).trend, 0, 'the second run compares with the first');

  store.appendScore(SLUG, { kind: 'headers', system: 'web', score: 10, grade: 'F' });
  store.upsertFindings(SLUG, [finding({ system: 'db', layer: 'INFRA' })], '2026-10-23T18-02-11Z');
  const worse = JSON.parse(cli(SLUG, '--json').stdout);
  assert.equal(worse.score, 60.8); // db drops 60 -> 48: (80 * 2 + 48 * 3) / 5
  assert.equal(worse.trend, -7.2);
  assert.equal(snapshots().filter((s) => s.kind === 'project').length, 3);
  assert.equal(snapshots().filter((s) => s.kind === 'project').pop().trend, -7.2, 'I6: the snapshot keeps the trend it was saved with');

  const text = cli(SLUG, '--no-save').stdout.split('\n')[0];
  assert.match(text, /\btrend 0\.0\b/);
  store.upsertFindings(SLUG, [finding({ system: 'db', layer: 'INFRA', ruleId: 'rule/second' })], '2026-10-23T18-02-11Z');
  assert.match(cli(SLUG, '--no-save').stdout.split('\n')[0], /\btrend -7\.2\b/);
});

test('CLI exits 2 for a missing project, a bad slug and bad arguments, writing nothing', () => {
  seed();
  const cases = [
    ['no-such-project'], ['Bad Slug!'], ['..'], [], [SLUG, 'extra'], [SLUG, '--bogus'], ['--json'], [SLUG, '--json=1'],
  ];
  for (const args of cases) {
    const r = cli(...args);
    assert.equal(r.status, 2, `score ${args.join(' ')}: ${r.stderr}`);
    assert.equal(r.stdout, '', args.join(' '));
    assert.match(r.stderr, /^score: /, args.join(' '));
  }
  assert.equal(fs.existsSync(scoresFile()), false);
  assert.ok(!fs.existsSync(path.join(home, 'projects', 'no-such-project')), 'a typo creates no project directory');
});

test('CLI exits 1 on a corrupt store, with the file named and nothing saved', () => {
  seed();
  fs.writeFileSync(path.join(home, 'projects', SLUG, 'findings.jsonl'), `{"secret":"sk-ant-abcdefghijklmnop"\n`);
  const r = cli(SLUG);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^score: findings\.jsonl line 1 is not valid JSON/);
  assert.ok(!r.stderr.includes('sk-ant'));
  assert.equal(fs.existsSync(scoresFile()), false);
});

test('CLI scores a project with no systems as 0 / F instead of failing', () => {
  store.writeProject(project([]));
  const r = cli(SLUG, '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([JSON.parse(r.stdout).score, JSON.parse(r.stdout).grade], [0, 'F']);
  assert.match(cli(SLUG, '--no-save').stdout, /no systems/);
});
