'use strict';

const REDACTED = '[REDACTED]';

// Applied in order, so a PEM block is collapsed before the narrower rules see its contents.
const RULES = [
  // PEM block, BEGIN through the matching END. An unterminated block (truncated output) runs to the end of the text.
  [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, REDACTED],
  // JWT: three base64url parts, the first starting with the encoded `{"`.
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED],
  // Known token formats. AKIA and AIza are fixed length; the rest are a prefix plus the token characters after it.
  [/AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{35}|(?:sk_live_|sk_test_|sk-ant-|ghp_|gho_|xox[baprs]-)[A-Za-z0-9_-]+/g, REDACTED],
  // key=value: keep the key and separator, replace the value. The 8-character minimum also leaves
  // true, false, null, 0 and 1 (and any other short value) alone.
  [/((?:password|passwd|secret|token|api[_-]?key|private[_-]?key)["']?\s*[=:]\s*["']?)[^\s"']{8,}/gi, `$1${REDACTED}`],
];

// Returns text with credentials replaced by [REDACTED]. Non-strings are returned unchanged.
function redact(text) {
  if (typeof text !== 'string') return text;
  return RULES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

module.exports = { redact, REDACTED };
