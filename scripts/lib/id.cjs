'use strict';
const crypto = require('node:crypto');

// Canonical string for a finding's location. Line numbers and commits are left out on purpose
// so an id survives code churn. The shape is chosen by which key is present, checked in this order:
//   package {package, ecosystem?, path?}   path is the lockfile it was found in; it is not part of the string,
//                                          so a ruleId that must tell two lockfiles apart has to name the lockfile itself
//   host    {host, service?, setting?}
//   url     {url, header?}
//   code    {path, symbol?, line?, commit?}
function normalizeLocation(loc) {
  if (loc.package !== undefined) return `${loc.ecosystem || ''}:${loc.package}`;
  if (loc.host !== undefined) return `${loc.host}|${loc.service || ''}|${loc.setting || ''}`;
  if (loc.url !== undefined) return `${loc.url}|${loc.header || ''}`;
  if (loc.path !== undefined) return `${String(loc.path).replace(/\\/g, '/')}:${loc.symbol || ''}`;
  throw new TypeError('normalizeLocation: location needs one of path, host, url or package');
}

// First 12 hex of SHA-256 over project|system|ruleId|normalizedLocation.
function findingId({ project, system, ruleId, location }) {
  const key = `${project}|${system}|${ruleId}|${normalizeLocation(location)}`;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

module.exports = { normalizeLocation, findingId };
