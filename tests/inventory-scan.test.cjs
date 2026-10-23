const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validate, loadSchema } = require('../scripts/lib/validate.cjs');
const { machineId } = require('../scripts/lib/paths.cjs');
const { which, run } = require('../scripts/lib/exec.cjs');
const { detectSystems, draftProject, assignIds, stripCredentials } = require('../scripts/inventory-scan.cjs');

const CLI = path.join(__dirname, '..', 'scripts', 'inventory-scan.cjs');
const schema = loadSchema('project');
const fixtureDir = (name) => path.join(__dirname, 'fixtures', 'repos', name);
const GIT = which('git');

const ATTESTATION = { statement: 'I own or am authorized to test every system listed here', by: 'tester', at: '2026-10-23T00:00:00Z' };
const REPO_LAYERS = { L1: { cadenceDays: 7 }, L2: { cadenceDays: 30 }, L3: { cadenceDays: 90 } };
const HOST_LAYERS = { INFRA: { cadenceDays: 30 }, L3: { cadenceDays: 90 } };

// Environment variables a test changes, put back afterwards (undefined means "was not set").
const TOUCHED = ['RAMPART_GIT', 'PATH', 'GIT_CEILING_DIRECTORIES', 'SHIM_REMOTE', 'SHIM_HEAD', 'SHIM_EXIT', 'SHIM_LOG'];
const saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));

// A scratch folder for every test, named with spaces and shell characters, filled from {relative/path: text}.
// git never looks above the scratch root, so a folder that is not a repo is not mistaken for part of one.
const made = [];
test.beforeEach(() => {
  for (const k of TOUCHED) delete process.env[k];
  process.env.PATH = saved.PATH;
  process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
});
test.afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
function tmp(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart inv & (x) '));
  made.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return dir;
}
const pkg = (dependencies, devDependencies) => JSON.stringify({ dependencies, devDependencies });
const compose = (...images) => `services:\n${images.map((image, i) => `  s${i}:\n    image: ${image}\n`).join('')}`;
const typesIn = (dir) => detectSystems(dir).map((s) => s.type);
const errorPaths = (errors) => errors.map((e) => e.slice(0, e.indexOf(':')));

// ---- detectSystems ------------------------------------------------------------------------

const FIXTURES = [
  { name: 'nextjs', types: ['web-nextjs'], evidence: { 'web-nextjs': ['package.json#dependencies.next'] } },
  { name: 'expo', types: ['mobile-expo'], evidence: { 'mobile-expo': ['package.json#dependencies.expo', 'app.json#expo'] } },
  { name: 'supabase', types: ['supabase'], evidence: { supabase: ['supabase/config.toml'] } },
  {
    name: 'compose',
    types: ['n8n', 'docker-host'],
    evidence: { n8n: ['docker-compose.yml#image:n8nio/n8n'], 'docker-host': ['docker-compose.yml'] },
  },
  { name: 'workers', types: ['cloudflare-workers'], evidence: { 'cloudflare-workers': ['wrangler.toml'] } },
  { name: 'wp', types: ['wordpress-hostinger'], evidence: { 'wordpress-hostinger': ['wp-content/'] } },
  { name: 'plain', types: ['node-api'], evidence: { 'node-api': ['package.json#dependencies.express'] } },
];

for (const { name, types, evidence } of FIXTURES) {
  test(`fixture ${name} yields exactly ${types.join(' + ')}, marked inferred, with its evidence`, () => {
    const systems = detectSystems(fixtureDir(name));
    assert.deepEqual(systems.map((s) => s.type), types);
    for (const s of systems) {
      assert.equal(s.source, 'inferred');
      assert.deepEqual(s.evidence, evidence[s.type]);
      assert.equal(typeof s.id, 'string');
      assert.equal(typeof s.name, 'string');
      assert.ok(Array.isArray(s.packs) && s.packs.length > 0);
    }
  });
}

test('each type has its id, readable name and packs', () => {
  const byType = {};
  for (const { name } of FIXTURES) for (const s of detectSystems(fixtureDir(name))) byType[s.type] = s;
  const brief = ({ id, name, packs }) => ({ id, name, packs });
  assert.deepEqual(brief(byType['web-nextjs']), { id: 'web', name: 'Next.js app', packs: ['web-nextjs'] });
  assert.deepEqual(brief(byType['node-api']), { id: 'api', name: 'Node API', packs: ['node-api'] });
  assert.deepEqual(brief(byType['mobile-expo']), { id: 'mobile', name: 'Expo app', packs: ['mobile-expo'] });
  assert.deepEqual(brief(byType.supabase), { id: 'db', name: 'Self-hosted Supabase', packs: ['supabase', 'docker-host'] });
  assert.deepEqual(brief(byType.n8n), { id: 'n8n', name: 'n8n automation', packs: ['n8n', 'docker-host'] });
  assert.deepEqual(brief(byType['docker-host']), { id: 'host', name: 'Docker host', packs: ['docker-host'] });
  assert.deepEqual(brief(byType['cloudflare-workers']), { id: 'workers', name: 'Cloudflare Workers', packs: ['cloudflare-workers'] });
  assert.deepEqual(brief(byType['wordpress-hostinger']), { id: 'wp', name: 'WordPress site', packs: ['wordpress-hostinger'] });
});

