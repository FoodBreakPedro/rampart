'use strict';
// Inventory scanner: what kind of systems live in one folder, found from manifests and file names alone, and a project.json
// draft built from them. The `inventory-mapper` agent starts from this and the user confirms it before it is saved.
//   node scripts/inventory-scan.cjs <folder> [--json] [--slug <slug>] [--name <name>]
// Prints a table of the systems found; --json prints {systems, draft} instead. Exit 0 when the folder was scanned (even if it
// held nothing recognizable), 2 for a folder that does not exist or bad arguments, 1 for anything unexpected.
//
// Only these are opened: package.json, app.json and the compose files in the folder itself (for `image:` lines). Everything else
// is looked at by name, and a .env file is never read. Nothing found is a guess the user has not confirmed, so every system is
// marked source "inferred" and lists the evidence (a file, or file#key) that put it there. The draft keeps both: the project schema
// declares source, and its systems[] are open objects, so evidence (not declared) is accepted and saved with the project.
//
// For a repo-backed system the draft also records the origin URL (credentials removed) and default branch, asked of git with
// no shell; without git, or outside a repo, those are simply left out. RAMPART_GIT overrides the git binary (tests use it).

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { machineId } = require('./lib/paths.cjs');
const { loadSchema } = require('./lib/validate.cjs');
const { which, run } = require('./lib/exec.cjs');
const { redact } = require('./lib/redact.cjs');

