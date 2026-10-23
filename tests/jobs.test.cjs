const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const store = require('../scripts/store.cjs');
const { validate, loadSchema } = require('../scripts/lib/validate.cjs');
const jobs = require('../scripts/jobs.cjs');

const JOBS = path.join(__dirname, '..', 'scripts', 'jobs.cjs');
const NOW = new Date('2026-10-23T12:34:56.789Z');
const NOW_ISO = NOW.toISOString();

const repoSystem = (extra = {}) => ({ id: 'web', type: 'web-app', repo: { remote: 'https://github.com/acme/app.git' }, ...extra });
const hostSystem = () => ({ id: 'box', type: 'server', executor: 'local', host: { ssh: 'me@box.lan' } });
const cloudOk = { cloudAllowed: true };

const queuedJob = (extra = {}) => ({
  id: 'job-20261023-120000-abcd',
  type: 'audit',
  project: 'example-app',
  system: 'web',
  layer: 'L2',
  executorKind: 'local',
  status: 'queued',
  createdBy: 'u_owner',
  confirmedAt: '2026-10-23T12:00:00.000Z',
  costShown: '100 agents',
  updatedAt: '2026-10-23T12:00:00.000Z',
  ...extra,
});

// ---- ids ------------------------------------------------------------------------------------

test('newJobId: job-<YYYYMMDD-HHmmss>-<4 hex> in UTC', () => {
  assert.match(jobs.newJobId(NOW), /^job-20261023-123456-[0-9a-f]{4}$/);
  // A local-time Date at the other side of midnight still reads as UTC.
  assert.match(jobs.newJobId(new Date('2026-01-02T00:00:01Z')), /^job-20260102-000001-[0-9a-f]{4}$/);
});

test('newJobId: the suffix comes from rand (an integer 0..65535), padded to 4 hex', () => {
  assert.equal(jobs.newJobId(NOW, () => 0), 'job-20261023-123456-0000');
  assert.equal(jobs.newJobId(NOW, () => 255), 'job-20261023-123456-00ff');
  assert.equal(jobs.newJobId(NOW, () => 65535), 'job-20261023-123456-ffff');
});

test('newJobId: ids sort by time, and the default suffix is random', () => {
  const times = ['2026-10-23T12:00:00Z', '2026-10-23T12:00:01Z', '2026-10-23T12:01:00Z', '2026-11-01T00:00:00Z', '2027-01-01T00:00:00Z'];
  const ids = times.map((t) => jobs.newJobId(new Date(t)));
  assert.deepEqual([...ids].sort(), ids);
  const suffixes = new Set(Array.from({ length: 30 }, () => jobs.newJobId(NOW).slice(-4)));
  assert.ok(suffixes.size > 1, 'thirty ids at one instant should not share a suffix');
});

test('newJobId: a bad date or a bad rand throws', () => {
  assert.throws(() => jobs.newJobId(new Date('nope')), TypeError);
  assert.throws(() => jobs.newJobId(NOW, () => 70000), RangeError);
  assert.throws(() => jobs.newJobId(NOW, () => 1.5), RangeError);
});

// ---- cost -----------------------------------------------------------------------------------

test('costEstimate: L1 is scripts only', () => {
  const c = jobs.costEstimate({ type: 'audit', layer: 'L1' });
  assert.equal(c.agents, 0);
  assert.match(c.note, /scripts only, ~1 min/);
});

test('costEstimate: L2 is min(units, 10) x 5 classes x 2', () => {
  assert.equal(jobs.costEstimate({ type: 'audit', layer: 'L2', units: 3 }).agents, 30);
  assert.equal(jobs.costEstimate({ type: 'audit', layer: 'L2', units: 10 }).agents, 100);
  assert.equal(jobs.costEstimate({ type: 'audit', layer: 'L2', units: 40 }).agents, 100);
  assert.equal(jobs.costEstimate({ type: 'audit', layer: 'L2' }).agents, 100, 'units default to 10');
});

