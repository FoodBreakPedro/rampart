const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fromGitleaks, fromTrivy, fromNpmAudit } = require('../scripts/normalize.cjs');
const { findingId } = require('../scripts/lib/id.cjs');
const { validate, loadSchema } = require('../scripts/lib/validate.cjs');

const RUN = '2026-10-23T18-02-11Z';
const NOW = '2026-10-23T18:02:11Z';
const CTX = { project: 'example-app', system: 'mobile', runId: RUN, now: NOW };

const fixtureText = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const fixture = (name) => JSON.parse(fixtureText(name));
const clone = (v) => JSON.parse(JSON.stringify(v));
const byRule = (findings, ruleId) => {
  const f = findings.find((x) => x.ruleId === ruleId);
  assert.ok(f, `no finding with ruleId ${ruleId}`);
  return f;
};
// A frozen report makes a normalizer that writes to its input throw (scripts/normalize.cjs runs in strict mode).
const deepFreeze = (v) => {
  if (v && typeof v === 'object') Object.values(v).forEach(deepFreeze);
  return Object.freeze(v);
};

const findingSchema = loadSchema('finding');
function assertAllValid(findings) {
  for (const f of findings) {
    const { ok, errors } = validate(findingSchema, f);
    assert.ok(ok, `${f.ruleId} does not validate: ${errors.join('; ')}`);
    assert.match(f.id, /^[0-9a-f]{12}$/);
    assert.equal(f.layer, 'L1');
    assert.equal(f.class, 'tool');
    assert.equal(f.status, 'open');
    assert.equal(f.project, CTX.project);
    assert.equal(f.system, CTX.system);
    assert.equal(f.pack, null);
    assert.equal(f.fixedIn, null);
    assert.equal(f.firstSeen, NOW);
    assert.equal(f.lastSeen, NOW);
    assert.deepEqual(f.verification, { verifiers: 0, confirmed: 0, run: RUN });
    assert.equal(f.externalIds.claudeSecurityPluginFindingId, null);
    assert.ok(f.exploitScenario && f.preconditions && f.recommendation, 'text fields are filled in');
  }
}

// ---- gitleaks -----------------------------------------------------------------------------

const GITLEAKS_NEVER_COPIED = ['Secret', 'Match', 'Line', 'Author', 'Email', 'Message'];

test('fromGitleaks makes one finding per report entry and every one validates', () => {
  const findings = fromGitleaks(fixture('gitleaks.json'), CTX);
  assert.equal(findings.length, 2);
  assertAllValid(findings);
  assert.equal(new Set(findings.map((f) => f.id)).size, 2);
});

test('fromGitleaks fills in the documented fields', () => {
  const [aws, pat] = fromGitleaks(fixture('gitleaks.json'), CTX);
  assert.equal(aws.source, 'gitleaks');
  assert.equal(aws.ruleId, 'gitleaks/aws-access-token');
  assert.equal(aws.severity, 'HIGH');
  assert.equal(aws.confidence, 'MEDIUM');
  assert.deepEqual(aws.cwe, ['CWE-798']);
  assert.deepEqual(aws.location, { path: 'src/config/aws.js', symbol: null, commit: '3f1c9a7e5b2d' });
  assert.equal(aws.title, 'Possible AWS Access Key in src/config/aws.js');
  assert.equal(aws.evidence, 'gitleaks rule aws-access-token matched at commit 3f1c9a7e5b2d; value not recorded');
  assert.equal(aws.externalIds.cve, null);
  assert.equal(
    aws.id,
    findingId({ project: 'example-app', system: 'mobile', ruleId: 'gitleaks/aws-access-token', location: { path: 'src/config/aws.js', symbol: null } }),
  );
  assert.equal(pat.ruleId, 'gitleaks/github-pat');
  assert.equal(pat.title, 'Possible GitHub Personal Access Token in scripts/deploy.sh');
  assert.equal(pat.location.commit, '9d8c7b6a5f4e');
});

