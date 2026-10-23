'use strict';

// Observatory-style rubric for the security headers of a live response. Pure functions, no I/O.
//
// A response starts at 100 and loses the weight of every failed check; the score floors at 0 (the weights add up to 105).
// The letter grade uses the same thresholds as the project score: A >= 90, B >= 75, C >= 60, D >= 40, F below.
//
// Each check carries what a finding needs, so a new check cannot be added without its text: cwe, recommendation, and
// evidence(headers), which names the header that is missing or wrong. Evidence never repeats a header value: cookie names
// and values stay out, and so do server banners. Only a number the rubric itself defines (the HSTS minimum) is written out.

const HSTS_MIN_AGE = 15552000; // 180 days, in seconds
const GRADES = [[90, 'A'], [75, 'B'], [60, 'C'], [40, 'D']];

const gradeOf = (score) => {
  const hit = GRADES.find(([min]) => score >= min);
  return hit ? hit[1] : 'F';
};

// Header names to lower case. A value is a string, or for several lines of one header an array of strings. Anything else is
// dropped, so it reads as absent. Two names that differ only in case are one header. Every value is a string except
// set-cookie, which stays an array of the lines (a cookie line can hold a comma, so the lines are never joined). Pass this
// to CHECKS[i].test; gradeHeaders and runChecks do it for you.
//
// The input must be a plain object. A fetch Headers or a Map has no own keys to read, so it would look like a response with
// no headers at all and earn a false F; it is refused instead of graded.
function normalizeHeaders(headers) {
  const proto = headers !== null && typeof headers === 'object' ? Object.getPrototypeOf(headers) : undefined;
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError('headers must be a plain object keyed by header name (convert a fetch Headers object first)');
  }
  const lines = new Map();
  for (const [name, raw] of Object.entries(headers)) {
    const values = (Array.isArray(raw) ? raw : [raw]).filter((v) => typeof v === 'string');
    if (values.length === 0) continue;
    const key = name.toLowerCase();
    lines.set(key, (lines.get(key) || []).concat(values));
  }
  const out = Object.create(null);
  for (const [key, values] of lines) out[key] = key === 'set-cookie' ? values : values.join(', ');
  return out;
}

// The trimmed value of a header, '' when it is absent.
const text = (h, name) => {
  const v = h[name];
  return (Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : '').trim();
};

// One entry per cookie. A string may hold several cookies joined by a comma (what fetch gives for a combined header); a
// comma starts a new cookie only when a name= follows, so the comma inside Expires=Wed, 21 Oct 2026 ... stays put.
function cookieLines(h) {
  const v = h['set-cookie'];
  const items = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  return items.flatMap((s) => s.split(/,(?=\s*[^;,\s=]+=)/)).map((s) => s.trim()).filter(Boolean);
}

// The attribute names of one cookie. The first segment is name=value, so a cookie called Secure is not a Secure cookie.
const cookieAttributes = (cookie) => new Set(cookie.split(';').slice(1).map((a) => a.split('=')[0].trim().toLowerCase()));
const lacksFlags = (cookie) => {
  const attrs = cookieAttributes(cookie);
  return !(attrs.has('secure') && attrs.has('httponly'));
};

const hstsMaxAge = (value) => {
  const m = /(?:^|;)\s*max-age\s*=\s*"?(\d+)"?\s*(?:;|$)/i.exec(value);
  return m ? Number(m[1]) : null;
};

// frame-ancestors as a directive of the policy, not as a word inside another directive's value.
const hasFrameAncestors = (csp) => /(?:^|[;,])\s*frame-ancestors(?=\s|;|,|$)/i.test(csp);

// The policy browsers apply is the last token they understand, so a fallback list is judged by its last entry.
const effectiveReferrer = (value) => value.split(',').pop().trim().toLowerCase();

const frameOptionsOk = (h) => ['deny', 'sameorigin'].includes(text(h, 'x-frame-options').toLowerCase());
const bannerParts = (h) => [
  text(h, 'x-powered-by') ? 'X-Powered-By header is set' : null,
  /\d/.test(text(h, 'server')) ? 'Server header includes a version string' : null,
].filter(Boolean);

