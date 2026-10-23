const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { validate, loadSchema } = require('../scripts/lib/validate.cjs');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---- validator keywords, on inline schemas ------------------------------------------------

test('type: scalars, integer vs number, and the root reported as $', () => {
  assert.deepEqual(validate({ type: 'string' }, 'x'), { ok: true, errors: [] });
  assert.deepEqual(validate({ type: 'string' }, 5).errors, ['$: expected string, got number']);
  assert.equal(validate({ type: 'integer' }, 3).ok, true);
  assert.deepEqual(validate({ type: 'integer' }, 1.5).errors, ['$: expected integer, got number']);
  assert.equal(validate({ type: 'number' }, 1.5).ok, true);
  assert.deepEqual(validate({ type: 'boolean' }, 'true').errors, ['$: expected boolean, got string']);
});

test('type: object, array and null are distinct', () => {
  assert.deepEqual(validate({ type: 'object' }, []).errors, ['$: expected object, got array']);
  assert.deepEqual(validate({ type: 'object' }, null).errors, ['$: expected object, got null']);
  assert.deepEqual(validate({ type: 'array' }, {}).errors, ['$: expected array, got object']);
  assert.equal(validate({ type: 'null' }, null).ok, true);
});

test('type: a list of types allows any of them (nullable values)', () => {
  const s = { type: ['string', 'null'] };
  assert.equal(validate(s, 'x').ok, true);
  assert.equal(validate(s, null).ok, true);
  assert.deepEqual(validate(s, 3).errors, ['$: expected string or null, got number']);
});

test('required and properties, with dotted paths', () => {
  const s = {
    type: 'object',
    required: ['a', 'b'],
    properties: { a: { type: 'string' }, b: { type: 'object', required: ['c'], properties: { c: { type: 'integer' } } } },
  };
  assert.equal(validate(s, { a: 'x', b: { c: 1 } }).ok, true);
  assert.deepEqual(validate(s, { a: 'x' }).errors, ['b: required property missing']);
  assert.deepEqual(validate(s, { a: 'x', b: {} }).errors, ['b.c: required property missing']);
  assert.deepEqual(validate(s, { a: 1, b: { c: 'z' } }).errors, ['a: expected string, got number', 'b.c: expected integer, got string']);
  // a property whose value is undefined counts as missing
  assert.deepEqual(validate({ type: 'object', required: ['a'] }, { a: undefined }).errors, ['a: required property missing']);
});

test('items, with array indexes in the path', () => {
  const s = { type: 'array', items: { type: 'string' } };
  assert.equal(validate(s, ['a', 'b']).ok, true);
  assert.deepEqual(validate(s, ['a', 2]).errors, ['$[1]: expected string, got number']);
  const nested = { type: 'object', properties: { xs: s } };
  assert.deepEqual(validate(nested, { xs: [1] }).errors, ['xs[0]: expected string, got number']);
});

test('enum', () => {
  const s = { enum: ['a', 'b'] };
  assert.equal(validate(s, 'a').ok, true);
  assert.deepEqual(validate(s, 'c').errors, ['$: expected one of a, b']);
  assert.deepEqual(validate({ enum: [1, null] }, 2).errors, ['$: expected one of 1, null']);
  assert.equal(validate({ enum: [1, null] }, null).ok, true);
});

test('additionalProperties: false rejects unknown keys; omitted leaves the object open', () => {
  const closed = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
  assert.equal(validate(closed, { a: 'x' }).ok, true);
  assert.deepEqual(validate(closed, { a: 'x', b: 1 }).errors, ['b: unexpected property']);
  const nested = { type: 'object', properties: { o: closed } };
  assert.deepEqual(validate(nested, { o: { z: 1 } }).errors, ['o.z: unexpected property']);
  const open = { type: 'object', properties: { a: { type: 'string' } } };
  assert.equal(validate(open, { a: 'x', b: 1 }).ok, true);
});

test('pattern applies to strings only and does not echo the value', () => {
  const s = { type: 'string', pattern: '^[0-9a-f]{12}$' };
  assert.equal(validate(s, 'a3f9c21be0d4').ok, true);
  assert.deepEqual(validate(s, 'hunter2-secret').errors, ['$: does not match pattern ^[0-9a-f]{12}$']);
  assert.equal(validate({ pattern: '^x$' }, 5).ok, true);
});

