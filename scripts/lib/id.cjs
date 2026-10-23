'use strict';
const crypto = require('node:crypto');

// Canonical string for a finding's location. Line numbers and commits are left out on purpose
// so an id survives code churn. The shape is chosen by which key is present:
//   code    {path, symbol?, line?, commit?}
//   host    {host, service?, setting?}
//   url     {url, header?}
//   package {package, ecosystem?}
function normalizeLocation(loc) {
  if (loc.path !== undefined) return `${String(loc.path).replace(/\\/g, '/')}:${loc.symbol || ''}`;
  if (loc.host !== undefined) return `${loc.host}|${loc.service || ''}|${loc.setting || ''}`;
  if (loc.url !== undefined) return `${loc.url}|${loc.header || ''}`;
  if (loc.package !== undefined) return `${loc.ecosystem || ''}:${loc.package}`;
  throw new TypeError('normalizeLocation: location needs one of path, host, url or package');
}

// First 12 hex of SHA-256 over project|system|ruleId|normalizedLocation.
function findingId({ project, system, ruleId, location }) {
  const key = `${project}|${system}|${ruleId}|${normalizeLocation(location)}`;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

module.exports = { normalizeLocation, findingId };
