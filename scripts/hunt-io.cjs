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
// CLI: node scripts/hunt-io.cjs init|assemble|list ... (see USAGE). Exit 0 ok, 2 usage error or a gate that did not pass, 1 other.

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

// Plan a run for one system and layer. Gates (project, owner attestation, system) throw RangeError before anything is created.
// An L2 audit with an empty diff returns {empty: true, ...} and creates nothing. Otherwise returns {runId, runDir, args}.
function initRun(slug, { system: systemId, layer, effort = 'medium', repo: repoOverride, base, runId } = {}) {
  if (!['L2', 'L3', 'INFRA'].includes(layer)) throw new RangeError('layer must be L2, L3 or INFRA');
  if (!['low', 'medium', 'high'].includes(effort)) throw new RangeError('effort must be low, medium or high');
  const project = store.readProject(slug);
  if (!project) throw new RangeError(`project ${slug} not found`);
  if (!isObject(project.ownerAttestation) || !isText(project.ownerAttestation.statement)) {
    throw new RangeError(`project ${slug} has no ownerAttestation; add the owner statement before hunting`);
  }
  const ctx = resolveSystem(slug, systemId);
  const system = ctx.system;
  const infra = layer === 'INFRA';
  const packs = packsFor(system).filter((p) => (p.kinds || []).includes(infra ? 'host' : 'code'));
  if (!packs.length) throw new RangeError(`system ${systemId} has no ${infra ? 'host' : 'code'} pack`);

  let repoRoot = null;
  let units;
  let classes = classesOf(packs);
  if (infra) {
    units = packs.flatMap((p) => coverage.unitsForHost(system, p));
  } else {
    repoRoot = resolveRepo(ctx, repoOverride);
    if (layer === 'L3') units = coverage.unitsForRepo(repoRoot);
    else {
      const scope = diffScope(repoRoot, { base, defaultBranch: system.repo && system.repo.defaultBranch });
      if (scope.empty) return { empty: true, base: scope.base, message: `nothing to scan: no changed files against ${scope.base}` };
      units = scope.units;
    }
    if (effort !== 'high') units = units.filter((u) => u.reachable);
    if (effort === 'low') classes = classes.filter((c) => LOW_CLASSES.includes(c.classId));
  }
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
  writeAtomic(path.join(dir, 'units.json'), toJson({ layer, effort, system: systemId, repoRoot, units, classes, hunters }));
  return {
    runId: id,
    runDir: dir,
    args: {
      project: slug,
      runId: id,
      repoRoot,
      systems: [{ id: systemId, type: system.type, kind: infra ? 'host' : 'code' }],
      layer,
      units: units.map((u) => ({ system: systemId, unit: u.id, files: Number.isInteger(u.files) ? u.files : null })),
      classes: classes.map(({ pack, packVersion, classId, text }) => ({ pack, packVersion, classId, text })),
      runDir: dir,
      effort,
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
  if (covered.length) {
    const allCovered = covered.length === units.length && closable.length === units.length;
    const inCovered = (f) => f.location && typeof f.location.path === 'string' && closable.some((u) => coverage.unitContains(u.id, f.location.path));
    closed = store.closeMissing(slug, {
      system: doc.system,
      source: infra ? 'infra-probe' : 'rampart-hunter',
      runId,
      seenIds: [...t.verified, ...t.undecided].map((e) => e.candidate.candidateId),
      filter: (f) => f.layer === doc.layer && (infra ? allCovered : inCovered(f)),
    }).closed;
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
  return ingest(slug, runId).candidates.map((c) => ({ candidateRef: `${c.hunter.agent}#${c.ref}`, file: `candidates/${c.hunter.agent}.json`, severity: c.severity, title: c.title }));
}

// ---- the command line ---------------------------------------------------------------------

const USAGE = [
  'usage: node scripts/hunt-io.cjs init --project <slug> --system <id> --layer L2|L3|INFRA [--effort low|medium|high] [--repo <path>] [--base <ref>] [--run <runId>] [--json]',
  '       node scripts/hunt-io.cjs assemble --project <slug> --run <runId> [--json]',
  '       node scripts/hunt-io.cjs list --project <slug> --run <runId> [--json]',
].join('\n');

class UsageError extends Error {}

const OPTIONS = {
  init: ['project', 'system', 'layer', 'effort', 'repo', 'base', 'run'],
  assemble: ['project', 'run'],
  list: ['project', 'run'],
};

function parse(argv) {
  const [command, ...rest] = argv;
  if (!Object.hasOwn(OPTIONS, command)) throw new UsageError(command === undefined ? 'a command is required' : `unknown command: ${command}`);
  let values;
  try {
    ({ values } = util.parseArgs({
      args: rest,
      options: { ...Object.fromEntries(OPTIONS[command].map((n) => [n, { type: 'string' }])), json: { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new UsageError(err.message.split('\n')[0]);
  }
  const required = command === 'init' ? ['project', 'system', 'layer'] : ['project', 'run'];
  for (const name of required) if (values[name] === undefined) throw new UsageError(`--${name} is required`);
  return { command, ...values };
}

function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const o = parse(argv);
    let result;
    if (o.command === 'init') {
      result = initRun(o.project, { system: o.system, layer: o.layer, effort: o.effort, repo: o.repo, base: o.base, runId: o.run });
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
  LOW_CLASSES, fileKey, hunterKey, infraKey, ingest, writeCandidate, writeVote, readCandidates, readVotes, tally, initRun, assemble, listCandidates, main,
};
