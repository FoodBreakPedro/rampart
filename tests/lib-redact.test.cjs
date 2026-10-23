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

const JWT = j(
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.',
  'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.',
  'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
);

test('a three-part JWT is replaced', () => {
  assert.equal(redact(`x ${JWT} y`), 'x [REDACTED] y');
});

test('a JWT inside a URL is replaced', () => {
  assert.equal(redact(`https://x.test/cb?code=${JWT}&next=/`), 'https://x.test/cb?code=[REDACTED]&next=/');
  assert.equal(redact(`https://x.test/auth/${JWT}/done`), 'https://x.test/auth/[REDACTED]/done');
});

test('T3: a JWT right after a URL-encoded character is replaced (Bearer%20<jwt>, token%3D<jwt>)', () => {
  assert.equal(redact(`Authorization: Bearer%20${JWT}`), 'Authorization: Bearer%20[REDACTED]');
  assert.equal(redact(`https://x.test/cb?state=token%3D${JWT}&next=/`), 'https://x.test/cb?state=token%3D[REDACTED]&next=/');
  assert.equal(redact(`next=%2F${JWT}`), 'next=%2F[REDACTED]');
  assert.equal(redact(`abc${JWT}`), `abc${JWT}`, 'still never inside an ordinary base64url run');
});

