const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const store = require('../scripts/store.cjs');
const { gradeHeaders } = require('../scripts/lib/headers-rubric.cjs');
const { checkHeaders } = require('../scripts/l1-headers.cjs');

const CLI = path.join(__dirname, '..', 'scripts', 'l1-headers.cjs');
const SLUG = 'example-app';
const SYSTEM = 'db'; // the fixture system that has a live.url; 'mobile' has none
const USER_AGENT = 'Rampart/0.1 (+https://github.com/<owner>/rampart)';
const ZERO = { added: 0, updated: 0, unchanged: 0, regressed: 0 };

// Cookie values the servers send. Not one of them may end up in a stored file.
const COOKIE_A = 'COOKIEVALUEaaaa1111';
const COOKIE_B1 = 'COOKIEVALUEbbbb2222';
const COOKIE_B2 = 'COOKIEVALUEbbbb3333';
const COOKIE_C = 'COOKIEVALUEcccc4444';
const COOKIE_VALUES = [COOKIE_A, COOKIE_B1, COOKIE_B2, COOKIE_C];
const STATE_TOKEN = 'secrettoken123'; // in the query of a redirect target; it must not be stored either

// A response that passes every check, with a cookie that has Secure and HttpOnly.
const FULL = {
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=()',
  'Set-Cookie': [`sid=${COOKIE_A}; Secure; HttpOnly; SameSite=Lax`],
  Server: 'nginx',
};
// A response with no security headers at all, two cookies without flags and a banner that gives the software away.
const BARE = {
  'Set-Cookie': [`tracker=${COOKIE_B1}; Path=/`, `session=${COOKIE_B2}; HttpOnly`],
  Server: 'nginx/1.18.0',
  'X-Powered-By': 'Express',
};

let home;
let servers;
let requests; // what the servers received, in order
const saved = process.env.RAMPART_HOME;

test.beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart headers store '));
  process.env.RAMPART_HOME = home;
  servers = [];
  requests = [];
  setLiveUrl('http://127.0.0.1:1/'); // replaced by the test when it matters
});
test.afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  fs.rmSync(home, { recursive: true, force: true });
  if (saved === undefined) delete process.env.RAMPART_HOME;
  else process.env.RAMPART_HOME = saved;
});

// The fixture project, with the live URL of its `db` system set to url.
function setLiveUrl(url) {
  const { created, updated, ...project } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'project.valid.json'), 'utf8'));
  project.systems.find((s) => s.id === SYSTEM).live.url = url;
  store.writeProject(project);
}