test('minimum and minLength', () => {
  const n = { type: 'integer', minimum: 1 };
  assert.equal(validate(n, 1).ok, true);
  assert.deepEqual(validate(n, 0).errors, ['$: expected integer >= 1']);
  assert.deepEqual(validate({ type: 'number', minimum: 0.5 }, 0.1).errors, ['$: expected number >= 0.5']);
  const s = { type: 'string', minLength: 1 };
  assert.equal(validate(s, 'x').ok, true);
  assert.deepEqual(validate(s, '').errors, ['$: expected string of at least 1 character']);
  assert.deepEqual(validate({ type: 'string', minLength: 3 }, 'ab').errors, ['$: expected string of at least 3 characters']);
  assert.equal(validate({ minLength: 1 }, 5).ok, true);
});

test('a type mismatch is reported once and skips the other keywords', () => {
  assert.deepEqual(validate({ type: 'integer', minimum: 1 }, 'x').errors, ['$: expected integer, got string']);
  assert.deepEqual(validate({ type: 'string', pattern: '^a$', minLength: 2 }, 7).errors, ['$: expected string, got number']);
});

test('oneOf passes on exactly one matching branch and reports the count otherwise', () => {
  const s = { oneOf: [{ type: 'string' }, { type: 'integer' }] };
  assert.equal(validate(s, 'x').ok, true);
  assert.equal(validate(s, 3).ok, true);
  assert.deepEqual(validate(s, true).errors, ['$: matched 0 of 2 oneOf branches']);
  const overlap = { oneOf: [{ type: 'number' }, { type: 'integer' }] };
  assert.deepEqual(validate(overlap, 3).errors, ['$: matched 2 of 2 oneOf branches']);
  assert.equal(validate(overlap, 3.5).ok, true);
  const nested = { type: 'object', properties: { loc: s } };
  assert.deepEqual(validate(nested, { loc: [] }).errors, ['loc: matched 0 of 2 oneOf branches']);
});

test('validate never throws on odd input', () => {
  const s = loadSchema('project');
  for (const v of [undefined, null, 0, '', [], {}, 'x', () => 1, Symbol('s'), { __proto__: null }]) {
    const r = validate(s, v);
    assert.equal(typeof r.ok, 'boolean');
    assert.ok(Array.isArray(r.errors));
  }
  const evil = JSON.parse('{"__proto__": {"polluted": true}, "slug": "ok-slug"}');
  assert.equal(validate(s, evil).ok, false);
  assert.equal({}.polluted, undefined);
});

// ---- loadSchema ---------------------------------------------------------------------------

test('loadSchema returns the four parsed schemas and caches them', () => {
  for (const name of ['project', 'finding', 'run', 'job']) {
    const s = loadSchema(name);
    assert.equal(typeof s, 'object');
    assert.equal(s.type, 'object');
    assert.equal(s.additionalProperties, false, `${name} schema is closed at the top level`);
    assert.equal(loadSchema(name), s, `${name} schema is cached`);
  }
});

test('loadSchema rejects names outside the four, including path tricks', () => {
  for (const bad of ['nope', '', '../package', 'project-schema', undefined, null, 42]) {
    assert.throws(() => loadSchema(bad), /unknown schema/);
  }
});

