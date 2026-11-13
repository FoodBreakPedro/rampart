'use strict';
// The scope of an L2 audit on a branch: the files it changed against its base and the units those files fall in.
//
//   diffScope(repoPath, {base, defaultBranch})
//        -> {base, baseSha, head, files: [{path, status: 'A'|'M'|'D'|'R', hunks: [{start, end}]}], units, empty}
//   base is a ref the caller resolved. Without it, defaultBranch (default 'main') is used: origin/<branch> when that ref
//   exists, else the local branch. Changes are those of `base...HEAD` (since the merge base). Hunks are line ranges on the new
//   side; a pure-deletion hunk has no new lines and is skipped, a deleted file has no hunks. units are the unique units
//   (coverage.cjs unitOf) of the files that are neither deleted nor ignored, with their count of changed files.
//   empty is true when no unit remains. Throws RangeError for a path that is not a git repo or a base that does not resolve.
// Read-only: no run directory and no store write is ever made here.
// CLI: node scripts/diff-scope.cjs --repo <path> [--base <ref>] [--project <slug> --system <id>] [--json]
//   --base wins; else the system's repo.defaultBranch (read only with --project and --system); else main.
//   Exit 0 ok (also when empty), 2 for a usage error, a non-repo or an unknown base, 1 for anything else.

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { run } = require('./lib/exec.cjs');
const { unitOf, isIgnored, isReachable } = require('./coverage.cjs');
const { resolveSystem } = require('./lib/l1-common.cjs');
const { redact } = require('./lib/redact.cjs');

const FALLBACK_BRANCH = 'main';
const GIT_TIMEOUT_MS = 60000;

class UsageError extends Error {}

function git(repo, args) {
  try {
    return run('git', ['-C', repo, '-c', 'core.quotepath=off', ...args], { timeoutMs: GIT_TIMEOUT_MS });
  } catch (err) {
    throw new Error(`git could not be started: ${err.message}`);
  }
}

