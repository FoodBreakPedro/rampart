const test = require('node:test');
const assert = require('node:assert/strict');
const { CHECKS, gradeHeaders } = require('../scripts/lib/headers-rubric.cjs');
const { fromHeaders } = require('../scripts/normalize.cjs');
const { findingId } = require('../scripts/lib/id.cjs');
const { validate, loadSchema } = require('../scripts/lib/validate.cjs');

const RUN = '2026-10-23T18-02-11Z';
const NOW = '2026-10-23T18:02:11Z';
const CTX = { project: 'example-app', system: 'web', runId: RUN, now: NOW };
const URL_ = 'https://example.com/';

// A response that passes every check.
const FULL = {
  'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=()',
  'set-cookie': ['sid=abc123; Secure; HttpOnly; SameSite=Lax'],
  server: 'nginx',
};
const without = (...names) => Object.fromEntries(Object.entries(FULL).filter(([k]) => !names.includes(k)));
const with_ = (extra) => ({ ...FULL, ...extra });
const deepFreeze = (v) => {
  if (v && typeof v === 'object') Object.values(v).forEach(deepFreeze);
  return Object.freeze(v);
};
const failedOf = (headers) => gradeHeaders(headers).failed;
const result = (headers) => ({ url: URL_, status: 200, headers });

const findingSchema = loadSchema('finding');

// ---- rubric ---------------------------------------------------------------------------------

test('CHECKS lists the eight checks with their weights and severities, in order', () => {
  assert.deepEqual(
    CHECKS.map((c) => [c.id, c.weight, c.severity]),
    [
      ['csp', 25, 'HIGH'],
      ['hsts', 20, 'MEDIUM'],
      ['frame', 15, 'MEDIUM'],
      ['xcto', 10, 'LOW'],
      ['referrer', 10, 'LOW'],
      ['permissions', 10, 'LOW'],
      ['cookies', 10, 'MEDIUM'],
      ['banner', 5, 'LOW'],
    ],
  );
  for (const c of CHECKS) {
    assert.equal(typeof c.title, 'string');
    assert.ok(c.title.length > 0);
    assert.equal(typeof c.test, 'function');
  }
});

test('a full-marks header set scores 100, grade A, nothing failed', () => {
  assert.deepEqual(gradeHeaders(FULL), { score: 100, grade: 'A', failed: [] });
  assert.deepEqual(fromHeaders(result(FULL), CTX), []);
});

test('only x-content-type-options: csp, hsts, frame, referrer and permissions fail, 100-25-20-15-10-10 = 20, F', () => {
  const headers = { 'x-content-type-options': 'nosniff' };
  assert.deepEqual(gradeHeaders(headers), {
    score: 20,
    grade: 'F',
    failed: ['csp', 'hsts', 'frame', 'referrer', 'permissions'],
  });
});

test('no headers at all fails six checks and passes cookies and banner (nothing set, nothing disclosed)', () => {
  assert.deepEqual(gradeHeaders({}), { score: 10, grade: 'F', failed: ['csp', 'hsts', 'frame', 'xcto', 'referrer', 'permissions'] });
});

test('failed ids come back in CHECKS order', () => {
  const order = CHECKS.map((c) => c.id);
  const failed = failedOf({ 'set-cookie': 'a=1', 'x-powered-by': 'Express' });
  assert.deepEqual(failed, order);
});

test('every check failing floors the score at 0 instead of going negative', () => {
  const g = gradeHeaders({ 'set-cookie': 'a=1', 'x-powered-by': 'Express' });
  assert.equal(g.failed.length, CHECKS.length);
  assert.equal(g.score, 0);
  assert.equal(g.grade, 'F');
});

test('letter grades use A >= 90, B >= 75, C >= 60, D >= 40, F below', () => {
  // xcto -10 -> 90
  assert.deepEqual(gradeHeaders(without('x-content-type-options')), { score: 90, grade: 'A', failed: ['xcto'] });
  // csp -25 -> 75 (x-frame-options keeps frame passing)
  assert.deepEqual(gradeHeaders(without('content-security-policy')), { score: 75, grade: 'B', failed: ['csp'] });
  // csp + frame -40 -> 60
  assert.deepEqual(gradeHeaders(without('content-security-policy', 'x-frame-options')), { score: 60, grade: 'C', failed: ['csp', 'frame'] });
  // csp + hsts + frame -60 -> 40
  assert.deepEqual(
    gradeHeaders(without('content-security-policy', 'strict-transport-security', 'x-frame-options')),
    { score: 40, grade: 'D', failed: ['csp', 'hsts', 'frame'] },
  );
  // ... plus banner -65 -> 35
  assert.deepEqual(
    gradeHeaders({ ...without('content-security-policy', 'strict-transport-security', 'x-frame-options'), 'x-powered-by': 'PHP' }),
    { score: 35, grade: 'F', failed: ['csp', 'hsts', 'frame', 'banner'] },
  );
});

