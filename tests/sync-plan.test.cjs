const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const store = require('../scripts/store.cjs');
const { validate, loadSchema } = require('../scripts/lib/validate.cjs');
const { runDir, machineId } = require('../scripts/lib/paths.cjs');
const { buildPage, publicProject } = require('../scripts/render-static.cjs');
const { planPush, applyPull } = require('../scripts/sync-plan.cjs');

const SYNC = path.join(__dirname, '..', 'scripts', 'sync-plan.cjs');
const SLUG = 'example-app';
const NOW = new Date('2026-10-23T12:00:00.000Z');
const PLANTED = 'plantedsecret12345';
const PLANTED_QUERY = 'plantedquerykey789';
const PLANTED_USERINFO = 'plantedtoken456';
const ID_A = '0000000000a1';
const ID_B = '0000000000b2';
const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';

// Wait until the clock moves to a new millisecond, so two stamps taken around it differ.
const tick = () => { const t = Date.now(); while (Date.now() === t); };
// A plan taken in a later millisecond than every write before it, so its cursor is not shared with a stamp (since is inclusive).
const planSettled = (...args) => { tick(); return planPush(...args); };

const savedHome = process.env.RAMPART_HOME;
let home;
test.beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart sync '));
  process.env.RAMPART_HOME = home;
});
test.afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.RAMPART_HOME;
  else process.env.RAMPART_HOME = savedHome;
});

const finding = (id, over = {}) => ({
  id, project: SLUG, system: 'web', layer: 'L1', source: 'npm-audit', ruleId: `npm/${id}`, title: `Issue ${id}`,
  severity: 'HIGH', confidence: 'HIGH', class: 'tool', location: { package: 'lodash', ecosystem: 'npm', path: 'package-lock.json' },
  evidence: 'lodash 4.17.20 installed', status: 'open', recommendation: 'Upgrade lodash', ...over,
});

// A project carrying every private field the page must never see, two findings, one finished run with a REPORT.md.
function seed() {
  store.writeProject({
    slug: SLUG,
    name: 'Example App',
    criticality: 'high',
    ownerAttestation: { statement: 'I own or am authorized to test every system listed here', by: 'owner', at: '2026-10-23T00:00:00Z' },
    defaultExecutor: 'local',
    cloudAllowed: false,
    systems: [
      {
        id: 'web', type: 'web-nextjs', name: 'Web app', packs: ['web-nextjs'], criticality: 'public', executor: 'either',
        repo: {
          remote: `https://${PLANTED_USERINFO}@github.com/acme/web`, defaultBranch: 'main',
          paths: { [machineId()]: 'C:\\Users\\someone\\web', other: '/home/someone/web' },
        },
        live: { url: `https://app.example.invalid/dashboard?apikey=${PLANTED_QUERY}#section` },
        layers: { L1: { cadenceDays: 7 }, L2: { cadenceDays: 30 } },
      },
      {
        id: 'db', type: 'supabase', name: 'Self-hosted Supabase', packs: ['supabase'], criticality: 'data', executor: 'local',
        host: { ssh: 'deploy@192.0.2.10:2222', composeProject: 'secret-compose', configPath: '/srv/private/config' },
        repo: { remote: 'git@github.com:acme/db.git', defaultBranch: 'main', paths: { [machineId()]: '/srv/private/db' } },
        layers: { INFRA: { cadenceDays: 30 } },
      },
    ],
  });
  const run = store.createRun(SLUG, { job: 'audit', layers: ['L1'], systems: ['web'], executor: 'local' });
  store.upsertFindings(SLUG, [
    finding(ID_A),
    finding(ID_B, { recommendation: `Old note from the deploy log: PASSWORD=${PLANTED}` }),
  ], run.runId);
  fs.writeFileSync(path.join(runDir(SLUG, run.runId), 'REPORT.md'), `# Report\n\nAll good. Found a leak: PASSWORD=${PLANTED}\n`);
  store.finishRun(SLUG, run.runId, { status: 'done', counts: { added: 2 } });
  return run.runId;
}

const ids = (plan, collection) => plan.docs.filter((d) => d.collection === collection).map((d) => d.id).sort();

// ---- privacy ----------------------------------------------------------------------------------

