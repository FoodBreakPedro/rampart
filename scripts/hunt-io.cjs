'use strict';
// The hub of the hunt engine: what hunter and verifier agents write into a run directory, and what becomes of it.
//
//   <RAMPART_HOME>/projects/<slug>/runs/<runId>/
//     units.json                          written by init, status per unit added by assemble
//     candidates/<hunterKey>.json         a JSON array written by one hunter ([] = nothing found)
//     votes/<hunterKey>__<ref>__<n>.json  one JSON object written by one verifier
//     observations.json                   INFRA only, written by the probe runner
//
// Agents write a raw form; ingest rewrites every file in place in its stored form (candidate-schema.json, vote-schema.json):
// scope fields (system, layer, pack, hunter, candidateId) come from units.json and never from the agent, text fields pass through
// redact(), and evidence that still looks like a value (a credential, a JWT, a long high-entropy token) is replaced whole.
// A hunter returned when its candidates file exists and parses to an array; a unit is covered only when every hunter planned for it
// returned, so an agent that died leaves its unit failed in coverage.json and under the run's skips, never silently clean.
//
//   fileKey(id)  hunterKey(...)          names that are safe in a file name
//   writeCandidate / writeVote           normalize one agent file (tests, and agents' files being normalized)
//   ingest(slug, runId)                  normalize all of them: {candidates, votes, invalid: [{file, reason}]}
//   readCandidates / readVotes           stored forms (ingest first)
//   tally(candidates, votes)             {verified, rejected, undecided}, each [{candidate, votes}]: the verification bar
//   initRun(slug, opts)                  plan a run; assemble(slug, runId): tally, upsert, close, cover, finish
//   initVerify / reverify               a verify run: one verifier per stored finding, then apply the votes (see below)
// CLI: node scripts/hunt-io.cjs init|assemble|list|init-verify|reverify ... (see USAGE); init --dry-run prints the cost per effort
// and creates nothing. Exit 0 ok, 2 usage error or a gate that did not pass, 1 other.

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const store = require('./store.cjs');
const coverage = require('./coverage.cjs');
const { packsFor, PACKS_DIR } = require('./packs.cjs');
const { diffScope } = require('./diff-scope.cjs');
const { fromHunt, INJECTION_RULE } = require('./normalize.cjs');
const { resolveSystem, resolveRepo } = require('./lib/l1-common.cjs');
const { findingId } = require('./lib/id.cjs');
const { redact, REDACTED } = require('./lib/redact.cjs');
const { validate, loadSchema } = require('./lib/validate.cjs');
const { writeAtomic } = require('./lib/atomic.cjs');
const { runDir } = require('./lib/paths.cjs');
const { run: runCmd } = require('./lib/exec.cjs');

const LOW_CLASSES = Object.freeze(['authz-scoping', 'tenant-isolation', 'bulk-export', 'session-handling', 'search-injection']);
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'];
const RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const SLUG_RE = /^[a-z0-9-]{2,40}$/;
const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;
const REF_RE = /^c([1-9]|10)$/;
const VOTE_FILE_RE = /^(.+)__(c(?:[1-9]|10))__([1-9][0-9]*)\.json$/;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
const TOKEN_RE = /[A-Za-z0-9+=_-]{20,}/g; // no '/' or '.': paths and dotted identifiers are not tokens
const MIN_ENTROPY = 3.5; // bits per character
const EVIDENCE_REPLACED = `${REDACTED} (value-like text removed by rampart)`;
const INJECTION_RE = /\b(ignore (all|any|previous|prior)|disregard (the|all|previous)|you are (now )?(an?|the) |as an ai|system prompt|mark (this|it) as (safe|clean|fixed)|do not (report|flag)|report (no|nothing)|this (file|code) is (safe|secure))/i;
const MAX_TITLE = 200;
const MAX_TEXT = 2000;
const GIT_TIMEOUT_MS = 60000;
// A rough average for one hunter or verifier run, for the cost shown before an audit (an estimate, not a budget).
const TOKENS_PER_AGENT = 50000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v !== '';
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const fileKey = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, '+');
const hunterKey = (unit, classId) => `${fileKey(unit)}__${classId}`;
const infraKey = (system) => `${fileKey(system)}__infra-prober`;

// ---- run directory ------------------------------------------------------------------------

function dirOf(slug, runId) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw new RangeError('slug must be 2 to 40 characters of a-z, 0-9 and "-"');
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) throw new RangeError('runId must look like 2026-10-23T18-02-11Z');
  return runDir(slug, runId);
}

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
};

const readJsonFile = (file) => {
  const text = readText(file);
  if (text === null) return { missing: true };
  try {
    return { value: JSON.parse(text), text };
  } catch {
    return { bad: true, text };
  }
};

const toJson = (v) => `${JSON.stringify(v, null, 2)}\n`;

function readUnits(slug, runId) {
  const r = readJsonFile(path.join(dirOf(slug, runId), 'units.json'));
  if (r.missing || r.bad || !isObject(r.value)) throw new RangeError(`run ${runId} has no readable units.json (run hunt-io init first)`);
  return r.value;
}

function ensureRunDirs(slug, runId) {
  const dir = dirOf(slug, runId);
  fs.mkdirSync(path.join(dir, 'candidates'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'votes'), { recursive: true });
  return dir;
}

const jsonFiles = (dir) => {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(byString);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
};

// ---- redaction ----------------------------------------------------------------------------

function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

// A value-like token: 20+ token characters with at least two digits and a letter and entropy of 3.5 bits per character or more.
const isSecretToken = (t) => (t.match(/[0-9]/g) || []).length >= 2 && /[A-Za-z]/.test(t) && entropy(t) >= MIN_ENTROPY;
const hasSecretToken = (s) => (s.match(TOKEN_RE) || []).some(isSecretToken);
const maskTokens = (s) => s.replace(TOKEN_RE, (t) => (isSecretToken(t) ? REDACTED : t));
const cut = (s, max) => (s.length > max ? `${s.slice(0, max)}...` : s);

// Free text: redact(), then any high-entropy token goes inline.
function cleanText(value, max = MAX_TEXT) {
  const out = maskTokens(redact(typeof value === 'string' ? value : ''));
  return cut(out, max);
}

