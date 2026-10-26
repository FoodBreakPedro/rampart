// The plugin's hooks (hooks/hooks.json): each script is run as Claude Code runs it, with an event on stdin, and what it prints
// is pinned exactly. A hook never fails the session: whatever goes wrong, it exits 0 and prints nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { machineId } = require('../scripts/lib/paths.cjs');

const ROOT = path.join(__dirname, '..');
const SESSION_START = path.join(ROOT, 'hooks', 'session-start.cjs');
const POST_PUSH = path.join(ROOT, 'hooks', 'post-push.cjs');
const SLUG = 'example-app';
const today = () => new Date().toISOString().slice(0, 10);

let home;
let repo;
let emptyBin;
test.beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart hooks '));
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rampart repo ')));
  emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart bin '));
});
test.afterEach(() => {
  for (const dir of [home, repo, emptyBin]) fs.rmSync(dir, { recursive: true, force: true });
});

// A stored project as project.json, written straight to the store (the hooks only read it).
function storeProject(slug, systems) {
  const dir = path.join(home, 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ slug, name: slug, criticality: 'public', defaultExecutor: 'local', systems }));
}
const repoSystem = (paths, layers = { L1: { cadenceDays: 7 }, L2: { cadenceDays: 30 } }) => ({
  id: 'web', type: 'web-nextjs', name: 'Web', packs: [], executor: 'local', repo: { paths }, layers,
});
const hostSystem = () => ({ id: 'box', type: 'docker-host', name: 'Box', packs: [], executor: 'local', host: { ssh: 'me@box' }, layers: { INFRA: { cadenceDays: 30 } } });