test('costEstimate: L3 is units x 5|10|classes x 2 by effort', () => {
  const l3 = (effort, extra = {}) => jobs.costEstimate({ type: 'audit', layer: 'L3', units: 4, effort, ...extra }).agents;
  assert.equal(l3('low'), 40);
  assert.equal(l3('medium'), 80);
  assert.equal(l3('high'), 120, 'classes default to 15');
  assert.equal(l3('high', { classes: 12 }), 96);
  assert.equal(jobs.costEstimate({ type: 'audit', layer: 'L3', units: 4 }).agents, 80, 'effort defaults to medium');
  assert.equal(jobs.costEstimate({ type: 'audit', layer: 'L3' }).agents, 200, 'units default to 10');
});

test('costEstimate: INFRA is probes + 2; verify is the open verified findings; inventory is 1', () => {
  assert.equal(jobs.costEstimate({ type: 'audit', layer: 'INFRA', probes: 8 }).agents, 10);
  assert.equal(jobs.costEstimate({ type: 'audit', layer: 'INFRA' }).agents, 8, 'probes default to 6');
  assert.equal(jobs.costEstimate({ type: 'verify', openVerified: 7 }).agents, 7);
  assert.equal(jobs.costEstimate({ type: 'verify' }).agents, 0);
  assert.equal(jobs.costEstimate({ type: 'inventory' }).agents, 1);
});

test('costEstimate: every note says it is an estimate and states the numbers; types that spawn no agents read 0', () => {
  assert.match(jobs.costEstimate({ type: 'audit', layer: 'L2', units: 3 }).note, /3 .*5 .*2 .*estimate/i);
  for (const type of ['dashboard', 'doctor', 'import', 'apply']) {
    const c = jobs.costEstimate({ type });
    assert.equal(c.agents, 0, type);
    assert.equal(typeof c.note, 'string');
  }
  assert.equal(jobs.costEstimate({ type: 'fix' }).agents, 1);
});

test('costEstimate: results are integers; bad input throws', () => {
  for (const layer of ['L1', 'L2', 'L3', 'INFRA']) assert.ok(Number.isInteger(jobs.costEstimate({ type: 'audit', layer }).agents), layer);
  assert.throws(() => jobs.costEstimate({ type: 'audit' }), /layer/);
  assert.throws(() => jobs.costEstimate({ type: 'audit', layer: 'L9' }), /layer/);
  assert.throws(() => jobs.costEstimate({ type: 'audit', layer: 'L2', units: -1 }), /units/);
  assert.throws(() => jobs.costEstimate({ type: 'audit', layer: 'L2', units: 1.5 }), /units/);
  assert.throws(() => jobs.costEstimate({ type: 'audit', layer: 'L3', effort: 'extreme' }), /effort/);
  assert.throws(() => jobs.costEstimate({ type: 'nope' }), /type/);
  assert.throws(() => jobs.costEstimate(), TypeError);
});

// ---- routing --------------------------------------------------------------------------------

test('route: a repo on github with cloud allowed goes to cloud', () => {
  const r = jobs.route({ project: cloudOk, system: repoSystem(), type: 'audit', layer: 'L2' });
  assert.equal(r.executorKind, 'cloud');
  assert.equal(typeof r.reason, 'string');
  assert.ok(r.reason.length > 0 && r.reason.length < 120);
});

test('route: cloudAllowed false or absent stays local', () => {
  assert.equal(jobs.route({ project: { cloudAllowed: false }, system: repoSystem(), type: 'audit', layer: 'L2' }).executorKind, 'local');
  assert.equal(jobs.route({ project: {}, system: repoSystem(), type: 'audit', layer: 'L2' }).executorKind, 'local');
  assert.match(jobs.route({ project: { cloudAllowed: false }, system: repoSystem(), type: 'audit', layer: 'L2' }).reason, /cloud/i);
});

test('route: INFRA never goes to cloud, even on a cloud-allowed repo project', () => {
  const r = jobs.route({ project: cloudOk, system: repoSystem(), type: 'audit', layer: 'INFRA' });
  assert.equal(r.executorKind, 'local');
  assert.match(r.reason, /infra/i);
});

test('route: apply never goes to cloud', () => {
  const r = jobs.route({ project: cloudOk, system: repoSystem(), type: 'apply', layer: 'L2' });
  assert.equal(r.executorKind, 'local');
  assert.match(r.reason, /apply/i);
});

