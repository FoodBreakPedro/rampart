'use strict';
// PostToolUse hook on Bash (hooks.json): after a `git push` from a checkout of a stored project's repository, suggest
// `/rampart audit L2 --project <slug>`, once per session.
//   push     tool_input.command matches /\bgit\s+push\b/ (the matcher sees only the tool name, so the command is checked here).
//   project  the event's cwd is, or is inside, a repo.paths entry for this machine (machineId) of a stored project's system,
//            compared after resolving symlinks. The first such project in slug order is named. Nothing else is looked at.
//   L2       only while L2 is available on this install: the L2 section of the plugin's own audit recipe
//            (skills/rampart/jobs/audit.md, found from this file, never from the event; RAMPART_AUDIT_RECIPE replaces it for
//            tests) has steps, not only "Arrives with the hunt engine". Otherwise silent, and the once is not used up.
//   once     sessions already told are kept in <rampartHome>/cache/post-push.json as {sessions: {<session_id>: <iso>}},
//            entries older than KEEP_DAYS dropped. A push the hook stays silent about uses nothing up. An event with no
//            session_id is never told (once could not be kept), and neither is one whose telling could not be recorded.
// A hook never fails the session: any error ends it silently with exit 0. No network.

const fs = require('node:fs');
const path = require('node:path');

const PUSH_RE = /\bgit\s+push\b/;
const KEEP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_ID_MAX = 200;
const AUDIT_RECIPE = path.join(__dirname, '..', 'skills', 'rampart', 'jobs', 'audit.md');
const NOT_YET_RE = /^Arrives with the hunt engine\b/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// True when the audit recipe's L2 section has something besides the "Arrives with the hunt engine" note.
function l2Available() {
  let text;
  try {
    text = fs.readFileSync(process.env.RAMPART_AUDIT_RECIPE || AUDIT_RECIPE, 'utf8');
  } catch {
    return false;
  }
  const section = /(?:^|\n)## L2[ \t]*\r?\n([\s\S]*?)(?=\r?\n## |$)/.exec(text);
  if (!section) return false;
  return section[1].split(/\r?\n/).map((l) => l.trim()).some((l) => l !== '' && !NOT_YET_RE.test(l));
}

function real(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

const inside = (dir, root) => dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

// The slug of the first stored project with a system checked out at or above dir on this machine, or null.
function projectFor(dir) {
  const store = require('../scripts/store.cjs');
  const { machineId } = require('../scripts/lib/paths.cjs');
  const me = machineId();
  for (const slug of store.listProjects()) {
    let project;
    try {
      project = store.readProject(slug);
    } catch {
      continue;
    }
    for (const system of (isObject(project) && Array.isArray(project.systems) ? project.systems : [])) {
      const paths = isObject(system) && isObject(system.repo) && isObject(system.repo.paths) ? system.repo.paths : null;
      const checkout = paths && Object.hasOwn(paths, me) ? paths[me] : null;
      if (typeof checkout === 'string' && checkout !== '' && inside(dir, real(checkout))) return slug;
    }
  }
  return null;
}

// Records the session; false when it was already told (or the record cannot be written).
function firstTime(sessionId) {
  const { rampartHome } = require('../scripts/lib/paths.cjs');
  const { writeAtomic } = require('../scripts/lib/atomic.cjs');
  const dir = path.join(rampartHome(), 'cache');
  const file = path.join(dir, 'post-push.json');
  let sessions = {};
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isObject(state) && isObject(state.sessions)) sessions = state.sessions;
  } catch {
    // missing or unreadable: no session told yet
  }
  if (Object.hasOwn(sessions, sessionId)) return false;
  const now = Date.now();
  const kept = {};
  for (const [id, at] of Object.entries(sessions)) {
    if (typeof at === 'string' && now - Date.parse(at) < KEEP_DAYS * DAY_MS) kept[id] = at;
  }
  kept[sessionId] = new Date(now).toISOString();
  try {
    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(file, `${JSON.stringify({ sessions: kept })}\n`);
    return true;
  } catch {
    return false;
  }
}

function message(event) {
  if (!isObject(event)) return null;
  if (event.tool_name !== undefined && event.tool_name !== 'Bash') return null;
  const command = isObject(event.tool_input) ? event.tool_input.command : null;
  if (typeof command !== 'string' || !PUSH_RE.test(command)) return null;
  const sessionId = event.session_id;
  if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > SESSION_ID_MAX) return null;
  if (typeof event.cwd !== 'string' || event.cwd === '') return null;
  if (!l2Available()) return null;
  const slug = projectFor(real(event.cwd));
  if (slug === null || !firstTime(sessionId)) return null;
  return `Rampart: this push went to a repository of the Rampart project ${slug}. Once, briefly, suggest to the user: /rampart audit L2 --project ${slug} reviews the pushed changes.`;
}

function main() {
  try {
    const text = message(JSON.parse(fs.readFileSync(0, 'utf8')));
    if (text) {
      process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } })}\n`);
    }
  } catch {
    // never fail the session
  }
  process.exitCode = 0;
}

main();