test('header names are matched case-insensitively', () => {
  const mixed = {
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
    'STRICT-TRANSPORT-SECURITY': 'max-age=31536000',
    'X-Frame-Options': 'DENY',
    'x-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=()',
    'Set-Cookie': 'sid=abc; Secure; HttpOnly',
    Server: 'nginx',
  };
  assert.deepEqual(gradeHeaders(mixed), { score: 100, grade: 'A', failed: [] });
  const upper = Object.fromEntries(Object.entries(FULL).map(([k, v]) => [k.toUpperCase(), v]));
  assert.deepEqual(gradeHeaders(upper), { score: 100, grade: 'A', failed: [] });
  // and a bad value is still caught under a mixed-case name
  assert.deepEqual(failedOf({ ...mixed, 'X-Powered-By': 'Express' }), ['banner']);
});

test('gradeHeaders does not change its input and rejects a non-object', () => {
  const frozen = deepFreeze({ 'Set-Cookie': ['a=1', 'b=2; Secure; HttpOnly'], 'X-Content-Type-Options': 'nosniff' });
  assert.doesNotThrow(() => gradeHeaders(frozen));
  for (const bad of [null, undefined, 'x', 42, ['a']]) {
    assert.throws(() => gradeHeaders(bad), TypeError);
  }
});

test('a fetch Headers object or a Map is refused, not graded as a response with no headers', () => {
  const fetched = new Headers({ 'x-content-type-options': 'nosniff' });
  assert.throws(() => gradeHeaders(fetched), TypeError);
  assert.throws(() => gradeHeaders(new Map([['x-content-type-options', 'nosniff']])), TypeError);
  assert.throws(() => fromHeaders(result(fetched), CTX), TypeError);
  // a plain object holding the same entries is fine, and so is one without a prototype
  assert.deepEqual(gradeHeaders(Object.fromEntries(fetched)).failed, ['csp', 'hsts', 'frame', 'referrer', 'permissions']);
  assert.deepEqual(gradeHeaders(Object.assign(Object.create(null), FULL)), { score: 100, grade: 'A', failed: [] });
});

test('a header value that is not a string is treated as absent, an array of strings is joined', () => {
  assert.deepEqual(failedOf(with_({ 'content-security-policy': 42 })), ['csp']);
  assert.deepEqual(failedOf(with_({ 'content-security-policy': undefined })), ['csp']);
  assert.deepEqual(failedOf(with_({ 'content-security-policy': null })), ['csp']);
  assert.deepEqual(failedOf(with_({ 'x-content-type-options': ['nosniff'] })), []);
});

// ---- csp ------------------------------------------------------------------------------------

test('csp passes with a non-empty content-security-policy and fails when absent or blank', () => {
  assert.ok(!failedOf(with_({ 'content-security-policy': "default-src 'self'" })).includes('csp'));
  assert.deepEqual(failedOf(without('content-security-policy')), ['csp']);
  assert.deepEqual(failedOf(with_({ 'content-security-policy': '' })), ['csp']);
  assert.deepEqual(failedOf(with_({ 'content-security-policy': '   ' })), ['csp']);
});

test('csp does not count the report-only header', () => {
  assert.deepEqual(failedOf({ ...without('content-security-policy'), 'content-security-policy-report-only': "default-src 'self'" }), ['csp']);
});

// ---- hsts -----------------------------------------------------------------------------------