test('route: a system with executor local (host-backed) stays local; cloud and either do not block', () => {
  assert.equal(jobs.route({ project: cloudOk, system: hostSystem(), type: 'audit', layer: 'L2' }).executorKind, 'local');
  assert.equal(jobs.route({ project: cloudOk, system: repoSystem({ executor: 'local' }), type: 'audit', layer: 'L2' }).executorKind, 'local');
  assert.equal(jobs.route({ project: cloudOk, system: repoSystem({ executor: 'cloud' }), type: 'audit', layer: 'L2' }).executorKind, 'cloud');
  assert.equal(jobs.route({ project: cloudOk, system: repoSystem({ executor: 'either' }), type: 'audit', layer: 'L2' }).executorKind, 'cloud');
});

test('route: the remote must be on github.com, in any of the forms git uses', () => {
  const kind = (remote) => jobs.route({ project: cloudOk, system: { id: 's', repo: { remote } }, type: 'audit', layer: 'L1' }).executorKind;
  for (const remote of [
    'github.com/acme/app',
    'github.com:acme/app.git',
    'GitHub.com/acme/app',
    'https://github.com/acme/app.git',
    'git@github.com:acme/app.git',
    'ssh://git@github.com/acme/app.git',
    'https://token@github.com/acme/app',
  ]) {
    assert.equal(kind(remote), 'cloud', remote);
  }
  for (const remote of [
    'gitlab.com/acme/app',
    'https://github.com.evil.example/acme/app',
    'https://evil.example/github.com/acme/app',
    'https://evil.example/x@github.com/acme/app',
    'git@bitbucket.org:acme/app.git',
    'notgithub.com/acme/app',
    '',
    undefined,
    42,
  ]) {
    assert.equal(kind(remote), 'local', String(remote));
  }
});

test('route: a system with no repo, no system or no project stays local and never throws', () => {
  assert.equal(jobs.route({ project: cloudOk, system: { id: 'x' }, type: 'audit', layer: 'L1' }).executorKind, 'local');
  assert.equal(jobs.route({ project: cloudOk, type: 'audit', layer: 'L1' }).executorKind, 'local');
  assert.equal(jobs.route({ system: repoSystem(), type: 'audit', layer: 'L1' }).executorKind, 'local');
  assert.equal(jobs.route({}).executorKind, 'local');
  assert.equal(jobs.route().executorKind, 'local');
  assert.equal(jobs.route({ project: { cloudAllowed: 'yes' }, system: repoSystem(), type: 'audit', layer: 'L1' }).executorKind, 'local', 'only true allows cloud');
});

test('route: the reason is non-empty for every outcome', () => {
  for (const args of [
    { project: cloudOk, system: repoSystem(), type: 'audit', layer: 'L2' },
    { project: cloudOk, system: repoSystem(), type: 'apply' },
    { project: cloudOk, system: repoSystem(), layer: 'INFRA' },
    { project: cloudOk, system: hostSystem() },
    { project: {}, system: repoSystem() },
    { project: cloudOk, system: { id: 'x' } },
    { project: cloudOk, system: { repo: { remote: 'gitlab.com/a/b' } } },
  ]) {
    const r = jobs.route(args);
    assert.ok(['local', 'cloud'].includes(r.executorKind));
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
  }
});

// ---- patches --------------------------------------------------------------------------------

const jobSchema = loadSchema('job');
const asJob = (job, patch) => ({ ...job, ...patch });

test('claimPatch: queued -> claimed with claimant and times; the merged job validates', () => {
  const job = queuedJob();
  const patch = jobs.claimPatch(job, 'exec-laptop', NOW);
  assert.deepEqual(patch, { status: 'claimed', claimedBy: 'exec-laptop', claimedAt: NOW_ISO, updatedAt: NOW_ISO });
  assert.deepEqual(validate(jobSchema, asJob(job, patch)), { ok: true, errors: [] });
  assert.equal(job.status, 'queued', 'the job is not mutated');
});

