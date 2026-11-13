const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const store = require('../scripts/store.cjs');
const hio = require('../scripts/hunt-io.cjs');
const { fromHunt } = require('../scripts/normalize.cjs');
const { validate, loadSchema } = require('../scripts/lib/validate.cjs');
const { runDir } = require('../scripts/lib/paths.cjs');
const { machineId } = require('../scripts/lib/paths.cjs');

const CLI = path.join(__dirname, '..', 'scripts', 'hunt-io.cjs');
const FIX = path.join(__dirname, 'fixtures');
const TARGET = path.join(FIX, 'repos', 'hunt-target');
const SLUG = 'example-app';
const SYS = 'web';
const LAYER = 'L3';
// Fake test values, assembled at run time so secret scanners do not read them as committed credentials.
const TOKEN = ['q8Zx3Lm9', 'Vb2NkR7t', 'Yw4Pc1Hd'].join('');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const FAKE_JWT = [b64({ alg: 'HS256' }), b64({ sub: '1234567890' }), 'abcdefghij'].join('.');

const fixtureText = (kind, name) => fs.readFileSync(path.join(FIX, 'hunt', kind, `${name}.json`), 'utf8');
const rawCandidates = (name) => JSON.parse(fixtureText('candidates', name));
const rawVote = (name) => JSON.parse(fixtureText('votes', name));

const savedHome = process.env.RAMPART_HOME;
let home;
test.beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart hunt '));
  process.env.RAMPART_HOME = home;
});
test.afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.RAMPART_HOME;
  else process.env.RAMPART_HOME = savedHome;
});

const projectObject = (over = {}) => ({
  slug: SLUG,
  name: 'Example App',
  criticality: 'high',
  ownerAttestation: { statement: 'I own every system listed here', by: '<owner>', at: '2026-10-23T00:00:00Z' },
  defaultExecutor: 'local',
  cloudAllowed: false,
  systems: [
    { id: SYS, type: 'web-nextjs', name: 'Web', packs: ['web-nextjs'], repo: { remote: 'github.com/<owner>/example-app', defaultBranch: 'main', paths: { [machineId()]: TARGET } }, executor: 'local', layers: { L3: { cadenceDays: 90 } } },
    { id: 'db', type: 'supabase', name: 'Supabase', packs: ['supabase'], host: { ssh: '<ssh-user>@192.0.2.10', composeProject: '<compose-project>' }, executor: 'local', layers: { INFRA: { cadenceDays: 30 } } },
  ],
  ...over,
});

// A project and a run whose units.json lists the given units and hunters ([unit, classId] pairs), as init would have written it.
const CLASSES = [
  { pack: 'web-nextjs', packVersion: '1.0.0', classId: 'authz-scoping', title: 'Record access not scoped', text: 'x' },
  { pack: 'web-nextjs', packVersion: '1.0.0', classId: 'bulk-export', title: 'Bulk export', text: 'x' },
];
const fileKey = hio.fileKey;
const keyOf = (unit, classId) => `${fileKey(unit)}__${classId}`;

function setup({ units = ['app/api/users', 'app/api/export'], hunters = null, layer = LAYER } = {}) {
  store.writeProject(projectObject());
  const run = store.createRun(SLUG, { job: 'audit', layers: [layer], systems: [SYS], executor: 'local' });
  const planned = hunters || units.map((u) => (typeof u === 'string' ? u : u.id)).flatMap((u) => ['authz-scoping', 'bulk-export'].map((c) => [u, c]));
  const doc = {
    layer, effort: 'high', system: SYS, repoRoot: TARGET,
    units: units.map((u) => (typeof u === 'string' ? { id: u, kind: 'dir', files: 1, reachable: true } : { kind: 'dir', files: 1, reachable: true, ...u })),
    classes: CLASSES,
    hunters: planned.map(([unit, classId]) => ({ key: keyOf(unit, classId), system: SYS, unit, classId, pack: 'web-nextjs', packVersion: '1.0.0' })),
  };
  const dir = runDir(SLUG, run.runId);
  fs.mkdirSync(path.join(dir, 'candidates'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'votes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'units.json'), JSON.stringify(doc, null, 2));
  return { runId: run.runId, dir, doc };
}

const putCandidates = (s, unit, classId, fixture) => hio.writeCandidate(SLUG, s.runId, keyOf(unit, classId), rawCandidates(fixture));
const putVote = (s, unit, classId, ref, n, fixture) => hio.writeVote(SLUG, s.runId, `${keyOf(unit, classId)}__${ref}__${n}.json`, rawVote(fixture));
const sorted = (set) => set.map((e) => e.candidate.title);
const talliedFor = (s) => hio.tally(hio.readCandidates(SLUG, s.runId), hio.readVotes(SLUG, s.runId));

// ---- tally -----------------------------------------------------------------------------------

test('tally: one confirm of a MEDIUM candidate verifies it', () => {
  const s = setup();
  putCandidates(s, 'app/api/users', 'authz-scoping', 'medium-idor');
  putVote(s, 'app/api/users', 'authz-scoping', 'c1', 1, 'confirm');
  const t = talliedFor(s);
  assert.equal(t.verified.length, 1);
  assert.equal(t.rejected.length + t.undecided.length, 0);
  assert.equal(t.verified[0].votes.length, 1);
});

test('tally: a HIGH candidate with one confirm is undecided', () => {
  const s = setup();
  putCandidates(s, 'app/api/export', 'bulk-export', 'high-export');
  putVote(s, 'app/api/export', 'bulk-export', 'c1', 1, 'confirm');
  const t = talliedFor(s);
  assert.equal(t.verified.length, 0);
  assert.equal(t.undecided.length, 1);
});

test('tally: two confirms and a reject verify a HIGH candidate, severity is the confirmers\' minimum', () => {
  const s = setup();
  putCandidates(s, 'app/api/export', 'bulk-export', 'high-export');
  putVote(s, 'app/api/export', 'bulk-export', 'c1', 1, 'confirm-high');
  putVote(s, 'app/api/export', 'bulk-export', 'c1', 2, 'confirm-medium');
  putVote(s, 'app/api/export', 'bulk-export', 'c1', 3, 'reject');
  const t = talliedFor(s);
  assert.equal(t.verified.length, 1);
  const { candidate, votes } = t.verified[0];
  assert.equal(votes.length, 3);
  const confirming = votes.filter((v) => v.verdict === 'confirmed');
  const f = fromHunt(candidate, confirming, { project: SLUG, runId: s.runId, totalVotes: votes.length });
  assert.equal(f.severity, 'MEDIUM'); // min(HIGH, MEDIUM)
  assert.equal(f.confidence, 'MEDIUM'); // min over hunter HIGH and confirmers HIGH, MEDIUM
  assert.deepEqual(f.verification, { verifiers: 3, confirmed: 2, run: s.runId });
});

test('tally: a lone unsure is undecided; two rejects reject; a 1-1 tie and zero votes are undecided', () => {
  const s = setup({ units: ['app/api/users'] });
  const cases = [['unsure', 'undecided'], ['reject', 'rejected']];
  putCandidates(s, 'app/api/users', 'authz-scoping', 'medium-idor');
  putVote(s, 'app/api/users', 'authz-scoping', 'c1', 1, 'unsure');
  assert.equal(talliedFor(s).undecided.length, 1);
  fs.rmSync(path.join(s.dir, 'votes'), { recursive: true });
  fs.mkdirSync(path.join(s.dir, 'votes'));
  putVote(s, 'app/api/users', 'authz-scoping', 'c1', 1, 'reject');
  putVote(s, 'app/api/users', 'authz-scoping', 'c1', 2, 'reject');
  const t = talliedFor(s);
  assert.equal(t.rejected.length, 1);
  assert.equal(t.verified.length + t.undecided.length, 0);
  fs.rmSync(path.join(s.dir, 'votes', `${keyOf('app/api/users', 'authz-scoping')}__c1__2.json`));
  putVote(s, 'app/api/users', 'authz-scoping', 'c1', 2, 'confirm');
  assert.equal(talliedFor(s).undecided.length, 1, '1 confirm vs 1 reject on MEDIUM is a tie');
  fs.rmSync(path.join(s.dir, 'votes'), { recursive: true });
  fs.mkdirSync(path.join(s.dir, 'votes'));
  assert.equal(talliedFor(s).undecided.length, 1, 'no votes at all');
  void cases;
});

test('tally: duplicate candidates from two hunters merge their votes', () => {
  const s = setup({ hunters: [['app/api/export', 'bulk-export'], ['lib', 'bulk-export']], units: ['app/api/export', 'lib'] });
  putCandidates(s, 'app/api/export', 'bulk-export', 'high-export');
  putCandidates(s, 'lib', 'bulk-export', 'high-export-second');
  const cands = hio.readCandidates(SLUG, s.runId);
  assert.equal(cands.length, 2);
  assert.equal(cands[0].candidateId, cands[1].candidateId);
  putVote(s, 'app/api/export', 'bulk-export', 'c1', 1, 'confirm');
  putVote(s, 'lib', 'bulk-export', 'c1', 1, 'confirm');
  const t = talliedFor(s);
  assert.equal(t.verified.length, 1, 'one confirm each: two confirms on the merged HIGH candidate');
  assert.equal(t.verified[0].votes.length, 2);
  assert.equal(t.verified[0].candidate.severity, 'HIGH', 'the bar uses the highest severity any hunter gave');
});

// ---- ingestion and redaction -----------------------------------------------------------------

test('an AWS key in evidence is stored as [REDACTED] and never kept', () => {
  const s = setup();
  putCandidates(s, 'app/api/users', 'authz-scoping', 'secret-evidence');
  const [c] = hio.readCandidates(SLUG, s.runId);
  assert.match(c.evidence, /^\[REDACTED\]/);
  const onDisk = fs.readFileSync(path.join(s.dir, 'candidates', `${keyOf('app/api/users', 'authz-scoping')}.json`), 'utf8');
  assert.ok(!onDisk.includes('AKIAFAKEFAKEFAKEFAKE'));
});

test('a high-entropy token in evidence replaces the whole evidence; in other fields only the token', () => {
  const s = setup();
  putCandidates(s, 'app/api/users', 'authz-scoping', 'entropy-evidence');
  const [c] = hio.readCandidates(SLUG, s.runId);
  assert.match(c.evidence, /^\[REDACTED\]/);
  assert.ok(!c.evidence.includes('x-internal'), 'the whole evidence goes, not just the token');
  assert.ok(!c.exploitScenario.includes(TOKEN));
  assert.match(c.exploitScenario, /^The token is reused for \[REDACTED\] style access\.$/);
});

test('a vote reason is redacted', () => {
  const s = setup();
  putCandidates(s, 'app/api/users', 'authz-scoping', 'medium-idor');
  putVote(s, 'app/api/users', 'authz-scoping', 'c1', 1, 'confirm-leaky');
  const [v] = hio.readVotes(SLUG, s.runId);
  assert.ok(!v.reason.includes('AKIAFAKEFAKEFAKEFAKE'));
  assert.ok(!v.reason.includes(TOKEN));
});

test('agent-claimed system, layer, pack and candidateId are overwritten from units.json', () => {
  const s = setup();
  putCandidates(s, 'app/api/users', 'authz-scoping', 'spoofed');
  const [c] = hio.readCandidates(SLUG, s.runId);
  assert.equal(c.system, SYS);
  assert.equal(c.layer, LAYER);
  assert.equal(c.pack, 'web-nextjs');
  assert.equal(c.packVersion, '1.0.0');
  assert.deepEqual(c.hunter, { agent: keyOf('app/api/users', 'authz-scoping'), unit: 'app/api/users' });
  assert.match(c.candidateId, /^[0-9a-f]{12}$/);
  assert.notEqual(c.candidateId, '000000000000');
  assert.deepEqual(validate(loadSchema('candidate'), c), { ok: true, errors: [] });
});

test('locations that escape the repo are invalid and never upserted', () => {
  const s = setup();
  const r = putCandidates(s, 'app/api/users', 'authz-scoping', 'bad-locations');
  assert.equal(r.candidates.length, 0);
  assert.equal(r.invalid.length, 4);
  assert.equal(hio.readCandidates(SLUG, s.runId).length, 0);
  const res = hio.assemble(SLUG, s.runId);
  assert.equal(res.counts.added, 0);
  assert.deepEqual(store.readFindings(SLUG), []);
});

test('a candidate that addresses the scan becomes a LOW hardening prompt-injection finding, still voted on', () => {
  const s = setup();
  putCandidates(s, 'app/api/users', 'authz-scoping', 'injection');
  const [c] = hio.readCandidates(SLUG, s.runId);
  assert.equal(c.flags.prompt_injection, true);
  putVote(s, 'app/api/users', 'authz-scoping', 'c1', 1, 'confirm');
  putVote(s, 'app/api/users', 'authz-scoping', 'c1', 2, 'confirm');
  const res = hio.assemble(SLUG, s.runId);
  const [f] = store.readFindings(SLUG);
  assert.equal(f.ruleId, 'rampart/prompt-injection-attempt');
  assert.equal(f.severity, 'LOW');
  assert.equal(f.class, 'hardening');
  assert.equal(f.pack, 'web-nextjs@1.0.0');
  assert.equal(res.counts.hardening, 1);
});

test('ingest is idempotent: a second pass changes nothing', () => {
  const s = setup();
  putCandidates(s, 'app/api/users', 'authz-scoping', 'injection');
  putVote(s, 'app/api/users', 'authz-scoping', 'c1', 1, 'confirm');
  const file = path.join(s.dir, 'candidates', `${keyOf('app/api/users', 'authz-scoping')}.json`);
  const before = fs.readFileSync(file, 'utf8');
  const again = hio.ingest(SLUG, s.runId);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(again.invalid, []);
  assert.equal(again.votes.length, 1);
});

test('a vote whose body names another candidate is invalid', () => {
  const s = setup();
  putCandidates(s, 'app/api/users', 'authz-scoping', 'medium-idor');
  const r = hio.writeVote(SLUG, s.runId, `${keyOf('app/api/users', 'authz-scoping')}__c1__1.json`, { ...rawVote('confirm'), candidateRef: 'other#c1' });
  assert.equal(r.invalid.length, 1);
  assert.equal(hio.readVotes(SLUG, s.runId).length, 0);
});

// ---- assemble --------------------------------------------------------------------------------

test('assemble upserts verified findings only and marks a unit whose hunter never returned failed', () => {
  const s = setup();
  putCandidates(s, 'app/api/users', 'authz-scoping', 'medium-idor');
  putCandidates(s, 'app/api/users', 'bulk-export', 'empty');
  putCandidates(s, 'app/api/export', 'authz-scoping', 'empty');
  // app/api/export / bulk-export never returned.
  putCandidates(s, 'app/api/users', 'authz-scoping', 'medium-idor');
  putVote(s, 'app/api/users', 'authz-scoping', 'c1', 1, 'confirm');
  const res = hio.assemble(SLUG, s.runId);
  assert.equal(res.counts.added, 1);
  assert.equal(res.counts.candidates, 1);
  assert.equal(res.counts.verified, 1);
  const findings = store.readFindings(SLUG);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].class, 'verified');
  assert.equal(findings[0].source, 'rampart-hunter');
  assert.equal(findings[0].ruleId, 'web-nextjs/authz-scoping');
  assert.equal(findings[0].id, res.findings[0]);
  assert.deepEqual(res.skipped.map((u) => [u.id, u.status]), [['app/api/export', 'failed']]);
  assert.match(res.skipped[0].reason, /hunter did not return: bulk-export/);
  const ledger = store.readCoverage(SLUG);
  assert.equal(ledger.units[`${SYS}|${LAYER}|app/api/users`].status, 'covered');
  assert.equal(ledger.units[`${SYS}|${LAYER}|app/api/export`].status, 'failed');
  // R47: a covered unit records the classes hunted on it and the run's effort
  assert.deepEqual(ledger.units[`${SYS}|${LAYER}|app/api/users`].classes, ['authz-scoping', 'bulk-export']);
  assert.equal(ledger.units[`${SYS}|${LAYER}|app/api/users`].effort, 'high');
  assert.ok(!('classes' in ledger.units[`${SYS}|${LAYER}|app/api/export`]));
  const doc = JSON.parse(fs.readFileSync(path.join(s.dir, 'units.json'), 'utf8'));
  assert.equal(doc.units.find((u) => u.id === 'app/api/export').status, 'failed');
  assert.equal(doc.units.find((u) => u.id === 'app/api/users').status, 'covered');
  // The run records its unit coverage, so the score credits only the share it covered.
  const run = JSON.parse(fs.readFileSync(path.join(s.dir, 'run.json'), 'utf8'));
  assert.equal(run.status, 'done');
  assert.deepEqual(run.coverage, { planned: 2, covered: 1 });
});

