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
// L2 and L3 hunters (0.5.0): init reads only hunt-worthy files (coverage.isHuntWorthy), packs the units into hunt groups under a
// byte budget and the effort's classes into bundles (hunt-plan.cjs); one hunter hunts one bundle over one group, keyed
// <group>__<bundle> (g03__b1), and each candidate names its class (one of the bundle) and a file of the group, whose unit it is.
// An L3 run skips, unless --full, a unit the ledger shows covered at these pack versions with every class of the effort and whose
// hunt-worthy files did not change since the commit of the run that covered it (status `unchanged` in units.json).
//
//   fileKey(id)  hunterKey(...)          names that are safe in a file name
//   writeCandidate / writeVote           normalize one agent file (tests, and agents' files being normalized)
//   ingest(slug, runId)                  normalize all of them: {candidates, votes, invalid: [{file, reason}]}
//   readCandidates / readVotes           stored forms (ingest first)
//   tally(candidates, votes)             {verified, rejected, undecided}, each [{candidate, votes}]: the verification bar
//   initRun(slug, opts)                  plan a run (L2/L3: batches of workflow args); assemble(slug, runId): tally, upsert, close, cover, finish
//   batchUnits(groups, bundleCount)      the hunt groups split into workflow batches of at most HUNTERS_PER_WORKFLOW hunters
//   initVerify / reverify               a verify run: one verifier per stored finding, then apply the votes (see below)
// CLI: node scripts/hunt-io.cjs init|assemble|list|init-verify|reverify|estimate ... (see USAGE); init --dry-run prints the cost per
// effort and creates nothing; estimate runs that dry run for every L2 and L3 layer of a project's systems that this machine has a
// checkout of and stores the figures (estimates.json) for the dashboard. Exit 0 ok, 2 usage error or a gate that did not pass, 1 other.

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const store = require('./store.cjs');
const coverage = require('./coverage.cjs');
const { packsFor, PACKS_DIR } = require('./packs.cjs');
const { diffScope } = require('./diff-scope.cjs');
const huntPlan = require('./hunt-plan.cjs');
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
// A hunter hunts a bundle of classes over a group of files, so it may report more than the 10 a one-class hunter could: refs run
// c1..c20 (REF_RE, the candidate schema and workflows/audit.js agree). The INFRA prober keeps its cap of 10. A hunter or prober
// that returns its cap may have stopped there, so its units close nothing (R49).
const REF_RE = /^c([1-9]|1[0-9]|20)$/;
const MAX_CANDIDATES = 20; // per code hunter, as REF_RE allows
const MAX_PROBER_CANDIDATES = 10; // per INFRA prober
const VOTE_FILE_RE = /^(.+)__(c(?:[1-9]|1[0-9]|20))__([1-9][0-9]*)\.json$/;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
const TOKEN_RE = /[A-Za-z0-9+=_-]{20,}/g; // no '/' or '.': paths and dotted identifiers are not tokens
const MIN_ENTROPY = 3.5; // bits per character
const EVIDENCE_REPLACED = `${REDACTED} (value-like text removed by rampart)`;
const INJECTION_RE = /\b(ignore (all|any|previous|prior)|disregard (the|all|previous)|you are (now )?(an?|the) |as an ai|system prompt|mark (this|it) as (safe|clean|fixed)|do not (report|flag)|report (no|nothing)|this (file|code) is (safe|secure))/i;
const MAX_TITLE = 200;
const MAX_TEXT = 2000;
const GIT_TIMEOUT_MS = 60000;
// A rough average for one agent run, for the INFRA cost shown before an audit (an estimate, not a budget). L2 and L3 estimate
// from the plan instead (hunt-plan.cjs estimate()).
const TOKENS_PER_AGENT = 50000;
// The workflow runner starts at most this many agents in one workflow run; past it, agents are never started. An L2 or L3 plan
// is split into batches, one workflow run each, of at most HUNTERS_PER_WORKFLOW hunters, which leaves the rest of the cap to
// their verifiers; the workflow itself stops dispatching at the cap, so a batch that finds a lot fails units instead of losing
// them silently.
const WORKFLOW_AGENT_CAP = 1000;
const HUNTERS_PER_WORKFLOW = 400;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// A hunter record is a group hunter ({group, units, classIds, classes}), the INFRA prober ({unit: null, units}) or, in a run
// directory written before 0.5.0, a one-class hunter of one unit ({unit, classId, pack, packVersion}). These read all three.
const unitsOfHunter = (h) => (Array.isArray(h.units) ? h.units : [h.unit]);
const classIdsOfHunter = (h) => (Array.isArray(h.classIds) ? h.classIds : h.classId ? [h.classId] : []);
const ruleIdsOfHunter = (h) => (Array.isArray(h.classes) ? h.classes.map((c) => `${c.pack}/${c.classId}`) : h.classId ? [`${h.pack}/${h.classId}`] : []);
const groupOf = (doc, h) => (h.group ? (doc.groups || []).find((g) => g.id === h.group) : undefined);
const isText = (v) => typeof v === 'string' && v !== '';
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const fileKey = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, '+');
// <fileKey(unit)>__<classId> for a one-class hunter of an older run; <group>__<bundle> (g03__b1) for a group hunter.
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
  if (typeof raw.ref !== 'string' || !REF_RE.test(raw.ref)) return { reason: `ref must be c1 to c${MAX_CANDIDATES}` };
  const infra = doc.layer === 'INFRA';
  let { classId, pack, packVersion } = hunter;
  const group = !infra && hunter.group ? groupOf(doc, hunter) : undefined;
  if (!infra && hunter.group) {
    // A group hunter names the class of each candidate; it must be one of the hunter's bundle (and so of one pack).
    const cls = (hunter.classes || []).find((c) => c.classId === raw.classId);
    if (!cls) return { reason: `${raw.ref}: classId is not one of this hunter's classes` };
    ({ classId, pack, packVersion } = cls);
  }
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
  // A group hunter's candidate lies in one of the files it was given (to read, or named as present); its unit is that file's unit.
  if (hunter.group && !infra && !(group && [...(group.paths || []), ...(group.present || [])].includes(location.path))) {
    return { reason: `${raw.ref}: location is not one of this hunter's files` };
  }
  const unit = hunter.group && !infra ? coverage.unitOf(location.path) : hunter.unit ?? null;
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
    hunter: { agent: hunter.key, unit },
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
    // Scoped to the checkout (a repo that is a folder of a larger one is dirty only for changes inside it).
    const status = runCmd('git', ['-C', repo, 'status', '--porcelain', '--', '.'], { timeoutMs: GIT_TIMEOUT_MS });
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