test('a folder with nothing recognizable yields no systems', () => {
  assert.deepEqual(detectSystems(tmp()), []);
  assert.deepEqual(detectSystems(tmp({ 'README.md': '# hi', 'src/index.js': 'console.log(1)', '.env': 'A=1' })), []);
  assert.deepEqual(detectSystems(tmp({ 'package.json': pkg({ lodash: '*' }, { vitest: '*' }) })), []);
});

test('an unreadable or odd package.json is ignored, not fatal', () => {
  for (const text of ['{ not json', '', '[]', 'null', '"next"', '{"dependencies": "next"}', '{"dependencies": ["next"]}']) {
    assert.deepEqual(detectSystems(tmp({ 'package.json': text })), [], text);
  }
  assert.deepEqual(typesIn(tmp({ 'package.json': `\uFEFF${pkg({ next: '*' })}` })), ['web-nextjs']);
});

test('dependencies and devDependencies both count', () => {
  assert.deepEqual(detectSystems(tmp({ 'package.json': pkg({}, { next: '*' }) }))[0].evidence, ['package.json#devDependencies.next']);
});

test('node-api: express, fastify, hono or koa, but not alongside next', () => {
  for (const framework of ['express', 'fastify', 'hono', 'koa']) {
    const [system] = detectSystems(tmp({ 'package.json': pkg({ [framework]: '*' }) }));
    assert.equal(system.type, 'node-api', framework);
    assert.deepEqual(system.evidence, [`package.json#dependencies.${framework}`]);
  }
  assert.deepEqual(detectSystems(tmp({ 'package.json': pkg({ express: '*', fastify: '*' }) }))[0].evidence, [
    'package.json#dependencies.express', 'package.json#dependencies.fastify',
  ]);
  assert.deepEqual(typesIn(tmp({ 'package.json': pkg({ next: '*', express: '*' }) })), ['web-nextjs']);
  assert.deepEqual(typesIn(tmp({ 'package.json': pkg({ koa: '*' }, { next: '*' }) })), ['web-nextjs']);
});

test('mobile-expo: the expo dependency, or app.json with an expo key', () => {
  assert.deepEqual(typesIn(tmp({ 'app.json': '{"expo": {}}' })), ['mobile-expo']);
  assert.deepEqual(typesIn(tmp({ 'app.json': '{"name": "x"}' })), []);
  assert.deepEqual(typesIn(tmp({ 'app.json': '{ not json' })), []);
  assert.deepEqual(detectSystems(tmp({ 'package.json': pkg({ expo: '*' }) }))[0].evidence, ['package.json#dependencies.expo']);
});

test('supabase: supabase/config.toml or an infra/supabase folder', () => {
  assert.deepEqual(detectSystems(tmp({ 'infra/supabase/.env.example': '' })).map((s) => [s.type, s.evidence]), [['supabase', ['infra/supabase']]]);
  assert.deepEqual(detectSystems(tmp({ 'supabase/migrations/001.sql': '' })), []);
  assert.deepEqual(detectSystems(tmp({ infra: '' })), []); // a file named infra is not the folder
  assert.deepEqual(typesIn(tmp({ 'supabase/config.toml': '', 'infra/supabase/x': '' })), ['supabase']);
});

test('cloudflare-workers: wrangler.toml, wrangler.json or wrangler.jsonc', () => {
  for (const file of ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc']) {
    assert.deepEqual(detectSystems(tmp({ [file]: '' })).map((s) => [s.type, s.evidence]), [['cloudflare-workers', [file]]], file);
  }
  assert.deepEqual(typesIn(tmp({ 'wrangler.yaml': '', 'src/wrangler.toml': '' })), []);
});

test('wordpress-hostinger: a wp-content folder or a wp-config*.php file', () => {
  assert.deepEqual(detectSystems(tmp({ 'wp-config.php': '<?php' })).map((s) => [s.type, s.evidence]), [['wordpress-hostinger', ['wp-config.php']]]);
  assert.deepEqual(detectSystems(tmp({ 'wp-config-sample.php': '<?php' }))[0].type, 'wordpress-hostinger');
  assert.deepEqual(detectSystems(tmp({ 'wp-content/themes/a/style.css': '', 'wp-config.php': '' }))[0].evidence, ['wp-content/', 'wp-config.php']);
  assert.deepEqual(typesIn(tmp({ 'wp-content': '' })), []); // a file named wp-content is not the folder
  assert.deepEqual(typesIn(tmp({ 'wp-config.txt': '', 'config.php': '' })), []);
});

