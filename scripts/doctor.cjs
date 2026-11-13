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
// diagnose() is synchronous and never throws for anything missing, unreadable or malformed, a home directory that cannot be
// determined included (store.home is then null and the degraded list says so). The claude-security plugin counts as
// present when any of three things in the Claude config dir (CLAUDE_CONFIG_DIR, else ~/.claude) says so, tried in this order:
//   installed    plugins/installed_plugins.json has a "claude-security@..." key under "plugins"
//   settings     settings.json has an "enabledPlugins" entry with such a key set to true
//   marketplace  a marketplace clone holds it: plugins/marketplaces/<any>/plugins/claude-security/.claude-plugin/plugin.json
//                (how the desktop app can offer its skills with no entry in either JSON file)
// claudeSecuritySource says which one answered. Nothing else in these files or folders is read.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');
const { which, run } = require('./lib/exec.cjs');
const { rampartHome } = require('./lib/paths.cjs');
const { redact } = require('./lib/redact.cjs');
const { listProjects } = require('./store.cjs');
const { listPacks } = require('./packs.cjs');

const MIN_NODE_MAJOR = 20; // package.json engines.node; 18 is past end of life
const PROBE_TIMEOUT_MS = 5000;
const VERSION_RE = /\d+\.\d+(?:\.\d+)?/;
const PACKS_DIR = path.join(__dirname, '..', 'packs');
const CLAUDE_SECURITY_PREFIX = 'claude-security@';
const BYTE_ORDER_MARK = 0xfeff; // a UTF-8 BOM at the start of a JSON file does not matter
const USAGE = 'usage: node scripts/doctor.cjs [--json]';
const NO_HOME = 'home directory could not be determined: store location unknown';

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

const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// The object under `field` of a JSON file in the Claude config dir, or null when the file is missing, unreadable, not JSON, or
// has anything but an object there. Never throws.
function readClaudeConfig(relativeFile, field) {
  try {
    const text = fs.readFileSync(path.join(claudeConfigDir(), ...relativeFile), 'utf8');
    const value = JSON.parse(text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text)[field];
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

const hasClaudeSecurityKey = (map, accept) => map !== null && Object.keys(map).some((key) => key.startsWith(CLAUDE_SECURITY_PREFIX) && accept(map[key]));

// True when some marketplace clone under plugins/marketplaces has the claude-security plugin (its plugin.json, as a file).
function marketplaceHasClaudeSecurity() {
  try {
    const root = path.join(claudeConfigDir(), 'plugins', 'marketplaces');
    return fs.readdirSync(root).some((name) => {
      try {
        return fs.statSync(path.join(root, name, 'plugins', 'claude-security', '.claude-plugin', 'plugin.json')).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

// Where the claude-security plugin was found: 'installed' (the plugin registry lists it, from any marketplace), 'settings'
// (settings.json enables it, the value being true: false and anything else means off), 'marketplace' (a marketplace clone
// holds it, which is availability, not a sign it is switched on), or null.
function claudeSecuritySource() {
  if (hasClaudeSecurityKey(readClaudeConfig(['plugins', 'installed_plugins.json'], 'plugins'), () => true)) return 'installed';
  if (hasClaudeSecurityKey(readClaudeConfig(['settings.json'], 'enabledPlugins'), (enabled) => enabled === true)) return 'settings';
  if (marketplaceHasClaudeSecurity()) return 'marketplace';
  return null;
}

// The store: where it is, whether it is there, how many projects. home is null when it cannot be worked out (RAMPART_HOME unset
// and os.homedir() throws, as it does with no HOME and no passwd entry).
function storeInfo() {
  let home;
  try {
    home = rampartHome();
  } catch {
    return { home: null, exists: false, projects: 0 };
  }
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

// The packs in dir (listPacks: *.md files, leaving out _template.md and any other file starting with _). A missing or
// unreadable dir has none.
function countPacks(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return { dir, exists: false, count: 0 };
    return { dir, exists: true, count: listPacks(dir).length };
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
  const source = claudeSecuritySource();
  const claudeSecurity = source !== null;
  const degraded = [];
  if (!node.ok) degraded.push(`Node ${node.version} is below ${MIN_NODE_MAJOR}`);
  for (const tool of TOOLS) if (!tools[tool.name].found) degraded.push(tool.missing);
  const store = storeInfo();
  if (store.home === null) degraded.push(NO_HOME);
  return {
    node,
    tools,
    plugins: { claudeSecurity, claudeSecuritySource: source },
    store,
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

// How the plugins line names where claude-security was found.
const CLAUDE_SECURITY_LABEL = {
  installed: 'installed (installed_plugins.json)',
  settings: 'enabled (settings.json)',
  marketplace: 'available (marketplace clone)',
};

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
    `plugins: claude-security ${CLAUDE_SECURITY_LABEL[plugins.claudeSecuritySource] || 'not installed'}`,
    store.home === null
      ? 'store: unknown (home directory could not be determined)'
      : `store: ${store.home} (${store.exists ? plural(store.projects, 'project') : 'not created yet'})`,
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