test('rejected and undecided candidates stay out of findings.jsonl', () => {
  const s = setup();
  putCandidates(s, 'app/api/users', 'authz-scoping', 'medium-idor');
  putCandidates(s, 'app/api/export', 'bulk-export', 'high-export');
  putVote(s, 'app/api/users', 'authz-scoping', 'c1', 1, 'reject');
  putVote(s, 'app/api/export', 'bulk-export', 'c1', 1, 'confirm');
  const res = hio.assemble(SLUG, s.runId);
  assert.deepEqual(store.readFindings(SLUG), []);
  assert.equal(res.counts.rejected, 1);
  assert.equal(res.counts.undecided, 1);
  assert.equal(res.counts.verified, 0);
});

test('nothing value-like from a candidate reaches findings.jsonl', () => {
  const s = setup();
  putCandidates(s, 'app/api/users', 'authz-scoping', 'secret-evidence');
  putVote(s, 'app/api/users', 'authz-scoping', 'c1', 1, 'confirm');
  hio.assemble(SLUG, s.runId);
  const text = fs.readFileSync(path.join(home, 'projects', SLUG, 'findings.jsonl'), 'utf8');
  assert.ok(text.includes('"class":"verified"'));
  assert.ok(!text.includes('AKIAFAKEFAKEFAKEFAKE'));
  const s2 = setup();
  putCandidates(s2, 'app/api/users', 'authz-scoping', 'entropy-evidence');
  putVote(s2, 'app/api/users', 'authz-scoping', 'c1', 1, 'confirm');
  hio.assemble(SLUG, s2.runId);
  assert.ok(!fs.readFileSync(path.join(home, 'projects', SLUG, 'findings.jsonl'), 'utf8').includes(TOKEN));
});

test('closeMissing closes a vanished finding in a covered unit and leaves one in an uncovered unit', () => {
  const s = setup({ units: ['app/api/users', 'lib'], hunters: [['app/api/users', 'authz-scoping'], ['lib', 'authz-scoping']] });
  const base = { project: SLUG, system: SYS, layer: LAYER, source: 'rampart-hunter', class: 'verified', pack: 'web-nextjs@1.0.0', severity: 'MEDIUM', confidence: 'HIGH', cwe: [], title: 't', evidence: 'e', exploitScenario: 's', preconditions: 'p', recommendation: 'r', verification: { verifiers: 1, confirmed: 1, run: '2026-10-22T00-00-00Z' }, status: 'open', externalIds: { claudeSecurityPluginFindingId: null, cve: null } };
  store.upsertFindings(SLUG, [
    { ...base, id: 'a'.repeat(12), ruleId: 'web-nextjs/authz-scoping', location: { path: 'app/api/users/gone.ts', symbol: 'GET' } },
    { ...base, id: 'b'.repeat(12), ruleId: 'web-nextjs/authz-scoping', location: { path: 'lib/auth.ts', symbol: 'check' } },
  ], '2026-10-22T00-00-00Z');
  putCandidates(s, 'app/api/users', 'authz-scoping', 'empty');
  // lib never returned
  const res = hio.assemble(SLUG, s.runId);
  assert.equal(res.counts.closed, 1);
  const byId = Object.fromEntries(store.readFindings(SLUG).map((f) => [f.id, f.status]));
  assert.equal(byId['a'.repeat(12)], 'fixed');
  assert.equal(byId['b'.repeat(12)], 'open');
});

// A stored open hunt finding of the given rule at the given path, last seen in an earlier run.
const OLD_RUN = '2026-10-22T00-00-00Z';
const storedHunt = (id, ruleId, p, over = {}) => ({
  project: SLUG, system: SYS, layer: LAYER, source: 'rampart-hunter', class: 'verified', pack: 'web-nextjs@1.0.0', severity: 'MEDIUM', confidence: 'HIGH', cwe: [],
  title: 't', evidence: 'e', exploitScenario: 's', preconditions: 'p', recommendation: 'r', verification: { verifiers: 1, confirmed: 1, run: OLD_RUN },
  status: 'open', externalIds: { claudeSecurityPluginFindingId: null, cve: null }, id, ruleId, location: { path: p, symbol: 'x' }, ...over,
});
const statusById = () => Object.fromEntries(store.readFindings(SLUG).map((f) => [f.id, f.status]));

test('R46: a low-effort L3 run closes only findings of the classes it hunted in a covered unit', () => {
  const s = setup({ units: ['app/api/users'], hunters: [['app/api/users', 'authz-scoping']] });
  store.upsertFindings(SLUG, [
    storedHunt('a'.repeat(12), 'web-nextjs/authz-scoping', 'app/api/users/gone.ts'),
    storedHunt('b'.repeat(12), 'web-nextjs/ssrf', 'app/api/users/route.ts'),
    storedHunt('c'.repeat(12), 'rampart/prompt-injection-attempt', 'app/api/users/route.ts', { class: 'hardening', severity: 'LOW' }),
  ], OLD_RUN);
  putCandidates(s, 'app/api/users', 'authz-scoping', 'empty');
  const res = hio.assemble(SLUG, s.runId);
  assert.deepEqual(statusById(), { ['a'.repeat(12)]: 'fixed', ['b'.repeat(12)]: 'open', ['c'.repeat(12)]: 'fixed' });
  assert.equal(res.counts.closed, 2);
});

test('R46: an L2 run closes only findings in the files it hunted', () => {
  const s = setup({ layer: 'L2', units: [{ id: 'lib', paths: ['lib/auth.ts'] }], hunters: [['lib', 'authz-scoping']] });
  store.upsertFindings(SLUG, [
    storedHunt('a'.repeat(12), 'web-nextjs/authz-scoping', 'lib/auth.ts', { layer: 'L2' }),
    storedHunt('b'.repeat(12), 'web-nextjs/authz-scoping', 'lib/db.ts', { layer: 'L2' }),
  ], OLD_RUN);
  putCandidates(s, 'lib', 'authz-scoping', 'empty');
  const res = hio.assemble(SLUG, s.runId);
  assert.deepEqual(statusById(), { ['a'.repeat(12)]: 'fixed', ['b'.repeat(12)]: 'open' });
  assert.equal(res.counts.closed, 1);
});

test('R46: an L2 unit with no recorded paths (an older units.json) closes nothing', () => {
  const s = setup({ layer: 'L2', units: ['lib'], hunters: [['lib', 'authz-scoping']] });
  store.upsertFindings(SLUG, [storedHunt('a'.repeat(12), 'web-nextjs/authz-scoping', 'lib/auth.ts', { layer: 'L2' })], OLD_RUN);
  putCandidates(s, 'lib', 'authz-scoping', 'empty');
  assert.equal(hio.assemble(SLUG, s.runId).counts.closed, 0);
  assert.equal(statusById()['a'.repeat(12)], 'open');
});

test('assemble writes findings.json with the ids it upserted and the ids it closed', () => {
  const s = setup({ units: ['app/api/users'], hunters: [['app/api/users', 'authz-scoping']] });
  const base = { project: SLUG, system: SYS, layer: LAYER, source: 'rampart-hunter', class: 'verified', pack: 'web-nextjs@1.0.0', severity: 'MEDIUM', confidence: 'HIGH', cwe: [], title: 't', evidence: 'e', exploitScenario: 's', preconditions: 'p', recommendation: 'r', verification: { verifiers: 1, confirmed: 1, run: '2026-10-22T00-00-00Z' }, status: 'open', externalIds: { claudeSecurityPluginFindingId: null, cve: null } };
  store.upsertFindings(SLUG, [{ ...base, id: 'a'.repeat(12), ruleId: 'web-nextjs/authz-scoping', location: { path: 'app/api/users/gone.ts', symbol: 'GET' } }], '2026-10-22T00-00-00Z');
  putCandidates(s, 'app/api/users', 'authz-scoping', 'medium-idor');
  putVote(s, 'app/api/users', 'authz-scoping', 'c1', 1, 'confirm');
  const res = hio.assemble(SLUG, s.runId);
  const doc = JSON.parse(fs.readFileSync(path.join(s.dir, 'findings.json'), 'utf8'));
  assert.deepEqual(doc, { verified: res.findings, closed: ['a'.repeat(12)], rejected: [], undecided: [] });
  assert.equal(doc.verified.length, 1);
});

test('R51 (M1): findings.json keeps the candidate ids the verifiers rejected and left undecided', () => {
  const s = setup();
  putCandidates(s, 'app/api/users', 'authz-scoping', 'medium-idor');
  putCandidates(s, 'app/api/export', 'bulk-export', 'high-export');
  putVote(s, 'app/api/users', 'authz-scoping', 'c1', 1, 'reject');
  putVote(s, 'app/api/export', 'bulk-export', 'c1', 1, 'confirm');
  hio.assemble(SLUG, s.runId);
  const byTitle = Object.fromEntries(hio.readCandidates(SLUG, s.runId).map((c) => [c.hunter.agent, c.candidateId]));
  const doc = JSON.parse(fs.readFileSync(path.join(s.dir, 'findings.json'), 'utf8'));
  assert.deepEqual(doc, { verified: [], closed: [], rejected: [byTitle[keyOf('app/api/users', 'authz-scoping')]], undecided: [byTitle[keyOf('app/api/export', 'bulk-export')]] });
});

test('all units failed: the run finishes failed with a reason, never clean', () => {
  const s = setup();
  const res = hio.assemble(SLUG, s.runId);
  assert.equal(res.skipped.length, 2);
  const run = JSON.parse(fs.readFileSync(path.join(s.dir, 'run.json'), 'utf8'));
  assert.equal(run.status, 'failed');
  assert.match(run.reason, /no unit was covered/);
  const ledger = store.readCoverage(SLUG);
  assert.ok(Object.values(ledger.units).every((e) => e.status === 'failed'));
});

test('R50: fewer than half the planned units covered finishes the run failed; the covered units still reach the ledger', () => {
  const units = ['a', 'b', 'c'];
  let s = setup({ units, hunters: units.map((u) => [u, 'authz-scoping']) });
  putCandidates(s, 'a', 'authz-scoping', 'empty');
  hio.assemble(SLUG, s.runId);
  let run = JSON.parse(fs.readFileSync(path.join(s.dir, 'run.json'), 'utf8'));
  assert.equal(run.status, 'failed');
  assert.equal(run.reason, 'only 1 of 3 units were covered');
  assert.deepEqual(validate(loadSchema('run'), run), { ok: true, errors: [] });
  assert.equal(store.readCoverage(SLUG).units[`${SYS}|${LAYER}|a`].status, 'covered');
  // exactly half is enough
  const four = ['a', 'b', 'c', 'd'];
  s = setup({ units: four, hunters: four.map((u) => [u, 'authz-scoping']) });
  putCandidates(s, 'a', 'authz-scoping', 'empty');
  putCandidates(s, 'b', 'authz-scoping', 'empty');
  hio.assemble(SLUG, s.runId);
  run = JSON.parse(fs.readFileSync(path.join(s.dir, 'run.json'), 'utf8'));
  assert.equal(run.status, 'done');
});

