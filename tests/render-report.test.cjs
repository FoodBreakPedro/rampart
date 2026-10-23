const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const store = require('../scripts/store.cjs');
const { scoreProject } = require('../scripts/score.cjs');
const { runDir, machineId } = require('../scripts/lib/paths.cjs');
const { renderReport } = require('../scripts/render-report.cjs');

const CLI = path.join(__dirname, '..', 'scripts', 'render-report.cjs');
const SLUG = 'example-app';
const TOKEN = 'q8Zx3Lm9Vb2NkR7tYw4Pc1HdZk5Jf0';
const AWS = 'AKIAFAKEFAKEFAKEFAKE';

const savedHome = process.env.RAMPART_HOME;
let home;
test.beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart report '));
  process.env.RAMPART_HOME = home;
});
test.afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.RAMPART_HOME;
  else process.env.RAMPART_HOME = savedHome;
});

const project = () => ({
  slug: SLUG, name: 'Example App', criticality: 'high',
  ownerAttestation: { statement: 'I own every system listed here', by: '<owner>', at: '2026-10-23T00:00:00Z' },
  defaultExecutor: 'local', cloudAllowed: false,
  systems: [
    { id: 'web', type: 'web-nextjs', name: 'Web', packs: ['web-nextjs'], repo: { remote: 'github.com/<owner>/example-app', defaultBranch: 'main', paths: { [machineId()]: __dirname } }, executor: 'local', layers: { L2: { cadenceDays: 30 }, L3: { cadenceDays: 90 } } },
    { id: 'db', type: 'supabase', name: 'Supabase', packs: ['supabase'], host: { ssh: '<ssh-user>@192.0.2.10', composeProject: '<compose-project>' }, executor: 'local', layers: { INFRA: { cadenceDays: 30 } } },
  ],
});

const finding = (over = {}) => ({
  id: 'aaaaaaaaaaaa', project: SLUG, system: 'web', layer: 'L3', source: 'rampart-hunter', pack: 'web-nextjs@1.0.0',
  ruleId: 'web-nextjs/authz-scoping', title: 'Record access not scoped', severity: 'HIGH', confidence: 'HIGH', cwe: [],
  class: 'verified', location: { path: 'app/api/users/route.ts', symbol: 'GET' }, evidence: 'ok', exploitScenario: 'x', preconditions: 'x', recommendation: 'x', status: 'open',
  ...over,
});

// A run with a units.json, as init and assemble leave it.
function setup({ layer = 'L3', system = 'web', units, findings = [], runPatch = {}, unitsPatch = {} } = {}) {
  store.writeProject(project());
  const run = store.createRun(SLUG, { job: 'audit', layers: [layer], systems: [system], executor: 'local' });
  const dir = runDir(SLUG, run.runId);
  const doc = {
    layer, effort: 'high', system, repoRoot: null,
    units: units || [
      { id: 'app/api/users', kind: 'dir', files: 3, reachable: true, status: 'covered' },
      { id: 'app/api/export', kind: 'dir', files: 2, reachable: true, status: 'skipped', reason: 'agent timed out' },
    ],
    classes: [{ pack: 'web-nextjs', packVersion: '1.0.0', classId: 'authz-scoping', title: 'T', text: 'x' }],
    hunters: [], ...unitsPatch,
  };
  fs.writeFileSync(path.join(dir, 'units.json'), JSON.stringify(doc, null, 2));
  if (findings.length) store.upsertFindings(SLUG, findings.map((f) => ({ ...f, verification: { verifiers: 2, confirmed: 2, run: run.runId } })), run.runId);
  store.finishRun(SLUG, run.runId, { status: 'done', counts: { added: findings.length }, revision: { commit: 'abc1234def', dirty: false }, ...runPatch });
  return { runId: run.runId, dir };
}

