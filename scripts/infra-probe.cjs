'use strict';
// INFRA probe runner: runs a host pack's read-only probes (over ssh, http, or on this machine), scrubs what they print, stores
// the scrubbed text under raw/ and writes observations.json into an audit run directory. The infra-prober agent reads those
// observations; hunt-io assemble judges the probe units from observations.json.
//   node scripts/infra-probe.cjs --project <slug> --system <id> [--probe <id>]... [--run <id>] [--json]
// --run uses the run hunt-io init created (it is finished by the audit, not here); without it the runner creates its own run
// (job audit, layer INFRA) and finishes it done. In a cloud session (CLAUDE_CODE_REMOTE=true) nothing runs: exit 2. A first probe that cannot reach the host (ssh refused, BatchMode auth failure,
// timeout, no http answer) marks the run skipped, with the reason, either way: exit 2. A later probe that fails that way is
// recorded in skipped[] and the run goes on. A probe that exits non-zero (other than an exit code its pack lists in okExit), or an
// http probe answered with a 5xx, is an observation with ok false; its text is kept, and assemble does not count its unit covered.
//
// What runs is only what the pack declares: the ssh command is built from the probe's argv, each element single-quoted, and
// nothing else except the one owner-attested field behind <sitePath> (host.sitePath, charset-checked). Target and URL come from
// project.json. Output never reaches disk or the caller unscrubbed: `scrub: env` reduces NAME=value lines to NAME=[set], and
// everything goes through redact().

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { which, run } = require('./lib/exec.cjs');
const { redact } = require('./lib/redact.cjs');
const { writeAtomic } = require('./lib/atomic.cjs');
const { runDir } = require('./lib/paths.cjs');
const { resolveSystem, firstLine, UsageError } = require('./lib/l1-common.cjs');
const { packsFor } = require('./packs.cjs');
const store = require('./store.cjs');

const DEFAULT_TIMEOUT_MS = 20000;
const HTTP_TIMEOUT_MS = 15000;
const MAX_TEXT = 100000;
const SITE_PATH_RE = /^[A-Za-z0-9._/-]+$/; // relative to the ssh user's home, or absolute; no ~ (single quotes stop tilde expansion)
const SITE_PATH_TOKEN = '<sitePath>';
const DEFAULT_SITE_PATH = 'public_html';
const SSH_TARGET_RE = /^[^\s-]\S*$/; // one argv element that cannot read as an option
// Assignment forms a scrub:env probe may print: [path:][export ]["]NAME[ ]=[ ]value, JSON "name": "value", and YAML-ish NAME: value.
const ENV_ASSIGN = /^(\s*(?:export\s+)?(?:[^\s=:"']+:)?)\s*["']?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/;
const JSON_STRING_PAIR = /^(\s*)"([^"]+)"\s*:\s*"(.*)$/;
const YAML_PAIR = /^(\s*)([A-Z_][A-Z0-9_.]*):\s+(\S.*)$/;
const USAGE = 'usage: node scripts/infra-probe.cjs --project <slug> --system <id> [--probe <id>]... [--run <id>] [--json]';

// ---- argv and scrubbing ---------------------------------------------------------------------

const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

function sitePathOf(system) {
  const p = system.host && system.host.sitePath;
  return typeof p === 'string' && SITE_PATH_RE.test(p) && !p.split('/').includes('..') ? p : DEFAULT_SITE_PATH;
}

const argvOf = (probe, system) => probe.argv.map((a) => a.split(SITE_PATH_TOKEN).join(sitePathOf(system)));

// A command answers ok with exit 0, or with an exit code its pack lists in okExit (a grep for risky settings exits 1 when it selected
// no line, which its expect line calls healthy; a grep whose empty output is not healthy declares nothing). An http probe answers ok
// with any status below 500: a 5xx from the edge or the app says nothing about the setting it was sent to look at.
const answeredOk = (probe, out) => (probe.via === 'http'
  ? Number.isInteger(out.status) && out.status < 500
  : out.exitCode === 0 || (Array.isArray(probe.okExit) && probe.okExit.includes(out.exitCode)));

// Every assignment becomes NAME=[set] (NAME= when the value is empty). Handled: CRLF, `export`, spaces around `=`, a grep `path:` prefix,
// "NAME=value", JSON string pairs ("name": "value"; booleans, numbers and arrays stay, they are settings, not secrets) and
// NAME: value. A value that opens a quote it does not close on the same line swallows the following lines up to the closing
// quote, and NAME=[set] is printed once. `NAME value` lines (the pack templates' allowlisted settings) and other text pass.
function scrubEnv(text) {
  const out = [];
  let closing = null;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    if (closing !== null) {
      if (raw.trimEnd().endsWith(closing)) closing = null;
      continue;
    }
    let m = ENV_ASSIGN.exec(raw);
    if (m) {
      const value = m[3].trim();
      const q = value[0] === '"' || value[0] === "'" ? value[0] : null;
      if (q !== null && (value.length === 1 || !value.endsWith(q))) closing = q;
      out.push(`${m[1]}${m[2]}=${value.replace(/^["']|["',;\s]+$/g, '') === '' ? '' : '[set]'}`);
      continue;
    }
    m = JSON_STRING_PAIR.exec(raw);
    if (m) {
      out.push(`${m[1]}${m[2]}=${/^",?\s*$/.test(m[3]) ? '' : '[set]'}`);
      continue;
    }
    m = YAML_PAIR.exec(raw);
    out.push(m ? `${m[1]}${m[2]}=[set]` : raw);
  }
  return out.join('\n');
}