test('assemble counts land in run.json and validate against the run schema', () => {
  const s = setup();
  putCandidates(s, 'app/api/users', 'authz-scoping', 'medium-idor');
  putCandidates(s, 'app/api/users', 'bulk-export', 'empty');
  putCandidates(s, 'app/api/export', 'authz-scoping', 'empty');
  putCandidates(s, 'app/api/export', 'bulk-export', 'high-export');
  putVote(s, 'app/api/users', 'authz-scoping', 'c1', 1, 'confirm');
  putVote(s, 'app/api/export', 'bulk-export', 'c1', 1, 'reject');
  hio.assemble(SLUG, s.runId);
  const run = JSON.parse(fs.readFileSync(path.join(s.dir, 'run.json'), 'utf8'));
  assert.equal(run.status, 'done');
  assert.deepEqual(validate(loadSchema('run'), run), { ok: true, errors: [] });
  assert.deepEqual(
    { added: run.counts.added, closed: run.counts.closed, candidates: run.counts.candidates, verified: run.counts.verified, rejected: run.counts.rejected, undecided: run.counts.undecided, hardening: run.counts.hardening },
    { added: 1, closed: 0, candidates: 2, verified: 1, rejected: 1, undecided: 0, hardening: 0 }
  );
});

test('list prints one row per candidate with its ref, file, severity and title', () => {
  const s = setup();
  putCandidates(s, 'app/api/export', 'bulk-export', 'high-export');
  const r = spawnSync(process.execPath, [CLI, 'list', '--project', SLUG, '--run', s.runId, '--json'], { encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [{
    candidateRef: `${keyOf('app/api/export', 'bulk-export')}#c1`,
    file: `candidates/${keyOf('app/api/export', 'bulk-export')}.json`,
    severity: 'HIGH',
    classId: 'bulk-export',
    title: "Export route returns every tenant's rows",
  }]);
});

// ---- init ------------------------------------------------------------------------------------

const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: process.env });
const runsDir = () => path.join(home, 'projects', SLUG, 'runs');

test('init prints the workflow args: hunt groups, class bundles and their text, one hunter per group and bundle', () => {
  store.writeProject(projectObject());
  const r = cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--effort', 'high', '--repo', TARGET);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.runId, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
  assert.equal(out.runDir, runDir(SLUG, out.runId));
  assert.equal(out.batches.length, 1, 'three hunters fit in one workflow run');
  assert.equal(out.args, undefined, 'L2 and L3 print batches, not args');
  assert.deepEqual(out.plan, { units: 5, skippedUnchanged: 0, notHunted: 0, groups: 1, bundles: 3, hunters: 3 });
  const a = out.batches[0];
  assert.deepEqual(Object.keys(a).sort(), ['agentCap', 'batch', 'bundles', 'classes', 'effort', 'groups', 'layer', 'project', 'repoRoot', 'runDir', 'runId', 'systems'].sort());
  assert.equal(a.agentCap, hio.WORKFLOW_AGENT_CAP);
  assert.deepEqual(a.batch, { index: 1, of: 1 });
  assert.equal(a.project, SLUG);
  assert.equal(a.layer, 'L3');
  assert.equal(a.effort, 'high');
  assert.equal(a.repoRoot, path.resolve(TARGET));
  assert.deepEqual(a.systems, [{ id: SYS, type: 'web-nextjs', kind: 'code' }]);
  // The fixture's source is tiny, so every unit packs into one group; node_modules, public/ and tests/ never reach it.
  assert.equal(a.groups.length, 1);
  const g = a.groups[0];
  assert.equal(g.group, 'g01');
  assert.deepEqual(g.units, ['.', 'app/api/export', 'app/api/invoices', 'app/api/users', 'lib']);
  assert.deepEqual(g.paths, ['middleware.ts', 'package.json', 'app/api/export/route.ts', 'app/api/invoices/route.ts', 'app/api/users/route.ts', 'lib/auth.ts', 'lib/db.ts']);
  assert.equal(g.bytes, g.paths.reduce((n, p) => n + fs.statSync(path.join(TARGET, p)).size, 0));
  // Fourteen classes of one pack: three bundles in pack order, the five logic-bug classes together.
  assert.deepEqual(a.bundles.map((b) => [b.bundle, b.pack, b.classIds.length]), [['b1', 'web-nextjs', 5], ['b2', 'web-nextjs', 5], ['b3', 'web-nextjs', 4]]);
  assert.deepEqual(a.bundles[0].classIds, [...hio.LOW_CLASSES]);
  const doc0 = () => JSON.parse(fs.readFileSync(path.join(out.runDir, 'units.json'), 'utf8'));
  assert.equal(a.classes.length, 14);
  const authz = a.classes.find((c) => c.classId === 'authz-scoping');
  assert.deepEqual(Object.keys(authz).sort(), ['classId', 'pack', 'packVersion', 'text', 'title']);
  assert.equal(authz.title, doc0().classes.find((c) => c.classId === 'authz-scoping').title);
  assert.match(authz.text, /\*\*Look for:\*\*/);
  assert.match(authz.text, /\*\*Confirm by:\*\*/);
  assert.match(authz.text, /\*\*Disprove by:\*\*/);
  assert.match(authz.text, /\*\*Severity when confirmed:\*\* HIGH\. Any signed-in user/);
  assert.match(authz.text, /\*\*CWE:\*\* CWE-639, CWE-862, CWE-863/);
  const doc = doc0();
  assert.deepEqual(doc.units.map((u) => u.id), g.units);
  assert.ok(doc.units.every((u) => !('paths' in u) && !('sizes' in u) && Number.isInteger(u.bytes)), 'L3 units keep no file list; the group does');
  assert.deepEqual(doc.groups, [{ id: 'g01', units: g.units, paths: g.paths, present: [], bytes: g.bytes, reachable: true }]);
  assert.equal(doc.engine, require('../scripts/hunt-plan.cjs').HUNT_ENGINE);
  assert.deepEqual(g.present, []);
  assert.equal(doc.hunters.length, 3);
  assert.deepEqual(doc.hunters[0], {
    key: 'g01__b1', system: SYS, group: 'g01', bundle: 'b1', units: g.units, classIds: [...hio.LOW_CLASSES],
    classes: hio.LOW_CLASSES.map((classId) => ({ pack: 'web-nextjs', packVersion: '1.0.0', classId })),
  });
  assert.ok(fs.statSync(path.join(out.runDir, 'candidates')).isDirectory());
  assert.ok(fs.statSync(path.join(out.runDir, 'votes')).isDirectory());
  const run = JSON.parse(fs.readFileSync(path.join(out.runDir, 'run.json'), 'utf8'));
  assert.equal(run.job, 'audit');
  assert.deepEqual(run.layers, ['L3']);
});