// Evidence: anything value-like replaces the whole field. What a model quotes next to a secret is not worth the risk.
function cleanEvidence(value) {
  const raw = typeof value === 'string' ? value : '';
  if (redact(raw) !== raw || JWT_RE.test(raw) || hasSecretToken(raw)) return EVIDENCE_REPLACED;
  return cut(raw, MAX_TEXT);
}

// An agent file ingest cannot use is overwritten, so what the agent wrote (possibly a credential) does not stay in the run directory.
// The reason is always computed by the code, never read from the file: a stub an agent wrote itself is just more invalid content.
function stub(file, reason) {
  const text = toJson({ invalid: reason });
  if (readText(file) !== text) writeAtomic(file, text);
}

// ---- candidates ---------------------------------------------------------------------------

// A repo-relative POSIX path, or null: no leading slash, drive letter, UNC prefix or ".." segment, nothing redact() would change.
function cleanPath(p) {
  if (typeof p !== 'string' || p === '' || p.length > 300 || p.includes('\0')) return null;
  const posix = p.replace(/\\/g, '/');
  if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix)) return null;
  const segments = posix.split('/');
  if (segments.includes('..')) return null;
  const joined = segments.filter((s) => s !== '' && s !== '.').join('/');
  if (joined === '' || redact(joined) !== joined) return null;
  return maskTokens(joined);
}

function cleanLocation(raw, infra) {
  if (!isObject(raw)) return null;
  const optional = (v) => (typeof v === 'string' && v !== '' ? cleanText(v, 200) : undefined);
  if (infra) {
    if (!isText(raw.host)) return null;
    const out = { host: cleanText(raw.host, 200) };
    const service = optional(raw.service);
    const setting = optional(raw.setting);
    if (service !== undefined) out.service = service;
    if (setting !== undefined) out.setting = setting;
    return out;
  }
  const p = cleanPath(raw.path);
  if (p === null) return null;
  return { path: p, symbol: optional(raw.symbol) ?? null };
}

// A raw (or already stored) candidate to its stored form: {candidate} or {reason}.
function normalizeCandidate(raw, hunter, doc, slug) {
  if (!isObject(raw)) return { reason: 'candidate is not an object' };
  if (typeof raw.ref !== 'string' || !REF_RE.test(raw.ref)) return { reason: 'ref must be c1 to c10' };
  const infra = doc.layer === 'INFRA';
  let { classId, pack, packVersion } = hunter;
  if (infra) {
    const named = (doc.classes || []).filter((c) => c.classId === raw.classId);
    const cls = named.find((c) => c.pack === raw.pack) || named[0];
    if (!cls) return { reason: `${raw.ref}: classId is not a class of this run` };
    ({ classId, pack, packVersion } = cls);
  }
  if (!SEVERITIES.includes(raw.severity)) return { reason: `${raw.ref}: severity must be one of ${SEVERITIES.join(', ')}` };
  if (!CONFIDENCES.includes(raw.confidence)) return { reason: `${raw.ref}: confidence must be one of ${CONFIDENCES.join(', ')}` };
  if (!isText(raw.title)) return { reason: `${raw.ref}: title is required` };
  const location = cleanLocation(raw.location, infra);
  if (location === null) return { reason: `${raw.ref}: location is missing or not a repo-relative path` };
  const injection =
    (isObject(raw.flags) && raw.flags.prompt_injection === true) || INJECTION_RE.test(raw.title) || INJECTION_RE.test(typeof raw.evidence === 'string' ? raw.evidence : '');
  const ruleId = injection ? INJECTION_RULE : `${pack}/${classId}`;
  const candidate = {
    candidateId: findingId({ project: slug, system: doc.system, ruleId, location }),
    ref: raw.ref,
    system: doc.system,
    layer: doc.layer,
    pack,
    packVersion,
    classId,
    title: cleanText(raw.title, MAX_TITLE),
    severity: raw.severity,
    confidence: raw.confidence,
    cwe: (Array.isArray(raw.cwe) ? raw.cwe : []).filter((c) => typeof c === 'string' && /^CWE-\d+$/.test(c)),
    location,
    evidence: cleanEvidence(raw.evidence),
    exploitScenario: cleanText(raw.exploitScenario),
    preconditions: cleanText(raw.preconditions),
    recommendation: cleanText(raw.recommendation),
    hunter: { agent: hunter.key, unit: hunter.unit ?? null },
    flags: injection ? { prompt_injection: true } : {},
  };
  const { ok, errors } = validate(loadSchema('candidate'), candidate);
  return ok ? { candidate } : { reason: `${raw.ref}: ${errors[0]}` };
}

// Every candidates file, normalized and rewritten in place when it changed. A file that does not parse (or is not an array) is not
// rewritten, except that its text passes through redact(): it stays unreturned but holds no credential.
function ingestCandidates(slug, runId, doc) {
  const dir = path.join(dirOf(slug, runId), 'candidates');
  const stored = [];
  const invalid = [];
  for (const name of jsonFiles(dir)) {
    const key = name.slice(0, -5);
    const file = path.join(dir, name);
    const hunter = (doc.hunters || []).find((h) => h.key === key);
    const r = readJsonFile(file);
    const reason = !hunter ? 'no hunter with this key was planned' : r.bad ? 'not valid JSON' : !Array.isArray(r.value) ? 'not a JSON array' : null;
    if (reason !== null) {
      invalid.push({ file: `candidates/${name}`, reason, whole: true });
      stub(file, reason);
      continue;
    }
    const seen = new Set();
    const mine = [];
    for (const item of r.value) {
      const n = normalizeCandidate(item, hunter, doc, slug);
      if (n.candidate && seen.has(n.candidate.ref)) invalid.push({ file: `candidates/${name}`, key, reason: `${n.candidate.ref}: duplicate ref` });
      else if (n.candidate) {
        seen.add(n.candidate.ref);
        mine.push(n.candidate);
      } else invalid.push({ file: `candidates/${name}`, key, reason: n.reason });
    }
    if (toJson(mine) !== r.text) writeAtomic(file, toJson(mine));
    stored.push(...mine);
  }
  return { candidates: stored, invalid };
}

