const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
// The front-matter list under key (allowed-tools, say) or the one-line value of key (tools), as an array of entries.
function frontMatter(text, key) {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)[1];
  const line = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(head);
  if (line && line[1].trim()) return line[1].split(/,\s*(?![^()]*\))/).map((s) => s.trim());
  const block = new RegExp(`^${key}:[ \\t]*\\r?\\n((?:[ \\t]+-.*\\r?\\n?)+)`, 'm').exec(head);
  return block ? block[1].split(/\r?\n/).filter(Boolean).map((l) => l.replace(/^\s*-\s*/, '').trim()) : [];
}

test('plugin manifest is valid JSON with name rampart', () => {
  const m = JSON.parse(read('.claude-plugin', 'plugin.json'));
  assert.equal(m.name, 'rampart');
  assert.match(m.version, /^\d+\.\d+\.\d+/);
});

test('T1: plugin.json and package.json carry the same version, and the Node floor is 20 everywhere it is stated', () => {
  const plugin = JSON.parse(read('.claude-plugin', 'plugin.json'));
  const pkg = JSON.parse(read('package.json'));
  assert.equal(plugin.version, pkg.version);
  assert.equal(pkg.engines.node, '>=20');
  assert.match(read('scripts', 'doctor.cjs'), /const MIN_NODE_MAJOR = 20;/);
  assert.match(read('README.md'), /Node 20 or newer/);
});

test('I7: the repository is its own marketplace, listing the rampart plugin at its root, and validate checks both manifests', () => {
  const market = JSON.parse(read('.claude-plugin', 'marketplace.json'));
  assert.equal(market.name, 'rampart');
  assert.deepEqual(market.owner, { name: 'Pedro Zabala' });
  assert.deepEqual(market.plugins.map(({ name, source }) => ({ name, source })), [{ name: 'rampart', source: './' }]);
  assert.ok(!/@|\/Users\/|\\Users\\/.test(JSON.stringify(market)), 'no e-mail address or machine path');
  const validate = JSON.parse(read('package.json')).scripts.validate;
  assert.match(validate, /claude plugin validate \.claude-plugin\/plugin\.json --strict/);
  assert.match(validate, /claude plugin validate \.claude-plugin\/marketplace\.json --strict/);
  assert.match(read('README.md'), /\/plugin marketplace add <owner>\/rampart\n\/plugin install rampart@rampart/);
});

test('I5: the skill pre-approves only the narrow git commands, and no recipe runs git in another form', () => {
  const tools = frontMatter(read('skills', 'rampart', 'SKILL.md'), 'allowed-tools');
  const git = tools.filter((t) => /^Bash\(git\b/.test(t));
  assert.deepEqual(git, ['Bash(git config user.name)', 'Bash(git remote get-url *)', 'Bash(git rev-parse *)']);
  assert.ok(!tools.includes('Bash(git *)'));
  const recipes = ['SKILL.md', 'role.md', ...fs.readdirSync(path.join(ROOT, 'skills', 'rampart', 'jobs')).map((f) => `jobs/${f}`)];
  for (const file of recipes) {
    const text = read('skills', 'rampart', ...file.split('/'));
    for (const [, command] of text.matchAll(/`(git [^`]*)`/g)) {
      if (command === 'git config user.name') continue;
      assert.ok(!/^git -[Cc]\b/.test(command), `${file} runs ${command}`);
      assert.ok(/^git (remote get-url|rev-parse)( |$)/.test(command), `${file} runs ${command}, which no rule pre-approves`);
    }
  }
});

test('T15: the inventory mapper runs no git; the explore agent has only read-only git rules with no wildcard before the subcommand', () => {
  assert.deepEqual(frontMatter(read('agents', 'inventory-mapper.md'), 'tools'), ['Read', 'Glob', 'Grep', 'Bash(ls *)']);
  const explore = frontMatter(read('agents', 'explore.md'), 'tools');
  for (const rule of explore.filter((t) => t.startsWith('Bash('))) {
    assert.match(rule, /^Bash\(git (log|show) \*\)$/, `${rule}: a * before the subcommand would also approve -c <cmd>`);
  }
});