test('the page data and the pushed docs hold no paths, ssh user, query string, ownerAttestation or planted credential', () => {
  seed();
  const outputs = {
    buildPage: JSON.stringify(buildPage(NOW)),
    planPush: JSON.stringify(planPush(SLUG, { now: NOW })),
  };
  const forbidden = [
    ['paths', /paths/],
    ['an ssh user', /[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+/],
    ['a query string', /\?/],
    ['ownerAttestation', /ownerAttestation/],
    ['the planted password', new RegExp(PLANTED)],
    ['the planted query key', new RegExp(PLANTED_QUERY)],
    ['the planted userinfo', new RegExp(PLANTED_USERINFO)],
    ['a local path', /someone|\/srv\/private|secret-compose/],
    ['a url fragment', /#section/],
  ];
  for (const [what, outcome] of Object.entries(outputs)) {
    for (const [name, re] of forbidden) assert.ok(!re.test(outcome), `${what} must not contain ${name}`);
  }
  assert.ok(outputs.buildPage.includes('PASSWORD=[REDACTED]'), 'the credential is redacted in place');
});

test('publicProject keeps only repo.remote/defaultBranch, host.hostname and live.url as origin plus pathname', () => {
  seed();
  const p = publicProject(store.readProject(SLUG));
  assert.equal('ownerAttestation' in p, false);
  const [web, db] = p.systems;
  assert.deepEqual(web.repo, { remote: 'https://github.com/acme/web', defaultBranch: 'main' });
  assert.deepEqual(web.live, { url: 'https://app.example.invalid/dashboard' });
  assert.deepEqual(db.host, { hostname: '192.0.2.10' });
  assert.deepEqual(db.repo, { remote: 'github.com:acme/db.git', defaultBranch: 'main' }, 'the scp-style ssh user is dropped');
  assert.equal('live' in db, false, 'no live url, none invented');
  assert.deepEqual(web.layers, { L1: { cadenceDays: 7 }, L2: { cadenceDays: 30 } });
  assert.equal(p.slug, SLUG);
});

test('publicProject host handles every ssh form: no user, no port, no @, ssh://, bracketed and bare IPv6', () => {
  const hostOf = (ssh) => publicProject({ slug: SLUG, systems: [{ id: 'x', host: { ssh } }] }).systems[0].host.hostname;
  assert.equal(hostOf('root@example.test'), 'example.test');
  assert.equal(hostOf('root@example.test:2222'), 'example.test');
  assert.equal(hostOf('example.test'), 'example.test');
  assert.equal(hostOf('example.test:22'), 'example.test');
  assert.equal(hostOf('ssh://root@example.test:2222/'), 'example.test');
  assert.equal(hostOf('root@[2001:db8::1]:22'), '2001:db8::1');
  assert.equal(hostOf('2001:db8::1'), '2001:db8::1');
  const remoteOf = (remote) => publicProject({ slug: SLUG, systems: [{ id: 'x', repo: { remote } }] }).systems[0].repo.remote;
  assert.equal(remoteOf('git@github.com:o/r.git'), 'github.com:o/r.git');
  assert.equal(remoteOf('user@192.0.2.10:repos/x.git'), '192.0.2.10:repos/x.git');
  assert.equal(remoteOf('https://tok@github.com/o/r'), 'https://github.com/o/r');
  assert.equal(remoteOf('ssh://git@github.com/o/r.git'), 'ssh://github.com/o/r.git');
  assert.equal(remoteOf('github.com/o/r'), 'github.com/o/r');
  const urlOf = (url) => publicProject({ slug: SLUG, systems: [{ id: 'x', live: { url } }] }).systems[0].live;
  assert.deepEqual(urlOf('http://example.test'), { url: 'http://example.test/' });
  assert.equal(urlOf('javascript:alert(1)'), undefined, 'not an http(s) url');
  assert.equal(urlOf('not a url'), undefined);
});

// ---- planPush ---------------------------------------------------------------------------------

test('planPush with no since plans the project, every finding and the run summary, with updatedAt on each doc', () => {
  const runId = seed();
  const plan = planPush(SLUG, { now: NOW });
  assert.deepEqual(ids(plan, 'projects'), [SLUG]);
  assert.deepEqual(ids(plan, 'findings'), [ID_A, ID_B]);
  assert.deepEqual(ids(plan, 'runs'), [runId]);
  assert.equal(plan.docs.length, 4, 'no packs docs in this plan');
  for (const d of plan.docs) assert.equal(typeof d.data.updatedAt, 'string', `${d.collection}/${d.id} carries updatedAt`);
  const project = plan.docs.find((d) => d.collection === 'projects').data;
  assert.equal(project.updatedAt, store.readProject(SLUG).updated, 'the store\'s updated stamp is sent as updatedAt');
  assert.equal(typeof project.score.score, 'number', 'the latest score travels in the project doc');
  assert.ok(!Number.isNaN(Date.parse(plan.cursor)));
});

test('planPush docs are valid against the finding and run schemas, and a finding carries its disposition (null when none)', () => {
  seed();
  store.setDisposition(SLUG, ID_A, { status: 'accepted_risk', reason: 'tracked', by: 'owner' });
  const plan = planPush(SLUG, { now: NOW });
  for (const d of plan.docs.filter((x) => x.collection === 'findings')) {
    const { ok, errors } = validate(loadSchema('finding'), d.data);
    assert.ok(ok, errors.join('; '));
  }
  const run = plan.docs.find((d) => d.collection === 'runs');
  assert.ok(validate(loadSchema('run'), run.data).ok);
  const byId = Object.fromEntries(plan.docs.filter((d) => d.collection === 'findings').map((d) => [d.id, d.data]));
  assert.equal(byId[ID_A].disposition.status, 'accepted_risk');
  assert.equal(byId[ID_A].disposition.by, 'owner');
  assert.equal(byId[ID_B].disposition, null);
});

test('planPush after one upsert lists exactly the changed finding', () => {
  seed();
  const { cursor } = planSettled(SLUG, { now: NOW });
  assert.deepEqual(planSettled(SLUG, { since: cursor, now: NOW }).docs, [], 'nothing changed since the cursor');
  tick();
  store.upsertFindings(SLUG, [finding(ID_A, { severity: 'CRITICAL' })], '2026-10-23T18-02-11Z');
  const plan = planSettled(SLUG, { since: cursor, now: NOW });
  assert.deepEqual(plan.docs.map((d) => `${d.collection}/${d.id}`), [`findings/${ID_A}`]);
  assert.equal(plan.docs[0].data.severity, 'CRITICAL');
});

test('a disposition, a closed finding and a finished run each move updatedAt, so planPush sees them', () => {
  seed();
  let { cursor } = planSettled(SLUG, { now: NOW });
  tick();
  store.setDisposition(SLUG, ID_B, { status: 'false_positive', reason: 'dev only', by: 'owner' });
  let plan = planSettled(SLUG, { since: cursor, now: NOW });
  assert.deepEqual(plan.docs.map((d) => d.id), [ID_B]);
  assert.equal(plan.docs[0].data.disposition.status, 'false_positive');

  ({ cursor } = plan);
  tick();
  const run = store.createRun(SLUG, { job: 'audit', layers: ['L1'], systems: ['web'], executor: 'local' });
  assert.deepEqual(planSettled(SLUG, { since: cursor, now: NOW }).docs, [], 'a run still running is not pushed');
  store.finishRun(SLUG, run.runId, { status: 'done' });
  plan = planSettled(SLUG, { since: cursor, now: NOW });
  assert.deepEqual(plan.docs.map((d) => `${d.collection}/${d.id}`), [`runs/${run.runId}`]);
  assert.equal(plan.docs[0].data.reportMd, undefined, 'no REPORT.md, no reportMd');

  ({ cursor } = plan);
  tick();
  store.closeMissing(SLUG, { system: 'web', source: 'npm-audit', runId: run.runId, seenIds: [ID_B] });
  assert.deepEqual(planSettled(SLUG, { since: cursor, now: NOW }).docs.map((d) => d.id), [ID_A]);
});

test('a changed project and a new score snapshot each plan the project doc', () => {
  seed();
  let { cursor } = planSettled(SLUG, { now: NOW });
  tick();
  store.appendScore(SLUG, { kind: 'project', score: 70, grade: 'C', trend: null });
  let plan = planSettled(SLUG, { since: cursor, now: NOW });
  assert.deepEqual(plan.docs.map((d) => `${d.collection}/${d.id}`), [`projects/${SLUG}`]);
  ({ cursor } = plan);
  tick();
  store.writeProject({ ...store.readProject(SLUG), cloudAllowed: true });
  plan = planSettled(SLUG, { since: cursor, now: NOW });
  assert.equal(plan.docs[0].data.cloudAllowed, true);
});

test('a run doc carries REPORT.md as reportMd, redacted and cut so the serialized doc stays under 256 KiB by bytes', () => {
  const runId = seed();
  let run = planPush(SLUG, { now: NOW }).docs.find((d) => d.collection === 'runs').data;
  assert.ok(run.reportMd.startsWith('# Report'));
  assert.ok(run.reportMd.includes('PASSWORD=[REDACTED]') && !run.reportMd.includes(PLANTED));
  const huge = { ascii: 'x'.repeat(300000), 'multi-byte': '\u00e9'.repeat(200000), 'escaped newlines': '\n'.repeat(200000), emoji: '\u{1F600}'.repeat(100000) };
  for (const [what, filler] of Object.entries(huge)) {
    fs.writeFileSync(path.join(runDir(SLUG, runId), 'REPORT.md'), `# Long\n${filler}`);
    run = planPush(SLUG, { now: NOW }).docs.find((d) => d.collection === 'runs').data;
    assert.ok(Buffer.byteLength(JSON.stringify(run)) < 256 * 1024, `${what}: inside the 256 KiB doc cap`);
    assert.ok(Buffer.byteLength(JSON.stringify(run)) > 200 * 1024, `${what}: not cut far below the cap`);
    assert.ok(run.reportMd.startsWith('# Long'));
    assert.ok(!/[\uD800-\uDBFF]$/.test(run.reportMd), `${what}: no half surrogate pair at the cut`);
  }
});

test('planPush batches are ArtifactData entries chunked at 50: set when the version is unknown, update with if_version when known', () => {
  seed();
  const run = store.createRun(SLUG, { job: 'audit', layers: ['L1'], systems: ['web'], executor: 'local' });
  const many = Array.from({ length: 120 }, (_, i) => finding(i.toString(16).padStart(12, '0'), { title: `Bulk ${i}` }));
  store.upsertFindings(SLUG, many, run.runId);
  const plan = planPush(SLUG, { now: NOW, versions: { [`findings/${ID_A}`]: 'v7', [`projects/${SLUG}`]: 3 } });
  assert.equal(plan.docs.length, 1 + 2 + 120 + 1, "project, two seeded findings, 120 bulk findings, one finished run");
  assert.deepEqual(plan.batches.map((b) => b.length), [50, 50, 24]);
  const entries = plan.batches.flat();
  assert.equal(entries.length, plan.docs.length);
  for (const e of entries) assert.deepEqual(Object.keys(e).filter((k) => !['if_version'].includes(k)).sort(), ['collection', 'data', 'doc_id', 'op']);
  const a = entries.find((e) => e.collection === 'findings' && e.doc_id === ID_A);
  assert.equal(a.op, 'update');
  assert.equal(a.if_version, 'v7');
  assert.equal(entries.find((e) => e.collection === 'projects').if_version, 3);
  const b = entries.find((e) => e.collection === 'findings' && e.doc_id === ID_B);
  assert.equal(b.op, 'set');
  assert.equal('if_version' in b, false);
});

test('planPush rejects a since that is not an ISO date, an unknown project and bad versions', () => {
  seed();
  assert.throws(() => planPush(SLUG, { since: 'yesterday' }), RangeError);
  assert.throws(() => planPush('no-such-app'), /not found/);
  assert.throws(() => planPush(SLUG, { versions: [] }), TypeError);
});

// ---- applyPull --------------------------------------------------------------------------------

const pageFinding = (id, disposition, updatedAt) => ({
  collection: 'findings', id, data: { ...store.readFindings(SLUG).find((f) => f.id === id), disposition, updatedAt },
});

test('applyPull: a page accepted_risk beats a local regressed', () => {
  const runId = seed();
  store.setDisposition(SLUG, ID_A, { status: 'fixed', reason: 'upgraded', by: 'rampart' });
  store.upsertFindings(SLUG, [finding(ID_A)], runId); // reappears
  assert.equal(store.readFindings(SLUG).find((f) => f.id === ID_A).status, 'regressed');
  assert.equal(store.readDispositions(SLUG)[ID_A].status, 'regressed');

  const page = { status: 'accepted_risk', reason: 'internal tool only', by: 'user-123', at: '2026-10-23T09:00:00.000Z' };
  const result = applyPull(SLUG, [pageFinding(ID_A, page, '2026-10-23T09:00:00.000Z')]);
  assert.deepEqual(result, { applied: 1, skipped: 0 });
  assert.equal(store.readFindings(SLUG).find((f) => f.id === ID_A).status, 'accepted_risk');
  assert.deepEqual(store.readDispositions(SLUG)[ID_A], { status: 'accepted_risk', reason: 'internal tool only', by: 'user-123', at: page.at });
  assert.deepEqual(applyPull(SLUG, [pageFinding(ID_A, page, page.at)]), { applied: 0, skipped: 1 }, 'a second pull is a no-op');
});

test('applyPull: a page by "rampart" disposition does not beat a newer local one, and does beat an older one', () => {
  const runId = seed();
  store.setDisposition(SLUG, ID_A, { status: 'fixed', reason: 'upgraded', by: 'rampart' });
  tick();
  store.upsertFindings(SLUG, [finding(ID_A)], runId); // regressed locally, now
  const local = store.readFindings(SLUG).find((f) => f.id === ID_A);
  assert.equal(local.status, 'regressed');

  const old = { status: 'fixed', reason: 'not reproduced', by: 'rampart', at: PAST };
  assert.deepEqual(applyPull(SLUG, [pageFinding(ID_A, old, PAST)]), { applied: 0, skipped: 1 });
  assert.equal(store.readFindings(SLUG).find((f) => f.id === ID_A).status, 'regressed', 'the newer local state stands');

  const newer = { status: 'fixed', reason: 'not reproduced', by: 'rampart', at: FUTURE };
  assert.deepEqual(applyPull(SLUG, [pageFinding(ID_A, newer, FUTURE)]), { applied: 1, skipped: 0 });
  assert.equal(store.readFindings(SLUG).find((f) => f.id === ID_A).status, 'fixed', 'a newer automated change applies');
});

test('applyPull: an automated page disposition never beats a local decision by a person; a later local person decision beats an earlier page one', () => {
  seed();
  store.setDisposition(SLUG, ID_A, { status: 'false_positive', reason: 'checked', by: 'owner', at: '2026-10-23T10:00:00.000Z' });
  const auto = { status: 'fixed', reason: 'not reproduced', by: 'rampart', at: FUTURE };
  assert.deepEqual(applyPull(SLUG, [pageFinding(ID_A, auto, FUTURE)]), { applied: 0, skipped: 1 });
  assert.equal(store.readFindings(SLUG).find((f) => f.id === ID_A).status, 'false_positive');

  const earlier = { status: 'accepted_risk', reason: 'older call', by: 'user-123', at: '2026-10-23T08:00:00.000Z' };
  assert.deepEqual(applyPull(SLUG, [pageFinding(ID_A, earlier, earlier.at)]), { applied: 0, skipped: 1 });
  assert.equal(store.readDispositions(SLUG)[ID_A].by, 'owner', 'the later local decision stands');

  const later = { status: 'accepted_risk', reason: 'new call', by: 'user-123', at: '2026-10-23T11:00:00.000Z' };
  assert.deepEqual(applyPull(SLUG, [pageFinding(ID_A, later, later.at)]), { applied: 1, skipped: 0 });
  assert.equal(store.readFindings(SLUG).find((f) => f.id === ID_A).status, 'accepted_risk');
});

test('applyPull skips findings it does not know, other projects, null dispositions and malformed docs; ignores other collections', () => {
  seed();
  const page = { status: 'accepted_risk', reason: 'r', by: 'user-123', at: '2026-10-23T09:00:00.000Z' };
  const known = store.readFindings(SLUG).find((f) => f.id === ID_A);
  const result = applyPull(SLUG, [
    { collection: 'findings', id: 'ffffffffffff', data: { ...known, id: 'ffffffffffff', disposition: page } },
    { collection: 'findings', id: ID_A, data: { ...known, project: 'other-app', disposition: page } },
    { collection: 'findings', id: ID_A, data: { ...known, disposition: null } },
    { collection: 'findings', id: ID_A, data: { ...known, disposition: { ...page, by: '' } } },
    { collection: 'findings', id: ID_A, data: { ...known, disposition: { ...page, status: 'regressed' } } },
    { collection: 'findings', id: ID_A, data: null },
    { collection: 'runs', id: 'x', data: {} },
    'junk',
  ]);
  assert.deepEqual(result, { applied: 0, skipped: 6 });
  assert.equal(store.readFindings(SLUG).find((f) => f.id === ID_A).status, 'open');
  assert.throws(() => applyPull(SLUG, {}), TypeError);
});

const job = (over = {}) => ({
  id: 'job-1', type: 'audit', project: SLUG, system: 'web', layer: 'L1', executorKind: 'local', status: 'queued',
  createdBy: 'user-123', confirmedAt: '2026-10-23T09:00:00.000Z', costShown: '5 agents', updatedAt: '2026-10-23T09:00:00.000Z', ...over,
});

test('applyPull mirrors jobs into ~/.rampart/jobs/<id>.json; an older or equal page copy does not replace a local one', () => {
  seed();
  assert.deepEqual(applyPull(SLUG, [{ collection: 'jobs', id: 'job-1', data: job() }]), { applied: 1, skipped: 0 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'jobs', 'job-1.json'), 'utf8')), job());
  assert.deepEqual(store.readJobs(SLUG).map((j) => j.id), ['job-1']);

  const claimed = job({ status: 'claimed', claimedBy: 'sess-1', updatedAt: '2026-10-23T09:05:00.000Z' });
  assert.deepEqual(applyPull(SLUG, [{ collection: 'jobs', id: 'job-1', data: claimed }]), { applied: 1, skipped: 0 });
  assert.equal(store.readJob('job-1').status, 'claimed');
  assert.deepEqual(applyPull(SLUG, [{ collection: 'jobs', id: 'job-1', data: job() }]), { applied: 0, skipped: 1 }, 'older');
  assert.deepEqual(applyPull(SLUG, [{ collection: 'jobs', id: 'job-1', data: claimed }]), { applied: 0, skipped: 1 }, 'equal');
  assert.equal(store.readJob('job-1').status, 'claimed');
});

