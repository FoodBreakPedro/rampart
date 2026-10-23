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
const TOKEN = 'q8Zx3Lm9Vb2NkR7tYw4Pc1Hd';

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
  const planned = hunters || units.flatMap((u) => ['authz-scoping', 'bulk-export'].map((c) => [u, c]));
  const doc = {
    layer, effort: 'high', system: SYS, repoRoot: TARGET,
    units: units.map((id) => ({ id, kind: 'dir', files: 1, reachable: true })),
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
  const doc = JSON.parse(fs.readFileSync(path.join(s.dir, 'units.json'), 'utf8'));
  assert.equal(doc.units.find((u) => u.id === 'app/api/export').status, 'failed');
  assert.equal(doc.units.find((u) => u.id === 'app/api/users').status, 'covered');
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
    title: "Export route returns every tenant's rows",
  }]);
});

// ---- init ------------------------------------------------------------------------------------

const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: process.env });
const runsDir = () => path.join(home, 'projects', SLUG, 'runs');

test('init prints the workflow args and plans every class on every unit at high effort', () => {
  store.writeProject(projectObject());
  const r = cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--effort', 'high', '--repo', TARGET);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.runId, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
  assert.equal(out.runDir, runDir(SLUG, out.runId));
  const a = out.args;
  assert.deepEqual(Object.keys(a).sort(), ['classes', 'effort', 'layer', 'project', 'repoRoot', 'runDir', 'runId', 'systems', 'units'].sort());
  assert.equal(a.project, SLUG);
  assert.equal(a.layer, 'L3');
  assert.equal(a.effort, 'high');
  assert.equal(a.repoRoot, path.resolve(TARGET));
  assert.deepEqual(a.systems, [{ id: SYS, type: 'web-nextjs', kind: 'code' }]);
  assert.deepEqual(a.units.map((u) => u.unit).sort(), ['.', 'app/api/export', 'app/api/invoices', 'app/api/users', 'lib']);
  assert.ok(a.units.every((u) => u.system === SYS && Number.isInteger(u.files)));
  assert.equal(a.classes.length, 14);
  const authz = a.classes.find((c) => c.classId === 'authz-scoping');
  assert.deepEqual(Object.keys(authz).sort(), ['classId', 'pack', 'packVersion', 'text']);
  assert.match(authz.text, /\*\*Look for:\*\*/);
  assert.match(authz.text, /\*\*Confirm by:\*\*/);
  assert.match(authz.text, /\*\*Disprove by:\*\*/);
  assert.match(authz.text, /\*\*Severity when confirmed:\*\* HIGH\. Any signed-in user/);
  assert.match(authz.text, /\*\*CWE:\*\* CWE-639, CWE-862, CWE-863/);
  const doc = JSON.parse(fs.readFileSync(path.join(out.runDir, 'units.json'), 'utf8'));
  assert.equal(doc.hunters.length, 5 * 14);
  assert.ok(fs.statSync(path.join(out.runDir, 'candidates')).isDirectory());
  assert.ok(fs.statSync(path.join(out.runDir, 'votes')).isDirectory());
  const run = JSON.parse(fs.readFileSync(path.join(out.runDir, 'run.json'), 'utf8'));
  assert.equal(run.job, 'audit');
  assert.deepEqual(run.layers, ['L3']);
});

test('init at low effort plans only the LOW classes, and only on reachable units', () => {
  store.writeProject(projectObject());
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart low '));
  try {
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'app', 'api', 'x'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs', 'a.md'), 'x');
    fs.writeFileSync(path.join(repo, 'app', 'api', 'x', 'route.ts'), 'x');
    const low = JSON.parse(cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--effort', 'low', '--repo', repo).stdout);
    assert.deepEqual(low.args.classes.map((c) => c.classId).sort(), [...hio.LOW_CLASSES].sort());
    assert.deepEqual(low.args.units.map((u) => u.unit), ['app/api/x']);
    const doc = JSON.parse(fs.readFileSync(path.join(low.runDir, 'units.json'), 'utf8'));
    assert.deepEqual(doc.hunters.map((h) => h.unit), Array(hio.LOW_CLASSES.length).fill('app/api/x'));
    const onTarget = JSON.parse(cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--effort', 'low', '--repo', TARGET).stdout);
    assert.deepEqual(onTarget.args.classes.map((c) => c.classId).sort(), [...hio.LOW_CLASSES].sort());
    assert.equal(onTarget.args.units.length, 5);
    const high = JSON.parse(cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--effort', 'high', '--repo', repo).stdout);
    assert.deepEqual(high.args.units.map((u) => u.unit).sort(), ['app/api/x', 'docs']);
    const medium = JSON.parse(cli('init', '--project', SLUG, '--system', SYS, '--layer', 'L3', '--effort', 'medium', '--repo', repo).stdout);
    assert.deepEqual(medium.args.units.map((u) => u.unit), ['app/api/x']);
    assert.equal(medium.args.classes.length, 14);
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
    assert.deepEqual(JSON.parse(r2.stdout).args.units.map((u) => u.unit), ['app/api/y']);
    const run = JSON.parse(fs.readFileSync(path.join(JSON.parse(r2.stdout).runDir, 'run.json'), 'utf8'));
    assert.match(run.revision.commit, /^[0-9a-f]{40}$/);
    assert.equal(run.revision.dirty, false);
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
  assert.match(ev('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij'), /^\[REDACTED\]/);
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