// ---- votes --------------------------------------------------------------------------------

function normalizeVote(raw, name, candidates) {
  const m = VOTE_FILE_RE.exec(name);
  if (!m) return { reason: 'file name must be <hunterKey>__<ref>__<n>.json' };
  const [, key, ref, n] = m;
  const candidateRef = `${key}#${ref}`;
  if (!isObject(raw)) return { reason: 'vote is not an object' };
  if (raw.candidateRef !== undefined && raw.candidateRef !== candidateRef) return { reason: 'candidateRef does not match the file name' };
  const candidate = candidates.find((c) => c.hunter.agent === key && c.ref === ref);
  if (!candidate) return { reason: `no candidate ${candidateRef}` };
  if (!['confirmed', 'rejected', 'unsure'].includes(raw.verdict)) return { reason: 'verdict must be confirmed, rejected or unsure' };
  const vote = { candidateId: candidate.candidateId, verifier: `verify:${candidateRef}:${n}`, verdict: raw.verdict };
  if (SEVERITIES.includes(raw.severity)) vote.severity = raw.severity;
  if (CONFIDENCES.includes(raw.confidence)) vote.confidence = raw.confidence;
  vote.reason = cleanText(raw.reason);
  const { ok, errors } = validate(loadSchema('vote'), vote);
  return ok ? { vote } : { reason: errors[0] };
}

function ingestVotes(slug, runId, candidates) {
  const dir = path.join(dirOf(slug, runId), 'votes');
  const votes = [];
  const invalid = [];
  for (const name of jsonFiles(dir)) {
    const file = path.join(dir, name);
    const r = readJsonFile(file);
    const n = r.bad ? { reason: 'not valid JSON' } : normalizeVote(r.value, name, candidates);
    if (!n.vote) {
      const reason = n.reason;
      invalid.push({ file: `votes/${name}`, reason, whole: true });
      stub(file, reason);
      continue;
    }
    if (toJson(n.vote) !== r.text) writeAtomic(file, toJson(n.vote));
    votes.push(n.vote);
  }
  return { votes, invalid };
}

function ingest(slug, runId) {
  const doc = readUnits(slug, runId);
  const c = ingestCandidates(slug, runId, doc);
  const v = ingestVotes(slug, runId, c.candidates);
  // Invalid entries are dropped from the rewritten files, so they are kept in invalid.json for assemble (and later passes).
  const file = path.join(dirOf(slug, runId), 'invalid.json');
  const before = readJsonFile(file);
  const known = Array.isArray(before.value) ? before.value : [];
  const seen = new Set(known.map((i) => JSON.stringify(i)));
  const merged = [...known];
  for (const i of [...c.invalid, ...v.invalid]) if (!seen.has(JSON.stringify(i))) { seen.add(JSON.stringify(i)); merged.push(i); }
  if (merged.length !== known.length) writeAtomic(file, toJson(merged));
  return { candidates: c.candidates, votes: v.votes, invalid: merged };
}

// One agent file, written and normalized. They return what ingest returns, for the files they touched.
function writeCandidate(slug, runId, key, rawArray) {
  ensureRunDirs(slug, runId);
  writeAtomic(path.join(dirOf(slug, runId), 'candidates', `${fileKey(key)}.json`), toJson(rawArray));
  const all = ingest(slug, runId);
  return { candidates: all.candidates.filter((c) => c.hunter.agent === key), invalid: all.invalid.filter((i) => i.file === `candidates/${fileKey(key)}.json`) };
}

function writeVote(slug, runId, fileName, rawVote) {
  if (typeof fileName !== 'string' || !VOTE_FILE_RE.test(fileName) || fileName.includes('/') || fileName.includes('\\')) {
    throw new RangeError('vote file name must be <hunterKey>__<ref>__<n>.json');
  }
  ensureRunDirs(slug, runId);
  writeAtomic(path.join(dirOf(slug, runId), 'votes', fileName), toJson(rawVote));
  const all = ingest(slug, runId);
  return { votes: all.votes, invalid: all.invalid.filter((i) => i.file === `votes/${fileName}`) };
}

// Stored forms only: an entry that does not match its schema (a raw file ingest rejected stays on disk as written) is left out.
function readStored(slug, runId, kind, schemaName) {
  const dir = path.join(dirOf(slug, runId), kind);
  const schema = loadSchema(schemaName);
  return jsonFiles(dir)
    .flatMap((name) => {
      const r = readJsonFile(path.join(dir, name));
      if (r.bad || r.missing) return [];
      if (kind === 'candidates') return Array.isArray(r.value) ? r.value : [];
      const m = VOTE_FILE_RE.exec(name);
      return m && isObject(r.value) && r.value.verifier === `verify:${m[1]}#${m[2]}:${m[3]}` ? [r.value] : [];
    })
    .filter((entry) => validate(schema, entry).ok);
}
const readCandidates = (slug, runId) => readStored(slug, runId, 'candidates', 'candidate');
const readVotes = (slug, runId) => readStored(slug, runId, 'votes', 'vote');

// ---- the verification bar -----------------------------------------------------------------

// Candidates that share a candidateId (two hunters, one finding) are one candidate with their votes unioned (one vote per verifier
// label); the bar uses the highest severity any hunter gave and the lowest confidence. Verified: a majority of the votes confirm,
// at least one does, and a HIGH or CRITICAL candidate has at least two. Rejected: a majority reject. Anything else (a tie, unsure,
// no votes) is undecided.
function tally(candidates, votes) {
  const merged = new Map();
  for (const c of candidates) {
    const cur = merged.get(c.candidateId);
    if (!cur) {
      merged.set(c.candidateId, { ...c, flags: { ...c.flags } });
      continue;
    }
    if (RANK[c.severity] > RANK[cur.severity]) cur.severity = c.severity;
    if (CONFIDENCES.indexOf(c.confidence) > CONFIDENCES.indexOf(cur.confidence)) cur.confidence = c.confidence;
    if (c.flags && c.flags.prompt_injection) cur.flags.prompt_injection = true;
  }
  const result = { verified: [], rejected: [], undecided: [] };
  for (const candidate of merged.values()) {
    const own = new Map();
    for (const v of votes) if (v.candidateId === candidate.candidateId && !own.has(v.verifier)) own.set(v.verifier, v);
    const mine = [...own.values()];
    const n = mine.length;
    const confirmed = mine.filter((v) => v.verdict === 'confirmed').length;
    const rejected = mine.filter((v) => v.verdict === 'rejected').length;
    const needed = RANK[candidate.severity] >= RANK.HIGH ? 2 : 1;
    const bucket = confirmed > n / 2 && confirmed >= needed ? 'verified' : rejected > n / 2 ? 'rejected' : 'undecided';
    result[bucket].push({ candidate, votes: mine });
  }
  return result;
}

