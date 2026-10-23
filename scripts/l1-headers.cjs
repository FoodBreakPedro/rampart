'use strict';
// L1 live security-headers check: one GET of a system's live URL, graded against the rubric in lib/headers-rubric.cjs, the
// failed checks turned into hardening findings in the store.
//   node scripts/l1-headers.cjs --project <slug> --system <id> [--url <url>] [--json]
// --url overrides the live URL recorded for the system (live.url); one of the two is needed, and only http: and https: URLs are
// accepted. Redirects are followed and the final response is the one graded: the run records both URLs.
// The final URL is kept as origin and path only (no query, no fragment): that is what findings, the score and the raw copy
// name, so a redirect to /login?state=<random> neither stores a token nor gives every run new finding ids.
// Exit 0: the run is done. Exit 2: the run was skipped (timeout, connection refused, DNS or TLS failure, ...) or the arguments
// were bad. Exit 1: anything unexpected.
//
// A response with an error status (404, 500) is graded all the same, because its headers are real; the run's reason says so.
// A finished check also closes the system's earlier headers findings that this response no longer shows (store.closeMissing):
// they become fixed, with a record in dispositions.json, and counts.closed says how many. A skipped check closes nothing.
// Only the headers are read: the body is dropped unread. Cookie values are scrubbed from the response as soon as it arrives,
// so they are not graded, stored, printed or passed on; the raw copy keeps each cookie's name and attributes.
// Nothing from the response except counts, the grade, the URLs and file paths is ever printed.

const path = require('node:path');
const util = require('node:util');
const { runDir } = require('./lib/paths.cjs');
const { redact, REDACTED } = require('./lib/redact.cjs');
const { gradeHeaders } = require('./lib/headers-rubric.cjs');
const common = require('./lib/l1-common.cjs');
const { fromHeaders } = require('./normalize.cjs');
const store = require('./store.cjs');

const { resolveSystem, firstLine, markFailed, UsageError, runCli } = common;

const RAW_NAME = 'headers.json';
const DEFAULT_TIMEOUT_MS = 15 * 1000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1; // what setTimeout can hold
const USER_AGENT = 'Rampart/0.1 (+https://github.com/<owner>/rampart)';
const ACCEPT = 'text/html,*/*';
// A comma starts a new cookie only when a name= follows, so the comma in Expires=Wed, 21 Oct 2026 ... stays put (as in the rubric).
const COOKIE_BOUNDARY = /,(?=\s*[^;,\s=]+=)/;

// ---- the request --------------------------------------------------------------------------

