'use strict';
// SessionStart hook (hooks.json): one line of additionalContext when a tool a stored project needs is missing on this machine,
// and nothing otherwise.
//   needs   a repo-backed system with an L1 layer needs gitleaks, trivy and git; a host-backed system with INFRA needs ssh.
//   report  the doctor's (scripts/doctor.cjs), cached per day in <rampartHome>/cache/doctor.json as {day, at, report}, day
//           being the UTC date. A cache from another day, or none, is refreshed by this same script run with --refresh,
//           detached, so a slow doctor (each tool's version probe may take seconds) never holds up the session: the hook
//           waits for today's cache at most CACHE_WAIT_MS and, when it is not there yet, says nothing this time.
// A hook never fails the session: any error, here or in the store, ends it silently with exit 0. No network.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CACHE_WAIT_MS = 1200;
const POLL_MS = 40;
const REFRESH_LOCK_MS = 60 * 1000; // a refresh started less than this long ago is still running (or died): do not start another
const TOOL_ORDER = ['gitleaks', 'trivy', 'python3', 'gh', 'ssh', 'git']; // the doctor's report order

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const today = () => new Date().toISOString().slice(0, 10);

const cacheDir = () => path.join(require('../scripts/lib/paths.cjs').rampartHome(), 'cache');
const cacheFile = () => path.join(cacheDir(), 'doctor.json');
const lockFile = () => path.join(cacheDir(), 'doctor.refresh');

// tool name -> the slugs of the stored projects that need it, in slug order.
function toolNeeds() {
  const store = require('../scripts/store.cjs');
  const needs = new Map();
  const need = (tool, slug) => {
    if (!needs.has(tool)) needs.set(tool, []);
    if (!needs.get(tool).includes(slug)) needs.get(tool).push(slug);
  };
  for (const slug of store.listProjects()) {
    let project;
    try {
      project = store.readProject(slug);
    } catch {
      continue; // one unreadable project does not silence the others
    }
    for (const system of (isObject(project) && Array.isArray(project.systems) ? project.systems : [])) {
      if (!isObject(system) || !isObject(system.layers)) continue;
      if (isObject(system.repo) && isObject(system.layers.L1)) for (const tool of ['gitleaks', 'trivy', 'git']) need(tool, slug);
      if (isObject(system.host) && isObject(system.layers.INFRA)) need('ssh', slug);
    }
  }
  return needs;
}

// Today's cached report, or null.
function cachedReport() {
  try {
    const cache = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    return isObject(cache) && cache.day === today() && isObject(cache.report) && isObject(cache.report.tools) ? cache.report : null;
  } catch {
    return null;
  }
}

// Start a detached refresh unless one started a moment ago, then wait a little for today's report.
function refreshAndWait() {
  fs.mkdirSync(cacheDir(), { recursive: true });
  let running = false;
  try {
    running = Date.now() - fs.statSync(lockFile()).mtimeMs < REFRESH_LOCK_MS;
  } catch {
    // no lock: nothing running
  }
  if (!running) {
    fs.writeFileSync(lockFile(), new Date().toISOString());
    // The listener keeps an async spawn error from ending this hook with exit 1 and a stack trace.
    spawn(process.execPath, [__filename, '--refresh'], { detached: true, stdio: 'ignore', env: process.env }).on('error', () => {}).unref();
  }
  for (let waited = 0; waited < CACHE_WAIT_MS; waited += POLL_MS) {
    sleep(POLL_MS);
    const report = cachedReport();
    if (report) return report;
  }
  return null;
}

// --refresh: run the doctor in this (detached) process and cache its report. The lock goes whatever happens, so a refresh
// that failed does not hold up the next one for REFRESH_LOCK_MS.
function refresh() {
  try {
    const { diagnose } = require('../scripts/doctor.cjs');
    const { writeAtomic } = require('../scripts/lib/atomic.cjs');
    const report = diagnose();
    fs.mkdirSync(cacheDir(), { recursive: true });
    writeAtomic(cacheFile(), `${JSON.stringify({ day: today(), at: new Date().toISOString(), report })}\n`);
  } finally {
    try {
      fs.unlinkSync(lockFile());
    } catch {
      // already gone
    }
  }
}

// The one line, or null when there is nothing to say.
function message() {
  const needs = toolNeeds();
  if (needs.size === 0) return null;
  const report = cachedReport() || refreshAndWait();
  if (!report) return null;
  const degraded = Array.isArray(report.degraded) ? report.degraded.filter((d) => typeof d === 'string') : [];
  const parts = [];
  for (const tool of TOOL_ORDER) {
    const probe = report.tools[tool];
    if (!needs.has(tool) || !isObject(probe) || probe.found !== false) continue;
    const sentence = degraded.find((d) => d.startsWith(`${tool} not found`)) || `${tool} not found`;
    parts.push(`${sentence} (needed by ${needs.get(tool).join(', ')})`);
  }
  return parts.length ? `Rampart: ${parts.join('; ')}. Run /rampart doctor for details.` : null;
}

function main() {
  try {
    if (process.argv[2] === '--refresh') {
      refresh();
      return;
    }
    try {
      fs.readFileSync(0); // the event: nothing in it is needed, but it is read so the writer never blocks
    } catch {
      // no stdin
    }
    const text = message();
    if (text) {
      process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })}\n`);
    }
  } catch {
    // never fail the session
  }
  process.exitCode = 0;
}

main();
