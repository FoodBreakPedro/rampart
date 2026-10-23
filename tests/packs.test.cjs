const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { listPacks, readPack, validatePack, packsFor, main } = require('../scripts/packs.cjs');
const { loadSchema } = require('../scripts/lib/validate.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'packs');
const CLI = path.join(REPO_ROOT, 'scripts', 'packs.cjs');

let tmp;
test.beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart packs '));
});
test.afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const fixture = (name) => fs.readFileSync(path.join(FIXTURES, `${name}.md`), 'utf8');
const put = (name, text) => fs.writeFileSync(path.join(tmp, `${name}.md`), text);
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('readPack parses the good fixture to the exact object', () => {
  assert.deepEqual(readPack('good', FIXTURES), {
    name: 'good',
    version: '1.2.0',
    appliesTo: ['nextjs', 'node-api'],
    kinds: ['code', 'host'],
    sources: [
      { url: 'https://example.com/guide', date: '2026-09-01' },
      { url: 'https://example.org/advisory', date: '2026-08-15' },
    ],
    lastReviewed: '2026-10-01',
    classes: [
      {
        id: 'idor',
        title: 'Broken object-level authorization',
        lookFor: 'Handlers that load a record by an id from the request without checking the caller owns it.',
        confirmBy: 'Trace the id from the route to the query and show no ownership check lies between them.',
        disproveBy: 'Find a policy, a row-level filter or a guard that scopes the query to the caller.',
        severity: 'HIGH',
        cwe: ['CWE-639', 'CWE-862'],
      },
      {
        id: 'open-redirect',
        title: 'Unvalidated redirect target',
        lookFor: 'Redirects built from a query parameter.',
        confirmBy: 'Show the parameter reaches the redirect without an allow-list.',
        disproveBy: 'Show the target is checked against a fixed list or made relative.',
        severity: 'LOW',
        cwe: ['CWE-601'],
      },
    ],
    baseline: 'Expect a reverse proxy in front of the app and no container publishing a database port.',
    probes: [
      {
        id: 'containers',
        title: 'Running containers',
        via: 'ssh',
        argv: ['docker', 'ps', '--format', '{{.Names}} {{.Image}}'],
        expect: 'Only the app, the proxy and the database are running.',
        scrub: 'none',
      },
    ],
  });
  assert.deepEqual(validatePack(readPack('good', FIXTURES)), { ok: true, errors: [] });
});

test('a pack with no Probes section has probes: [] and a CRLF file parses the same', () => {
  const text = fixture('good').replace(/## Probes[\s\S]*?(?=## Sources)/, '');
  put('good', text.replace(/\n/g, '\r\n'));
  const pack = readPack('good', tmp);
  assert.deepEqual(pack.probes, []);
  assert.equal(pack.classes.length, 2);
  assert.equal(pack.baseline, 'Expect a reverse proxy in front of the app and no container publishing a database port.');
});

test('a probe may carry an optional path', () => {
  put('good', fixture('good').replace('`ssh`', '`http`').replace('**scrub:** none', '**scrub:** none\n**path:** /health'));
  const probe = readPack('good', tmp).probes[0];
  assert.equal(probe.path, '/health');
  assert.equal(probe.via, 'http');
});

test('missing sources: validatePack reports the path sources', () => {
  const pack = readPack('bad-missing-sources', FIXTURES);
  const result = validatePack(pack);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((e) => e.path), ['sources']);
  assert.match(result.errors[0].message, /required/);
});

test('a probe with a non-array argv fails at probes[0].argv, and an empty array fails too', () => {
  const pack = readPack('good', FIXTURES);
  pack.probes[0].argv = 'docker ps';
  let result = validatePack(pack);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((e) => e.path), ['probes[0].argv']);
  pack.probes[0].argv = [];
  result = validatePack(pack);
  assert.deepEqual(result.errors.map((e) => e.path), ['probes[0].argv']);
  pack.probes[0].argv = ['docker', 5];
  assert.deepEqual(validatePack(pack).errors.map((e) => e.path), ['probes[0].argv[1]']);
});