test('applyPull skips jobs of another project, invalid jobs and ids that cannot be file names', () => {
  seed();
  const result = applyPull(SLUG, [
    { collection: 'jobs', id: 'j2', data: job({ id: 'j2', project: 'other-app' }) },
    { collection: 'jobs', id: 'j3', data: job({ id: 'j3', type: 'nonsense' }) },
    { collection: 'jobs', id: 'x', data: job({ id: '../escape' }) },
    { collection: 'jobs', id: 'j4', data: { id: 'j4', project: SLUG } },
  ]);
  assert.deepEqual(result, { applied: 0, skipped: 4 });
  assert.deepEqual(store.readJobs(), []);
  assert.ok(!fs.existsSync(path.join(home, 'escape.json')));
});

test('applyPull applies page-written project settings when the doc is newer, and only then', () => {
  seed();
  const doc = (over, updatedAt) => ({
    collection: 'projects', id: SLUG, data: { ...publicProject(store.readProject(SLUG)), updatedAt, ...over },
  });
  const settings = { cloudAllowed: true, defaultExecutor: 'cloud', huntEffort: 'high', cadenceOverrides: { web: { L1: 3, L3: 9 }, db: { INFRA: 14 }, nope: { L1: 1 } } };

  assert.deepEqual(applyPull(SLUG, [doc(settings, PAST)]), { applied: 0, skipped: 1 }, 'older than the project');
  assert.equal(store.readProject(SLUG).cloudAllowed, false);

  assert.deepEqual(applyPull(SLUG, [doc(settings, FUTURE)]), { applied: 1, skipped: 0 });
  const p = store.readProject(SLUG);
  assert.equal(p.cloudAllowed, true);
  assert.equal(p.defaultExecutor, 'cloud');
  assert.equal(p.huntEffort, 'high');
  assert.equal(p.systems[0].layers.L1.cadenceDays, 3);
  assert.equal(p.systems[0].layers.L3, undefined, 'an override never switches a layer on');
  assert.equal(p.systems[1].layers.INFRA.cadenceDays, 14);
  assert.deepEqual(p.ownerAttestation.by, 'owner', 'private fields stay as they were');
  assert.equal(p.systems[0].repo.paths.other, '/home/someone/web', 'local paths survive a pull');

  assert.deepEqual(applyPull(SLUG, [doc(settings, FUTURE)]), { applied: 0, skipped: 1 }, 'the write moved updated past the doc');
  assert.deepEqual(applyPull(SLUG, [{ ...doc({}, FUTURE), id: 'other-app' }]), { applied: 0, skipped: 1 });
  assert.deepEqual(applyPull(SLUG, [doc({ cloudAllowed: 'yes', defaultExecutor: 'moon', huntEffort: 'max', cadenceOverrides: { web: { L1: 0 } } }, FUTURE)]), { applied: 0, skipped: 1 }, 'invalid settings change nothing');
});

