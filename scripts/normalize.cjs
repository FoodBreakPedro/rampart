'use strict';
const { findingId } = require('./lib/id.cjs');

// Turn the raw JSON of the L1 tools into findings that match finding-schema.json. Each function takes the parsed report and
// ctx = {project, system, runId, now?} and returns an array; the caller hands the array to the store.
//
// Every finding is class 'tool', layer 'L1', status 'open', stamped with ctx.now (or the current time) for both
// firstSeen and lastSeen. The store keeps the real firstSeen when the finding already exists.
//
// Nothing here reads a field it does not need. For gitleaks that matters: Secret, Match, Line, Author and Email stay in
// the report and never reach a finding.

const RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const TRIVY_SEVERITY = { CRITICAL: 'CRITICAL', HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW', UNKNOWN: 'LOW' };
const NPM_SEVERITY = { critical: 'CRITICAL', high: 'HIGH', moderate: 'MEDIUM', low: 'LOW', info: 'LOW' };
const MAX_LISTED = 5; // advisories named in one finding's evidence; externalIds.cve always carries all of them

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const isText = (v) => typeof v === 'string' && v !== '';
const uniqueSorted = (items) => [...new Set(items)].sort();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const severityOf = (table, raw, fold) => {
  const key = fold(typeof raw === 'string' ? raw : '');
  return own(table, key) ? table[key] : 'LOW';
};
const maxSeverity = (severities) => severities.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'LOW');

// "a (..), b (..), c (..), d (..), e (..), and 7 more"
function listed(items) {
  const shown = items.slice(0, MAX_LISTED).join(', ');
  const more = items.length - MAX_LISTED;
  return more > 0 ? `${shown}, and ${more} more` : shown;
}

function context(ctx, fn) {
  if (!isObject(ctx)) throw new TypeError(`${fn}: ctx is required`);
  for (const key of ['project', 'system', 'runId']) {
    if (!isText(ctx[key])) throw new TypeError(`${fn}: ctx.${key} must be a non-empty string`);
  }
  return { project: ctx.project, system: ctx.system, runId: ctx.runId, now: ctx.now || new Date().toISOString() };
}

// The fields every L1 finding shares. Key order follows the finding fixture.
function toolFinding(c, f) {
  return {
    id: findingId({ project: c.project, system: c.system, ruleId: f.ruleId, location: f.location }),
    project: c.project,
    system: c.system,
    layer: 'L1',
    source: f.source,
    pack: null,
    ruleId: f.ruleId,
    title: f.title,
    severity: f.severity,
    confidence: f.confidence,
    cwe: f.cwe,
    class: 'tool',
    location: f.location,
    evidence: f.evidence,
    exploitScenario: f.exploitScenario,
    preconditions: f.preconditions,
    recommendation: f.recommendation,
    verification: { verifiers: 0, confirmed: 0, run: c.runId },
    status: 'open',
    firstSeen: c.now,
    lastSeen: c.now,
    fixedIn: null,
    externalIds: { claudeSecurityPluginFindingId: null, cve: f.cve },
  };
}

// ---- gitleaks -----------------------------------------------------------------------------

// report: the JSON array gitleaks writes with --report-format json (older versions write null when nothing matched).
// One finding per entry. The commit is kept (shortened) but not the line, and neither is part of the id, so the id of a
// leak survives line drift. Two leaks of the same rule in the same file share an id by design.
function fromGitleaks(report, ctx) {
  const c = context(ctx, 'fromGitleaks');
  if (report === null || report === undefined) return [];
  if (!Array.isArray(report)) throw new TypeError('fromGitleaks: report must be an array');
  return report.map((entry, i) => {
    // Only these four fields are read.
    const { RuleID, Description, File, Commit } = isObject(entry) ? entry : {};
    if (!isText(RuleID) || !isText(File)) throw new TypeError(`fromGitleaks: entry ${i} needs a RuleID and a File`);
    const short = typeof Commit === 'string' ? Commit.slice(0, 12) : '';
    const location = short ? { path: File, symbol: null, commit: short } : { path: File, symbol: null };
    return toolFinding(c, {
      source: 'gitleaks',
      ruleId: `gitleaks/${RuleID}`,
      title: `Possible ${isText(Description) ? Description : RuleID} in ${File}`,
      severity: 'HIGH',
      confidence: 'MEDIUM',
      cwe: ['CWE-798'],
      location,
      evidence: `gitleaks rule ${RuleID} matched ${short ? `at commit ${short}` : 'in the working tree'}; value not recorded`,
      exploitScenario: 'Anyone who can read the repository or its history can use the exposed credential.',
      preconditions: 'The matched value is a live credential and the repository, or a copy of it, is readable by someone untrusted.',
      recommendation: 'Rotate the credential, remove it from the repository, load it from a secret store or environment variable, and purge it from history if the repository is shared.',
      cve: null,
    });
  });
}