// ---- init ---------------------------------------------------------------------------------

// The five labelled paragraphs of a class, verbatim from the pack file (the parsed pack keeps only the level of the severity).
function classText(packName, classId) {
  const lines = fs.readFileSync(path.join(PACKS_DIR, `${packName}.md`), 'utf8').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const start = lines.findIndex((l) => l.startsWith(`### ${classId}:`) || l.trim() === `### ${classId}`);
  if (start === -1) return '';
  const end = lines.findIndex((l, i) => i > start && l.startsWith('##'));
  return lines.slice(start + 1, end === -1 ? lines.length : end).join('\n').trim();
}

const classesOf = (packs) =>
  packs.flatMap((p) => p.classes.map((c) => ({ pack: p.name, packVersion: p.version, classId: c.id, title: c.title, text: classText(p.name, c.id) })));

function revisionOf(repo) {
  try {
    const head = runCmd('git', ['-C', repo, 'rev-parse', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS });
    if (head.code !== 0) return null;
    const status = runCmd('git', ['-C', repo, 'status', '--porcelain'], { timeoutMs: GIT_TIMEOUT_MS });
    return { commit: head.stdout.trim(), dirty: status.code === 0 && status.stdout.trim() !== '' };
  } catch {
    return null;
  }
}

// Each host pack's Baseline section, then each of its probes' id and expect line, verbatim from the pack: the INFRA prober's and
// verifiers' `baseline`.
const baselineOf = (packs) =>
  packs.map((p) => [`${p.name}@${p.version} Baseline:`, p.baseline, '', `${p.name}@${p.version} probes:`, ...(p.probes || []).map((pr) => `- ${pr.id}: ${pr.expect}`)].join('\n')).join('\n\n');

// The host name of a system for the INFRA prober: the ssh target without its user, scheme or port, else the live URL's host,
// else the system id. The ssh user never reaches an agent.
function hostNameOf(system) {
  const ssh = system.host && typeof system.host.ssh === 'string' ? system.host.ssh.trim() : '';
  if (ssh) {
    const bare = ssh.replace(/^ssh:\/\//i, '').split('/')[0];
    const host = bare.slice(bare.lastIndexOf('@') + 1).replace(/^\[([^\]]+)\](:\d+)?$/, '$1').replace(/:\d+$/, '');
    if (host) return host;
  }
  try {
    if (system.live && system.live.url) return new URL(system.live.url).hostname;
  } catch { /* not a URL: fall through */ }
  return system.id;
}

// The units and classes an effort leaves: low = the LOW classes on reachable units, medium = every class on reachable units,
// high = every class on every unit.
function byEffort(units, classes, effort) {
  return {
    units: effort === 'high' ? units : units.filter((u) => u.reachable),
    classes: effort === 'low' ? classes.filter((c) => LOW_CLASSES.includes(c.classId)) : classes,
  };
}

// What a run for one system and layer would hunt, before any effort filter. Gates (project, owner attestation, system, an
// INFRA audit in a cloud session) throw RangeError. An L2 audit with an empty diff returns {empty: true, ...}.
function planRun(slug, { system: systemId, layer, repo: repoOverride, base } = {}) {
  if (!['L2', 'L3', 'INFRA'].includes(layer)) throw new RangeError('layer must be L2, L3 or INFRA');
  const project = store.readProject(slug);
  if (!project) throw new RangeError(`project ${slug} not found`);
  if (!isObject(project.ownerAttestation) || !isText(project.ownerAttestation.statement)) {
    throw new RangeError(`project ${slug} has no ownerAttestation; add the owner statement before hunting`);
  }
  const ctx = resolveSystem(slug, systemId);
  const system = ctx.system;
  const infra = layer === 'INFRA';
  // Spec 5.8: infra jobs never go to a cloud executor. Claude Code cloud sessions set CLAUDE_CODE_REMOTE.
  if (infra && process.env.CLAUDE_CODE_REMOTE === 'true') throw new RangeError('INFRA audits never run on a cloud executor; run it from a local session');
  const packs = packsFor(system).filter((p) => (p.kinds || []).includes(infra ? 'host' : 'code'));
  if (!packs.length) throw new RangeError(`system ${systemId} has no ${infra ? 'host' : 'code'} pack`);
  const classes = classesOf(packs);
  if (infra) return { system, packs, classes, repoRoot: null, units: packs.flatMap((p) => coverage.unitsForHost(system, p)) };
  const repoRoot = resolveRepo(ctx, repoOverride);
  if (layer === 'L3') return { system, packs, classes, repoRoot, units: coverage.unitsForRepo(repoRoot, { paths: true }) };
  const scope = diffScope(repoRoot, { base, defaultBranch: system.repo && system.repo.defaultBranch });
  if (scope.empty) return { empty: true, base: scope.base, message: `nothing to scan: no changed files against ${scope.base}` };
  // The hunter of an L2 unit reads the unit's changed files that still exist (the ones diffScope counted).
  const kept = scope.files.filter((f) => f.status !== 'D' && !coverage.isIgnored(f.path)).map((f) => f.path).sort(byString);
  return { system, packs, classes, repoRoot, units: scope.units.map((u) => ({ ...u, paths: kept.filter((p) => coverage.unitOf(p) === u.id) })) };
}