test('loadSchema resolves from the repo, not from process.cwd()', () => {
  // A fresh process, so this process's schema cache cannot hide a cwd dependency.
  const modulePath = path.join(__dirname, '..', 'scripts', 'lib', 'validate.cjs');
  const script = `process.stdout.write(require(${JSON.stringify(modulePath)}).loadSchema('run').type)`;
  const out = execFileSync(process.execPath, ['-e', script], { cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(out, 'object');
});

test('every keyword used in the shipped schemas is one the validator implements', () => {
  const ANNOTATIONS = ['$schema', '$id', 'title', 'description'];
  const IMPLEMENTED = ['type', 'required', 'properties', 'enum', 'items', 'additionalProperties', 'oneOf', 'pattern', 'minimum', 'minLength'];
  const walk = (node, where) => {
    for (const key of Object.keys(node)) {
      assert.ok(ANNOTATIONS.includes(key) || IMPLEMENTED.includes(key), `${where}: unsupported keyword ${key}`);
    }
    for (const [k, sub] of Object.entries(node.properties || {})) walk(sub, `${where}.${k}`);
    if (node.items) walk(node.items, `${where}[]`);
    (node.oneOf || []).forEach((sub, i) => walk(sub, `${where}.oneOf[${i}]`));
  };
  for (const name of ['project', 'finding', 'run', 'job']) walk(loadSchema(name), name);
});

// ---- project ------------------------------------------------------------------------------

test('project fixture validates', () => {
  const r = validate(loadSchema('project'), fixture('project.valid.json'));
  assert.deepEqual(r, { ok: true, errors: [] });
});

test('fixtures carry placeholder values only', () => {
  for (const name of ['project.valid.json', 'finding.valid.json']) {
    const text = fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
    for (const ip of text.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) || []) {
      assert.match(ip, /^192\.0\.2\./, `${name}: ${ip} is not a documentation address`);
    }
    assert.doesNotMatch(text, /[A-Za-z]:\\|\/Users\/|\/home\//, `${name}: contains a local path`);
  }
});

test('project missing ownerAttestation fails and names it', () => {
  const p = fixture('project.valid.json');
  delete p.ownerAttestation;
  const r = validate(loadSchema('project'), p);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['ownerAttestation: required property missing']);
});

test('project with an empty attestation statement fails on that path only', () => {
  const p = fixture('project.valid.json');
  p.ownerAttestation.statement = '';
  const r = validate(loadSchema('project'), p);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['ownerAttestation.statement: expected string of at least 1 character']);
});

test('project: cadenceDays below 1 reports the full dotted path', () => {
  const p = fixture('project.valid.json');
  p.systems[0].layers.L1.cadenceDays = 0;
  assert.deepEqual(validate(loadSchema('project'), p).errors, ['systems[0].layers.L1.cadenceDays: expected integer >= 1']);
  p.systems[0].layers.L1.cadenceDays = 7.5;
  assert.deepEqual(validate(loadSchema('project'), p).errors, ['systems[0].layers.L1.cadenceDays: expected integer, got number']);
});

test('project: slug pattern, enums and stray top-level fields are caught with their paths', () => {
  const s = loadSchema('project');
  const bad = (mutate) => {
    const p = fixture('project.valid.json');
    mutate(p);
    return validate(s, p).errors;
  };
  assert.deepEqual(bad((p) => { p.slug = 'Has Spaces'; }), ['slug: does not match pattern ^[a-z0-9-]{2,40}$']);
  assert.deepEqual(bad((p) => { p.slug = 'a'; }), ['slug: does not match pattern ^[a-z0-9-]{2,40}$']);
  assert.deepEqual(bad((p) => { p.criticality = 'extreme'; }), ['criticality: expected one of low, medium, high']);
  assert.deepEqual(bad((p) => { p.defaultExecutor = 'either'; }), ['defaultExecutor: expected one of local, cloud']);
  assert.deepEqual(bad((p) => { p.cloudAllowed = 'no'; }), ['cloudAllowed: expected boolean, got string']);
  assert.deepEqual(bad((p) => { p.systems[1].type = 'mainframe'; }), [
    'systems[1].type: expected one of web-nextjs, node-api, mobile-expo, supabase, n8n, docker-host, cloudflare-workers, wordpress-hostinger, static-site, other',
  ]);
  assert.deepEqual(bad((p) => { p.systems[1].criticality = 'vip'; }), ['systems[1].criticality: expected one of auth, billing, data, public, internal']);
  assert.deepEqual(bad((p) => { p.systems[0].executor = 'edge'; }), ['systems[0].executor: expected one of local, cloud, either']);
  assert.deepEqual(bad((p) => { delete p.systems[1].host.ssh; }), ['systems[1].host.ssh: required property missing']);
  assert.deepEqual(bad((p) => { delete p.systems[0].repo.paths; }), ['systems[0].repo.paths: required property missing']);
  assert.deepEqual(bad((p) => { delete p.systems[1].live.url; }), ['systems[1].live.url: required property missing']);
  assert.deepEqual(bad((p) => { p.systems[0].packs = 'mobile-expo'; }), ['systems[0].packs: expected array, got string']);
  assert.deepEqual(bad((p) => { p.systems[0].layers.L9 = { cadenceDays: 1 }; }), [], 'layers stay open to extra keys');
  assert.deepEqual(bad((p) => { p.owner = 'me'; }), ['owner: unexpected property']);
});

