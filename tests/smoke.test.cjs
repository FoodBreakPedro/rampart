const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
test('plugin manifest is valid JSON with name rampart', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(m.name, 'rampart');
  assert.match(m.version, /^\d+\.\d+\.\d+/);
});