// Start a server on a free port on the loopback address; resolves to its base URL (with a trailing slash).
function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      requests.push({ method: req.method, url: req.url, headers: req.headers });
      handler(req, res);
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/`));
  });
}
const respond = (status, headers) => (req, res) => {
  res.writeHead(status, headers);
  res.end('<!doctype html><title>x</title>');
};
const serveFull = () => serve(respond(200, FULL));
const serveBare = () => serve(respond(200, BARE));
const serveRedirect = (to) => serve(respond(302, { Location: to, 'Set-Cookie': `redirect=${COOKIE_C}; Path=/` }));
const serveSilence = () => serve(() => {}); // takes the request and never answers

// Stop one server now; its port then refuses connections.
async function stop(server) {
  servers.splice(servers.indexOf(server), 1);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

// A URL nothing listens on: a port that was free a moment ago.
async function closedUrl() {
  const url = await serve(respond(200, {}));
  await stop(servers[servers.length - 1]);
  return url;
}

// A site whose answer the test changes between checks: answer(status, headers) for every path, page(path, headers) for one.
async function serveSite(status, headers, pages = {}) {
  const now = { status, headers, pages: { ...pages } };
  const url = await serve((req, res) => {
    const pagePath = req.url.split('?')[0];
    respond(now.status, now.pages[pagePath] || now.headers)(req, res);
  });
  return {
    url,
    server: servers[servers.length - 1],
    answer: (nextStatus, nextHeaders) => { now.status = nextStatus; now.headers = nextHeaders; },
    page: (pagePath, pageHeaders) => { now.pages[pagePath] = pageHeaders; },
  };
}

const runsDir = () => path.join(home, 'projects', SLUG, 'runs');
const readRun = (run) => JSON.parse(fs.readFileSync(path.join(runsDir(), run.runId, 'run.json'), 'utf8'));
const rawFile = (run) => path.join(runsDir(), run.runId, 'raw', 'headers.json');
const readRaw = (run) => JSON.parse(fs.readFileSync(rawFile(run), 'utf8'));
const scoreLines = () => {
  const file = path.join(home, 'projects', SLUG, 'scores.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
function everyStoredText() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push([full, fs.readFileSync(full, 'utf8')]);
    }
  };
  walk(path.join(home, 'projects'));
  return out;
}
const assertNoCookieValues = () => {
  for (const [file, text] of everyStoredText()) {
    for (const value of COOKIE_VALUES) assert.ok(!text.includes(value), `${file} holds a cookie value`);
  }
};
const noRunsYet = () => !fs.existsSync(runsDir()) || fs.readdirSync(runsDir()).length === 0;

// A skipped run: the status, the reason, no counts, run.json on disk equal to the returned run, and nothing ingested or scored.
function assertSkipped({ run, counts }, reason) {
  assert.equal(run.status, 'skipped');
  if (typeof reason === 'string') assert.equal(run.reason, reason);
  else assert.match(run.reason, reason);
  assert.ok(run.finishedAt);
  assert.deepEqual(counts, ZERO);
  assert.deepEqual(readRun(run), run);
  assert.deepEqual(store.readFindings(SLUG), [], 'nothing from a skipped run is ingested');
  assert.deepEqual(scoreLines(), [], 'a skipped run is not scored');
  assert.ok(!fs.existsSync(rawFile(run)), 'there is no response to keep');
}

// The CLI in a child process (async: the servers live in this process and must keep answering).
function cli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
const ARGS = ['--project', SLUG, '--system', SYSTEM];

// ---- the four cases from the brief ---------------------------------------------------------

test('(a) full-marks headers: no findings, grade A, a done run with hardening 0 and one score line', async () => {
  const url = await serveFull();
  setLiveUrl(url);
  const { run, counts, grade } = await checkHeaders({ project: SLUG, system: SYSTEM });

  assert.equal(run.status, 'done');
  assert.equal(run.reason, undefined);
  assert.equal(run.job, 'audit');
  assert.deepEqual(run.layers, ['L1']);
  assert.deepEqual(run.systems, [SYSTEM]);
  assert.equal(run.executor, 'local');
  assert.deepEqual(run.tool, { name: 'headers' });
  assert.ok(run.finishedAt);
  assert.deepEqual(counts, { added: 0, updated: 0, unchanged: 0, regressed: 0, closed: 0, hardening: 0 });
  assert.deepEqual(run.counts, { added: 0, updated: 0, unchanged: 0, hardening: 0, regressed: 0, closed: 0 });
  assert.deepEqual(readRun(run), run, 'run.json on disk is the returned run');
  assert.deepEqual(grade, { score: 100, grade: 'A', failed: [] });
  assert.deepEqual(store.readFindings(SLUG), []);

  const raw = readRaw(run);
  assert.equal(raw.url, url);
  assert.equal(raw.finalUrl, url);
  assert.equal(raw.status, 200);
  assert.deepEqual(raw.grade, grade);
  assert.equal(raw.headers['content-security-policy'], FULL['Content-Security-Policy'], 'the headers are kept, keyed by lower-case name');

  assert.deepEqual(scoreLines().map(({ at, ...rest }) => rest), [{ kind: 'headers', system: SYSTEM, url, score: 100, grade: 'A' }]);
  assert.match(scoreLines()[0].at, /^\d{4}-\d{2}-\d{2}T/);
});

test('(b) no security headers: eight hardening findings, grade F, the run is done and counts them', async () => {
  const url = await serveBare();
  setLiveUrl(url);
  const { run, counts, grade } = await checkHeaders({ project: SLUG, system: SYSTEM });

  assert.equal(run.status, 'done');
  assert.deepEqual(grade, { score: 0, grade: 'F', failed: ['csp', 'hsts', 'frame', 'xcto', 'referrer', 'permissions', 'cookies', 'banner'] });
  assert.equal(counts.hardening, 8);
  assert.equal(counts.added, 8);
  assert.equal(run.counts.hardening, 8);
  assert.equal(run.counts.added, 8);
  assert.deepEqual(readRun(run), run);

  const findings = store.readFindings(SLUG);
  assert.equal(findings.length, 8);
  assert.ok(findings.every((f) => (
    f.class === 'hardening' && f.layer === 'L1' && f.source === 'headers' && f.system === SYSTEM && f.status === 'open' && f.location.url === url
  )));
  assert.deepEqual(findings.map((f) => f.ruleId).sort(), grade.failed.map((id) => `headers/${id}`).sort());

  assert.deepEqual(scoreLines().map(({ at, ...rest }) => rest), [{ kind: 'headers', system: SYSTEM, url, score: 0, grade: 'F' }]);
});

test('(c) a 302 to the full-marks server is graded on the final response, and finalUrl is where it ended', async () => {
  const target = await serveFull();
  const start = await serveRedirect(target);
  setLiveUrl(start);
  const { run, counts, grade } = await checkHeaders({ project: SLUG, system: SYSTEM });

  assert.equal(run.status, 'done');
  assert.deepEqual(grade, { score: 100, grade: 'A', failed: [] }, 'the redirect response has no security headers; the final one does');
  assert.equal(counts.hardening, 0);
  const raw = readRaw(run);
  assert.equal(raw.url, start);
  assert.equal(raw.finalUrl, target);
  assert.equal(raw.status, 200);
  assert.equal(scoreLines()[0].url, target, 'the score is for the page the check ended on');
  assert.deepEqual(requests.map((r) => r.method), ['GET', 'GET']);
});

test('(c) the query string of a redirect target is not kept: findings, raw copy and score name origin and path only', async () => {
  const target = await serveBare();
  const start = await serveRedirect(`${target}path?state=${STATE_TOKEN}`);
  setLiveUrl(start);
  const { run } = await checkHeaders({ project: SLUG, system: SYSTEM });

  assert.equal(run.status, 'done');
  assert.ok(requests.some((r) => r.url === `/path?state=${STATE_TOKEN}`), 'the redirect was followed with its query');
  const findings = store.readFindings(SLUG);
  assert.equal(findings.length, 8);
  assert.ok(findings.every((f) => f.location.url === `${target}path` && f.location.url.endsWith('/path')));
  assert.equal(readRaw(run).finalUrl, `${target}path`);
  assert.equal(readRaw(run).url, start, 'what was asked for is recorded as it was');
  assert.equal(scoreLines()[0].url, `${target}path`);
  for (const [file, text] of everyStoredText()) assert.ok(!text.includes(STATE_TOKEN), `${file} holds the redirect token`);
});

test('(c) the same page reached through a different query is the same findings, not new ones', async () => {
  const target = await serveBare();
  setLiveUrl(await serveRedirect(`${target}path?state=one`));
  const first = await checkHeaders({ project: SLUG, system: SYSTEM });
  setLiveUrl(await serveRedirect(`${target}path?state=two`));
  const second = await checkHeaders({ project: SLUG, system: SYSTEM });
  assert.equal(first.counts.added, 8);
  assert.deepEqual(second.counts, { added: 0, updated: 0, unchanged: 8, regressed: 0, closed: 0, hardening: 8 });
});

test('a query or fragment on the URL asked for does not reach the final URL either', async () => {
  const url = await serveBare();
  const { run } = await checkHeaders({ project: SLUG, system: SYSTEM, url: `${url}page?x=1#section` });
  assert.equal(readRaw(run).finalUrl, `${url}page`);
  assert.equal(readRaw(run).url, `${url}page?x=1#section`);
  assert.ok(store.readFindings(SLUG).every((f) => f.location.url === `${url}page`));
});