test('project: required top-level fields', () => {
  const s = loadSchema('project');
  for (const key of ['slug', 'name', 'criticality', 'ownerAttestation', 'defaultExecutor', 'cloudAllowed', 'systems']) {
    const p = fixture('project.valid.json');
    delete p[key];
    assert.deepEqual(validate(s, p).errors, [`${key}: required property missing`]);
  }
  // created and updated are stamped by the store, so a project without them is still valid input
  const p = fixture('project.valid.json');
  delete p.created;
  delete p.updated;
  assert.equal(validate(s, p).ok, true);
});

// ---- finding ------------------------------------------------------------------------------

test('finding fixture validates', () => {
  assert.deepEqual(validate(loadSchema('finding'), fixture('finding.valid.json')), { ok: true, errors: [] });
});

test('finding with severity SEVERE fails with an enum error at severity', () => {
  const f = fixture('finding.valid.json');
  f.severity = 'SEVERE';
  const r = validate(loadSchema('finding'), f);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['severity: expected one of CRITICAL, HIGH, MEDIUM, LOW']);
});

test('finding with id xyz fails the pattern at id', () => {
  const f = fixture('finding.valid.json');
  f.id = 'xyz';
  const r = validate(loadSchema('finding'), f);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['id: does not match pattern ^[0-9a-f]{12}$']);
});

test('finding: enums for class, status, confidence, layer and source', () => {
  const s = loadSchema('finding');
  const bad = (mutate) => {
    const f = fixture('finding.valid.json');
    mutate(f);
    return validate(s, f).errors;
  };
  assert.deepEqual(bad((f) => { f.class = 'speculative'; }), ['class: expected one of verified, tool, hardening']);
  assert.deepEqual(bad((f) => { f.status = 'wontfix'; }), ['status: expected one of open, fixed, false_positive, accepted_risk, regressed']);
  assert.deepEqual(bad((f) => { f.confidence = 'CERTAIN'; }), ['confidence: expected one of HIGH, MEDIUM, LOW']);
  assert.deepEqual(bad((f) => { f.layer = 'L4'; }), ['layer: expected one of L1, L2, L3, INFRA']);
  assert.deepEqual(bad((f) => { f.source = 'burp'; }), [
    'source: expected one of gitleaks, trivy, npm-audit, pnpm-audit, headers, claude-security, rampart-hunter, rampart-lite, infra-probe, manual',
  ]);
  for (const cls of ['verified', 'tool', 'hardening']) assert.deepEqual(bad((f) => { f.class = cls; }), []);
  for (const st of ['open', 'fixed', 'false_positive', 'accepted_risk', 'regressed']) assert.deepEqual(bad((f) => { f.status = st; }), []);
});

test('finding: required fields, nullable fields and stray fields', () => {
  const s = loadSchema('finding');
  for (const key of ['id', 'project', 'system', 'layer', 'source', 'ruleId', 'title', 'severity', 'confidence', 'class', 'location', 'evidence', 'status']) {
    const f = fixture('finding.valid.json');
    delete f[key];
    assert.deepEqual(validate(s, f).errors, [`${key}: required property missing`], key);
  }
  // optional: store-stamped timestamps, tool findings have no exploit write-up, pack, cwe or verification
  const lean = fixture('finding.valid.json');
  for (const key of ['pack', 'cwe', 'exploitScenario', 'preconditions', 'recommendation', 'verification', 'firstSeen', 'lastSeen', 'fixedIn', 'externalIds']) delete lean[key];
  assert.equal(validate(s, lean).ok, true);
  const f = fixture('finding.valid.json');
  f.fixedIn = 'abc123def456';
  f.externalIds = { claudeSecurityPluginFindingId: 'CS-1', cve: ['CVE-2026-0001'] };
  assert.equal(validate(s, f).ok, true);
  f.externalIds.cve = [7];
  assert.deepEqual(validate(s, f).errors, ['externalIds.cve[0]: expected string, got number']);
  const g = fixture('finding.valid.json');
  g.title = 5;
  g.cwe = [284];
  g.extra = true;
  assert.deepEqual(validate(s, g).errors, ['title: expected string, got number', 'cwe[0]: expected string, got number', 'extra: unexpected property']);
});

test('finding: verification needs verifiers, confirmed and run', () => {
  const s = loadSchema('finding');
  const f = fixture('finding.valid.json');
  f.verification = { verifiers: 2, confirmed: -1 };
  assert.deepEqual(validate(s, f).errors, ['verification.run: required property missing', 'verification.confirmed: expected integer >= 0']);
  f.verification = { verifiers: '2', confirmed: 1, run: 'r' };
  assert.deepEqual(validate(s, f).errors, ['verification.verifiers: expected integer, got string']);
});