test('hsts needs max-age of at least 15552000', () => {
  const hsts = (value) => failedOf(with_({ 'strict-transport-security': value })).includes('hsts');
  assert.equal(hsts('max-age=300'), true);
  assert.equal(hsts('max-age=15551999'), true);
  assert.equal(hsts('max-age=15552000'), false);
  assert.equal(hsts('max-age=31536000; includeSubDomains; preload'), false);
  assert.equal(hsts('includeSubDomains; max-age=31536000'), false);
  assert.equal(hsts('Max-Age=31536000'), false);
  assert.equal(hsts('max-age="31536000"'), false);
  assert.equal(hsts('includeSubDomains'), true);
  assert.equal(hsts(''), true);
  assert.equal(hsts('max-age=abc'), true);
  assert.equal(hsts('x-max-age=31536000'), true);
  assert.deepEqual(failedOf(without('strict-transport-security')), ['hsts']);
});

// ---- frame ----------------------------------------------------------------------------------

test('frame passes with x-frame-options DENY or SAMEORIGIN in any case, or a csp frame-ancestors directive', () => {
  const frame = (extra) => failedOf({ ...without('x-frame-options', 'content-security-policy'), 'content-security-policy': "default-src 'self'", ...extra }).includes('frame');
  assert.equal(frame({ 'x-frame-options': 'DENY' }), false);
  assert.equal(frame({ 'x-frame-options': 'deny' }), false);
  assert.equal(frame({ 'x-frame-options': 'SameOrigin' }), false);
  assert.equal(frame({ 'x-frame-options': 'ALLOW-FROM https://a.example' }), true);
  assert.equal(frame({ 'x-frame-options': '' }), true);
  assert.equal(frame({}), true);
  assert.equal(frame({ 'content-security-policy': "default-src 'self'; frame-ancestors 'self'" }), false);
  assert.equal(frame({ 'content-security-policy': "frame-ancestors 'none'" }), false);
  assert.equal(frame({ 'content-security-policy': "default-src 'self'; FRAME-ANCESTORS 'self'" }), false);
});

test('frame needs frame-ancestors as a directive, not a substring of another value', () => {
  const headers = { ...without('x-frame-options'), 'content-security-policy': "default-src 'self'; report-uri /frame-ancestors-report" };
  assert.deepEqual(failedOf(headers), ['frame']);
});

// ---- xcto -----------------------------------------------------------------------------------

test('xcto passes only for nosniff', () => {
  const xcto = (value) => failedOf(with_({ 'x-content-type-options': value })).includes('xcto');
  assert.equal(xcto('nosniff'), false);
  assert.equal(xcto('NoSniff'), false);
  assert.equal(xcto(' nosniff '), false);
  assert.equal(xcto('sniff'), true);
  assert.equal(xcto('nosniffx'), true);
  assert.equal(xcto('no-nosniff'), true);
  assert.equal(xcto('nosniff, nosniff'), false); // a repeated header arrives joined
  assert.equal(xcto('sniff, nosniff'), true); // browsers read the first value
  assert.equal(xcto(''), true);
  assert.deepEqual(failedOf(without('x-content-type-options')), ['xcto']);
});

// ---- referrer -------------------------------------------------------------------------------

test('referrer passes when present and not unsafe-url', () => {
  const referrer = (value) => failedOf(with_({ 'referrer-policy': value })).includes('referrer');
  assert.equal(referrer('no-referrer'), false);
  assert.equal(referrer('strict-origin-when-cross-origin'), false);
  assert.equal(referrer('unsafe-url'), true);
  assert.equal(referrer('UNSAFE-URL'), true);
  assert.equal(referrer('no-referrer, unsafe-url'), true);
  assert.equal(referrer('unsafe-url, no-referrer'), false); // browsers use the last token they understand
  assert.equal(referrer(''), true);
  assert.deepEqual(failedOf(without('referrer-policy')), ['referrer']);
});

// ---- permissions ----------------------------------------------------------------------------

test('permissions passes when permissions-policy is present', () => {
  assert.deepEqual(failedOf(without('permissions-policy')), ['permissions']);
  assert.deepEqual(failedOf(with_({ 'permissions-policy': '' })), ['permissions']);
  assert.deepEqual(failedOf(with_({ 'permissions-policy': 'geolocation=()' })), []);
});

// ---- cookies --------------------------------------------------------------------------------

test('cookies passes when there are no cookies', () => {
  assert.deepEqual(failedOf(without('set-cookie')), []);
  assert.deepEqual(failedOf(with_({ 'set-cookie': [] })), []);
  assert.deepEqual(failedOf(with_({ 'set-cookie': '' })), []);
});