test('(d) a port nothing listens on is a skipped run naming ECONNREFUSED, never a crash', async () => {
  setLiveUrl(await closedUrl());
  const result = await checkHeaders({ project: SLUG, system: SYSTEM });
  assertSkipped(result, /^headers check failed: ECONNREFUSED$/);
});

test('(d) a server that never answers is a skipped run, "timed out after <n> ms", and returns promptly', async () => {
  setLiveUrl(await serveSilence());
  const started = Date.now();
  const result = await checkHeaders({ project: SLUG, system: SYSTEM, timeoutMs: 300 });
  assertSkipped(result, 'headers check timed out after 300 ms');
  assert.ok(Date.now() - started < 5000);
  assert.equal(requests.length, 1, 'the server did get the request');
});

// ---- what is requested ---------------------------------------------------------------------

test('the request is a GET with the Rampart user agent and an Accept header', async () => {
  setLiveUrl(await serveFull());
  await checkHeaders({ project: SLUG, system: SYSTEM });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].url, '/');
  assert.equal(requests[0].headers['user-agent'], USER_AGENT);
  assert.equal(requests[0].headers.accept, 'text/html,*/*');
});

test('only the headers are read: a body that never ends does not delay the grade, and its connection is dropped', async () => {
  let closed;
  setLiveUrl(await serve((req, res) => {
    closed = new Promise((resolve) => res.on('close', resolve));
    res.writeHead(200, FULL);
    res.write('<!doctype html>'); // and never res.end()
  }));
  const started = Date.now();
  const { run, grade } = await checkHeaders({ project: SLUG, system: SYSTEM, timeoutMs: 10000 });
  assert.equal(run.status, 'done');
  assert.equal(grade.grade, 'A');
  assert.ok(Date.now() - started < 3000);
  const timer = { id: undefined };
  const gaveUp = new Promise((resolve) => { timer.id = setTimeout(resolve, 3000, 'timeout'); });
  assert.notEqual(await Promise.race([closed, gaveUp]), 'timeout', 'the server saw the connection close');
  clearTimeout(timer.id);
});