test('fromGitleaks never copies Secret, Match, Line, Author, Email or Message into any field', () => {
  const report = fixture('gitleaks.json');
  const raw = fixtureText('gitleaks.json');
  const secrets = report.flatMap((entry) => GITLEAKS_NEVER_COPIED.map((k) => entry[k]));
  // Guard against a vacuous pass: the strings we look for really are in the report.
  assert.ok(secrets.length >= 12 && secrets.every((s) => typeof s === 'string' && s));
  assert.ok(raw.includes('AKIAFAKEFAKEFAKEFAKE') && raw.includes('ghp_fakefakefakefakefakefakefakefake1234'));
  const out = fromGitleaks(deepFreeze(report), CTX);
  assert.equal(out.length, 2);
  for (const f of out) {
    const text = JSON.stringify(f);
    for (const s of secrets) assert.ok(!text.includes(s), `a finding contains ${JSON.stringify(s.slice(0, 6))}...`);
    assert.ok(!text.includes('AKIAFAKE') && !text.includes('ghp_fake'));
  }
});

test('fromGitleaks ids survive line drift and a rewritten commit', () => {
  const before = fromGitleaks(fixture('gitleaks.json'), CTX);
  const moved = fixture('gitleaks.json');
  moved[0].StartLine += 40;
  moved[0].EndLine += 40;
  moved[0].Commit = 'ffffffffffffffffffffffffffffffffffffffff';
  const after = fromGitleaks(moved, CTX);
  assert.equal(after[0].id, before[0].id);
  assert.equal(after[0].location.commit, 'ffffffffffff');
  assert.equal(after[0].location.line, undefined, 'no line number is recorded');
  assert.equal(after[1].id, before[1].id);
});

test('fromGitleaks ids depend on project, system, rule and file', () => {
  const [base] = fromGitleaks(fixture('gitleaks.json'), CTX);
  const otherProject = fromGitleaks(fixture('gitleaks.json'), { ...CTX, project: 'other-app' })[0];
  const otherSystem = fromGitleaks(fixture('gitleaks.json'), { ...CTX, system: 'api' })[0];
  const renamed = fixture('gitleaks.json');
  renamed[0].File = 'src/config/aws.production.js';
  assert.notEqual(otherProject.id, base.id);
  assert.notEqual(otherSystem.id, base.id);
  assert.notEqual(fromGitleaks(renamed, CTX)[0].id, base.id);
});

test('fromGitleaks handles an entry with no commit (a --no-git scan) without inventing one', () => {
  const report = fixture('gitleaks.json').slice(0, 1);
  report[0].Commit = '';
  const [f] = fromGitleaks(report, CTX);
  assert.deepEqual(f.location, { path: 'src/config/aws.js', symbol: null });
  assert.equal(f.evidence, 'gitleaks rule aws-access-token matched in the working tree; value not recorded');
  assertAllValid([f]);
});

test('fromGitleaks returns [] for an empty report and for the null some gitleaks versions write', () => {
  assert.deepEqual(fromGitleaks(fixture('gitleaks.empty.json'), CTX), []);
  assert.deepEqual(fromGitleaks(null, CTX), []);
});

test('fromGitleaks stamps the current time when ctx.now is missing', () => {
  const before = Date.now();
  const { now, ...ctx } = CTX;
  const [f] = fromGitleaks(fixture('gitleaks.json'), ctx);
  const after = Date.now();
  assert.equal(new Date(f.firstSeen).toISOString(), f.firstSeen);
  assert.ok(Date.parse(f.firstSeen) >= before && Date.parse(f.firstSeen) <= after);
  assert.equal(f.lastSeen, f.firstSeen);
});