const CHECKS = Object.freeze([
  {
    id: 'csp',
    title: 'Content-Security-Policy header is missing',
    weight: 25,
    severity: 'HIGH',
    cwe: ['CWE-79'],
    test: (h) => text(h, 'content-security-policy') !== '',
    evidence: () => 'Content-Security-Policy header is missing or empty',
    recommendation: "Add the header: Content-Security-Policy: default-src 'self'; frame-ancestors 'self' (then allow only the sources the site loads).",
  },
  {
    id: 'hsts',
    title: 'Strict-Transport-Security header is missing or too short',
    weight: 20,
    severity: 'MEDIUM',
    cwe: ['CWE-319'],
    test: (h) => (hstsMaxAge(text(h, 'strict-transport-security')) ?? -1) >= HSTS_MIN_AGE,
    evidence: (h) => (text(h, 'strict-transport-security')
      ? `Strict-Transport-Security has no max-age of at least ${HSTS_MIN_AGE} seconds`
      : 'Strict-Transport-Security header is missing'),
    recommendation: 'Add the header: Strict-Transport-Security: max-age=31536000; includeSubDomains',
  },
  {
    id: 'frame',
    title: 'No clickjacking protection (X-Frame-Options or CSP frame-ancestors)',
    weight: 15,
    severity: 'MEDIUM',
    cwe: ['CWE-1021'],
    test: (h) => frameOptionsOk(h) || hasFrameAncestors(text(h, 'content-security-policy')),
    evidence: () => 'Neither X-Frame-Options (DENY or SAMEORIGIN) nor a Content-Security-Policy frame-ancestors directive is set',
    recommendation: "Add the header: X-Frame-Options: DENY (or Content-Security-Policy: frame-ancestors 'none').",
  },
  {
    id: 'xcto',
    title: 'X-Content-Type-Options: nosniff is missing',
    weight: 10,
    severity: 'LOW',
    cwe: ['CWE-16'],
    test: (h) => text(h, 'x-content-type-options').split(',')[0].trim().toLowerCase() === 'nosniff',
    evidence: (h) => (text(h, 'x-content-type-options') ? 'X-Content-Type-Options is not set to nosniff' : 'X-Content-Type-Options header is missing'),
    recommendation: 'Add the header: X-Content-Type-Options: nosniff',
  },
  {
    id: 'referrer',
    title: 'Referrer-Policy header is missing or unsafe',
    weight: 10,
    severity: 'LOW',
    cwe: ['CWE-200'],
    test: (h) => {
      const policy = effectiveReferrer(text(h, 'referrer-policy'));
      return policy !== '' && policy !== 'unsafe-url';
    },
    evidence: (h) => (text(h, 'referrer-policy')
      ? 'Referrer-Policy is unsafe-url, which sends the full URL to every site the page links to'
      : 'Referrer-Policy header is missing'),
    recommendation: 'Add the header: Referrer-Policy: strict-origin-when-cross-origin',
  },
  {
    id: 'permissions',
    title: 'Permissions-Policy header is missing',
    weight: 10,
    severity: 'LOW',
    cwe: ['CWE-16'],
    test: (h) => text(h, 'permissions-policy') !== '',
    evidence: () => 'Permissions-Policy header is missing or empty',
    recommendation: 'Add the header: Permissions-Policy: camera=(), microphone=(), geolocation=()',
  },
  {
    id: 'cookies',
    title: 'Cookies are set without Secure and HttpOnly',
    weight: 10,
    severity: 'MEDIUM',
    cwe: ['CWE-614'],
    test: (h) => !cookieLines(h).some(lacksFlags),
    evidence: (h) => {
      const all = cookieLines(h);
      const bad = all.filter(lacksFlags).length;
      return `${bad} of ${all.length} Set-Cookie ${all.length === 1 ? 'header is' : 'headers are'} missing the Secure or HttpOnly attribute`;
    },
    recommendation: 'Add the Secure and HttpOnly attributes to every cookie, for example: Set-Cookie: <name>=<value>; Secure; HttpOnly; SameSite=Lax',
  },
  {
    id: 'banner',
    title: 'Response discloses server software or its version',
    weight: 5,
    severity: 'LOW',
    cwe: ['CWE-200'],
    test: (h) => bannerParts(h).length === 0,
    evidence: (h) => bannerParts(h).join(' and '),
    recommendation: 'Remove the X-Powered-By header and strip the version from the Server header (for example Server: nginx).',
  },
].map(Object.freeze));

// Normalizes the headers once and runs every check. failed holds the CHECKS entries that did not pass, in CHECKS order, and
// headers the normalized map, which is what each check's evidence() reads.
function runChecks(headers) {
  const normalized = normalizeHeaders(headers);
  return { headers: normalized, failed: CHECKS.filter((check) => !check.test(normalized)) };
}

function gradeHeaders(headers) {
  const { failed } = runChecks(headers);
  const score = Math.max(0, 100 - failed.reduce((sum, check) => sum + check.weight, 0));
  return { score, grade: gradeOf(score), failed: failed.map((check) => check.id) };
}

module.exports = { CHECKS, gradeHeaders, runChecks, normalizeHeaders };