// The URL to check, or a RangeError: from --url when given, else from the system's live.url. Messages say where the URL came
// from and never quote it, because it may carry a credential.
function resolveUrl(system, url) {
  const explicit = url !== undefined && url !== null;
  const label = explicit ? '--url' : `live.url of system ${system.id}`;
  const raw = explicit ? url : system.live && system.live.url;
  if (raw === undefined || raw === null) throw new RangeError(`system ${system.id} has no live.url; pass --url`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RangeError(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new RangeError(`${label} must be an http: or https: URL`);
  if (parsed.username !== '' || parsed.password !== '') throw new RangeError(`${label} must not contain credentials`);
  return parsed.href;
}

// Everything that can be wrong with the arguments is checked here, before a run exists, so a typo leaves nothing behind.
function resolveTarget({ project, system, url, timeoutMs }) {
  const resolved = resolveSystem(project, system);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS}`);
  }
  return { url: resolveUrl(resolved.system, url) };
}

// The page a response came from as findings and scores name it: origin and path, without query or fragment (a redirect target
// can carry a one-time token there) and without credentials.
function pageOf(responseUrl) {
  const { origin, pathname } = new URL(responseUrl);
  return `${origin}${pathname}`;
}

// One Set-Cookie line with its value replaced: the name and the attributes stay, so the raw copy still shows which cookie
// lacks Secure or HttpOnly. A line without a name=value pair is replaced whole.
function scrubCookie(line) {
  const semicolon = line.indexOf(';');
  const pair = semicolon === -1 ? line : line.slice(0, semicolon);
  const rest = semicolon === -1 ? '' : line.slice(semicolon);
  const equals = pair.indexOf('=');
  return `${equals === -1 ? REDACTED : `${pair.slice(0, equals)}=${REDACTED}`}${rest}`;
}

// The response headers as the plain object the rubric and the normalizer need (they refuse a fetch Headers): lower-case names,
// string values, and set-cookie as an array of the cookie lines with their values scrubbed. Iterating a Headers object gives
// one entry per Set-Cookie line and Object.fromEntries keeps only the last, so the lines come from getSetCookie() when there is one.
function plainHeaders(responseHeaders) {
  const headers = Object.fromEntries(responseHeaders);
  const lines = typeof responseHeaders.getSetCookie === 'function' ? responseHeaders.getSetCookie() : [];
  if (lines.length > 0) headers['set-cookie'] = lines;
  if (headers['set-cookie'] !== undefined) {
    const cookies = Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : String(headers['set-cookie']).split(COOKIE_BOUNDARY);
    headers['set-cookie'] = cookies.map(scrubCookie);
  }
  return headers;
}

// What went wrong with a fetch, as short as it can be said: the error code of the failed connection (ECONNREFUSED, ENOTFOUND,
// a TLS code), else the message. fetch itself only says "fetch failed" and keeps the reason in cause, which for localhost may be
// an AggregateError with one error per address.
function failureDetail(err) {
  const cause = err && err.cause;
  const first = cause && Array.isArray(cause.errors) ? cause.errors[0] : undefined;
  return (cause && cause.code) || (first && first.code) || (err && err.code) || (cause && cause.message) || (err && err.message) || 'unknown error';
}

// GET the URL and return {finalUrl, status, headers} for the response after redirects, or {skip: reason} when there was none.
async function fetchFinal(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: ACCEPT },
      });
    } catch (err) {
      if (controller.signal.aborted || (err && err.name === 'AbortError')) return { skip: `headers check timed out after ${timeoutMs} ms` };
      return { skip: `headers check failed: ${firstLine(String(failureDetail(err)))}` };
    }
    const seen = { finalUrl: pageOf(res.url || url), status: res.status, headers: plainHeaders(res.headers) };
    // Only the headers matter: drop the body unread so the connection is released.
    try {
      if (res.body) await res.body.cancel();
    } catch {
      // the headers are in hand
    }
    return seen;
  } finally {
    clearTimeout(timer);
  }
}

// ---- check --------------------------------------------------------------------------------

// Check one system's live URL and record the outcome as a run. Returns {run, counts, grade, finalUrl, status}: the finished run,
// the findings upsert counts plus hardening (the number of failed checks) and closed (earlier findings no longer shown), the
// grade ({score, grade, failed}) and the final response's URL (origin and path) and status. For a skipped run the counts are all zero and there is no grade. Throws RangeError for a project,
// system, URL or timeout that does not resolve (no run is created). Anything else that goes wrong after the run exists marks it
// failed and is rethrown.
async function check({ project, system, url, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const target = resolveTarget({ project, system, url, timeoutMs });
  const run = store.createRun(project, { job: 'audit', layers: ['L1'], systems: [system], executor: 'local' });
  try {
    const outcome = await fetchFinal(target.url, timeoutMs);
    if (outcome.skip) return common.skipped(run, outcome.skip);

    const { finalUrl, status, headers } = outcome;
    const grade = gradeHeaders(headers);
    store.writeRaw(project, run.runId, RAW_NAME, JSON.stringify({ url: target.url, finalUrl, status, headers, grade }, null, 2));
    const findings = fromHeaders({ url: finalUrl, status, headers }, { project, system, runId: run.runId });
    const upserted = store.upsertFindings(project, findings, run.runId);
    const { closed } = store.closeMissing(project, { system, source: 'headers', runId: run.runId, seenIds: findings.map((f) => f.id) });
    const counts = { ...upserted, closed, hardening: findings.length };
    store.appendScore(project, { kind: 'headers', system, url: finalUrl, score: grade.score, grade: grade.grade });

    const patch = { status: 'done', counts, tool: { name: 'headers' } };
    if (status < 200 || status >= 400) patch.reason = `final response status was ${status}; graded anyway`;
    return { run: store.finishRun(project, run.runId, patch), counts, grade, finalUrl, status };
  } catch (err) {
    markFailed(run, err);
    throw err;
  }
}

// The public result is {run, counts, grade}.
async function checkHeaders(options) {
  const { run, counts, grade } = await check(options);
  return { run, counts, grade };
}

// ---- CLI ----------------------------------------------------------------------------------

const USAGE = 'usage: node scripts/l1-headers.cjs --project <slug> --system <id> [--url <url>] [--json]';

// --project and --system are required; --url and --json are optional. There is no repo to point at, so --repo and --input are
// usage errors here, as is anything else the CLI does not know.
function parse(argv) {
  let values;
  try {
    ({ values } = util.parseArgs({
      args: argv,
      options: { project: { type: 'string' }, system: { type: 'string' }, url: { type: 'string' }, json: { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new UsageError(err.message.split('\n')[0]);
  }
  for (const name of ['project', 'system']) {
    if (values[name] === undefined) throw new UsageError(`--${name} is required`);
  }
  return values;
}

// The lines under the head of a done run.
function details({ run, counts, grade, finalUrl, status }) {
  const { added, updated, unchanged, regressed, closed, hardening } = counts;
  const lines = [
    `url: ${redact(finalUrl)} (status ${status})`,
    `grade: ${grade.grade} (score ${grade.score})`,
    `${hardening} hardening ${hardening === 1 ? 'finding' : 'findings'}: ${added} new, ${updated} updated, ${unchanged} unchanged, ${regressed} regressed, ${closed} closed`,
    `raw response: ${path.join(runDir(run.project, run.runId), 'raw', RAW_NAME)}`,
  ];
  if (run.reason) lines.push(`note: ${run.reason}`);
  return lines;
}

if (require.main === module) {
  Promise.resolve(runCli({
    name: 'l1-headers',
    usage: USAGE,
    parse,
    details,
    scan: (opts) => check({ project: opts.project, system: opts.system, url: opts.url }),
  }, process.argv.slice(2))).then((code) => {
    process.exitCode = code;
  });
}

module.exports = { checkHeaders };
