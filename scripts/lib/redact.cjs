'use strict';

const REDACTED = '[REDACTED]';

// An optional quote, possibly JSON-escaped (\" inside a stringified JSON blob).
const QUOTE = String.raw`(?:\\?["'])?`;
// A key word plus whatever identifier characters follow it (AWS_SECRET_ACCESS_KEY, SECRET_KEY, clientSecret).
// The suffix is capped so the rule stays linear on inputs like "secretsecretsecret...".
const KEY = String.raw`(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)[A-Za-z0-9_-]{0,64}`;

// Applied in order, so a PEM block is collapsed before the narrower rules see its contents.
const RULES = [
  // PEM block, BEGIN through the matching END. An unterminated block (truncated output) runs to the end of the text.
  [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, REDACTED],
  // JWT: three base64url parts, the first starting with the encoded `{"`. The left boundary means only the start
  // of a base64url run can begin a match, which keeps the rule linear (no rescanning of "eyJeyJeyJ..."). A URL-encoded
  // character just before it (Bearer%20<jwt>, token%3D<jwt>) is a boundary too, though its last hex digit is a run character.
  [/(?:(?<![A-Za-z0-9_-])|(?<=%[0-9A-Fa-f]{2}))eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED],
  // Known token formats. AKIA/ASIA and AIza are fixed length; the rest are a prefix plus the token characters after it.
  [/(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{35}|(?:sk_live_|sk_test_|sk-ant-|sk-proj-|github_pat_|ghp_|gho_|xox[baprs]-)[A-Za-z0-9_-]+/g, REDACTED],
  // Password in URL userinfo (scheme://user:password@host): keep everything but the password. Anchored on "://"
  // so it needs no scheme scan.
  [/(:\/\/[^\s:/@]*:)[^\s/]+(?=@)/g, `$1${REDACTED}`],
  // Authorization: Basic <base64>. Tied to the header name because "basic" is an ordinary word.
  [new RegExp(String.raw`(authorization${QUOTE}[ \t]*[:=][ \t]*${QUOTE}basic[ \t]+)[A-Za-z0-9+/_-]{8,}=*`, 'gi'), `$1${REDACTED}`],
  // Bearer token: keep the scheme, replace the token (8+ characters, optional base64 padding).
  [/(\bbearer[ \t]+)[A-Za-z0-9\-._~+/]{8,}=*/gi, `$1${REDACTED}`],
  // key=value: keep the key and separator, replace the value. The separator stays on one line, so a key at the
  // end of a line never swallows the next one. A quoted value runs to its closing quote on the same line (spaces
  // allowed, \" escapes understood); an unquoted one is a run of non-space characters. Either way it needs 8
  // characters, which also leaves true, false, null, 0 and 1 (and any other short value) alone.
  [
    new RegExp(
      String.raw`(${KEY}${QUOTE}[ \t]*[=:][ \t]*)` +
        String.raw`(?:(\\?["'])(?:(?!\2)(?:\\.|[^\\\r\n])){8,}\2|((?:\\?["'])?)[^\s"']{8,})`,
      'gi'
    ),
    (match, head, quoted, open) => (quoted !== undefined ? `${head}${quoted}${REDACTED}${quoted}` : `${head}${open}${REDACTED}`),
  ],
];

// Returns text with credentials replaced by [REDACTED]. Non-strings are returned unchanged.
function redact(text) {
  if (typeof text !== 'string') return text;
  return RULES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

module.exports = { redact, REDACTED };