const headings = (md) => md.split('\n').filter((l) => /^#{1,6} /.test(l));

test('the report has the six sections in order and is written atomically to the run dir', () => {
  const { runId, dir } = setup({ findings: [finding(), finding({ id: 'bbbbbbbbbbbb', class: 'hardening', severity: 'LOW', title: 'Missing header' })] });
  const md = renderReport(SLUG, runId);
  assert.equal(fs.readFileSync(path.join(dir, 'REPORT.md'), 'utf8'), md);
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.tmp')).length, 0);
  assert.deepEqual(headings(md).filter((h) => !h.startsWith('### ')), [
    `# Example App: audit L3, run ${runId}`, '## Coverage', '## Findings', '## Skips', '## Score after this run',
  ]);
  assert.match(md, /### HIGH\n- `aaaaaaaaaaaa` Record access not scoped/);
  assert.match(md, /### Hardening\n- `bbbbbbbbbbbb`/);
  assert.ok(!md.includes('### CRITICAL'));
  assert.match(md, /app\/api\/users\/route\.ts:GET/);
  assert.match(md, /web-nextjs@1\.0\.0/);
  assert.match(md, /abc1234/);
});

test('a skipped unit is listed under Skips with its reason, and invalid candidates are noted', () => {
  const { runId } = setup({ units: [
    { id: 'app/api/users', kind: 'dir', files: 3, reachable: true, status: 'covered', invalid: 2 },
    { id: 'app/api/export', kind: 'dir', files: 2, reachable: true, status: 'skipped', reason: 'agent timed out' },
  ] });
  const md = renderReport(SLUG, runId);
  const skips = md.split('## Skips')[1].split('## Score')[0];
  assert.match(skips, /app\/api\/export/);
  assert.match(skips, /agent timed out/);
  assert.match(skips, /2 invalid candidate\(s\) ignored; findings in this unit were not closed/);
});

test('a skipped run puts its own reason under Skips', () => {
  const { runId } = setup({ layer: 'INFRA', system: 'db', units: [], runPatch: { status: 'skipped', reason: 'host unreachable (connect timeout)' } });
  const md = renderReport(SLUG, runId);
  assert.match(md.split('## Skips')[1], /host unreachable \(connect timeout\)/);
});

test('evidence, planted credential values and other withheld fields never reach the report', () => {
  const { runId, dir } = setup({ findings: [finding()] });
  const file = path.join(home, 'projects', SLUG, 'findings.jsonl');
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  rows[0].evidence = `leaked ${TOKEN} and ${AWS}`;
  rows[0].exploitScenario = 'EXPLOIT-TEXT';
  rows[0].recommendation = 'RECOMMEND-TEXT';
  rows[0].preconditions = 'PRECOND-TEXT';
  rows[0].title = `Token ${AWS} exposed`;
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const md = renderReport(SLUG, runId);
  for (const bad of [TOKEN, AWS, 'EXPLOIT-TEXT', 'RECOMMEND-TEXT', 'PRECOND-TEXT', 'leaked']) assert.ok(!md.includes(bad), bad);
  assert.ok(fs.existsSync(path.join(dir, 'REPORT.md')));
});

test('the score section matches scoreProject', () => {
  const { runId } = setup({ findings: [finding(), finding({ id: 'cccccccccccc', severity: 'MEDIUM', title: 'Other' })] });
  const now = new Date();
  const md = renderReport(SLUG, runId, { now });
  const expected = scoreProject(store.readProject(SLUG), store.readFindings(SLUG), store.readRuns(SLUG), now);
  const section = md.split('## Score after this run')[1];
  assert.ok(section.includes(`${expected.grade}`));
  assert.ok(section.includes(expected.score.toFixed(1)));
  assert.match(section, /no trend yet/);
  for (const [id, s] of Object.entries(expected.systems)) {
    const row = section.split('\n').find((l) => l.startsWith(`| ${id} |`));
    assert.equal(row, `| ${id} | ${s.grade} | ${s.score.toFixed(1)} | ${s.coverage.toFixed(1)} | ${s.findingsScore.toFixed(1)} | ${s.hardening} |`);
  }
  assert.match(section, /\| System \| Grade \| Score \| Coverage \| Findings \| Hardening \|/);
});

test('a title with a newline and a heading renders on one line with no new heading', () => {
  const { runId } = setup({ findings: [finding({ title: 'Real title\n# Injected\r\n## More | cell `tick`' })] });
  const md = renderReport(SLUG, runId);
  assert.ok(!headings(md).some((h) => /Injected|More/.test(h)));
  assert.ok(!md.split('\n').some((l) => /^\s*#+\s*Injected/.test(l)));
  const line = md.split('\n').find((l) => l.includes('aaaaaaaaaaaa'));
  assert.match(line, /Real title/);
  assert.match(line, /Injected/);
  assert.ok(!/(?<!\\)\|/.test(line), 'pipes are escaped');
  const long = renderReport(SLUG, setup({ findings: [finding({ id: 'dddddddddddd', title: 'x'.repeat(500) })] }).runId);
  assert.ok(long.split('\n').find((l) => l.includes('dddddddddddd')).length < 300);
});

test('no findings is said in one plain line', () => {
  const { runId } = setup();
  const md = renderReport(SLUG, runId);
  const body = md.split('## Findings')[1].split('## Skips')[0].trim();
  assert.equal(body, 'No findings in this run.');
});

test('INFRA locations read host service setting and urls read as the url', () => {
  const { runId } = setup({ layer: 'INFRA', system: 'db', units: [{ id: 'probe:ports', kind: 'probe', reachable: true, status: 'covered' }],
    findings: [
      finding({ system: 'db', layer: 'INFRA', source: 'infra-probe', location: { host: '192.0.2.10', service: 'postgres', setting: 'listen_addresses' } }),
      finding({ id: 'eeeeeeeeeeee', system: 'db', layer: 'INFRA', class: 'tool', severity: 'LOW', location: { url: 'https://example.com/x' }, title: 'Header' }),
    ] });
  const md = renderReport(SLUG, runId);
  assert.match(md, /192\.0\.2\.10 postgres listen_addresses/);
  assert.match(md, /https:\/\/example\.com\/x/);
  assert.match(md, /Coverage[\s\S]*probe:ports/);
});

test('an L2 run reports its layer and only its own findings', () => {
  const { runId } = setup({ layer: 'L2', findings: [finding({ layer: 'L2' })] });
  store.upsertFindings(SLUG, [finding({ id: 'ffffffffffff', system: 'db', layer: 'INFRA', title: 'Other system' })], runId);
  const md = renderReport(SLUG, runId);
  assert.match(md, /^# Example App: audit L2, run /);
  assert.ok(!md.includes('Other system'));
  assert.match(md, /Record access not scoped/);
});

test('a long unit list is truncated with "and N more"', () => {
  const units = Array.from({ length: 45 }, (_, i) => ({ id: `u${String(i).padStart(2, '0')}`, kind: 'dir', files: 1, reachable: true, status: 'covered' }));
  const md = renderReport(SLUG, setup({ units }).runId);
  assert.match(md, /and 15 more/);
  assert.ok(md.includes('u29') && !md.includes('u30'));
});

test('a bad run id is refused', () => {
  setup();
  assert.throws(() => renderReport(SLUG, '../../etc'), RangeError);
  assert.throws(() => renderReport(SLUG, '2020-01-01T00-00-00Z'), /no run/);
});

test('the CLI prints the path of REPORT.md', () => {
  const { runId, dir } = setup({ findings: [finding()] });
  const r = spawnSync(process.execPath, [CLI, '--project', SLUG, '--run', runId], { encoding: 'utf8', env: { ...process.env, RAMPART_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), path.join(dir, 'REPORT.md'));
  const bad = spawnSync(process.execPath, [CLI, '--project', SLUG], { encoding: 'utf8', env: { ...process.env, RAMPART_HOME: home } });
  assert.equal(bad.status, 2);
});
