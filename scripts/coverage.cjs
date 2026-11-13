'use strict';
// Units and the coverage ledger. A unit is a piece of a target that a hunter covers: a directory of a repo (kind 'dir') or a
// probe of a host pack (kind 'probe'). The ledger (projects/<slug>/coverage.json, via the store) records, per system and layer,
// which units a run covered and with which pack versions, so a later run hunts only the gaps.
//
//   unitOf(relPath, maxDepth = 2)        the unit id of a repo file: its directory cut to at most maxDepth + 1 path segments
//                                        (app/api/users/route.ts -> app/api/users, a/b/c/d/e.ts -> a/b/c); a root-level file
//                                        is unit '.'. Pure; accepts / or \ and returns POSIX ids. Task 5 (diff scope) reuses it.
//   isIgnored(relPath, ignore)           true when a path is excluded: a plain entry matches any path segment, an entry with *
//                                        matches file basenames (*.lock, *.min.js). Pure; same separators rule.
//   unitContains(unitId, relPath, maxDepth) bucket membership: unitOf(relPath, maxDepth) === unitId, never a prefix test; unit '.'
//                                        owns only root-level files. Pure.
//   packVersionsFor(system, layer)       {name: version} of the system's packs of the layer's kind (host for INFRA, else code).
//                                        The `packs` given to markCovered and gaps must be this layer-scoped set.
//   unitsForRepo(repoPath, opts)         [{id, kind: 'dir', files, reachable}] sorted by id; ignored paths produce no units.
//                                        reachable is false for tests|test|__tests__|fixtures|docs|scripts roots (background only).
//                                        opts.paths: also keep each unit's repo-relative files, sorted, as `paths`.
//   classifyFile(relPath, bytes)        what a hunt does with a file: 'source' (read), 'present' (a possible credential: named,
//                                        never opened), 'oversize' (source over the size cap: listed as not hunted) or 'excluded'
//                                        with a class (image, font, media, archive, binary, document, prose, data, style,
//                                        translation, lockfile, generated, tooling, housekeeping). A denylist: anything not known
//                                        to be non-code is read. Pure. isHuntWorthy(relPath, bytes) is kind === 'source'.
//   listRepoFiles(repoPath, opts)        {source: 'git'|'walk', files: [{path, bytes}], submodules}: in a git checkout the tracked
//                                        files (submodules' too) plus the untracked ones git does not ignore, else a walk of the
//                                        tree; ignored paths (DEFAULT_IGNORE) are left out either way. Sorted by path.
//   huntScope(repoPath, opts)            {source, units, excluded}: the units a hunt plans (unitsForRepo's ids, built from the
//                                        source files, each with `paths`, `sizes`, `bytes`, and `present` / `oversize` when it
//                                        has them) and what was left out, by class, with every oversize file and its size. A
//                                        directory with neither source nor oversize source is no unit: never planned, never a gap.
//                                        huntUnitsForRepo(repoPath) is its units.
//   unitsForHost(system, pack)           one {id: 'probe:<probeId>', kind: 'probe', reachable: true} per pack probe.
//   markCovered(ledger, {...})           the ledger with the given units stamped (pure; the input is not changed), with the
//                                        class ids hunted (`classes`) and the run's `effort` when given; `changed` unit ids drop
//                                        the classes earlier runs hunted (their code is not the code those runs read).
//   gaps(ledger, {...})                  the units that still need a hunt: never covered, status failed, covered against an
//                                        older or different version of any pack in `packs`, or (given `classes`, every class
//                                        of the layer) covered without every class hunted, with `missingClasses`.
//   classIdsFor(system, layer)           every class id of the layer's packs (undefined for L1): the `classes` for gaps.
// CLI: node scripts/coverage.cjs units|gaps|show --project <slug> --system <id> [--repo <path>] [--layer L1|L2|L3|INFRA] [--reachable] [--json]
//   units and gaps list the hunt units (huntUnitsForRepo): a folder of images or Markdown only is not a unit.
//   --reachable keeps only reachable units (the background ones - docs, scripts, tests - are listed with reachable false otherwise).
// (--layer defaults to L2). Exit 0 ok, 2 for a usage error or a project, system or repo that does not resolve, 1 for anything else.

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const store = require('./store.cjs');
const { packsFor } = require('./packs.cjs');
const { resolveSystem, resolveRepo } = require('./lib/l1-common.cjs');
const { redact } = require('./lib/redact.cjs');
const { run: runCmd } = require('./lib/exec.cjs');

