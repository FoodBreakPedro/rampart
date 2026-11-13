const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validate, loadSchema } = require('../scripts/lib/validate.cjs');

// scripts/progress.cjs: the job progress document the dashboard's activity panel reads (skills/rampart/specs/progress.md).

const SCRIPT = path.join(__dirname, '..', 'scripts', 'progress.cjs');
const SLUG = 'example-app';
const RUN = '2026-10-23T18-02-11Z';
const T0 = '2026-10-23T18:00:00.000Z';
const T1 = '2026-10-23T18:05:00.000Z';

let home;
test.beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart-progress-'));
  process.env.RAMPART_HOME = home;
  const dir = path.join(home, 'projects', SLUG);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    slug: SLUG,
    name: 'Example App',
    systems: [
      { id: 'mobile', type: 'mobile-expo', name: 'Expo app', repo: { remote: 'github.com/o/r' }, layers: { L1: { cadenceDays: 7 } } },
      { id: 'site', type: 'static-site', name: 'Site', repo: { remote: 'github.com/o/s' }, live: { url: 'https://example.invalid/' }, layers: { L1: { cadenceDays: 7 } } },
      { id: 'db', type: 'supabase', name: 'Database', host: { ssh: 'me@box' }, layers: { INFRA: { cadenceDays: 30 } } },
    ],
  }));
});
test.afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.RAMPART_HOME;
});

const progress = () => {
  delete require.cache[require.resolve('../scripts/progress.cjs')];
  return require('../scripts/progress.cjs');
};
const valid = (doc) => assert.deepEqual(validate(loadSchema('progress'), doc).errors, []);
const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, RAMPART_HOME: home }, encoding: 'utf8' });

test('start: L1 plans the checks each system has, per system, then triage and score; --live adds the dashboard update', () => {
  const p = progress();
  const doc = p.startPlan(SLUG, { job: 'audit', layer: 'L1', live: true }, T0);
  valid(doc);
  assert.deepEqual(doc.steps.map((s) => s.id), ['secrets:mobile', 'deps:mobile', 'secrets:site', 'deps:site', 'headers:site', 'triage', 'score', 'sync']);
  assert.ok(doc.steps.every((s) => s.status === 'pending'));
  assert.match(doc.steps[0].label, /^Looking for leaked keys and passwords: Expo app$/, 'with several systems the label names the system');
  assert.equal(doc.state, 'running');
  assert.equal(doc.title, 'Basic checks: Example App');
  assert.deepEqual(doc.overall, { done: 0, total: 8, percent: 0 });
  assert.equal(doc.staleAfterSec, 900);
  const one = p.startPlan(SLUG, { job: 'audit', layer: 'L1', system: 'mobile' }, T0);
  assert.deepEqual(one.steps.map((s) => s.id), ['secrets:mobile', 'deps:mobile', 'triage', 'score']);
  assert.equal(one.steps[0].label, 'Looking for leaked keys and passwords', 'one system: no system name');
  assert.equal(one.title, 'Basic checks: Expo app');
});

test('start: the hunt, server, inventory and verify step lists are fixed', () => {
  const p = progress();
  const ids = (opts) => p.startPlan(SLUG, opts, T0).steps.map((s) => s.id);
  assert.deepEqual(ids({ job: 'audit', layer: 'L3', system: 'mobile', runId: RUN }), ['plan', 'hunt', 'verify', 'assemble', 'report', 'score']);
  assert.deepEqual(ids({ job: 'audit', layer: 'L2', system: 'mobile', live: true }), ['plan', 'hunt', 'verify', 'assemble', 'report', 'score', 'sync']);
  assert.deepEqual(ids({ job: 'audit', layer: 'INFRA', system: 'db' }), ['probe', 'compare', 'verify', 'assemble', 'report', 'score']);
  assert.deepEqual(ids({ job: 'inventory' }), ['scan', 'map', 'questions', 'save', 'score']);
  assert.deepEqual(ids({ job: 'verify' }), ['plan', 'verify', 'assemble', 'score']);
  const doc = p.readProgress(SLUG);
  valid(doc);
  assert.equal(doc.job, 'verify');
  assert.equal(doc.layer, null);
});