// ---- trivy --------------------------------------------------------------------------------

// The highest version in a list of FixedVersion strings. A string may name several fixes ("4.17.21, 3.10.1"); only the
// numeric parts are compared, which is enough to pick an upgrade target.
function highestVersion(fixes) {
  const numbers = (v) => (v.match(/\d+/g) || []).map(Number);
  const compare = (a, b) => {
    const x = numbers(a);
    const y = numbers(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] ?? 0) - (y[i] ?? 0);
      if (d) return d;
    }
    return 0;
  };
  const tokens = fixes.flatMap((fix) => fix.split(',')).map((t) => t.trim()).filter((t) => /\d/.test(t));
  return tokens.reduce((best, t) => (best === undefined || compare(t, best) > 0 ? t : best), undefined);
}

// report: the JSON of `trivy fs --format json`. One finding per (Target, PkgName): a package with three advisories is one
// thing to upgrade, not three. Results and Vulnerabilities may be absent.
function fromTrivy(report, ctx) {
  const c = context(ctx, 'fromTrivy');
  if (!isObject(report)) throw new TypeError('fromTrivy: report must be an object');
  const groups = new Map();
  list(report.Results).forEach((result, r) => {
    if (!isObject(result)) return;
    const target = isText(result.Target) ? result.Target : '';
    const type = isText(result.Type) ? result.Type : '';
    list(result.Vulnerabilities).forEach((v, i) => {
      if (!isObject(v) || !isText(v.PkgName)) throw new TypeError(`fromTrivy: vulnerability ${i} in result ${r} has no PkgName`);
      const key = `${target}\0${v.PkgName}`;
      if (!groups.has(key)) groups.set(key, { target, type, pkg: v.PkgName, advisories: new Map() });
      const advisory = {
        id: isText(v.VulnerabilityID) ? v.VulnerabilityID : '',
        installed: isText(v.InstalledVersion) ? v.InstalledVersion : '',
        fixed: isText(v.FixedVersion) ? v.FixedVersion : '',
        severity: severityOf(TRIVY_SEVERITY, v.Severity, (s) => s.toUpperCase()),
        cwe: list(v.CweIDs).filter(isText),
      };
      groups.get(key).advisories.set(`${advisory.id}|${advisory.installed}|${advisory.fixed}`, advisory);
    });
  });

  return [...groups.values()].map((g) => {
    const advisories = [...g.advisories.values()].sort(
      (a, b) => RANK[b.severity] - RANK[a.severity] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const versions = uniqueSorted(advisories.map((a) => a.installed).filter(Boolean));
    const ids = uniqueSorted(advisories.map((a) => a.id).filter(Boolean));
    const count = plural(advisories.length, 'advisory', 'advisories');
    const location = { package: g.pkg };
    if (g.type) location.ecosystem = g.type;
    if (g.target) location.path = g.target;
    return toolFinding(c, {
      source: 'trivy',
      ruleId: `trivy/pkg/${g.pkg}`,
      title: `Vulnerable dependency ${g.pkg}${versions.length ? ` ${versions.join(', ')}` : ''} (${count})`,
      severity: maxSeverity(advisories.map((a) => a.severity)),
      confidence: 'HIGH',
      cwe: uniqueSorted(advisories.flatMap((a) => a.cwe)),
      location,
      evidence: `${count}: ${listed(advisories.map((a) => `${a.id || 'unidentified advisory'} (installed ${a.installed || 'unknown'}, fixed ${a.fixed || 'none'})`))}`,
      exploitScenario: `An attacker exploits a published vulnerability in the installed version of ${g.pkg}.`,
      preconditions: `The vulnerable code in ${g.pkg} is reachable from application input or the build.`,
      recommendation: `Upgrade ${g.pkg} to ${highestVersion(advisories.map((a) => a.fixed)) || 'the latest version'}`,
      cve: ids.length ? ids : null,
    });
  });
}

// ---- npm audit ----------------------------------------------------------------------------

const GHSA_AT_END = /\/(GHSA(?:-[0-9a-z]{4}){3})\/?$/i;

// The advisory ids npm gives for one `via` object: the GHSA id at the end of its url and, if present, a cve field.
function advisoryIds(via) {
  const ghsa = typeof via.url === 'string' ? via.url.match(GHSA_AT_END) : null;
  return [ghsa && ghsa[1], isText(via.cve) ? via.cve : null].filter(Boolean);
}

function npmFix(name, fix) {
  if (isObject(fix) && isText(fix.version)) {
    return `Upgrade ${isText(fix.name) ? fix.name : name} to ${fix.version}${fix.isSemVerMajor ? ' (semver-major change)' : ''}`;
  }
  if (fix === true) return `Upgrade ${name} to a patched version (npm audit fix)`;
  return `Upgrade ${name} to the latest version; npm reports no automatic fix`;
}

// report: the JSON of `npm audit --json` (auditReportVersion 2). One finding per vulnerable package.
// A package whose `via` holds only package names is vulnerable because of a dependency. When that dependency, followed
// through the report, reaches an advisory, the advisory's own entry carries the finding and this one is skipped.
// When nothing it points at carries an advisory, the entry is kept so the signal is not lost, and says how it was reached.
function fromNpmAudit(report, ctx) {
  const c = context(ctx, 'fromNpmAudit');
  if (!isObject(report)) throw new TypeError('fromNpmAudit: report must be an object');
  if (report.error !== undefined && report.error !== null) {
    throw new TypeError('fromNpmAudit: report is an npm audit error report, not an audit result');
  }
  if (report.auditReportVersion !== undefined && report.auditReportVersion !== 2) {
    throw new TypeError('fromNpmAudit: unsupported npm audit report version (expected auditReportVersion 2)');
  }
  if (report.vulnerabilities === undefined && report.advisories !== undefined) {
    throw new TypeError('fromNpmAudit: unsupported npm audit report version (expected auditReportVersion 2)');
  }
  const vulnerabilities = isObject(report.vulnerabilities) ? report.vulnerabilities : {};

  const reachesAdvisory = (name, seen) => {
    if (seen.has(name)) return false;
    seen.add(name);
    if (!own(vulnerabilities, name) || !isObject(vulnerabilities[name])) return false;
    const via = list(vulnerabilities[name].via);
    return via.some(isObject) || via.some((v) => typeof v === 'string' && reachesAdvisory(v, seen));
  };

  const findings = [];
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    if (!isObject(entry)) continue;
    const via = list(entry.via);
    const names = via.filter(isText);
    const advisories = via
      .filter(isObject)
      .map((a) => ({ raw: a, severity: severityOf(NPM_SEVERITY, a.severity, (s) => s.toLowerCase()) }))
      .sort((a, b) => RANK[b.severity] - RANK[a.severity]);

    if (advisories.length === 0) {
      const seen = new Set([name]);
      if (names.some((n) => reachesAdvisory(n, seen))) continue;
    }

    const ids = advisories.flatMap(({ raw }) => advisoryIds(raw));
    const described = advisories.map(({ raw }) => {
      const label = advisoryIds(raw)[0] || (raw.source !== undefined ? `advisory ${raw.source}` : 'unidentified advisory');
      const detail = [isText(raw.title) ? raw.title : '', isText(raw.range) ? `affected ${raw.range}` : ''].filter(Boolean).join('; ');
      return detail ? `${label} (${detail})` : label;
    });

    let title;
    let evidence;
    if (advisories.length > 0) {
      const first = advisories[0].raw;
      const more = advisories.length - 1;
      title = `Vulnerable dependency ${name}: ${isText(first.title) ? first.title : described[0]}${more ? ` (and ${more} more)` : ''}`;
      evidence = `${plural(advisories.length, 'advisory', 'advisories')}: ${listed(described)}${names.length ? `; also reached via ${names.join(', ')}` : ''}`;
    } else {
      title = `Vulnerable dependency ${name}${names.length ? ` (via ${names.join(', ')})` : ''}`;
      evidence = names.length
        ? `no advisory is listed on ${name} itself; reached via ${names.join(', ')}`
        : `no advisory detail is listed for ${name}`;
    }

    findings.push(toolFinding(c, {
      source: 'npm-audit',
      ruleId: `npm-audit/pkg/${name}`,
      title,
      severity: maxSeverity([severityOf(NPM_SEVERITY, entry.severity, (s) => s.toLowerCase()), ...advisories.map((a) => a.severity)]),
      confidence: 'HIGH',
      cwe: uniqueSorted(advisories.flatMap(({ raw }) => list(raw.cwe).filter(isText))),
      location: { package: name, ecosystem: 'npm' },
      evidence,
      exploitScenario: `An attacker exploits a published advisory in the installed version of ${name}.`,
      preconditions: `The vulnerable code in ${name} is reachable from application input or the build.`,
      recommendation: npmFix(name, entry.fixAvailable),
      cve: ids.length ? uniqueSorted(ids) : null,
    }));
  }
  return findings;
}

module.exports = { fromGitleaks, fromTrivy, fromNpmAudit };