test('docker-host: docker-compose*.yml|yaml and compose.yml|yaml in the folder', () => {
  for (const file of ['docker-compose.yml', 'docker-compose.yaml', 'docker-compose.prod.yml', 'docker-compose.override.yaml', 'compose.yml', 'compose.yaml']) {
    assert.deepEqual(detectSystems(tmp({ [file]: 'services: {}\n' })).map((s) => [s.type, s.evidence]), [['docker-host', [file]]], file);
  }
  for (const file of ['docker-compose.txt', 'docker-compose', 'mycompose.yml', 'compose.yml.bak', 'compose.json']) {
    assert.deepEqual(typesIn(tmp({ [file]: 'services: {}\n' })), [], file);
  }
  assert.deepEqual(detectSystems(tmp({ 'docker-compose.yml': '', 'compose.yaml': '' }))[0].evidence, ['compose.yaml', 'docker-compose.yml']);
  assert.deepEqual(typesIn(tmp({ 'deploy/docker-compose.yml': '' })), []); // only the folder itself is read
});

test('n8n: only an image line naming n8nio/n8n counts', () => {
  const yes = [
    'n8nio/n8n', 'n8nio/n8n:latest', 'n8nio/n8n:1.80.0', 'docker.n8n.io/n8nio/n8n', 'docker.n8n.io/n8nio/n8n:1.80.0',
    'registry.example.com:5000/n8nio/n8n:2', '"n8nio/n8n"', "'n8nio/n8n:1'", 'n8nio/n8n@sha256:abc123',
    // ${VAR:-default} and ${VAR-default} count as their default; ${VAR} alone leaves the rest of the name to decide
    '${N8N_IMAGE:-n8nio/n8n:latest}', '${N8N_IMAGE-n8nio/n8n}', '"${N8N_IMAGE:-n8nio/n8n:1}"',
    '${REGISTRY:-docker.n8n.io}/n8nio/n8n:1', 'n8nio/n8n:${N8N_TAG:-latest}', 'n8nio/n8n:${N8N_TAG}',
  ];
  for (const image of yes) {
    assert.deepEqual(typesIn(tmp({ 'docker-compose.yml': compose(image) })), ['n8n', 'docker-host'], image);
  }
  const no = [
    'n8nio/n8n-custom', 'myorg/n8nio-n8n', 'n8nio/runners', 'postgres:16', 'n8n',
    '${N8N_IMAGE:-postgres:16}', '${N8N_IMAGE}', '${N8N_IMAGE:-}', 'postgres:${N8N_TAG:-n8nio/n8n}x',
  ];
  for (const image of no) {
    assert.deepEqual(typesIn(tmp({ 'docker-compose.yml': compose(image) })), ['docker-host'], image);
  }
  const other = {
    'list item': 'services:\n  a:\n    containers:\n      - image: n8nio/n8n\n',
    'flow mapping': 'services: { n8n: { image: n8nio/n8n } }\n',
    'trailing comment': 'services:\n  a:\n    image: n8nio/n8n # the automation server\n',
    'CRLF line ends': 'services:\r\n  a:\r\n    image: n8nio/n8n\r\n',
    'flow mapping with a trailing comment': 'services: { n8n: { image: n8nio/n8n } } # keep this one\n',
  };
  for (const [label, text] of Object.entries(other)) assert.deepEqual(typesIn(tmp({ 'docker-compose.yml': text })), ['n8n', 'docker-host'], label);
  const notImage = {
    'commented out': 'services:\n  a:\n    # image: n8nio/n8n\n',
    'named in a command': 'services:\n  a:\n    command: pull n8nio/n8n\n',
    'in an env value': 'services:\n  a:\n    environment:\n      IMAGE: n8nio/n8n\n',
    'commented-out flow mapping': '# services: { n8n: { image: n8nio/n8n } }\n',
    'indented commented-out flow mapping': 'services:\n  # a: { image: n8nio/n8n }\n',
    'comment mentioning image:': '# pin this, image: n8nio/n8n later\n',
    'comment tail mentioning image:': 'services:\n  a:\n    ports: [80] # pin this, image: n8nio/n8n later\n',
    'comment tail of a flow mapping': 'services: { a: { ports: [80] } } # { image: n8nio/n8n }\n',
  };
  for (const [label, text] of Object.entries(notImage)) assert.deepEqual(typesIn(tmp({ 'docker-compose.yml': text })), ['docker-host'], label);
});

test('n8n evidence names every compose file that has the image', () => {
  const dir = tmp({ 'docker-compose.yml': compose('postgres:16'), 'docker-compose.prod.yml': compose('n8nio/n8n'), 'compose.yaml': compose('n8nio/n8n:1') });
  const n8n = detectSystems(dir).find((s) => s.type === 'n8n');
  assert.deepEqual(n8n.evidence, ['compose.yaml#image:n8nio/n8n', 'docker-compose.prod.yml#image:n8nio/n8n']);
});