test('claimPatch: throws unless the job is queued', () => {
  for (const status of ['claimed', 'running', 'done', 'failed']) {
    assert.throws(() => jobs.claimPatch(queuedJob({ status }), 'exec-laptop', NOW), /queued/, status);
  }
  assert.throws(() => jobs.claimPatch(null, 'exec-laptop', NOW), TypeError);
  assert.throws(() => jobs.claimPatch(queuedJob(), '', NOW), /executor/);
  assert.throws(() => jobs.claimPatch(queuedJob(), 'exec-laptop', new Date('nope')), TypeError);
});

test('completionPatch: done or failed, with finishedAt, updatedAt, runId and a summary; the merged job validates', () => {
  const job = queuedJob({ status: 'running', claimedBy: 'exec-laptop', claimedAt: NOW_ISO });
  const done = jobs.completionPatch(job, { runId: 'run-1', status: 'done', resultSummary: '3 new findings' }, NOW);
  assert.deepEqual(done, { status: 'done', runId: 'run-1', resultSummary: '3 new findings', finishedAt: NOW_ISO, updatedAt: NOW_ISO });
  assert.deepEqual(validate(jobSchema, asJob(job, done)), { ok: true, errors: [] });
  const failed = jobs.completionPatch(job, { status: 'failed', resultSummary: 'tool missing' }, NOW);
  assert.equal(failed.status, 'failed');
  assert.ok(!('runId' in failed), 'no runId given, none in the patch');
  assert.deepEqual(validate(jobSchema, asJob(job, failed)), { ok: true, errors: [] });
  const bare = jobs.completionPatch(job, { status: 'done' }, NOW);
  assert.ok(!('resultSummary' in bare));
});

test('completionPatch: only done or failed are accepted', () => {
  const job = queuedJob({ status: 'running' });
  for (const status of ['queued', 'claimed', 'running', 'success', undefined]) {
    assert.throws(() => jobs.completionPatch(job, { status }, NOW), /done|failed/, String(status));
  }
  assert.throws(() => jobs.completionPatch(job, undefined, NOW), TypeError);
});

test('completionPatch: the summary goes through the redactor and is capped at 500 characters', () => {
  const job = queuedJob({ status: 'running' });
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const p = jobs.completionPatch(job, { status: 'failed', resultSummary: `push failed with ${secret}` }, NOW);
  assert.ok(!p.resultSummary.includes(secret));
  assert.match(p.resultSummary, /\[REDACTED\]/);
  const long = jobs.completionPatch(job, { status: 'done', resultSummary: 'x'.repeat(2000) }, NOW).resultSummary;
  assert.equal(long.length, 500);
  assert.equal(jobs.completionPatch(job, { status: 'done', resultSummary: 'y'.repeat(500) }, NOW).resultSummary, 'y'.repeat(500), '500 exactly is kept whole');
  // Redact first, then cap: a secret straddling the cap cannot leave a fragment.
  const straddle = jobs.completionPatch(job, { status: 'done', resultSummary: `${'z'.repeat(480)} token=${'q'.repeat(60)}` }, NOW).resultSummary;
  assert.ok(!/q{8}/.test(straddle));
  assert.ok(straddle.length <= 500);
});

test('refusalPatch: failed with the fixed text; the merged job validates', () => {
  const job = queuedJob({ createdBy: 'u_stranger' });
  const patch = jobs.refusalPatch(job, NOW);
  assert.deepEqual(patch, { status: 'failed', resultSummary: 'not created by the owner', finishedAt: NOW_ISO, updatedAt: NOW_ISO });
  assert.deepEqual(validate(jobSchema, asJob(job, patch)), { ok: true, errors: [] });
});

test('patches accept an ISO string or a millisecond number for now', () => {
  assert.equal(jobs.claimPatch(queuedJob(), 'e', NOW_ISO).claimedAt, NOW_ISO);
  assert.equal(jobs.claimPatch(queuedJob(), 'e', NOW.getTime()).claimedAt, NOW_ISO);
});

// ---- page copies ----------------------------------------------------------------------------