function mustGit(repo, args) {
  const r = git(repo, args);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim().split('\n')[0]}`);
  return r.stdout;
}

const refExists = (repo, ref) => git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).code === 0;

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

function closestBranch(repo, name) {
  const out = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']).stdout;
  const names = out.split('\n').map((s) => s.trim()).filter((s) => s && !s.endsWith('/HEAD'));
  let best = null;
  for (const n of names) {
    const d = editDistance(name.toLowerCase(), n.toLowerCase());
    if (best === null || d < best.d) best = { n, d };
  }
  return best && best.n;
}

const unknownBase = (repo, name) => {
  const near = closestBranch(repo, name);
  return new RangeError(`unknown base: ${name}${near ? `; the closest branch is ${near}` : ''}`);
};

function resolveBase(repo, { base, defaultBranch }) {
  if (base !== undefined && base !== null && base !== '') {
    if (base.startsWith('-') || !refExists(repo, base)) throw unknownBase(repo, base);
    return base;
  }
  const branch = defaultBranch || FALLBACK_BRANCH;
  if (refExists(repo, `origin/${branch}`)) return `origin/${branch}`;
  if (refExists(repo, branch)) return branch;
  throw unknownBase(repo, branch);
}

// `git diff --name-status -z`: "<status>\0<path>\0", and "R<score>\0<old>\0<new>\0" for a rename or copy.
function parseNameStatus(text) {
  const t = text.split('\0');
  const files = [];
  for (let i = 0; i < t.length && t[i] !== ''; ) {
    const code = t[i][0];
    if (code === 'R' || code === 'C') {
      files.push({ path: t[i + 2], status: 'R', hunks: [] });
      i += 3;
    } else {
      files.push({ path: t[i + 1], status: code === 'A' || code === 'D' ? code : 'M', hunks: [] });
      i += 2;
    }
  }
  return files;
}

const ESCAPES = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };

// A path as git quotes it when it has control characters or quotes (C-style escapes, octal bytes).
function unquote(s) {
  if (!s.startsWith('"')) return s;
  const body = s.slice(1, s.lastIndexOf('"'));
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      bytes.push(...Buffer.from(body[i]));
      continue;
    }
    const c = body[++i];
    if (/[0-7]/.test(c)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else {
      bytes.push(...Buffer.from(ESCAPES[c] === undefined ? c : ESCAPES[c]));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// Hunk ranges on the new side, by file: `+++ b/<path>` starts a file, `@@ -a,b +c,d @@` a hunk.
function parseHunks(text) {
  const byPath = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = unquote(line.slice(4).replace(/\t$/, ''));
      if (p === '/dev/null') {
        current = null;
      } else {
        current = [];
        byPath.set(p.slice(2), current);
      }
    } else if (current && line.startsWith('@@')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count > 0) current.push({ start, end: start + count - 1 });
    }
  }
  return byPath;
}

const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function diffScope(repoPath, { base, defaultBranch } = {}) {
  const repo = path.resolve(repoPath);
  if (!fs.existsSync(repo) || git(repo, ['rev-parse', '--git-dir']).code !== 0) throw new RangeError(`not a git repository: ${repo}`);
  const ref = resolveBase(repo, { base, defaultBranch });
  const range = `${ref}...HEAD`;
  const head = git(repo, ['rev-parse', 'HEAD']);
  if (head.code !== 0) throw new RangeError('the repository has no commits');
  const baseSha = mustGit(repo, ['rev-parse', `${ref}^{commit}`]).trim();
  const files = parseNameStatus(mustGit(repo, ['diff', '--name-status', '-z', '-M', range]));
  const hunks = parseHunks(mustGit(repo, ['diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', range]));
  for (const f of files) if (f.status !== 'D') f.hunks = hunks.get(f.path) || [];
  files.sort((a, b) => byString(a.path, b.path));
  const counts = new Map();
  for (const f of files) {
    if (f.status === 'D' || isIgnored(f.path)) continue;
    const id = unitOf(f.path);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const units = [...counts.entries()]
    .sort(([a], [b]) => byString(a, b))
    .map(([id, n]) => ({ id, kind: 'dir', files: n, reachable: isReachable(id) }));
  return { base: ref, baseSha, head: head.stdout.trim(), files, units, empty: units.length === 0 };
}

// ---- the command line ---------------------------------------------------------------------

const USAGE = 'usage: node scripts/diff-scope.cjs --repo <path> [--base <ref>] [--project <slug> --system <id>] [--json]';

function parse(argv) {
  let values;
  try {
    ({ values } = util.parseArgs({
      args: argv,
      options: { repo: { type: 'string' }, base: { type: 'string' }, project: { type: 'string' }, system: { type: 'string' }, json: { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new UsageError(err.message.split('\n')[0]);
  }
  if (values.repo === undefined) throw new UsageError('--repo is required');
  if ((values.project === undefined) !== (values.system === undefined)) throw new UsageError('--project and --system go together');
  return values;
}

function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const opts = parse(argv);
    let defaultBranch;
    if (opts.base === undefined && opts.project !== undefined) {
      const { system } = resolveSystem(opts.project, opts.system);
      defaultBranch = system.repo && system.repo.defaultBranch;
    }
    const result = diffScope(opts.repo, { base: opts.base, defaultBranch });
    if (opts.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.empty) {
      stdout.write(`nothing to scan: no changed files against ${result.base}\n`);
    } else {
      const n = result.files.length;
      stdout.write(`${n} changed file${n === 1 ? '' : 's'} against ${result.base}; units:\n`);
      for (const u of result.units) stdout.write(`${u.id}  ${u.files} file${u.files === 1 ? '' : 's'}${u.reachable ? '' : '  (background)'}\n`);
    }
    return 0;
  } catch (err) {
    stderr.write(`diff-scope: ${redact(err.message)}\n`);
    if (err instanceof UsageError) stderr.write(`${USAGE}\n`);
    return err instanceof UsageError || err instanceof RangeError ? 2 : 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { diffScope, main, parseNameStatus, parseHunks };