test('fromGitleaks rejects a malformed report or ctx instead of guessing', () => {
  assert.throws(() => fromGitleaks({ Results: [] }, CTX), TypeError);
  assert.throws(() => fromGitleaks('[]', CTX), TypeError);
  assert.throws(() => fromGitleaks([{ Description: 'x', File: 'a.js' }], CTX), /entry 0/);
  assert.throws(() => fromGitleaks([{ RuleID: 'x', Description: 'x' }], CTX), /entry 0/);
  assert.throws(() => fromGitleaks([], undefined), TypeError);
  assert.throws(() => fromGitleaks([], { ...CTX, project: '' }), /ctx\.project/);
  assert.throws(() => fromGitleaks([], { ...CTX, runId: undefined }), /ctx\.runId/);
});

// ---- trivy --------------------------------------------------------------------------------

test('fromTrivy makes one finding per (Target, PkgName) and every one validates', () => {
  const findings = fromTrivy(fixture('trivy.json'), CTX);
  assert.equal(findings.length, 2);
  assertAllValid(findings);
  assert.deepEqual(findings.map((f) => f.ruleId).sort(), ['trivy/pkg/lodash', 'trivy/pkg/minimist']);
});

test('fromTrivy lodash: max severity, sorted cve list, cwe union, location and evidence', () => {
  const findings = fromTrivy(deepFreeze(fixture('trivy.json')), CTX);
  const lodash = byRule(findings, 'trivy/pkg/lodash');
  assert.equal(lodash.source, 'trivy');
  assert.equal(lodash.severity, 'CRITICAL');
  assert.equal(lodash.confidence, 'HIGH');
  assert.deepEqual(lodash.externalIds.cve, ['CVE-2019-10744', 'CVE-2021-23337']);
  assert.equal(lodash.externalIds.cve.length, 2);
  assert.deepEqual(lodash.cwe, ['CWE-1321', 'CWE-77', 'CWE-94']);
  assert.deepEqual(lodash.location, { package: 'lodash', ecosystem: 'npm', path: 'package-lock.json' });
  assert.equal(lodash.title, 'Vulnerable dependency lodash 4.17.11 (2 advisories)');
  assert.equal(
    lodash.evidence,
    '2 advisories: CVE-2019-10744 (installed 4.17.11, fixed 4.17.12), CVE-2021-23337 (installed 4.17.11, fixed 4.17.21)',
  );
  assert.equal(lodash.recommendation, 'Upgrade lodash to 4.17.21');
  assert.equal(
    lodash.id,
    findingId({ project: 'example-app', system: 'mobile', ruleId: 'trivy/pkg/lodash', location: lodash.location }),
  );
});

test('fromTrivy minimist: a single advisory keeps its own severity and reads in the singular', () => {
  const minimist = byRule(fromTrivy(fixture('trivy.json'), CTX), 'trivy/pkg/minimist');
  assert.equal(minimist.severity, 'MEDIUM');
  assert.deepEqual(minimist.externalIds.cve, ['CVE-2020-7598']);
  assert.deepEqual(minimist.cwe, ['CWE-1321']);
  assert.equal(minimist.evidence, '1 advisory: CVE-2020-7598 (installed 1.2.0, fixed 1.2.3)');
  assert.equal(minimist.title, 'Vulnerable dependency minimist 1.2.0 (1 advisory)');
  assert.equal(minimist.recommendation, 'Upgrade minimist to 1.2.3');
});