test('--url wins over the live URL of the system', async () => {
  setLiveUrl(await serveBare());
  const full = await serveFull();
  const { run, grade } = await checkHeaders({ project: SLUG, system: SYSTEM, url: full });
  assert.equal(run.status, 'done');
  assert.equal(grade.grade, 'A');
  assert.equal(readRaw(run).url, full);
  assert.equal(requests.length, 1, 'only the --url server was asked');
});

// ---- cookies -------------------------------------------------------------------------------

test('cookie values never reach a stored file; the cookies stay in the raw copy by name and attributes', async () => {
  setLiveUrl(await serveBare());
  const { run } = await checkHeaders({ project: SLUG, system: SYSTEM });
  assert.equal(run.status, 'done');
  assertNoCookieValues();
  assert.deepEqual(readRaw(run).headers['set-cookie'], ['tracker=[REDACTED]; Path=/', 'session=[REDACTED]; HttpOnly'], 'every Set-Cookie line is kept, not only the last');
});

test('cookie values never reach a stored file when the cookies pass, or when the response was a redirect', async () => {
  const url = await serveRedirect(await serveFull());
  setLiveUrl(url);
  const { run } = await checkHeaders({ project: SLUG, system: SYSTEM });
  assert.equal(run.status, 'done');
  assert.deepEqual(readRaw(run).headers['set-cookie'], ['sid=[REDACTED]; Secure; HttpOnly; SameSite=Lax']);
  assertNoCookieValues();
});

test('the stored headers are a plain object with lower-case names and grade the same as the response did', async () => {
  setLiveUrl(await serveBare());
  const { run, grade } = await checkHeaders({ project: SLUG, system: SYSTEM });
  const { headers } = readRaw(run);
  assert.ok(Object.keys(headers).length > 0);
  assert.ok(Object.keys(headers).every((name) => name === name.toLowerCase()));
  assert.ok(Array.isArray(headers['set-cookie']));
  assert.deepEqual(gradeHeaders(headers), grade, 'removing the cookie values does not change the verdict');
});

// ---- other statuses and failures -----------------------------------------------------------