test('redaction stays fast on pathological input', () => {
  const inputs = {
    'eyJ x 66667 (200 KB)': 'eyJ'.repeat(66667),
    '%3DeyJ x 33334 (200 KB)': '%3DeyJ'.repeat(33334),
    '%3DeyJa. x 25000': '%3DeyJa.'.repeat(25000),
    'secret x 33334': 'secret'.repeat(33334),
    'password=" x 20000': 'password="'.repeat(20000),
    'bearer x 28572': 'Bearer '.repeat(28572),
    'a x 200000': 'a'.repeat(200000),
    '://a:a x 40000': '://a:a'.repeat(40000),
    'authorization x 15385': 'authorization'.repeat(15385),
    'unclosed quote, long value': 'password="' + 'ab '.repeat(70000),
    'unclosed quote, backslashes': 'password="' + '\\'.repeat(200000),
    'backslashes x 200000': '\\'.repeat(200000),
  };
  for (const [name, input] of Object.entries(inputs)) {
    const start = performance.now();
    redact(input);
    const ms = performance.now() - start;
    assert.ok(ms < 200, `${name} took ${ms.toFixed(1)} ms`);
  }
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

test('a PEM block with CRLF line endings collapses to a single marker', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\r\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\r\nKgwggSmAgEAAoIBAQDH\r\n-----END PRIVATE KEY-----';
  assert.equal(redact(`a\r\n${pem}\r\nb`), 'a\r\n[REDACTED]\r\nb');
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
    j('AS', 'IA', 'IOSFODNN7EXAMPLE'),
    j('github', '_pat_', '11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP'),
    j('sk-', 'proj-', 'AbCdEf_123-xyzAbCdEf'),
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

test('the key=value separator does not span a newline', () => {
  assert.equal(redact('secret:\nconfiguration'), 'secret:\nconfiguration');
  assert.equal(redact('secret:\r\nconfiguration'), 'secret:\r\nconfiguration');
  assert.equal(redact('password=\nhunter2hunter2'), 'password=\nhunter2hunter2');
});

test('a key name with a suffix is still a key', () => {
  assert.equal(
    redact('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY'),
    'AWS_SECRET_ACCESS_KEY=[REDACTED]'
  );
  assert.equal(
    redact('aws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY'),
    'aws_secret_access_key = [REDACTED]'
  );
  assert.equal(redact('SECRET_KEY=django-insecure-abcdefghijkl'), 'SECRET_KEY=[REDACTED]');
  assert.equal(redact('clientSecret: "abcdefgh12345"'), 'clientSecret: "[REDACTED]"');
});

test('a quoted value is redacted up to its closing quote, spaces included', () => {
  assert.equal(redact('password="correct horse battery staple"'), 'password="[REDACTED]"');
  assert.equal(redact('password="hunter2hunter2 plus words"'), 'password="[REDACTED]"');
  assert.equal(redact('password: "p@ss w0rd"'), 'password: "[REDACTED]"');
  assert.equal(redact("secret='two words here ok' and more"), "secret='[REDACTED]' and more");
  assert.equal(redact('{"password":"abcdefgh","user":"bob"}'), '{"password":"[REDACTED]","user":"bob"}');
  assert.equal(redact('password="say \\"hi\\" to me"'), 'password="[REDACTED]"');
});

test('the 8-character minimum applies to the whole quoted value', () => {
  assert.equal(redact('password="abc def"'), 'password="abc def"');
  assert.equal(redact('password="abc defg"'), 'password="[REDACTED]"');
  assert.equal(redact('password="a b c"'), 'password="a b c"');
});

test('JSON-escaped quotes do not hide a value', () => {
  assert.equal(redact('{\\"password\\":\\"hunter2hunter2\\"}'), '{\\"password\\":\\"[REDACTED]\\"}');
  assert.equal(
    redact('{\\"user\\":\\"bob\\",\\"token\\":\\"abcdefgh12345\\"}'),
    '{\\"user\\":\\"bob\\",\\"token\\":\\"[REDACTED]\\"}'
  );
  assert.equal(redact('{\\"password\\":\\"abc\\"}'), '{\\"password\\":\\"abc\\"}');
});

test('Authorization: Basic keeps the scheme and redacts the credentials', () => {
  assert.equal(redact('Authorization: Basic dXNlcjpwYXNzd29yZA=='), 'Authorization: Basic [REDACTED]');
  assert.equal(redact('authorization: basic dXNlcjpwYXNzd29yZA=='), 'authorization: basic [REDACTED]');
  assert.equal(
    redact('curl -H "Authorization: Basic dXNlcjpwYXNzd29yZA==" https://x.test'),
    'curl -H "Authorization: Basic [REDACTED]" https://x.test'
  );
  assert.equal(redact('{"Authorization": "Basic dXNlcjpwYXNzd29yZA=="}'), '{"Authorization": "Basic [REDACTED]"}');
});

test('Basic outside an Authorization header, or too short, is left alone', () => {
  assert.equal(redact('Basic authentication is simple'), 'Basic authentication is simple');
  assert.equal(redact('Authorization: Basic abc123'), 'Authorization: Basic abc123');
});

test('the password in URL userinfo is replaced and the rest kept', () => {
  assert.equal(
    redact('postgresql://postgres:s3cretpassw0rd@db.example:5432/x'),
    'postgresql://postgres:[REDACTED]@db.example:5432/x'
  );
  assert.equal(redact('redis://u:p@h:6379'), 'redis://u:[REDACTED]@h:6379');
  assert.equal(redact('https://:onlypass@host/x'), 'https://:[REDACTED]@host/x');
  assert.equal(redact('DATABASE_URL=postgres://app:pw12@db/app'), 'DATABASE_URL=postgres://app:[REDACTED]@db/app');
});

test('URLs without a userinfo password are left alone', () => {
  assert.equal(redact('ssh://git@github.com/org/repo'), 'ssh://git@github.com/org/repo');
  assert.equal(redact('http://localhost:3000/a@b'), 'http://localhost:3000/a@b');
  assert.equal(redact('https://example.com/path'), 'https://example.com/path');
});

test('a bearer token is replaced and the scheme is kept', () => {
  assert.equal(redact('Authorization: Bearer abcDEF123456+/xyz=='), 'Authorization: Bearer [REDACTED]');
  assert.equal(redact('authorization: bearer abcdefgh1234'), 'authorization: bearer [REDACTED]');
  assert.equal(
    redact('curl -H "Authorization: Bearer abc.def-ghi_jkl~mno" https://x.test'),
    'curl -H "Authorization: Bearer [REDACTED]" https://x.test'
  );
});

test('a bearer value shorter than 8 characters is left alone', () => {
  assert.equal(redact('Authorization: Bearer abc123'), 'Authorization: Bearer abc123');
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