test('fromTrivy severity is the max whatever the order, and UNKNOWN counts as LOW', () => {
  const report = fixture('trivy.json');
  const vulns = report.Results[0].Vulnerabilities;
  const forwards = byRule(fromTrivy(report, CTX), 'trivy/pkg/lodash');
  vulns.reverse();
  const backwards = byRule(fromTrivy(report, CTX), 'trivy/pkg/lodash');
  assert.equal(forwards.severity, 'CRITICAL');
  assert.equal(backwards.severity, 'CRITICAL');
  assert.deepEqual(backwards.externalIds.cve, forwards.externalIds.cve);

  const only = clone(fixture('trivy.json'));
  only.Results[0].Vulnerabilities = [
    { ...vulns[0], PkgName: 'left-pad', Severity: 'UNKNOWN', VulnerabilityID: 'CVE-2099-0001' },
  ];
  const [unknown] = fromTrivy(only, CTX);
  assert.equal(unknown.severity, 'LOW');
  only.Results[0].Vulnerabilities.push({ ...vulns[0], PkgName: 'left-pad', Severity: 'LOW', VulnerabilityID: 'CVE-2099-0002' });
  only.Results[0].Vulnerabilities.push({ ...vulns[0], PkgName: 'left-pad', Severity: 'MEDIUM', VulnerabilityID: 'CVE-2099-0003' });
  assert.equal(fromTrivy(only, CTX)[0].severity, 'MEDIUM');
});

test('fromTrivy returns [] when Results is missing, or when a target has no Vulnerabilities', () => {
  assert.deepEqual(fromTrivy(fixture('trivy.empty.json'), CTX), []);
  assert.deepEqual(fromTrivy({}, CTX), []);
  assert.deepEqual(fromTrivy({ Results: [] }, CTX), []);
  assert.deepEqual(fromTrivy({ Results: [{ Target: 'package-lock.json', Class: 'lang-pkgs', Type: 'npm' }] }, CTX), []);
  assert.deepEqual(fromTrivy({ Results: [{ Target: 'package-lock.json', Type: 'npm', Vulnerabilities: null }] }, CTX), []);
});

test('fromTrivy groups by target as well as package, and the target is recorded in the location', () => {
  const report = fixture('trivy.json');
  const lock = report.Results[0];
  report.Results.push({
    Target: 'requirements.txt',
    Class: 'lang-pkgs',
    Type: 'pip',
    Vulnerabilities: [{ ...lock.Vulnerabilities[0], PkgName: 'lodash', InstalledVersion: '0.0.1', Severity: 'LOW', VulnerabilityID: 'CVE-2099-0100', CweIDs: undefined, FixedVersion: undefined }],
  });
  const findings = fromTrivy(report, CTX);
  assert.equal(findings.length, 3);
  const lodashes = findings.filter((f) => f.ruleId === 'trivy/pkg/lodash');
  assert.equal(lodashes.length, 2);
  assert.deepEqual(lodashes.map((f) => f.location.path).sort(), ['package-lock.json', 'requirements.txt']);
  const pip = lodashes.find((f) => f.location.ecosystem === 'pip');
  assert.equal(pip.severity, 'LOW');
  assert.deepEqual(pip.cwe, []);
  assert.equal(pip.recommendation, 'Upgrade lodash to the latest version');
  assert.notEqual(pip.id, lodashes.find((f) => f.location.ecosystem === 'npm').id);
  assertAllValid(findings);
});

test('fromTrivy gives the same package in two lockfiles of one ecosystem two different ids', () => {
  const report = fixture('trivy.json');
  report.Results.push({ ...clone(report.Results[0]), Target: 'web/package-lock.json' });
  const findings = fromTrivy(report, CTX);
  const lodashes = findings.filter((f) => f.ruleId === 'trivy/pkg/lodash');
  assert.equal(findings.length, 4);
  assert.equal(lodashes.length, 2);
  assert.deepEqual(lodashes.map((f) => f.location.path).sort(), ['package-lock.json', 'web/package-lock.json']);
  assert.equal(new Set(findings.map((f) => f.id)).size, 4, 'no two findings share an id');
  assertAllValid(findings);
});

test('fromTrivy counts a repeated advisory once and says so when there is no fix', () => {
  const v = fixture('trivy.json').Results[0].Vulnerabilities[2];
  const noFix = { ...v };
  delete noFix.FixedVersion;
  const report = { Results: [{ Target: 'package-lock.json', Type: 'npm', Vulnerabilities: [noFix, { ...noFix }] }] };
  const [f] = fromTrivy(report, CTX);
  assert.deepEqual(f.externalIds.cve, ['CVE-2020-7598']);
  assert.equal(f.evidence, '1 advisory: CVE-2020-7598 (installed 1.2.0, fixed none)');
  assert.equal(f.recommendation, 'Upgrade minimist to the latest version');
  assertAllValid([f]);
});