test('a 404 is graded all the same; the run is done and its reason notes the status', async () => {
  setLiveUrl(await serve(respond(404, FULL)));
  const { run, grade } = await checkHeaders({ project: SLUG, system: SYSTEM });
  assert.equal(run.status, 'done');
  assert.equal(run.reason, 'final response status was 404; graded anyway');
  assert.equal(grade.grade, 'A');
  assert.equal(readRaw(run).status, 404);
  assert.deepEqual(readRun(run), run);
  assert.equal(scoreLines().length, 1);
});

test('a 500 is noted too, and a 200 or a 304 is not', async () => {
  setLiveUrl(await serve(respond(500, {})));
  assert.match((await checkHeaders({ project: SLUG, system: SYSTEM })).run.reason, /status was 500/);

  setLiveUrl(await serve(respond(304, {})));
  const notModified = await checkHeaders({ project: SLUG, system: SYSTEM });
  assert.equal(notModified.run.status, 'done');
  assert.equal(notModified.run.reason, undefined);
});

test('a redirect loop is a skipped run, not a crash', async () => {
  let self;
  self = await serve((req, res) => {
    res.writeHead(302, { Location: self });
    res.end();
  });
  setLiveUrl(self);
  const result = await checkHeaders({ project: SLUG, system: SYSTEM });
  assert.equal(result.run.status, 'skipped');
  assert.match(result.run.reason, /^headers check failed: /);
});

test('the reason of a failed fetch is redacted and holds one line', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: new Error('boom ghp_headersheadersheadersheaders99999\nsecond line') });
  };
  try {
    const result = await checkHeaders({ project: SLUG, system: SYSTEM, url: 'http://127.0.0.1:1/' });
    assert.equal(result.run.status, 'skipped');
    assert.match(result.run.reason, /^headers check failed: boom \[REDACTED\]$/);
  } finally {
    globalThis.fetch = original;
  }
});

test('a run is created for every checked URL, and a second check of the same page changes nothing', async () => {
  setLiveUrl(await serveBare());
  const first = await checkHeaders({ project: SLUG, system: SYSTEM });
  const before = store.readFindings(SLUG);
  const { run, counts } = await checkHeaders({ project: SLUG, system: SYSTEM });
  assert.notEqual(run.runId, first.run.runId);
  assert.deepEqual(counts, { added: 0, updated: 0, unchanged: 8, regressed: 0, closed: 0, hardening: 8 });
  assert.deepEqual(store.readFindings(SLUG).map((f) => f.id), before.map((f) => f.id));
  assert.equal(scoreLines().length, 2, 'every finished check adds a score line');
});

// ---- findings that no longer reproduce ----------------------------------------------------

test('(e) a page checked bare and then fixed: the earlier findings are fixed, with a record naming the run, and counted as closed', async () => {
  const site = await serveSite(200, BARE);
  setLiveUrl(site.url);
  const first = await checkHeaders({ project: SLUG, system: SYSTEM });
  const earlier = store.readFindings(SLUG);
  assert.equal(earlier.length, 8);

  site.answer(200, FULL);
  const { run, counts, grade } = await checkHeaders({ project: SLUG, system: SYSTEM });
  assert.equal(grade.grade, 'A');
  assert.equal(counts.closed, 8);
  assert.equal(counts.hardening, 0);
  assert.equal(counts.added, 0);
  assert.equal(run.counts.closed, 8);
  assert.deepEqual(readRun(run), run);

  const now = store.readFindings(SLUG);
  assert.deepEqual(now.map((f) => f.id), earlier.map((f) => f.id), 'nothing is deleted');
  assert.ok(now.every((f) => f.status === 'fixed'));
  const dispositions = store.readDispositions(SLUG);
  assert.deepEqual(Object.keys(dispositions).sort(), earlier.map((f) => f.id).sort());
  for (const { id } of earlier) {
    const { at, ...record } = dispositions[id];
    assert.deepEqual(record, { status: 'fixed', reason: `not reproduced in run ${run.runId}`, by: 'rampart' });
    assert.ok(at);
  }
  assert.notEqual(run.runId, first.run.runId);
  assert.equal(scoreLines().length, 2);
});