// The doctor's report as session-start caches it, with the named tools missing.
function doctorReport(missing) {
  const names = ['gitleaks', 'trivy', 'python3', 'gh', 'ssh', 'git'];
  const sentences = {
    gitleaks: 'gitleaks not found: L1 secrets history scan will be skipped',
    trivy: 'trivy not found: dependency audit falls back to npm/pnpm audit (yarn unsupported)',
    ssh: 'ssh not found: INFRA probes over SSH will be skipped',
    git: 'git not found: repository remotes and change scans are unavailable',
    python3: 'python3 not found: the claude-security plugin cannot run',
    gh: 'gh not found: pull-request lookups are unavailable',
  };
  const tools = Object.fromEntries(names.map((n) => [n, missing.includes(n) ? { found: false, path: null, version: null } : { found: true, path: `/bin/${n}`, version: '1.0' }]));
  return { tools, degraded: missing.map((n) => sentences[n]) };
}
function writeCache(day, report) {
  fs.mkdirSync(path.join(home, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(home, 'cache', 'doctor.json'), JSON.stringify({ day, at: new Date().toISOString(), report }));
}

function runHook(file, event, env = {}) {
  const input = typeof event === 'string' ? event : JSON.stringify(event);
  const started = Date.now();
  const r = spawnSync(process.execPath, [file], { input, encoding: 'utf8', env: { ...process.env, RAMPART_HOME: home, ...env }, timeout: 10000 });
  return { ...r, ms: Date.now() - started };
}

const startEvent = () => ({ session_id: 'sess-1', hook_event_name: 'SessionStart', source: 'startup', cwd: repo, transcript_path: '/nowhere' });
const pushEvent = (over = {}) => ({
  session_id: 'sess-1', hook_event_name: 'PostToolUse', cwd: repo, tool_name: 'Bash',
  tool_input: { command: 'git push origin main' }, tool_response: { stdout: '', stderr: '' }, ...over,
});

const sessionContext = (text) => `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })}\n`;
const pushContext = (slug) =>
  `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `Rampart: this push went to a repository of the Rampart project ${slug}. Once, briefly, suggest to the user: /rampart audit L2 --project ${slug} reviews the pushed changes.`,
    },
  })}\n`;

// ---- hooks.json --------------------------------------------------------------------------------

test('hooks.json wires SessionStart and PostToolUse on Bash to the two scripts through the plugin root', () => {
  const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const start = json.hooks.SessionStart;
  const post = json.hooks.PostToolUse;
  assert.equal(start.length, 1);
  assert.deepEqual(start[0].hooks.map((h) => [h.type, h.command]), [['command', 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.cjs"']]);
  assert.equal(post.length, 1);
  assert.equal(post[0].matcher, 'Bash');
  assert.deepEqual(post[0].hooks.map((h) => [h.type, h.command]), [['command', 'node "${CLAUDE_PLUGIN_ROOT}/hooks/post-push.cjs"']]);
  for (const h of [...start[0].hooks, ...post[0].hooks]) assert.ok(h.timeout > 0 && h.timeout <= 10, 'a short timeout');
  assert.deepEqual(Object.keys(json.hooks).sort(), ['PostToolUse', 'SessionStart']);
});

// ---- SessionStart ------------------------------------------------------------------------------

test('session-start: a missing tool a stored project needs, from today\'s cache, is one line of additionalContext', () => {
  storeProject(SLUG, [repoSystem({ [machineId()]: repo })]);
  storeProject('infra', [hostSystem()]);
  writeCache(today(), doctorReport(['gitleaks', 'ssh', 'gh']));
  const r = runHook(SESSION_START, startEvent());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(
    r.stdout,
    sessionContext(
      'Rampart: gitleaks not found: L1 secrets history scan will be skipped (needed by example-app); ' +
        'ssh not found: INFRA probes over SSH will be skipped (needed by infra). Run /rampart doctor for details.'
    )
  );
  assert.ok(!r.stdout.includes('gh not found'), 'a tool no stored project needs is not mentioned');
});

test('session-start: silent when nothing a project needs is missing, and when there are no projects', () => {
  writeCache(today(), doctorReport(['gitleaks', 'trivy']));
  const none = runHook(SESSION_START, startEvent());
  assert.equal(none.status, 0);
  assert.equal(none.stdout, '', 'no projects: nothing to say');
  storeProject('infra', [hostSystem()]);
  const r = runHook(SESSION_START, startEvent());
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'gitleaks and trivy are missing, but only a host system is stored');
});

test('session-start: with no cache it runs the doctor, caches today\'s report, and still finishes in under 2 s', () => {
  storeProject(SLUG, [repoSystem({ [machineId()]: repo })]);
  // An empty PATH: every tool is missing, and the doctor has nothing to wait for.
  const r = runHook(SESSION_START, startEvent(), { PATH: emptyBin, RAMPART_GITLEAKS: '', RAMPART_TRIVY: '', RAMPART_GIT: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.ms < 2000, `took ${r.ms} ms`);
  assert.equal(
    r.stdout,
    sessionContext(
      'Rampart: gitleaks not found: L1 secrets history scan will be skipped (needed by example-app); ' +
        'trivy not found: dependency audit falls back to npm/pnpm audit (yarn unsupported) (needed by example-app); ' +
        'git not found: repository remotes and change scans are unavailable (needed by example-app). Run /rampart doctor for details.'
    )
  );
  const cache = JSON.parse(fs.readFileSync(path.join(home, 'cache', 'doctor.json'), 'utf8'));
  assert.equal(cache.day, today());
  assert.equal(cache.report.tools.gitleaks.found, false);
});

test('session-start: yesterday\'s cache is not trusted; the fresh report is', () => {
  storeProject(SLUG, [repoSystem({ [machineId()]: repo })]);
  writeCache('2000-01-01', doctorReport(['gitleaks']));
  const shim = path.join(emptyBin, 'tool.cjs');
  fs.writeFileSync(shim, "process.stdout.write('tool version 1.2.3\\n');");
  const env = { PATH: emptyBin, RAMPART_GITLEAKS: `node:${shim}`, RAMPART_TRIVY: `node:${shim}`, RAMPART_GIT: `node:${shim}` };
  const r = runHook(SESSION_START, startEvent(), env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'every tool the project needs is found now');
  assert.ok(r.ms < 2000, `took ${r.ms} ms`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'cache', 'doctor.json'), 'utf8')).day, today());
});

test('session-start: never fails the session, whatever it is given', () => {
  storeProject(SLUG, [repoSystem({ [machineId()]: repo })]);
  writeCache(today(), 'not a report'); // not a report: refreshed, and every tool is found then
  const shim = path.join(emptyBin, 'tool.cjs');
  fs.writeFileSync(shim, "process.stdout.write('tool version 1.2.3\\n');");
  const env = { PATH: emptyBin, RAMPART_GITLEAKS: `node:${shim}`, RAMPART_TRIVY: `node:${shim}`, RAMPART_GIT: `node:${shim}` };
  for (const input of ['', 'not json', '[]', JSON.stringify(startEvent())]) {
    const r = runHook(SESSION_START, input, env);
    assert.equal(r.status, 0, input);
    assert.equal(r.stdout, '', input);
    assert.equal(r.stderr, '', input);
  }
  const file = path.join(emptyBin, 'a file');
  fs.writeFileSync(file, 'x');
  const r = runHook(SESSION_START, startEvent(), { RAMPART_HOME: file });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

// ---- PostToolUse: git push ---------------------------------------------------------------------

test('post-push: a push from a stored project\'s repo suggests audit L2 once', () => {
  storeProject(SLUG, [repoSystem({ [machineId()]: repo })]);
  const r = runHook(POST_PUSH, pushEvent());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, pushContext(SLUG));
  const state = JSON.parse(fs.readFileSync(path.join(home, 'cache', 'post-push.json'), 'utf8'));
  assert.ok(Object.hasOwn(state.sessions, 'sess-1'));
});

test('post-push: silent for a second push in the same session; a new session hears it again', () => {
  storeProject(SLUG, [repoSystem({ [machineId()]: repo })]);
  assert.equal(runHook(POST_PUSH, pushEvent()).stdout, pushContext(SLUG));
  const again = runHook(POST_PUSH, pushEvent({ tool_input: { command: 'git push --force-with-lease' } }));
  assert.equal(again.status, 0);
  assert.equal(again.stdout, '');
  assert.equal(runHook(POST_PUSH, pushEvent({ session_id: 'sess-2' })).stdout, pushContext(SLUG));
});

test('post-push: a push from a folder inside the repo counts', () => {
  storeProject(SLUG, [repoSystem({ [machineId()]: repo })]);
  const sub = path.join(repo, 'packages', 'app');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(runHook(POST_PUSH, pushEvent({ cwd: sub })).stdout, pushContext(SLUG));
});

test('post-push: silent for an unknown repo, and the session can still hear it later', () => {
  storeProject(SLUG, [repoSystem({ [machineId()]: repo })]);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart other '));
  try {
    const r = runHook(POST_PUSH, pushEvent({ cwd: other }));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    // A sibling whose name merely starts with the repo's path is not inside it.
    fs.mkdirSync(`${repo}-sibling`);
    assert.equal(runHook(POST_PUSH, pushEvent({ cwd: `${repo}-sibling` })).stdout, '');
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
    fs.rmSync(`${repo}-sibling`, { recursive: true, force: true });
  }
  assert.equal(runHook(POST_PUSH, pushEvent()).stdout, pushContext(SLUG), 'nothing was used up by the silent pushes');
});

test('post-push: silent when the repo path is another machine\'s', () => {
  storeProject(SLUG, [repoSystem({ 'another-mach': repo })]);
  assert.equal(runHook(POST_PUSH, pushEvent()).stdout, '');
});

test('post-push: silent for a Bash command that is not a git push', () => {
  storeProject(SLUG, [repoSystem({ [machineId()]: repo })]);
  for (const command of ['git status', 'git pull', 'echo pushing', 'git pushx', 'npm run push']) {
    const r = runHook(POST_PUSH, pushEvent({ tool_input: { command } }));
    assert.equal(r.status, 0, command);
    assert.equal(r.stdout, '', command);
  }
  assert.equal(runHook(POST_PUSH, pushEvent({ tool_input: { command: 'npm test && git  push -u origin HEAD' } })).stdout, pushContext(SLUG));
});

test('post-push: never fails the session, whatever it is given', () => {
  storeProject(SLUG, [repoSystem({ [machineId()]: repo })]);
  const inputs = [
    '', 'not json', '[]', 'null',
    JSON.stringify(pushEvent({ session_id: undefined })),
    JSON.stringify(pushEvent({ tool_input: null })),
    JSON.stringify(pushEvent({ cwd: 42 })),
  ];
  for (const input of inputs) {
    const r = runHook(POST_PUSH, input);
    assert.equal(r.status, 0, input);
    assert.equal(r.stdout, '', input);
    assert.equal(r.stderr, '', input);
  }
  fs.mkdirSync(path.join(home, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(home, 'cache', 'post-push.json'), '{broken');
  const r = runHook(POST_PUSH, pushEvent());
  assert.equal(r.status, 0);
  assert.equal(r.stdout, pushContext(SLUG), 'an unreadable state file counts as empty');
  const file = path.join(emptyBin, 'a file');
  fs.writeFileSync(file, 'x');
  const bad = runHook(POST_PUSH, pushEvent(), { RAMPART_HOME: file });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, '');
  assert.equal(bad.stderr, '');
});