test('PAGE_FUNCTIONS: each is a self-contained function that behaves the same with no Node globals', () => {
  assert.ok(Array.isArray(jobs.PAGE_FUNCTIONS) && jobs.PAGE_FUNCTIONS.length >= 5);
  for (const name of ['newJobId', 'costEstimate', 'route', 'claimPatch', 'refusalPatch']) assert.ok(jobs.PAGE_FUNCTIONS.includes(name), name);
  assert.ok(!jobs.PAGE_FUNCTIONS.includes('completionPatch'), 'completionPatch needs the Node redactor and stays out of the page');
  const sources = jobs.PAGE_FUNCTIONS.map((name) => {
    assert.equal(typeof jobs[name], 'function', name);
    const src = jobs[name].toString();
    assert.ok(src.startsWith('function '), `${name} is a function declaration`);
    assert.ok(!/\brequire\s*\(|\bprocess\b|\bBuffer\b|\bmodule\b/.test(src), `${name} uses no Node-only global`);
    return src;
  });
  // A bare context: only the language built-ins, as in a page script with no module loader.
  const page = vm.runInNewContext(`${sources.join('\n')}\n({ ${jobs.PAGE_FUNCTIONS.join(', ')} })`, Object.create(null));
  assert.equal(page.newJobId(NOW, () => 0xabcd), 'job-20261023-123456-abcd');
  assert.match(page.newJobId(NOW), /^job-20261023-123456-[0-9a-f]{4}$/, 'the default suffix works without crypto');
  // Objects built inside the vm context have another realm's prototypes, so compare them as JSON.
  const same = (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b);
  same(page.costEstimate({ type: 'audit', layer: 'L2', units: 3 }), jobs.costEstimate({ type: 'audit', layer: 'L2', units: 3 }));
  const args = { project: cloudOk, system: repoSystem(), type: 'audit', layer: 'L2' };
  same(page.route(args), jobs.route(args));
  same(page.claimPatch(queuedJob(), 'e', NOW), jobs.claimPatch(queuedJob(), 'e', NOW));
  same(page.refusalPatch(queuedJob(), NOW), jobs.refusalPatch(queuedJob(), NOW));
});

// ---- CLI ------------------------------------------------------------------------------------

let tmp;
test.beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart jobs '));
});
test.afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const cli = (args) => spawnSync(process.execPath, [JOBS, ...args], { env: { ...process.env, RAMPART_HOME: path.join(tmp, 'home') }, encoding: 'utf8' });
const cliJson = (args) => {
  const r = cli([...args, '--json']);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const writeTmp = (name, value) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
};

test('CLI new-id: prints the id; --json wraps it; --now fixes the time', () => {
  const r = cli(['new-id', '--now', NOW_ISO]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^job-20261023-123456-[0-9a-f]{4}$/);
  const j = cliJson(['new-id', '--now', NOW_ISO]);
  assert.match(j.id, /^job-20261023-123456-[0-9a-f]{4}$/);
  assert.match(cliJson(['new-id']).id, /^job-\d{8}-\d{6}-[0-9a-f]{4}$/);
});

test('CLI cost: the same numbers as the function', () => {
  assert.deepEqual(cliJson(['cost', '--type', 'audit', '--layer', 'L2', '--units', '3']), jobs.costEstimate({ type: 'audit', layer: 'L2', units: 3 }));
  assert.deepEqual(
    cliJson(['cost', '--type', 'audit', '--layer', 'L3', '--units', '4', '--effort', 'high', '--classes', '12']),
    jobs.costEstimate({ type: 'audit', layer: 'L3', units: 4, effort: 'high', classes: 12 })
  );
  assert.deepEqual(cliJson(['cost', '--type', 'audit', '--layer', 'INFRA', '--probes', '8']), jobs.costEstimate({ type: 'audit', layer: 'INFRA', probes: 8 }));
  assert.deepEqual(cliJson(['cost', '--type', 'verify', '--open-verified', '7']), jobs.costEstimate({ type: 'verify', openVerified: 7 }));
  assert.deepEqual(cliJson(['cost', '--type', 'inventory']), { agents: 1, note: jobs.costEstimate({ type: 'inventory' }).note });
});