test('supabase/postgres in a compose file is not, by itself, a supabase system', () => {
  assert.deepEqual(typesIn(tmp({ 'docker-compose.yml': compose('supabase/postgres:15') })), ['docker-host']);
});

test('one folder can yield several systems, in table order, with distinct ids; its repo types fold into one', () => {
  const dir = tmp({
    'package.json': pkg({ next: '*', expo: '*' }),
    'app.json': '{"expo": {}}',
    'supabase/config.toml': '',
    'docker-compose.yml': compose('n8nio/n8n'),
    'wrangler.toml': '',
    'wp-content/.keep': '',
  });
  const systems = detectSystems(dir);
  assert.deepEqual(systems.map((s) => s.type), ['mobile-expo', 'supabase', 'n8n', 'docker-host']);
  assert.deepEqual(systems.map((s) => s.id), ['mobile', 'db', 'n8n', 'host']);
  assert.deepEqual(systems[0].packs, ['mobile-expo', 'web-nextjs', 'cloudflare-workers', 'wordpress-hostinger'], 'Expo is primary');
  assert.deepEqual(systems[0].evidence, [
    'package.json#dependencies.expo', 'app.json#expo', 'package.json#dependencies.next', 'wrangler.toml', 'wp-content/',
  ]);
});

// Ruling (final review I3): one checkout is one system, so L1 scans and triages it once.
test('I3: a Next.js app with a wrangler.toml is one web-nextjs system carrying both packs and all the evidence', () => {
  const dir = tmp({ 'package.json': pkg({ next: '*' }), 'wrangler.toml': '' });
  const systems = detectSystems(dir);
  assert.equal(systems.length, 1);
  assert.deepEqual(systems[0], {
    id: 'web', type: 'web-nextjs', name: 'Next.js app', packs: ['web-nextjs', 'cloudflare-workers'],
    evidence: ['package.json#dependencies.next', 'wrangler.toml'], source: 'inferred',
  });
  const draft = draftProject({ slug: 'next-on-workers', name: 'N', folder: dir });
  assert.equal(draft.systems.length, 1);
  assert.deepEqual(draft.systems[0].packs, ['web-nextjs', 'cloudflare-workers']);
  assert.deepEqual(draft.systems[0].repo.paths, { [machineId()]: dir }, 'one repo entry for the one checkout');
  assert.deepEqual(validate(schema, { ...draft, ownerAttestation: ATTESTATION }), { ok: true, errors: [] });
});

test('I3: the primary type: Next.js over Workers, WordPress and Node API; Workers over Node API; host systems never fold', () => {
  const only = (files) => detectSystems(tmp(files)).map((s) => [s.type, s.packs]);
  assert.deepEqual(only({ 'package.json': pkg({ hono: '*' }), 'wrangler.toml': '' }), [['cloudflare-workers', ['cloudflare-workers', 'node-api']]]);
  assert.deepEqual(only({ 'package.json': pkg({ next: '*' }), 'wp-content/.keep': '' }), [['web-nextjs', ['web-nextjs', 'wordpress-hostinger']]]);
  assert.deepEqual(only({ 'package.json': pkg({ next: '*' }), 'docker-compose.yml': compose('nginx') }), [
    ['web-nextjs', ['web-nextjs']], ['docker-host', ['docker-host']],
  ]);
  assert.deepEqual(only({ 'package.json': pkg({ express: '*' }) }), [['node-api', ['node-api']]], 'one repo type is left as it is');
});

test('detectSystems throws RangeError for a folder that is missing or is a file', () => {
  const dir = tmp({ 'a.txt': '' });
  assert.throws(() => detectSystems(path.join(dir, 'missing')), RangeError);
  assert.throws(() => detectSystems(path.join(dir, 'a.txt')), RangeError);
  assert.throws(() => detectSystems(''), RangeError);
  assert.throws(() => detectSystems(undefined), RangeError);
});

test('detection opens manifests only: never a .env file, whatever its name', () => {
  const canary = 'canary-value-9f3a';
  const dir = tmp({
    'package.json': pkg({ next: '*' }),
    'docker-compose.yml': compose('n8nio/n8n'),
    '.env': `KEY=${canary}`,
    '.env.local': `KEY=${canary}`,
    '.env.production': `KEY=${canary}`,
    'infra/supabase/.env': `KEY=${canary}`,
    'wp-config.php': `<?php define('DB_PASSWORD', '${canary}');`,
  });
  const opened = [];
  const undo = ['readFileSync', 'openSync', 'readFile', 'open', 'createReadStream'].map((name) => {
    const original = fs[name];
    fs[name] = (...args) => {
      opened.push(String(args[0]));
      return original.apply(fs, args);
    };
    return () => { fs[name] = original; };
  });
  let draft;
  try {
    draft = draftProject({ slug: 'canary-app', name: 'Canary', folder: dir });
  } finally {
    for (const restore of undo) restore();
  }
  assert.ok(opened.some((f) => f.endsWith('package.json')), 'the patch sees reads at all');
  assert.deepEqual(opened.filter((f) => /(^|[\\/])\.env/i.test(f)), []);
  assert.deepEqual(opened.filter((f) => /wp-config/i.test(f)), []); // present by name, never opened
  assert.ok(!JSON.stringify(draft).includes(canary));
});

