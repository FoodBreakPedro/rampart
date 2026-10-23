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
//   unitsForRepo(repoPath, opts)         [{id, kind: 'dir', files, reachable}] sorted by id; ignored paths produce no units.
//                                        reachable is false for tests|test|__tests__|fixtures|docs|scripts roots (background only).
//   unitsForHost(system, pack)           one {id: 'probe:<probeId>', kind: 'probe', reachable: true} per pack probe.
//   markCovered(ledger, {...})           the ledger with the given units stamped (pure; the input is not changed).
//   gaps(ledger, {...})                  the units that still need a hunt: never covered, status failed, or covered against an
//                                        older or different version of any pack in `packs`.
// CLI: node scripts/coverage.cjs units|gaps|show --project <slug> --system <id> [--repo <path>] [--layer L1|L2|L3|INFRA] [--json]
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

// ---- units --------------------------------------------------------------------------------

function unitsForRepo(repoPath, { maxDepth = DEFAULT_MAX_DEPTH, ignore = DEFAULT_IGNORE } = {}) {
  const counts = new Map();
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(repoPath, rel), { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (isIgnored(next, ignore)) continue;
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) {
        const id = unitOf(next, maxDepth);
        counts.set(id, (counts.get(id) || 0) + 1);
      }
    }
  };
  walk('');
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, files]) => ({ id, kind: 'dir', files, reachable: !BACKGROUND_ROOTS.has(id.split('/')[0]) }));
}

function unitsForHost(system, pack) {
  return ((pack && pack.probes) || []).map((p) => ({ id: `probe:${p.id}`, kind: 'probe', reachable: true }));
}

// ---- ledger -------------------------------------------------------------------------------

const keyOf = (system, layer, unitId) => `${system}|${layer}|${unitId}`;
const idOf = (unit) => (typeof unit === 'string' ? unit : unit.id);

function markCovered(ledger, { system, layer, units, runId, packs, status = 'covered' }) {
  if (!STATUSES.includes(status)) throw new RangeError(`status must be one of ${STATUSES.join(', ')}`);
  const next = { ...ledger, units: { ...ledger.units } };
  for (const unit of units) {
    next.units[keyOf(system, layer, idOf(unit))] = { system, layer, lastRun: runId, packVersions: { ...packs }, status };
  }
  return next;
}

function gaps(ledger, { system, layer, units, packs }) {
  return units.filter((unit) => {
    const entry = ledger.units[keyOf(system, layer, idOf(unit))];
    if (!entry || entry.status === 'failed') return true;
    return Object.entries(packs || {}).some(([name, version]) => entry.packVersions[name] !== version);
  });
}

// ---- the command line ---------------------------------------------------------------------

const USAGE = 'usage: node scripts/coverage.cjs units|gaps|show --project <slug> --system <id> [--repo <path>] [--layer L1|L2|L3|INFRA] [--json]';

class UsageError extends Error {}

function parse(argv) {
  const [command, ...rest] = argv;
  if (!['units', 'gaps', 'show'].includes(command)) throw new UsageError(command === undefined ? 'a command is required' : `unknown command: ${command}`);
  let values;
  try {
    ({ values } = util.parseArgs({
      args: rest,
      options: { project: { type: 'string' }, system: { type: 'string' }, repo: { type: 'string' }, layer: { type: 'string' }, json: { type: 'boolean' } },
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
      const packs = Object.fromEntries(packsFor(ctx.system).map((p) => [p.name, p.version]));
      result = opts.command === 'units' ? units : gaps(ledger, { system: opts.system, layer: opts.layer, units, packs });
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
  return result.map((u) => `${u.id}${u.kind === 'dir' ? `  ${u.files} file${u.files === 1 ? '' : 's'}` : ''}${u.reachable ? '' : '  (background)'}`).join('\n');
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { unitOf, isIgnored, unitsForRepo, unitsForHost, markCovered, gaps, main, DEFAULT_IGNORE };