test('CLI route: from a project file or from the store, picking the system by id', () => {
  const project = { name: 'Example', cloudAllowed: true, systems: [repoSystem(), hostSystem()] };
  const file = writeTmp('project.json', project);
  assert.equal(cliJson(['route', '--project-file', file, '--system', 'web', '--type', 'audit', '--layer', 'L2']).executorKind, 'cloud');
  assert.equal(cliJson(['route', '--project-file', file, '--system', 'box', '--type', 'audit', '--layer', 'L2']).executorKind, 'local');
  assert.equal(cliJson(['route', '--project-file', file, '--system', 'web', '--type', 'audit', '--layer', 'INFRA']).executorKind, 'local');
  const out = cliJson(['route', '--project-file', file, '--system', 'web', '--type', 'apply']);
  assert.deepEqual(Object.keys(out).sort(), ['executorKind', 'reason']);

  const saved = process.env.RAMPART_HOME;
  process.env.RAMPART_HOME = path.join(tmp, 'home');
  try {
    const valid = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'project.valid.json'), 'utf8'));
    store.writeProject({ ...valid, slug: 'example-app', cloudAllowed: true });
  } finally {
    if (saved === undefined) delete process.env.RAMPART_HOME;
    else process.env.RAMPART_HOME = saved;
  }
  assert.equal(cliJson(['route', '--project', 'example-app', '--system', 'mobile', '--type', 'audit', '--layer', 'L1']).executorKind, 'cloud');
});

test('CLI route: a system id the project does not have is an error, not a silent local', () => {
  const file = writeTmp('project.json', { systems: [repoSystem()] });
  const r = cli(['route', '--project-file', file, '--system', 'missing', '--type', 'audit', '--layer', 'L1']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing/);
});

test('CLI claim-patch and completion-patch read the job from --job and print the patch', () => {
  const file = writeTmp('job.json', queuedJob());
  assert.deepEqual(cliJson(['claim-patch', '--job', file, '--executor', 'exec-laptop', '--now', NOW_ISO]), {
    status: 'claimed',
    claimedBy: 'exec-laptop',
    claimedAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
  const running = writeTmp('running.json', queuedJob({ status: 'running' }));
  assert.deepEqual(
    cliJson(['completion-patch', '--job', running, '--run-id', 'run-1', '--status', 'done', '--summary', '3 new findings', '--now', NOW_ISO]),
    { status: 'done', runId: 'run-1', resultSummary: '3 new findings', finishedAt: NOW_ISO, updatedAt: NOW_ISO }
  );
  assert.deepEqual(cliJson(['refusal-patch', '--job', file, '--now', NOW_ISO]), jobs.refusalPatch(queuedJob(), NOW));
});

test('CLI claim-patch on a job that is not queued exits 1 with the reason', () => {
  const file = writeTmp('job.json', queuedJob({ status: 'claimed' }));
  const r = cli(['claim-patch', '--job', file, '--executor', 'exec-laptop']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /queued/);
});

test('CLI completion-patch redacts the summary it was given', () => {
  const file = writeTmp('job.json', queuedJob({ status: 'running' }));
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const out = cliJson(['completion-patch', '--job', file, '--status', 'failed', '--summary', `failed with ${secret}`]);
  assert.ok(!out.resultSummary.includes(secret));
});

test('CLI usage errors exit 2: no command, unknown command, missing options, bad numbers', () => {
  assert.equal(cli([]).status, 2);
  assert.equal(cli(['frobnicate']).status, 2);
  assert.equal(cli(['cost']).status, 2);
  assert.equal(cli(['cost', '--type', 'audit', '--layer', 'L2', '--units', 'many']).status, 2);
  assert.equal(cli(['route', '--type', 'audit']).status, 2);
  assert.equal(cli(['claim-patch']).status, 2);
  assert.equal(cli(['completion-patch', '--job', 'x.json']).status, 2);
  assert.equal(cli(['new-id', '--now', 'tomorrow']).status, 2);
  assert.equal(cli(['new-id', '--bogus']).status, 2);
  assert.match(cli(['frobnicate']).stderr, /usage/);
});

test('CLI: a missing or corrupt --job file exits 1', () => {
  assert.equal(cli(['claim-patch', '--job', path.join(tmp, 'nope.json'), '--executor', 'e']).status, 1);
  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, '{not json');
  assert.equal(cli(['claim-patch', '--job', bad, '--executor', 'e']).status, 1);
});