// The cost of a run without creating it: per effort, units, classes, hunters (units x classes) and agent runs (a hunter and,
// on average, about one verifier each: 2 per hunter), with a rough token figure. INFRA has no effort: one prober and up to
// three verifiers for each of at most 10 candidates.
function dryRun(slug, opts = {}) {
  const plan = planRun(slug, opts);
  if (plan.empty) return plan;
  const head = { dryRun: true, layer: opts.layer, system: plan.system.id, repoRoot: plan.repoRoot };
  if (opts.layer === 'INFRA') {
    const agentsMax = 1 + 10 * 3;
    return { ...head, infra: { probes: plan.units.length, classes: plan.classes.length, agentsMax, tokensMax: agentsMax * TOKENS_PER_AGENT } };
  }
  const efforts = {};
  for (const effort of ['low', 'medium', 'high']) {
    const { units, classes } = byEffort(plan.units, plan.classes, effort);
    const hunters = units.length * classes.length;
    efforts[effort] = { units: units.length, classes: classes.length, hunters, agents: 2 * hunters, tokens: 2 * hunters * TOKENS_PER_AGENT };
  }
  return { ...head, efforts };
}

// Plan a run for one system and layer. Gates (project, owner attestation, system) throw RangeError before anything is created.
// An L2 audit with an empty diff returns {empty: true, ...} and creates nothing. Otherwise returns {runId, runDir, args}.
function initRun(slug, { system: systemId, layer, effort = 'medium', repo: repoOverride, base, runId } = {}) {
  if (!['L2', 'L3', 'INFRA'].includes(layer)) throw new RangeError('layer must be L2, L3 or INFRA');
  if (!['low', 'medium', 'high'].includes(effort)) throw new RangeError('effort must be low, medium or high');
  const plan = planRun(slug, { system: systemId, layer, repo: repoOverride, base });
  if (plan.empty) return plan;
  const { system, packs, repoRoot } = plan;
  const infra = layer === 'INFRA';
  let { units, classes } = plan;
  if (!infra) ({ units, classes } = byEffort(units, classes, effort));
  if (!units.length || (!infra && !classes.length)) throw new RangeError('nothing to hunt: no unit and class remain after the effort filter');

  let id = runId;
  if (id === undefined) id = store.createRun(slug, { job: 'audit', layers: [layer], systems: [systemId], executor: 'local' }).runId;
  else if (!fs.existsSync(path.join(dirOf(slug, id), 'run.json'))) throw new RangeError(`run ${id} not found in project ${slug}`);
  const dir = ensureRunDirs(slug, id);
  const revision = repoRoot ? revisionOf(repoRoot) : null;
  if (revision) store.finishRun(slug, id, { revision });

  const hunters = infra
    ? [{ key: infraKey(systemId), system: systemId, unit: null, units: units.map((u) => u.id), classId: null, pack: null, packVersion: null }]
    : units.flatMap((u) => classes.map((c) => ({ key: hunterKey(u.id, c.classId), system: systemId, unit: u.id, classId: c.classId, pack: c.pack, packVersion: c.packVersion })));
  const unitsDoc = units.map(({ paths, ...u }) => u);
  writeAtomic(path.join(dir, 'units.json'), toJson({ layer, effort, system: systemId, repoRoot, units: unitsDoc, classes, hunters }));
  return {
    runId: id,
    runDir: dir,
    ...(infra ? {
      prober: {
        system: { id: systemId, type: system.type, host: hostNameOf(system) },
        observationsPath: path.join(dir, 'observations.json'),
        outputPath: path.join(dir, 'candidates', `${infraKey(systemId)}.json`),
      },
    } : {}),
    args: {
      project: slug,
      runId: id,
      repoRoot,
      systems: [{ id: systemId, type: system.type, kind: infra ? 'host' : 'code' }],
      layer,
      units: units.map((u) => ({ system: systemId, unit: u.id, files: Number.isInteger(u.files) ? u.files : null, ...(Array.isArray(u.paths) ? { paths: u.paths } : {}) })),
      classes: classes.map(({ pack, packVersion, classId, title, text }) => ({ pack, packVersion, classId, title, text })),
      runDir: dir,
      effort,
      ...(infra ? { baseline: baselineOf(packs) } : {}),
    },
  };
}

// ---- assemble -----------------------------------------------------------------------------

const hunterReturned = (dir, key) => {
  const r = readJsonFile(path.join(dir, 'candidates', `${key}.json`));
  return Array.isArray(r.value);
};

// Status and reason of each unit of the run, decided from the files in the run directory.
function judgeUnits(doc, dir) {
  const hunters = doc.hunters || [];
  if (doc.layer === 'INFRA') {
    const obs = readJsonFile(path.join(dir, 'observations.json'));
    const ok = isObject(obs.value);
    const observations = ok && Array.isArray(obs.value.observations) ? obs.value.observations : [];
    const skipped = ok && Array.isArray(obs.value.skipped) ? obs.value.skipped : [];
    const probeOf = (u) => u.id.replace(/^probe:/, '');
    const returned = hunters.length > 0 && hunters.every((h) => hunterReturned(dir, h.key));
    return doc.units.map((u) => {
      if (!ok) return { ...u, status: 'failed', reason: 'no probe observations were recorded' };
      const skip = skipped.find((s) => s.probeId === probeOf(u));
      if (skip) return { ...u, status: 'skipped', reason: cleanText(skip.reason || 'probe skipped', 200) };
      const seen = observations.find((o) => o.probeId === probeOf(u));
      if (!seen) return { ...u, status: 'failed', reason: 'probe has no observation' };
      if (seen.ok === false && !isText(seen.text)) return { ...u, status: 'skipped', reason: 'probe failed and produced no output' };
      if (!returned) return { ...u, status: 'failed', reason: 'hunter did not return: infra-prober' };
      return { ...u, status: 'covered' };
    });
  }
  return doc.units.map((u) => {
    const missing = hunters.filter((h) => h.unit === u.id && !hunterReturned(dir, h.key)).map((h) => h.classId);
    return missing.length ? { ...u, status: 'failed', reason: `hunter did not return: ${missing.join(', ')}` } : { ...u, status: 'covered' };
  });
}

