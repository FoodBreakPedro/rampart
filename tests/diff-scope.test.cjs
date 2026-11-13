const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { diffScope } = require('../scripts/diff-scope.cjs');

const CLI = path.join(__dirname, '..', 'scripts', 'diff-scope.cjs');

let repo;
const git = (...args) => {
  const r = spawnSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const write = (rel, text) => {
  const file = path.join(repo, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const commit = (msg) => {
  git('add', '-A');
  git('commit', '-q', '-m', msg);
};

test.beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart diff repo '));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@example.com');
  write('lib/db.ts', 'a\nb\nc\nd\ne\n');
  write('lib/old.ts', 'old\n');
  write('docs/guide.md', 'x\n');
  write('rename-me.ts', 'one\ntwo\nthree\nfour\nfive\n');
  commit('base 1');
  write('README.md', 'hi\n');
  commit('base 2');
  git('checkout', '-q', '-b', 'feature');
});
test.afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('a branch adding a route and editing lib/db.ts: files, hunks and units', () => {
  write('app/api/x/route.ts', 'l1\nl2\nl3\n');
  write('lib/db.ts', 'a\nb\nCHANGED\nd\ne\n');
  commit('feature');
  const r = diffScope(repo, { base: 'main' });
  assert.equal(r.empty, false);
  assert.equal(r.base, 'main');
  assert.match(r.head, /^[0-9a-f]{40}$/);
  assert.match(r.baseSha, /^[0-9a-f]{40}$/);
  assert.deepEqual(r.files, [
    { path: 'app/api/x/route.ts', status: 'A', hunks: [{ start: 1, end: 3 }] },
    { path: 'lib/db.ts', status: 'M', hunks: [{ start: 3, end: 3 }] },
  ]);
  assert.deepEqual(r.units, [
    { id: 'app/api/x', kind: 'dir', files: 1, reachable: true },
    { id: 'lib', kind: 'dir', files: 1, reachable: true },
  ]);
});

test('same branch as base is empty', () => {
  const r = diffScope(repo, { base: 'feature' });
  assert.equal(r.empty, true);
  assert.deepEqual(r.files, []);
  assert.deepEqual(r.units, []);
  const out = cli('--repo', repo, '--base', 'feature', '--json');
  assert.equal(out.status, 0);
  assert.equal(JSON.parse(out.stdout).empty, true);
  assert.match(cli('--repo', repo, '--base', 'feature').stdout, /nothing to scan/);
});

test('unknown base exits 2 naming the closest branch', () => {
  const r = cli('--repo', repo, '--base', 'mian');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /main/);
});

test('not a git repo exits 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart nogit '));
  try {
    assert.equal(cli('--repo', dir, '--base', 'main').status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deleted and ignored files are excluded from units; deleted has no hunks', () => {
  fs.rmSync(path.join(repo, 'lib/old.ts'));
  write('node_modules/pkg/index.js', 'x\n');
  write('yarn.lock', 'x\n');
  commit('feature');
  const r = diffScope(repo, { base: 'main' });
  const old = r.files.find((f) => f.path === 'lib/old.ts');
  assert.deepEqual(old, { path: 'lib/old.ts', status: 'D', hunks: [] });
  assert.deepEqual(r.units, []);
  assert.equal(r.empty, true);
});

test('a rename is reported as R with the new path', () => {
  git('mv', 'rename-me.ts', 'renamed.ts');
  commit('feature');
  const r = diffScope(repo, { base: 'main' });
  assert.deepEqual(r.files.map((f) => [f.path, f.status]), [['renamed.ts', 'R']]);
  assert.deepEqual(r.units.map((u) => u.id), ['.']);
});

test('a path with a space works, with hunks', () => {
  write('src/my dir/a file.ts', 'x\ny\n');
  commit('feature');
  const r = diffScope(repo, { base: 'main' });
  assert.deepEqual(r.files, [{ path: 'src/my dir/a file.ts', status: 'A', hunks: [{ start: 1, end: 2 }] }]);
  assert.deepEqual(r.units.map((u) => u.id), ['src/my dir']);
});

test('pure deletion hunks are skipped, a missing count means one line', () => {
  write('lib/db.ts', 'a\nb\nd\ne\n'); // deletes c
  write('rename-me.ts', 'ONE\ntwo\nthree\nfour\nfive\n'); // 1 line changed: +1 without count
  commit('feature');
  const r = diffScope(repo, { base: 'main' });
  assert.deepEqual(r.files.find((f) => f.path === 'lib/db.ts').hunks, []);
  assert.deepEqual(r.files.find((f) => f.path === 'rename-me.ts').hunks, [{ start: 1, end: 1 }]);
});

test('defaultBranch resolves to origin/<branch> when it exists, else local', () => {
  write('lib/x.ts', 'x\n');
  commit('feature');
  assert.equal(diffScope(repo, { defaultBranch: 'main' }).base, 'main');
  git('update-ref', 'refs/remotes/origin/main', 'main');
  assert.equal(diffScope(repo, { defaultBranch: 'main' }).base, 'origin/main');
});