// ---- store pieces the planner relies on -------------------------------------------------------

test('the store stamps updatedAt on findings and runs; setDisposition keeps a pulled decision\'s own time', () => {
  const runId = seed();
  const f = store.readFindings(SLUG).find((x) => x.id === ID_A);
  assert.equal(f.updatedAt, f.firstSeen);
  assert.ok(store.readRuns(SLUG).find((r) => r.runId === runId).updatedAt);
  store.setDisposition(SLUG, ID_A, { status: 'fixed', reason: 'r', by: 'user-1', at: '2026-10-23T09:00:00.000Z' });
  assert.equal(store.readDispositions(SLUG)[ID_A].at, '2026-10-23T09:00:00.000Z');
  const stamped = store.readFindings(SLUG).find((x) => x.id === ID_A).updatedAt;
  assert.ok(stamped > '2026-10-23T09:00:00.000Z' && stamped >= f.updatedAt, 'the finding is stamped now, so an incremental push never misses the status change');
  store.setDisposition(SLUG, ID_A, { status: 'open', reason: 'r', by: 'user-1', at: 'not a time' });
  assert.ok(Number.isFinite(Date.parse(store.readDispositions(SLUG)[ID_A].at)), 'an unparseable time falls back to now');
});

test('an unchanged re-sighting moves lastSeen but not updatedAt', () => {
  const runId = seed();
  const before = store.readFindings(SLUG).find((x) => x.id === ID_A);
  tick();
  store.upsertFindings(SLUG, [finding(ID_A)], runId);
  const after = store.readFindings(SLUG).find((x) => x.id === ID_A);
  assert.equal(after.updatedAt, before.updatedAt);
  assert.ok(after.lastSeen > before.lastSeen);
});