// Everything that happens once the agents are done. See the file header; returns {counts, findings: [ids], skipped: [units]}.
function assemble(slug, runId) {
  const doc = readUnits(slug, runId);
  const dir = dirOf(slug, runId);
  const status = (readJsonFile(path.join(dir, 'run.json')).value || {}).status;
  if (['done', 'failed', 'skipped'].includes(status)) throw new RangeError(`run ${runId} is already ${status}; assemble runs once`);
  const { candidates, votes, invalid } = ingest(slug, runId);
  // A unit whose hunter file had invalid entries is still covered, but an entry that never made it in may have been the finding
  // that is "missing", so nothing in that unit is closed.
  const invalidIn = new Map();
  for (const i of invalid) {
    const h = i.key ? (doc.hunters || []).find((x) => x.key === i.key) : null;
    for (const id of h ? (h.units || [h.unit]) : []) invalidIn.set(id, (invalidIn.get(id) || 0) + 1);
  }
  const units = judgeUnits(doc, dir).map((u) => (invalidIn.has(u.id) ? { ...u, invalid: invalidIn.get(u.id) } : u));
  const covered = units.filter((u) => u.status === 'covered');
  const closable = covered.filter((u) => !u.invalid);
  const t = tally(candidates, votes);

  const now = new Date().toISOString();
  const findings = t.verified.map(({ candidate, votes: mine }) =>
    fromHunt(candidate, mine.filter((v) => v.verdict === 'confirmed'), { project: slug, runId, now, totalVotes: mine.length })
  );
  const upserted = store.upsertFindings(slug, findings, runId);

  const infra = doc.layer === 'INFRA';
  let closed = 0;
  let closedIds = [];
  if (covered.length) {
    const allCovered = covered.length === units.length && closable.length === units.length;
    const inCovered = (f) => f.location && typeof f.location.path === 'string' && closable.some((u) => coverage.unitContains(u.id, f.location.path));
    const res = store.closeMissing(slug, {
      system: doc.system,
      source: infra ? 'infra-probe' : 'rampart-hunter',
      runId,
      seenIds: [...t.verified, ...t.undecided].map((e) => e.candidate.candidateId),
      filter: (f) => f.layer === doc.layer && (infra ? allCovered : inCovered(f)),
    });
    closed = res.closed;
    closedIds = res.ids;
  }

  // Skipped units are left out of the ledger: its gaps treat a skipped entry as covered.
  const packs = coverage.packVersionsFor(store.readProject(slug).systems.find((s) => s.id === doc.system) || {}, doc.layer);
  let ledger = store.readCoverage(slug);
  for (const status of ['covered', 'failed']) {
    const group = units.filter((u) => u.status === status);
    if (group.length) ledger = coverage.markCovered(ledger, { system: doc.system, layer: doc.layer, units: group, runId, packs, status });
  }
  store.writeCoverage(slug, ledger);
  writeAtomic(path.join(dir, 'units.json'), toJson({ ...doc, units }));
  // The run's own finding list (ids only): the report reads it, since a finding's lastSeen moves on with every later run.
  writeAtomic(path.join(dir, 'findings.json'), toJson({ verified: findings.map((f) => f.id), closed: closedIds }));

  const counts = {
    added: upserted.added, updated: upserted.updated, unchanged: upserted.unchanged,
    hardening: findings.filter((f) => f.class === 'hardening').length,
    closed,
    candidates: t.verified.length + t.rejected.length + t.undecided.length,
    verified: t.verified.length, rejected: t.rejected.length, undecided: t.undecided.length,
    invalid: invalid.length,
  };
  const failed = covered.length === 0;
  store.finishRun(slug, runId, failed ? { status: 'failed', reason: 'no unit was covered', counts } : { status: 'done', counts });
  return { counts, invalid, findings: findings.map((f) => f.id), skipped: units.filter((u) => u.status === 'failed' || u.status === 'skipped') };
}

// For the INFRA verify-only workflow: the candidates a prober wrote, after ingesting.
function listCandidates(slug, runId) {
  return ingest(slug, runId).candidates.map((c) => ({ candidateRef: `${c.hunter.agent}#${c.ref}`, file: `candidates/${c.hunter.agent}.json`, severity: c.severity, classId: c.classId, title: c.title }));
}

// ---- verify: re-run a verifier on stored findings ------------------------------------------

// A verify run re-judges stored hunt findings against the current code: one verifier each, no hunt. Its run directory holds
//   verify.json                        {system, repoRoot, entries: [{finding, key, outcome?, reason?}]}
//   candidates/<key>.json              a one-element array (ref c1) written from the stored finding, for the verifier to read
//   votes/<key>__c1__1.json            the verifier's vote
// with key = <fileKey(finding id)>__verify. The run has job verify and no layers: a re-check covers no unit, so it earns no
// coverage credit. reverify applies the votes: rejected -> fixed (by rampart, "no longer reproducible in run <runId>"),
// confirmed -> still open, seen again (lastSeen moves on; verification becomes this run's votes), anything else -> unchanged, with the reason.

const VERIFY_STATUSES = ['open', 'regressed'];
const verifyKey = (findingId) => `${fileKey(findingId)}__verify`;

// Why a stored finding cannot be re-verified, or null when it can.
function notVerifiable(f, systemId) {
  if (systemId !== undefined && f.system !== systemId) return `finding ${f.id} belongs to system ${f.system}, not ${systemId}`;
  if (f.source !== 'rampart-hunter') return `finding ${f.id} came from ${f.source}, not from a Rampart hunt`;
  if (f.class !== 'verified') return `finding ${f.id} is class ${f.class}, not verified`;
  if (!VERIFY_STATUSES.includes(f.status)) return `finding ${f.id} is ${f.status}, not open`;
  if (!isObject(f.location) || !isText(f.location.path)) return `finding ${f.id} has no code location`;
  return null;
}

// The class a finding was hunted under, from its pack as it is today: {pack, packVersion, classId, title, text} or {reason}.
function classOfFinding(f) {
  const packName = typeof f.pack === 'string' ? f.pack.split('@')[0] : '';
  const classId = typeof f.ruleId === 'string' && f.ruleId.startsWith(`${packName}/`) ? f.ruleId.slice(packName.length + 1) : '';
  if (!packName || !classId) return { reason: `finding ${f.id} names no pack class` };
  let pack;
  try {
    pack = require('./packs.cjs').readPack(packName);
  } catch {
    return { reason: `pack ${packName} is not installed` };
  }
  const cls = (pack.classes || []).find((c) => c.id === classId);
  if (!cls) return { reason: `class ${classId} is no longer in pack ${packName}` };
  return { pack: pack.name, packVersion: pack.version, classId, title: cls.title, text: classText(pack.name, classId) };
}

