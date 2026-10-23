const test = require('node:test');
const assert = require('node:assert/strict');
const { redact, REDACTED } = require('../scripts/lib/redact.cjs');

// Credential-shaped fixtures are assembled from parts so this file does not itself trip secret scanners.
const j = (...parts) => parts.join('');

test('REDACTED is the literal marker', () => {
  assert.equal(REDACTED, '[REDACTED]');
});

test('an AWS access key id is replaced', () => {
  assert.equal(redact('key AKIAIOSFODNN7EXAMPLE end'), 'key [REDACTED] end');
});

test('a three-part JWT is replaced', () => {
  const jwt = j(
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.',
    'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.',
    'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
  );
  assert.equal(redact(`Authorization: Bearer ${jwt}`), 'Authorization: Bearer [REDACTED]');
});

test('PASSWORD=value keeps the key and redacts the value', () => {
  assert.equal(redact('PASSWORD=hunter2hunter2'), 'PASSWORD=[REDACTED]');
});

test('a PEM private key block collapses to a single marker', () => {
  const pem = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun',
    'VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n');
  assert.equal(redact(`before\n${pem}\nafter`), 'before\n[REDACTED]\nafter');
});

test('an unterminated PEM block is redacted to the end of the text', () => {
  const text = 'head\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC';
  assert.equal(redact(text), 'head\n[REDACTED]');
});

test('an sk_live_ token is replaced', () => {
  assert.equal(redact(`stripe ${j('sk_', 'live_', '4eC39HqLyjWDarjtT1zdp7dc')} ok`), 'stripe [REDACTED] ok');
});

test('an sk-ant- token is replaced', () => {
  assert.equal(redact(`key ${j('sk-', 'ant-', 'api03-AbCdEf_123-xyz')} ok`), 'key [REDACTED] ok');
});

test('the other known prefixes are replaced', () => {
  const cases = [
    j('sk_', 'test_', '51H8abcdefghijklmnop'),
    j('gh', 'p_', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'),
    j('gh', 'o_', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'),
    j('xo', 'xb-', '123456789012-abcdefghijklmnop'),
    j('xo', 'xp-', '123456789012-abcdefghijklmnop'),
    j('AI', 'za', 'SyA1234567890abcdefghijklmnopqrst_-'),
  ];
  for (const secret of cases) {
    assert.equal(redact(`x ${secret} y`), 'x [REDACTED] y', secret);
  }
});

test('a plain code line is unchanged', () => {
  assert.equal(redact('const x = add(1, 2);'), 'const x = add(1, 2);');
});

test('boolean and short values are not treated as secrets', () => {
  assert.equal(redact('GOTRUE_DISABLE_SIGNUP=false'), 'GOTRUE_DISABLE_SIGNUP=false');
  assert.equal(redact('password=short'), 'password=short');
  assert.equal(redact('token: null'), 'token: null');
  assert.equal(redact('SECRET=1'), 'SECRET=1');
});

test('a value of exactly 8 characters is redacted', () => {
  assert.equal(redact('password=12345678'), 'password=[REDACTED]');
});

test('the key=value rule is case-insensitive and covers each key name', () => {
  const keys = ['password', 'PASSWD', 'Secret', 'token', 'api_key', 'API-KEY', 'apikey', 'private_key', 'PRIVATE-KEY'];
  for (const key of keys) {
    assert.equal(redact(`${key}=abcdefgh12345`), `${key}=[REDACTED]`, key);
  }
});

test('the key=value rule keeps the separator and tolerates quotes', () => {
  assert.equal(redact('secret: "abcdefgh12345"'), 'secret: "[REDACTED]"');
  assert.equal(redact("token = 'abcdefgh12345'"), "token = '[REDACTED]'");
  assert.equal(redact('{"password": "hunter2hunter2"}'), '{"password": "[REDACTED]"}');
});

test('a secret inside a longer variable name keeps its prefix', () => {
  assert.equal(redact('GOTRUE_JWT_SECRET=abcdefgh12345'), 'GOTRUE_JWT_SECRET=[REDACTED]');
});

test('every match in a multi-line text is redacted', () => {
  const input = 'user=pedro\npassword=hunter2hunter2\nkey AKIAIOSFODNN7EXAMPLE\nPORT=5432';
  assert.equal(redact(input), 'user=pedro\npassword=[REDACTED]\nkey [REDACTED]\nPORT=5432');
});

test('redacting twice gives the same result', () => {
  const once = redact('password=hunter2hunter2 and AKIAIOSFODNN7EXAMPLE');
  assert.equal(redact(once), once);
});

test('non-string input is returned unchanged', () => {
  const obj = { a: 1 };
  assert.equal(redact(undefined), undefined);
  assert.equal(redact(null), null);
  assert.equal(redact(42), 42);
  assert.equal(redact(obj), obj);
});
