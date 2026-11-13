const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cov = require('../scripts/coverage.cjs');
const hp = require('../scripts/hunt-plan.cjs');

// A temporary folder with the given files ({path: content or byte count}); git: true makes it a repository with one commit.
function tree(files, { git = false, ignore } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart plan '));
  const put = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof body === 'number' ? 'x'.repeat(body) : body);
  };
  for (const [rel, body] of Object.entries(files)) put(rel, body);
  if (ignore) put('.gitignore', ignore);
  const g = (...args) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  if (git) {
    g('init', '-q', '-b', 'main');
    g('config', 'user.name', 'T');
    g('config', 'user.email', 't@example.com');
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
  }
  return { dir, put, git: g, rm: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ---- the source filter --------------------------------------------------------------------

test('classifyFile is a denylist: code in any language is read; media, prose, data, lockfiles and generated files are not', () => {
  for (const keep of [
    'src/app.ts', 'src/App.tsx', 'lib/a.mjs', 'api/main.py', 'app.rb', 'main.go', 'lib.rs', 'View.swift', 'index.php', 'supabase/migrations/001.sql',
    'deploy.sh', '.github/workflows/ci.yml', 'wrangler.toml', 'public/index.html', 'ios/Info.plist', 'Dockerfile', 'api.Dockerfile', 'Makefile',
    'package.json', '.env.example', 'config.sample', 'firestore.rules', '.htaccess', 'docs/page.mdx', 'Views/Home.cshtml', 'web/a.aspx', 'a.jsp',
    'templates/a.j2', 'views/a.pug', 'a.liquid', 'Build.groovy', 'Token.sol', 'policy.rego', 'api.proto', 'Main.hs', 'core.clj', 'a.erl', 'a.fs',
    'a.ml', 'a.vb', 'a.zig', 'a.nim', 'a.jl', 'a.r', 'run.bat', 'run.cmd', 'mod.psm1', 'flake.nix', 'main.bicep', 'prod.tfvars', 'edge.vcl',
    'app.service', 'bin/www', 'Rakefile', 'fastlane/Fastfile', 'src/routes/download-bundle.js', 'src/lib/lang/parser.ts', 'src/i18n/index.ts',
    'database.rules.json', 'google-services.json',
  ]) assert.equal(cov.classifyFile(keep, 100).kind, 'source', keep);
  const excluded = {
    'assets/a.png': 'image', 'shots/b.jpg': 'image', 'fonts/c.ttf': 'font', 'media/d.mp4': 'media', 'g.zip': 'archive', 'lib.so': 'binary',
    'f.pdf': 'document', 'README.md': 'prose', 'notes.txt': 'prose', 'LICENSE': 'prose', 'data/e.csv': 'data', 'x.js.map': 'data',
    'a.snap': 'data', 'styles/a.css': 'style', 'package-lock.json': 'lockfile', 'pnpm-lock.yaml': 'lockfile', 'ios/Podfile.lock': 'lockfile',
    'vendor.min.js': 'generated', 'app.bundle.js': 'generated', 'main.3f9a2c1b.js': 'generated', 'src/i18n/locales/es/names.ts': 'translation',
    'locales/en.json': 'translation', 'src/translations/fr.json': 'translation', 'po/de.po': 'translation', '.vscode/settings.json': 'tooling',
    '.expo/web/cache.json': 'tooling', 'src/__mocks__/api.ts': 'tooling', '.gitignore': 'housekeeping', '.nvmrc': 'housekeeping',
  };
  for (const [p, reason] of Object.entries(excluded)) assert.deepEqual(cov.classifyFile(p, 100), { kind: 'excluded', reason }, p);
  // Possible credentials: named to the hunter as present, never read.
  for (const p of ['.env', '.env.production', 'app/.env.local', '.dev.vars', '.npmrc', 'credentials.json', 'service-account.json', 'deploy/id_rsa', 'certs/server.pem', 'release.keystore']) {
    assert.equal(cov.classifyFile(p, 100).kind, 'present', p);
  }
  // Size: source over the cap is listed as not hunted, never silently dropped.
  assert.equal(cov.classifyFile('src/data/body.ts', cov.MAX_HUNT_FILE_BYTES).kind, 'source');
  assert.deepEqual(cov.classifyFile('src/legacy.php', cov.MAX_HUNT_FILE_BYTES + 1), { kind: 'oversize', reason: 'over 200 KB' });
  assert.equal(cov.classifyFile('database.rules.json', 40 * 1024).kind, 'source', 'JSON config up to 64 KB is read');
  assert.equal(cov.classifyFile('assets/seed/exercises.json', cov.MAX_HUNT_JSON_BYTES + 1).kind, 'oversize');
  assert.equal(cov.isHuntWorthy('src/app.ts'), true, 'without a size the name alone decides');
  assert.equal(cov.isHuntWorthy('a.png'), false);
  assert.equal(cov.isHuntWorthy('.env', 10), false);
  assert.ok(cov.MAX_HUNT_FILE_BYTES >= 200 * 1024 && cov.MAX_HUNT_FILE_BYTES <= 400 * 1024);
});

test('listRepoFiles in a git checkout lists tracked and untracked files git does not ignore, and drops ignored build output', () => {
  const t = tree({ 'src/a.ts': 'a', 'src/gone.ts': 'g', 'node_modules/x/i.js': 'x' }, { git: true, ignore: '.expo/\ndist-content/\n' });
  try {
    t.put('.expo/cache/big.json', '{}');
    t.put('dist-content/out.js', 'x');
    t.put('src/new.ts', 'new');
    fs.rmSync(path.join(t.dir, 'src/gone.ts')); // tracked, deleted from the working tree
    const listed = cov.listRepoFiles(t.dir);
    assert.equal(listed.source, 'git');
    assert.deepEqual(listed.files.map((f) => f.path), ['.gitignore', 'src/a.ts', 'src/new.ts']);
    assert.deepEqual(listed.files.find((f) => f.path === 'src/new.ts'), { path: 'src/new.ts', bytes: 3 });
    // The walk (no git) still sees what git ignores: that is the fallback for a folder that is not a checkout.
    const walked = cov.listRepoFiles(t.dir, { git: false });
    assert.equal(walked.source, 'walk');
    assert.ok(walked.files.some((f) => f.path === 'dist-content/out.js'));
    assert.ok(!walked.files.some((f) => f.path.startsWith('node_modules/')), 'DEFAULT_IGNORE applies to both');
  } finally {
    t.rm();
  }
});

test('listRepoFiles of a folder inside a larger checkout lists only that folder, with paths relative to it', () => {
  const t = tree({ 'apps/web/src/a.ts': 'a', 'apps/api/b.ts': 'b' }, { git: true });
  try {
    const listed = cov.listRepoFiles(path.join(t.dir, 'apps', 'web'));
    assert.equal(listed.source, 'git');
    assert.deepEqual(listed.files.map((f) => f.path), ['src/a.ts']);
  } finally {
    t.rm();
  }
});

test('listRepoFiles falls back to the walk outside a git checkout', () => {
  const t = tree({ 'src/a.ts': 'a', 'tests/b.ts': 'b' });
  try {
    const listed = cov.listRepoFiles(t.dir);
    assert.equal(listed.source, 'walk');
    assert.deepEqual(listed.files, [{ path: 'src/a.ts', bytes: 1 }]);
  } finally {
    t.rm();
  }
});

test('huntScope: units hold source; oversize-only folders stay as units with nothing to read; present files ride along; the rest is counted', () => {
  const t = tree({
    'src/a.ts': 10, 'src/b.tsx': 20, 'src/logo.png': 5000, 'src/NOTES.md': 50, 'src/.env': 5,
    'screenshots/1.png': 100, 'screenshots/2.jpg': 100, 'docs/guide.md': 10, 'docs/build.sh': 7,
    'assets/seed/exercises.json': cov.MAX_HUNT_JSON_BYTES + 1, 'app.json': 30, 'secrets/.npmrc': 3,
  });
  try {
    const scope = cov.huntScope(t.dir);
    assert.equal(scope.source, 'walk');
    assert.deepEqual(scope.units.map((u) => [u.id, u.reachable, u.paths, u.bytes, u.present || [], (u.oversize || []).map((f) => f.path)]), [
      ['.', true, ['app.json'], 30, [], []],
      ['assets/seed', true, [], 0, [], ['assets/seed/exercises.json']],
      ['docs', false, ['docs/build.sh'], 7, [], []],
      ['src', true, ['src/a.ts', 'src/b.tsx'], 30, ['src/.env'], []],
    ]);
    assert.deepEqual(scope.excluded, {
      counts: { image: 3, prose: 2 },
      oversize: [{ path: 'assets/seed/exercises.json', bytes: cov.MAX_HUNT_JSON_BYTES + 1, reason: 'JSON over 64 KB' }],
      present: ['secrets/.npmrc'],
      submodules: [],
    });
    assert.ok(!scope.units.some((u) => u.id === 'screenshots'), 'a folder of images is no unit');
    const all = cov.unitsForRepo(t.dir).map((u) => u.id);
    for (const u of scope.units) assert.ok(all.includes(u.id), 'unit ids are the ledger\'s directory ids');
  } finally {
    t.rm();
  }
});

test('listRepoFiles recurses into checked-out submodules and reports one that is not checked out', () => {
  const sub = tree({ 'lib/inner.ts': 'inner' }, { git: true });
  const t = tree({ 'src/a.ts': 'a' }, { git: true });
  try {
    t.git('-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', sub.dir, 'vendored');
    t.git('commit', '-qm', 'sub');
    const listed = cov.listRepoFiles(t.dir);
    assert.ok(listed.files.some((f) => f.path === 'vendored/lib/inner.ts'), 'a checked-out submodule is read');
    t.git('submodule', '--quiet', 'deinit', '-f', 'vendored');
    const bare = cov.listRepoFiles(t.dir);
    assert.deepEqual(bare.submodules, ['vendored']);
    assert.ok(!bare.files.some((f) => f.path.startsWith('vendored/')));
    assert.deepEqual(cov.huntScope(t.dir).excluded.submodules, ['vendored']);
  } finally {
    t.rm();
    sub.rm();
  }
});

test('markCovered: a unit listed in changed starts its class list afresh; the others keep earlier classes at the same versions', () => {
  const packs = { 'web-nextjs': '1.0.0' };
  let led = cov.markCovered({ project: 'example-app', units: {} }, { system: 'web', layer: 'L3', units: ['a', 'b'], runId: 'R1', packs, classes: ['x', 'y'] });
  led = cov.markCovered(led, { system: 'web', layer: 'L3', units: ['a', 'b'], runId: 'R2', packs, classes: ['z'], changed: ['b'] });
  assert.deepEqual(led.units['web|L3|a'].classes, ['x', 'y', 'z']);
  assert.deepEqual(led.units['web|L3|b'].classes, ['z']);
});

// ---- packing ------------------------------------------------------------------------------

const unit = (id, sizes, reachable = true) => ({
  id, reachable, paths: sizes.map((_, i) => `${id}/f${i}.ts`), sizes, bytes: sizes.reduce((n, s) => n + s, 0),
});

test('packGroups packs sorted units under the budget, siblings together, with readable stable ids', () => {
  const units = [unit('src/c', [40]), unit('src/a', [30]), unit('src/b', [50]), unit('src/d', [10])];
  const groups = hp.packGroups(units, { budget: 100 });
  assert.deepEqual(groups.map((g) => [g.id, g.units, g.bytes, g.reachable]), [
    ['g01', ['src/a', 'src/b'], 80, true],
    ['g02', ['src/c', 'src/d'], 50, true],
  ]);
  assert.deepEqual(groups[0].paths, ['src/a/f0.ts', 'src/b/f0.ts']);
  assert.ok(groups.every((g) => g.bytes <= 100));
  assert.deepEqual(hp.packGroups([...units].reverse(), { budget: 100 }), groups, 'the same units always give the same groups');
  assert.deepEqual(hp.packGroups([]), []);
  assert.ok(hp.GROUP_BUDGET_BYTES >= 100 * 1024 && hp.GROUP_BUDGET_BYTES <= 150 * 1024);
});

test('packGroups splits a unit over the budget by files into groups of its own, and never splits a file', () => {
  const groups = hp.packGroups([unit('a', [10]), unit('big', [60, 60, 30, 150]), unit('c', [10])], { budget: 100 });
  assert.deepEqual(groups.map((g) => [g.units, g.paths, g.bytes]), [
    [['a'], ['a/f0.ts'], 10],
    [['big'], ['big/f0.ts'], 60],
    [['big'], ['big/f1.ts', 'big/f2.ts'], 90],
    [['big'], ['big/f3.ts'], 150],
    [['c'], ['c/f0.ts'], 10],
  ]);
  // Every file is in exactly one group.
  const files = groups.flatMap((g) => g.paths);
  assert.equal(new Set(files).size, files.length);
  assert.equal(files.length, 6);
});

test('packGroups never mixes reachable and background units, and numbers background groups after the reachable ones', () => {
  const groups = hp.packGroups([unit('docs', [5], false), unit('src', [5]), unit('scripts', [5], false), unit('app', [5])], { budget: 100 });
  assert.deepEqual(groups.map((g) => [g.id, g.units, g.reachable]), [['g01', ['app', 'src'], true], ['g02', ['docs', 'scripts'], false]]);
  assert.throws(() => hp.packGroups([], { budget: 0 }), RangeError);
});

test('packGroups pads ids to the group count so they sort', () => {
  const units = Array.from({ length: 120 }, (_, i) => unit(`u${String(i).padStart(3, '0')}`, [100]));
  const groups = hp.packGroups(units, { budget: 100 });
  assert.equal(groups.length, 120);
  assert.equal(groups[0].id, 'g001');
  assert.equal(groups[119].id, 'g120');
});

// ---- bundling -----------------------------------------------------------------------------

const classes = (pack, n) => Array.from({ length: n }, (_, i) => ({ pack, packVersion: '1.0.0', classId: `c${i + 1}` }));

test('bundleClasses: five classes are one bundle, twelve two of six, seven 4 + 3; ids b1.., pack order kept', () => {
  assert.deepEqual(hp.bundleClasses(classes('p', 5)).map((b) => b.classIds.length), [5]);
  assert.deepEqual(hp.bundleClasses(classes('p', 12)).map((b) => [b.id, b.classIds.length]), [['b1', 6], ['b2', 6]]);
  assert.deepEqual(hp.bundleClasses(classes('p', 7)).map((b) => b.classIds), [['c1', 'c2', 'c3', 'c4'], ['c5', 'c6', 'c7']]);
  assert.deepEqual(hp.bundleClasses(classes('p', 14)).map((b) => b.classIds.length), [5, 5, 4]);
  assert.deepEqual(hp.bundleClasses(classes('p', 3), { size: 1 }).map((b) => b.classIds), [['c1'], ['c2'], ['c3']]);
  assert.equal(hp.BUNDLE_SIZE, 6);
  assert.deepEqual(hp.bundleClasses([]), []);
});

test('bundleClasses never mixes two packs, so a bundle never holds one class id twice', () => {
  const bundles = hp.bundleClasses([...classes('a', 4), ...classes('b', 4)]);
  assert.deepEqual(bundles.map((b) => [b.id, b.pack, b.classIds]), [['b1', 'a', ['c1', 'c2', 'c3', 'c4']], ['b2', 'b', ['c1', 'c2', 'c3', 'c4']]]);
  for (const b of bundles) assert.equal(new Set(b.classIds).size, b.classIds.length);
});

// ---- the estimate -------------------------------------------------------------------------

test('estimate: hunter tokens follow each group\'s source; verifiers follow the expected candidates, not one per hunter', () => {
  const E = hp.ESTIMATE;
  const groups = [{ bytes: 40000 }, { bytes: 120000 }];
  const bundles = [{ pack: 'p', classIds: ['a', 'b'] }];
  const cls = [{ pack: 'p', classId: 'a', title: 't', text: 'x'.repeat(398) }, { pack: 'p', classId: 'b', title: '', text: '' }];
  const est = hp.estimate(groups, bundles, cls);
  const perClass = Math.ceil(400 / E.bytesPerToken) + Math.ceil(1 / E.bytesPerToken);
  const hunter = (bytes) => E.hunterBase + E.tracePerHunter + 2 * E.tracePerClass + perClass + Math.ceil(bytes / E.bytesPerToken);
  assert.equal(est.hunters, 2);
  assert.equal(est.hunterTokens, hunter(40000) + hunter(120000));
  assert.equal(est.verifiers, Math.ceil(2 * E.candidatesPerHunter * E.verifiersPerCandidate));
  assert.equal(est.verifierTokens, est.verifiers * E.verifierTokens);
  assert.equal(est.agents, est.hunters + est.verifiers);
  assert.equal(est.tokens, est.hunterTokens + est.verifierTokens);
  assert.equal(est.sourceBytes, 160000);
  assert.ok(est.verifiers < 2 * est.hunters, 'far fewer verifiers than the old one-per-hunter figure');
  assert.deepEqual(hp.estimate([], bundles, cls), { hunters: 0, hunterTokens: 0, candidates: 0, verifiers: 0, verifierTokens: 0, agents: 0, tokens: 0, sourceBytes: 0 });
});

// ---- incremental --------------------------------------------------------------------------

// A ledger with the given units covered by run R1 (complete, by this engine), and R1 as the run list.
function ledgerFor(ids, over = {}) {
  const entry = { system: 'web', layer: 'L3', lastRun: 'R1', packVersions: { p: '1.0.0' }, status: 'covered', classes: ['a', 'b'], engine: hp.HUNT_ENGINE, complete: true, ...over };
  for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];
  return { project: 'example-app', units: Object.fromEntries(ids.map((id) => [`web|L3|${id}`, { ...entry }])) };
}
const NOW = Date.parse('2026-11-12T00:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

test('changedUnits: a covered unit whose source did not change since its run\'s commit is skippable; a changed one is not', () => {
  const t = tree({ 'src/a/x.ts': 'a', 'src/b/y.ts': 'b', 'src/c/z.ts': 'c', 'src/d/w.ts': 'd' }, { git: true });
  try {
    const commit = t.git('rev-parse', 'HEAD');
    const units = cov.huntUnitsForRepo(t.dir);
    const opts = (over = {}) => ({ ledger: ledgerFor(['src/a', 'src/b', 'src/c', 'src/d']), runs: [{ runId: 'R1', finishedAt: daysAgo(3), revision: { commit, dirty: false } }], system: 'web', layer: 'L3', packs: { p: '1.0.0' }, classIds: ['a'], now: NOW, ...over });
    assert.ok(hp.changedUnits(t.dir, units, opts()).every((c) => c.skippable && !c.changed && c.coveredBy === 'R1'));
    // A committed change, an uncommitted one, a new untracked file: each makes its unit changed. A Markdown change does not.
    t.put('src/a/x.ts', 'a2');
    t.git('commit', '-qam', 'change a');
    t.put('src/b/y.ts', 'b2');
    t.put('src/c/new.ts', 'new');
    t.put('src/d/NOTES.md', 'notes');
    const res = Object.fromEntries(hp.changedUnits(t.dir, cov.huntUnitsForRepo(t.dir), opts()).map((c) => [c.id, [c.changed, c.skippable]]));
    assert.deepEqual(res, { 'src/a': [true, false], 'src/b': [true, false], 'src/c': [true, false], 'src/d': [false, true] });
    // A deleted source file changes its unit too.
    fs.rmSync(path.join(t.dir, 'src/d/w.ts'));
    assert.equal(hp.changedUnits(t.dir, [{ id: 'src/d' }], opts()).find((c) => c.id === 'src/d').changed, true);
  } finally {
    t.rm();
  }
});

test('changedUnits: a change to a cross-cutting file anywhere (middleware, auth, migrations, manifests, lockfiles) changes every unit', () => {
  for (const [file, body] of [['src/b/middleware.ts', 'm'], ['src/auth/guard.ts', 'g'], ['supabase/migrations/002_rls.sql', 'drop policy'], ['package-lock.json', '{}'], ['src/b/config.ts', 'c'], ['tsconfig.json', '{}']]) {
    const t = tree({ 'src/a/x.ts': 'a', 'src/b/y.ts': 'b', 'supabase/migrations/001.sql': 's', 'package-lock.json': '{"v":1}' }, { git: true });
    try {
      const commit = t.git('rev-parse', 'HEAD');
      t.put(file, body);
      const res = hp.changedUnits(t.dir, [{ id: 'src/a' }], { ledger: ledgerFor(['src/a']), runs: [{ runId: 'R1', finishedAt: daysAgo(1), revision: { commit, dirty: false } }], system: 'web', layer: 'L3', packs: { p: '1.0.0' }, classIds: ['a'], now: NOW })[0];
      assert.deepEqual([res.changed, res.skippable], [true, false], file);
      assert.match(res.reason, /cross-cutting/, file);
    } finally {
      t.rm();
    }
  }
  for (const p of ['src/middleware.ts', 'app/api/route.ts', 'src/lib/auth/session.ts', 'src/policies/orders.ts', 'supabase/migrations/1.sql', 'prisma/schema.prisma', 'package.json', 'yarn.lock', 'next.config.js', 'src/app/_layout.tsx', 'README.md', '.github/workflows/ci.yml']) {
    assert.equal(hp.isCrossCutting(p), true, p);
  }
  for (const p of ['src/features/workout/Card.tsx', 'src/components/Button.tsx', 'src/utils/format.ts']) assert.equal(hp.isCrossCutting(p), false, p);
});

test('changedUnits: a file marked assume-unchanged or skip-worktree counts as changed for its unit', () => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const t = tree({ 'src/a/x.ts': 'a', 'src/b/y.ts': 'b' }, { git: true });
    try {
      const commit = t.git('rev-parse', 'HEAD');
      t.git('update-index', flag, 'src/a/x.ts');
      t.put('src/a/x.ts', 'edited, but git hides it');
      const res = Object.fromEntries(hp.changedUnits(t.dir, [{ id: 'src/a' }, { id: 'src/b' }], { ledger: ledgerFor(['src/a', 'src/b']), runs: [{ runId: 'R1', finishedAt: daysAgo(1), revision: { commit, dirty: false } }], system: 'web', layer: 'L3', packs: { p: '1.0.0' }, classIds: ['a'], now: NOW }).map((c) => [c.id, c.skippable]));
      assert.deepEqual(res, { 'src/a': false, 'src/b': true }, flag);
    } finally {
      t.rm();
    }
  }
});