// Plan a verify run. --finding <id> (its system is the finding's) or --system <id> with all: every open verified hunt finding
// of that system. Gates as for init. A finding that cannot be re-verified is refused when named, skipped with a reason under
// all. Nothing to verify returns {nothing: true, ...} and creates no run. Otherwise {runId, runDir, repoRoot, verifications,
// skipped}, each verification carrying the verifier's dispatch fields and the finding's id, title, severity and location.
function initVerify(slug, { system: systemId, finding: findingId, all = false, repo: repoOverride } = {}) {
  if (Boolean(findingId) === Boolean(all)) throw new RangeError('give exactly one of --finding <id> or --all');
  if (all && !systemId) throw new RangeError('--all needs --system');
  const project = store.readProject(slug);
  if (!project) throw new RangeError(`project ${slug} not found`);
  if (!isObject(project.ownerAttestation) || !isText(project.ownerAttestation.statement)) {
    throw new RangeError(`project ${slug} has no ownerAttestation; add the owner statement before verifying`);
  }
  const findings = store.readFindings(slug);
  let chosen;
  let sys = systemId;
  if (findingId) {
    const f = findings.find((x) => x.id === findingId);
    if (!f) throw new RangeError(`no finding ${findingId} in project ${slug}`);
    const why = notVerifiable(f, systemId);
    if (why) throw new RangeError(why);
    sys = f.system;
    chosen = [f];
  } else {
    chosen = findings.filter((f) => notVerifiable(f, systemId) === null).sort((a, b) => byString(a.id, b.id));
  }
  const ctx = resolveSystem(slug, sys);
  const plans = [];
  const skipped = [];
  for (const f of chosen) {
    const cls = classOfFinding(f);
    if (cls.reason) {
      if (findingId) throw new RangeError(cls.reason);
      skipped.push({ finding: f.id, reason: cls.reason });
    } else plans.push({ f, cls });
  }
  if (!plans.length) return { nothing: true, verifications: [], skipped, message: 'nothing to verify: no open verified finding from a Rampart hunt' };
  const repoRoot = resolveRepo(ctx, repoOverride);

  const runId = store.createRun(slug, { job: 'verify', layers: [], systems: [sys], executor: 'local' }).runId;
  const dir = ensureRunDirs(slug, runId);
  const revision = revisionOf(repoRoot);
  if (revision) store.finishRun(slug, runId, { revision });
  const verifications = plans.map(({ f, cls }) => {
    const key = verifyKey(f.id);
    const candidate = {
      ref: 'c1', classId: cls.classId, title: f.title, severity: f.severity, confidence: f.confidence, cwe: f.cwe || [],
      location: f.location, evidence: f.evidence, exploitScenario: f.exploitScenario || '', preconditions: f.preconditions || '',
      recommendation: f.recommendation || '',
    };
    const candidateFile = path.join(dir, 'candidates', `${key}.json`);
    writeAtomic(candidateFile, toJson([candidate]));
    return {
      finding: f.id, title: f.title, severity: f.severity, location: f.location,
      candidateFile, candidateRef: `${key}#c1`,
      classText: `${cls.pack}@${cls.packVersion} ${cls.classId}: ${cls.title}\n\n${cls.text}`,
      outputPath: path.join(dir, 'votes', `${key}__c1__1.json`),
    };
  });
  writeAtomic(path.join(dir, 'verify.json'), toJson({ system: sys, repoRoot, entries: plans.map(({ f }) => ({ finding: f.id, key: verifyKey(f.id) })) }));
  return { runId, runDir: dir, repoRoot, verifications, skipped };
}

// The usable votes of one verify entry; every vote file of it is rewritten in its stored (redacted) form, or stubbed.
function verifyVotes(dir, entry) {
  const votes = [];
  const cand = { candidateId: entry.finding, hunter: { agent: entry.key }, ref: 'c1' };
  for (const name of jsonFiles(path.join(dir, 'votes')).filter((n) => n.startsWith(`${entry.key}__`))) {
    const file = path.join(dir, 'votes', name);
    const r = readJsonFile(file);
    const n = r.bad ? { reason: 'not valid JSON' } : normalizeVote(r.value, name, [cand]);
    if (!n.vote) {
      stub(file, n.reason);
      continue;
    }
    if (toJson(n.vote) !== r.text) writeAtomic(file, toJson(n.vote));
    votes.push(n.vote);
  }
  return votes;
}