test('init at low effort plans only the LOW classes, and only on reachable units; background units get their own groups', () => {
  store.writeProject(projectObject());
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart low '));
  try {
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'app', 'api', 'x'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs', 'a.sh'), 'x');
    fs.writeFileSync(path.join(repo, 'docs', 'guide.md'), 'x');
    fs.writeFileSync(path.join(repo, 'app', 'api', 'x', 'route.ts'), 'x');
    const low = JSON.parse(cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--effort', 'low', '--repo', repo).stdout);
    assert.deepEqual(low.batches[0].classes.map((c) => c.classId).sort(), [...hio.LOW_CLASSES].sort());
    assert.deepEqual(low.batches[0].bundles.map((b) => b.classIds), [[...hio.LOW_CLASSES]]);
    assert.deepEqual(low.batches[0].groups.map((g) => g.units), [['app/api/x']]);
    const doc = JSON.parse(fs.readFileSync(path.join(low.runDir, 'units.json'), 'utf8'));
    assert.deepEqual(doc.hunters.map((h) => [h.key, h.units, h.classIds]), [['g01__b1', ['app/api/x'], [...hio.LOW_CLASSES]]]);
    // R47: the classes the effort left out are kept in units.json for the report
    assert.equal(doc.classesLeftOut.length, 14 - hio.LOW_CLASSES.length);
    assert.ok(doc.classesLeftOut.every((c) => !hio.LOW_CLASSES.includes(c.classId) && c.pack === 'web-nextjs' && typeof c.title === 'string' && !('text' in c)));
    const onTarget = JSON.parse(cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--effort', 'low', '--repo', TARGET).stdout);
    assert.deepEqual(onTarget.batches[0].classes.map((c) => c.classId).sort(), [...hio.LOW_CLASSES].sort());
    assert.equal(onTarget.batches[0].groups[0].units.length, 5);
    const high = JSON.parse(cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--effort', 'high', '--repo', repo).stdout);
    // A reachable and a background unit never share a group, however small both are; docs/guide.md is not source and never listed.
    assert.deepEqual(high.batches[0].groups.map((g) => [g.group, g.units, g.paths]), [['g01', ['app/api/x'], ['app/api/x/route.ts']], ['g02', ['docs'], ['docs/a.sh']]]);
    const medium = JSON.parse(cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--effort', 'medium', '--repo', repo).stdout);
    assert.deepEqual(medium.batches[0].groups.map((g) => g.units), [['app/api/x']]);
    assert.equal(medium.batches[0].classes.length, 14);
    assert.equal(medium.plan.hunters, 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(medium.runDir, 'units.json'), 'utf8')).classesLeftOut, []);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('init refuses a project without an owner attestation and a system that is not in it (exit 2, no run)', () => {
  const { ownerAttestation, ...bare } = projectObject();
  fs.mkdirSync(path.join(home, 'projects', SLUG), { recursive: true });
  fs.writeFileSync(path.join(home, 'projects', SLUG, 'project.json'), JSON.stringify(bare));
  let r = cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--effort', 'low', '--repo', TARGET);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /attestation/i);
  store.writeProject(projectObject());
  r = cli('init', '--project', SLUG, '--system', 'nope', '--layer', 'L3', '--effort', 'low', '--repo', TARGET);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /nope/);
  assert.ok(!fs.existsSync(runsDir()));
});

test('init at L2 on an empty diff reports empty and leaves no run directory', () => {
  store.writeProject(projectObject());
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart l2 '));
  try {
    const git = (...args) => {
      const r = spawnSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    };
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'T');
    git('config', 'user.email', 't@example.com');
    fs.mkdirSync(path.join(repo, 'lib'));
    fs.writeFileSync(path.join(repo, 'lib', 'a.ts'), 'a\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'feature');
    const r = cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L2', '--effort', 'medium', '--repo', repo, '--base', 'main');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).empty, true);
    assert.ok(!fs.existsSync(runsDir()), 'no run directory for nothing to scan');
    fs.mkdirSync(path.join(repo, 'app', 'api', 'y'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'app', 'api', 'y', 'route.ts'), 'b\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'feature');
    const r2 = cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L2', '--effort', 'medium', '--repo', repo, '--base', 'main');
    assert.equal(r2.status, 0, r2.stderr);
    assert.deepEqual(JSON.parse(r2.stdout).batches[0].groups.map((g) => [g.units, g.paths]), [[['app/api/y'], ['app/api/y/route.ts']]]);
    // R46: an L2 run keeps each unit's hunted files in units.json, so assemble closes findings only in those files.
    const l2doc = JSON.parse(fs.readFileSync(path.join(JSON.parse(r2.stdout).runDir, 'units.json'), 'utf8'));
    assert.deepEqual(l2doc.units.map((u) => [u.id, u.paths]), [['app/api/y', ['app/api/y/route.ts']]]);
    // R32: a deleted file is not among a unit's paths; the changed files that remain are.
    fs.mkdirSync(path.join(repo, 'app', 'api', 'z'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'app', 'api', 'z', 'a.ts'), 'a\n');
    fs.writeFileSync(path.join(repo, 'app', 'api', 'z', 'b.ts'), 'b\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'z');
    git('checkout', '-q', 'main');
    git('merge', '-q', '--ff-only', 'feature');
    git('checkout', '-q', '-b', 'feature2');
    fs.rmSync(path.join(repo, 'app', 'api', 'z', 'a.ts'));
    fs.writeFileSync(path.join(repo, 'app', 'api', 'z', 'b.ts'), 'b2\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'delete a, change b');
    const r3 = cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L2', '--effort', 'medium', '--repo', repo, '--base', 'main');
    assert.equal(r3.status, 0, r3.stderr);
    assert.deepEqual(JSON.parse(r3.stdout).batches[0].groups.map((g) => [g.units, g.paths]), [[['app/api/z'], ['app/api/z/b.ts']]]);
    const l3doc = JSON.parse(fs.readFileSync(path.join(JSON.parse(r3.stdout).runDir, 'units.json'), 'utf8'));
    assert.deepEqual(l3doc.units.map((u) => [u.id, u.files, u.paths]), [['app/api/z', 1, ['app/api/z/b.ts']]]);
    const run = JSON.parse(fs.readFileSync(path.join(JSON.parse(r2.stdout).runDir, 'run.json'), 'utf8'));
    assert.match(run.revision.commit, /^[0-9a-f]{40}$/);
    assert.equal(run.revision.dirty, false);
    // 0.5.0: a branch that changed only prose and images has nothing for a hunter: empty, and no run.
    git('checkout', '-q', 'main');
    git('merge', '-q', '--ff-only', 'feature2');
    git('checkout', '-q', '-b', 'docs-only');
    fs.writeFileSync(path.join(repo, 'app', 'api', 'z', 'NOTES.md'), '# notes\n');
    fs.writeFileSync(path.join(repo, 'app', 'api', 'z', 'shot.png'), 'png');
    git('add', '-A');
    git('commit', '-q', '-m', 'docs');
    const before = fs.readdirSync(runsDir()).length;
    const r4 = cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L2', '--effort', 'medium', '--repo', repo, '--base', 'main');
    assert.equal(r4.status, 0, r4.stderr);
    assert.equal(JSON.parse(r4.stdout).empty, true);
    assert.equal(JSON.parse(r4.stdout).message, 'nothing to scan: the 2 changed files are not source a hunt reads (1 image, 1 prose) against main', 'it says what it left out');
    assert.equal(fs.readdirSync(runsDir()).length, before, 'no run for a change with no source in it');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('INFRA: init plans one prober for all probes; assemble covers observed probes and skips the skipped ones', () => {
  store.writeProject(projectObject());
  const r = cli('init', '--project', SLUG, '--system', 'db', '--layer', 'INFRA', '--effort', 'medium');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.args.systems, [{ id: 'db', type: 'supabase', kind: 'host' }]);
  assert.ok(out.args.units.every((u) => !('paths' in u)), 'INFRA units carry no paths');
  const doc = JSON.parse(fs.readFileSync(path.join(out.runDir, 'units.json'), 'utf8'));
  assert.equal(doc.hunters.length, 1);
  assert.equal(doc.hunters[0].key, 'db__infra-prober');
  const probes = doc.units.map((u) => u.id.replace(/^probe:/, ''));
  assert.ok(probes.length > 2);
  fs.writeFileSync(path.join(out.runDir, 'candidates', 'db__infra-prober.json'), '[]');
  fs.writeFileSync(path.join(out.runDir, 'observations.json'), JSON.stringify({
    observations: probes.slice(1).map((p) => ({ probeId: p, via: 'ssh', ok: true, exitCode: 0, durationMs: 5, text: 'ok', rawPath: `raw/${p}.txt` })),
    skipped: [{ probeId: probes[0], reason: 'connection refused' }],
  }));
  const res = hio.assemble(SLUG, out.runId);
  assert.deepEqual(res.skipped.map((u) => [u.id, u.status, u.reason]), [[`probe:${probes[0]}`, 'skipped', 'connection refused']]);
  const run = JSON.parse(fs.readFileSync(path.join(out.runDir, 'run.json'), 'utf8'));
  assert.equal(run.status, 'done');
  const ledger = store.readCoverage(SLUG);
  assert.equal(ledger.units[`db|INFRA|probe:${probes[1]}`].status, 'covered');
  assert.ok(!ledger.units[`db|INFRA|probe:${probes[0]}`]);
});

// Ten distinct candidates, the most a hunter may return: c1..c10 at <dir>/f<n>.ts (code) or on ten settings (INFRA).
const tenCandidates = (dir, classId = 'authz-scoping') => Array.from({ length: 10 }, (_, i) => ({
  ...rawCandidates('medium-idor')[0], ref: `c${i + 1}`, classId,
  location: dir === null ? { host: 'db.example.test', service: 'auth', setting: `s${i + 1}` } : { path: `${dir}/f${i + 1}.ts`, symbol: 'GET' },
}));

test('R49: a hunter that hit the 10-candidate cap keeps its unit from closing findings, and the unit is marked capped', () => {
  const s = setup({ units: ['app/api/users', 'lib'], hunters: [['app/api/users', 'authz-scoping'], ['lib', 'authz-scoping']] });
  store.upsertFindings(SLUG, [
    storedHunt('a'.repeat(12), 'web-nextjs/authz-scoping', 'app/api/users/gone.ts'),
    storedHunt('b'.repeat(12), 'web-nextjs/authz-scoping', 'lib/gone.ts'),
  ], OLD_RUN);
  hio.writeCandidate(SLUG, s.runId, keyOf('app/api/users', 'authz-scoping'), tenCandidates('app/api/users'));
  putCandidates(s, 'lib', 'authz-scoping', 'empty');
  const res = hio.assemble(SLUG, s.runId);
  assert.deepEqual(statusById(), { ['a'.repeat(12)]: 'open', ['b'.repeat(12)]: 'fixed' });
  const doc = JSON.parse(fs.readFileSync(path.join(s.dir, 'units.json'), 'utf8'));
  assert.equal(doc.units.find((u) => u.id === 'app/api/users').capped, true);
  assert.equal(doc.units.find((u) => u.id === 'app/api/users').status, 'covered');
  assert.ok(!('capped' in doc.units.find((u) => u.id === 'lib')));
  assert.equal(res.counts.closed, 1);
});

// An INFRA run of system db as init plans it, with the prober returned ([] by default) and the given observations per probe id.
function infraRun(observe, { candidates = [] } = {}) {
  store.writeProject(projectObject());
  const out = hio.initRun(SLUG, { system: 'db', layer: 'INFRA' });
  const probes = JSON.parse(fs.readFileSync(path.join(out.runDir, 'units.json'), 'utf8')).units.map((u) => u.id.replace(/^probe:/, ''));
  fs.writeFileSync(path.join(out.runDir, 'candidates', 'db__infra-prober.json'), JSON.stringify(candidates));
  fs.writeFileSync(path.join(out.runDir, 'observations.json'), JSON.stringify({
    observations: probes.map((p) => ({ probeId: p, via: 'ssh', ok: true, exitCode: 0, durationMs: 5, text: 'ok', rawPath: `raw/${p}.txt`, ...(observe(p, probes) || {}) })),
    skipped: [],
  }));
  return { ...out, probes };
}
const infraFinding = (id) => ({
  id, project: SLUG, system: 'db', layer: 'INFRA', source: 'infra-probe', class: 'verified', pack: 'supabase@1.0.0', ruleId: 'supabase/x', severity: 'MEDIUM', confidence: 'HIGH', cwe: [],
  title: 't', evidence: 'e', exploitScenario: 's', preconditions: 'p', recommendation: 'r', verification: { verifiers: 1, confirmed: 1, run: OLD_RUN }, status: 'open',
  externalIds: { claudeSecurityPluginFindingId: null, cve: null }, location: { host: 'db.example.test', service: 'auth', setting: 'x' },
});

test('R48: an observation that answered with an error (ok false, with text) leaves its unit failed, and nothing is closed', () => {
  const s = infraRun((p, probes) => (p === probes[0] ? { ok: false, exitCode: 1, text: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' } : null));
  store.upsertFindings(SLUG, [infraFinding('d'.repeat(12))], OLD_RUN);
  const res = hio.assemble(SLUG, s.runId);
  assert.deepEqual(res.skipped.map((u) => [u.id, u.status]), [[`probe:${s.probes[0]}`, 'failed']]);
  assert.match(res.skipped[0].reason, /probe returned an error \(exit 1\)/);
  assert.equal(res.counts.closed, 0);
  assert.equal(statusById()['d'.repeat(12)], 'open');
  assert.equal(store.readCoverage(SLUG).units[`db|INFRA|probe:${s.probes[0]}`].status, 'failed');
});

test('R48: an observation whose ok is not true (missing) is not covered either; every probe ok closes what the prober did not report', () => {
  let s = infraRun((p, probes) => (p === probes[1] ? { ok: undefined } : p === probes[2] ? { via: 'http', ok: false, exitCode: 0, text: 'HTTP 503\nserver: edge' } : null));
  store.upsertFindings(SLUG, [infraFinding('d'.repeat(12))], OLD_RUN);
  const res = hio.assemble(SLUG, s.runId);
  assert.equal(res.counts.closed, 0);
  assert.deepEqual(res.skipped.map((u) => u.id), [`probe:${s.probes[1]}`, `probe:${s.probes[2]}`]);
  assert.match(res.skipped[1].reason, /\(HTTP 503\)/);
  s = infraRun(() => null);
  assert.equal(hio.assemble(SLUG, s.runId).counts.closed, 1);
  assert.equal(statusById()['d'.repeat(12)], 'fixed');
});

test('R49: an INFRA prober at the cap keeps the whole system from closing findings', () => {
  const s = infraRun(() => null);
  // the prober's file, rewritten with ten candidates under the run's first host class
  const doc = JSON.parse(fs.readFileSync(path.join(s.runDir, 'units.json'), 'utf8'));
  fs.writeFileSync(path.join(s.runDir, 'candidates', 'db__infra-prober.json'), JSON.stringify(tenCandidates(null, doc.classes[0].classId)));
  store.upsertFindings(SLUG, [infraFinding('d'.repeat(12))], OLD_RUN);
  const res = hio.assemble(SLUG, s.runId);
  assert.equal(res.counts.candidates, 10);
  assert.equal(res.counts.closed, 0);
  assert.equal(statusById()['d'.repeat(12)], 'open');
  const after = JSON.parse(fs.readFileSync(path.join(s.runDir, 'units.json'), 'utf8'));
  assert.ok(after.units.every((u) => u.status === 'covered' && u.capped === true));
});

test('fileKey maps every character outside [A-Za-z0-9._-] to +', () => {
  assert.equal(fileKey('app/api/users'), 'app+api+users');
  assert.equal(fileKey('probe:auth-env'), 'probe+auth-env');
  assert.equal(fileKey('.'), '.');
});

// ---- fix round 1 -----------------------------------------------------------------------------

const AKIA = 'AKIAFAKEFAKEFAKEFAKE';
const stubbed = (file) => {
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes(AKIA), 'the original content is gone');
  assert.ok(typeof JSON.parse(text).invalid === 'string');
};

test('candidate and vote files hunt-io cannot use are overwritten with a stub, not kept', () => {
  const s = setup();
  const cdir = path.join(s.dir, 'candidates');
  const vdir = path.join(s.dir, 'votes');
  fs.writeFileSync(path.join(cdir, 'nobody__authz-scoping.json'), JSON.stringify([{ ref: 'c1', evidence: AKIA }]));
  fs.writeFileSync(path.join(cdir, `${keyOf('app/api/users', 'authz-scoping')}.json`), `[{"ref": "c1", "evidence": "${AKIA}"`);
  fs.writeFileSync(path.join(cdir, `${keyOf('app/api/users', 'bulk-export')}.json`), JSON.stringify({ note: AKIA }));
  putCandidates(s, 'app/api/export', 'authz-scoping', 'medium-idor');
  fs.writeFileSync(path.join(vdir, `${keyOf('app/api/export', 'authz-scoping')}__c1__1.json`), JSON.stringify({ verdict: 'bogus', reason: AKIA }));
  fs.writeFileSync(path.join(vdir, 'garbage.json'), JSON.stringify({ reason: AKIA }));
  const r = hio.ingest(SLUG, s.runId);
  assert.ok(r.invalid.length >= 5);
  for (const f of [path.join(cdir, 'nobody__authz-scoping.json'), path.join(cdir, `${keyOf('app/api/users', 'authz-scoping')}.json`), path.join(cdir, `${keyOf('app/api/users', 'bulk-export')}.json`), path.join(vdir, `${keyOf('app/api/export', 'authz-scoping')}__c1__1.json`), path.join(vdir, 'garbage.json')]) stubbed(f);
  assert.equal(hio.readVotes(SLUG, s.runId).length, 0);
  hio.ingest(SLUG, s.runId); // a second pass is stable
});

test('invalid candidates are counted, recorded on the unit, and keep that unit from closing findings', () => {
  const s = setup({ units: ['app/api/users'], hunters: [['app/api/users', 'authz-scoping']] });
  const base = { project: SLUG, system: SYS, layer: LAYER, source: 'rampart-hunter', class: 'verified', pack: 'web-nextjs@1.0.0', severity: 'MEDIUM', confidence: 'HIGH', cwe: [], title: 't', evidence: 'e', exploitScenario: 's', preconditions: 'p', recommendation: 'r', verification: { verifiers: 1, confirmed: 1, run: '2026-10-22T00-00-00Z' }, status: 'open', externalIds: { claudeSecurityPluginFindingId: null, cve: null } };
  store.upsertFindings(SLUG, [{ ...base, id: 'a'.repeat(12), ruleId: 'web-nextjs/authz-scoping', location: { path: 'app/api/users/gone.ts', symbol: 'GET' } }], '2026-10-22T00-00-00Z');
  putCandidates(s, 'app/api/users', 'authz-scoping', 'bad-locations');
  const res = hio.assemble(SLUG, s.runId);
  assert.equal(res.counts.invalid, 4);
  assert.equal(res.invalid.length, 4);
  assert.equal(res.counts.closed, 0);
  assert.equal(store.readFindings(SLUG)[0].status, 'open');
  const doc = JSON.parse(fs.readFileSync(path.join(s.dir, 'units.json'), 'utf8'));
  assert.equal(doc.units[0].status, 'covered');
  assert.equal(doc.units[0].invalid, 4);
  const run = JSON.parse(fs.readFileSync(path.join(s.dir, 'run.json'), 'utf8'));
  assert.deepEqual(validate(loadSchema('run'), run), { ok: true, errors: [] });
});

test('value detection: identifiers and paths stay, hex and mixed tokens blank the evidence', () => {
  const s = setup();
  const ev = (text) => {
    const raw = rawCandidates('medium-idor');
    raw[0].evidence = text;
    return hio.writeCandidate(SLUG, s.runId, keyOf('app/api/users', 'authz-scoping'), raw).candidates[0].evidence;
  };
  for (const keep of ['getUserByIdWithoutAuthorizationCheck is called', 'imports lib/auth/session-handler', 'route app/api/invoices/route.ts']) assert.equal(ev(keep), keep);
  assert.match(ev('key a3f9c21be0d47856ab12cd34ef56a7b8 used'), /^\[REDACTED\]/);
  assert.match(ev(`token ${TOKEN} used`), /^\[REDACTED\]/);
  assert.match(ev(`jwt ${FAKE_JWT}`), /^\[REDACTED\]/);
  const raw = rawCandidates('medium-idor');
  raw[0].location = { path: `app/chunk-${TOKEN}.js`, symbol: 'GET' };
  const [c] = hio.writeCandidate(SLUG, s.runId, keyOf('app/api/users', 'authz-scoping'), raw).candidates;
  assert.ok(!c.location.path.includes(TOKEN));
});

test('assemble runs once; writeVote rejects a path-like file name; readVotes checks the verifier label', () => {
  const s = setup();
  putCandidates(s, 'app/api/users', 'authz-scoping', 'medium-idor');
  assert.throws(() => hio.writeVote(SLUG, s.runId, '../../x__c1__1.json', rawVote('confirm')), RangeError);
  assert.throws(() => hio.writeVote(SLUG, s.runId, 'x.json', rawVote('confirm')), RangeError);
  const name = `${keyOf('app/api/users', 'authz-scoping')}__c1__1.json`;
  putVote(s, 'app/api/users', 'authz-scoping', 'c1', 1, 'confirm');
  const file = path.join(s.dir, 'votes', name);
  const forged = { ...JSON.parse(fs.readFileSync(file, 'utf8')), verifier: 'verify:other#c1:1' };
  fs.writeFileSync(file, JSON.stringify(forged));
  assert.equal(hio.readVotes(SLUG, s.runId).length, 0);
  hio.assemble(SLUG, s.runId);
  assert.throws(() => hio.assemble(SLUG, s.runId), /already/);
  const r = cli('assemble', '--project', SLUG, '--run', s.runId);
  assert.equal(r.status, 2);
});

test('an agent-written {"invalid": ...} stub is not trusted: its text is never echoed', () => {
  const s = setup();
  const cfile = path.join(s.dir, 'candidates', `${keyOf('app/api/users', 'authz-scoping')}.json`);
  const vfile = path.join(s.dir, 'votes', `${keyOf('app/api/users', 'authz-scoping')}__c1__1.json`);
  fs.writeFileSync(cfile, JSON.stringify({ invalid: AKIA }));
  fs.writeFileSync(vfile, JSON.stringify({ invalid: AKIA }));
  hio.ingest(SLUG, s.runId);
  hio.ingest(SLUG, s.runId);
  for (const f of [cfile, vfile, path.join(s.dir, 'invalid.json')]) assert.ok(!fs.readFileSync(f, 'utf8').includes(AKIA), f);
});

// ---- Task 13: dry run, INFRA baseline and cloud gate, re-verify ------------------------------

test('init --dry-run prints the plan for each effort and creates nothing', () => {
  store.writeProject(projectObject());
  const r = cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--repo', TARGET, '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dryRun, true);
  assert.equal(out.layer, 'L3');
  assert.equal(out.system, SYS);
  assert.equal(out.files, 'git', 'the fixture is in a git checkout, so its file list comes from git');
  assert.equal(out.full, false);
  assert.deepEqual(Object.keys(out.efforts), ['low', 'medium', 'high']);
  const pick = (e, keys) => Object.fromEntries(keys.map((k) => [k, e[k]]));
  const shape = ['units', 'classes', 'hunters', 'workflows', 'groups', 'bundles', 'skippedUnchanged'];
  assert.deepEqual(pick(out.efforts.low, shape), { units: 5, classes: 5, hunters: 1, workflows: 1, groups: 1, bundles: 1, skippedUnchanged: 0 });
  assert.deepEqual(pick(out.efforts.medium, shape), { units: 5, classes: 14, hunters: 3, workflows: 1, groups: 1, bundles: 3, skippedUnchanged: 0 });
  assert.deepEqual(pick(out.efforts.high, shape), { units: 5, classes: 14, hunters: 3, workflows: 1, groups: 1, bundles: 3, skippedUnchanged: 0 });
  for (const e of Object.values(out.efforts)) {
    // The fields the recipe reads are still there, and they add up: agents are the hunters plus the expected verifiers.
    assert.equal(e.agents, e.hunters + e.verifiers);
    assert.equal(e.tokens, e.hunterTokens + e.verifierTokens);
    assert.ok(Number.isInteger(e.sourceBytes) && e.sourceBytes > 0);
    assert.ok(e.hunterTokens / e.hunters < 100000, 'a hunter over a few KB of source is estimated well under 100k tokens');
  }
  assert.ok(!('runId' in out) && !('args' in out));
  assert.ok(!fs.existsSync(runsDir()), 'a dry run creates no run');
});

test('batchUnits keeps every batch at or under HUNTERS_PER_WORKFLOW hunters, in order, never splitting a group', () => {
  const units = Array.from({ length: 99 }, (_, i) => ({ id: `u${i}` }));
  // The L3 audit that hit the runner's cap: 99 units x 12 classes = 1,188 hunters in one workflow.
  const batches = hio.batchUnits(units, 12);
  assert.ok(batches.every((b) => b.length * 12 <= hio.HUNTERS_PER_WORKFLOW));
  assert.deepEqual(batches.flat().map((u) => u.id), units.map((u) => u.id));
  assert.equal(batches.length, Math.ceil(99 / Math.floor(hio.HUNTERS_PER_WORKFLOW / 12)));
  assert.ok(hio.HUNTERS_PER_WORKFLOW < hio.WORKFLOW_AGENT_CAP, 'room is left under the cap for verifiers');
  assert.deepEqual(hio.batchUnits(units.slice(0, 3), hio.HUNTERS_PER_WORKFLOW + 1).map((b) => b.length), [1, 1, 1], 'a group with too many bundles is a batch of its own');
  assert.deepEqual(hio.batchUnits([], 12), []);
  assert.equal(hio.batchUnits(units, 2).length, 1, 'ninety-nine groups of two bundles fit one workflow run');
});

test('init splits a large plan into batches: every group in exactly one, each batch numbered, all in one run', () => {
  store.writeProject(projectObject());
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart batches '));
  try {
    // 140 reachable units of 100 KB of source each: one group per unit (two would pass the budget), x 3 bundles = 420 hunters,
    // more than one workflow run's worth.
    const body = `export const x = 1;\n${'//'.repeat(50 * 1024)}\n`;
    for (let i = 0; i < 140; i++) {
      fs.mkdirSync(path.join(repo, 'app', 'api', `r${String(i).padStart(3, '0')}`), { recursive: true });
      fs.writeFileSync(path.join(repo, 'app', 'api', `r${String(i).padStart(3, '0')}`, 'route.ts'), body);
    }
    const dry = JSON.parse(cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--repo', repo, '--dry-run').stdout);
    assert.equal(dry.efforts.medium.groups, 140);
    const r = cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--effort', 'medium', '--repo', repo);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.batches.length, dry.efforts.medium.workflows);
    assert.ok(out.batches.length > 1);
    assert.deepEqual(out.batches.map((b) => b.batch), out.batches.map((_, i) => ({ index: i + 1, of: out.batches.length })));
    assert.ok(out.batches.every((b) => b.runId === out.runId && b.runDir === out.runDir && b.agentCap === hio.WORKFLOW_AGENT_CAP));
    assert.ok(out.batches.every((b) => b.groups.length * b.bundles.length <= hio.HUNTERS_PER_WORKFLOW));
    const all = out.batches.flatMap((b) => b.groups.map((g) => g.group));
    assert.equal(new Set(all).size, all.length, 'no group in two batches');
    const doc = JSON.parse(fs.readFileSync(path.join(out.runDir, 'units.json'), 'utf8'));
    assert.deepEqual(all, doc.groups.map((g) => g.id), 'every group is in a batch, in order');
    assert.deepEqual(out.batches.flatMap((b) => b.groups.flatMap((g) => g.units)).sort(), doc.units.map((u) => u.id).sort(), 'every planned unit is in a batch');
    assert.equal(doc.hunters.length, all.length * 3);
    assert.equal(doc.groups[0].id, 'g001', 'ids are padded to the group count, so they sort');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});


test('init --dry-run for INFRA counts probes and the most agents a prober run can take; it creates nothing', () => {
  store.writeProject(projectObject());
  const r = cli('init', '--project', SLUG, '--system', 'db', '--layer', 'INFRA', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dryRun, true);
  assert.equal(out.layer, 'INFRA');
  assert.ok(out.infra.probes > 2);
  assert.ok(out.infra.classes > 2);
  assert.equal(out.infra.agentsMax, 31);
  assert.equal(out.infra.tokensMax, 31 * hio.TOKENS_PER_AGENT);
  assert.ok(!fs.existsSync(runsDir()));
});

test('estimate stores the dry-run figures per system, layer and effort for the dashboard; a layer it cannot plan here keeps the last figures', () => {
  const p = projectObject();
  p.systems[0].layers = { L3: { cadenceDays: 90 } };
  p.systems.push({ id: 'api', type: 'node-api', name: 'API', packs: ['node-api'], repo: { remote: 'github.com/<owner>/api', defaultBranch: 'main', paths: {} }, executor: 'local', layers: { L3: { cadenceDays: 90 } } });
  store.writeProject(p);
  const earlier = { at: '2026-11-01T00:00:00.000Z', efforts: { medium: { hunters: 9, agents: 11, tokens: 900000 } } };
  store.writeEstimates(SLUG, { updatedAt: '2026-11-01T00:00:00.000Z', systems: { api: { L3: earlier }, gone: { L3: earlier } } });
  const r = cli('estimate', '--project', SLUG, '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.estimated, [{ system: SYS, layer: 'L3' }], 'only L2 and L3 layers: the INFRA host is priced on the page without a plan');
  assert.deepEqual(out.skipped.map((s) => [s.system, s.layer]), [['api', 'L3']], 'no checkout of api on this machine');
  assert.equal(typeof out.skipped[0].reason, 'string');
  const doc = store.readEstimates(SLUG);
  assert.deepEqual(Object.keys(doc.systems).sort(), ['api', SYS].sort(), 'a system the project no longer lists is dropped');
  assert.deepEqual(doc.systems.api.L3, earlier, 'the figures an earlier estimate stored stand');
  const dry = JSON.parse(cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--dry-run').stdout);
  const mine = doc.systems[SYS].L3;
  assert.ok(!Number.isNaN(Date.parse(mine.at)));
  assert.deepEqual(Object.keys(mine.efforts), ['low', 'medium', 'high']);
  for (const effort of ['low', 'medium', 'high']) {
    for (const k of ['hunters', 'agents', 'tokens', 'workflows', 'skippedUnchanged', 'notHunted']) assert.equal(mine.efforts[effort][k], dry.efforts[effort][k], `${effort} ${k}`);
    assert.ok(!('sourceBytes' in mine.efforts[effort]) && !('hunterTokens' in mine.efforts[effort]), 'only what the page shows');
  }
  assert.ok(!JSON.stringify(doc).includes(TARGET), 'no local path in the figures');
  assert.ok(!fs.existsSync(runsDir()), 'an estimate creates no run');
  // The page prices from it exactly as the audit's own dry run would.
  const cost = require('../scripts/jobs.cjs').costEstimate({ type: 'audit', layer: 'L3', effort: 'medium', estimate: mine });
  assert.deepEqual([cost.agents, cost.tokens], [dry.efforts.medium.agents, dry.efforts.medium.tokens]);
  assert.equal(cli('estimate').status, 2);
  assert.equal(cli('estimate', '--project', 'no-such').status, 2);
});

test('INFRA init puts every host pack\'s baseline and each probe\'s expect line into args.baseline', () => {
  const p = projectObject();
  p.systems[1].packs = ['supabase', 'docker-host']; // as inventory lists them for a self-hosted Supabase
  store.writeProject(p);
  const out = JSON.parse(cli('init', '--project', SLUG, '--system', 'db', '--layer', 'INFRA').stdout);
  const b = out.args.baseline;
  assert.equal(typeof b, 'string');
  const { readPack } = require('../scripts/packs.cjs');
  for (const name of ['supabase', 'docker-host']) {
    const pack = readPack(name);
    assert.ok(b.includes(`${name}@${pack.version} Baseline:\n${pack.baseline}`), name);
    for (const p of pack.probes) assert.ok(b.includes(`- ${p.id}: ${p.expect}`), `${name} ${p.id}`);
  }
  const probes = out.args.units.map((u) => u.unit.replace(/^probe:/, ''));
  for (const p of probes) assert.ok(b.includes(`- ${p}: `), p);
});

test('INFRA init and its dry run refuse a cloud session (exit 2, no run)', () => {
  store.writeProject(projectObject());
  const env = { ...process.env, CLAUDE_CODE_REMOTE: 'true' };
  for (const extra of [[], ['--dry-run']]) {
    const r = spawnSync(process.execPath, [CLI, 'init', '--project', SLUG, '--system', 'db', '--layer', 'INFRA', ...extra], { encoding: 'utf8', env });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /cloud/);
  }
  assert.ok(!fs.existsSync(runsDir()));
  const l3 = spawnSync(process.execPath, [CLI, 'init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--repo', TARGET, '--dry-run'], { encoding: 'utf8', env });
  assert.equal(l3.status, 0, 'a repo layer may run in a cloud session');
});

// A stored hunt finding of the web system, as assemble would have upserted it.
const huntFinding = (over = {}) => {
  const location = over.location || { path: 'app/api/users/route.ts', symbol: 'GET' };
  const ruleId = over.ruleId || 'web-nextjs/authz-scoping';
  return {
    id: require('../scripts/lib/id.cjs').findingId({ project: SLUG, system: SYS, ruleId, location }),
    project: SLUG, system: SYS, layer: 'L3', source: 'rampart-hunter', pack: 'web-nextjs@1.0.0', ruleId,
    title: 'Users route returns any user by id', severity: 'MEDIUM', confidence: 'HIGH', cwe: ['CWE-639'], class: 'verified',
    location, evidence: 'GET reads params.id with no session comparison.', exploitScenario: 'Read another user.',
    preconditions: 'Signed in.', recommendation: 'Scope the query.',
    verification: { verifiers: 2, confirmed: 2, run: '2026-10-20T00-00-00Z' }, status: 'open',
    firstSeen: '2026-10-20T00:00:00Z', lastSeen: '2026-10-20T00:00:00Z', fixedIn: null,
    externalIds: { claudeSecurityPluginFindingId: null, cve: null },
    ...over,
  };
};

function seedFindings() {
  store.writeProject(projectObject());
  const f = {
    reject: huntFinding(),
    confirm: huntFinding({ location: { path: 'app/api/export/route.ts', symbol: 'GET' }, ruleId: 'web-nextjs/bulk-export', title: 'Export returns every row', severity: 'HIGH' }),
    unsure: huntFinding({ location: { path: 'lib/auth.ts', symbol: 'session' }, ruleId: 'web-nextjs/session-handling', title: 'Session not verified' }),
    gone: huntFinding({ location: { path: 'lib/db.ts', symbol: 'q' }, ruleId: 'web-nextjs/gone-class', title: 'Class that left the pack' }),
    imported: huntFinding({ location: { path: 'lib/db.ts', symbol: 'x' }, ruleId: 'claude-security/CWE-89', source: 'claude-security', pack: undefined, title: 'Imported' }),
    hardening: huntFinding({ location: { path: 'lib/db.ts', symbol: 'y' }, class: 'hardening', title: 'A note' }),
  };
  delete f.imported.pack;
  store.upsertFindings(SLUG, Object.values(f), '2026-10-20T00-00-00Z');
  return f;
}

test('init-verify plans one verifier per open verified hunt finding of the system and writes each a candidates file', () => {
  const f = seedFindings();
  const r = cli('init-verify', '--project', SLUG, '--system', SYS, '--all', '--repo', TARGET);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.repoRoot, path.resolve(TARGET));
  assert.deepEqual(out.verifications.map((v) => v.finding).sort(), [f.reject.id, f.confirm.id, f.unsure.id].sort());
  assert.deepEqual(out.skipped, [{ finding: f.gone.id, reason: 'class gone-class is no longer in pack web-nextjs' }]);
  const run = JSON.parse(fs.readFileSync(path.join(out.runDir, 'run.json'), 'utf8'));
  assert.equal(run.job, 'verify');
  assert.deepEqual(run.layers, [], 'a verify run earns no layer coverage');
  assert.deepEqual(run.systems, [SYS]);
  assert.equal(run.status, 'running');
  for (const v of out.verifications) {
    const key = `${fileKey(v.finding)}__verify`;
    assert.equal(v.candidateRef, `${key}#c1`);
    assert.equal(v.candidateFile, path.join(out.runDir, 'candidates', `${key}.json`));
    assert.equal(v.outputPath, path.join(out.runDir, 'votes', `${key}__c1__1.json`));
    const [cand] = JSON.parse(fs.readFileSync(v.candidateFile, 'utf8'));
    const stored = Object.values(f).find((x) => x.id === v.finding);
    assert.equal(cand.ref, 'c1');
    assert.deepEqual(cand.location, stored.location);
    assert.equal(cand.title, stored.title);
    assert.equal(v.title, stored.title);
    assert.equal(v.severity, stored.severity);
    assert.deepEqual(v.location, stored.location);
    const classId = stored.ruleId.split('/')[1];
    assert.ok(v.classText.startsWith(`web-nextjs@1.0.0 ${classId}: `), v.classText.slice(0, 60));
    assert.match(v.classText, /\*\*Disprove by:\*\*/);
  }
});

test('init-verify: --finding alone works, an ineligible finding or a bad flag set is refused (exit 2), nothing open creates no run', () => {
  const f = seedFindings();
  let r = cli('init-verify', '--project', SLUG, '--finding', f.confirm.id, '--repo', TARGET);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).verifications.map((v) => v.finding), [f.confirm.id]);
  const before = fs.readdirSync(runsDir()).length;
  for (const bad of [
    ['--finding', f.imported.id], ['--finding', f.hardening.id], ['--finding', f.gone.id], ['--finding', 'ffffffffffff'],
    ['--all'], ['--system', SYS], ['--system', SYS, '--all', '--finding', f.confirm.id], ['--system', 'db', '--finding', f.confirm.id],
  ]) {
    r = cli('init-verify', '--project', SLUG, '--repo', TARGET, ...bad);
    assert.equal(r.status, 2, `${bad.join(' ')}: ${r.stderr}`);
  }
  assert.equal(fs.readdirSync(runsDir()).length, before, 'a refused init-verify creates no run');
  for (const x of [f.reject, f.confirm, f.unsure]) store.setDisposition(SLUG, x.id, { status: 'fixed', reason: 'test', by: 'test' });
  r = cli('init-verify', '--project', SLUG, '--system', SYS, '--all', '--repo', TARGET);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.nothing, true);
  assert.equal(out.verifications.length, 0);
  assert.equal(fs.readdirSync(runsDir()).length, before, 'nothing to verify creates no run');
});

test('reverify: rejected closes the finding as fixed, confirmed keeps it open and seen, unsure leaves it; votes are redacted', () => {
  const f = seedFindings();
  const seen = Object.fromEntries(store.readFindings(SLUG).map((x) => [x.id, x.lastSeen]));
  const out = JSON.parse(cli('init-verify', '--project', SLUG, '--system', SYS, '--all', '--repo', TARGET).stdout);
  const byFinding = Object.fromEntries(out.verifications.map((v) => [v.finding, v]));
  const vote = (id, body) => fs.writeFileSync(byFinding[id].outputPath, JSON.stringify({ candidateRef: byFinding[id].candidateRef, ...body }));
  vote(f.reject.id, { verdict: 'rejected', reason: 'The route now compares the session user.' });
  vote(f.confirm.id, { verdict: 'confirmed', severity: 'HIGH', confidence: 'HIGH', reason: `Still unscoped; key ${AKIA} seen nearby.` });
  vote(f.unsure.id, { verdict: 'unsure', reason: 'Depends on deployment config.' });

  // One finding first: the run stays open until every finding has an outcome.
  let r = cli('reverify', '--project', SLUG, '--run', out.runId, '--finding', f.reject.id, '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).results.map((x) => [x.finding, x.outcome]), [[f.reject.id, 'fixed']]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out.runDir, 'run.json'), 'utf8')).status, 'running');
  r = cli('reverify', '--project', SLUG, '--run', out.runId, '--finding', f.reject.id);
  assert.equal(r.status, 2, 'a finding is re-verified once per run');

  r = cli('reverify', '--project', SLUG, '--run', out.runId, '--json');
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.deepEqual(Object.fromEntries(res.results.map((x) => [x.finding, x.outcome])), { [f.confirm.id]: 'still-open', [f.unsure.id]: 'unchanged' });
  assert.match(res.results.find((x) => x.finding === f.unsure.id).reason, /unsure/);

  const findings = Object.fromEntries(store.readFindings(SLUG).map((x) => [x.id, x]));
  assert.equal(findings[f.reject.id].status, 'fixed');
  const disp = JSON.parse(fs.readFileSync(path.join(home, 'projects', SLUG, 'dispositions.json'), 'utf8'));
  assert.deepEqual([disp[f.reject.id].status, disp[f.reject.id].reason, disp[f.reject.id].by], ['fixed', `no longer reproducible in run ${out.runId}`, 'rampart']);
  assert.equal(findings[f.confirm.id].status, 'open');
  assert.deepEqual(findings[f.confirm.id].verification, { verifiers: 1, confirmed: 1, run: out.runId }, 'this run\'s votes, not the hunt\'s 2 of 2');
  assert.ok(findings[f.confirm.id].lastSeen > seen[f.confirm.id]);
  assert.equal(findings[f.confirm.id].severity, 'HIGH');
  assert.equal(findings[f.unsure.id].lastSeen, seen[f.unsure.id]);
  assert.equal(findings[f.unsure.id].verification.run, f.unsure.verification.run);

  for (const name of fs.readdirSync(path.join(out.runDir, 'votes'))) {
    assert.ok(!fs.readFileSync(path.join(out.runDir, 'votes', name), 'utf8').includes(AKIA), name);
  }
  const run = JSON.parse(fs.readFileSync(path.join(out.runDir, 'run.json'), 'utf8'));
  assert.equal(run.status, 'done');
  assert.deepEqual(run.layers, []);
  assert.equal(run.counts.closed, 1);
  assert.equal(run.counts.verified, 1);
  assert.equal(run.counts.rejected, 1);
  assert.equal(run.counts.undecided, 1);
  assert.ok(validate(loadSchema('run'), run).ok);
  assert.equal(cli('reverify', '--project', SLUG, '--run', out.runId).status, 2, 'a finished verify run is not applied again');
});

test('reverify: a missing or unusable vote leaves the finding unchanged; a finding a person dispositioned meanwhile is not touched', () => {
  const f = seedFindings();
  const out = JSON.parse(cli('init-verify', '--project', SLUG, '--system', SYS, '--all', '--repo', TARGET).stdout);
  const byFinding = Object.fromEntries(out.verifications.map((v) => [v.finding, v]));
  fs.writeFileSync(byFinding[f.reject.id].outputPath, JSON.stringify({ verdict: 'rejected', reason: 'gone' }));
  store.setDisposition(SLUG, f.reject.id, { status: 'accepted_risk', reason: 'owner decision', by: 'owner' });
  fs.writeFileSync(byFinding[f.confirm.id].outputPath, JSON.stringify({ verdict: 'maybe', reason: AKIA }));
  const r = cli('reverify', '--project', SLUG, '--run', out.runId, '--json');
  assert.equal(r.status, 0, r.stderr);
  const res = Object.fromEntries(JSON.parse(r.stdout).results.map((x) => [x.finding, x]));
  assert.equal(res[f.reject.id].outcome, 'unchanged');
  assert.match(res[f.reject.id].reason, /accepted_risk/);
  assert.equal(res[f.confirm.id].outcome, 'unchanged');
  assert.match(res[f.confirm.id].reason, /no usable vote/);
  assert.equal(res[f.unsure.id].outcome, 'unchanged');
  assert.match(res[f.unsure.id].reason, /no usable vote/);
  assert.equal(store.readFindings(SLUG).find((x) => x.id === f.reject.id).status, 'accepted_risk');
  assert.ok(!fs.readFileSync(byFinding[f.confirm.id].outputPath, 'utf8').includes(AKIA));
  assert.equal(JSON.parse(fs.readFileSync(path.join(out.runDir, 'run.json'), 'utf8')).status, 'done');
  // A verify run where no verifier left a usable vote finishes failed, with the reason.
  const lone = JSON.parse(cli('init-verify', '--project', SLUG, '--finding', f.unsure.id, '--repo', TARGET).stdout);
  assert.equal(cli('reverify', '--project', SLUG, '--run', lone.runId).status, 0);
  const run = JSON.parse(fs.readFileSync(path.join(lone.runDir, 'run.json'), 'utf8'));
  assert.equal(run.status, 'failed');
  assert.match(run.reason, /no verifier/);
});

test('INFRA init prints the prober dispatch fields: the host name only (never the ssh user), observations and output paths', () => {
  const p = projectObject();
  p.systems.push({ id: 'edge box', type: 'docker-host', name: 'Edge', packs: ['docker-host'], host: { ssh: 'ssh://<ssh-user>@host.example.test:2222' }, executor: 'local', layers: { INFRA: { cadenceDays: 30 } } });
  p.systems.push({ id: 'alias', type: 'docker-host', name: 'Alias', packs: ['docker-host'], host: { ssh: 'homebox' }, executor: 'local', layers: { INFRA: { cadenceDays: 30 } } });
  store.writeProject(p);
  const out = JSON.parse(cli('init', '--project', SLUG, '--system', 'db', '--layer', 'INFRA').stdout);
  assert.deepEqual(out.prober, {
    system: { id: 'db', type: 'supabase', host: '192.0.2.10' },
    observationsPath: path.join(out.runDir, 'observations.json'),
    outputPath: path.join(out.runDir, 'candidates', 'db__infra-prober.json'),
  });
  assert.ok(!JSON.stringify(out).includes('<ssh-user>'), 'the ssh user is never printed');
  const edge = JSON.parse(cli('init', '--project', SLUG, '--system', 'edge box', '--layer', 'INFRA').stdout);
  assert.equal(edge.prober.system.host, 'host.example.test');
  assert.equal(edge.prober.outputPath, path.join(edge.runDir, 'candidates', 'edge+box__infra-prober.json'));
  assert.equal(JSON.parse(cli('init', '--project', SLUG, '--system', 'alias', '--layer', 'INFRA').stdout).prober.system.host, 'homebox');
  const l3 = JSON.parse(cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--repo', TARGET).stdout);
  assert.ok(!('prober' in l3));
});

// ---- 0.5.0: group hunters, incremental L3 ----------------------------------------------------

// A run whose units.json was planned the 0.5.0 way: groups of files, bundles of classes, one hunter per group and bundle.
// groups: [{id, units, paths}]; bundles: [{id, classIds}] (pack web-nextjs). Returns {runId, dir, doc, key(g, b)}.
const B1 = ['authz-scoping', 'bulk-export'];
const B2 = ['ssrf'];
function setupGroups({ units, groups, bundles = [{ id: 'b1', classIds: B1 }, { id: 'b2', classIds: B2 }], layer = LAYER, extraUnits = [] } = {}) {
  store.writeProject(projectObject());
  const run = store.createRun(SLUG, { job: 'audit', layers: [layer], systems: [SYS], executor: 'local' });
  const cls = (id) => ({ pack: 'web-nextjs', packVersion: '1.0.0', classId: id });
  const doc = {
    layer, effort: 'medium', system: SYS, repoRoot: TARGET,
    units: [...units.map((u) => (typeof u === 'string' ? { id: u, kind: 'dir', files: 1, reachable: true } : { kind: 'dir', files: 1, reachable: true, ...u })), ...extraUnits],
    classes: [...B1, ...B2].map((id) => ({ ...cls(id), title: id, text: 'x' })),
    groups: groups.map((g) => ({ bytes: 1, reachable: true, ...g })),
    bundles: bundles.map((b) => ({ ...b, pack: 'web-nextjs', packVersion: '1.0.0' })),
    hunters: groups.flatMap((g) => bundles.map((b) => ({
      key: `${g.id}__${b.id}`, system: SYS, group: g.id, bundle: b.id, units: g.units, classIds: b.classIds, classes: b.classIds.map(cls),
    }))),
  };
  const dir = runDir(SLUG, run.runId);
  fs.mkdirSync(path.join(dir, 'candidates'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'votes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'units.json'), JSON.stringify(doc, null, 2));
  return { runId: run.runId, dir, doc };
}
const cand = (ref, classId, p, over = {}) => ({ ...rawCandidates('medium-idor')[0], ref, classId, location: { path: p, symbol: 'GET' }, ...over });
const unitsAfter = (s) => Object.fromEntries(JSON.parse(fs.readFileSync(path.join(s.dir, 'units.json'), 'utf8')).units.map((u) => [u.id, u]));

test('group hunter: each candidate keeps its own class (of the bundle) and the unit of its file; a class or file outside the hunter is invalid', () => {
  const s = setupGroups({
    units: ['app/api/users', 'lib'],
    groups: [{ id: 'g01', units: ['app/api/users', 'lib'], paths: ['app/api/users/route.ts', 'lib/auth.ts'] }],
  });
  const r = hio.writeCandidate(SLUG, s.runId, 'g01__b1', [
    cand('c1', 'authz-scoping', 'app/api/users/route.ts'),
    cand('c2', 'bulk-export', 'lib/auth.ts'),
    cand('c3', 'ssrf', 'lib/auth.ts'), // b2's class, not this hunter's
    cand('c4', 'authz-scoping', 'lib/db.ts'), // a file of the unit, but not of the group
    cand('c20', 'authz-scoping', 'lib/auth.ts', { title: 'Second lookup' }),
    cand('c21', 'authz-scoping', 'lib/auth.ts'),
  ]);
  assert.deepEqual(r.candidates.map((c) => [c.ref, c.classId, c.pack, c.hunter.unit]), [
    ['c1', 'authz-scoping', 'web-nextjs', 'app/api/users'],
    ['c2', 'bulk-export', 'web-nextjs', 'lib'],
    ['c20', 'authz-scoping', 'web-nextjs', 'lib'],
  ]);
  assert.ok(r.candidates.every((c) => c.hunter.agent === 'g01__b1'));
  assert.deepEqual(r.invalid.map((i) => i.reason), [
    "c3: classId is not one of this hunter's classes",
    "c4: location is not one of this hunter's files",
    'ref must be c1 to c20',
  ]);
  for (const c of r.candidates) assert.deepEqual(validate(loadSchema('candidate'), c), { ok: true, errors: [] });
});

test('group hunters: a unit is covered when every hunter of its group returned; a missing one fails every unit of its group', () => {
  const s = setupGroups({
    units: ['app/api/users', 'lib', 'app/api/export'],
    groups: [
      { id: 'g01', units: ['app/api/users', 'lib'], paths: ['app/api/users/route.ts', 'lib/auth.ts'] },
      { id: 'g02', units: ['app/api/export'], paths: ['app/api/export/route.ts'] },
    ],
  });
  for (const key of ['g01__b1', 'g01__b2', 'g02__b1']) hio.writeCandidate(SLUG, s.runId, key, []);
  const res = hio.assemble(SLUG, s.runId);
  assert.deepEqual(res.skipped.map((u) => [u.id, u.status, u.reason]), [['app/api/export', 'failed', 'hunter did not return: g02__b2']]);
  const ledger = store.readCoverage(SLUG);
  assert.deepEqual(ledger.units[`${SYS}|${LAYER}|lib`].classes, ['authz-scoping', 'bulk-export', 'ssrf'], 'the classes of every bundle hunted over it');
  assert.equal(ledger.units[`${SYS}|${LAYER}|app/api/export`].status, 'failed');
  const run = JSON.parse(fs.readFileSync(path.join(s.dir, 'run.json'), 'utf8'));
  assert.deepEqual(run.coverage, { planned: 3, covered: 2 });
});

test('group hunters: a unit split over two groups is covered only when both groups\' hunters returned', () => {
  const s = setupGroups({
    units: ['lib'],
    groups: [{ id: 'g01', units: ['lib'], paths: ['lib/auth.ts'] }, { id: 'g02', units: ['lib'], paths: ['lib/db.ts'] }],
    bundles: [{ id: 'b1', classIds: B1 }],
  });
  hio.writeCandidate(SLUG, s.runId, 'g01__b1', []);
  const res = hio.assemble(SLUG, s.runId);
  assert.deepEqual(res.skipped.map((u) => [u.id, u.reason]), [['lib', 'hunter did not return: g02__b1']]);
});

test('group hunters close a finding only where they looked: a covered unit, a class of a returned bundle, a file of the group', () => {
  const s = setupGroups({
    units: ['app/api/users', 'lib'],
    groups: [{ id: 'g01', units: ['app/api/users'], paths: ['app/api/users/route.ts'] }, { id: 'g02', units: ['lib'], paths: ['lib/auth.ts'] }],
    bundles: [{ id: 'b1', classIds: B1 }],
  });
  store.upsertFindings(SLUG, [
    storedHunt('a'.repeat(12), 'web-nextjs/authz-scoping', 'app/api/users/route.ts'), // hunted, not reported again: fixed
    storedHunt('b'.repeat(12), 'web-nextjs/ssrf', 'app/api/users/route.ts'), // a class this run did not hunt: open
    storedHunt('c'.repeat(12), 'web-nextjs/authz-scoping', 'app/api/users/NOTES.md'), // a file no hunter read: open
    storedHunt('d'.repeat(12), 'rampart/prompt-injection-attempt', 'lib/auth.ts', { class: 'hardening', severity: 'LOW' }), // read by g02: fixed
    storedHunt('e'.repeat(12), 'web-nextjs/bulk-export', 'lib/db.ts'), // lib's file, not in g02: open
  ], OLD_RUN);
  hio.writeCandidate(SLUG, s.runId, 'g01__b1', []);
  hio.writeCandidate(SLUG, s.runId, 'g02__b1', []);
  const res = hio.assemble(SLUG, s.runId);
  assert.deepEqual(statusById(), {
    ['a'.repeat(12)]: 'fixed', ['b'.repeat(12)]: 'open', ['c'.repeat(12)]: 'open', ['d'.repeat(12)]: 'fixed', ['e'.repeat(12)]: 'open',
  });
  assert.equal(res.counts.closed, 2);
});

test('group hunters: one at the cap of 20 keeps every unit of its group from closing; 19 does not; invalid entries do the same', () => {
  const twenty = (n) => Array.from({ length: n }, (_, i) => cand(`c${i + 1}`, 'authz-scoping', 'app/api/users/route.ts', { location: { path: 'app/api/users/route.ts', symbol: `h${i}` } }));
  for (const [n, capped] of [[20, true], [19, false]]) {
    const s = setupGroups({
      units: ['app/api/users', 'lib'],
      groups: [{ id: 'g01', units: ['app/api/users', 'lib'], paths: ['app/api/users/route.ts', 'lib/auth.ts'] }],
      bundles: [{ id: 'b1', classIds: B1 }],
    });
    store.upsertFindings(SLUG, [storedHunt('a'.repeat(12), 'web-nextjs/authz-scoping', 'lib/auth.ts')], OLD_RUN);
    hio.writeCandidate(SLUG, s.runId, 'g01__b1', twenty(n));
    const res = hio.assemble(SLUG, s.runId);
    const after = unitsAfter(s);
    assert.equal(after.lib.capped === true, capped, `${n} candidates`);
    assert.equal(after['app/api/users'].capped === true, capped);
    assert.equal(res.counts.closed, capped ? 0 : 1, `${n} candidates`);
  }
  const s = setupGroups({
    units: ['app/api/users', 'lib'],
    groups: [{ id: 'g01', units: ['app/api/users', 'lib'], paths: ['app/api/users/route.ts', 'lib/auth.ts'] }],
    bundles: [{ id: 'b1', classIds: B1 }],
  });
  store.upsertFindings(SLUG, [storedHunt('f'.repeat(12), 'web-nextjs/authz-scoping', 'lib/auth.ts')], OLD_RUN);
  hio.writeCandidate(SLUG, s.runId, 'g01__b1', [cand('c1', 'ssrf', 'lib/auth.ts')]);
  const res = hio.assemble(SLUG, s.runId);
  assert.equal(res.counts.invalid, 1);
  assert.equal(res.counts.closed, 0);
  assert.deepEqual([unitsAfter(s).lib.invalid, unitsAfter(s)['app/api/users'].invalid], [1, 1]);
});

test('group hunters: candidates are tallied and upserted as findings, voted by <group>__<bundle>#<ref>', () => {
  const s = setupGroups({ units: ['app/api/users'], groups: [{ id: 'g01', units: ['app/api/users'], paths: ['app/api/users/route.ts'] }], bundles: [{ id: 'b1', classIds: B1 }] });
  hio.writeCandidate(SLUG, s.runId, 'g01__b1', [cand('c12', 'bulk-export', 'app/api/users/route.ts')]);
  hio.writeVote(SLUG, s.runId, 'g01__b1__c12__1.json', { ...rawVote('confirm'), candidateRef: 'g01__b1#c12' });
  const res = hio.assemble(SLUG, s.runId);
  assert.equal(res.counts.verified, 1);
  const [f] = store.readFindings(SLUG);
  assert.equal(f.ruleId, 'web-nextjs/bulk-export');
  assert.equal(f.location.path, 'app/api/users/route.ts');
});

// A small git repository as an L3 target: two reachable units, committed, and the project pointing at it.
function l3Repo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart incr '));
  const git = (...args) => {
    const r = spawnSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  const put = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@example.com');
  put('app/api/a/handler.ts', 'a\n');
  put('lib/b.ts', 'b\n');
  put('screens/shot.png', 'png');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  store.writeProject(projectObject());
  return { repo, git, put, rm: () => fs.rmSync(repo, { recursive: true, force: true }) };
}
// Run init (CLI) and let every hunter return [] , then assemble: what a clean hunt of the repository leaves behind.
function cleanHunt(repo, ...extra) {
  const r = cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--repo', repo, ...extra);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  if (out.empty) return out;
  const doc = JSON.parse(fs.readFileSync(path.join(out.runDir, 'units.json'), 'utf8'));
  for (const h of doc.hunters) fs.writeFileSync(path.join(out.runDir, 'candidates', `${h.key}.json`), '[]');
  hio.assemble(SLUG, out.runId);
  return { ...out, doc: JSON.parse(fs.readFileSync(path.join(out.runDir, 'units.json'), 'utf8')) };
}

test('incremental L3: a second run at the same effort hunts nothing and creates no run; --full hunts everything again', () => {
  const t = l3Repo();
  try {
    const first = cleanHunt(t.repo, '--effort', 'low');
    assert.deepEqual(first.doc.units.map((u) => [u.id, u.status, u.changed]), [['app/api/a', 'covered', true], ['lib', 'covered', true]]);
    assert.ok(!first.doc.units.some((u) => u.id === 'screens'), 'a folder of images is never a unit');
    const runs = fs.readdirSync(runsDir()).length;
    const dry = JSON.parse(cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--repo', t.repo, '--dry-run').stdout);
    assert.deepEqual([dry.efforts.low.hunters, dry.efforts.low.skippedUnchanged, dry.efforts.low.agents, dry.efforts.low.workflows], [0, 2, 0, 0]);
    assert.equal(dry.efforts.medium.skippedUnchanged, 0, 'medium hunts classes low never did');
    const again = cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--effort', 'low', '--repo', t.repo);
    assert.equal(again.status, 0, again.stderr);
    const out = JSON.parse(again.stdout);
    assert.equal(out.empty, true);
    assert.equal(out.skippedUnchanged, 2);
    assert.match(out.message, /nothing to hunt: all 2 units are unchanged since their last L3 hunt at this effort; pass --full/);
    assert.equal(fs.readdirSync(runsDir()).length, runs, 'no run for nothing to hunt');
    const full = cleanHunt(t.repo, '--effort', 'low', '--full');
    assert.equal(full.plan.skippedUnchanged, 0);
    assert.equal(full.doc.full, true);
    assert.deepEqual(full.doc.units.map((u) => [u.id, u.status, u.changed]), [['app/api/a', 'covered', false], ['lib', 'covered', false]]);
    const dryFull = JSON.parse(cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--repo', t.repo, '--dry-run', '--full').stdout);
    assert.equal(dryFull.full, true);
    assert.equal(dryFull.efforts.low.hunters, 1);
    assert.equal(cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L2', '--repo', t.repo, '--full', '--dry-run').status, 2, '--full is L3 only');
  } finally {
    t.rm();
  }
});

test('incremental L3: only the changed unit is hunted; the unchanged one keeps its ledger entry and counts as covered', () => {
  const t = l3Repo();
  try {
    const first = cleanHunt(t.repo, '--effort', 'low');
    const before = store.readCoverage(SLUG).units[`${SYS}|L3|lib`];
    t.put('app/api/a/handler.ts', 'a2\n');
    t.git('commit', '-qam', 'change a');
    const second = cleanHunt(t.repo, '--effort', 'low');
    assert.deepEqual(second.plan, { units: 2, skippedUnchanged: 1, notHunted: 0, groups: 1, bundles: 1, hunters: 1 });
    assert.deepEqual(second.batches[0].groups.map((g) => g.units), [['app/api/a']]);
    const lib = second.doc.units.find((u) => u.id === 'lib');
    assert.deepEqual([lib.status, lib.coveredBy], ['unchanged', first.runId]);
    assert.equal(second.doc.units.find((u) => u.id === 'app/api/a').status, 'covered');
    const ledger = store.readCoverage(SLUG);
    assert.deepEqual(ledger.units[`${SYS}|L3|lib`], before, 'the unchanged unit keeps its entry (and its run)');
    assert.equal(ledger.units[`${SYS}|L3|app/api/a`].lastRun, second.runId);
    const run = JSON.parse(fs.readFileSync(path.join(second.runDir, 'run.json'), 'utf8'));
    assert.equal(run.status, 'done');
    assert.deepEqual(run.coverage, { planned: 2, covered: 2 });
    const md = require('../scripts/render-report.cjs').renderReport(SLUG, second.runId);
    assert.match(md, /- Units unchanged since their last hunt, not hunted again \(they keep their coverage\): 1 \(lib\)/);
    assert.match(md, /- Hunters: 1 \(1 group of source files x 1 class bundle\)/);
    assert.doesNotMatch(md.slice(md.indexOf('## Skips')), /lib/, 'an unchanged unit is not a skip');
  } finally {
    t.rm();
  }
});

test('incremental L3: a low run skips what a medium run covered, and a changed unit forgets the classes hunted on its old code', () => {
  const t = l3Repo();
  try {
    cleanHunt(t.repo, '--effort', 'medium');
    t.put('lib/b.ts', 'b2\n');
    t.git('commit', '-qam', 'change b');
    const low = cleanHunt(t.repo, '--effort', 'low');
    assert.deepEqual(low.plan.skippedUnchanged, 1);
    const ledger = store.readCoverage(SLUG);
    assert.deepEqual(ledger.units[`${SYS}|L3|lib`].classes, [...hio.LOW_CLASSES].sort(), 'lib changed: only what low hunted on the new code counts');
    assert.equal(ledger.units[`${SYS}|L3|app/api/a`].classes.length, 14, 'app/api/a unchanged and skipped: its medium entry stands');
    const medium = JSON.parse(cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--repo', t.repo, '--dry-run').stdout).efforts.medium;
    assert.deepEqual([medium.skippedUnchanged, medium.hunters], [1, 3], 'medium again: lib needs the classes low left out');
  } finally {
    t.rm();
  }
});

test('incremental L3: a run on a dirty tree never lets its units be skipped later', () => {
  const t = l3Repo();
  try {
    t.put('lib/scratch.ts', 'wip\n'); // untracked: the tree is dirty
    const first = cleanHunt(t.repo, '--effort', 'low');
    assert.equal(JSON.parse(fs.readFileSync(path.join(first.runDir, 'run.json'), 'utf8')).revision.dirty, true);
    fs.rmSync(path.join(t.repo, 'lib', 'scratch.ts'));
    const second = cleanHunt(t.repo, '--effort', 'low');
    assert.equal(second.plan.skippedUnchanged, 0);
  } finally {
    t.rm();
  }
});

// ---- review fixes: incomplete hunts, cross-cutting changes, relabels, exclusions, reasons ------

// cleanHunt, but each hunter returns the given candidates (fn(hunter) -> array) and the given votes are written before assemble.
function huntWith(repo, candidatesOf, { votes = () => [], args = ['--effort', 'low'] } = {}) {
  const out = JSON.parse(cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--repo', repo, ...args).stdout);
  if (out.empty) return out;
  const doc = JSON.parse(fs.readFileSync(path.join(out.runDir, 'units.json'), 'utf8'));
  for (const h of doc.hunters) {
    fs.writeFileSync(path.join(out.runDir, 'candidates', `${h.key}.json`), JSON.stringify(candidatesOf(h)));
    for (const [ref, n, verdict] of votes(h)) hio.writeVote(SLUG, out.runId, `${h.key}__${ref}__${n}.json`, { candidateRef: `${h.key}#${ref}`, verdict, reason: 'lib/b.ts:x traced.' });
  }
  hio.assemble(SLUG, out.runId);
  return out;
}
const libCand = (h, ref, symbol = 'x') => cand(ref, h.classIds[0], 'lib/b.ts', { location: { path: 'lib/b.ts', symbol } });

test('C1: a unit whose hunt was capped, had invalid entries, an undecided candidate or a missing vote is never skipped as unchanged', () => {
  const modes = {
    capped: { c: (h) => Array.from({ length: 20 }, (_, i) => libCand(h, `c${i + 1}`, `h${i}`)), v: () => [] },
    invalid: { c: (h) => [cand('c1', 'ssrf', 'lib/b.ts')], v: () => [] },
    undecided: { c: (h) => [libCand(h, 'c1')], v: () => [] },
    oneVote: { c: (h) => [libCand(h, 'c1')], v: () => [['c1', 1, 'rejected']] },
  };
  for (const [mode, { c, v }] of Object.entries(modes)) {
    const t = l3Repo();
    try {
      huntWith(t.repo, c, { votes: v });
      const entry = store.readCoverage(SLUG).units[`${SYS}|L3|lib`];
      assert.equal(entry.complete, false, mode);
      assert.equal(entry.engine, require('../scripts/hunt-plan.cjs').HUNT_ENGINE);
      assert.equal(store.readCoverage(SLUG).units[`${SYS}|L3|app/api/a`].complete, mode === 'capped' || mode === 'invalid' ? false : true, `${mode}: the group's other unit`);
      const again = JSON.parse(cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--effort', 'low', '--repo', t.repo).stdout);
      assert.ok(!again.empty, `${mode}: the second run hunts again`);
      assert.ok(again.batches[0].groups[0].units.includes('lib'), mode);
    } finally {
      t.rm();
    }
  }
  // Two rejecting votes settle the candidate: the hunt is complete and the unit can be skipped next time.
  const t = l3Repo();
  try {
    huntWith(t.repo, (h) => [libCand(h, 'c1')], { votes: () => [['c1', 1, 'rejected'], ['c1', 2, 'rejected']] });
    assert.equal(store.readCoverage(SLUG).units[`${SYS}|L3|lib`].complete, true);
    assert.equal(JSON.parse(cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--effort', 'low', '--repo', t.repo).stdout).empty, true);
  } finally {
    t.rm();
  }
});

test('C2: a cross-cutting change anywhere re-hunts every unit, and a skip expires with the system\'s L3 cadence', () => {
  let t = l3Repo();
  try {
    cleanHunt(t.repo, '--effort', 'low');
    t.put('package.json', '{"dependencies":{"x":"2"}}\n');
    t.git('add', '-A');
    t.git('commit', '-qm', 'bump');
    const out = cleanHunt(t.repo, '--effort', 'low');
    assert.equal(out.plan.skippedUnchanged, 0, 'a manifest change re-hunts everything');
  } finally {
    t.rm();
  }
  t = l3Repo();
  try {
    const first = cleanHunt(t.repo, '--effort', 'low');
    const p = projectObject();
    p.systems[0].layers.L3.cadenceDays = 1;
    store.writeProject(p);
    // The first hunt finished two days ago: past a one-day cadence.
    const runFile = path.join(first.runDir, 'run.json');
    fs.writeFileSync(runFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(runFile, 'utf8')), finishedAt: new Date(Date.now() - 2 * 86400000).toISOString() }));
    assert.equal(cleanHunt(t.repo, '--effort', 'low').plan.skippedUnchanged, 0);
  } finally {
    t.rm();
  }
});

test('I5: a ledger entry from another hunt engine (or from 0.4, with none) never qualifies for a skip', () => {
  const t = l3Repo();
  try {
    cleanHunt(t.repo, '--effort', 'low');
    const ledger = store.readCoverage(SLUG);
    for (const e of Object.values(ledger.units)) delete e.engine;
    store.writeCoverage(SLUG, ledger);
    assert.equal(cleanHunt(t.repo, '--effort', 'low').plan.skippedUnchanged, 0);
  } finally {
    t.rm();
  }
});

test('I4: a finding is not closed when this run has any candidate at the same place, of another class and even rejected', () => {
  const s = setupGroups({ units: ['app/api/users'], groups: [{ id: 'g01', units: ['app/api/users'], paths: ['app/api/users/route.ts'] }], bundles: [{ id: 'b1', classIds: B1 }] });
  store.upsertFindings(SLUG, [
    storedHunt('a'.repeat(12), 'web-nextjs/authz-scoping', 'app/api/users/route.ts', { location: { path: 'app/api/users/route.ts', symbol: 'GET' } }),
    storedHunt('b'.repeat(12), 'web-nextjs/authz-scoping', 'app/api/users/route.ts', { location: { path: 'app/api/users/route.ts', symbol: 'POST' } }),
  ], OLD_RUN);
  // The same flaw at GET, relabelled bulk-export, and rejected by both verifiers.
  hio.writeCandidate(SLUG, s.runId, 'g01__b1', [cand('c1', 'bulk-export', 'app/api/users/route.ts')]);
  for (const n of [1, 2]) hio.writeVote(SLUG, s.runId, `g01__b1__c1__${n}.json`, { ...rawVote('reject'), candidateRef: 'g01__b1#c1' });
  const res = hio.assemble(SLUG, s.runId);
  assert.deepEqual(statusById(), { ['a'.repeat(12)]: 'open', ['b'.repeat(12)]: 'fixed' }, 'GET stays open; POST, with no candidate there, closes');
  assert.equal(res.counts.closed, 1);
});

test('I1/I3: oversize source is listed as not hunted (a folder of only that is a uncovered unit); credential files are named, never read', () => {
  store.writeProject(projectObject());
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart scope '));
  try {
    const put = (rel, body) => {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), body);
    };
    put('app/api/x/handler.ts', 'x');
    put('app/api/x/.env', 'SECRET=1');
    put('app/api/x/README.md', 'notes');
    put('src/data/male.ts', 'x'.repeat(250 * 1024));
    put('screens/a.png', 'png');
    const r = cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--effort', 'low', '--repo', repo);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.plan, { units: 2, skippedUnchanged: 0, notHunted: 1, groups: 1, bundles: 1, hunters: 1 });
    assert.deepEqual(out.batches[0].groups, [{ group: 'g01', units: ['app/api/x'], paths: ['app/api/x/handler.ts'], present: ['app/api/x/.env'], bytes: 1 }]);
    const doc = JSON.parse(fs.readFileSync(path.join(out.runDir, 'units.json'), 'utf8'));
    const data = doc.units.find((u) => u.id === 'src/data');
    assert.equal(data.status, 'not-hunted');
    assert.deepEqual(data.oversize, [{ path: 'src/data/male.ts', bytes: 250 * 1024, reason: 'over 200 KB' }]);
    assert.deepEqual(doc.excluded, { byClass: { image: 1, prose: 1 }, oversize: data.oversize, present: [], submodules: [] });
    fs.writeFileSync(path.join(out.runDir, 'candidates', 'g01__b1.json'), '[]');
    const res = hio.assemble(SLUG, out.runId);
    assert.deepEqual(res.skipped.map((u) => [u.id, u.status]), [['src/data', 'not-hunted']]);
    const run = JSON.parse(fs.readFileSync(path.join(out.runDir, 'run.json'), 'utf8'));
    assert.deepEqual(run.coverage, { planned: 2, covered: 1 }, 'a folder whose code is too large to read is not covered');
    assert.equal(store.readCoverage(SLUG).units[`${SYS}|L3|src/data`].status, 'failed', 'and it stays a gap in the ledger');
    const md = require('../scripts/render-report.cjs').renderReport(SLUG, out.runId);
    assert.match(md, /- Not read, as non-code: 1 image, 1 prose/);
    assert.match(md, /- Not hunted, over the size cap: 1 file \(src\/data\/male\.ts 250 KB\)/);
    assert.match(md, /- Possible credential files, named to the hunters but never opened: app\/api\/x\/\.env/);
    assert.match(md, /A group can span unrelated folders, and each hunter hunts several classes in one pass/);
    assert.match(md, /- src\/data: not-hunted, all its source is over the size cap/);
    const dry = JSON.parse(cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--repo', repo, '--dry-run').stdout);
    assert.deepEqual(dry.excluded, { byClass: { image: 1, prose: 1 }, oversizeFiles: 1, oversizeBytes: 250 * 1024, presentFiles: 1, submodules: 0 });
    assert.match(dry.tokensNote, /rough context-size estimate/);
    assert.equal(dry.efforts.low.notHunted, 1);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('I6: an effort with no hunter says why: no source, none reachable at this effort, all too large, or all unchanged', () => {
  store.writeProject(projectObject());
  const make = (files) => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart why '));
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), body);
    }
    return repo;
  };
  const cases = [
    [{ 'README.md': 'x', 'a.png': 'p' }, { low: 'no-source', medium: 'no-source', high: 'no-source' }],
    [{ 'docs/build.sh': 'x' }, { low: 'none-at-effort', medium: 'none-at-effort', high: undefined }],
    [{ 'src/big.ts': 'x'.repeat(201 * 1024) }, { low: 'all-oversize', medium: 'all-oversize', high: 'all-oversize' }],
  ];
  for (const [files, want] of cases) {
    const repo = make(files);
    try {
      const dry = JSON.parse(cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--repo', repo, '--dry-run').stdout);
      for (const [effort, reason] of Object.entries(want)) {
        assert.equal(dry.efforts[effort].reason, reason, `${Object.keys(files)} ${effort}`);
        if (reason) assert.equal(dry.efforts[effort].hunters, 0);
      }
      const r = cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--effort', 'low', '--repo', repo);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.deepEqual([out.empty, out.reason], [true, want.low]);
      assert.ok(!/unchanged/.test(out.message), out.message);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }
  assert.ok(!fs.existsSync(runsDir()), 'none of these creates a run');
});