test('changedUnits: never skippable when the entry is incomplete, from another engine (or 0.4), too old, or the revision is dirty or unknown', () => {
  const t = tree({ 'src/a/x.ts': 'a' }, { git: true });
  try {
    const commit = t.git('rev-parse', 'HEAD');
    const units = [{ id: 'src/a' }];
    const runs = (over = {}) => [{ runId: 'R1', finishedAt: daysAgo(10), revision: { commit, dirty: false }, ...over }];
    const base = { system: 'web', layer: 'L3', packs: { p: '1.0.0' }, classIds: ['a'], now: NOW };
    const one = (over) => hp.changedUnits(t.dir, units, { ledger: ledgerFor(['src/a']), runs: runs(), ...base, ...over })[0];
    const why = (over) => {
      const r = one(over);
      return [r.skippable, r.reason];
    };
    assert.equal(one({}).skippable, true);
    assert.deepEqual(why({ ledger: ledgerFor(['src/a'], { complete: false }) }), [false, 'its last hunt was incomplete (capped, invalid or undecided candidates, or missing votes)']);
    assert.deepEqual(why({ ledger: ledgerFor(['src/a'], { complete: undefined }) }), [false, 'its last hunt was incomplete (capped, invalid or undecided candidates, or missing votes)']);
    assert.deepEqual(why({ ledger: ledgerFor(['src/a'], { engine: undefined, complete: undefined }) }), [false, 'hunted by another version of the hunt engine'], 'a 0.4 entry');
    assert.deepEqual(why({ ledger: ledgerFor(['src/a'], { engine: '0.5.0-1' }) }), [false, 'hunted by another version of the hunt engine']);
    assert.deepEqual(why({ maxAgeDays: 7 }), [false, 'its last hunt is older than 7 days'], 'a skip expires with the layer\'s cadence');
    assert.equal(one({ runs: runs({ finishedAt: daysAgo(89) }) }).skippable, true);
    assert.deepEqual(why({ runs: runs({ finishedAt: daysAgo(91) }) }), [false, 'its last hunt is older than 90 days'], 'default cadence 90 days');
    assert.deepEqual([one({ runs: runs({ revision: { commit, dirty: true } }) }).changed, one({ runs: runs({ revision: { commit, dirty: true } }) }).reason], [true, 'the run that covered it hunted uncommitted changes']);
    assert.equal(one({ runs: runs({ revision: { commit: 'f'.repeat(40), dirty: false } }) }).changed, true, 'an unreachable commit');
    assert.equal(one({ runs: [{ runId: 'R1', finishedAt: daysAgo(1) }] }).changed, true, 'no revision');
    assert.equal(one({ runs: [] }).changed, true, 'the run is gone');
    assert.deepEqual(why({ packs: { p: '1.1.0' } }), [false, 'covered against other pack versions']);
    assert.deepEqual(why({ classIds: ['a', 'c'] }), [false, 'not every class of this effort was hunted on it']);
    assert.equal(one({ ledger: ledgerFor(['src/a'], { status: 'failed' }) }).skippable, false);
    assert.equal(one({ ledger: { project: 'example-app', units: {} } }).skippable, false);
  } finally {
    t.rm();
  }
});

test('changedSince returns null outside git and for a commit that is not a hash', () => {
  const t = tree({ 'a.ts': 'a' });
  try {
    assert.equal(hp.changedSince(t.dir, 'a'.repeat(40)), null);
    assert.equal(hp.changedSince(t.dir, '--output=x'), null);
  } finally {
    t.rm();
  }
});

test('packGroups carries each unit\'s present files to its group (the first part of a split unit), never into paths', () => {
  const groups = hp.packGroups([
    { ...unit('a', [10]), present: ['a/.env'] },
    { ...unit('big', [80, 80]), present: ['big/.npmrc'] },
  ], { budget: 100 });
  assert.deepEqual(groups.map((g) => [g.units, g.paths, g.present]), [
    [['a'], ['a/f0.ts'], ['a/.env']],
    [['big'], ['big/f0.ts'], ['big/.npmrc']],
    [['big'], ['big/f1.ts'], []],
  ]);
});

test('the estimate expects about 0.1 candidates per hunter, near the one measured run', () => {
  assert.ok(hp.ESTIMATE.candidatesPerHunter <= 0.1);
});