test('readJobs is empty without a jobs folder; writeJob validates and readJob rejects a path-like id', () => {
  assert.deepEqual(store.readJobs(), []);
  assert.equal(store.readJob('missing'), null);
  assert.throws(() => store.writeJob({ id: 'j', type: 'audit' }), /job is invalid/);
  assert.throws(() => store.readJob('../x'), RangeError);
  store.writeJob(job({ id: 'b-job', updatedAt: '2026-10-23T10:00:00.000Z' }));
  store.writeJob(job({ id: 'a-job', updatedAt: '2026-10-23T11:00:00.000Z' }));
  assert.deepEqual(store.readJobs().map((j) => j.id), ['b-job', 'a-job'], 'oldest first');
  assert.deepEqual(store.readJobs('other-app'), []);
});

// ---- CLI --------------------------------------------------------------------------------------

const cli = (...args) => spawnSync(process.execPath, [SYNC, ...args], { env: { ...process.env, RAMPART_HOME: home }, encoding: 'utf8' });

test('CLI push writes one body per doc and batches.json with file_path entries, and no store data on stdout', () => {
  const runId = seed();
  const out = path.join(home, 'out dir');
  const versionsFile = path.join(home, 'versions.json');
  fs.writeFileSync(versionsFile, JSON.stringify({ [`findings/${ID_A}`]: 4 }));
  const r = cli('push', '--project', SLUG, '--versions', versionsFile, '--out', out);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^4 docs in 1 batches, cursor \d{4}-/);
  const { cursor, batches } = JSON.parse(fs.readFileSync(path.join(out, 'batches.json'), 'utf8'));
  assert.ok(Number.isFinite(Date.parse(cursor)));
  assert.equal(batches.length, 1);
  const entries = batches[0];
  assert.deepEqual(entries.map((e) => `${e.collection}/${e.doc_id}`).sort(), [`findings/${ID_A}`, `findings/${ID_B}`, `projects/${SLUG}`, `runs/${runId}`]);
  for (const e of entries) {
    assert.ok(!('data' in e), 'the body is in the file, not the batch');
    assert.equal(e.file_path, path.join(out, 'docs', e.collection, `${e.doc_id}.json`));
    assert.equal(JSON.parse(fs.readFileSync(e.file_path, 'utf8')).updatedAt !== undefined, true);
  }
  const a = entries.find((e) => e.doc_id === ID_A);
  assert.deepEqual([a.op, a.if_version], ['update', 4]);
  assert.equal(entries.find((e) => e.doc_id === ID_B).op, 'set');

  const second = cli('push', '--project', SLUG, '--since', cursor, '--out', out);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /^0 docs in 0 batches/);
  assert.ok(!fs.existsSync(path.join(out, 'docs')), 'files of the earlier plan are cleared');
});