test('fromTrivy picks the highest fix, including from a multi-branch FixedVersion', () => {
  const v = fixture('trivy.json').Results[0].Vulnerabilities;
  const report = {
    Results: [{
      Target: 'package-lock.json',
      Type: 'npm',
      Vulnerabilities: [
        { ...v[0], FixedVersion: '4.17.21, 3.10.1' },
        { ...v[1], FixedVersion: '4.9.0' },
      ],
    }],
  };
  assert.equal(fromTrivy(report, CTX)[0].recommendation, 'Upgrade lodash to 4.17.21');
});

test('fromTrivy keeps evidence short for a package with many advisories but lists every cve', () => {
  const v = fixture('trivy.json').Results[0].Vulnerabilities[0];
  const many = Array.from({ length: 12 }, (_, i) => ({ ...v, VulnerabilityID: `CVE-2099-${String(1000 + i)}` }));
  const [f] = fromTrivy({ Results: [{ Target: 'package-lock.json', Type: 'npm', Vulnerabilities: many }] }, CTX);
  assert.equal(f.externalIds.cve.length, 12);
  assert.ok(f.evidence.startsWith('12 advisories: '));
  assert.ok(f.evidence.endsWith('and 7 more'));
  assert.ok(f.evidence.length < 600);
});

test('fromTrivy rejects a malformed report or a vulnerability with no PkgName', () => {
  assert.throws(() => fromTrivy([], CTX), TypeError);
  assert.throws(() => fromTrivy(null, CTX), TypeError);
  assert.throws(() => fromTrivy({ Results: [{ Target: 't', Type: 'npm', Vulnerabilities: [{ VulnerabilityID: 'CVE-1' }] }] }, CTX), /PkgName/);
  assert.throws(() => fromTrivy({}, { project: 'p' }), TypeError);
});

// ---- npm audit ----------------------------------------------------------------------------

test('fromNpmAudit makes one finding per vulnerable package and every one validates', () => {
  const findings = fromNpmAudit(fixture('npm-audit.json'), CTX);
  assert.equal(findings.length, 2);
  assertAllValid(findings);
  assert.deepEqual(findings.map((f) => f.ruleId).sort(), ['npm-audit/pkg/lodash', 'npm-audit/pkg/qs']);
});

test('fromNpmAudit lodash: severity, GHSA ids from the advisory urls, cwe union, location', () => {
  const lodash = byRule(fromNpmAudit(deepFreeze(fixture('npm-audit.json')), CTX), 'npm-audit/pkg/lodash');
  assert.equal(lodash.source, 'npm-audit');
  assert.equal(lodash.severity, 'HIGH');
  assert.equal(lodash.confidence, 'HIGH');
  assert.deepEqual(lodash.externalIds.cve, ['GHSA-35jh-r3h4-6jhm', 'GHSA-p6mc-m468-83gw']);
  assert.deepEqual(lodash.cwe, ['CWE-1321', 'CWE-77', 'CWE-770', 'CWE-94']);
  assert.deepEqual(lodash.location, { package: 'lodash', ecosystem: 'npm' });
  assert.equal(lodash.title, 'Vulnerable dependency lodash: Command Injection in lodash (and 1 more)');
  assert.equal(
    lodash.evidence,
    '2 advisories: GHSA-35jh-r3h4-6jhm (Command Injection in lodash; affected <4.17.21), GHSA-p6mc-m468-83gw (Prototype Pollution in lodash; affected <4.17.19)',
  );
  assert.equal(lodash.recommendation, 'Upgrade lodash to a patched version (npm audit fix)');
  assert.equal(
    lodash.id,
    findingId({ project: 'example-app', system: 'mobile', ruleId: 'npm-audit/pkg/lodash', location: { package: 'lodash', ecosystem: 'npm' } }),
  );
});