function scrubText(probe, text) {
  const scrubbed = redact(probe.scrub === 'env' ? scrubEnv(text) : text);
  return scrubbed.length > MAX_TEXT ? `${scrubbed.slice(0, MAX_TEXT)}\n[output cut by rampart]` : scrubbed;
}

// ---- one probe, by transport ----------------------------------------------------------------
// Each returns {text, exitCode} for an answer, or {unreachable: reason} when the host could not be asked, or {refused: reason}
// when the probe cannot run for this system.

function viaSsh(probe, system, timeoutMs) {
  const target = system.host && system.host.ssh;
  if (typeof target !== 'string' || !SSH_TARGET_RE.test(target)) return { refused: 'system has no usable host.ssh target' };
  const ssh = which('ssh', 'RAMPART_SSH');
  if (!ssh) return { unreachable: 'ssh is not installed' };
  const remote = argvOf(probe, system).map(shellQuote).join(' ');
  return execute(ssh, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, '--', remote], timeoutMs, 'ssh could not connect', (r) => r.code === 255);
}

function viaLocal(probe, system, timeoutMs) {
  if (system.type !== 'docker-host' || (system.host && system.host.ssh)) return { refused: 'local probes run only for a docker-host system with no host.ssh' };
  const [cmd, ...args] = argvOf(probe, system);
  return execute(cmd, args, timeoutMs, 'command failed', () => false);
}

function execute(cmd, args, timeoutMs, failure, isConnectFailure) {
  let r;
  try {
    r = run(cmd, args, { timeoutMs });
  } catch (err) {
    return { unreachable: `${failure}: ${err.code || 'could not start'}` };
  }
  if (r.timedOut) return { unreachable: `probe timed out after ${timeoutMs} ms` };
  if (isConnectFailure(r)) {
    const line = firstLine(r.stderr);
    return { unreachable: line ? `${failure}: ${line}` : failure };
  }
  return { text: r.stdout + (r.stderr ? `${r.stdout && !r.stdout.endsWith('\n') ? '\n' : ''}${r.stderr}` : ''), exitCode: r.code };
}