test('finding.location accepts exactly the four shapes', () => {
  const s = loadSchema('finding');
  const withLocation = (loc) => {
    const f = fixture('finding.valid.json');
    f.location = loc;
    return validate(s, f);
  };
  const good = [
    { path: 'src/app.ts' },
    { path: 'src/app.ts', symbol: 'handler', line: 42, commit: 'abcdef123456' },
    { path: '.env', symbol: null, commit: 'abcdef123456' },
    { host: '192.0.2.10' },
    { host: '192.0.2.10', service: 'supabase-auth', setting: 'GOTRUE_DISABLE_SIGNUP' },
    { url: 'https://app.example.invalid/' },
    { url: 'https://app.example.invalid/', header: 'csp' },
    { package: 'lodash' },
    { package: 'lodash', ecosystem: 'npm' },
    { package: 'lodash', ecosystem: 'npm', path: 'package-lock.json' },
  ];
  for (const loc of good) assert.deepEqual(withLocation(loc).errors, [], JSON.stringify(loc));
  const bad = [
    {},
    { service: 'supabase-auth' },
    { path: 'a', host: 'h' },
    { path: 'a', url: 'https://x.invalid' },
    { host: 'h', package: 'p' },
    { path: 'a', extra: 1 },
    { host: 'h', extra: 1 },
    { url: 'u', symbol: 's' },
    { package: 'p', setting: 's' },
  ];
  for (const loc of bad) assert.deepEqual(withLocation(loc).errors, ['location: matched 0 of 4 oneOf branches'], JSON.stringify(loc));
  assert.deepEqual(withLocation('src/app.ts').errors, ['location: matched 0 of 4 oneOf branches']);
});

test('finding.location: line must be an integer when present', () => {
  const f = fixture('finding.valid.json');
  f.location = { path: 'a.ts', line: 1.5 };
  assert.deepEqual(validate(loadSchema('finding'), f).errors, ['location: matched 0 of 4 oneOf branches']);
});

// ---- run ----------------------------------------------------------------------------------

const validRun = () => ({
  runId: '2026-10-23T18-02-11Z',
  project: 'example-app',
  job: 'audit',
  layers: ['L1', 'INFRA'],
  systems: ['mobile', 'db'],
  executor: 'local',
  status: 'done',
  startedAt: '2026-10-23T18:02:11Z',
  finishedAt: '2026-10-23T18:05:00Z',
  counts: { added: 2, updated: 0, unchanged: 1, hardening: 3 },
  revision: { commit: 'abcdef123456', dirty: false },
  tool: { name: 'gitleaks', version: '8.18.0' },
});

test('run schema accepts a full run and a minimal running run', () => {
  const s = loadSchema('run');
  assert.deepEqual(validate(s, validRun()), { ok: true, errors: [] });
  const minimal = {
    runId: '2026-10-23T18-02-11Z', project: 'example-app', job: 'inventory', layers: [], systems: [],
    executor: 'cloud', status: 'running', startedAt: '2026-10-23T18:02:11Z',
    counts: { added: 0, updated: 0, unchanged: 0, hardening: 0 },
  };
  assert.deepEqual(validate(s, minimal), { ok: true, errors: [] });
  assert.equal(validate(s, { ...validRun(), status: 'skipped', reason: 'no repo on this machine' }).ok, true);
});