test('assignIds: the id comes from the type, and a repeat gets a numeric suffix', () => {
  assert.deepEqual(assignIds([{ type: 'web-nextjs' }, { type: 'web-nextjs' }, { type: 'web-nextjs' }, { type: 'supabase' }]).map((s) => s.id), [
    'web', 'web-2', 'web-3', 'db',
  ]);
  assert.deepEqual(assignIds([{ type: 'other' }]).map((s) => s.id), ['system']);
});

// ---- stripCredentials ---------------------------------------------------------------------

test('stripCredentials removes user:pass@ and token@ from URLs and keeps the rest', () => {
  const cases = [
    ['https://user:s3cret@github.com/o/r.git', 'https://github.com/o/r.git'],
    ['https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r.git', 'https://github.com/o/r.git'],
    ['http://user:pa@ss@host.example:8080/o/r.git?x=1#f', 'http://host.example:8080/o/r.git?x=1#f'],
    ['https://github.com/o/r.git', 'https://github.com/o/r.git'],
    ['https://github.com/o/r@v1', 'https://github.com/o/r@v1'],
    ['ssh://git@github.com/o/r.git', 'ssh://git@github.com/o/r.git'],
    ['ssh://git:s3cret@github.com/o/r.git', 'ssh://git@github.com/o/r.git'],
    ['git@github.com:o/r.git', 'git@github.com:o/r.git'],
    ['user:s3cret@host.example:o/r.git', 'host.example:o/r.git'],
    ['/srv/git/r.git', '/srv/git/r.git'],
    ['C:\\repos\\r.git', 'C:\\repos\\r.git'],
  ];
  for (const [input, expected] of cases) {
    const out = stripCredentials(input);
    assert.equal(out, expected, input);
    assert.ok(!out.includes('s3cret'), input);
  }
});

// ---- draftProject -------------------------------------------------------------------------

for (const { name } of FIXTURES) {
  test(`draft for fixture ${name} fails validation only on ownerAttestation.statement, and passes once it is given`, () => {
    const draft = draftProject({ slug: 'fixture-app', name: 'Fixture App', folder: fixtureDir(name) });
    const result = validate(schema, draft);
    assert.equal(result.ok, false);
    assert.deepEqual(errorPaths(result.errors), ['ownerAttestation.statement']);
    assert.deepEqual(result.errors, ['ownerAttestation.statement: expected string of at least 1 character']);
    assert.deepEqual(validate(schema, { ...draft, ownerAttestation: ATTESTATION }), { ok: true, errors: [] });
  });
}

test('draft top level: defaults, an empty attestation, nothing the store stamps', () => {
  const draft = draftProject({ slug: 'my-app', name: 'My App', folder: fixtureDir('nextjs') });
  assert.deepEqual(Object.keys(draft).sort(), ['cloudAllowed', 'criticality', 'defaultExecutor', 'name', 'ownerAttestation', 'slug', 'systems']);
  assert.equal(draft.slug, 'my-app');
  assert.equal(draft.name, 'My App');
  assert.equal(draft.criticality, 'medium');
  assert.equal(draft.defaultExecutor, 'local');
  assert.equal(draft.cloudAllowed, false);
  assert.deepEqual(draft.ownerAttestation, { statement: '', by: '', at: '' });
});

test('draft systems: executor, layers and repo by kind of system', () => {
  const dir = tmp({
    'package.json': pkg({ next: '*', expo: '*' }),
    'app.json': '{"expo": {}}',
    'supabase/config.toml': '',
    'docker-compose.yml': compose('n8nio/n8n'),
    'wrangler.toml': '',
    'wp-content/.keep': '',
  });
  const draft = draftProject({ slug: 'all-of-it', name: 'All of it', folder: dir });
  const bySystem = Object.fromEntries(draft.systems.map((s) => [s.type, s]));
  assert.deepEqual(draft.systems.filter((s) => 'repo' in s).map((s) => s.type), ['mobile-expo'], 'the repo types are one system');
  for (const type of ['mobile-expo']) {
    const s = bySystem[type];
    assert.equal(s.executor, 'either', type);
    assert.deepEqual(s.layers, REPO_LAYERS, type);
    assert.equal(s.repo.defaultBranch, 'main', type);
    assert.deepEqual(s.repo.paths, { [machineId()]: dir }, type);
  }
  for (const type of ['supabase', 'n8n', 'docker-host']) {
    const s = bySystem[type];
    assert.equal(s.executor, 'local', type);
    assert.deepEqual(s.layers, HOST_LAYERS, type);
    assert.ok(!('repo' in s), type);
    assert.ok(!('host' in s), type);
  }
  for (const s of draft.systems) {
    assert.equal(s.source, 'inferred');
    assert.ok(s.evidence.length > 0);
  }
  assert.equal(new Set(draft.systems.map((s) => s.id)).size, draft.systems.length);
  assert.notEqual(bySystem.supabase.layers, bySystem.n8n.layers); // no shared objects to edit by accident
  assert.deepEqual(validate(schema, { ...draft, ownerAttestation: ATTESTATION }), { ok: true, errors: [] });
});