test('cookies fails for a cookie without Secure and HttpOnly', () => {
  assert.deepEqual(failedOf(with_({ 'set-cookie': 'a=1' })), ['cookies']);
  assert.deepEqual(failedOf(with_({ 'set-cookie': 'a=1; Secure' })), ['cookies']);
  assert.deepEqual(failedOf(with_({ 'set-cookie': 'a=1; HttpOnly' })), ['cookies']);
  assert.deepEqual(failedOf(with_({ 'set-cookie': 'a=1; Path=/; SameSite=Lax' })), ['cookies']);
});

test('cookies passes when Secure and HttpOnly are set, in any case or order', () => {
  assert.deepEqual(failedOf(with_({ 'set-cookie': 'a=1; Secure; HttpOnly' })), []);
  assert.deepEqual(failedOf(with_({ 'set-cookie': 'a=1; httponly; secure; Path=/' })), []);
  assert.deepEqual(failedOf(with_({ 'set-cookie': 'a=1; HTTPONLY; SECURE' })), []);
});

test('cookies handles set-cookie as an array and as a single string, and every cookie must carry both flags', () => {
  const good = 'a=1; Secure; HttpOnly';
  const bad = 'b=2; Path=/';
  assert.deepEqual(failedOf(with_({ 'set-cookie': good })), []);
  assert.deepEqual(failedOf(with_({ 'set-cookie': [good] })), []);
  assert.deepEqual(failedOf(with_({ 'set-cookie': [good, good] })), []);
  assert.deepEqual(failedOf(with_({ 'set-cookie': [good, bad] })), ['cookies']);
  assert.deepEqual(failedOf(with_({ 'set-cookie': [bad, good] })), ['cookies']);
  assert.deepEqual(failedOf(with_({ 'set-cookie': bad })), ['cookies']);
});

test('cookies splits one string holding several cookies, and an Expires comma is not a split point', () => {
  const expires = 'Expires=Wed, 21 Oct 2026 07:28:00 GMT';
  assert.deepEqual(failedOf(with_({ 'set-cookie': `a=1; ${expires}; Secure; HttpOnly` })), []);
  assert.deepEqual(failedOf(with_({ 'set-cookie': `a=1; ${expires}; Secure; HttpOnly, b=2; Secure; HttpOnly` })), []);
  assert.deepEqual(failedOf(with_({ 'set-cookie': `a=1; ${expires}; Secure; HttpOnly, b=2; Path=/` })), ['cookies']);
  assert.deepEqual(failedOf(with_({ 'set-cookie': `b=2; Path=/, a=1; ${expires}; Secure; HttpOnly` })), ['cookies']);
});

test('two spellings of set-cookie are one header: every line from both is checked', () => {
  const base = without('set-cookie');
  assert.deepEqual(failedOf({ ...base, 'Set-Cookie': 'a=1', 'set-cookie': 'b=2; Secure; HttpOnly' }), ['cookies']);
  assert.deepEqual(failedOf({ ...base, 'Set-Cookie': 'a=1; Secure; HttpOnly', 'set-cookie': 'b=2' }), ['cookies']);
  assert.deepEqual(failedOf({ ...base, 'Set-Cookie': 'a=1; Secure; HttpOnly', 'set-cookie': ['b=2; Secure; HttpOnly'] }), []);
});

test('a cookie whose name or value says Secure or HttpOnly does not count as having the flag', () => {
  assert.deepEqual(failedOf(with_({ 'set-cookie': 'Secure=HttpOnly' })), ['cookies']);
  assert.deepEqual(failedOf(with_({ 'set-cookie': 'Secure=1; HttpOnly' })), ['cookies']);
  assert.deepEqual(failedOf(with_({ 'set-cookie': 'HttpOnly=1; Secure' })), ['cookies']);
  assert.deepEqual(failedOf(with_({ 'set-cookie': 'a=secure-httponly; Path=/' })), ['cookies']);
});

// ---- banner ---------------------------------------------------------------------------------

test('banner fails on x-powered-by or a server header with a version', () => {
  const banner = (extra) => failedOf({ ...without('server'), ...extra }).includes('banner');
  assert.equal(banner({}), false);
  assert.equal(banner({ server: 'nginx' }), false);
  assert.equal(banner({ server: 'cloudflare' }), false);
  assert.equal(banner({ server: 'nginx/1.18.0' }), true);
  assert.equal(banner({ server: 'Apache/2.4.41 (Ubuntu)' }), true);
  assert.equal(banner({ server: 'Microsoft-IIS/10.0' }), true);
  assert.equal(banner({ 'x-powered-by': 'Express' }), true);
  assert.equal(banner({ server: 'nginx', 'x-powered-by': 'PHP/8.2' }), true);
  assert.equal(banner({ 'x-powered-by': '' }), false);
});