test('run schema: enums, counts, nested objects and stray fields', () => {
  const s = loadSchema('run');
  const bad = (mutate) => {
    const r = validRun();
    mutate(r);
    return validate(s, r).errors;
  };
  assert.deepEqual(bad((r) => { r.job = 'deploy'; }), ['job: expected one of inventory, audit, verify, fix, apply, dashboard, doctor, import']);
  assert.deepEqual(bad((r) => { r.status = 'paused'; }), ['status: expected one of running, done, skipped, failed']);
  assert.deepEqual(bad((r) => { r.executor = 'either'; }), ['executor: expected one of local, cloud']);
  assert.deepEqual(bad((r) => { r.layers = ['L1', 'L5']; }), ['layers[1]: expected one of L1, L2, L3, INFRA']);
  assert.deepEqual(bad((r) => { r.systems = [1]; }), ['systems[0]: expected string, got number']);
  assert.deepEqual(bad((r) => { delete r.counts.hardening; }), ['counts.hardening: required property missing']);
  assert.deepEqual(bad((r) => { r.counts.added = -1; }), ['counts.added: expected integer >= 0']);
  assert.deepEqual(bad((r) => { r.revision.dirty = 'yes'; }), ['revision.dirty: expected boolean, got string']);
  assert.deepEqual(bad((r) => { delete r.tool.name; }), ['tool.name: required property missing']);
  assert.deepEqual(bad((r) => { r.surprise = 1; }), ['surprise: unexpected property']);
  for (const key of ['runId', 'project', 'job', 'layers', 'systems', 'executor', 'status', 'startedAt', 'counts']) {
    assert.deepEqual(bad((r) => { delete r[key]; }), [`${key}: required property missing`], key);
  }
  for (const job of ['inventory', 'audit', 'verify', 'fix', 'apply', 'dashboard', 'doctor', 'import']) assert.deepEqual(bad((r) => { r.job = job; }), []);
});

// ---- job ----------------------------------------------------------------------------------

const validJob = () => ({
  id: 'job-0001',
  type: 'audit',
  project: 'example-app',
  system: 'mobile',
  layer: 'L1',
  findingId: 'a3f9c21be0d4',
  params: { scope: 'full', anything: [1, 2] },
  executorKind: 'local',
  status: 'queued',
  createdBy: '<owner>',
  confirmedAt: '2026-10-23T18:00:00Z',
  costShown: '~$2',
  updatedAt: '2026-10-23T18:00:00Z',
});

test('job schema accepts a queued job, a minimal job and a finished job', () => {
  const s = loadSchema('job');
  assert.deepEqual(validate(s, validJob()), { ok: true, errors: [] });
  const minimal = {
    id: 'job-0002', type: 'inventory', project: 'example-app', executorKind: 'cloud', status: 'queued',
    createdBy: '<owner>', confirmedAt: '2026-10-23T18:00:00Z', costShown: 0, updatedAt: '2026-10-23T18:00:00Z',
  };
  assert.deepEqual(validate(s, minimal), { ok: true, errors: [] });
  const done = { ...validJob(), status: 'done', claimedAt: '2026-10-23T18:00:30Z', claimedBy: 'session-1', startedAt: '2026-10-23T18:01:00Z', finishedAt: '2026-10-23T18:02:00Z', resultSummary: '2 added', runId: '2026-10-23T18-01-00Z' };
  assert.deepEqual(validate(s, done), { ok: true, errors: [] });
});

test('job schema: enums, patterns, required fields and stray fields', () => {
  const s = loadSchema('job');
  const bad = (mutate) => {
    const j = validJob();
    mutate(j);
    return validate(s, j).errors;
  };
  assert.deepEqual(bad((j) => { j.status = 'cancelled'; }), ['status: expected one of queued, claimed, running, done, failed']);
  assert.deepEqual(bad((j) => { j.executorKind = 'either'; }), ['executorKind: expected one of local, cloud']);
  assert.deepEqual(bad((j) => { j.executor = 'local'; }), ['executor: unexpected property']);
  assert.deepEqual(bad((j) => { j.type = 'deploy'; }), ['type: expected one of inventory, audit, verify, fix, apply, dashboard, doctor, import']);
  assert.deepEqual(bad((j) => { j.layer = 'L9'; }), ['layer: expected one of L1, L2, L3, INFRA']);
  assert.deepEqual(bad((j) => { j.findingId = 'xyz'; }), ['findingId: does not match pattern ^[0-9a-f]{12}$']);
  assert.deepEqual(bad((j) => { j.params = 'full'; }), ['params: expected object, got string']);
  assert.deepEqual(bad((j) => { j.costShown = true; }), ['costShown: expected string or number, got boolean']);
  assert.deepEqual(bad((j) => { j.queue = 'x'; }), ['queue: unexpected property']);
  for (const key of ['id', 'type', 'project', 'executorKind', 'status', 'createdBy', 'confirmedAt', 'costShown', 'updatedAt']) {
    assert.deepEqual(bad((j) => { delete j[key]; }), [`${key}: required property missing`], key);
  }
});

// ---- dashboard fields (live DB documents) -------------------------------------------------

