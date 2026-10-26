'use strict';
// Import a claude-security report into the store.
//   node scripts/import-claude-security.cjs --project <slug> --system <id> --layer <L2|L3> [--dir <path>] [--json]
// Reads the newest <dir>/CLAUDE-SECURITY-<timestamp>/CLAUDE-SECURITY-RESULTS.jsonl (dir defaults to the current directory;
// a dir that holds the JSONL itself works too) and nothing else from the report directory.
// Exit 0: done. Exit 2: bad arguments, a project that is not attested, or no report found. Exit 1: anything unexpected.
//
// Each record becomes a finding (source claude-security, class verified). Spec 5.4 merge rule: an existing finding of the
// system with the same first CWE id and the same normalizeLocation (path:symbol) keeps its id and gets the external id and the
// higher verification count; its own text and severity are left as they are. Otherwise a finding is added. A record whose
// external id is already on a finding folds into that finding, so a re-import changes nothing.
// Only the title and recommendation (redacted), severity, confidence, CWE ids, file, symbol and line are read from a record.
// The snippet, description, impact, exploit scenario and preconditions are never read into anything, stored or printed.
// A malformed line or an unusable record is skipped with a reason that never quotes the record.

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const store = require('./store.cjs');
const common = require('./lib/l1-common.cjs');
const { findingId, normalizeLocation } = require('./lib/id.cjs');
const { redact } = require('./lib/redact.cjs');

const REPORT_DIR_RE = /^CLAUDE-SECURITY-[0-9-]+$/;
const RESULTS_NAME = 'CLAUDE-SECURITY-RESULTS.jsonl';
const LAYERS = ['L2', 'L3'];
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'];
const RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const CWE_RE = /^CWE-\d+$/;
const MAX_TITLE = 200;
const MAX_TEXT = 2000;
const MAX_REASONS_PRINTED = 10;
// claude-security keeps a finding only when 2 of its 3 verifiers confirm it.
const PANEL = { verifiers: 3, confirmed: 2 };
const EVIDENCE = 'Imported from a claude-security report; the report holds the details.';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const cap = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---- finding the report -------------------------------------------------------------------

const isFile = (file) => {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
};

// The JSONL of the lexically greatest CLAUDE-SECURITY-<timestamp> directory under dir that has one, else dir's own JSONL.
function findResults(dir) {
  const root = path.resolve(dir);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    throw new RangeError(`report directory cannot be read: ${root}`);
  }
  const names = entries.filter((e) => e.isDirectory() && REPORT_DIR_RE.test(e.name)).map((e) => e.name).sort().reverse();
  for (const name of names) {
    const file = path.join(root, name, RESULTS_NAME);
    if (isFile(file)) return file;
  }
  const direct = path.join(root, RESULTS_NAME);
  if (isFile(direct)) return direct;
  throw new RangeError(`no CLAUDE-SECURITY-*/${RESULTS_NAME} found under ${root}`);
}

// ---- one record ---------------------------------------------------------------------------