test('argv text that is not JSON is kept raw and fails validation', () => {
  put('good', fixture('good').replace(/\*\*argv:\*\*.*/, '**argv:** `docker ps`'));
  const pack = readPack('good', tmp);
  assert.equal(pack.probes[0].argv, 'docker ps');
  assert.deepEqual(validatePack(pack).errors.map((e) => e.path), ['probes[0].argv']);
});

test('a class missing a field fails at classes[i].field; an unknown severity fails', () => {
  const text = fixture('good')
    .replace('**Confirm by:** Show the parameter reaches the redirect without an allow-list.\n', '')
    .replace('**Severity when confirmed:** low', '**Severity when confirmed:** severe');
  put('good', text);
  const result = validatePack(readPack('good', tmp));
  assert.deepEqual(result.errors.map((e) => e.path).sort(), ['classes[1].confirmBy', 'classes[1].severity']);
  assert.ok(result.errors.every((e) => typeof e.message === 'string' && !e.message.includes('severe')));
});

test('duplicate class ids and malformed dates are reported', () => {
  put('good', fixture('good').replace('### open-redirect:', '### idor:').replace('lastReviewed: 2026-10-01', 'lastReviewed: soon'));
  const paths = validatePack(readPack('good', tmp)).errors.map((e) => e.path).sort();
  assert.deepEqual(paths, ['classes[1].id', 'lastReviewed']);
});

test('readPack refuses a name that differs from the file name, and a missing pack or front-matter', () => {
  put('other', fixture('good'));
  assert.throws(() => readPack('other', tmp), /name/);
  assert.throws(() => readPack('nope', tmp), /not found/);
  put('plain', '# no front-matter\n');
  assert.throws(() => readPack('plain', tmp), /front-matter/);
  assert.throws(() => readPack('../good', FIXTURES), /pack name/);
});

test('listPacks is sorted and excludes _template.md, other _ files and non-markdown files', () => {
  assert.deepEqual(listPacks(tmp), []);
  for (const f of ['supabase.md', 'nextjs.md', '_template.md', '_draft.md', 'notes.txt']) fs.writeFileSync(path.join(tmp, f), 'x');
  assert.deepEqual(listPacks(tmp), ['nextjs', 'supabase']);
  assert.deepEqual(listPacks(path.join(tmp, 'missing')), []);
});

test('listPacks defaults to packs/ at the plugin root and leaves the template out', () => {
  assert.equal(listPacks().includes('_template'), false);
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'packs', '_template.md')));
});

test('the template parses, validates and shows every section and field', () => {
  const pack = readPack('_template', path.join(REPO_ROOT, 'packs'));
  assert.deepEqual(validatePack(pack), { ok: true, errors: [] });
  assert.equal(pack.classes.length, 1);
  assert.equal(pack.probes.length, 1);
  assert.equal(pack.probes[0].path, '/optional-path');
  const text = fs.readFileSync(path.join(REPO_ROOT, 'packs', '_template.md'), 'utf8');
  for (const needle of [
    'name:', 'version:', 'appliesTo:', 'kinds:', 'sources:', 'lastReviewed:',
    '## Hunt classes', '## Baseline', '## Probes', '## Sources',
    '**Look for:**', '**Confirm by:**', '**Disprove by:**', '**Severity when confirmed:**', '**CWE:**',
    '**via:**', '**argv:**', '**expect:**', '**scrub:**', '**path:**',
  ]) assert.ok(text.includes(needle), `template shows ${needle}`);
  assert.doesNotMatch(text, /sk_live|AKIA|BEGIN [A-Z ]*PRIVATE KEY|password\s*[:=]/i);
});

test('the pack schema loads through loadSchema', () => {
  assert.equal(loadSchema('pack').title, 'Rampart pack');
});

