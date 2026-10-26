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
//   unitsForHost(system, pack)           one {id: 'probe:<probeId>', kind: 'probe', reachable: true} per pack probe.
//   markCovered(ledger, {...})           the ledger with the given units stamped (pure; the input is not changed), with the
//                                        class ids hunted (`classes`) and the run's `effort` when given.
//   gaps(ledger, {...})                  the units that still need a hunt: never covered, status failed, covered against an
//                                        older or different version of any pack in `packs`, or (given `classes`, every class
//                                        of the layer) covered without every class hunted, with `missingClasses`.
//   classIdsFor(system, layer)           every class id of the layer's packs (undefined for L1): the `classes` for gaps.
// CLI: node scripts/coverage.cjs units|gaps|show --project <slug> --system <id> [--repo <path>] [--layer L1|L2|L3|INFRA] [--reachable] [--json]
//   --reachable keeps only reachable units (the background ones - docs, scripts, tests - are listed with reachable false otherwise).
// (--layer defaults to L2). Exit 0 ok, 2 for a usage error or a project, system or repo that does not resolve, 1 for anything else.

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const store = require('./store.cjs');
const { packsFor } = require('./packs.cjs');
const { resolveSystem, resolveRepo } = require('./lib/l1-common.cjs');
const { redact } = require('./lib/redact.cjs');

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
// versions keeps the classes earlier runs hunted too, so a low run after a high one does not forget the rest. effort (optional)
// is the effort of this run.
function markCovered(ledger, { system, layer, units, runId, packs, status = 'covered', classes, effort }) {
  if (!STATUSES.includes(status)) throw new RangeError(`status must be one of ${STATUSES.join(', ')}`);
  if (classes !== undefined && (!Array.isArray(classes) || classes.some((c) => typeof c !== 'string' || c === ''))) throw new TypeError('classes must be an array of class ids');
  if (effort !== undefined && !EFFORTS.includes(effort)) throw new RangeError(`effort must be one of ${EFFORTS.join(', ')}`);
  const next = { ...ledger, units: { ...ledger.units } };
  for (const unit of units) {
    const key = keyOf(system, layer, idOf(unit));
    const entry = { system, layer, lastRun: runId, packVersions: { ...packs }, status };
    if (classes !== undefined) {
      const prev = ledger.units[key];
      const keep = status === 'covered' && prev && prev.status === 'covered' && Array.isArray(prev.classes) && samePacks(prev.packVersions, packs);
      entry.classes = sortedUnique([...(keep ? prev.classes : []), ...classes]);
    }
    if (effort !== undefined) entry.effort = effort;
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
  return unitsForRepo(resolveRepo(ctx, opts.repo));
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

module.exports = { unitOf, unitContains, packVersionsFor, classIdsFor, isIgnored, isReachable, unitsForRepo, unitsForHost, markCovered, gaps, main, DEFAULT_IGNORE };