// A repo-relative path with no absolute prefix and no .. segment, or null.
function safePath(file) {
  const p = text(file).replace(/\\/g, '/');
  if (p === '' || p.includes('\0') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  return p.split('/').includes('..') ? null : p;
}

// {finding} or {reason}. Reads only the fields it keeps.
function toFinding(rec, { project, system, layer, runId }) {
  if (!isObject(rec)) return { reason: 'not a JSON object' };
  const file = safePath(rec.file);
  if (file === null) return { reason: 'missing or unsafe file path' };
  const externalId = text(rec.claudeSecurityPluginFindingId) || text(rec.id);
  if (externalId === '') return { reason: 'no finding id' };
  const title = cap(redact(text(rec.title)), MAX_TITLE);
  if (title === '') return { reason: 'missing title' };
  const severity = text(rec.severity).toUpperCase();
  if (!SEVERITIES.includes(severity)) return { reason: 'unknown severity' };
  const confidence = text(rec.confidence).toUpperCase();
  if (!CONFIDENCES.includes(confidence)) return { reason: 'unknown confidence' };

  const firstCwe = CWE_RE.test(text(rec.cwe_id)) ? text(rec.cwe_id) : null;
  const others = Array.isArray(rec.other_cwe_ids) ? rec.other_cwe_ids.map(text).filter((c) => CWE_RE.test(c)) : [];
  const cwe = [...new Set([...(firstCwe ? [firstCwe] : []), ...others])];
  const location = { path: file, symbol: text(rec.symbol) || null };
  if (Number.isInteger(rec.line) && rec.line > 0) location.line = rec.line;
  const category = text(rec.category).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // The CWE id is the steadier rule name: a category is free text the plugin may reword.
  const ruleId = `claude-security/${firstCwe || category || 'unknown'}`;
  const recommendation = cap(redact(text(rec.recommendation)), MAX_TEXT);
  const stamp = new Date().toISOString();

  const finding = {
    id: findingId({ project, system, ruleId, location }),
    project,
    system,
    layer,
    source: 'claude-security',
    pack: null,
    ruleId,
    title,
    severity,
    confidence,
    cwe,
    class: 'verified',
    location,
    evidence: EVIDENCE,
    verification: { ...PANEL, run: runId },
    status: 'open',
    firstSeen: stamp,
    lastSeen: stamp,
    fixedIn: null,
    externalIds: { claudeSecurityPluginFindingId: externalId, cve: null },
  };
  if (recommendation !== '') finding.recommendation = recommendation;
  return { finding, firstCwe, externalId };
}

// ---- merge --------------------------------------------------------------------------------

const locationKey = (f) => {
  try {
    return normalizeLocation(f.location);
  } catch {
    return null;
  }
};

// The existing finding a record folds into: the one that already carries its external id, else (spec 5.4) the first of the
// system with the same first CWE id and the same path:symbol. Undefined when there is none.
function findExisting(existing, { finding, firstCwe, externalId }) {
  const sameSystem = existing.filter((f) => f.system === finding.system);
  const byExternal = sameSystem.find((f) => f.externalIds && f.externalIds.claudeSecurityPluginFindingId === externalId);
  if (byExternal) return byExternal;
  if (firstCwe === null) return undefined;
  const key = locationKey(finding);
  return sameSystem.find((f) => Array.isArray(f.cwe) && f.cwe[0] === firstCwe && locationKey(f) === key);
}

// The existing finding with the external id added and the higher verification count; everything else as it was.
function mergedInto(current, incoming) {
  const keep = current.verification && current.verification.confirmed >= incoming.verification.confirmed;
  return {
    ...current,
    verification: keep ? current.verification : incoming.verification,
    externalIds: { ...(current.externalIds || { cve: null }), claudeSecurityPluginFindingId: incoming.externalIds.claudeSecurityPluginFindingId },
  };
}

// True when a is the stronger of two records for one finding: higher severity, then higher confidence.
const stronger = (a, b) => RANK[a.severity] > RANK[b.severity] || (a.severity === b.severity && RANK[a.confidence] > RANK[b.confidence]);

// ---- import -------------------------------------------------------------------------------

// Import the newest report under dir (default: the current directory) into one system of a project and record the run.
// Returns {run, counts, skipped, file}: counts is {imported, merged, added, skippedRecords, updated, unchanged, regressed} where
// merged is the records that folded into a finding already in the store and added the ones that made a new finding;
// skipped is [{line, reason}]. Throws RangeError for a project that is missing or has no owner attestation, a system that is
// missing, a layer other than L2 or L3, or a report that cannot be found (no run is created).
function importClaudeSecurity({ project, system, layer, dir = process.cwd() } = {}) {
  if (!LAYERS.includes(layer)) throw new RangeError('layer must be L2 or L3');
  const { project: proj } = common.resolveSystem(project, system);
  if (!isObject(proj.ownerAttestation) || !text(proj.ownerAttestation.statement)) {
    throw new RangeError(`project ${project} has no ownerAttestation; add the owner statement before importing`);
  }
  const file = findResults(dir);
  const raw = fs.readFileSync(file, 'utf8');

  const run = store.createRun(project, { job: 'import', layers: [layer], systems: [system], executor: 'local' });
  try {
    const skipped = [];
    const mapped = [];
    raw.replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
      if (line.trim() === '') return;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        skipped.push({ line: i + 1, reason: 'malformed JSON line' });
        return;
      }
      const result = toFinding(rec, { project, system, layer, runId: run.runId });
      if (result.reason) skipped.push({ line: i + 1, reason: result.reason });
      else mapped.push(result);
    });

    const existing = store.readFindings(project);
    // One entry per finding id: records of one report that resolve to the same finding count once, the stronger kept.
    const targets = new Map();
    let duplicates = 0;
    for (const m of mapped) {
      const current = findExisting(existing, m);
      const id = current ? current.id : m.finding.id;
      const prior = targets.get(id);
      if (!prior) {
        targets.set(id, { current, m });
        continue;
      }
      duplicates++;
      if (stronger(m.finding, prior.m.finding)) targets.set(id, { current, m });
    }
    let merged = 0;
    let added = 0;
    let annotated = { updated: 0, unchanged: 0 };
    const toUpsert = [];
    for (const { current, m } of targets.values()) {
      if (!current) {
        added++;
        toUpsert.push(m.finding);
        continue;
      }
      merged++;
      const next = mergedInto(current, m.finding);
      // An import never changes a status: only open and regressed findings go through the upsert; a fixed or triaged one
      // just gets the external id and the verification recorded, with status, disposition and lastSeen left alone.
      if (current.status === 'open' || current.status === 'regressed') toUpsert.push(next);
      else if (store.annotateFinding(project, current.id, { externalIds: next.externalIds, verification: next.verification })) annotated.updated++;
      else annotated.unchanged++;
    }
    const upsert = store.upsertFindings(project, toUpsert, run.runId);
    upsert.updated += annotated.updated;
    upsert.unchanged += annotated.unchanged;
    const counts = { imported: mapped.length, merged, added, duplicates, skippedRecords: skipped.length, ...upsert };
    const runCounts = { ...upsert, hardening: 0 };
    return {
      run: store.finishRun(project, run.runId, { status: 'done', counts: runCounts, tool: { name: 'claude-security' } }),
      counts,
      skipped,
      file,
    };
  } catch (err) {
    common.markFailed(run, err);
    throw err;
  }
}