test('packsFor picks packs by system.packs names, else by appliesTo matching system.type', () => {
  put('nextjs', fixture('good').replace('name: good', 'name: nextjs'));
  put('node', fixture('good').replace('name: good', 'name: node'));
  put('nginx', fixture('good').replace('name: good', 'name: nginx').replace('  - nextjs\n  - node-api', '  - web-server'));
  assert.deepEqual(packsFor({ type: 'node-api' }, tmp).map((p) => p.name), ['nextjs', 'node']);
  assert.deepEqual(packsFor({ type: 'web-server', packs: ['node'] }, tmp).map((p) => p.name), ['node']);
  assert.deepEqual(packsFor({ type: 'web-server', packs: [] }, tmp).map((p) => p.name), ['nginx']);
  assert.deepEqual(packsFor({ type: 'unknown' }, tmp), []);
  assert.deepEqual(packsFor({ type: 'web-server', packs: ['absent'] }, tmp), []);
});

test('CLI: list, show, validate, usage errors', () => {
  const list = cli('list');
  assert.equal(list.status, 0);
  assert.equal(list.stdout.includes('_template'), false);

  const show = cli('show', 'nope');
  assert.equal(show.status, 2);
  assert.match(show.stderr, /packs: /);

  for (const args of [[], ['bogus'], ['list', 'extra'], ['validate', '--wat'], ['show']]) {
    const r = cli(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage: node scripts\/packs\.cjs/);
  }

  const ok = cli('validate', '--json');
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).ok, true);
});

test('main validates every listed pack, exits 1 when any is invalid, and prints per-pack results', () => {
  put('bad-missing-sources', fixture('bad-missing-sources'));
  put('good', fixture('good'));
  const out = [];
  const err = [];
  const io = { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, dir: tmp };
  assert.equal(main(['validate'], io), 1);
  assert.match(out.join(''), /INVALID bad-missing-sources/);
  assert.match(out.join(''), /sources: /);
  out.length = 0;
  assert.equal(main(['validate', 'good'], io), 0);
  assert.match(out.join(''), /^ok good/);
  out.length = 0;
  assert.equal(main(['validate', '--json'], io), 1);
  const doc = JSON.parse(out.join(''));
  assert.equal(doc.ok, false);
  assert.deepEqual(doc.packs.map((p) => [p.name, p.ok]), [['bad-missing-sources', false], ['good', true]]);
  assert.equal(doc.packs[0].errors[0].path, 'sources');
  out.length = 0;
  assert.equal(main(['show', 'good'], io), 0);
  assert.equal(JSON.parse(out.join('')).name, 'good');
  assert.equal(err.length, 0);
});

test('main reports a pack whose name differs from its file as invalid instead of crashing', () => {
  put('other', fixture('good'));
  const out = [];
  const io = { stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} }, dir: tmp };
  assert.equal(main(['validate'], io), 1);
  assert.match(out.join(''), /INVALID other/);
});

test('a class with no CWE line fails at classes[i].cwe', () => {
  put('good', fixture('good').replace(/\*\*CWE:\*\* CWE-601\n/, ''));
  assert.deepEqual(validatePack(readPack('good', tmp)).errors.map((e) => e.path), ['classes[1].cwe']);
});

test('a code pack with no classes (mistyped heading) and a host pack with no probes fail', () => {
  put('good', fixture('good').replace('## Hunt classes', '## Hunt clases'));
  assert.deepEqual(validatePack(readPack('good', tmp)).errors.map((e) => e.path), ['classes']);
  const noProbes = fixture('good').replace(/## Probes[\s\S]*?(?=## Sources)/, '');
  put('good', noProbes);
  assert.deepEqual(validatePack(readPack('good', tmp)).errors.map((e) => e.path), ['probes']);
  put('good', noProbes.replace('  - host\n', ''));
  assert.deepEqual(validatePack(readPack('good', tmp)), { ok: true, errors: [] });
});