test('CLI pull reads a JSON array of docs and an ArtifactData-style tree (bare bodies and {id, data, version} wrappers)', () => {
  seed();
  const page = { status: 'accepted_risk', reason: 'r', by: 'user-123', at: '2026-10-23T09:00:00.000Z' };
  const known = (id) => store.readFindings(SLUG).find((f) => f.id === id);

  const file = path.join(home, 'pulled.json');
  fs.writeFileSync(file, JSON.stringify([{ collection: 'findings', id: ID_A, data: { ...known(ID_A), disposition: page, updatedAt: page.at } }]));
  let r = cli('pull', '--project', SLUG, '--in', file);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'applied 1, skipped 0');
  assert.equal(known(ID_A).status, 'accepted_risk');

  const tree = path.join(home, 'tree');
  fs.mkdirSync(path.join(tree, 'findings'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'jobs'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'findings', `${ID_B}.json`), JSON.stringify({ id: ID_B, version: 'v2', data: { ...known(ID_B), disposition: page, updatedAt: page.at } }));
  fs.writeFileSync(path.join(tree, 'jobs', 'job-9.json'), JSON.stringify(job({ id: 'job-9' })));
  fs.writeFileSync(path.join(tree, 'runs', 'whatever.json'), '{}');
  r = cli('pull', '--project', SLUG, '--in', tree);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'applied 2, skipped 0');
  assert.equal(known(ID_B).status, 'accepted_risk');
  assert.equal(store.readJob('job-9').id, 'job-9');
});

test('CLI exit codes: 2 for bad arguments, 1 for a missing project or invalid JSON, 0 on success', () => {
  seed();
  const out = path.join(home, 'o');
  assert.equal(cli().status, 2);
  assert.equal(cli('sideways', '--project', SLUG).status, 2);
  assert.equal(cli('push', '--project', SLUG).status, 2, 'no --out');
  assert.equal(cli('push', '--out', out).status, 2, 'no --project');
  assert.equal(cli('push', '--project', SLUG, '--out', out, '--bogus').status, 2);
  assert.equal(cli('push', '--project', 'Bad Slug', '--out', out).status, 2);
  assert.equal(cli('push', '--project', SLUG, '--since', 'yesterday', '--out', out).status, 2);
  assert.equal(cli('pull', '--project', SLUG).status, 2, 'no --in');
  assert.equal(cli('pull', '--project', SLUG, '--in', path.join(home, 'nope.json')).status, 2);
  assert.equal(cli('push', '--project', 'no-such-app', '--out', out).status, 1);
  const bad = path.join(home, 'bad.json');
  fs.writeFileSync(bad, '{not json');
  const r = cli('pull', '--project', SLUG, '--in', bad);
  assert.equal(r.status, 1);
  assert.ok(!r.stderr.includes('not json'), 'the content is never echoed');
});