test('draft of a node-api folder records the repo path for this machine, as an absolute path', () => {
  const dir = tmp({ 'package.json': pkg({ hono: '*' }) });
  const [system] = draftProject({ slug: 'api-only', name: 'API', folder: dir }).systems;
  assert.equal(system.id, 'api');
  assert.deepEqual(system.repo.paths, { [machineId()]: dir });
  const relative = path.relative(process.cwd(), dir);
  const [again] = draftProject({ slug: 'api-only', name: 'API', folder: relative }).systems;
  assert.equal(again.repo.paths[machineId()], path.resolve(relative));
});

test('draft of an empty folder is a valid-shape project with no systems', () => {
  const draft = draftProject({ slug: 'nothing', name: 'Nothing', folder: tmp() });
  assert.deepEqual(draft.systems, []);
  assert.deepEqual(errorPaths(validate(schema, draft).errors), ['ownerAttestation.statement']);
});

test('draftProject: a missing name is the folder name; a slug that cannot be saved or a missing folder is a RangeError', () => {
  const dir = tmp({ 'package.json': pkg({ express: '*' }) });
  assert.equal(draftProject({ slug: 'abc', folder: dir }).name, path.basename(dir));
  for (const slug of ['', 'a', 'Has-Capitals', 'has space', 'has_underscore', 'x'.repeat(41), undefined, 7]) {
    assert.throws(() => draftProject({ slug, name: 'N', folder: dir }), RangeError, String(slug));
  }
  assert.throws(() => draftProject({ slug: 'abc', name: 'N', folder: path.join(dir, 'missing') }), RangeError);
  assert.throws(() => draftProject({ slug: 'abc', name: 'N' }), RangeError);
});

test('draftProject can reuse systems it is handed, so the CLI scans once', () => {
  const dir = fixtureDir('nextjs');
  const systems = detectSystems(dir);
  assert.deepEqual(draftProject({ slug: 'abc', name: 'N', folder: dir, systems }).systems.map((s) => s.id), ['web']);
});

// ---- git ----------------------------------------------------------------------------------