test('job: applyConfirmation, costEstimate and sessionId validate; null confirmation is allowed', () => {
  const s = loadSchema('job');
  const apply = {
    ...validJob(), type: 'apply', findingId: 'a3f9c21be0d4', sessionId: 'session-9',
    costEstimate: { agents: 3, note: '~3 agents' },
    applyConfirmation: { typed: 'a3f9c21be0d4', at: '2026-10-23T18:00:10Z' },
  };
  assert.deepEqual(validate(s, apply), { ok: true, errors: [] });
  assert.deepEqual(validate(s, { ...apply, applyConfirmation: null }), { ok: true, errors: [] });
  const bad = (mutate) => {
    const j = clone(apply);
    mutate(j);
    return validate(s, j).errors;
  };
  assert.deepEqual(bad((j) => { delete j.applyConfirmation.typed; }), ['applyConfirmation.typed: required property missing']);
  assert.deepEqual(bad((j) => { j.applyConfirmation = 'yes'; }), ['applyConfirmation: expected object or null, got string']);
  assert.deepEqual(bad((j) => { delete j.costEstimate.note; }), ['costEstimate.note: required property missing']);
  assert.deepEqual(bad((j) => { j.costEstimate.agents = '3'; }), ['costEstimate.agents: expected integer, got string']);
  assert.deepEqual(bad((j) => { j.sessionId = 7; }), ['sessionId: expected string, got number']);
});

test('finding: disposition is {status, reason, by, at} or null; updatedAt is a string', () => {
  const s = loadSchema('finding');
  const f = fixture('finding.valid.json');
  f.updatedAt = '2026-10-23T18:10:00Z';
  f.disposition = null;
  assert.deepEqual(validate(s, f), { ok: true, errors: [] });
  f.disposition = { status: 'accepted_risk', reason: 'internal tool only', by: '<owner>', at: '2026-10-23T18:10:00Z' };
  assert.deepEqual(validate(s, f), { ok: true, errors: [] });
  for (const status of ['open', 'fixed', 'false_positive', 'accepted_risk']) {
    assert.deepEqual(validate(s, { ...f, disposition: { ...f.disposition, status } }).errors, [], status);
  }
  assert.deepEqual(validate(s, { ...f, disposition: { ...f.disposition, status: 'regressed' } }).errors, ['disposition.status: expected one of open, fixed, false_positive, accepted_risk']);
  const missing = clone(f);
  delete missing.disposition.by;
  assert.deepEqual(validate(s, missing).errors, ['disposition.by: required property missing']);
  assert.deepEqual(validate(s, { ...f, disposition: 'open' }).errors, ['disposition: expected object or null, got string']);
  assert.deepEqual(validate(s, { ...f, updatedAt: 5 }).errors, ['updatedAt: expected string, got number']);
});

test('run: updatedAt and reportMd are optional strings', () => {
  const s = loadSchema('run');
  assert.deepEqual(validate(s, { ...validRun(), updatedAt: '2026-10-23T18:05:00Z', reportMd: '# Report' }), { ok: true, errors: [] });
  assert.deepEqual(validate(s, { ...validRun(), reportMd: 3 }).errors, ['reportMd: expected string, got number']);
});

test('project: huntEffort is an optional low|medium|high', () => {
  const s = loadSchema('project');
  for (const e of ['low', 'medium', 'high']) assert.deepEqual(validate(s, { ...fixture('project.valid.json'), huntEffort: e }).errors, [], e);
  assert.deepEqual(validate(s, { ...fixture('project.valid.json'), huntEffort: 'max' }).errors, ['huntEffort: expected one of low, medium, high']);
});

// ---- db-rules.json ------------------------------------------------------------------------

test('db-rules.json is the array form: root plus one owner-write rule per collection', () => {
  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'skills', 'rampart', 'specs', 'db-rules.json'), 'utf8'));
  assert.ok(Array.isArray(rules));
  assert.deepEqual(rules[0], { path: '', read: 'view', write: 'owner' });
  const collections = ['projects', 'findings', 'runs', 'jobs', 'executors', 'packs', 'meta'];
  assert.deepEqual(rules.slice(1).map((r) => r.path), collections);
  for (const r of rules) {
    assert.deepEqual(Object.keys(r).sort(), ['path', 'read', 'write']);
    assert.equal(r.read, 'view', `${r.path || '(root)'} read`);
    assert.equal(r.write, 'owner', `${r.path || '(root)'} write`);
  }
});