// ---- fromHeaders ----------------------------------------------------------------------------

const CWE = { csp: 'CWE-79', hsts: 'CWE-319', frame: 'CWE-1021', xcto: 'CWE-16', referrer: 'CWE-200', permissions: 'CWE-16', cookies: 'CWE-614', banner: 'CWE-200' };

test('fromHeaders makes one hardening finding per failed check and every one validates', () => {
  const findings = fromHeaders(result({ 'x-content-type-options': 'nosniff' }), CTX);
  assert.deepEqual(findings.map((f) => f.ruleId), ['headers/csp', 'headers/hsts', 'headers/frame', 'headers/referrer', 'headers/permissions']);
  for (const f of findings) {
    const { ok, errors } = validate(findingSchema, f);
    assert.ok(ok, `${f.ruleId} does not validate: ${errors.join('; ')}`);
  }
  assert.equal(new Set(findings.map((f) => f.id)).size, findings.length);
});

test('fromHeaders fills in the documented fields', () => {
  const headers = { 'set-cookie': 'sid=SECRETVALUE1', 'x-powered-by': 'Express' };
  const findings = fromHeaders({ url: URL_, status: 200, headers }, CTX);
  assert.equal(findings.length, CHECKS.length);
  CHECKS.forEach((check, i) => {
    const f = findings[i];
    assert.equal(f.ruleId, `headers/${check.id}`);
    assert.equal(f.source, 'headers');
    assert.equal(f.class, 'hardening');
    assert.equal(f.layer, 'L1');
    assert.equal(f.severity, check.severity);
    assert.equal(f.confidence, 'HIGH');
    assert.deepEqual(f.cwe, [CWE[check.id]]);
    assert.deepEqual(f.location, { url: URL_, header: check.id });
    assert.equal(f.title, check.title);
    assert.equal(f.project, 'example-app');
    assert.equal(f.system, 'web');
    assert.equal(f.pack, null);
    assert.equal(f.fixedIn, null);
    assert.equal(f.status, 'open');
    assert.equal(f.firstSeen, NOW);
    assert.equal(f.lastSeen, NOW);
    assert.deepEqual(f.verification, { verifiers: 0, confirmed: 0, run: RUN });
    assert.deepEqual(f.externalIds, { claudeSecurityPluginFindingId: null, cve: null });
    assert.equal(f.id, findingId({ project: 'example-app', system: 'web', ruleId: `headers/${check.id}`, location: { url: URL_, header: check.id } }));
    assert.match(f.id, /^[0-9a-f]{12}$/);
    for (const key of ['evidence', 'exploitScenario', 'preconditions', 'recommendation']) {
      assert.equal(typeof f[key], 'string', `${check.id}.${key}`);
      assert.ok(f[key].length > 0, `${check.id}.${key} is empty`);
    }
  });
});

test('fromHeaders evidence names the header and the recommendation gives the line to add', () => {
  const byId = Object.fromEntries(fromHeaders(result({ 'set-cookie': 'sid=abc', 'x-powered-by': 'Express', 'strict-transport-security': 'max-age=300' }), CTX).map((f) => [f.ruleId.replace('headers/', ''), f]));
  assert.match(byId.csp.evidence, /Content-Security-Policy/);
  assert.match(byId.csp.recommendation, /Content-Security-Policy: /);
  assert.match(byId.hsts.evidence, /Strict-Transport-Security/);
  assert.match(byId.hsts.evidence, /15552000/);
  assert.match(byId.hsts.recommendation, /Strict-Transport-Security: max-age=\d+/);
  assert.match(byId.frame.evidence, /X-Frame-Options/);
  assert.match(byId.frame.recommendation, /X-Frame-Options: DENY/);
  assert.match(byId.xcto.evidence, /X-Content-Type-Options/);
  assert.match(byId.xcto.recommendation, /X-Content-Type-Options: nosniff/);
  assert.match(byId.referrer.evidence, /Referrer-Policy/);
  assert.match(byId.referrer.recommendation, /Referrer-Policy: /);
  assert.match(byId.permissions.evidence, /Permissions-Policy/);
  assert.match(byId.permissions.recommendation, /Permissions-Policy: /);
  assert.match(byId.cookies.evidence, /Set-Cookie/);
  assert.match(byId.cookies.recommendation, /Secure/);
  assert.match(byId.cookies.recommendation, /HttpOnly/);
  assert.match(byId.banner.evidence, /X-Powered-By/);
  assert.match(byId.banner.recommendation, /X-Powered-By/);
});

