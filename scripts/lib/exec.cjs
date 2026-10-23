'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// How Rampart finds and starts the external tools (gitleaks, trivy, npm, ...). No shell is ever involved, so an
// argument with a space or a quote reaches the tool as exactly one argv element.

const MAX_BUFFER = 64 * 1024 * 1024;
const NODE_PREFIX = 'node:';
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

function isRunnable(file, win) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (!win) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Where to find a tool. When envOverride names an environment variable that is set (and not empty), its value is
// returned as is, whether or not it exists: it is the user's explicit choice, and tests use it to substitute a shim
// ("node:<script>", see run). Otherwise the first match on PATH: on Windows the name plus each PATHEXT extension, elsewhere
// a file with the execute bit. A name that already has a path in it is checked in place. Returns null when nothing matches.
function which(bin, envOverride) {
  if (envOverride) {
    const forced = process.env[envOverride];
    if (forced) return forced;
  }
  if (typeof bin !== 'string' || bin === '') return null;
  const win = process.platform === 'win32';
  const exts = win ? (process.env.PATHEXT || DEFAULT_PATHEXT).split(';').filter(Boolean) : [];
  const hasExt = win && exts.some((e) => bin.toLowerCase().endsWith(e.toLowerCase()));
  const names = win && !hasExt ? exts.map((e) => bin + e) : [bin];
  const dirs = /[\\/]/.test(bin)
    ? ['']
    : (process.env.PATH || '').split(path.delimiter).map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const file = dir ? path.join(dir, name) : name;
      if (isRunnable(file, win)) return file;
    }
  }
  return null;
}

// Run a command and wait for it. cmd is a binary path, or "node:<script path>" to run that script with the current
// node binary (how tests stand in for a tool). env is merged over the current environment.
// Returns {code, stdout, stderr, timedOut}. A non-zero exit is a result, not an error; code is null when the child
// was killed, and timedOut is true when the timeout did it. Throws only when the child could not be started or its
// output overflowed the buffer (err.code is ENOENT, EACCES, EINVAL, ENOBUFS, ...); the caller decides what that means.
// Note that Node refuses to start a .cmd or .bat without a shell (EINVAL), which is why npm needs care on Windows.
function run(cmd, args = [], { cwd, timeoutMs, env } = {}) {
  if (typeof cmd !== 'string' || cmd === '') throw new TypeError('run: cmd must be a non-empty string');
  if (!Array.isArray(args)) throw new TypeError('run: args must be an array');
  const viaNode = cmd.startsWith(NODE_PREFIX);
  const timeout = timeoutMs > 0 ? timeoutMs : undefined;
  const result = spawnSync(viaNode ? process.execPath : cmd, viaNode ? [cmd.slice(NODE_PREFIX.length), ...args] : args, {
    cwd,
    env: env ? { ...process.env, ...env } : undefined,
    timeout,
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });
  const timedOut =
    (result.error !== undefined && result.error.code === 'ETIMEDOUT') ||
    (timeout !== undefined && result.status === null && result.signal === 'SIGTERM');
  if (result.error && !timedOut) throw result.error;
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', timedOut };
}

module.exports = { which, run };
