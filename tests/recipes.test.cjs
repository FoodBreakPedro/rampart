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

// ---- dashboard: publish and sync -------------------------------------------------------------

const dashboard = recipes.find((r) => r.name === 'dashboard.md');
const section = (text, title) => {
  const m = new RegExp(`\\n## ${escape(title)}\\r?\\n([\\s\\S]*?)(?=\\n## |$)`).exec(text);
  return m ? m[1] : null;
};

test('dashboard: has the "## Sync" section watch.md points at', () => {
  assert.ok(section(dashboard.text, 'Sync'), 'dashboard.md has a section titled exactly "Sync"');
  assert.match(watch.text, /Sync section of \[dashboard\]/);
});

test('dashboard: the first publish asks first, declares the capabilities and records the settings through the store CLI', () => {
  const pub = section(dashboard.text, 'Publish');
  assert.ok(pub, 'a Publish section');
  const ask = pub.indexOf('Publish the Rampart dashboard as a private claude.ai artifact?');
  const call = pub.search(/Publish with the `Artifact` tool/);
  assert.ok(ask >= 0 && call > ask, 'the question comes before the publish');
  for (const s of ['`artifact-design`', '`artifact-capabilities`', 'db-rules.json', '`icon: "shield"`', '`title: "Rampart Dashboard"`', 'downloads: true', 'user: {}',
    'Claude Code Remote', 'create_session', 'send_message', 'get_session', 'list_sessions', 'list_environments']) {
    assert.ok(pub.includes(s), `Publish names ${s}`);
  }
  assert.match(pub, /store\.cjs" dashboard-set --url <url> --published-at <now> --page-hash <hash>/);
  assert.match(pub, /sync-plan\.cjs" page-copy/);
  assert.match(pub, /`as_level: "view"`/);
  assert.match(pub, /one line/);
  assert.match(pub, /meta\/owner/);
  assert.match(pub, /store\.cjs" dashboard-set --owner-id/);
  assert.match(dashboard.text, /never edit it by hand/);
});

test('dashboard: a republish happens only when the page hash changed, and asks nothing', () => {
  const re = section(dashboard.text, 'Republish');
  assert.ok(re);
  assert.match(re, /sync-plan\.cjs" page-hash/);
  assert.match(re, /`pageHash`/);
  assert.match(re, /no question/i);
  assert.match(re, /dashboard-set --page-hash <hash> --published-at <now>/);
});

test('dashboard: sync pulls and builds versions from one snapshot, then pushes pinned batches; a conflict redoes the whole cycle', () => {
  const sync = section(dashboard.text, 'Sync');
  const at = (s) => {
    const i = sync.indexOf(s);
    assert.ok(i >= 0, `Sync has ${s}`);
    return i;
  };
  const read = at('`out_dir: "<sync>/db"`');
  const pull = at('sync-plan.cjs" pull --project <slug> --in "<sync>/db"');
  const versions = at('sync-plan.cjs" versions --in "<sync>/db" --listings "<sync>/listings" --out "<sync>/versions.json"');
  const push = at('sync-plan.cjs" push --project <slug> --versions "<sync>/versions.json" --out "<sync>/push/<slug>"');
  const batch = at('`ArtifactData batch`');
  assert.ok(read < pull && pull < versions && versions < push && push < batch, 'read, pull, versions, push, batch in that order');
  for (const c of ['`projects`', '`findings`', '`runs`', '`jobs`', '`meta`']) assert.ok(sync.includes(c), `Sync reads ${c}`);
  assert.match(sync, /Write the result text, copied verbatim, to `<sync>\/listings\/<collection>\.txt`/);
  assert.match(sync, /redo the whole cycle/);
  assert.match(sync, /never re-read/i);
  assert.match(sync, /sync-plan\.cjs" meta-sync --in "<sync>\/db" --cursor <cursor>/);
  assert.match(sync, /`update meta\/sync` with `data` the printed JSON and `if_version` the version/);
  assert.match(sync, /`set meta\/sync`[^.]*creates the document/);
  assert.match(sync, /never type/i);
});

test('audit and inventory end with the sync when a dashboard URL exists (R12)', () => {
  for (const name of ['audit.md', 'inventory.md']) {
    const { text } = recipes.find((r) => r.name === name);
    const i = text.search(/Sync section of \[dashboard\]\(\$\{CLAUDE_SKILL_DIR\}\/jobs\/dashboard\.md\)/);
    assert.ok(i >= 0, `${name} names the Sync section`);
    const lastStep = Math.max(...[...text.matchAll(/\n(?:#+ |\d+\. )/g)].map((m) => m.index));
    assert.ok(i > lastStep, `${name}: the sync is in the last section or step`);
    assert.match(text.slice(lastStep), /`url`/, `${name}: only when a dashboard URL exists`);
  }
  const audit = recipes.find((r) => r.name === 'audit.md').text;
  const finish = section(audit, 'L1');
  assert.match(finish.slice(finish.indexOf('### Finish')), /Live dashboard/, 'audit L1 points its Finish at the sync');
});

test('R41: publish and republish send a copy made by page-copy, never the plugin file itself', () => {
  const t = dashboard.text;
  assert.doesNotMatch(t, /`file_path` the page `\$\{CLAUDE_PLUGIN_ROOT\}/);
  for (const name of ['Publish', 'Republish']) {
    const s = section(t, name);
    assert.match(s, /sync-plan\.cjs" page-copy --to "<publish dir>"/, `${name} copies the page`);
  }
  assert.match(section(t, 'Publish'), /`file_path` the printed `file`/);
  assert.match(section(t, 'Publish'), /scratchpad/);
});

test('R42: a publish refused over mcp is recorded with --mcp false, and republish leaves mcp out when recorded or refused', () => {
  const pub = section(dashboard.text, 'Publish');
  const re = section(dashboard.text, 'Republish');
  assert.match(pub, /store\.cjs" dashboard-set --mcp false/);
  assert.match(pub, /store\.cjs" dashboard-set --mcp true/);
  assert.match(re, /`mcp` is `false`[^.]*leave `mcp` out/);
  assert.match(re, /refused over the `mcp` entry[^.]*without `mcp`/);
  assert.match(re, /store\.cjs" dashboard-set --mcp false/);
});

test('R40: the viewer check compares a view-level list of projects with the owner-level one; a mismatch is a failed check', () => {
  const pub = section(dashboard.text, 'Publish');
  assert.doesNotMatch(pub, /limit: 5/);
  assert.match(pub, /`list` of `projects` with `as_level: "view"`/);
  assert.match(pub, /same ids/);
  assert.match(pub, /empty or different[^.]*failed/i);
  assert.doesNotMatch(pub, /`jobs` with `as_level: "view"`/);
});

test('Minor 1: the sync names where its projects come from', () => {
  assert.match(section(dashboard.text, 'Sync'), /store\.cjs" projects`/);
});

// ---- schedule (Task 10) ----------------------------------------------------------------------

const schedule = recipes.find((r) => r.name === 'schedule.md');

test('schedule: the recipe exists with --weekly, --off and the scheduled run', () => {
  assert.ok(schedule, 'jobs/schedule.md exists');
  for (const name of ['Weekly', 'Off', 'Run']) assert.ok(section(schedule.text, name), `schedule.md has a "## ${name}" section`);
  assert.match(schedule.text, /`\/rampart schedule \[--weekly \| --off\]`/);
});

test('schedule: confirms with AskUserQuestion before creating, and tries the schedulers in the order the brief gives', () => {
  const w = section(schedule.text, 'Weekly');
  const ask = w.indexOf('AskUserQuestion');
  const order = ['mcp__scheduled-tasks__create_scheduled_task', 'CronCreate', 'claude -p'].map((s) => w.indexOf(s));
  assert.ok(ask >= 0, 'asks first');
  for (const at of order) assert.ok(at > ask, 'every scheduler comes after the question');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'scheduled-tasks, then CronCreate, then the printed cron line');
  assert.match(w, /store\.cjs" dashboard-set --schedule-id scheduled-tasks:<taskId>/);
  assert.match(w, /store\.cjs" dashboard-set --schedule-id cron:<id>/);
  assert.match(w, /store\.cjs" dashboard-set --schedule-id crontab:rampart-weekly/);
  assert.match(w, /\/rampart schedule --run/, 'the scheduled prompt runs the Run section');
});

test('schedule: --off removes the task with the tool its id names, then clears the id', () => {
  const off = section(schedule.text, 'Off');
  assert.match(off, /mcp__scheduled-tasks__delete_scheduled_task/);
  assert.match(off, /CronDelete/);
  assert.match(off, /crontab/);
  assert.match(off, /store\.cjs" dashboard-set --clear schedule-id/);
});

test('schedule: the run syncs the dashboard, then audits L1 only on systems whose L1 is overdue, asking nothing', () => {
  const run = section(schedule.text, 'Run');
  const sync = run.indexOf('Sync');
  const audit = run.indexOf('/rampart audit L1 --project <slug> --system <id>');
  assert.ok(sync >= 0 && audit > sync, 'sync first, then the audits');
  assert.match(run, /score\.cjs" <slug> --json --no-save/);
  assert.match(run, /`nextDue`/);
  assert.match(run, /ask nothing/i);
});

test('schedule: the front desk routes to it, it is no longer "not in this version", and its tools are allowed', () => {
  const skill = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  assert.match(skill, /\| schedule[^|]*\| schedule \| \[schedule\]\(\$\{CLAUDE_SKILL_DIR\}\/jobs\/schedule\.md\) \|/);
  const description = /^description: "([^"\n]*)"/m.exec(skill)[1];
  assert.match(description, /Available now:(?:(?!L2, L3).)*\bschedule \(a weekly dashboard sync and the overdue L1 audits; --off removes it\)/, 'R44: the description names schedule');
  const notYet = /These are not in this version:[^\n]*/.exec(skill)[0];
  assert.doesNotMatch(notYet, /schedule/);
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill)[1];
  for (const tool of ['mcp__scheduled-tasks__create_scheduled_task', 'mcp__scheduled-tasks__delete_scheduled_task', 'CronCreate', 'CronDelete']) {
    assert.match(head, new RegExp(`^\\s*-\\s*${escape(tool)}\\s*$`, 'm'), `allowed-tools has ${tool}`);
  }
});

test('minor 6: the cron-line id is recorded before the person installs the line, and --weekly then reports it scheduled', () => {
  const w = section(schedule.text, 'Weekly');
  assert.match(w, /`crontab:rampart-weekly` is recorded even before[^.]*installs? the line[^.]*already scheduled[^.]*`--off`/);
});
