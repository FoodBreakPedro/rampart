'use strict';
// Doctor: what this machine has for Rampart to use, and what degrades without it.
//   node scripts/doctor.cjs [--json]
// Prints a table of the tools (gitleaks, trivy, python3, gh, ssh, git: found or not, version, path), then the claude-security
// plugin, the store, the packs and the engines, then one sentence for each thing that is missing. --json prints the same report
// as one document. The doctor reports, it does not fail: exit 0 whatever it found, 2 for an unknown flag or a stray argument,
// 1 only for something unexpected.
//
// It looks at tools the way the scanners do, so it reports what they will actually use: RAMPART_GITLEAKS, RAMPART_TRIVY and
// RAMPART_GIT override the lookup on PATH (exec.which), and an override that names a file that is not there counts as missing,
// because that is what the scanner would find. python3, gh and ssh have no override. A tool is asked for its version with
// `--version` (`version` for gitleaks, `-V` for ssh), cut off after 5 seconds; the first dotted number on stdout or stderr is
// the version, and only an exit code of 0 yields one. A tool that is found but cannot be asked (cut off, exits non-zero, or
// cannot be started: Node will not start a .cmd or .bat without a shell, and none is used here) is still found, with version null.
//
// diagnose() is synchronous and never throws for anything missing, unreadable or malformed. The claude-security plugin is
// detected from <config dir>/plugins/installed_plugins.json (CLAUDE_CONFIG_DIR, else ~/.claude); nothing else in there is read.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');
const { which, run } = require('./lib/exec.cjs');
const { rampartHome } = require('./lib/paths.cjs');
const { redact } = require('./lib/redact.cjs');
const { listProjects } = require('./store.cjs');

const MIN_NODE_MAJOR = 18;
const PROBE_TIMEOUT_MS = 5000;
const VERSION_RE = /\d+\.\d+(?:\.\d+)?/;
const PACKS_DIR = path.join(__dirname, '..', 'packs');
const PACK_TEMPLATE = '_template.md';
const CLAUDE_SECURITY_PREFIX = 'claude-security@';
const USAGE = 'usage: node scripts/doctor.cjs [--json]';

// In report order. env is the RAMPART_* variable that overrides the PATH lookup (none for the tools no scanner starts through an
// override). missing is the sentence for the degraded list, in plain words: what does not work without the tool.
const TOOLS = [
  { name: 'gitleaks', env: 'RAMPART_GITLEAKS', versionArgs: ['version'], missing: 'gitleaks not found: L1 secrets history scan will be skipped' },
  { name: 'trivy', env: 'RAMPART_TRIVY', versionArgs: ['--version'], missing: 'trivy not found: dependency audit falls back to npm/pnpm audit (yarn unsupported)' },
  { name: 'python3', env: undefined, versionArgs: ['--version'], missing: 'python3 not found: the claude-security plugin cannot run' },
  { name: 'gh', env: undefined, versionArgs: ['--version'], missing: 'gh not found: pull-request lookups are unavailable' },
  { name: 'ssh', env: undefined, versionArgs: ['-V'], missing: 'ssh not found: INFRA probes over SSH will be skipped' },
  { name: 'git', env: 'RAMPART_GIT', versionArgs: ['--version'], missing: 'git not found: repository remotes and change scans are unavailable' },
];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- tools ----------------------------------------------------------------------------------

// The first dotted number in a tool's output ("gitleaks version 8.18.4" is 8.18.4, "OpenSSH_9.6p1, ..." is 9.6), or null.
function parseVersion(text) {
  const match = VERSION_RE.exec(String(text === undefined || text === null ? '' : text));
  return match ? match[0] : null;
}

// {found, path, version} for one tool. Never throws.
function probe({ name, env, versionArgs }, timeoutMs) {
  const missing = { found: false, path: null, version: null };
  try {
    const file = which(name, env);
    if (!file) return missing;
    let result;
    try {
      result = run(file, versionArgs, { timeoutMs });
    } catch (err) {
      // ENOENT: an override that names nothing, which the scanner would report as not found. Any other failure to start
      // (EACCES, EINVAL for a .cmd, ...) means the file is there but cannot be asked.
      return err && err.code === 'ENOENT' ? missing : { found: true, path: file, version: null };
    }
    const version = result.timedOut || result.code !== 0 ? null : parseVersion(`${result.stdout}\n${result.stderr}`);
    return { found: true, path: file, version };
  } catch {
    return missing;
  }
}