test('start: refuses a bad job, layer, slug, system, run id or job id', () => {
  const p = progress();
  for (const [slug, opts] of [
    [SLUG, { job: 'deploy' }],
    [SLUG, { job: 'audit' }],
    [SLUG, { job: 'audit', layer: 'L4' }],
    ['../x', { job: 'inventory' }],
    [SLUG, { job: 'audit', layer: 'L1', system: 'a/b' }],
    [SLUG, { job: 'audit', layer: 'L3', runId: '../../etc' }],
    [SLUG, { job: 'audit', layer: 'L3', jobId: 'job-1' }],
  ]) assert.throws(() => p.startPlan(slug, opts, T0), p.UsageError, JSON.stringify(opts));
});

test('step: running stamps startedAt, done stamps finishedAt, counts and a redacted one-line note are kept; percent credits counts', () => {
  const p = progress();
  p.startPlan(SLUG, { job: 'audit', layer: 'L3', system: 'mobile' }, T0);
  p.markStep(SLUG, 'plan', { status: 'done' }, T0);
  let doc = p.markStep(SLUG, 'hunt', { status: 'running', done: 6, total: 24 }, T1);
  valid(doc);
  const hunt = doc.steps.find((s) => s.id === 'hunt');
  assert.equal(hunt.startedAt, T1);
  assert.deepEqual([hunt.done, hunt.total, hunt.unit], [6, 24, 'AI reviewers']);
  assert.equal(doc.updatedAt, T1);
  assert.deepEqual(doc.overall, { done: 1, total: 6, percent: Math.round(((1 + 6 / 24) / 6) * 100) });
  doc = p.markStep(SLUG, 'report', { status: 'skipped', note: 'token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 in\na reason' }, T1);
  const report = doc.steps.find((s) => s.id === 'report');
  assert.equal(report.finishedAt, T1);
  assert.doesNotMatch(report.note, /sk-ant-api03-abcdefghij/, 'the note is redacted');
  assert.doesNotMatch(report.note, /\n/);
  assert.throws(() => p.markStep(SLUG, 'nope', { status: 'done' }, T1), p.UsageError);
  assert.throws(() => p.markStep(SLUG, 'hunt', { status: 'finished' }, T1), p.UsageError);
  assert.throws(() => p.markStep(SLUG, 'hunt', { done: -1 }, T1), p.UsageError);
  assert.throws(() => p.markStep(SLUG, 'hunt', { note: 'x'.repeat(10) }, 'not a time'), TypeError);
  assert.ok(p.markStep(SLUG, 'hunt', { note: 'y'.repeat(500) }, T1).steps.find((s) => s.id === 'hunt').note.length <= 200);
});

test('step: no plan yet is a usage error, not a crash', () => {
  const p = progress();
  assert.throws(() => p.markStep(SLUG, 'plan', { status: 'done' }, T0), /no progress plan/);
});