test('fromHeaders evidence says which side of a check failed', () => {
  const evidence = (headers, id) => fromHeaders(result(headers), CTX).find((f) => f.ruleId === `headers/${id}`).evidence;
  assert.notEqual(evidence({}, 'hsts'), evidence({ 'strict-transport-security': 'max-age=300' }, 'hsts'));
  assert.notEqual(evidence({}, 'referrer'), evidence({ 'referrer-policy': 'unsafe-url' }, 'referrer'));
  assert.match(evidence({ 'referrer-policy': 'unsafe-url' }, 'referrer'), /unsafe-url/);
  assert.match(evidence({ server: 'nginx/1.18.0' }, 'banner'), /Server/);
  assert.doesNotMatch(evidence({ server: 'nginx/1.18.0' }, 'banner'), /X-Powered-By/);
});

test('fromHeaders never puts a cookie name or value, or a banner value, into a finding', () => {
  const headers = {
    'set-cookie': ['sessionid=SUPERSECRETVALUE123; Path=/', 'csrf=OTHERSECRET456; Secure; HttpOnly'],
    'x-powered-by': 'Express/4.18.2',
    server: 'nginx/1.18.0',
    'strict-transport-security': 'max-age=300',
  };
  const text = JSON.stringify(fromHeaders(result(headers), CTX));
  for (const leak of ['SUPERSECRETVALUE123', 'OTHERSECRET456', 'sessionid', 'csrf', 'Express/4.18.2', '4.18.2', 'nginx/1.18.0', '1.18.0']) {
    assert.ok(!text.includes(leak), `finding text contains ${leak}`);
  }
});

test('fromHeaders cookie evidence counts the cookies that lack a flag', () => {
  const f = fromHeaders(result(with_({ 'set-cookie': ['a=1', 'b=2; Secure; HttpOnly', 'c=3; Secure'] })), CTX).find((x) => x.ruleId === 'headers/cookies');
  assert.match(f.evidence, /2 of 3/);
});

test('fromHeaders is stable: same input, same ids; a different url gives different ids', () => {
  const headers = { 'x-content-type-options': 'nosniff' };
  const a = fromHeaders(result(headers), CTX);
  const b = fromHeaders(result(headers), CTX);
  assert.deepEqual(a.map((f) => f.id), b.map((f) => f.id));
  const c = fromHeaders({ url: 'https://other.example/', status: 200, headers }, CTX);
  assert.equal(new Set([...a, ...c].map((f) => f.id)).size, a.length + c.length);
});

test('fromHeaders does not change its input', () => {
  const frozen = deepFreeze({ url: URL_, status: 200, headers: { 'Set-Cookie': ['a=1'], 'X-Powered-By': 'Express' } });
  assert.doesNotThrow(() => fromHeaders(frozen, CTX));
});

test('fromHeaders uses the current time when ctx.now is missing', () => {
  const before = Date.now();
  const [f] = fromHeaders(result({}), { project: 'example-app', system: 'web', runId: RUN });
  assert.ok(Date.parse(f.firstSeen) >= before - 1000);
  assert.equal(f.firstSeen, f.lastSeen);
});

test('fromHeaders rejects a bad ctx or a bad result', () => {
  assert.throws(() => fromHeaders(result({}), undefined), TypeError);
  assert.throws(() => fromHeaders(result({}), { project: 'p', system: 's' }), TypeError);
  assert.throws(() => fromHeaders(null, CTX), TypeError);
  assert.throws(() => fromHeaders({ status: 200, headers: {} }, CTX), TypeError);
  assert.throws(() => fromHeaders({ url: '', status: 200, headers: {} }, CTX), TypeError);
  assert.throws(() => fromHeaders({ url: URL_, status: 200 }, CTX), TypeError);
  assert.throws(() => fromHeaders({ url: URL_, status: 200, headers: 'x' }, CTX), TypeError);
});