test('(e) a check of another page of the system never closes the findings of this one', async () => {
  const site = await serveSite(200, FULL, { '/one': BARE });
  const one = `${site.url}one`;
  const two = `${site.url}two`;
  const first = await checkHeaders({ project: SLUG, system: SYSTEM, url: one });
  assert.equal(first.counts.added, 8);

  const second = await checkHeaders({ project: SLUG, system: SYSTEM, url: two }); // /two has full marks
  assert.equal(second.grade.grade, 'A');
  assert.equal(second.counts.closed, 0, 'nothing found on /one is "not reproduced" by a look at /two');
  assert.ok(store.readFindings(SLUG).every((f) => f.status === 'open' && f.location.url === one));
  assert.deepEqual(store.readDispositions(SLUG), {});

  // Fixing /one is seen by a check of /one, and only by that.
  site.page('/one', FULL);
  assert.equal((await checkHeaders({ project: SLUG, system: SYSTEM, url: two })).counts.closed, 0);
  assert.ok(store.readFindings(SLUG).every((f) => f.status === 'open'));
  assert.equal((await checkHeaders({ project: SLUG, system: SYSTEM, url: one })).counts.closed, 8);
  assert.ok(store.readFindings(SLUG).every((f) => f.status === 'fixed'));
});

test('(e) findings of two pages are closed page by page, each by its own check', async () => {
  const site = await serveSite(200, BARE);
  const one = `${site.url}one`;
  const two = `${site.url}two`;
  await checkHeaders({ project: SLUG, system: SYSTEM, url: one });
  await checkHeaders({ project: SLUG, system: SYSTEM, url: two });
  assert.equal(store.readFindings(SLUG).length, 16);

  site.answer(200, FULL);
  assert.equal((await checkHeaders({ project: SLUG, system: SYSTEM, url: two })).counts.closed, 8);
  const statusesOf = (url) => store.readFindings(SLUG).filter((f) => f.location.url === url).map((f) => f.status);
  assert.ok(statusesOf(two).every((status) => status === 'fixed'));
  assert.ok(statusesOf(one).every((status) => status === 'open'));
});

test('(e) an error response is graded but closes nothing, even for the same page; the next good response does', async () => {
  const site = await serveSite(200, BARE);
  setLiveUrl(site.url);
  await checkHeaders({ project: SLUG, system: SYSTEM });
  assert.equal(store.readFindings(SLUG).length, 8);

  site.answer(404, FULL); // the error page has all the headers; that says nothing about the real page
  const notFound = await checkHeaders({ project: SLUG, system: SYSTEM });
  assert.equal(notFound.run.status, 'done');
  assert.equal(notFound.run.reason, 'final response status was 404; graded anyway');
  assert.equal(notFound.grade.grade, 'A', 'it is still graded and recorded');
  assert.deepEqual(notFound.counts, { added: 0, updated: 0, unchanged: 0, regressed: 0, closed: 0, hardening: 0 });
  assert.equal(notFound.run.counts.closed, 0);
  assert.ok(store.readFindings(SLUG).every((f) => f.status === 'open'), 'the findings of the real page stay open');
  assert.deepEqual(store.readDispositions(SLUG), {});
  assert.equal(scoreLines().length, 2);

  site.answer(500, FULL);
  assert.equal((await checkHeaders({ project: SLUG, system: SYSTEM })).counts.closed, 0);

  site.answer(399, FULL); // below 400 is a response like any other
  assert.equal((await checkHeaders({ project: SLUG, system: SYSTEM })).counts.closed, 8);
});