// Apply the votes of a verify run: every entry without an outcome, or only the one --finding names. The run finishes once every
// entry has an outcome: done, or failed when no verifier left a usable vote. Returns {results: [{finding, outcome, reason}], run}.
function reverify(slug, runId, { finding: only } = {}) {
  const dir = dirOf(slug, runId);
  const run = readJsonFile(path.join(dir, 'run.json')).value;
  if (!isObject(run) || run.job !== 'verify') throw new RangeError(`run ${runId} is not a verify run of project ${slug}`);
  if (run.status !== 'running') throw new RangeError(`run ${runId} is already ${run.status}; reverify runs once`);
  const docFile = path.join(dir, 'verify.json');
  const doc = readJsonFile(docFile).value;
  if (!isObject(doc) || !Array.isArray(doc.entries)) throw new RangeError(`run ${runId} has no readable verify.json (run hunt-io init-verify first)`);
  const todo = doc.entries.filter((e) => (only === undefined ? !e.outcome : e.finding === only));
  if (only !== undefined && !todo.length) throw new RangeError(`finding ${only} is not part of run ${runId}`);
  if (only !== undefined && todo[0].outcome) throw new RangeError(`finding ${only} was already re-verified in run ${runId}`);

  const results = [];
  for (const entry of todo) {
    const votes = verifyVotes(dir, entry);
    const n = votes.length;
    const confirmed = votes.filter((v) => v.verdict === 'confirmed').length;
    const rejected = votes.filter((v) => v.verdict === 'rejected').length;
    const current = store.readFindings(slug).find((f) => f.id === entry.finding);
    let outcome = 'unchanged';
    let reason;
    if (!n) reason = 'no usable vote: the verifier did not return';
    else if (!current) reason = 'the finding is no longer in the store';
    else if (!VERIFY_STATUSES.includes(current.status)) reason = `the finding is now ${current.status}; left as it is`;
    else if (rejected > n / 2) {
      store.setDisposition(slug, entry.finding, { status: 'fixed', reason: `no longer reproducible in run ${runId}`, by: 'rampart' });
      outcome = 'fixed';
      reason = 'the verifier could not reproduce it';
    } else if (confirmed > n / 2) {
      store.upsertFindings(slug, [{ ...current, verification: { verifiers: n, confirmed, run: runId } }], runId);
      outcome = 'still-open';
      reason = 'the verifier confirmed it in the current code';
    } else reason = 'the verifier was unsure; left as it is';
    entry.outcome = outcome;
    entry.reason = reason;
    entry.votes = n;
    entry.verdict = n ? (confirmed > n / 2 ? 'confirmed' : rejected > n / 2 ? 'rejected' : 'undecided') : 'none';
    results.push({ finding: entry.finding, outcome, reason });
  }
  writeAtomic(docFile, toJson(doc));

  let finished = run;
  if (doc.entries.every((e) => e.outcome)) {
    const count = (v) => doc.entries.filter((e) => e.verdict === v).length;
    const counts = {
      added: 0, updated: 0, unchanged: doc.entries.filter((e) => e.outcome !== 'fixed').length, hardening: 0,
      closed: doc.entries.filter((e) => e.outcome === 'fixed').length,
      candidates: doc.entries.length, verified: count('confirmed'), rejected: count('rejected'), undecided: count('undecided') + count('none'),
    };
    finished = doc.entries.some((e) => e.votes > 0)
      ? store.finishRun(slug, runId, { status: 'done', counts })
      : store.finishRun(slug, runId, { status: 'failed', reason: 'no verifier left a usable vote', counts });
  }
  return { results, run: finished };
}

// ---- the command line ---------------------------------------------------------------------

const USAGE = [
  'usage: node scripts/hunt-io.cjs init --project <slug> --system <id> --layer L2|L3|INFRA [--effort low|medium|high] [--repo <path>] [--base <ref>] [--run <runId>] [--dry-run] [--json]',
  '       node scripts/hunt-io.cjs assemble --project <slug> --run <runId> [--json]',
  '       node scripts/hunt-io.cjs list --project <slug> --run <runId> [--json]',
  '       node scripts/hunt-io.cjs init-verify --project <slug> (--finding <id> | --system <id> --all) [--repo <path>] [--json]',
  '       node scripts/hunt-io.cjs reverify --project <slug> --run <runId> [--finding <id>] [--json]',
].join('\n');

class UsageError extends Error {}

const OPTIONS = {
  init: ['project', 'system', 'layer', 'effort', 'repo', 'base', 'run'],
  assemble: ['project', 'run'],
  list: ['project', 'run'],
  'init-verify': ['project', 'system', 'finding', 'repo'],
  reverify: ['project', 'run', 'finding'],
};
const FLAGS = { init: ['dry-run'], 'init-verify': ['all'] };

function parse(argv) {
  const [command, ...rest] = argv;
  if (!Object.hasOwn(OPTIONS, command)) throw new UsageError(command === undefined ? 'a command is required' : `unknown command: ${command}`);
  let values;
  try {
    ({ values } = util.parseArgs({
      args: rest,
      options: {
        ...Object.fromEntries(OPTIONS[command].map((n) => [n, { type: 'string' }])),
        ...Object.fromEntries((FLAGS[command] || []).map((n) => [n, { type: 'boolean' }])),
        json: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new UsageError(err.message.split('\n')[0]);
  }
  const required = command === 'init' ? ['project', 'system', 'layer'] : command === 'init-verify' ? ['project'] : ['project', 'run'];
  for (const name of required) if (values[name] === undefined) throw new UsageError(`--${name} is required`);
  return { command, ...values };
}

function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const o = parse(argv);
    let result;
    if (o.command === 'init') {
      const opts = { system: o.system, layer: o.layer, effort: o.effort, repo: o.repo, base: o.base, runId: o.run };
      if (o['dry-run'] && o.effort !== undefined && !['low', 'medium', 'high'].includes(o.effort)) throw new RangeError('effort must be low, medium or high');
      result = o['dry-run'] ? dryRun(o.project, opts) : initRun(o.project, opts);
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (o.command === 'init-verify') {
      result = initVerify(o.project, { system: o.system, finding: o.finding, all: o.all, repo: o.repo });
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (o.command === 'reverify') {
      result = reverify(o.project, o.run, { finding: o.finding });
      stdout.write(o.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${result.results.map((r) => `${r.finding}  ${r.outcome}  ${r.reason}`).join('\n') || 'nothing re-verified'}\nrun ${result.run.runId}: ${result.run.status}\n`);
    } else if (o.command === 'list') {
      result = listCandidates(o.project, o.run);
      stdout.write(o.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.map((r) => `${r.candidateRef}  ${r.severity}  ${r.title}`).join('\n') || 'no candidates'}\n`);
    } else {
      result = assemble(o.project, o.run);
      const c = result.counts;
      stdout.write(o.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${c.verified} verified, ${c.rejected} rejected, ${c.undecided} undecided; ${c.added} added, ${c.updated} updated, ${c.closed} closed; ${result.skipped.length} unit(s) failed or skipped\n`);
    }
    return 0;
  } catch (err) {
    stderr.write(`hunt-io: ${redact(err.message)}\n`);
    if (err instanceof UsageError) stderr.write(`${USAGE}\n`);
    return err instanceof UsageError || err instanceof RangeError ? 2 : 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  LOW_CLASSES, TOKENS_PER_AGENT, fileKey, hunterKey, infraKey, ingest, writeCandidate, writeVote, readCandidates, readVotes, tally, initRun, dryRun, assemble,
  listCandidates, initVerify, reverify, main,
};