const MAX_MANIFEST_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 10 * 1000;
const DEFAULT_BRANCH = 'main';
const ORIGIN_HEAD = 'refs/remotes/origin/HEAD';
const ORIGIN_PREFIX = 'refs/remotes/origin/';
const NODE_API_DEPS = ['express', 'fastify', 'hono', 'koa'];
const DEP_SECTIONS = ['dependencies', 'devDependencies'];
const COMPOSE_FILE = /^(?:docker-compose.*|compose)\.ya?ml$/i;
const WP_CONFIG_FILE = /^wp-config.*\.php$/i;
const WRANGLER_FILES = ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'];
// An `image:` key, as a block line (optionally a list item) or inside a flow mapping, and the image it names.
const IMAGE_KEY = /(?:^\s*(?:-\s*)?|[{,]\s*)image\s*:\s*["']?([^\s"'},#]+)/g;
const N8N_IMAGE = /(?:^|\/)n8nio\/n8n(?:[:@]|$)/i;
const SSH_SCHEMES = new Set(['ssh', 'git+ssh', 'ssh+git']);

// What each system type is called, which packs it starts with, and how it is run. "repo" systems are code that is checked out
// and scanned from a clone (they get a repo entry and may run anywhere); "host" systems are services on a machine (local only).
const TYPES = {
  'web-nextjs': { id: 'web', name: 'Next.js app', packs: ['web-nextjs'], kind: 'repo' },
  'node-api': { id: 'api', name: 'Node API', packs: ['node-api'], kind: 'repo' },
  'mobile-expo': { id: 'mobile', name: 'Expo app', packs: ['mobile-expo'], kind: 'repo' },
  supabase: { id: 'db', name: 'Self-hosted Supabase', packs: ['supabase', 'docker-host'], kind: 'host' },
  n8n: { id: 'n8n', name: 'n8n automation', packs: ['n8n', 'docker-host'], kind: 'host' },
  'docker-host': { id: 'host', name: 'Docker host', packs: ['docker-host'], kind: 'host' },
  'cloudflare-workers': { id: 'workers', name: 'Cloudflare Workers', packs: ['cloudflare-workers'], kind: 'repo' },
  'wordpress-hostinger': { id: 'wp', name: 'WordPress site', packs: ['wordpress-hostinger'], kind: 'repo' },
  'static-site': { id: 'site', name: 'Static site', packs: ['static-site'], kind: 'repo' },
  other: { id: 'system', name: 'Other system', packs: [], kind: 'repo' },
};
const LAYERS = {
  repo: { L1: { cadenceDays: 7 }, L2: { cadenceDays: 30 }, L3: { cadenceDays: 90 } },
  host: { INFRA: { cadenceDays: 30 }, L3: { cadenceDays: 90 } },
};

const copy = (value) => JSON.parse(JSON.stringify(value));
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// ---- looking at the folder ----------------------------------------------------------------

function statOf(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}
const isDir = (file) => statOf(file)?.isDirectory() === true;
const isFile = (file) => statOf(file)?.isFile() === true;

// The text of a manifest, or null when it cannot be read or is unreasonably large.
function readText(file) {
  try {
    if (fs.statSync(file).size > MAX_MANIFEST_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// A JSON object from the folder, or null when the file is missing, not JSON, or not an object.
function readJson(dir, name) {
  const text = readText(path.join(dir, name));
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text.replace(/^﻿/, ''));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// package.json#dependencies.next, ... for each of the names found in dependencies or devDependencies.
function dependencyEvidence(manifest, names) {
  const found = [];
  if (!manifest) return found;
  for (const name of names) {
    for (const section of DEP_SECTIONS) {
      if (isObject(manifest[section]) && hasOwn(manifest[section], name)) found.push(`package.json#${section}.${name}`);
    }
  }
  return found;
}

// The names in the folder itself (not below it) that match, sorted, when they are files.
function filesMatching(dir, pattern) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => pattern.test(n) && isFile(path.join(dir, n))).sort();
}

// Whether a compose file has an `image:` line naming n8n. Only those lines are looked at, and nothing from them is kept.
function composeHasN8n(file) {
  const text = readText(file);
  if (text === null) return false;
  return text.split(/\r?\n/).some((line) => [...line.matchAll(IMAGE_KEY)].some((m) => N8N_IMAGE.test(m[1])));
}

function resolveFolder(folder) {
  if (typeof folder !== 'string' || folder === '') throw new RangeError('folder is required');
  const dir = path.resolve(folder);
  const stat = statOf(dir);
  if (!stat) throw new RangeError(`folder not found: ${dir}`);
  if (!stat.isDirectory()) throw new RangeError(`not a folder: ${dir}`);
  return dir;
}

// ---- detection ----------------------------------------------------------------------------

// Give each system an id from its type, with a numeric suffix (web, web-2, ...) when two would share one.
function assignIds(items) {
  const taken = new Set();
  return items.map((item) => {
    const base = (TYPES[item.type] || TYPES.other).id;
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
    taken.add(id);
    return Object.assign({ id }, item, { id });
  });
}

// The systems this folder holds, in a fixed order, as [{id, type, name, packs, evidence, source: 'inferred'}].
// Throws RangeError when the folder does not exist or is not a folder. A manifest that cannot be read is ignored.
function detectSystems(folder) {
  const dir = resolveFolder(folder);
  const found = [];
  const add = (type, evidence) => {
    if (evidence.length > 0) found.push({ type, evidence });
  };
  const manifest = readJson(dir, 'package.json');
  const app = readJson(dir, 'app.json');
  const nextEvidence = dependencyEvidence(manifest, ['next']);

  add('web-nextjs', nextEvidence);
  add('mobile-expo', [...dependencyEvidence(manifest, ['expo']), ...(app && hasOwn(app, 'expo') ? ['app.json#expo'] : [])]);
  add('supabase', [
    ...(isFile(path.join(dir, 'supabase', 'config.toml')) ? ['supabase/config.toml'] : []),
    ...(isDir(path.join(dir, 'infra', 'supabase')) ? ['infra/supabase'] : []),
  ]);
  const composeFiles = filesMatching(dir, COMPOSE_FILE);
  add('n8n', composeFiles.filter((f) => composeHasN8n(path.join(dir, f))).map((f) => `${f}#image:n8nio/n8n`));
  add('docker-host', composeFiles);
  add('cloudflare-workers', WRANGLER_FILES.filter((f) => isFile(path.join(dir, f))));
  add('wordpress-hostinger', [...(isDir(path.join(dir, 'wp-content')) ? ['wp-content/'] : []), ...filesMatching(dir, WP_CONFIG_FILE)]);
  if (nextEvidence.length === 0) add('node-api', dependencyEvidence(manifest, NODE_API_DEPS));

  return assignIds(found.map(({ type, evidence }) => ({
    type, name: TYPES[type].name, packs: [...TYPES[type].packs], evidence, source: 'inferred',
  })));
}

// ---- git ----------------------------------------------------------------------------------

// A remote URL without credentials. scheme://user:pass@host and scheme://token@host lose the whole userinfo; an ssh URL keeps a
// plain login name (ssh://git@host) and loses only a password. A scp-style remote (user@host:path) has no password to lose
// unless it was written user:pass@host:path. The result is redacted once more, in case the URL was shaped in a way not foreseen.
function stripCredentials(remote) {
  const url = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([\s\S]*)$/i.exec(remote);
  let clean = remote;
  if (url) {
    const [, scheme, authority, rest] = url;
    const at = authority.lastIndexOf('@');
    if (at !== -1) {
      const login = SSH_SCHEMES.has(scheme.toLowerCase()) ? authority.slice(0, at).split(':')[0] : '';
      clean = `${scheme}://${login ? `${login}@` : ''}${authority.slice(at + 1)}${rest}`;
    }
  } else {
    clean = remote.replace(/^[^@/:\s]*:[^@/\s]*@/, '');
  }
  return redact(clean);
}

// First line of git's output, or '' when git fails, times out or cannot be started. No shell is involved.
function gitOutput(git, args, cwd) {
  try {
    const result = run(git, args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
    return result.code === 0 && !result.timedOut ? (result.stdout.split(/\r?\n/)[0] || '').trim() : '';
  } catch {
    return '';
  }
}

// {remote?, defaultBranch} from the repo the folder is in: the origin URL without credentials, and origin's default branch
// when the clone knows it (otherwise main). Without git, or outside a repo, or without an origin there is no remote.
function gitInfo(dir) {
  const info = { defaultBranch: DEFAULT_BRANCH };
  const git = which('git', 'RAMPART_GIT');
  if (!git) return info;
  const remote = stripCredentials(gitOutput(git, ['remote', 'get-url', 'origin'], dir));
  if (remote === '') return info;
  info.remote = remote;
  const head = gitOutput(git, ['symbolic-ref', ORIGIN_HEAD], dir);
  const branch = head.startsWith(ORIGIN_PREFIX) ? head.slice(ORIGIN_PREFIX.length) : '';
  if (/^[^\s\u0000-\u001f]+$/.test(branch)) info.defaultBranch = branch;
  return info;
}

// ---- the draft ----------------------------------------------------------------------------

const slugSource = () => loadSchema('project').properties.slug.pattern;
const isSlug = (value) => typeof value === 'string' && new RegExp(slugSource()).test(value);

// A project.json draft for the folder: the systems found, the safest defaults (local executor, no cloud, medium criticality, the
// layer cadences for the kind of system), and an owner attestation left empty, so the project does not validate until the user has
// made it. The systems are detected here unless the caller hands in what detectSystems already returned.
// Throws RangeError when the slug cannot be saved or the folder does not exist.
function draftProject({ slug, name, folder, systems } = {}) {
  const dir = resolveFolder(folder);
  if (!isSlug(slug)) throw new RangeError(`slug must match ${slugSource()}`);
  const found = systems === undefined ? detectSystems(dir) : systems;
  const git = found.some((s) => (TYPES[s.type] || TYPES.other).kind === 'repo') ? gitInfo(dir) : null;
  return {
    slug,
    name: typeof name === 'string' && name.trim() !== '' ? name : path.basename(dir) || slug,
    criticality: 'medium',
    ownerAttestation: { statement: '', by: '', at: '' },
    defaultExecutor: 'local',
    cloudAllowed: false,
    systems: found.map((s) => {
      const { kind } = TYPES[s.type] || TYPES.other;
      const draft = { id: s.id, type: s.type, name: s.name, packs: [...s.packs] };
      if (kind === 'repo') {
        draft.repo = {
          ...(git.remote ? { remote: git.remote } : {}),
          defaultBranch: git.defaultBranch,
          paths: { [machineId()]: dir },
        };
      }
      return { ...draft, executor: kind === 'host' ? 'local' : 'either', layers: copy(LAYERS[kind]), source: s.source, evidence: [...s.evidence] };
    }),
  };
}

// ---- command line -------------------------------------------------------------------------

class UsageError extends Error {}

const USAGE = 'usage: node scripts/inventory-scan.cjs <folder> [--json] [--slug <slug>] [--name <name>]';

function parseCli(argv) {
  let parsed;
  try {
    parsed = util.parseArgs({
      args: argv,
      options: { json: { type: 'boolean' }, slug: { type: 'string' }, name: { type: 'string' } },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    throw new UsageError(err.message.split('\n')[0]);
  }
  const { values, positionals } = parsed;
  if (positionals.length === 0) throw new UsageError('<folder> is required');
  if (positionals.length > 1) throw new UsageError('only one <folder> can be scanned at a time');
  return { folder: positionals[0], ...values };
}

// The folder's name as a slug (a-z, 0-9 and single dashes, at most 40 characters).
function slugFromFolder(dir) {
  const slug = path.basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  if (!isSlug(slug)) throw new UsageError('cannot make a slug from the folder name; pass --slug');
  return slug;
}

function table(dir, systems) {
  if (systems.length === 0) return `inventory-scan: ${dir}\nno systems detected (nothing recognizable in the manifests or file names)`;
  const rows = [['id', 'type', 'name', 'evidence'], ...systems.map((s) => [s.id, s.type, s.name, s.evidence.join(', ')])];
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => r[col].length)));
  const lines = rows.map((r) => r.map((cell, col) => cell.padEnd(widths[col])).join('  ').trimEnd());
  return [
    `inventory-scan: ${dir}`,
    `${systems.length} system${systems.length === 1 ? '' : 's'} found (inferred from manifests and file names, not yet confirmed)`,
    '',
    ...lines,
    '',
    'Run with --json for the project draft.',
  ].join('\n');
}

// Run the command and return its exit code (the caller sets process.exitCode).
function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const opts = parseCli(argv);
    const dir = resolveFolder(opts.folder);
    const systems = detectSystems(dir);
    const draft = draftProject({ slug: opts.slug !== undefined ? opts.slug : slugFromFolder(dir), name: opts.name, folder: dir, systems });
    stdout.write(`${opts.json ? JSON.stringify({ systems, draft }, null, 2) : table(dir, systems)}\n`);
    return 0;
  } catch (err) {
    stderr.write(`inventory-scan: ${redact(err.message)}\n`);
    if (err instanceof UsageError) stderr.write(`${USAGE}\n`);
    return err instanceof UsageError || err instanceof RangeError ? 2 : 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { detectSystems, draftProject, assignIds, stripCredentials };