// A run directory with hunters planned in units.json, some candidate files and some votes.
function seedRun({ hunters, candidates = {}, votes = [], extra = {} }) {
  const dir = path.join(home, 'projects', SLUG, 'runs', RUN);
  fs.mkdirSync(path.join(dir, 'candidates'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'votes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'units.json'), JSON.stringify({ layer: 'L3', system: 'mobile', hunters, ...extra }));
  for (const [name, body] of Object.entries(candidates)) fs.writeFileSync(path.join(dir, 'candidates', `${name}.json`), typeof body === 'string' ? body : JSON.stringify(body));
  for (const name of votes) fs.writeFileSync(path.join(dir, 'votes', name), '{}');
  return dir;
}

test('hunt: counts hunters by candidate file, possible problems by entry, and double-checked ones by vote file name', () => {
  // Keys hold a "/" that fileKey turns into "+", and the hunters carry the fields the reshaped planner adds.
  seedRun({
    hunters: [
      { key: 'src/db__sql-injection', units: ['src/db'], classIds: ['sql-injection'] },
      { key: 'src/db__ssrf' },
      { key: 'web__xss' },
      { key: 'docs__secrets' },
      { nokey: true },
      'junk',
    ],
    candidates: {
      'src+db__sql-injection': [{ ref: 'c1' }, { ref: 'c2' }],
      'src+db__ssrf': [],
      web__xss: '{not json',
      'stray__file': [{ ref: 'c1' }],
    },
    votes: ['src+db__sql-injection__c1__1.json', 'src+db__sql-injection__c1__2.json', 'stray__file__c1__1.json', 'unrelated__c9__1.json', 'bad-name.json'],
  });
  const p = progress();
  const c = p.huntCounts(SLUG, RUN);
  assert.deepEqual(c.hunters, { done: 3, total: 4 }, 'a candidate file that is not valid JSON still means its hunter returned');
  assert.deepEqual(c.verify, { done: 2, total: 3 });
  p.startPlan(SLUG, { job: 'audit', layer: 'L3', system: 'mobile', runId: RUN }, T0);
  const doc = p.applyHunt(SLUG, RUN, T1);
  valid(doc);
  const hunt = doc.steps.find((s) => s.id === 'hunt');
  assert.deepEqual([hunt.status, hunt.done, hunt.total], ['running', 3, 4]);
  const verify = doc.steps.find((s) => s.id === 'verify');
  assert.deepEqual([verify.status, verify.done, verify.total], ['running', 2, 3]);
});

test('hunt: the 0.5.0 run layout: group hunters, candidates named by key, refs up to c20, units skipped as unchanged or too large', () => {
  const twenty = Array.from({ length: 20 }, (_, i) => ({ ref: `c${i + 1}` }));
  seedRun({
    hunters: [
      { key: 'g01__b1', group: 'g01', bundle: 'b1', units: ['src/api'], classIds: ['authz-scoping', 'ssrf'] },
      { key: 'g01__b2', group: 'g01', bundle: 'b2', units: ['src/api'], classIds: ['xss'] },
      { key: 'g02__b1', group: 'g02', bundle: 'b1', units: ['src/web'], classIds: ['authz-scoping', 'ssrf'] },
    ],
    candidates: { g01__b1: twenty, g02__b1: [] },
    votes: ['g01__b1__c1__1.json', 'g01__b1__c1__2.json', 'g01__b1__c20__1.json', 'g01__b1__c21__1.json', 'g01__b1__c0__1.json', 'g01__b1__c2__0.json'],
    extra: {
      units: [
        { id: 'src/api' }, { id: 'src/web' },
        { id: 'docs', status: 'unchanged', coveredBy: '2026-10-01T00-00-00Z' }, { id: 'lib', status: 'unchanged' },
        { id: 'vendor', status: 'not-hunted' },
      ],
    },
  });
  const p = progress();
  const c = p.huntCounts(SLUG, RUN);
  assert.deepEqual(c.hunters, { done: 2, total: 3 });
  assert.deepEqual(c.verify, { done: 2, total: 20 }, 'c1 and c20 are double-checked; c21, c0 and a vote numbered 0 are not hunt-io names');
  assert.deepEqual(c.skipped, { unchanged: 2, notHunted: 1 });
  p.startPlan(SLUG, { job: 'audit', layer: 'L3', system: 'mobile', runId: RUN }, T0);
  const doc = p.applyHunt(SLUG, RUN, T1);
  valid(doc);
  const hunt = doc.steps.find((s) => s.id === 'hunt');
  assert.equal(hunt.label, 'AI reviewers reading the code groups');
  assert.equal(hunt.unit, 'AI reviewers');
  assert.equal(hunt.note, '2 areas of code unchanged since the last review skipped; 1 too large to read');
  assert.equal(doc.steps.find((s) => s.id === 'verify').unit, 'possible problems');
});

test('hunt: a verify run (no units.json) counts only its double-checks', () => {
  const dir = path.join(home, 'projects', SLUG, 'runs', RUN);
  fs.mkdirSync(path.join(dir, 'candidates'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'votes'), { recursive: true });
  for (const id of ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']) fs.writeFileSync(path.join(dir, 'candidates', `${id}__verify.json`), JSON.stringify([{ ref: 'c1' }]));
  fs.writeFileSync(path.join(dir, 'votes', 'aaaaaaaaaaaa__verify__c1__1.json'), '{}');
  const p = progress();
  assert.deepEqual(p.huntCounts(SLUG, RUN), { hunters: { done: 0, total: 0 }, verify: { done: 1, total: 2 }, skipped: { unchanged: 0, notHunted: 0 } });
  p.startPlan(SLUG, { job: 'verify', system: 'mobile', runId: RUN }, T0);
  const doc = p.applyHunt(SLUG, RUN, T1);
  const verify = doc.steps.find((s) => s.id === 'verify');
  assert.deepEqual([verify.status, verify.done, verify.total], ['running', 1, 2]);
});

test('labels use the dashboard\'s plain names: AI reviewers, AI checkers, code groups', () => {
  const p = progress();
  const labels = (opts) => Object.fromEntries(p.planSteps({ systems: [], ...opts }).map((s) => [s.id, s.label]));
  assert.equal(labels({ job: 'audit', layer: 'L3' }).plan, 'Splitting the code into groups');
  assert.match(labels({ job: 'audit', layer: 'L2' }).plan, /code groups/);
  assert.match(labels({ job: 'audit', layer: 'L2' }).hunt, /^AI reviewers /);
  for (const layer of ['L2', 'L3', 'INFRA']) assert.match(labels({ job: 'audit', layer }).verify, /^AI checkers /, layer);
  assert.match(labels({ job: 'verify' }).verify, /^AI checkers /);
  assert.match(labels({ job: 'audit', layer: 'INFRA' }).compare, /AI agent/);
});

test('hunt: an INFRA run counts its one prober file; a missing run directory counts nothing', () => {
  const p = progress();
  assert.deepEqual(p.huntCounts(SLUG, RUN), { hunters: { done: 0, total: 0 }, verify: { done: 0, total: 0 }, skipped: { unchanged: 0, notHunted: 0 } });
  seedRun({ hunters: undefined, extra: { layer: 'INFRA', system: 'db' }, candidates: { 'db__infra-prober': [{ ref: 'c1' }] } });
  assert.deepEqual(p.huntCounts(SLUG, RUN), { hunters: { done: 1, total: 1 }, verify: { done: 0, total: 1 }, skipped: { unchanged: 0, notHunted: 0 } });
  p.startPlan(SLUG, { job: 'audit', layer: 'INFRA', system: 'db' }, T0);
  const doc = p.applyHunt(SLUG, RUN, T1);
  const compare = doc.steps.find((s) => s.id === 'compare');
  assert.deepEqual([compare.status, compare.done, compare.total], ['running', 1, 1]);
  assert.equal(doc.steps.find((s) => s.id === 'verify').status, 'pending', 'no vote yet: verify has not started');
  assert.equal(doc.runId, RUN, 'the run id is recorded once known');
  assert.throws(() => p.huntCounts(SLUG, '../x'), p.UsageError);
});

test('hunt: a finished step is left alone', () => {
  seedRun({ hunters: [{ key: 'a__b' }], candidates: { a__b: [{ ref: 'c1' }] } });
  const p = progress();
  p.startPlan(SLUG, { job: 'audit', layer: 'L3', system: 'mobile' }, T0);
  p.markStep(SLUG, 'hunt', { status: 'done', done: 1, total: 1 }, T0);
  const doc = p.applyHunt(SLUG, RUN, T1);
  assert.equal(doc.steps.find((s) => s.id === 'hunt').status, 'done');
});

test('finish: pending steps are skipped, a running one done (or failed), and the state and finishedAt are set', () => {
  const p = progress();
  p.startPlan(SLUG, { job: 'audit', layer: 'L3', system: 'mobile' }, T0);
  p.markStep(SLUG, 'plan', { status: 'done' }, T0);
  p.markStep(SLUG, 'hunt', { status: 'running' }, T0);
  let doc = p.finishPlan(SLUG, { status: 'done' }, T1);
  valid(doc);
  assert.deepEqual(doc.steps.map((s) => s.status), ['done', 'done', 'skipped', 'skipped', 'skipped', 'skipped']);
  assert.equal(doc.state, 'done');
  assert.equal(doc.finishedAt, T1);
  assert.deepEqual(doc.overall, { done: 6, total: 6, percent: 100 });
  p.startPlan(SLUG, { job: 'audit', layer: 'L3', system: 'mobile' }, T0);
  p.markStep(SLUG, 'plan', { status: 'running' }, T0);
  doc = p.finishPlan(SLUG, { status: 'failed', note: 'the workflow tool is missing' }, T1);
  assert.equal(doc.state, 'failed');
  assert.equal(doc.steps[0].status, 'failed');
  assert.equal(doc.note, 'the workflow tool is missing');
  valid(doc);
  assert.throws(() => p.finishPlan(SLUG, { status: 'skipped' }, T1), p.UsageError);
  doc = p.markStep(SLUG, 'score', { status: 'running' }, T1);
  assert.equal(doc.state, 'running', 'a step marked after the finish reopens the plan');
  assert.equal(doc.finishedAt, null);
});

test('CLI: start, step, hunt, finish and show print the document; --out writes it too', () => {
  let r = cli('start', '--project', SLUG, '--job', 'audit', '--layer', 'L3', '--system', 'mobile', '--run', RUN, '--live', '--now', T0);
  assert.equal(r.status, 0, r.stderr);
  const started = JSON.parse(r.stdout);
  valid(started);
  assert.equal(started.runId, RUN);
  r = cli('step', '--project', SLUG, '--step', 'plan', '--status', 'done', '--now', T1);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).steps[0].status, 'done');
  seedRun({ hunters: [{ key: 'a__b' }, { key: 'c__d' }], candidates: { a__b: [] } });
  r = cli('hunt', '--project', SLUG, '--run', RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).steps[1].done, 1);
  const out = path.join(home, 'out', 'progress.json');
  r = cli('finish', '--project', SLUG, '--out', out);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).state, 'done');
  r = cli('show', '--project', SLUG);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).state, 'done');
});

test('CLI: bad arguments exit 2 with a usage line and write nothing', () => {
  for (const args of [[], ['start'], ['bogus', '--project', SLUG], ['start', '--project', SLUG, '--job', 'audit'], ['step', '--project', SLUG, '--step', 'plan'], ['show', '--project', SLUG], ['step', '--project', SLUG, '--step', 'x', '--status', 'done'], ['start', '--project', SLUG, '--job', 'inventory', '--bogus']]) {
    const r = cli(...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^progress: /);
  }
  assert.ok(!fs.existsSync(path.join(home, 'projects', SLUG, 'progress.json')));
});

test('CLI: a corrupt progress file exits 1, naming the project and never quoting the file', () => {
  fs.writeFileSync(path.join(home, 'projects', SLUG, 'progress.json'), '{"secret": "sk-ant-api03-abcdefghijklmnop"');
  const r = cli('show', '--project', SLUG);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /progress\.json of example-app is not valid JSON/);
  assert.ok(!r.stderr.includes('sk-ant'));
});