const DEFAULT_IGNORE = Object.freeze([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', 'vendor', 'public',
  'tests', 'test', '__tests__', 'fixtures', '*.lock', '*.min.js',
]);
const BACKGROUND_ROOTS = new Set(['tests', 'test', '__tests__', 'fixtures', 'docs', 'scripts']);
const LAYERS = ['L1', 'L2', 'L3', 'INFRA'];
const STATUSES = ['covered', 'skipped', 'failed'];
const DEFAULT_MAX_DEPTH = 2;

// A relative path as POSIX segments: backslashes become slashes, empty and '.' segments are dropped.
const segmentsOf = (relPath) => String(relPath).replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');

function unitOf(relPath, maxDepth = DEFAULT_MAX_DEPTH) {
  const dirs = segmentsOf(relPath).slice(0, -1);
  return dirs.length === 0 ? '.' : dirs.slice(0, maxDepth + 1).join('/');
}

function isIgnored(relPath, ignore = DEFAULT_IGNORE) {
  const segs = segmentsOf(relPath);
  const base = segs[segs.length - 1];
  return ignore.some((entry) => {
    if (!entry.includes('*')) return segs.includes(entry);
    const re = new RegExp(`^${entry.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return base !== undefined && re.test(base);
  });
}

const unitContains = (unitId, relPath, maxDepth = DEFAULT_MAX_DEPTH) => unitOf(relPath, maxDepth) === unitId;

// The versions of the packs that apply to this layer of the system: host packs for INFRA, code packs otherwise, so a bump of
// one kind never reopens the units of the other.
function packVersionsFor(system, layer) {
  const kind = layer === 'INFRA' ? 'host' : 'code';
  return Object.fromEntries(packsFor(system).filter((p) => (p.kinds || []).includes(kind)).map((p) => [p.name, p.version]));
}

// ---- units --------------------------------------------------------------------------------

const isReachable = (unitId) => !BACKGROUND_ROOTS.has(unitId.split('/')[0]);

function unitsForRepo(repoPath, { maxDepth = DEFAULT_MAX_DEPTH, ignore = DEFAULT_IGNORE, paths = false } = {}) {
  const files = new Map();
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(repoPath, rel), { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (isIgnored(next, ignore)) continue;
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) {
        const id = unitOf(next, maxDepth);
        if (!files.has(id)) files.set(id, []);
        files.get(id).push(next);
      }
    }
  };
  walk('');
  const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...files.entries()]
    .sort(([a], [b]) => byString(a, b))
    .map(([id, list]) => ({ id, kind: 'dir', files: list.length, reachable: isReachable(id), ...(paths ? { paths: list.sort(byString) } : {}) }));
}

// ---- hunt scope: which files a hunt reads ---------------------------------------------------

// A hunt reads every file except known non-code (a denylist: an unknown extension, or none, is read). Each excluded file gets a
// class, recorded in units.json and the report. Extensions are matched lowercased, without the dot.
const EXCLUDED_EXTENSIONS = Object.freeze({
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'svg', 'tif', 'tiff', 'heic', 'heif', 'avif', 'psd', 'ai', 'sketch', 'fig', 'xcf', 'eps', 'raw', 'cr2', 'nef'],
  font: ['ttf', 'otf', 'woff', 'woff2', 'eot', 'fon'],
  media: ['mp3', 'mp4', 'm4a', 'm4v', 'mov', 'avi', 'mkv', 'webm', 'wav', 'ogg', 'oga', 'flac', 'aac', 'wma', 'wmv', 'flv', 'mid', 'midi', 'lottie', 'riv'],
  archive: ['zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'bz2', 'xz', 'zst', 'lz', 'lzma', 'jar', 'war', 'ear', 'aar', 'apk', 'aab', 'ipa', 'dmg', 'iso', 'pkg', 'deb', 'rpm', 'msi', 'crx', 'xpi', 'whl', 'gem', 'nupkg'],
  binary: ['exe', 'dll', 'so', 'dylib', 'a', 'lib', 'o', 'obj', 'class', 'pyc', 'pyo', 'wasm', 'bin', 'dat', 'db', 'sqlite', 'sqlite3', 'mdb', 'node', 'dSYM', 'car', 'nib', 'tflite', 'onnx', 'pt', 'h5', 'pb', 'mlmodel', 'glb', 'gltf', 'fbx', 'blend', 'stl', 'usdz', 'unitypackage'],
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'pages', 'numbers', 'epub'],
  prose: ['md', 'markdown', 'rst', 'txt', 'adoc', 'asciidoc', 'rtf', 'org', 'textile', 'tex'],
  data: ['csv', 'tsv', 'log', 'map', 'snap', 'lcov', 'parquet', 'avro', 'ndjson', 'jsonl', 'geojson', 'topojson', 'har', 'pcap'],
  style: ['css', 'scss', 'sass', 'less', 'styl', 'stylus'],
  translation: ['po', 'pot', 'mo', 'xlf', 'xliff', 'strings', 'stringsdict', 'arb', 'resx'],
});
// Files known by name that hold no behaviour.
const EXCLUDED_NAMES = Object.freeze({
  prose: ['LICENSE', 'LICENCE', 'COPYING', 'NOTICE', 'AUTHORS', 'CONTRIBUTORS', 'CHANGELOG', 'README', 'CODEOWNERS', 'PATENTS', 'OWNERS'],
  housekeeping: ['.gitignore', '.gitattributes', '.gitmodules', '.gitkeep', '.keep', '.editorconfig', '.DS_Store', 'Thumbs.db', '.nvmrc', '.node-version', '.python-version', '.ruby-version', '.tool-versions', '.prettierignore', '.eslintignore', '.dockerignore', '.npmignore', '.watchmanconfig', '.mailmap'],
});
// Lockfiles: generated, huge, and the dependency check (L1) reads them already. A change to one still counts as cross-cutting.
const LOCKFILES = Object.freeze(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'Podfile.lock', 'Gemfile.lock', 'composer.lock', 'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'go.sum', 'mix.lock', 'pubspec.lock', 'gradle.lockfile', 'packages.lock.json', 'flake.lock', 'deno.lock', 'Package.resolved']);
// Editor settings, tool caches and test doubles: never behaviour of the app.
const NON_SOURCE_DIRS = new Set(['.vscode', '.idea', '.expo', '.cache', '.turbo', '.parcel-cache', '.gradle', '.dart_tool', '__snapshots__', '__mocks__']);
// Translation string tables: a data file (or a .ts/.js string table) under a translations folder whose own name or a folder
// between is a locale code (src/i18n/locales/es/names.ts, locales/en.json). Code in a folder that happens to be called `lang`
// (src/lib/lang/parser.ts) is still read.
const TRANSLATION_DIRS = new Set(['locales', 'locale', 'translations', 'i18n', 'l10n']);
const TRANSLATION_DATA_EXT = new Set(['json', 'json5', 'yml', 'yaml', 'properties', 'ini', 'ts', 'js', 'mjs', 'cjs', 'toml', 'xml']);
const LOCALE_RE = /^[a-z]{2,3}([-_][A-Za-z]{2,4})?$/;
// Files whose content may be a credential. A hunter is told they are there (present, do not open) and never gets them to read:
// their presence is the evidence. Env templates (.env.example, .sample, .template) are read as ordinary config.
const SECRET_FILE_RE = /^(\.env(\..+)?|\.dev\.vars|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.htpasswd|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|jks|keystore|p8|ppk|asc|gpg|kdbx|ovpn|mobileprovision)|(credentials?|secrets?|service[-_]?account)([-_.][^/]*)?\.(json|ya?ml|toml|ini|txt|env)|.*\.secrets?)$/i;
const TEMPLATE_RE = /\.(example|sample|template|dist|defaults?)$/i;
// Size caps: a file over MAX_HUNT_FILE_BYTES is generated or seed data more often than code, and would crowd out a hunter's
// context. It is not read, but it is never invisible either: units.json and the report list it as not hunted, and a directory
// whose source is all over the cap is a unit that is not covered. JSON over MAX_HUNT_JSON_BYTES is treated the same way.
const MAX_HUNT_FILE_BYTES = 200 * 1024;
const MAX_HUNT_JSON_BYTES = 64 * 1024;
const JSON_EXTENSIONS = new Set(['json', 'jsonc', 'json5']);
// Hunt-scope classification is part of the hunt engine (hunt-plan.cjs HUNT_ENGINE): change it, bump that.

const extOf = (base) => {
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};

// What a hunt does with one file: {kind: 'source'} (read), {kind: 'present', reason: 'possible credential'} (named to the
// hunter, never opened), {kind: 'oversize', reason} (source not read because of its size) or {kind: 'excluded', reason: class}.
// bytes undefined classifies by name only. Pure.
function classifyFile(relPath, bytes) {
  const segs = segmentsOf(relPath);
  const base = segs[segs.length - 1];
  if (!base) return { kind: 'excluded', reason: 'housekeeping' };
  const dirs = segs.slice(0, -1);
  if (dirs.some((s) => NON_SOURCE_DIRS.has(s))) return { kind: 'excluded', reason: 'tooling' };
  if (SECRET_FILE_RE.test(base) && !TEMPLATE_RE.test(base)) return { kind: 'present', reason: 'possible credential' };
  if (LOCKFILES.includes(base)) return { kind: 'excluded', reason: 'lockfile' };
  const stem = base.replace(/\.[^.]*$/, '');
  for (const [reason, names] of Object.entries(EXCLUDED_NAMES)) if (names.includes(base) || (reason === 'prose' && names.includes(stem.toUpperCase()) && stem === stem.toUpperCase())) return { kind: 'excluded', reason };
  if (/\.min\.[a-z0-9]+$/i.test(base) || /\.(bundle|chunk)\.[cm]?js$/i.test(base) || /[.-][0-9a-f]{8,}\.[cm]?js$/i.test(base)) return { kind: 'excluded', reason: 'generated' };
  const ext = extOf(base);
  for (const [reason, exts] of Object.entries(EXCLUDED_EXTENSIONS)) if (exts.includes(ext)) return { kind: 'excluded', reason };
  const at = dirs.findIndex((s) => TRANSLATION_DIRS.has(s.toLowerCase()));
  if (at !== -1 && TRANSLATION_DATA_EXT.has(ext) && [...dirs.slice(at + 1), stem].some((s) => LOCALE_RE.test(s))) return { kind: 'excluded', reason: 'translation' };
  if (bytes === undefined || bytes === null) return { kind: 'source' };
  if (!Number.isFinite(bytes) || bytes < 0) return { kind: 'excluded', reason: 'unreadable' };
  if (bytes > MAX_HUNT_FILE_BYTES) return { kind: 'oversize', reason: `over ${MAX_HUNT_FILE_BYTES / 1024} KB` };
  if (JSON_EXTENSIONS.has(ext) && bytes > MAX_HUNT_JSON_BYTES) return { kind: 'oversize', reason: `JSON over ${MAX_HUNT_JSON_BYTES / 1024} KB` };
  return { kind: 'source' };
}

const isHuntWorthy = (relPath, bytes) => classifyFile(relPath, bytes).kind === 'source';

const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const GIT_LIST_TIMEOUT_MS = 60000;

function gitList(repoPath, args) {
  const r = runCmd('git', ['-C', repoPath, '-c', 'core.quotepath=off', 'ls-files', '-z', ...args, '--', '.'], { timeoutMs: GIT_LIST_TIMEOUT_MS });
  return r.code === 0 ? r.stdout.split('\0').filter(Boolean) : null;
}

// The repo-relative files git knows for this checkout (tracked, with the files of checked-out submodules, plus untracked that
// are not ignored), or null when repoPath is not inside a git work tree or git cannot run. Paths are relative to repoPath, also
// when it is a folder inside a larger repo.
function gitFiles(repoPath) {
  try {
    const inside = runCmd('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree'], { timeoutMs: GIT_LIST_TIMEOUT_MS });
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null;
    const cached = gitList(repoPath, ['--cached', '--recurse-submodules']) || gitList(repoPath, ['--cached']);
    const others = gitList(repoPath, ['--others', '--exclude-standard']);
    if (!cached || !others) return null;
    return [...new Set([...cached, ...others])];
  } catch {
    return null;
  }
}

// {source: 'git'|'walk', files: [{path, bytes}], submodules: [path]}: submodules are folders git lists as one entry (a submodule
// that is not checked out); their code is not hunted and the report says so.
function listRepoFiles(repoPath, { ignore = DEFAULT_IGNORE, git = true } = {}) {
  const listed = git ? gitFiles(repoPath) : null;
  const files = [];
  const submodules = [];
  if (listed) {
    for (const rel of listed) {
      if (isIgnored(rel, ignore)) continue;
      let st;
      try {
        st = fs.lstatSync(path.join(repoPath, rel));
      } catch {
        continue; // tracked but deleted from the working tree
      }
      const p = segmentsOf(rel).join('/');
      if (st.isFile()) files.push({ path: p, bytes: st.size });
      else if (st.isDirectory()) submodules.push(p);
    }
    return { source: 'git', files: files.sort(byPath), submodules: submodules.sort() };
  }
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(repoPath, rel), { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (isIgnored(next, ignore)) continue;
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) files.push({ path: next, bytes: fs.statSync(path.join(repoPath, next)).size });
    }
  };
  walk('');
  return { source: 'walk', files: files.sort(byPath), submodules };
}

// The hunt scope of a list of files: {units, excluded}. A unit is a directory holding source (`paths`, `sizes`, `bytes`) or
// source too large to read (`oversize`: [{path, bytes, reason}]; a unit with only that is planned but not hunted); files that
// may be credentials ride along as `present`. excluded = {counts: {class: n}, oversize: [...], present: [paths outside any
// unit], submodules}.
function scanFiles(files, { maxDepth = DEFAULT_MAX_DEPTH, submodules = [] } = {}) {
  const byUnit = new Map();
  const counts = {};
  const loose = [];
  const slot = (id) => {
    if (!byUnit.has(id)) byUnit.set(id, { source: [], oversize: [], present: [] });
    return byUnit.get(id);
  };
  for (const f of files) {
    const c = classifyFile(f.path, f.bytes);
    const id = unitOf(f.path, maxDepth);
    if (c.kind === 'source') slot(id).source.push(f);
    else if (c.kind === 'oversize') slot(id).oversize.push({ path: f.path, bytes: f.bytes, reason: c.reason });
    else if (c.kind === 'present') loose.push(f.path);
    else counts[c.reason] = (counts[c.reason] || 0) + 1;
  }
  const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const present = [];
  for (const p of loose) {
    const id = unitOf(p, maxDepth);
    if (byUnit.has(id)) byUnit.get(id).present.push(p);
    else present.push(p);
  }
  const units = [...byUnit.entries()].sort(([a], [b]) => byString(a, b)).map(([id, u]) => {
    const sorted = [...u.source].sort(byPath);
    const out = {
      id, kind: 'dir', files: sorted.length, reachable: isReachable(id),
      bytes: sorted.reduce((n, f) => n + f.bytes, 0), paths: sorted.map((f) => f.path), sizes: sorted.map((f) => f.bytes),
    };
    if (u.present.length) out.present = u.present.sort();
    if (u.oversize.length) out.oversize = u.oversize.sort(byPath);
    return out;
  });
  const oversize = units.flatMap((u) => u.oversize || []);
  return { units, excluded: { counts, oversize, present: present.sort(), submodules: [...submodules].sort() } };
}

// Units only (scanFiles(...).units), for callers that need no exclusion record.
const unitsFromFiles = (files, opts) => scanFiles(files, opts).units;

function huntScope(repoPath, { maxDepth = DEFAULT_MAX_DEPTH, ignore = DEFAULT_IGNORE, git = true } = {}) {
  const listed = listRepoFiles(repoPath, { ignore, git });
  return { source: listed.source, ...scanFiles(listed.files, { maxDepth, submodules: listed.submodules }) };
}

function huntUnitsForRepo(repoPath, opts = {}) {
  const scope = huntScope(repoPath, opts);
  return Object.assign(scope.units, { source: scope.source, excluded: scope.excluded });
}

function unitsForHost(system, pack) {
  return ((pack && pack.probes) || []).map((p) => ({ id: `probe:${p.id}`, kind: 'probe', reachable: true }));
}

// ---- ledger -------------------------------------------------------------------------------

const keyOf = (system, layer, unitId) => `${system}|${layer}|${unitId}`;
const idOf = (unit) => (typeof unit === 'string' ? unit : unit.id);

const EFFORTS = ['low', 'medium', 'high'];
const samePacks = (a, b) => {
  const ka = Object.keys(a || {});
  return ka.length === Object.keys(b || {}).length && ka.every((k) => a[k] === b[k]);
};
const sortedUnique = (list) => [...new Set(list)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

// classes (optional): the class ids this run hunted on the units. A covered unit that was already covered against the same pack
// versions keeps the classes earlier runs hunted too, so a low run after a high one does not forget the rest; except a unit listed
// in `changed` (ids whose hunt-worthy files changed since the run that stamped the earlier entry): what earlier runs hunted was
// other code, so only this run's classes count. effort (optional) is the effort of this run.
// engine and complete (optional): the hunt engine that covered the units and whether that hunt was complete (hunt-plan.cjs reads
// both before it skips a unit as unchanged).
function markCovered(ledger, { system, layer, units, runId, packs, status = 'covered', classes, effort, changed = [], engine, complete }) {
  if (!STATUSES.includes(status)) throw new RangeError(`status must be one of ${STATUSES.join(', ')}`);
  if (classes !== undefined && (!Array.isArray(classes) || classes.some((c) => typeof c !== 'string' || c === ''))) throw new TypeError('classes must be an array of class ids');
  if (effort !== undefined && !EFFORTS.includes(effort)) throw new RangeError(`effort must be one of ${EFFORTS.join(', ')}`);
  const next = { ...ledger, units: { ...ledger.units } };
  for (const unit of units) {
    const key = keyOf(system, layer, idOf(unit));
    const entry = { system, layer, lastRun: runId, packVersions: { ...packs }, status };
    if (classes !== undefined) {
      const prev = ledger.units[key];
      const keep = status === 'covered' && prev && prev.status === 'covered' && Array.isArray(prev.classes) && samePacks(prev.packVersions, packs)
        && !changed.includes(idOf(unit));
      entry.classes = sortedUnique([...(keep ? prev.classes : []), ...classes]);
    }
    if (effort !== undefined) entry.effort = effort;
    if (typeof engine === 'string' && engine) entry.engine = engine;
    if (typeof complete === 'boolean') entry.complete = complete;
    next.units[key] = entry;
  }
  return next;
}

// classes (optional): every class id of the layer's packs. When given, a covered unit is still a gap until each of them was hunted
// on it (returned with missingClasses: the ones not yet hunted); an entry that records no classes counts as none hunted.
function gaps(ledger, { system, layer, units, packs, classes }) {
  const out = [];
  for (const unit of units) {
    const entry = ledger.units[keyOf(system, layer, idOf(unit))];
    if (!entry || entry.status === 'failed' || Object.entries(packs || {}).some(([name, version]) => entry.packVersions[name] !== version)) {
      out.push(unit);
      continue;
    }
    if (!Array.isArray(classes)) continue;
    const hunted = new Set(Array.isArray(entry.classes) ? entry.classes : []);
    const missing = sortedUnique(classes.filter((c) => !hunted.has(c)));
    if (missing.length) out.push(typeof unit === 'string' ? { id: unit, missingClasses: missing } : { ...unit, missingClasses: missing });
  }
  return out;
}

// Every class id of the system's packs for the layer (none for L1, which has no hunt classes).
function classIdsFor(system, layer) {
  if (layer === 'L1') return undefined;
  const kind = layer === 'INFRA' ? 'host' : 'code';
  return sortedUnique(packsFor(system).filter((p) => (p.kinds || []).includes(kind)).flatMap((p) => (p.classes || []).map((c) => c.id)));
}

// ---- the command line ---------------------------------------------------------------------

const USAGE = 'usage: node scripts/coverage.cjs units|gaps|show --project <slug> --system <id> [--repo <path>] [--layer L1|L2|L3|INFRA] [--reachable] [--json]';

class UsageError extends Error {}

function parse(argv) {
  const [command, ...rest] = argv;
  if (!['units', 'gaps', 'show'].includes(command)) throw new UsageError(command === undefined ? 'a command is required' : `unknown command: ${command}`);
  let values;
  try {
    ({ values } = util.parseArgs({
      args: rest,
      options: { project: { type: 'string' }, system: { type: 'string' }, repo: { type: 'string' }, layer: { type: 'string' }, reachable: { type: 'boolean' }, json: { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new UsageError(err.message.split('\n')[0]);
  }
  for (const name of ['project', 'system']) if (values[name] === undefined) throw new UsageError(`--${name} is required`);
  const layer = values.layer === undefined ? 'L2' : values.layer;
  if (!LAYERS.includes(layer)) throw new UsageError(`--layer must be one of ${LAYERS.join(', ')}`);
  return { command, ...values, layer };
}

// The units of the system for the layer: probes of the host packs for INFRA, else the repo directories.
function unitsFor(ctx, opts) {
  if (opts.layer === 'INFRA') return packsFor(ctx.system).flatMap((pack) => unitsForHost(ctx.system, pack));
  // Only units a hunt would plan: a directory with no hunt-worthy file is never a gap.
  return huntUnitsForRepo(resolveRepo(ctx, opts.repo)).map(({ paths, sizes, present, oversize, ...u }) => u);
}

function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const opts = parse(argv);
    const ctx = resolveSystem(opts.project, opts.system);
    const ledger = store.readCoverage(opts.project);
    let result;
    if (opts.command === 'show') {
      const mine = Object.entries(ledger.units).filter(([, e]) => e.system === opts.system && e.layer === opts.layer);
      result = { project: ledger.project, units: Object.fromEntries(mine) };
    } else {
      const units = unitsFor(ctx, opts);
      const packs = packVersionsFor(ctx.system, opts.layer);
      result = opts.command === 'units' ? units : gaps(ledger, { system: opts.system, layer: opts.layer, units, packs, classes: classIdsFor(ctx.system, opts.layer) });
      if (opts.reachable) result = result.filter((u) => u.reachable);
    }
    stdout.write(`${opts.json ? JSON.stringify(result, null, 2) : render(opts.command, result)}\n`);
    return 0;
  } catch (err) {
    stderr.write(`coverage: ${redact(err.message)}\n`);
    if (err instanceof UsageError) stderr.write(`${USAGE}\n`);
    return err instanceof UsageError || err instanceof RangeError ? 2 : 1;
  }
}

function render(command, result) {
  if (command === 'show') {
    const rows = Object.entries(result.units).map(([key, e]) => `${key}  ${e.status}  run ${e.lastRun}`);
    return rows.length ? rows.join('\n') : 'no coverage recorded';
  }
  if (result.length === 0) return command === 'gaps' ? 'no gaps' : 'no units';
  return result.map((u) => `${u.id}${u.kind === 'dir' ? `  ${u.files} file${u.files === 1 ? '' : 's'}` : ''}${u.reachable ? '' : '  (background)'}${u.missingClasses ? `  (not yet hunted: ${u.missingClasses.join(', ')})` : ''}`).join('\n');
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  unitOf, unitContains, packVersionsFor, classIdsFor, isIgnored, isReachable, unitsForRepo, unitsForHost, markCovered, gaps, main, DEFAULT_IGNORE,
  classifyFile, isHuntWorthy, listRepoFiles, scanFiles, unitsFromFiles, huntScope, huntUnitsForRepo, EXCLUDED_EXTENSIONS, EXCLUDED_NAMES, LOCKFILES,
  NON_SOURCE_DIRS, TRANSLATION_DIRS, MAX_HUNT_FILE_BYTES, MAX_HUNT_JSON_BYTES,
};