test('fromNpmAudit qs: moderate maps to MEDIUM and an object fixAvailable names the upgrade', () => {
  const qs = byRule(fromNpmAudit(fixture('npm-audit.json'), CTX), 'npm-audit/pkg/qs');
  assert.equal(qs.severity, 'MEDIUM');
  assert.deepEqual(qs.externalIds.cve, ['GHSA-hrpp-h998-j3pp']);
  assert.deepEqual(qs.cwe, ['CWE-1321']);
  assert.equal(qs.title, 'Vulnerable dependency qs: qs vulnerable to Prototype Pollution');
  assert.equal(qs.evidence, '1 advisory: GHSA-hrpp-h998-j3pp (qs vulnerable to Prototype Pollution; affected >=6.7.0 <6.7.3)');
  assert.equal(qs.recommendation, 'Upgrade express to 4.18.2');
});

test('fromNpmAudit maps every npm severity and flags a semver-major fix', () => {
  const via = (severity) => [{ source: 1, name: 'x', title: 'T', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity, cwe: [], range: '*' }];
  const report = {
    auditReportVersion: 2,
    vulnerabilities: Object.fromEntries(['critical', 'high', 'moderate', 'low', 'info'].map((s) => [
      `pkg-${s}`,
      { name: `pkg-${s}`, severity: s, via: via(s), range: '*', fixAvailable: { name: `pkg-${s}`, version: '9.0.0', isSemVerMajor: true } },
    ])),
  };
  const findings = fromNpmAudit(report, CTX);
  assert.deepEqual(
    Object.fromEntries(findings.map((f) => [f.location.package, f.severity])),
    { 'pkg-critical': 'CRITICAL', 'pkg-high': 'HIGH', 'pkg-moderate': 'MEDIUM', 'pkg-low': 'LOW', 'pkg-info': 'LOW' },
  );
  assert.equal(findings[0].recommendation, 'Upgrade pkg-critical to 9.0.0 (semver-major change)');
  assertAllValid(findings);
});

test('fromNpmAudit takes the id from the end of the url, uses via.cve when present, and gives null with neither', () => {
  const report = {
    auditReportVersion: 2,
    vulnerabilities: {
      a: {
        name: 'a', severity: 'high', range: '*', fixAvailable: false,
        via: [
          { source: 1, name: 'a', title: 'One', url: 'https://github.com/advisories/GHSA-1111-2222-3333', severity: 'high', cwe: [], range: '<1' },
          { source: 2, name: 'a', title: 'Two', url: 'https://nodesecurity.io/advisories/118', severity: 'high', cwe: [], range: '<2', cve: 'CVE-2099-0007' },
        ],
      },
      b: {
        name: 'b', severity: 'low', range: '*', fixAvailable: false,
        via: [{ source: 3, name: 'b', title: 'Three', url: 'https://nodesecurity.io/advisories/200', severity: 'low', cwe: [], range: '<3' }],
      },
    },
  };
  const findings = fromNpmAudit(report, CTX);
  assert.deepEqual(byRule(findings, 'npm-audit/pkg/a').externalIds.cve, ['CVE-2099-0007', 'GHSA-1111-2222-3333']);
  assert.equal(byRule(findings, 'npm-audit/pkg/b').externalIds.cve, null);
  assert.equal(byRule(findings, 'npm-audit/pkg/b').recommendation, 'Upgrade b to the latest version; npm reports no automatic fix');
  assertAllValid(findings);
});