// ---- R22 and R23: finding urls, inclusive cursor ----------------------------------------------

test('R22: a finding location.url loses its query, fragment and userinfo in the page data and in the push docs', () => {
  const runId = seed();
  const url = 'https://app.example.invalid/login?token=plantedurltoken#frag';
  store.upsertFindings(SLUG, [
    finding('0000000000c3', {
      source: 'headers', layer: 'L1', ruleId: 'headers/csp-missing', title: 'No Content-Security-Policy header', class: 'hardening',
      location: { url, header: 'content-security-policy' }, evidence: 'content-security-policy is absent from the response',
    }),
  ], runId);
  assert.equal(store.readFindings(SLUG).find((f) => f.id === '0000000000c3').location.url, url, 'the local store keeps the full url');

  const page = buildPage(NOW);
  const shown = page.projects[0].findings.find((f) => f.id === '0000000000c3');
  assert.deepEqual(shown.location, { url: 'https://app.example.invalid/login', header: 'content-security-policy' });
  const pushed = planPush(SLUG, { now: NOW }).docs.find((d) => d.id === '0000000000c3').data;
  assert.deepEqual(pushed.location, shown.location);
  for (const out of [JSON.stringify(page), JSON.stringify(planPush(SLUG, { now: NOW }))]) {
    assert.ok(!out.includes('?'), 'no ? anywhere');
    assert.ok(!out.includes('plantedurltoken') && !out.includes('#frag'));
  }
  // Other location shapes pass through untouched.
  assert.deepEqual(page.projects[0].findings.find((f) => f.id === ID_A).location, finding(ID_A).location);
});

test('R23: a doc stamped exactly at since is planned again (the cursor is inclusive, so a re-push is idempotent)', () => {
  seed();
  const stamp = store.readFindings(SLUG).find((f) => f.id === ID_A).updatedAt;
  const plan = planPush(SLUG, { since: stamp, now: NOW });
  assert.ok(plan.docs.some((d) => d.collection === 'findings' && d.id === ID_A), 'updatedAt equal to since counts');
  tick();
  const later = planPush(SLUG, { since: new Date().toISOString(), now: NOW });
  assert.deepEqual(later.docs, [], 'a since after every stamp plans nothing');
});

// ---- fix round 1: merge rule (R25), safe plan output, id check, cadenceOverrides ---------------

const person = (status, at, over = {}) => ({ status, reason: 'from the page', by: 'user-1', at, ...over });
const statusOf = (id) => store.readFindings(SLUG).find((f) => f.id === id).status;

test('R25: a page fixed decision older than a later local regression does not hide it, now or on any later pull', () => {
  const runId = seed();
  const fixed = person('fixed', PAST);
  assert.deepEqual(applyPull(SLUG, [pageFinding(ID_A, fixed, PAST)]), { applied: 1, skipped: 0 });
  assert.equal(statusOf(ID_A), 'fixed');
  tick();
  store.upsertFindings(SLUG, [finding(ID_A)], runId); // a later scan sees it again
  assert.equal(statusOf(ID_A), 'regressed');
  assert.deepEqual(applyPull(SLUG, [pageFinding(ID_A, fixed, PAST)]), { applied: 0, skipped: 1 });
  assert.equal(statusOf(ID_A), 'regressed', 'the regression stands');
  assert.equal(store.readDispositions(SLUG)[ID_A].by, 'rampart');
  assert.equal(planPush(SLUG, { now: NOW }).docs.find((d) => d.id === ID_A).data.disposition, null, 'push does not send the stale decision back');
});

test('R25: a page accepted_risk or false_positive beats a later local regression; so does a page fixed that is newer than it', () => {
  const runId = seed();
  for (const [id, page] of [[ID_A, person('accepted_risk', PAST)], [ID_B, person('false_positive', PAST)]]) {
    store.setDisposition(SLUG, id, { status: 'fixed', reason: 'upgraded', by: 'rampart' });
    tick();
    store.upsertFindings(SLUG, [finding(id)], runId);
    assert.equal(statusOf(id), 'regressed');
    assert.deepEqual(applyPull(SLUG, [pageFinding(id, page, PAST)]), { applied: 1, skipped: 0 });
    assert.equal(statusOf(id), page.status, 'a judgment automation never overrides');
  }
});

test('R25: a page fixed decision newer than the local regression applies', () => {
  const runId = seed();
  store.setDisposition(SLUG, ID_A, { status: 'fixed', reason: 'upgraded', by: 'rampart' });
  tick();
  store.upsertFindings(SLUG, [finding(ID_A)], runId);
  assert.equal(statusOf(ID_A), 'regressed');
  assert.deepEqual(applyPull(SLUG, [pageFinding(ID_A, person('fixed', FUTURE), FUTURE)]), { applied: 1, skipped: 0 });
  assert.equal(statusOf(ID_A), 'fixed');
});

test('R25: a page open decision older than a local close-missing stays fixed', () => {
  const runId = seed();
  assert.deepEqual(applyPull(SLUG, [pageFinding(ID_A, person('open', PAST), PAST)]), { applied: 1, skipped: 0 });
  tick();
  store.closeMissing(SLUG, { system: 'web', source: 'npm-audit', runId, seenIds: [] });
  assert.equal(statusOf(ID_A), 'fixed');
  assert.deepEqual(applyPull(SLUG, [pageFinding(ID_A, person('open', PAST), PAST)]), { applied: 0, skipped: 1 });
  assert.equal(statusOf(ID_A), 'fixed');
  assert.deepEqual(applyPull(SLUG, [pageFinding(ID_A, person('fixed', FUTURE), FUTURE)]), { applied: 1, skipped: 0 }, 'a page fixed that is newer applies');
});