// ---- plugins, store, packs ------------------------------------------------------------------

// True when the Claude Code plugin registry lists a claude-security plugin (any marketplace).
function hasClaudeSecurity() {
  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const text = fs.readFileSync(path.join(configDir, 'plugins', 'installed_plugins.json'), 'utf8').replace(/^﻿/, '');
    const { plugins } = JSON.parse(text);
    return isObject(plugins) && Object.keys(plugins).some((key) => key.startsWith(CLAUDE_SECURITY_PREFIX));
  } catch {
    return false;
  }
}

function storeInfo() {
  const home = rampartHome();
  let exists = false;
  try {
    exists = fs.statSync(home).isDirectory();
  } catch {
    // not there yet
  }
  let projects = 0;
  if (exists) {
    try {
      projects = listProjects().length;
    } catch {
      // unreadable: no projects to count
    }
  }
  return { home, exists, projects };
}

// The packs in dir: the *.md files there, leaving out _template.md. A missing or unreadable dir has none.
function countPacks(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const count = entries.filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== PACK_TEMPLATE).length;
    return { dir, exists: true, count };
  } catch {
    return { dir, exists: false, count: 0 };
  }
}

// ---- the report -----------------------------------------------------------------------------

// nodeVersion and timeoutMs exist so tests can reach the paths a real machine cannot (an old Node, a tool that hangs).
function diagnose({ nodeVersion = process.versions.node, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const node = { version: nodeVersion, ok: Number.parseInt(nodeVersion, 10) >= MIN_NODE_MAJOR };
  const tools = {};
  for (const tool of TOOLS) tools[tool.name] = probe(tool, timeoutMs);
  const claudeSecurity = hasClaudeSecurity();
  const degraded = [];
  if (!node.ok) degraded.push(`Node ${node.version} is below ${MIN_NODE_MAJOR}`);
  for (const tool of TOOLS) if (!tools[tool.name].found) degraded.push(tool.missing);
  return {
    node,
    tools,
    plugins: { claudeSecurity },
    store: storeInfo(),
    packs: countPacks(PACKS_DIR),
    engines: { l2l3Unattended: 'rampart', l2l3Attended: claudeSecurity ? 'claude-security' : 'rampart' },
    degraded,
  };
}

// ---- the command line -----------------------------------------------------------------------

class UsageError extends Error {}

function parseCli(argv) {
  try {
    return util.parseArgs({ args: argv, options: { json: { type: 'boolean' } }, strict: true, allowPositionals: false }).values;
  } catch (err) {
    throw new UsageError(err.message.split('\n')[0]);
  }
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function format(report) {
  const { node, tools, plugins, store, packs, engines, degraded } = report;
  const rows = [['tool', 'found', 'version', 'path'], ...Object.entries(tools).map(([name, t]) => [name, t.found ? 'yes' : 'no', t.version || '-', t.path || '-'])];
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => r[col].length)));
  const table = rows.map((r) => r.map((cell, col) => cell.padEnd(widths[col])).join('  ').trimEnd());
  return [
    'rampart doctor',
    node.ok ? `node ${node.version}, ok (${MIN_NODE_MAJOR} or newer is needed)` : `node ${node.version}, below ${MIN_NODE_MAJOR} (${MIN_NODE_MAJOR} or newer is needed)`,
    '',
    ...table,
    '',
    `plugins: claude-security ${plugins.claudeSecurity ? 'installed' : 'not installed'}`,
    `store: ${store.home} (${store.exists ? plural(store.projects, 'project') : 'not created yet'})`,
    `packs: ${packs.dir} (${packs.exists ? plural(packs.count, 'pack') : 'directory not found'})`,
    `engines: L2/L3 unattended runs use ${engines.l2l3Unattended}; attended runs use ${engines.l2l3Attended}`,
    '',
    ...(degraded.length === 0 ? ['degraded: nothing, every tool was found'] : ['degraded:', ...degraded.map((line) => `- ${line}`)]),
  ].join('\n');
}

// Run the command and return its exit code (the caller sets process.exitCode).
function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const { json } = parseCli(argv);
    const report = diagnose();
    stdout.write(`${json ? JSON.stringify(report, null, 2) : format(report)}\n`);
    return 0;
  } catch (err) {
    stderr.write(`doctor: ${redact(err.message)}\n`);
    if (err instanceof UsageError) stderr.write(`${USAGE}\n`);
    return err instanceof UsageError ? 2 : 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { diagnose, parseVersion, countPacks };