function gitRepo({ remote, originHead } = {}) {
  const dir = tmp({ 'package.json': pkg({ next: '*' }) });
  const git = (...args) => {
    const r = run(GIT, args, { cwd: dir });
    assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q');
  if (remote) git('remote', 'add', 'origin', remote);
  if (originHead) git('symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${originHead}`);
  return dir;
}
const repoOf = (dir) => draftProject({ slug: 'git-app', name: 'Git App', folder: dir }).systems[0].repo;
const gitTest = (name, fn) => test(name, { skip: GIT ? false : 'git is not installed' }, fn);

gitTest('repo.remote is the origin URL without credentials', () => {
  const dir = gitRepo({ remote: 'https://user:s3cret-pass@github.com/owner/repo.git' });
  const repo = repoOf(dir);
  assert.equal(repo.remote, 'https://github.com/owner/repo.git');
  assert.equal(repo.defaultBranch, 'main');
  assert.deepEqual(repo.paths, { [machineId()]: dir });
  assert.ok(!JSON.stringify(repo).includes('s3cret'));
});

gitTest('repo.defaultBranch follows origin/HEAD when it is set', () => {
  const repo = repoOf(gitRepo({ remote: 'git@github.com:owner/repo.git', originHead: 'trunk' }));
  assert.equal(repo.remote, 'git@github.com:owner/repo.git');
  assert.equal(repo.defaultBranch, 'trunk');
});

gitTest('a repo without an origin has no remote and defaults to main', () => {
  const repo = repoOf(gitRepo());
  assert.ok(!('remote' in repo));
  assert.equal(repo.defaultBranch, 'main');
});

gitTest('a folder that is not a git repo has no remote and defaults to main', () => {
  const repo = repoOf(tmp({ 'package.json': pkg({ next: '*' }) }));
  assert.ok(!('remote' in repo));
  assert.equal(repo.defaultBranch, 'main');
});

test('git that cannot be started (or is not installed) leaves the remote out and never fails the draft', () => {
  const dir = tmp({ 'package.json': pkg({ next: '*' }) });
  process.env.RAMPART_GIT = path.join(dir, 'no-such-dir', 'git');
  let repo = repoOf(dir);
  assert.ok(!('remote' in repo));
  assert.equal(repo.defaultBranch, 'main');
  delete process.env.RAMPART_GIT;
  process.env.PATH = tmp(); // an empty directory: no git on PATH
  repo = repoOf(dir);
  assert.ok(!('remote' in repo));
  assert.equal(repo.defaultBranch, 'main');
});

// A stand-in for git (RAMPART_GIT=node:<script>) that answers "remote ..." with SHIM_REMOTE and anything else with SHIM_HEAD, exits
// with SHIM_EXIT, and logs the argv of every call to SHIM_LOG.
function shimGit({ remote = '', head = '', exit = 0 }) {
  const dir = tmp({
    'package.json': pkg({ next: '*' }),
    'git-shim.cjs': [
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "fs.appendFileSync(process.env.SHIM_LOG, JSON.stringify(args) + '\\n');",
      "process.stdout.write((args[0] === 'remote' ? process.env.SHIM_REMOTE : process.env.SHIM_HEAD) + '\\n');",
      'process.exitCode = Number(process.env.SHIM_EXIT);',
    ].join('\n'),
  });
  const log = path.join(dir, 'git-calls.jsonl');
  Object.assign(process.env, {
    RAMPART_GIT: `node:${path.join(dir, 'git-shim.cjs')}`,
    SHIM_REMOTE: remote,
    SHIM_HEAD: head,
    SHIM_EXIT: String(exit),
    SHIM_LOG: log,
  });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, calls };
}

test('git output is used: the origin URL loses its credentials, origin/HEAD names the branch, arguments reach git one by one', () => {
  const { dir, calls } = shimGit({ remote: 'https://user:s3cret-pass@github.com/o/r.git', head: 'refs/remotes/origin/trunk' });
  const repo = repoOf(dir);
  assert.equal(repo.remote, 'https://github.com/o/r.git');
  assert.equal(repo.defaultBranch, 'trunk');
  assert.ok(!JSON.stringify(repo).includes('s3cret'));
  assert.deepEqual(calls(), [['remote', 'get-url', 'origin'], ['symbolic-ref', 'refs/remotes/origin/HEAD']]);
});

test('git that exits non-zero leaves the remote out even when it printed a URL', () => {
  for (const exit of [1, 2, 128]) {
    const { dir, calls } = shimGit({ remote: 'https://user:s3cret-pass@github.com/o/r.git', head: 'refs/remotes/origin/trunk', exit });
    const repo = repoOf(dir);
    assert.ok(!('remote' in repo), String(exit));
    assert.equal(repo.defaultBranch, 'main', String(exit));
    assert.ok(!JSON.stringify(repo).includes('s3cret'), String(exit));
    assert.deepEqual(calls(), [['remote', 'get-url', 'origin']], String(exit)); // no point asking for the branch of a missing remote
  }
});

test('git that prints nothing, or a default branch that is not a remote-tracking ref, changes nothing it should not', () => {
  const { dir } = shimGit({ remote: '', head: 'refs/remotes/origin/trunk' });
  const repo = repoOf(dir);
  assert.ok(!('remote' in repo));
  assert.equal(repo.defaultBranch, 'main');
  for (const head of ['', 'refs/heads/trunk', 'origin/trunk', 'refs/remotes/origin/has space']) {
    const { dir: d } = shimGit({ remote: 'git@github.com:o/r.git', head });
    const r = repoOf(d);
    assert.equal(r.remote, 'git@github.com:o/r.git', head);
    assert.equal(r.defaultBranch, 'main', head);
  }
});

// ---- the command line ---------------------------------------------------------------------

function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, RAMPART_GIT: path.join(os.tmpdir(), 'no-git-here') } });
  assert.equal(r.error, undefined);
  return r;
}

