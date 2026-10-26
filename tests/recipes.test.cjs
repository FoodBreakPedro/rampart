// Static checks over the job recipes (skills/rampart/jobs/*.md): every script command a recipe tells Claude to run names a
// script that exists, with a subcommand and flags that script accepts; no recipe runs git beyond the skill's pre-approved
// rules; and the watch recipe pins every write it makes to a job or executor document.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKILL_DIR = path.join(ROOT, 'skills', 'rampart');
const JOBS_DIR = path.join(SKILL_DIR, 'jobs');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');

const recipes = fs
  .readdirSync(JOBS_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((name) => ({ name, text: fs.readFileSync(path.join(JOBS_DIR, name), 'utf8') }));

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every `node "${CLAUDE_PLUGIN_ROOT}/scripts/<x>.cjs" ...` in a recipe, up to the closing backtick or the end of the line, so
// inline code and fenced blocks are both covered.
function invocations(text) {
  const out = [];
  for (const m of text.matchAll(/node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([^"]+)"([^`\n]*)/g)) {
    const tokens = m[2].match(/"[^"]*"|\S+/g) || [];
    const first = tokens[0];
    const sub = first !== undefined && /^[a-z][a-z0-9-]*$/.test(first) ? first : null;
    const flags = tokens.filter((t) => t.startsWith('--')).map((t) => t.slice(2).split('=')[0]);
    out.push({ script: m[1], sub, flags, line: m[0].trim() });
  }
  return out;
}

const sources = new Map();
const sourceOf = (script) => {
  if (!sources.has(script)) sources.set(script, fs.readFileSync(path.join(SCRIPTS_DIR, script), 'utf8'));
  return sources.get(script);
};

test('the recipe parser sees what a recipe runs', () => {
  const [a, b, c] = invocations(
    [
      'Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/store.cjs" findings <slug> --status open --new-since=<start> --json`.',
      '```',
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/inventory-scan.cjs" "<folder> with --space" --json',
      '```',
      '`node "${CLAUDE_PLUGIN_ROOT}/scripts/score.cjs" <slug>`',
    ].join('\n')
  );
  assert.deepEqual([a.script, a.sub, a.flags], ['store.cjs', 'findings', ['status', 'new-since', 'json']]);
  assert.deepEqual([b.script, b.sub, b.flags], ['inventory-scan.cjs', null, ['json']], 'a quoted argument is neither a subcommand nor a flag');
  assert.deepEqual([c.script, c.sub, c.flags], ['score.cjs', null, []]);
});

// What is wrong with one script command, or null: a missing script, a subcommand or a flag its source does not know.
function problem(inv) {
  if (!/^[a-z0-9-]+.cjs$/.test(inv.script)) return `names no script (${inv.script})`;
  if (!fs.existsSync(path.join(SCRIPTS_DIR, inv.script))) return `scripts/${inv.script} does not exist`;
  const src = sourceOf(inv.script);
  if (inv.sub !== null && !new RegExp(`['"]${escape(inv.sub)}['"]|^\\s*${escape(inv.sub)}:`, 'm').test(src)) {
    return `${inv.script} has no subcommand ${inv.sub}`;
  }
  const flag = inv.flags.find((f) => !new RegExp(`--${escape(f)}(?![a-z0-9-])`).test(src));
  return flag === undefined ? null : `${inv.script} does not take --${flag}`;
}

test('every script command in a recipe names a script that exists, with a subcommand and flags it accepts', () => {
  let checked = 0;
  for (const { name, text } of recipes) {
    for (const inv of invocations(text)) {
      checked++;
      assert.equal(problem(inv), null, `${name}: ${inv.line}`);
    }
  }
  assert.ok(checked >= 20, `only ${checked} script commands found: the parser is missing them`);
});

test('the check catches a script, subcommand or flag that does not exist', () => {
  const lines = [
    '`node "${CLAUDE_PLUGIN_ROOT}/scripts/nope.cjs" --json`',
    '`node "${CLAUDE_PLUGIN_ROOT}/scripts/store.cjs" frobnicate <slug>`',
    '`node "${CLAUDE_PLUGIN_ROOT}/scripts/jobs.cjs" claim-patch --job "<f>" --claimant <id>`',
    '`node "${CLAUDE_PLUGIN_ROOT}/scripts/jobs.cjs" claim-patch --job "<f>" --executor <id>`',
  ];
  assert.deepEqual(
    lines.map((line) => problem(invocations(line)[0])),
    ['scripts/nope.cjs does not exist', 'store.cjs has no subcommand frobnicate', 'jobs.cjs does not take --claimant', null]
  );
});

// The skill's Bash(git ...) rules as patterns: a trailing * stands for any arguments.
function gitRules() {
  const skill = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill)[1];
  return [...head.matchAll(/^\s*-\s*Bash\((git [^)]*)\)\s*$/gm)].map(([, rule]) =>
    new RegExp(`^${escape(rule).replace(/ \\\*$/, '( .*)?')}$`)
  );
}

test('the git rules read from allowed-tools approve only their own commands', () => {
  const ok = (command) => gitRules().some((r) => r.test(command));
  assert.deepEqual(
    ['git config user.name', 'git remote get-url origin', 'git rev-parse --show-toplevel', 'git push', 'git config user.email', 'git remote add x y'].map(ok),
    [true, true, true, false, false, false]
  );
});

test('no recipe runs git beyond the skill\'s pre-approved rules, inline or in a code block', () => {
  const rules = gitRules();
  assert.ok(rules.length >= 1);
  for (const { name, text } of recipes) {
    const fenced = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].flatMap(([, body]) => body.split('\n'));
    const inline = [...text.matchAll(/`([^`\n]+)`/g)].map(([, code]) => code);
    for (const command of [...inline, ...fenced].map((c) => c.trim()).filter((c) => /^git\b/.test(c))) {
      assert.ok(rules.some((r) => r.test(command)), `${name} runs \`${command}\`, which no allowed-tools rule pre-approves`);
    }
  }
});