test('fromNpmAudit skips a transitive-only entry whose cause is already reported, even through a chain', () => {
  const report = fixture('npm-audit.json');
  report.vulnerabilities.express = {
    name: 'express', severity: 'moderate', isDirect: true, via: ['qs'], effects: [], range: '<4.18.2', nodes: ['node_modules/express'], fixAvailable: true,
  };
  report.vulnerabilities.app = {
    name: 'app', severity: 'moderate', isDirect: true, via: ['express'], effects: [], range: '*', nodes: [''], fixAvailable: true,
  };
  const findings = fromNpmAudit(report, CTX);
  assert.deepEqual(findings.map((f) => f.ruleId).sort(), ['npm-audit/pkg/lodash', 'npm-audit/pkg/qs']);
});

test('fromNpmAudit still emits a transitive-only entry when nothing it points at carries an advisory', () => {
  const report = {
    auditReportVersion: 2,
    vulnerabilities: {
      express: { name: 'express', severity: 'high', isDirect: true, via: ['qs', 'body-parser'], effects: [], range: '<4.18.2', nodes: ['node_modules/express'], fixAvailable: true },
      'body-parser': { name: 'body-parser', severity: 'high', isDirect: false, via: ['express'], effects: ['express'], range: '*', nodes: [], fixAvailable: true },
    },
  };
  const findings = fromNpmAudit(report, CTX);
  assert.equal(findings.length, 2, 'a cycle with no advisory behind it is not hidden');
  const express = byRule(findings, 'npm-audit/pkg/express');
  assert.equal(express.severity, 'HIGH');
  assert.equal(express.externalIds.cve, null);
  assert.deepEqual(express.cwe, []);
  assert.equal(express.evidence, 'no advisory is listed on express itself; reached via qs, body-parser');
  assertAllValid(findings);
});

test('fromNpmAudit keeps a mixed entry (own advisory plus a dependency) and notes the dependency', () => {
  const report = fixture('npm-audit.json');
  report.vulnerabilities.qs.via.push('side-dep');
  const qs = byRule(fromNpmAudit(report, CTX), 'npm-audit/pkg/qs');
  assert.deepEqual(qs.externalIds.cve, ['GHSA-hrpp-h998-j3pp']);
  assert.ok(qs.evidence.startsWith('1 advisory: GHSA-hrpp-h998-j3pp'));
  assert.ok(qs.evidence.endsWith('; also reached via side-dep'));
});

test('fromNpmAudit returns [] for an empty report', () => {
  assert.deepEqual(fromNpmAudit(fixture('npm-audit.empty.json'), CTX), []);
  assert.deepEqual(fromNpmAudit({ auditReportVersion: 2 }, CTX), []);
});

test('fromNpmAudit refuses an error report or an older format instead of reporting a clean audit', () => {
  const failed = { message: 'audit endpoint returned an error', error: { code: 'ENOTFOUND', summary: 'request failed', detail: 'offline' } };
  assert.throws(() => fromNpmAudit(failed, CTX), /error report/);
  assert.throws(() => fromNpmAudit({ auditReportVersion: 1, advisories: {} }, CTX), /version/);
  assert.throws(() => fromNpmAudit({ advisories: {}, actions: [] }, CTX), /version/);
  assert.throws(() => fromNpmAudit([], CTX), TypeError);
  assert.throws(() => fromNpmAudit(null, CTX), TypeError);
});

// ---- all three ----------------------------------------------------------------------------

test('every normalizer leaves its input untouched and is deterministic for a given ctx', () => {
  const cases = [
    [fromGitleaks, 'gitleaks.json'],
    [fromTrivy, 'trivy.json'],
    [fromNpmAudit, 'npm-audit.json'],
  ];
  for (const [fn, name] of cases) {
    const input = fixture(name);
    const snapshot = clone(input);
    const first = fn(input, CTX);
    const second = fn(deepFreeze(clone(input)), CTX);
    assert.deepEqual(input, snapshot, `${fn.name} mutated its input`);
    assert.deepEqual(first, second, `${fn.name} is not deterministic`);
    assert.ok(first.length > 0);
    assertAllValid(first);
  }
});