// Consecutive items (hunt groups; units in older callers) grouped so that no batch needs more than HUNTERS_PER_WORKFLOW hunters
// (items x per-item hunters, the number of class bundles). An item is never split: one with more hunters than that is a batch of
// its own.
function batchUnits(units, classCount) {
  const per = Math.max(1, Math.floor(HUNTERS_PER_WORKFLOW / Math.max(1, classCount)));
  const batches = [];
  for (let i = 0; i < units.length; i += per) batches.push(units.slice(i, i + per));
  return batches;
}

// The size of a file that still exists in the working tree, or null.
function sizeOf(repoRoot, rel) {
  try {
    const st = fs.lstatSync(path.join(repoRoot, rel));
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

// What a run for one system and layer would hunt, before any effort filter. Gates (project, owner attestation, system, an
// INFRA audit in a cloud session) throw RangeError. An L2 audit with an empty diff, or one that changed no hunt-worthy file,
// returns {empty: true, ...}. L2 and L3 units hold only hunt-worthy files (coverage.isHuntWorthy), with their sizes.
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
  if (layer === 'L3') {
    const scope = coverage.huntScope(repoRoot);
    return { system, packs, classes, repoRoot, units: scope.units, excluded: scope.excluded, fileSource: scope.source };
  }
  const scope = diffScope(repoRoot, { base, defaultBranch: system.repo && system.repo.defaultBranch });
  if (scope.empty) return { empty: true, base: scope.base, message: `nothing to scan: no changed files against ${scope.base}` };
  // The hunter of an L2 unit reads the unit's changed hunt-worthy files that still exist.
  const kept = scope.files
    .filter((f) => f.status !== 'D' && !coverage.isIgnored(f.path))
    .map((f) => ({ path: f.path, bytes: sizeOf(repoRoot, f.path) }))
    .filter((f) => f.bytes !== null);
  const scanned = coverage.scanFiles(kept);
  if (!scanned.units.length) {
    return { empty: true, reason: 'no-source', base: scope.base, excluded: scanned.excluded, message: `nothing to scan: ${excludedText(kept.length, scanned.excluded)} against ${scope.base}` };
  }
  return { system, packs, classes, repoRoot, units: scanned.units, excluded: scanned.excluded, fileSource: 'diff' };
}

// "the 3 changed files are not source a hunt reads (2 prose, 1 image)", for an L2 diff with nothing to hunt.
function excludedText(n, excluded) {
  const parts = Object.entries(excluded.counts || {}).sort(([a], [b]) => byString(a, b)).map(([k, v]) => `${v} ${k}`);
  if ((excluded.present || []).length) parts.push(`${excluded.present.length} possible credential file${excluded.present.length === 1 ? '' : 's'}, never read`);
  if (!n) return 'no changed file still exists';
  return `the ${n} changed file${n === 1 ? ' is' : 's are'} not source a hunt reads${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

// Why an effort has no hunter, in words, for dryRun and init: no source at all, none at this effort, all of it too large to read,
// or every unit unchanged since its last hunt.
const NOTHING = {
  'no-source': 'nothing to hunt: the repository has no source file a hunt reads',
  'none-at-effort': 'nothing to hunt at this effort: no source unit is reachable (only background units such as docs and scripts; high effort hunts them)',
  'all-oversize': 'nothing to hunt: every source file is over the size cap, so none can be read (they are listed as not hunted)',
  'all-unchanged': 'nothing to hunt: all units are unchanged since their last hunt at this effort; pass --full to hunt them again',
};

const uniqueSorted = (list) => [...new Set(list)].sort(byString);

// What one effort hunts of a plan: the effort's units and classes; for L3, which units are unchanged since the run that last
// covered them (skipped unless full); the hunt groups of the rest and the class bundles; one hunter per group and bundle.
function huntOf(slug, plan, effort, { layer, full = false } = {}) {
  const { units, classes } = byEffort(plan.units, plan.classes, effort);
  // A unit whose source is all over the size cap has nothing a hunter can read: planned, never hunted, never covered.
  const readable = units.filter((u) => (u.paths || []).length);
  const notHunted = units.filter((u) => !(u.paths || []).length);
  let changes = null;
  if (layer === 'L3' && readable.length && classes.length) {
    const cadence = plan.system.layers && plan.system.layers.L3 && Number.isFinite(plan.system.layers.L3.cadenceDays) ? plan.system.layers.L3.cadenceDays : undefined;
    changes = huntPlan.changedUnits(plan.repoRoot, readable, {
      ledger: store.readCoverage(slug), runs: store.readRuns(slug), system: plan.system.id, layer,
      packs: coverage.packVersionsFor(plan.system, layer), classIds: uniqueSorted(classes.map((c) => c.classId)), maxAgeDays: cadence,
    });
  }
  const byId = new Map((changes || []).map((c) => [c.id, c]));
  const skip = new Set(full ? [] : (changes || []).filter((c) => c.skippable).map((c) => c.id));
  const toHunt = readable.filter((u) => !skip.has(u.id));
  const groups = huntPlan.packGroups(toHunt);
  const bundles = classes.length ? huntPlan.bundleClasses(classes) : [];
  const skipped = readable.filter((u) => skip.has(u.id));
  const reason = groups.length && bundles.length ? null
    : !plan.units.length ? 'no-source' : !units.length || !classes.length ? 'none-at-effort' : !readable.length ? 'all-oversize' : 'all-unchanged';
  return { units, classes, changes: byId, skipped, notHunted, toHunt, groups, bundles, reason };
}

// The cost of a run without creating it. L2 and L3, per effort: units (after the effort filter), the ones skipped as unchanged
// (L3), hunt groups, class bundles, hunters (groups x bundles), the workflow runs they take (batchUnits), and the estimate of
// hunt-plan.cjs: agent runs (hunters plus the verifiers the expected candidates need) and tokens. INFRA has no effort: one prober
// and up to three verifiers for each of at most 10 candidates. full: L3 hunts unchanged units too.
function dryRun(slug, opts = {}) {
  const plan = planRun(slug, opts);
  if (plan.empty) return plan;
  const head = { dryRun: true, layer: opts.layer, system: plan.system.id, repoRoot: plan.repoRoot };
  if (opts.layer === 'INFRA') {
    const agentsMax = 1 + MAX_PROBER_CANDIDATES * 3;
    return { ...head, infra: { probes: plan.units.length, classes: plan.classes.length, agentsMax, tokensMax: agentsMax * TOKENS_PER_AGENT } };
  }
  const efforts = {};
  for (const effort of ['low', 'medium', 'high']) {
    const h = huntOf(slug, plan, effort, { layer: opts.layer, full: opts.full });
    const est = huntPlan.estimate(h.groups, h.bundles, h.classes);
    const workflows = h.groups.length && h.bundles.length ? batchUnits(h.groups, h.bundles.length).length : 0;
    efforts[effort] = {
      units: h.units.length, classes: h.classes.length, hunters: est.hunters, workflows, agents: est.agents, tokens: est.tokens,
      groups: h.groups.length, bundles: h.bundles.length, skippedUnchanged: h.skipped.length, notHunted: h.notHunted.length, sourceBytes: est.sourceBytes,
      verifiers: est.verifiers, hunterTokens: est.hunterTokens, verifierTokens: est.verifierTokens,
      ...(h.reason ? { reason: h.reason, message: NOTHING[h.reason] } : {}),
    };
  }
  const ex = plan.excluded || { counts: {}, oversize: [], present: [], submodules: [] };
  const excluded = {
    byClass: ex.counts, oversizeFiles: ex.oversize.length, oversizeBytes: ex.oversize.reduce((n, f) => n + f.bytes, 0),
    presentFiles: ex.present.length + plan.units.reduce((n, u) => n + (u.present || []).length, 0), submodules: ex.submodules.length,
  };
  return { ...head, files: plan.fileSource, full: Boolean(opts.full), tokensNote: TOKENS_NOTE, excluded, efforts };
}

const TOKENS_NOTE = 'tokens is a rough context-size estimate (what the agents read once); real multi-turn runs resend context and can use several times more';

// The dry-run figures the dashboard prices a job with: per effort, counts and the planner's fixed message, nothing else.
const ESTIMATE_FIELDS = ['units', 'classes', 'hunters', 'workflows', 'agents', 'tokens', 'groups', 'bundles', 'skippedUnchanged', 'notHunted', 'reason', 'message'];
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

// Run the dry run for every L2 and L3 layer the project's systems declare, on this machine's checkout of each, and store the
// figures in estimates.json: {updatedAt, systems: {<id>: {L2|L3: {at, efforts: {low, medium, high}} | {at, empty: true,
// message}}}}. A layer whose dry run cannot run here (no checkout on this machine, no code pack, an unreadable repository)
// keeps what an earlier estimate stored and is returned under skipped with its reason; systems and layers the project no
// longer declares are dropped. Returns {estimated: [{system, layer}], skipped: [{system, layer, reason}], doc}.
function estimateProject(slug, now = new Date()) {
  const project = store.readProject(slug);
  if (!project) throw new RangeError(`project ${slug} not found`);
  const at = new Date(now).toISOString();
  const before = store.readEstimates(slug);
  const systems = {};
  const estimated = [];
  const skipped = [];
  for (const system of Array.isArray(project.systems) ? project.systems : []) {
    const layers = ['L2', 'L3'].filter((L) => isObject(system.layers) && isObject(system.layers[L]));
    const kept = before && isObject(before.systems[system.id]) ? before.systems[system.id] : {};
    const out = {};
    for (const layer of layers) {
      try {
        const r = dryRun(slug, { system: system.id, layer });
        out[layer] = r.empty
          ? { at, empty: true, message: String(r.message || 'nothing to hunt') }
          : { at, efforts: Object.fromEntries(Object.entries(r.efforts).map(([effort, e]) => [effort, pick(e, ESTIMATE_FIELDS)])) };
        estimated.push({ system: system.id, layer });
      } catch (err) {
        if (isObject(kept[layer])) out[layer] = kept[layer];
        skipped.push({ system: system.id, layer, reason: redact(String(err.message)).split('\n')[0] });
      }
    }
    if (Object.keys(out).length) systems[system.id] = out;
  }
  const doc = { updatedAt: at, systems };
  store.writeEstimates(slug, doc);
  return { estimated, skipped, doc };
}

// Plan a run for one system and layer. Gates (project, owner attestation, system) throw RangeError before anything is created.
// An L2 audit with an empty diff (or no changed source file), or an L3 audit whose every unit is unchanged since its last hunt at
// this effort (without full), returns {empty: true, message} and creates nothing. Otherwise returns {runId, runDir, ...}: for L2
// and L3 `batches`, the workflow args of each batch (one workflow run each, in order, all in this one run directory), and
// `plan`, its counts; for INFRA `args` and `prober`.
function initRun(slug, { system: systemId, layer, effort = 'medium', repo: repoOverride, base, runId, full = false } = {}) {
  if (!['L2', 'L3', 'INFRA'].includes(layer)) throw new RangeError('layer must be L2, L3 or INFRA');
  if (!['low', 'medium', 'high'].includes(effort)) throw new RangeError('effort must be low, medium or high');
  const plan = planRun(slug, { system: systemId, layer, repo: repoOverride, base });
  if (plan.empty) return plan;
  const { system, packs, repoRoot } = plan;
  const infra = layer === 'INFRA';
  let units = plan.units;
  let classes = plan.classes;
  let hunt = null;
  if (!infra) {
    hunt = huntOf(slug, plan, effort, { layer, full });
    ({ units, classes } = hunt);
  }
  if (infra && !units.length) throw new RangeError('nothing to probe: the host packs list no probe');
  if (hunt && hunt.reason) {
    const message = hunt.reason === 'all-unchanged'
      ? `nothing to hunt: all ${hunt.skipped.length} units are unchanged since their last ${layer} hunt at this effort; pass --full to hunt them again`
      : NOTHING[hunt.reason];
    return { empty: true, reason: hunt.reason, skippedUnchanged: hunt.skipped.length, notHunted: hunt.notHunted.length, message };
  }

  let id = runId;
  if (id === undefined) id = store.createRun(slug, { job: 'audit', layers: [layer], systems: [systemId], executor: 'local' }).runId;
  else if (!fs.existsSync(path.join(dirOf(slug, id), 'run.json'))) throw new RangeError(`run ${id} not found in project ${slug}`);
  const dir = ensureRunDirs(slug, id);
  const revision = repoRoot ? revisionOf(repoRoot) : null;
  if (revision) store.finishRun(slug, id, { revision });

  // The classes the effort filter left out, so the report can say what this run did not hunt.
  const hunted = new Set(classes.map((c) => `${c.pack}/${c.classId}`));
  const classesLeftOut = infra ? [] : plan.classes.filter((c) => !hunted.has(`${c.pack}/${c.classId}`)).map(({ pack, packVersion, classId, title }) => ({ pack, packVersion, classId, title }));
  const systems = [{ id: systemId, type: system.type, kind: infra ? 'host' : 'code' }];
  const common = { project: slug, runId: id, repoRoot, systems, layer, runDir: dir, effort, agentCap: WORKFLOW_AGENT_CAP };

  if (infra) {
    const hunters = [{ key: infraKey(systemId), system: systemId, unit: null, units: units.map((u) => u.id), classId: null, pack: null, packVersion: null }];
    writeAtomic(path.join(dir, 'units.json'), toJson({ layer, effort, system: systemId, repoRoot, units, classes, classesLeftOut, hunters }));
    return {
      runId: id,
      runDir: dir,
      prober: {
        system: { id: systemId, type: system.type, host: hostNameOf(system) },
        observationsPath: path.join(dir, 'observations.json'),
        outputPath: path.join(dir, 'candidates', `${infraKey(systemId)}.json`),
      },
      args: {
        ...common,
        units: units.map((u) => ({ system: systemId, unit: u.id, files: null })),
        classes: classes.map(({ pack, packVersion, classId, title, text }) => ({ pack, packVersion, classId, title, text })),
        baseline: baselineOf(packs),
      },
    };
  }

  const { groups, bundles, skipped, changes, notHunted } = hunt;
  const hunters = groups.flatMap((g) => bundles.map((b) => ({
    key: hunterKey(g.id, b.id), system: systemId, group: g.id, bundle: b.id, units: g.units, classIds: b.classIds,
    classes: b.classIds.map((classId) => ({ pack: b.pack, packVersion: b.packVersion, classId })),
  })));
  // A unit records how much hunt-worthy source it has; an L2 unit also keeps the files its hunters read (assemble closes a finding
  // only in those files). An L3 unit records whether its source changed since the run that last covered it (assemble then drops
  // the classes earlier runs hunted on it), and a unit skipped as unchanged is written with status `unchanged` and that run.
  // A unit whose source is all over the size cap is written `not-hunted`: planned, so it counts against the run's coverage.
  const unitDoc = (u) => {
    const { paths, sizes, ...rest } = u;
    const out = layer === 'L2' ? { ...rest, paths } : rest;
    const c = changes.get(u.id);
    if (c) out.changed = c.changed;
    return out;
  };
  const skippedIds = new Set(skipped.map((u) => u.id));
  const notHuntedIds = new Set(notHunted.map((u) => u.id));
  const unitsDoc = units.map((u) => {
    if (skippedIds.has(u.id)) return { ...unitDoc(u), status: 'unchanged', coveredBy: changes.get(u.id).coveredBy, skipReason: changes.get(u.id).reason };
    if (notHuntedIds.has(u.id)) return { ...unitDoc(u), status: 'not-hunted', reason: `all its source is over the size cap (${(u.oversize || []).length} file${(u.oversize || []).length === 1 ? '' : 's'})` };
    return unitDoc(u);
  });
  const ex = plan.excluded || { counts: {}, oversize: [], present: [], submodules: [] };
  writeAtomic(path.join(dir, 'units.json'), toJson({
    layer, effort, system: systemId, repoRoot, full: Boolean(full), engine: huntPlan.HUNT_ENGINE, units: unitsDoc, classes, classesLeftOut,
    groups: groups.map(({ id: gid, units: gu, paths, present, bytes, reachable }) => ({ id: gid, units: gu, paths, present, bytes, reachable })),
    bundles, hunters,
    // What the hunt did not read, and why: counts per class of non-code file, each source file over the size cap, files that may
    // hold credentials outside any unit, and submodules that are not checked out.
    excluded: { byClass: ex.counts, oversize: ex.oversize, present: ex.present, submodules: ex.submodules },
  }));
  const wanted = new Set(bundles.flatMap((b) => b.classIds.map((c) => `${b.pack}/${c}`)));
  const argsClasses = classes.filter((c) => wanted.has(`${c.pack}/${c.classId}`)).map(({ pack, packVersion, classId, title, text }) => ({ pack, packVersion, classId, title, text }));
  const argsBundles = bundles.map((b) => ({ bundle: b.id, pack: b.pack, classIds: b.classIds }));
  const batched = batchUnits(groups, bundles.length);
  return {
    runId: id,
    runDir: dir,
    plan: { units: units.length, skippedUnchanged: skipped.length, notHunted: notHunted.length, groups: groups.length, bundles: bundles.length, hunters: hunters.length },
    batches: batched.map((list, i) => ({
      ...common,
      groups: list.map((g) => ({ group: g.id, units: g.units, paths: g.paths, present: g.present, bytes: g.bytes })),
      bundles: argsBundles,
      classes: argsClasses,
      batch: { index: i + 1, of: batched.length },
    })),
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
      // Only an answer counts: a permission error, a daemon that is down or a 503 from the edge says nothing about the setting.
      if (seen.ok !== true) {
        const status = seen.via === 'http' && isText(seen.text) ? /^HTTP (\d{3})\b/.exec(seen.text) : null;
        const how = status ? ` (HTTP ${status[1]})` : Number.isInteger(seen.exitCode) ? ` (exit ${seen.exitCode})` : '';
        return { ...u, status: 'failed', reason: `probe returned an error${how}, which says nothing about the setting` };
      }
      if (!returned) return { ...u, status: 'failed', reason: 'hunter did not return: infra-prober' };
      return { ...u, status: 'covered' };
    });
  }
  // A unit init skipped as unchanged keeps that status: no hunter was planned for it. Any other unit is covered only when every
  // hunter planned over it returned (a group hunter that died fails every unit of its group).
  // Each hunter file is read once, not once per unit.
  const back = new Map(hunters.map((h) => [h.key, hunterReturned(dir, h.key)]));
  return doc.units.map((u) => {
    if (u.status === 'unchanged' || u.status === 'not-hunted') return u;
    const mine = hunters.filter((h) => unitsOfHunter(h).includes(u.id));
    const missing = mine.filter((h) => !back.get(h.key)).map((h) => (h.group ? h.key : h.classId));
    if (!mine.length) return { ...u, status: 'failed', reason: 'no hunter was planned for it' };
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
    for (const id of h ? unitsOfHunter(h) : []) invalidIn.set(id, (invalidIn.get(id) || 0) + 1);
  }
  // A hunter that returned the most candidates it may (20 for a group hunter, 10 for the INFRA prober and an older one-class
  // hunter) may have stopped there: what it did not report is no evidence of a fix, so its units (for the INFRA prober, every
  // probe unit of the system) close nothing, and the report says so.
  const capOf = (h) => (doc.layer === 'INFRA' || !h.group ? MAX_PROBER_CANDIDATES : MAX_CANDIDATES);
  const cappedIn = new Set();
  for (const h of doc.hunters || []) {
    if (candidates.filter((c) => c.hunter.agent === h.key).length >= capOf(h)) for (const id of unitsOfHunter(h)) cappedIn.add(id);
  }
  const units = judgeUnits(doc, dir).map((u) => {
    let out = invalidIn.has(u.id) ? { ...u, invalid: invalidIn.get(u.id) } : u;
    if (cappedIn.has(u.id)) out = { ...out, capped: true };
    return out;
  });
  const covered = units.filter((u) => u.status === 'covered');
  // Units skipped as unchanged count as covered for the run's coverage credit (their ledger entry stands), but close nothing:
  // this run did not look at them. Units not hunted (all their source over the size cap) are planned and not covered.
  const unchanged = units.filter((u) => u.status === 'unchanged');
  const notHunted = units.filter((u) => u.status === 'not-hunted');
  const closable = covered.filter((u) => !u.invalid && !u.capped);
  const t = tally(candidates, votes);
  // A covered unit's hunt is complete only when nothing in it was left open: no capped hunter, no invalid entry, and every
  // candidate in it decided with at least two votes. Only a complete entry lets a later L3 run skip the unit as unchanged.
  const unsettled = new Set();
  for (const e of t.undecided) unsettled.add(e.candidate.hunter.unit);
  for (const e of [...t.verified, ...t.rejected]) if (e.votes.length < 2) unsettled.add(e.candidate.hunter.unit);
  const completeOf = (u) => !u.capped && !u.invalid && !unsettled.has(u.id);

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
    // A code finding closes only where this run looked for it: a closable unit holding its file (for L2, a file the unit's hunters
    // read) whose returned hunters include the finding's class and, for a group hunter, read that file (a file the source filter
    // left out, or one of a split unit's other group, was not read). A prompt-injection finding belongs to no class: any returned
    // hunter of the unit that read that file read that code.
    const returned = (doc.hunters || []).filter((h) => hunterReturned(dir, h.key));
    const readFile = (h, p) => {
      if (!h.group) return true;
      const g = groupOf(doc, h);
      return Boolean(g && [...(g.paths || []), ...(g.present || [])].includes(p));
    };
    const lookedFor = (f, u) => returned.some((h) => unitsOfHunter(h).includes(u.id) && readFile(h, f.location.path)
      && (f.ruleId === INJECTION_RULE || ruleIdsOfHunter(h).includes(f.ruleId)));
    const inFiles = (f, u) => doc.layer !== 'L2' || (Array.isArray(u.paths) && u.paths.includes(f.location.path));
    // A candidate of this run at the same place (any class, whatever its verdict) keeps a finding open: a bundle hunter may have
    // reported the same flaw under another class of its bundle, which gives it another id.
    const sameSpot = (f) => candidates.some((c) => c.location && c.location.path === f.location.path
      && (!c.location.symbol || !f.location.symbol || c.location.symbol === f.location.symbol));
    const inCovered = (f) => f.location && typeof f.location.path === 'string' && !sameSpot(f)
      && closable.some((u) => coverage.unitContains(u.id, f.location.path) && inFiles(f, u) && lookedFor(f, u));
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
  // A covered unit records the classes hunted on it (every class of the run for INFRA, whose one prober reads them all) and the
  // effort, so gaps() still lists it until the classes a lower effort left out are hunted too.
  const effort = ['low', 'medium', 'high'].includes(doc.effort) ? doc.effort : undefined;
  const classesOf = (u) => (infra ? (doc.classes || []).map((c) => c.classId) : (doc.hunters || []).filter((h) => unitsOfHunter(h).includes(u.id)).flatMap(classIdsOfHunter));
  // A unit whose source changed since the run that last covered it starts its class list afresh. Unchanged units keep their entry.
  const changed = units.filter((u) => u.changed === true).map((u) => u.id);
  const engine = !infra && typeof doc.engine === 'string' ? doc.engine : undefined;
  for (const u of units.filter((x) => x.status === 'covered')) {
    ledger = coverage.markCovered(ledger, {
      system: doc.system, layer: doc.layer, units: [u], runId, packs, status: 'covered', classes: [...new Set(classesOf(u))], effort, changed,
      ...(engine ? { engine, complete: completeOf(u) } : {}),
    });
  }
  // A unit that could not be hunted (its source is over the size cap) is a gap in the ledger, as a failed hunt is.
  const failedUnits = units.filter((u) => u.status === 'failed' || u.status === 'not-hunted');
  if (failedUnits.length) ledger = coverage.markCovered(ledger, { system: doc.system, layer: doc.layer, units: failedUnits, runId, packs, status: 'failed', effort });
  store.writeCoverage(slug, ledger);
  writeAtomic(path.join(dir, 'units.json'), toJson({ ...doc, units }));
  // The run's own finding list (ids only): the report reads it, since a finding's lastSeen moves on with every later run. The
  // candidate ids the verifiers rejected or left undecided are kept beside it, as the record of what the tally did with each.
  const idsOf = (bucket) => bucket.map((e) => e.candidate.candidateId);
  writeAtomic(path.join(dir, 'findings.json'), toJson({ verified: findings.map((f) => f.id), closed: closedIds, rejected: idsOf(t.rejected), undecided: idsOf(t.undecided) }));

  const counts = {
    added: upserted.added, updated: upserted.updated, unchanged: upserted.unchanged,
    hardening: findings.filter((f) => f.class === 'hardening').length,
    closed,
    candidates: t.verified.length + t.rejected.length + t.undecided.length,
    verified: t.verified.length, rejected: t.rejected.length, undecided: t.undecided.length,
    invalid: invalid.length,
  };
  // A run that covered fewer than half its planned units is not a finished audit of the layer: it finishes failed, though the units it did cover keep their place in the ledger and their closes.
  const credited = covered.length + unchanged.length;
  const reason = credited === 0 ? 'no unit was covered' : credited < units.length / 2 ? `only ${credited} of ${units.length} units were covered` : null;
  // A done run with failed units is credited only for the share it covered (score.cjs), units skipped as unchanged included; a
  // skipped INFRA probe does not apply to the host, so it counts on neither side. A directory with no hunt-worthy file was never a
  // unit of the run, so it counts on neither side either.
  const unitCoverage = { planned: units.filter((u) => u.status !== 'skipped').length, covered: credited };
  store.finishRun(slug, runId, reason ? { status: 'failed', reason, counts, coverage: unitCoverage } : { status: 'done', counts, coverage: unitCoverage });
  return { counts, invalid, findings: findings.map((f) => f.id), skipped: units.filter((u) => ['failed', 'skipped', 'not-hunted'].includes(u.status)) };
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
  'usage: node scripts/hunt-io.cjs init --project <slug> --system <id> --layer L2|L3|INFRA [--effort low|medium|high] [--repo <path>] [--base <ref>] [--run <runId>] [--full] [--dry-run] [--json]',
  '       node scripts/hunt-io.cjs assemble --project <slug> --run <runId> [--json]',
  '       node scripts/hunt-io.cjs list --project <slug> --run <runId> [--json]',
  '       node scripts/hunt-io.cjs init-verify --project <slug> (--finding <id> | --system <id> --all) [--repo <path>] [--json]',
  '       node scripts/hunt-io.cjs reverify --project <slug> --run <runId> [--finding <id>] [--json]',
  '       node scripts/hunt-io.cjs estimate --project <slug> [--json]',
].join('\n');

class UsageError extends Error {}

const OPTIONS = {
  init: ['project', 'system', 'layer', 'effort', 'repo', 'base', 'run'],
  assemble: ['project', 'run'],
  list: ['project', 'run'],
  'init-verify': ['project', 'system', 'finding', 'repo'],
  reverify: ['project', 'run', 'finding'],
  estimate: ['project'],
};
const FLAGS = { init: ['dry-run', 'full'], 'init-verify': ['all'] };

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
  const required = command === 'init' ? ['project', 'system', 'layer'] : command === 'init-verify' || command === 'estimate' ? ['project'] : ['project', 'run'];
  for (const name of required) if (values[name] === undefined) throw new UsageError(`--${name} is required`);
  return { command, ...values };
}

function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const o = parse(argv);
    let result;
    if (o.command === 'init') {
      if (o.full && o.layer !== 'L3') throw new UsageError('--full applies to L3 only');
      const opts = { system: o.system, layer: o.layer, effort: o.effort, repo: o.repo, base: o.base, runId: o.run, full: Boolean(o.full) };
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
    } else if (o.command === 'estimate') {
      result = estimateProject(o.project);
      const skips = result.skipped.map((x) => `${x.system} ${x.layer} (${x.reason})`).join('; ');
      stdout.write(o.json
        ? `${JSON.stringify({ estimated: result.estimated, skipped: result.skipped }, null, 2)}\n`
        : `estimated ${result.estimated.length} layer(s); skipped ${result.skipped.length}${skips ? `: ${skips}` : ''}\n`);
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
  LOW_CLASSES, TOKENS_PER_AGENT, WORKFLOW_AGENT_CAP, HUNTERS_PER_WORKFLOW, MAX_CANDIDATES, MAX_PROBER_CANDIDATES, batchUnits, fileKey, hunterKey, infraKey,
  ingest, writeCandidate, writeVote, readCandidates, readVotes, tally, initRun, dryRun, assemble,
  listCandidates, initVerify, reverify, estimateProject, main,
};