// ---- watch -----------------------------------------------------------------------------------

const watch = recipes.find((r) => r.name === 'watch.md');

// The recipe's paragraphs and list items, each with its continuation lines.
const blocks = (text) =>
  text
    .split(/\r?\n(?=\s*(?:\d+\.|-)\s)|\r?\n\s*\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean);

test('watch: every step that writes a job or executor document, and every claim, is pinned with if_version', () => {
  assert.ok(watch, 'jobs/watch.md exists');
  const writes = blocks(watch.text).filter((b) => /`(?:set|update|delete) (?:jobs|executors)\/[^`]*`|claim-patch/.test(b));
  assert.ok(writes.length >= 7, `only ${writes.length} write steps found`);
  for (const b of writes) assert.match(b, /`if_version`/, `not pinned: ${b.slice(0, 160)}`);
  // Every update says which version it pins; a set without it only where the text says it creates the document.
  const sentenceAfter = (b, i) => b.slice(i).split(/\.(?:\s|$)/)[0];
  let updates = 0;
  let sets = 0;
  for (const b of writes) {
    for (const m of b.matchAll(/`(update|set) (?:jobs|executors)\/[^`]*`/g)) {
      const rest = sentenceAfter(b, m.index);
      if (m[1] === 'update') {
        updates++;
        assert.match(rest, /`if_version` the version/, `an update must say which version it pins: ${rest.slice(0, 160)}`);
      } else {
        sets++;
        assert.match(rest, /creates the document|`if_version` the version/, `a set must pin a version or say it creates the document: ${rest.slice(0, 160)}`);
      }
    }
    const unpinned = b.replace(/[^.]*creates the document[^.]*\./g, '');
    assert.doesNotMatch(unpinned, /\b(?:no|without|omit|skip)\b[^.\n]*`if_version`/i, `an unpinned write: ${b.slice(0, 160)}`);
  }
  assert.ok(updates >= 7 && sets >= 1, `${updates} updates and ${sets} sets found`);
});

test('watch: the next pass is scheduled on every pass, not only on an idle one', () => {
  const step = /\n6\. \*\*Next pass\.\*\*([\s\S]*)$/.exec(watch.text);
  assert.ok(step, 'step 6 exists');
  const [lead, ...bullets] = step[1].split(/\n\s*- /);
  assert.match(lead, /heartbeat as in step 4\.11\.\s*Then, every pass:/, 'the heartbeat is separate from the scheduling');
  assert.doesNotMatch(lead, /no job ran this pass[^.]*,\s*then:/i, 'the scheduling is not conditioned on an idle pass');
  assert.ok(bullets.some((b) => /^`ScheduleWakeup`/.test(b)), 'a ScheduleWakeup bullet follows');
  for (const b of bullets) assert.doesNotMatch(b, /no job ran/i);
});

test('watch: job failures name the right cause and a stuck claim is handled', () => {
  const t = watch.text;
  assert.match(t, /names a target this project's inventory does not list"; so does an `audit` job with no `layer` and a `verify` job with no `findingId`/);
  assert.doesNotMatch(t, /no `findingId`[^\n]*verify is not available/);
  const running = blocks(t).find((b) => /\*\*Running\.\*\*/.test(b));
  assert.match(running, /`get jobs\/<id>` once: still `claimed` and `claimedBy` this executor, redo the write with `if_version` the version just read/);
});

test('watch: the claim is a fresh read, a queued check, then a pinned update; a version conflict is a lost race', () => {
  const t = watch.text;
  assert.match(t, /`ArtifactData get jobs\/<id>`/);
  assert.match(t, /`status` is not `queued`/);
  assert.match(t, /claim-patch --job "<job file>" --executor <executorId>`, then `update jobs\/<id>` with `data` the printed patch and `if_version` the version from the fresh read/);
  assert.match(t, /lost race/);
});

test('watch: refuses without a URL or an owner id, refuses jobs the owner did not create, leaves cloud and apply jobs alone', () => {
  const t = watch.text;
  assert.match(t, /store\.cjs" dashboard --json/);
  assert.match(t, /`url` null[^\n]*stop/);
  assert.match(t, /`ownerId` null[^\n]*no job may run[^\n]*Stop/);
  assert.match(t, /`createdBy` is not exactly `ownerId`[^\n]*refusal-patch/);
  assert.match(t, /`executorKind` is `cloud`/);
  assert.match(t, /`type` is `apply`/);
  for (const text of ['layer <L> is not available in this version', 'verify is not available in this version', 'not runnable from the dashboard in this version']) {
    assert.ok(t.includes(`"${text}"`), `fixed failure text: ${text}`);
  }
});

test('watch: every patch comes from jobs.cjs, Remote Control is recorded through the store CLI, and --once never schedules', () => {
  const t = watch.text;
  for (const cmd of ['executor-doc', 'refusal-patch', 'claim-patch', 'start-patch', 'completion-patch']) {
    assert.ok(t.includes(`scripts/jobs.cjs" ${cmd}`), `watch runs jobs.cjs ${cmd}`);
  }
  assert.match(t, /store\.cjs" dashboard-set --remote-control true/);
  assert.match(t, /never edit it by hand/);
  assert.match(t, /`--once`: stop/);
  assert.match(t, /120-second delay/);
  assert.match(t, /Sync section of \[dashboard\]\(\$\{CLAUDE_SKILL_DIR\}\/jobs\/dashboard\.md\)/);
});