test('CLI prints a table of what it found and exits 0', () => {
  const r = cli(fixtureDir('compose'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /2 systems/);
  assert.match(r.stdout, /n8n\s+n8n\s+n8n automation/);
  assert.match(r.stdout, /host\s+docker-host\s+Docker host/);
  assert.match(r.stdout, /docker-compose\.yml#image:n8nio\/n8n/);
  assert.match(r.stdout, /inferred/i);
});

test('CLI --json prints {systems, draft} and nothing else', () => {
  const r = cli(fixtureDir('expo'), '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out).sort(), ['draft', 'systems']);
  assert.deepEqual(out.systems.map((s) => s.type), ['mobile-expo']);
  assert.deepEqual(out.systems, detectSystems(fixtureDir('expo')));
  assert.equal(out.draft.slug, 'expo');
  assert.equal(out.draft.name, 'expo');
  assert.deepEqual(out.draft.systems.map((s) => s.id), ['mobile']);
  assert.deepEqual(errorPaths(validate(schema, out.draft).errors), ['ownerAttestation.statement']);
});

test('CLI --slug and --name set the draft; the default slug is the folder name made safe', () => {
  const dir = path.join(tmp(), 'My Cool App_v2');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), pkg({ express: '*' }));
  let out = JSON.parse(cli(dir, '--json').stdout);
  assert.equal(out.draft.slug, 'my-cool-app-v2');
  assert.equal(out.draft.name, 'My Cool App_v2');
  out = JSON.parse(cli(dir, '--json', '--slug', 'cool-app', '--name', 'Cool App').stdout);
  assert.equal(out.draft.slug, 'cool-app');
  assert.equal(out.draft.name, 'Cool App');
  assert.deepEqual(out.draft.systems[0].repo.paths, { [machineId()]: dir });
});

test('CLI on a folder with nothing recognizable exits 0 and says so', () => {
  const dir = tmp({ 'README.md': 'x' });
  const human = cli(dir);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /no systems/i);
  const json = cli(dir, '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).systems, []);
});

test('CLI exits 2 with a message on stderr for usage errors and a missing folder', () => {
  const dir = tmp({ 'a.txt': '' });
  const bad = [
    [],
    ['--json'],
    [dir, dir],
    [dir, '--bogus'],
    [dir, '--slug'],
    [dir, '--slug', 'Bad Slug'],
    [dir, '--slug', 'x'],
    [path.join(dir, 'missing')],
    [path.join(dir, 'a.txt')],
    [path.join(dir, 'a.txt'), '--json'],
  ];
  for (const args of bad) {
    const r = cli(...args);
    assert.equal(r.status, 2, `${JSON.stringify(args)}: ${r.stdout}`);
    assert.equal(r.stdout, '', JSON.stringify(args));
    assert.match(r.stderr, /^inventory-scan: /, JSON.stringify(args));
  }
  assert.match(cli().stderr, /usage: node scripts\/inventory-scan\.cjs <folder>/);
  assert.match(cli(path.join(dir, 'missing')).stderr, /not found/);
});

test('CLI cannot derive a slug from a folder name with no letters or digits, but only the --json draft needs one', () => {
  const dir = path.join(tmp(), '___');
  fs.mkdirSync(dir);
  const r = cli(dir, '--json');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--slug/);
  assert.equal(cli(dir, '--json', '--slug', 'given-slug').status, 0);
  const human = cli(dir);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /no systems/i);
});

test('I5: CLI --remote prints the origin URL without credentials, or nothing, and detects nothing', () => {
  const { dir, calls } = shimGit({ remote: 'https://user:s3cret-pass@github.com/o/r.git' });
  const env = { ...process.env };
  const remote = (...args) => spawnSync(process.execPath, [CLI, dir, '--remote', ...args], { encoding: 'utf8', env });
  const text = remote();
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout.trim(), 'https://github.com/o/r.git');
  assert.ok(!text.stdout.includes('s3cret'));
  assert.deepEqual(JSON.parse(remote('--json').stdout), { remote: 'https://github.com/o/r.git' });
  assert.ok(calls().every((c) => c[0] === 'remote' || c[0] === 'symbolic-ref'), 'only the remote and its branch are asked');
  env.SHIM_EXIT = '2';
  assert.equal(remote().stdout, '', 'no origin: nothing');
  assert.deepEqual(JSON.parse(remote('--json').stdout), { remote: null });
  assert.equal(spawnSync(process.execPath, [CLI, dir, '--remote', '--slug', 'abc'], { encoding: 'utf8', env }).status, 2);
  assert.equal(spawnSync(process.execPath, [CLI, path.join(dir, 'missing'), '--remote'], { encoding: 'utf8', env }).status, 2);
});

test('CLI human mode does not build the draft (git is never asked), and still rejects a slug that cannot be saved', () => {
  const dir = tmp({ 'package.json': pkg({ next: '*' }) });
  const marker = path.join(dir, 'git-ran');
  fs.writeFileSync(path.join(dir, 'git-shim.cjs'), "require('node:fs').writeFileSync(process.env.SHIM_MARK, 'x');");
  const env = { ...process.env, RAMPART_GIT: `node:${path.join(dir, 'git-shim.cjs')}`, SHIM_MARK: marker };
  const human = spawnSync(process.execPath, [CLI, dir], { encoding: 'utf8', env });
  assert.equal(human.status, 0, human.stderr);
  assert.ok(!fs.existsSync(marker));
  const json = spawnSync(process.execPath, [CLI, dir, '--json'], { encoding: 'utf8', env });
  assert.equal(json.status, 0, json.stderr);
  assert.ok(fs.existsSync(marker));
  assert.equal(spawnSync(process.execPath, [CLI, dir, '--slug', 'Bad Slug'], { encoding: 'utf8', env }).status, 2);
});