// ---- CLI ----------------------------------------------------------------------------------

const USAGE = 'usage: node scripts/import-claude-security.cjs --project <slug> --system <id> --layer <L2|L3> [--dir <path>] [--json]';

function parse(argv) {
  let values;
  try {
    ({ values } = util.parseArgs({
      args: argv,
      options: { project: { type: 'string' }, system: { type: 'string' }, layer: { type: 'string' }, dir: { type: 'string' }, json: { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new common.UsageError(err.message.split('\n')[0]);
  }
  for (const name of ['project', 'system', 'layer']) if (values[name] === undefined) throw new common.UsageError(`--${name} is required`);
  if (!LAYERS.includes(values.layer)) throw new common.UsageError('--layer must be L2 or L3');
  return values;
}

function details({ counts, skipped }) {
  const lines = [
    `import: ${counts.added} added, ${counts.merged} merged (${counts.imported} records), ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.regressed} regressed`,
  ];
  if (skipped.length) {
    lines.push(`skipped ${skipped.length} record(s):`);
    for (const s of skipped.slice(0, MAX_REASONS_PRINTED)) lines.push(`  line ${s.line}: ${s.reason}`);
    if (skipped.length > MAX_REASONS_PRINTED) lines.push(`  ... and ${skipped.length - MAX_REASONS_PRINTED} more`);
  }
  return lines;
}

if (require.main === module) {
  process.exitCode = common.runCli({
    name: 'import-claude-security',
    usage: USAGE,
    details,
    parse,
    json: (r) => ({ run: r.run, counts: r.counts, skipped: r.skipped }),
    scan: (o) => importClaudeSecurity({ project: o.project, system: o.system, layer: o.layer, dir: o.dir }),
  }, process.argv.slice(2));
}

module.exports = { importClaudeSecurity, findResults };