test('R25: the same page decision pulled twice applies once; a newer page decision by a person replaces it', () => {
  seed();
  const page = person('accepted_risk', '2026-10-23T09:00:00.000Z');
  assert.deepEqual(applyPull(SLUG, [pageFinding(ID_A, page, page.at)]), { applied: 1, skipped: 0 });
  assert.deepEqual(applyPull(SLUG, [pageFinding(ID_A, page, page.at)]), { applied: 0, skipped: 1 });
  const newer = person('false_positive', '2026-10-23T10:00:00.000Z');
  assert.deepEqual(applyPull(SLUG, [pageFinding(ID_A, newer, newer.at)]), { applied: 1, skipped: 0 });
  assert.equal(statusOf(ID_A), 'false_positive');
  assert.deepEqual(applyPull(SLUG, [pageFinding(ID_A, page, page.at)]), { applied: 0, skipped: 1 }, 'the older person decision does not come back');
});

test('minor 4: a doc whose id differs from its data.id is skipped and writes nothing', () => {
  seed();
  const known = store.readFindings(SLUG).find((f) => f.id === ID_A);
  const result = applyPull(SLUG, [
    { collection: 'jobs', id: 'job-A', data: job({ id: 'job-B' }) },
    { collection: 'findings', id: ID_B, data: { ...known, disposition: person('accepted_risk', PAST), updatedAt: PAST } },
  ]);
  assert.deepEqual(result, { applied: 0, skipped: 2 });
  assert.equal(store.readJob('job-B'), null);
  assert.equal(statusOf(ID_A), 'open');
  assert.equal(statusOf(ID_B), 'open');
});

test('R26: a project doc carries cadenceOverrides: null so a consumed page override does not linger', () => {
  seed();
  const doc = planPush(SLUG, { now: NOW }).docs.find((d) => d.collection === 'projects').data;
  assert.ok('cadenceOverrides' in doc);
  assert.equal(doc.cadenceOverrides, null);
});

test('CLI push refuses an --out that is not empty and holds no earlier plan, and leaves it untouched', () => {
  seed();
  const out = path.join(home, 'project root');
  fs.mkdirSync(path.join(out, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(out, 'docs', 'precious.md'), 'keep me');
  fs.writeFileSync(path.join(out, 'package.json'), '{}');
  let r = cli('push', '--project', SLUG, '--out', out);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /not empty/);
  assert.equal(fs.readFileSync(path.join(out, 'docs', 'precious.md'), 'utf8'), 'keep me');
  assert.deepEqual(fs.readdirSync(out).sort(), ['docs', 'package.json']);

  fs.writeFileSync(path.join(out, 'batches.json'), '{not a plan');
  r = cli('push', '--project', SLUG, '--out', out);
  assert.equal(r.status, 2, 'a batches.json that is not a plan does not count');
  assert.equal(fs.readFileSync(path.join(out, 'docs', 'precious.md'), 'utf8'), 'keep me');

  const dot = cli('push', '--project', SLUG, '--out', '.');
  assert.equal(dot.status, 2, 'the project root of this repo is not an output folder');
});

test('CLI push reuses an --out that holds an earlier plan: removes only the files that plan listed', () => {
  seed();
  const out = path.join(home, 'plan out');
  assert.equal(cli('push', '--project', SLUG, '--out', out).status, 0);
  const first = JSON.parse(fs.readFileSync(path.join(out, 'batches.json'), 'utf8')).batches.flat();
  assert.equal(first.length, 4);
  const stranger = path.join(out, 'docs', 'findings', 'notes.txt');
  fs.writeFileSync(stranger, 'not part of the plan');

  const since = new Date(Date.now() + 60000).toISOString();
  const r = cli('push', '--project', SLUG, '--since', since, '--out', out);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^0 docs in 0 batches/);
  for (const e of first) assert.ok(!fs.existsSync(e.file_path), 'the earlier plan\'s file is gone');
  assert.equal(fs.readFileSync(stranger, 'utf8'), 'not part of the plan', 'a file the plan did not list stays');
  assert.ok(!fs.existsSync(path.join(out, 'docs', 'projects')) && !fs.existsSync(path.join(out, 'docs', 'runs')), 'emptied folders are removed');

  fs.rmSync(stranger);
  assert.equal(cli('push', '--project', SLUG, '--out', out).status, 0);
  assert.equal(cli('push', '--project', SLUG, '--since', since, '--out', out).status, 0);
  assert.ok(!fs.existsSync(path.join(out, 'docs')), 'the docs folder goes when it is empty');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'batches.json'), 'utf8')).batches, []);
});

test('CLI push never deletes outside <out>/docs even when an earlier batches.json names such a file', () => {
  seed();
  const out = path.join(home, 'plan out 2');
  assert.equal(cli('push', '--project', SLUG, '--out', out).status, 0);
  const victim = path.join(home, 'victim.txt');
  fs.writeFileSync(victim, 'safe');
  const plan = JSON.parse(fs.readFileSync(path.join(out, 'batches.json'), 'utf8'));
  plan.batches[0][0].file_path = victim;
  fs.writeFileSync(path.join(out, 'batches.json'), JSON.stringify(plan));
  assert.equal(cli('push', '--project', SLUG, '--out', out).status, 0);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'safe');
});
