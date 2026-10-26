'use strict';
// INFRA probe runner: runs a host pack's read-only probes (over ssh, http, or on this machine), scrubs what they print, stores
// the scrubbed text under raw/ and writes observations.json into an audit run directory. The infra-prober agent reads those
// observations; hunt-io assemble judges the probe units from observations.json.
//   node scripts/infra-probe.cjs --project <slug> --system <id> [--probe <id>]... [--run <id>] [--json]
// --run uses the run hunt-io init created (it is finished by the audit, not here); without it the runner creates its own run
// (job audit, layer INFRA) and finishes it done. A first probe that cannot reach the host (ssh refused, BatchMode auth failure,
// timeout, no http answer) marks the run skipped, with the reason, either way: exit 2. A later probe that fails that way is
// recorded in skipped[] and the run goes on. A probe that exits non-zero is an observation with ok false; its text is kept.
//
// What runs is only what the pack declares: the ssh command is built from the probe's argv, each element single-quoted, and
// nothing else except the one owner-attested field behind <sitePath> (host.sitePath, charset-checked). Target and URL come from
// project.json. Output never reaches disk or the caller unscrubbed: `scrub: env` reduces NAME=value lines to NAME=[set], and
// everything goes through redact().

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
const SITE_PATH_RE = /^[A-Za-z0-9._/~-]+$/;
const SITE_PATH_TOKEN = '<sitePath>';
const DEFAULT_SITE_PATH = 'public_html';
const SSH_TARGET_RE = /^[^\s-]\S*$/; // one argv element that cannot read as an option
const ENV_LINE = /^(\s*[A-Za-z_][A-Za-z0-9_.]*)=(.*)$/;
const USAGE = 'usage: node scripts/infra-probe.cjs --project <slug> --system <id> [--probe <id>]... [--run <id>] [--json]';

// ---- argv and scrubbing ---------------------------------------------------------------------

const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

function sitePathOf(system) {
  const p = system.host && system.host.sitePath;
  return typeof p === 'string' && SITE_PATH_RE.test(p) && !p.split('/').includes('..') ? p : DEFAULT_SITE_PATH;
}

const argvOf = (probe, system) => probe.argv.map((a) => a.split(SITE_PATH_TOKEN).join(sitePathOf(system)));

// NAME=value becomes NAME=[set] (NAME= stays empty); lines that are not assignments pass unchanged.
function scrubEnv(text) {
  return text.split('\n').map((line) => {
    const m = ENV_LINE.exec(line);
    return m ? (m[2].trim() === '' ? `${m[1]}=` : `${m[1]}=[set]`) : line;
  }).join('\n');
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
    return { text: kept.join('\n'), exitCode: 0 };
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
  const observations = [];
  const skipped = [];
  let abort = null;
  try {
    for (const [i, probe] of chosen.entries()) {
      const started = Date.now();
      const out = probe.via === 'http' ? await viaHttp(probe, ctx.system)
        : probe.via === 'local' ? viaLocal(probe, ctx.system, timeoutMs)
          : viaSsh(probe, ctx.system, timeoutMs);
      if (out.refused) { skipped.push({ probeId: probe.id, reason: out.refused }); continue; }
      if (out.unreachable) {
        const reason = redact(out.unreachable);
        skipped.push({ probeId: probe.id, reason });
        if (i === 0) { abort = reason; for (const rest of chosen.slice(1)) skipped.push({ probeId: rest.id, reason: 'not run: host unreachable' }); break; }
        continue;
      }
      const text = scrubText(probe, out.text);
      const rawPath = store.writeRaw(project, id, `probe-${probe.id}.txt`, text);
      observations.push({ probeId: probe.id, via: probe.via, ok: out.exitCode === 0, exitCode: out.exitCode, durationMs: Date.now() - started, text, rawPath });
    }
    writeAtomic(path.join(runDir(project, id), 'observations.json'), `${JSON.stringify({ observations, skipped }, null, 2)}\n`);
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