test('(e) the same page fixed step by step closes what each step fixes, and a header that goes missing again is a regression', async () => {
  const CSP = { 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'" };
  const modes = { bare: BARE, partial: { ...BARE, ...CSP }, full: FULL };
  let mode = 'bare';
  setLiveUrl(await serve((req, res) => respond(200, modes[mode])(req, res)));
  const check = async (next) => {
    mode = next;
    const { run, counts } = await checkHeaders({ project: SLUG, system: SYSTEM });
    assert.equal(run.status, 'done');
    return counts;
  };
  const statuses = () => store.readFindings(SLUG).map((f) => f.status);

  assert.deepEqual(await check('bare'), { added: 8, updated: 0, unchanged: 0, regressed: 0, closed: 0, hardening: 8 });
  // A CSP with frame-ancestors answers both the csp and the frame check.
  assert.deepEqual(await check('partial'), { added: 0, updated: 0, unchanged: 6, regressed: 0, closed: 2, hardening: 6 });
  assert.equal(statuses().filter((s) => s === 'fixed').length, 2);
  assert.deepEqual(await check('full'), { added: 0, updated: 0, unchanged: 0, regressed: 0, closed: 6, hardening: 0 });
  assert.ok(statuses().every((s) => s === 'fixed'));
  assert.deepEqual(await check('bare'), { added: 0, updated: 0, unchanged: 0, regressed: 8, closed: 0, hardening: 8 });
  assert.ok(statuses().every((s) => s === 'regressed'));
  assert.ok(Object.values(store.readDispositions(SLUG)).every((d) => d.status === 'regressed' && d.by === 'rampart'));
});

test('(e) a skipped check closes nothing: it says nothing about what is gone', async () => {
  const site = await serveSite(200, BARE);
  setLiveUrl(site.url);
  await checkHeaders({ project: SLUG, system: SYSTEM });
  await stop(site.server); // the same URL, now refusing connections
  const { run } = await checkHeaders({ project: SLUG, system: SYSTEM });
  assert.equal(run.status, 'skipped');
  assert.match(run.reason, /ECONNREFUSED/);
  assert.equal(run.counts.closed, undefined);
  assert.ok(store.readFindings(SLUG).every((f) => f.status === 'open'));
  assert.deepEqual(store.readDispositions(SLUG), {});
});

test('(e) findings that a person triaged are not closed when the header gets fixed', async () => {
  const site = await serveSite(200, BARE);
  setLiveUrl(site.url);
  await checkHeaders({ project: SLUG, system: SYSTEM });
  const [first, second] = store.readFindings(SLUG);
  store.setDisposition(SLUG, first.id, { status: 'accepted_risk', reason: 'behind a CDN', by: 'pedro' });
  store.setDisposition(SLUG, second.id, { status: 'false_positive', reason: 'scanner quirk', by: 'pedro' });
  site.answer(200, FULL);
  const { counts } = await checkHeaders({ project: SLUG, system: SYSTEM });
  assert.equal(counts.closed, 6);
  const byId = Object.fromEntries(store.readFindings(SLUG).map((f) => [f.id, f.status]));
  assert.equal(byId[first.id], 'accepted_risk');
  assert.equal(byId[second.id], 'false_positive');
});

// ---- arguments that do not resolve ---------------------------------------------------------

test('a project, system or URL that does not resolve is a RangeError and leaves no run behind', async () => {
  const bad = (options, message) => assert.rejects(() => checkHeaders({ project: SLUG, system: SYSTEM, ...options }), (err) => {
    assert.ok(err instanceof RangeError, `${err.name}: ${err.message}`);
    if (message) assert.match(err.message, message);
    return true;
  });
  await assert.rejects(() => checkHeaders({ project: 'no-such-app', system: SYSTEM }), RangeError);
  await assert.rejects(() => checkHeaders({ project: 'Bad Slug!', system: SYSTEM }), RangeError);
  await assert.rejects(() => checkHeaders({ project: SLUG, system: 'nope' }), RangeError);
  await assert.rejects(() => checkHeaders({ project: SLUG, system: 'mobile' }), /system mobile has no live\.url; pass --url/);
  await bad({ url: 'not a url' }, /--url is not a valid URL/);
  await bad({ url: '' }, /--url is not a valid URL/);
  for (const url of ['ftp://127.0.0.1/', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'ws://127.0.0.1/']) {
    await bad({ url }, /--url must be an http: or https: URL/);
  }
  await bad({ url: 'http://user:hunter2hunter2@127.0.0.1:1/' }, /--url must not contain credentials/);
  for (const timeoutMs of [0, -5, NaN, Infinity, '300', 2 ** 31]) await bad({ url: 'http://127.0.0.1:1/', timeoutMs }, /timeoutMs/);
  assert.ok(noRunsYet());
  assert.deepEqual(scoreLines(), []);
  assert.equal(requests.length, 0);
});

test('the message for a bad URL never quotes it; one from the system names live.url', async () => {
  await assert.rejects(() => checkHeaders({ project: SLUG, system: SYSTEM, url: 'http://user:hunter2hunter2@127.0.0.1:1/' }), (err) => (
    err instanceof RangeError && !err.message.includes('hunter2')
  ));
  setLiveUrl('ftp://127.0.0.1/');
  await assert.rejects(() => checkHeaders({ project: SLUG, system: SYSTEM }), /live\.url of system db must be an http: or https: URL/);
  assert.ok(noRunsYet());
});

// ---- the CLI -------------------------------------------------------------------------------

test('cli: a finished check exits 0 and prints the grade, the final URL, the findings count and the raw path', async () => {
  const target = await serveFull();
  const r = await cli([...ARGS, '--url', await serveRedirect(target)]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^l1-headers example-app\/db: done \(run /);
  assert.ok(r.stdout.includes(`url: ${target}`), 'the final URL is printed');
  assert.match(r.stdout, /grade: A \(score 100\)/);
  assert.match(r.stdout, /0 hardening findings/);
  assert.match(r.stdout, /0 closed/);
  assert.match(r.stdout, /raw[\\/]headers\.json/);
  assert.equal(r.stderr, '');
  assert.equal(scoreLines().length, 1);
});

test('cli: with no --url the live URL of the system is used, and a bare site is still a done run (exit 0)', async () => {
  setLiveUrl(await serveBare());
  const r = await cli(ARGS);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /grade: F \(score 0\)/);
  assert.match(r.stdout, /8 hardening findings/);
  assert.equal(store.readFindings(SLUG).length, 8);
});

test('cli: an error status is still a done run (exit 0) and the output carries the note about it', async () => {
  const r = await cli([...ARGS, '--url', await serve(respond(404, FULL))]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\(status 404\)/);
  assert.match(r.stdout, /note: final response status was 404; graded anyway/);
  assert.match(r.stdout, /grade: A/);
});

test('cli: --json prints {run, counts} and nothing else', async () => {
  const r = await cli([...ARGS, '--url', await serveBare(), '--json']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ['run', 'counts']);
  assert.equal(out.run.status, 'done');
  assert.deepEqual(out.run.tool, { name: 'headers' });
  assert.equal(out.counts.hardening, 8);
});

test('cli: an unreachable site exits 2, the output says skipped and why', async () => {
  const r = await cli([...ARGS, '--url', await closedUrl()]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /example-app\/db: skipped/);
  assert.match(r.stdout, /reason: headers check failed: ECONNREFUSED/);
  assert.equal(r.stderr, '');

  const json = await cli([...ARGS, '--url', await closedUrl(), '--json']);
  assert.equal(json.code, 2);
  assert.equal(JSON.parse(json.stdout).run.status, 'skipped');
});

test('cli: usage errors and unresolved names exit 2 with a message on stderr, and leave nothing behind', async () => {
  for (const args of [
    [],
    ['--project', SLUG],
    ['--system', SYSTEM],
    [...ARGS, '--bogus'],
    [...ARGS, 'extra'],
    [...ARGS, '--url'],
    [...ARGS, '--repo', home],
    [...ARGS, '--input', 'report.json'],
    ['--project', SLUG, '--system', 'nope'],
    ['--project', 'no-such-app', '--system', SYSTEM],
    ['--project', SLUG, '--system', 'mobile'], // no live.url and no --url
    [...ARGS, '--url', 'ftp://127.0.0.1/'],
    [...ARGS, '--url', 'not a url'],
  ]) {
    const r = await cli(args);
    assert.equal(r.code, 2, `args ${JSON.stringify(args)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^l1-headers: /);
    assert.equal(r.stdout, '');
  }
  assert.ok(noRunsYet());
  assert.equal(requests.length, 0);
});