// Status line and headers only; cookie values are dropped at once.
async function viaHttp(probe, system) {
  const live = system.live && system.live.url;
  if (typeof live !== 'string') return { refused: 'system has no live.url' };
  const method = String(probe.argv[0]).toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return { refused: 'http probe method must be GET or HEAD' };
  const rel = typeof probe.path === 'string' ? probe.path : '';
  let url;
  try {
    url = new URL(live.replace(/\/+$/, '') + (rel === '' || rel.startsWith('/') ? rel : `/${rel}`));
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) throw new Error('bad url');
  } catch {
    return { refused: 'live.url is not a usable http(s) URL' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, redirect: 'manual', signal: controller.signal });
    try { if (res.body) await res.body.cancel(); } catch { /* headers are in hand */ }
    const kept = [`HTTP ${res.status}`];
    for (const [name, value] of res.headers) if (name !== 'set-cookie') kept.push(`${name}: ${value}`);
    const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of cookies) kept.push(`set-cookie: ${c.replace(/^([^=;]*)=[^;]*/, '$1=[set]')}`);
    return { text: kept.join('\n'), exitCode: 0, status: res.status };
  } catch (err) {
    const aborted = controller.signal.aborted || (err && err.name === 'AbortError');
    const cause = err && err.cause;
    const code = (cause && (cause.code || (cause.errors && cause.errors[0] && cause.errors[0].code))) || (err && err.code) || 'fetch failed';
    return { unreachable: aborted ? `probe timed out after ${HTTP_TIMEOUT_MS} ms` : `http request failed: ${code}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---- the runner -----------------------------------------------------------------------------

// Run the probes of one host system and record them. pack is a pack or an array of packs; probes (ids) narrows them, in the order
// given, and an id no pack declares is a RangeError before anything is created. runId reuses an existing run.
// Returns {run, observations: [{probeId, via, ok, exitCode, durationMs, text, rawPath}], skipped: [{probeId, reason}]}.
async function runProbes({ project, system, pack, probes, timeoutMs = DEFAULT_TIMEOUT_MS, runId } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('timeoutMs must be a whole number of milliseconds');
  // Spec 5.8: infra jobs never go to a cloud executor (Claude Code cloud sessions set CLAUDE_CODE_REMOTE). Refused before any
  // run is created, read or finished, and before any probe, extra probes included.
  if (process.env.CLAUDE_CODE_REMOTE === 'true') throw new RangeError('INFRA probes never run on a cloud executor; run them from a local session');
  const ctx = resolveSystem(project, system);
  if (!ctx.project.ownerAttestation || typeof ctx.project.ownerAttestation.statement !== 'string' || ctx.project.ownerAttestation.statement.trim() === '') {
    throw new RangeError(`project ${project} has no ownerAttestation; add the owner statement before probing`);
  }
  const declared = [].concat(pack || []).flatMap((p) => p.probes || []);
  const chosen = probes === undefined ? declared : probes.map((id) => {
    const found = declared.find((p) => p.id === id);
    if (!found) throw new RangeError(`probe ${id} is not declared by the pack`);
    return found;
  });
  if (chosen.length === 0) throw new RangeError('no probes to run');
  if (runId !== undefined && !store.readRuns(project).some((r) => r.runId === runId)) throw new RangeError(`run ${runId} not found in project ${project}`);

  const own = runId === undefined;
  const run0 = own ? store.createRun(project, { job: 'audit', layers: ['INFRA'], systems: [system], executor: 'local' }) : { runId };
  const id = run0.runId;
  // With --run and an observations.json already there (the full pass), this call adds to it: a probe run again replaces its
  // earlier entry, and the run is never finished or skipped here.
  const file = path.join(runDir(project, id), 'observations.json');
  let before = null;
  if (!own) {
    try { before = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { before = null; }
    if (before !== null && (typeof before !== 'object' || !Array.isArray(before.observations) || !Array.isArray(before.skipped))) before = null;
  }
  const merging = before !== null;
  const observations = merging ? [...before.observations] : [];
  const skipped = merging ? [...before.skipped] : [];
  const put = (list, entry) => {
    const at = list.findIndex((e) => e.probeId === entry.probeId);
    if (at === -1) list.push(entry); else list[at] = entry;
  };
  const drop = (list, probeId) => {
    const at = list.findIndex((e) => e.probeId === probeId);
    if (at !== -1) list.splice(at, 1);
  };
  const note = (probeId, reason) => { drop(observations, probeId); put(skipped, { probeId, reason }); };
  let abort = null;
  let attempted = false;
  try {
    for (const [i, probe] of chosen.entries()) {
      const started = Date.now();
      const out = probe.via === 'http' ? await viaHttp(probe, ctx.system)
        : probe.via === 'local' ? viaLocal(probe, ctx.system, timeoutMs)
          : viaSsh(probe, ctx.system, timeoutMs);
      if (out.refused) { note(probe.id, out.refused); continue; }
      const first = !attempted; // the first probe that really tried to reach the host
      attempted = true;
      if (out.unreachable) {
        const reason = redact(out.unreachable);
        note(probe.id, reason);
        if (first && !merging) {
          abort = reason;
          for (const rest of chosen.slice(i + 1)) note(rest.id, 'not run: host unreachable');
          break;
        }
        continue;
      }
      const text = scrubText(probe, out.text);
      const rawPath = store.writeRaw(project, id, `probe-${probe.id}.txt`, text);
      drop(skipped, probe.id);
      put(observations, { probeId: probe.id, via: probe.via, ok: answeredOk(probe, out), exitCode: out.exitCode, durationMs: Date.now() - started, text, rawPath });
    }
    writeAtomic(file, `${JSON.stringify({ observations, skipped }, null, 2)}\n`);
    let finished = run0;
    if (abort !== null) finished = store.finishRun(project, id, { status: 'skipped', reason: abort });
    else if (own) finished = store.finishRun(project, id, { status: 'done' });
    else finished = store.readRuns(project).find((r) => r.runId === id);
    return { run: finished, observations, skipped };
  } catch (err) {
    if (own) {
      try { store.finishRun(project, id, { status: 'failed', reason: redact(`${err.name}: ${err.message}`) }); } catch { /* the original error is the one worth seeing */ }
    }
    throw err;
  }
}

// ---- CLI ------------------------------------------------------------------------------------

function parse(argv) {
  let values;
  try {
    ({ values } = util.parseArgs({
      args: argv,
      options: { project: { type: 'string' }, system: { type: 'string' }, probe: { type: 'string', multiple: true }, run: { type: 'string' }, json: { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new UsageError(err.message.split('\n')[0]);
  }
  for (const name of ['project', 'system']) if (values[name] === undefined) throw new UsageError(`--${name} is required`);
  return values;
}

async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const opts = parse(argv);
    const { system } = resolveSystem(opts.project, opts.system);
    const packs = packsFor(system).filter((p) => (p.kinds || []).includes('host'));
    if (!packs.length) throw new RangeError(`system ${opts.system} has no host pack`);
    const { run: r, observations, skipped } = await runProbes({ project: opts.project, system: opts.system, pack: packs, probes: opts.probe, runId: opts.run });
    const brief = observations.map(({ text, ...rest }) => rest);
    if (opts.json) stdout.write(`${JSON.stringify({ run: r, observations: brief, skipped }, null, 2)}\n`);
    else {
      stdout.write(`infra-probe ${opts.project}/${opts.system}: ${r.status} (run ${r.runId})\n`);
      if (r.status === 'skipped') stdout.write(`reason: ${r.reason}\n`);
      stdout.write(`${observations.length} observed, ${skipped.length} skipped\n`);
      for (const s of skipped) stdout.write(`skipped ${s.probeId}: ${s.reason}\n`);
    }
    return r.status === 'skipped' ? 2 : 0;
  } catch (err) {
    stderr.write(`infra-probe: ${redact(err.message)}\n`);
    if (err instanceof UsageError) stderr.write(`${USAGE}\n`);
    return err instanceof UsageError || err instanceof RangeError ? 2 : 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { runProbes, main };
