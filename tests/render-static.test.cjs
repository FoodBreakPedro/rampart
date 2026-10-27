const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const store = require('../scripts/store.cjs');
const { scoreProject } = require('../scripts/score.cjs');
const { machineId } = require('../scripts/lib/paths.cjs');
const { buildData, buildPage, publicProject, renderStatic } = require('../scripts/render-static.cjs');
const { planPacksPush } = require('../scripts/sync-plan.cjs');
const { listPacks, PACKS_DIR } = require('../scripts/packs.cjs');

const RENDER = path.join(__dirname, '..', 'scripts', 'render-static.cjs');
const TEMPLATE = path.join(__dirname, '..', 'dashboard', 'index.html');
const SLUG = 'example-app';
const NAME = 'Example App';
const NOW = new Date('2026-10-23T12:00:00.000Z');
const PLANTED = 'plantedsecret12345';
const EVIDENCE = 'lodash 4.17.20 installed from package-lock.json; 4.17.21 fixes it';
const SCRIPT_BREAK = 'Prototype pollution in lodash </script><script>alert(1)</script>';
const SLOT_RE = /<script id="rampart-data" type="application\/json">([\s\S]*?)<\/script>/;

const slot = (html) => {
  const m = html.match(SLOT_RE);
  assert.ok(m, 'the page has a rampart-data slot');
  return m[1];
};
const count = (text, needle) => text.split(needle).length - 1;

// Each test gets a fresh store root; its name contains a space to prove paths round-trip.
const savedHome = process.env.RAMPART_HOME;
let home;
test.beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart render '));
  process.env.RAMPART_HOME = home;
});
test.afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.RAMPART_HOME;
  else process.env.RAMPART_HOME = savedHome;
});

// One project with two systems, two findings (a tool HIGH, open, and a hardening note) and one finished run, all written
// through the store API. The hardening note's recommendation carries a planted credential.
function seed() {
  store.writeProject({
    slug: SLUG,
    name: NAME,
    criticality: 'high',
    ownerAttestation: { statement: 'I own or am authorized to test every system listed here', by: 'owner', at: '2026-10-23T00:00:00Z' },
    defaultExecutor: 'local',
    cloudAllowed: false,
    systems: [
      {
        id: 'web', type: 'web-nextjs', name: 'Web app', packs: ['web-nextjs'], criticality: 'public', executor: 'either',
        live: { url: 'https://app.example.invalid' }, layers: { L1: { cadenceDays: 7 }, L2: { cadenceDays: 30 } },
      },
      {
        id: 'db', type: 'supabase', name: 'Self-hosted Supabase', packs: ['supabase'], criticality: 'data', executor: 'local',
        layers: { INFRA: { cadenceDays: 30 }, L3: { cadenceDays: 90 } },
      },
    ],
  });
  const run = store.createRun(SLUG, { job: 'audit', layers: ['L1'], systems: ['web'], executor: 'local' });
  const tool = {
    id: '0000000000a1', project: SLUG, system: 'web', layer: 'L1', source: 'npm-audit', ruleId: 'npm/lodash',
    title: SCRIPT_BREAK, severity: 'HIGH', confidence: 'HIGH', class: 'tool',
    location: { package: 'lodash', ecosystem: 'npm', path: 'package-lock.json' }, evidence: EVIDENCE, status: 'open',
    recommendation: 'Upgrade lodash to 4.17.21',
  };
  const hardening = {
    id: '0000000000b2', project: SLUG, system: 'web', layer: 'L1', source: 'headers', ruleId: 'headers/csp-missing',
    title: 'No Content-Security-Policy header', severity: 'MEDIUM', confidence: 'HIGH', class: 'hardening',
    location: { url: 'https://app.example.invalid/', header: 'content-security-policy' },
    evidence: 'content-security-policy is absent from the response', status: 'open',
    recommendation: `Add a policy. Old note pasted from the deploy log: PASSWORD=${PLANTED}`,
  };
  store.upsertFindings(SLUG, [tool, hardening], run.runId);
  store.setDisposition(SLUG, hardening.id, { status: 'open', reason: 'tracked for the next release', by: 'owner' });
  return store.finishRun(SLUG, run.runId, { status: 'done', counts: { added: 2, hardening: 1 } });
}

// ---- renderStatic -----------------------------------------------------------------------------

test('renderStatic writes ~/.rampart/dashboard.html: a full page with the project, its findings and the filled data slot', () => {
  seed();
  const out = renderStatic();
  assert.equal(out, path.join(home, 'dashboard.html'));
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /^<!doctype html>/i, 'the local file gets the document skeleton the artifact host would add');
  assert.ok(html.includes('<title>Rampart Dashboard</title>'));
  assert.ok(html.includes(NAME), 'the project name');
  assert.ok(html.includes(`"slug":"${SLUG}"`), 'the JSON slot is filled');
  assert.ok(html.includes(EVIDENCE), 'the evidence text');
  const data = JSON.parse(slot(html));
  assert.equal(data.projects.length, 1);
  assert.equal(data.projects[0].project.slug, SLUG);
  assert.deepEqual(data.projects[0].findings.map((f) => f.id).sort(), ['0000000000a1', '0000000000b2']);
});

test('renderStatic escapes the data so </script> in a finding cannot end the slot, and the text parses back unchanged', () => {
  seed();
  const html = fs.readFileSync(renderStatic(), 'utf8');
  const text = slot(html);
  assert.ok(!text.includes('<'), 'no raw < inside the slot');
  assert.ok(text.includes('\\u003c/script>'), '< is written as \\u003c');
  assert.ok(!html.includes('</script><script>alert(1)'));
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  assert.equal(count(html, '</script>'), count(template, '</script>'), 'the data added no closing tags');
  const tool = JSON.parse(text).projects[0].findings.find((f) => f.id === '0000000000a1');
  assert.equal(tool.title, SCRIPT_BREAK);
});

test('a credential planted in a stored finding never reaches the page', () => {
  seed();
  const html = fs.readFileSync(renderStatic(), 'utf8');
  assert.ok(!html.includes(PLANTED));
  assert.ok(html.includes('PASSWORD=[REDACTED]'), 'redacted in place, the rest of the text kept');
  assert.ok(!JSON.stringify(buildData(NOW)).includes(PLANTED), 'buildData redacts too');
});

test('renderStatic(outPath) writes there, creating missing folders, and returns the absolute path', () => {
  seed();
  const target = path.join(home, 'nested dir', 'deeper', 'board.html');
  assert.equal(renderStatic(target), target);
  assert.ok(fs.readFileSync(target, 'utf8').includes(NAME));
  assert.ok(!fs.existsSync(path.join(home, 'dashboard.html')), 'nothing written at the default path');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['board.html'], 'no temp file left behind');
});

test('an empty store renders the empty state, with an empty project list in the slot', () => {
  const html = fs.readFileSync(renderStatic(), 'utf8');
  const heading = /<h1 id="empty-heading"[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  assert.ok(heading, 'the empty-state heading is on the page');
  assert.equal(heading[1].replace(/<[^>]+>/g, ''), 'No data yet — run /rampart inventory, then /rampart audit L1');
  const data = JSON.parse(slot(html));
  assert.deepEqual(data.projects, []);
  assert.equal(data.machineId, machineId());
  assert.equal(page().hasProjects(data), false, 'the page shows its empty state for this data');
});

// ---- buildData --------------------------------------------------------------------------------

test('buildData returns everything the detail view needs: project, score, findings, runs and dispositions', () => {
  const run = seed();
  const data = buildData(NOW);
  assert.deepEqual(Object.keys(data).sort(), ['generatedAt', 'machineId', 'packs', 'projects']);
  assert.equal(data.generatedAt, NOW.toISOString());
  assert.equal(data.machineId, machineId());
  assert.equal(data.projects.length, 1);
  const entry = data.projects[0];
  assert.deepEqual(Object.keys(entry).sort(), ['dispositions', 'findings', 'project', 'runs', 'score']);
  assert.deepEqual(entry.project, publicProject(store.readProject(SLUG)), 'the project as publicProject leaves it');
  assert.equal(buildData, buildPage, 'buildData is the old name of buildPage');
  const findings = store.readFindings(SLUG);
  assert.deepEqual(entry.score, scoreProject(store.readProject(SLUG), findings, store.readRuns(SLUG), NOW));
  assert.deepEqual(entry.runs, [run], 'the run.json objects');
  assert.deepEqual(entry.dispositions, store.readDispositions(SLUG));
  assert.equal(entry.dispositions['0000000000b2'].reason, 'tracked for the next release');
  for (const stored of findings) {
    const shown = entry.findings.find((f) => f.id === stored.id);
    assert.ok(shown, stored.id);
    assert.deepEqual(Object.keys(shown).sort(), Object.keys(stored).sort(), `every field of ${stored.id} is kept`);
  }
  assert.deepEqual(entry.findings.find((f) => f.id === '0000000000a1'), findings.find((f) => f.id === '0000000000a1'));
});

// I6: every job saves a score snapshot and then renders, so the page used to compare the score with itself and read 0.
const SCORE_CLI = path.join(__dirname, '..', 'scripts', 'score.cjs');
const scoreCli = () => {
  const r = spawnSync(process.execPath, [SCORE_CLI, SLUG, '--json'], { env: { ...process.env, RAMPART_HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test('I6: score (saving its snapshot) then render: the page shows the trend the score sheet printed, not 0', () => {
  seed();
  store.appendScore(SLUG, { kind: 'project', score: 40, grade: 'D', at: '2026-10-01T00:00:00.000Z' }); // an earlier audit
  const sheet = scoreCli();
  assert.ok(Number.isFinite(sheet.trend) && sheet.trend !== 0, `the sheet has a real trend (${sheet.trend})`);
  const shown = buildData().projects[0].score;
  assert.equal(shown.score, sheet.score);
  assert.equal(shown.trend, sheet.trend, 'the trend the user was told');
  const html = fs.readFileSync(renderStatic(), 'utf8');
  assert.equal(JSON.parse(slot(html)).projects[0].score.trend, sheet.trend);
});

test('I6: the first snapshot shows no trend, and a score that moved since the snapshot shows the change since it', () => {
  seed();
  assert.equal(scoreCli().trend, null);
  assert.equal(buildData().projects[0].score.trend, null, 'no history yet, so no arrow (not "no change")');
  const before = buildData().projects[0].score.score;
  store.upsertFindings(SLUG, [{ ...store.readFindings(SLUG)[0], id: '0000000000c3', ruleId: 'npm/qs', location: { package: 'qs', ecosystem: 'npm' } }], '2026-10-23T12-00-00Z');
  const moved = buildData().projects[0].score;
  assert.ok(moved.score < before, 'a new finding since the snapshot');
  assert.equal(moved.trend, Math.round((moved.score - before) * 10) / 10, 'computed against the snapshot');
  store.appendScore(SLUG, { kind: 'project', score: moved.score, grade: moved.grade }); // an older snapshot shape: no trend
  assert.equal(buildData().projects[0].score.trend, 0, 'without a saved trend the computed one stands');
});

test('buildPage carries the installed packs as the live dashboard holds them: the public pack facts, one per pack, by name', () => {
  seed();
  const { packs } = buildPage(NOW);
  assert.deepEqual(packs.map((p) => p.name), listPacks(), 'every installed pack, in name order');
  const pushed = planPacksPush().docs.map((d) => d.data);
  assert.deepEqual(packs, pushed, 'the same document the sync pushes to packs/<name>');
  for (const p of packs) {
    assert.deepEqual(Object.keys(p).sort(), ['appliesTo', 'classes', 'kinds', 'lastReviewed', 'name', 'probes', 'updatedAt', 'version']);
    assert.equal(typeof p.classes, 'number');
    assert.equal(typeof p.probes, 'number');
  }
  const text = JSON.stringify(packs);
  assert.ok(!text.includes(PACKS_DIR) && !text.includes(os.homedir()), 'no folder of this machine');
  assert.ok(!text.includes('.md'), 'no file name');
  const html = fs.readFileSync(renderStatic(), 'utf8');
  assert.ok(JSON.parse(slot(html)).packs.length === listPacks().length, 'the rendered page carries them in its slot');
});

test('buildData lists every project in slug order and defaults now to the current time', () => {
  seed();
  store.writeProject({ ...store.readProject(SLUG), slug: 'aaa-first', name: 'First', systems: [] });
  const before = Date.now();
  const data = buildData();
  assert.deepEqual(data.projects.map((p) => p.project.slug), ['aaa-first', SLUG]);
  assert.ok(Date.parse(data.generatedAt) >= before - 1000 && Date.parse(data.generatedAt) <= Date.now() + 1000);
  assert.deepEqual(data.projects[0].findings, []);
  assert.deepEqual(data.projects[0].runs, []);
  assert.deepEqual(data.projects[0].dispositions, {});
  assert.throws(() => buildData(new Date('nope')), TypeError);
  assert.throws(() => buildData('2026-10-23'), TypeError);
});

// ---- the template -----------------------------------------------------------------------------

test('dashboard/index.html is one self-contained artifact page with an empty data slot', () => {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  assert.ok(html.slice(0, 8192).includes('<title>Rampart Dashboard</title>'), 'the title is in the first 8 KB');
  assert.equal(slot(html).trim(), '', 'the slot ships empty');
  assert.doesNotMatch(html, /<script[^>]+src=/i, 'no external scripts');
  assert.doesNotMatch(html, /<link[^>]+stylesheet/i, 'no external stylesheets');
  assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, 'DOM is built from nodes and text');
  assert.doesNotMatch(html, /<!doctype|<(?:html|head|body)[\s>]/i, 'the artifact host adds the skeleton');
  for (const block of [/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)/, /:root\[data-theme="dark"\]/]) {
    assert.match(html, block, 'dark tokens for the system setting and for the explicit choice');
  }
});

test('dashboard/index.html: both dark blocks set the same values, and every token they set is defined on bare :root first', () => {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  const block = (re) => {
    const m = html.match(re);
    assert.ok(m, String(re));
    return Object.fromEntries([...m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
  };
  const light = block(/\n:root \{([^}]*)\}/);
  const systemDark = block(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/);
  const explicitDark = block(/\n:root\[data-theme="dark"\] \{([^}]*)\}/);
  assert.deepEqual(systemDark, explicitDark);
  assert.deepEqual(Object.keys(systemDark).filter((k) => !(k in light)), [], 'no token exists only in a dark block');
  const colours = Object.keys(light).filter((k) => !k.startsWith('--font-'));
  assert.deepEqual(colours.filter((k) => !(k in systemDark)), [], 'every colour token has a dark value');
  assert.match(html, /body \{[^}]*background: var\(--bg\)/, 'the body paints its own background');
});

// ---- T13: accessibility of the template ------------------------------------------------------

// WCAG relative luminance and contrast ratio of two #rrggbb colours.
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
function themes() {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  const block = (re) => Object.fromEntries([...html.match(re)[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
  const light = block(/\n:root \{([^}]*)\}/);
  return { light, dark: { ...light, ...block(/\n:root\[data-theme="dark"\] \{([^}]*)\}/) } };
}

test('T13: --faint text reaches 4.5:1 on every background it can sit on, in both themes', () => {
  for (const [name, t] of Object.entries(themes())) {
    for (const bg of ['--bg', '--surface', '--sunk']) {
      const ratio = contrast(t['--faint'], t[bg]);
      assert.ok(ratio >= 4.5, `${name}: --faint on ${bg} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test('T13: every grade badge, the small one included, has 4.5:1 text in both themes (light D was 4.37:1)', () => {
  for (const [name, t] of Object.entries(themes())) {
    for (const g of ['a', 'b', 'c', 'd', 'f']) {
      const ratio = contrast(t[`--grade-${g}-ink`], t[`--grade-${g}`]);
      assert.ok(ratio >= 4.5, `${name}: grade ${g.toUpperCase()} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test('T13: the copy buttons are not marked disabled and say they copy; the copy fallback input is not hidden from assistive tech', () => {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  assert.ok(!html.includes('aria-disabled'), 'a working button is never aria-disabled');
  assert.match(html, /'aria-label': `\$\{ACTION_LABELS\[layer\]\}, copies the command`/);
  const input = /<input id="copy-fallback"[^>]*>/.exec(html);
  assert.ok(input, 'the fallback input is on the page');
  assert.ok(!/aria-hidden/.test(input[0]), 'it takes focus when the clipboard API fails, so it cannot be aria-hidden');
  assert.match(input[0], /aria-label="[^"]+"/);
});

test('T13: long project names wrap in the tile and the detail title', () => {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  for (const selector of ['.card-name', '.detail-title h1']) {
    const rule = new RegExp(`\\n${selector.replace('.', '\\.')} \\{([^}]*)\\}`).exec(html);
    assert.ok(rule, selector);
    assert.match(rule[1], /overflow-wrap: anywhere/, selector);
  }
});

test('T13: only layers with an engine get a Run button; the page sets data-engines to all four layers', () => {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  const main = /<main\b[^>]*>/.exec(html)[0];
  assert.match(main, /id="main"/);
  assert.match(main, /data-engines='\["L1","L2","L3","INFRA"\]'/);
  const { parseEngines, runnableLayers, DEFAULT_ENGINES } = page();
  assert.deepEqual([...DEFAULT_ENGINES], ['L1']);
  assert.deepEqual(parseEngines('["L1"]'), ['L1']);
  assert.deepEqual(parseEngines('["L2", "bogus", "L1"]'), ['L1', 'L2'], 'known layers, in layer order');
  for (const junk of ['', 'L1', '{"L1": true}', 'null', '[']) assert.deepEqual(parseEngines(junk), ['L1'], junk);
  const repo = { id: 'web', layers: { L1: { cadenceDays: 7 }, L2: { cadenceDays: 30 }, L3: { cadenceDays: 90 } } };
  const host = { id: 'db', layers: { INFRA: { cadenceDays: 30 }, L3: { cadenceDays: 90 } } };
  assert.deepEqual(runnableLayers(repo, ['L1']), ['L1'], 'no Run L2 or Run L3');
  assert.deepEqual(runnableLayers(host, ['L1']), [], 'no Probe infra');
  assert.deepEqual(runnableLayers(repo, ['L1', 'L2', 'L3', 'INFRA']), ['L1', 'L2', 'L3'], 'Plan 2 turns them on');
  assert.deepEqual(runnableLayers({ id: 'x' }, ['L1']), []);
});

// ---- the page's own logic (the inline script, run without a DOM) ------------------------------

// The page script, evaluated in this realm. It only boots when there is a document, so here it just returns its helpers.
function page() {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1, 'one inline script besides the data slot');
  return vm.runInThisContext(`(function () {\n${scripts[0]}\nreturn RampartDashboard;\n})()`, { filename: 'dashboard/index.html' });
}

test('page: open counts are open and regressed findings by severity, with hardening counted apart and never by severity', () => {
  const f = (severity, cls, status) => ({ severity, class: cls, status });
  const counts = page().openCounts([
    f('CRITICAL', 'verified', 'open'), f('HIGH', 'tool', 'open'), f('HIGH', 'verified', 'regressed'),
    f('MEDIUM', 'hardening', 'open'), f('LOW', 'hardening', 'regressed'),
    f('LOW', 'verified', 'fixed'), f('HIGH', 'tool', 'false_positive'), f('MEDIUM', 'verified', 'accepted_risk'),
    f('HIGH', 'hardening', 'fixed'),
  ]);
  assert.deepEqual({ ...counts }, { CRITICAL: 1, HIGH: 2, MEDIUM: 0, LOW: 0, hardening: 2 });
});

test('page: a layer is fresh at credit 1, aging at 0.5, stale or never run at 0, and absent when the system does not declare it', () => {
  const { freshness } = page();
  assert.equal(freshness({ credit: 1, lastRun: '2026-10-22T00:00:00Z' }), 'fresh');
  assert.equal(freshness({ credit: 0.5, lastRun: '2026-10-01T00:00:00Z' }), 'aging');
  assert.equal(freshness({ credit: 0, lastRun: '2026-01-01T00:00:00Z' }), 'stale');
  assert.equal(freshness({ credit: 0, lastRun: null }), 'never');
  assert.equal(freshness(undefined), 'absent');
});

test('page: last reviewed is the latest run over every layer of every system', () => {
  const layers = (lastRuns) => Object.fromEntries(lastRuns.map(([l, at]) => [l, { lastRun: at, nextDue: null, credit: 0 }]));
  const score = {
    systems: {
      web: { layers: layers([['L1', '2026-10-20T08:00:00Z'], ['L2', null]]) },
      db: { layers: layers([['INFRA', '2026-10-21T09:30:00Z'], ['L3', '2026-09-01T00:00:00Z']]) },
      none: { layers: {} },
    },
  };
  assert.equal(page().lastReviewed(score), '2026-10-21T09:30:00Z');
  assert.equal(page().lastReviewed({ systems: { web: { layers: layers([['L1', null]]) } } }), null);
});

test('page: the action buttons copy the /rampart audit command for that layer, project and system', () => {
  const { auditCommand, ACTION_LABELS } = page();
  assert.equal(auditCommand('L1', SLUG, 'web'), '/rampart audit L1 --project example-app --system web');
  assert.equal(auditCommand('INFRA', SLUG, 'db'), '/rampart audit INFRA --project example-app --system db');
  assert.deepEqual({ ...ACTION_LABELS }, { L1: 'Run L1', L2: 'Run L2', L3: 'Run L3', INFRA: 'Probe infra' });
});

test('page: the view state round-trips through the URL hash, and default filters are left out of it', () => {
  const { parseHash, buildHash, DEFAULT_FILTERS } = page();
  const state = { slug: SLUG, filters: { system: 'db', severity: 'HIGH', status: 'all', class: 'tool' } };
  const hash = buildHash(state);
  assert.match(hash, /^[A-Za-z0-9._~-]+$/, 'a plain anchor token');
  assert.deepEqual(JSON.parse(JSON.stringify(parseHash(`#${hash}`))), state);
  assert.equal(buildHash({ slug: SLUG, filters: { ...DEFAULT_FILTERS } }), `p-${SLUG}`);
  assert.equal(buildHash({ slug: null, filters: { ...DEFAULT_FILTERS } }), '');
  const odd = { slug: SLUG, filters: { ...DEFAULT_FILTERS, system: 'api~v2.1 eu' } };
  assert.deepEqual(JSON.parse(JSON.stringify(parseHash(buildHash(odd)))), odd, 'a system id with ~, . and a space');
  for (const junk of ['', '#', '#tiles', '#p-', '#p-x~severity', '#%E0%A4%A']) {
    assert.doesNotThrow(() => parseHash(junk), junk);
  }
  assert.equal(parseHash('#tiles').slug, null);
  assert.deepEqual({ ...parseHash(`#p-${SLUG}~bogus.1~severity.LOW`).filters }, { ...DEFAULT_FILTERS, severity: 'LOW' });
});

test('page: findings filter by system, severity, status and class, with "active" meaning open or regressed', () => {
  const { filterFindings, DEFAULT_FILTERS } = page();
  const rows = [
    { id: 'a', system: 'web', severity: 'HIGH', status: 'open', class: 'tool' },
    { id: 'b', system: 'web', severity: 'LOW', status: 'regressed', class: 'verified' },
    { id: 'c', system: 'db', severity: 'HIGH', status: 'fixed', class: 'verified' },
    { id: 'd', system: 'db', severity: 'MEDIUM', status: 'open', class: 'hardening' },
  ];
  const ids = (filters) => filterFindings(rows, { ...DEFAULT_FILTERS, ...filters }).map((f) => f.id).sort();
  assert.deepEqual(ids({}), ['a', 'b', 'd'], 'the default shows open and regressed');
  assert.deepEqual(ids({ status: 'all' }), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids({ status: 'fixed' }), ['c']);
  assert.deepEqual(ids({ system: 'db', status: 'all' }), ['c', 'd']);
  assert.deepEqual(ids({ severity: 'HIGH', status: 'all' }), ['a', 'c']);
  assert.deepEqual(ids({ class: 'hardening' }), ['d']);
});

test('page: locations read as path:line, host, url or package', () => {
  const { formatLocation } = page();
  assert.equal(formatLocation({ path: 'src/api/user.ts', line: 42, symbol: 'getUser' }), 'src/api/user.ts:42');
  assert.equal(formatLocation({ path: 'src/api/user.ts' }), 'src/api/user.ts');
  assert.equal(formatLocation({ host: '192.0.2.10', service: 'supabase-auth', setting: 'GOTRUE_DISABLE_SIGNUP' }), '192.0.2.10 · supabase-auth · GOTRUE_DISABLE_SIGNUP');
  assert.equal(formatLocation({ url: 'https://app.example.invalid/', header: 'content-security-policy' }), 'https://app.example.invalid/ · content-security-policy');
  assert.equal(formatLocation({ package: 'lodash', ecosystem: 'npm', path: 'package-lock.json' }), 'lodash (npm) in package-lock.json');
  assert.equal(formatLocation(null), '');
});

test('page: data with a project list is static mode; anything else is the empty state', () => {
  const { isData, hasProjects } = page();
  for (const bad of [null, undefined, '', 'text', 42, [], {}, { projects: 'no' }]) {
    assert.equal(isData(bad), false, JSON.stringify(bad));
    assert.equal(hasProjects(bad), false, JSON.stringify(bad));
  }
  assert.equal(isData({ projects: [] }), true);
  assert.equal(hasProjects({ projects: [] }), false);
  assert.equal(hasProjects({ projects: [{ project: { slug: SLUG, name: NAME, systems: [] }, score: { systems: {} }, findings: [], runs: [] }] }), true);
});

// ---- the CLI ----------------------------------------------------------------------------------

const cli = (args, env = {}) => {
  const base = { ...process.env, RAMPART_HOME: home, ...env };
  if (!('RAMPART_OPENER' in env)) delete base.RAMPART_OPENER;
  return spawnSync(process.execPath, [RENDER, ...args], { env: base, encoding: 'utf8' });
};

test('CLI writes the default dashboard, prints its path and exits 0', () => {
  seed();
  const r = cli([]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  const out = path.join(home, 'dashboard.html');
  assert.equal(r.stdout, `${out}\n`);
  assert.ok(fs.readFileSync(out, 'utf8').includes(`"slug":"${SLUG}"`));
});

test('CLI --out writes to the given path', () => {
  seed();
  const target = path.join(home, 'out dir', 'rampart.html');
  for (const args of [['--out', target], [`--out=${target}`]]) {
    fs.rmSync(path.dirname(target), { recursive: true, force: true });
    const r = cli(args);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `${target}\n`);
    assert.ok(fs.readFileSync(target, 'utf8').includes(NAME));
  }
});

test('CLI --open hands the written file to the OS opener', () => {
  seed();
  const shim = path.join(home, 'fake-opener.cjs');
  const argvOut = path.join(home, 'opener-argv.json');
  fs.writeFileSync(shim, "require('node:fs').writeFileSync(process.env.OPENER_ARGV_OUT, JSON.stringify(process.argv.slice(2)));\n");
  const r = cli(['--open'], { RAMPART_OPENER: `node:${shim}`, OPENER_ARGV_OUT: argvOut });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  const out = path.join(home, 'dashboard.html');
  const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
  assert.equal(argv[argv.length - 1], out, 'the file is the last argument');
  if (process.platform === 'win32') assert.deepEqual(argv, ['url.dll,FileProtocolHandler', out]);
  else assert.deepEqual(argv, [out]);
});

test('CLI --open still renders and exits 0 when the opener is missing or fails', () => {
  seed();
  const shim = path.join(home, 'failing-opener.cjs');
  fs.writeFileSync(shim, 'process.exitCode = 3;\n');
  for (const opener of [path.join(home, 'no-such-opener.exe'), `node:${shim}`]) {
    fs.rmSync(path.join(home, 'dashboard.html'), { force: true });
    const r = cli(['--open'], { RAMPART_OPENER: opener });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `${path.join(home, 'dashboard.html')}\n`);
    assert.match(r.stderr, /^render-static: could not open the dashboard/);
    assert.ok(fs.existsSync(path.join(home, 'dashboard.html')), opener);
  }
});

test('CLI exits 2 on bad arguments and writes nothing', () => {
  seed();
  for (const args of [['--bogus'], ['--out'], ['extra'], ['--open=1']]) {
    const r = cli(args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^render-static: /);
  }
  assert.ok(!fs.existsSync(path.join(home, 'dashboard.html')));
});

test('CLI exits 1 on a corrupt store, naming the file and never quoting it', () => {
  seed();
  fs.writeFileSync(path.join(home, 'projects', SLUG, 'findings.jsonl'), '{"secret":"sk-ant-abcdefghijklmnop"\n');
  const r = cli([]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^render-static: findings\.jsonl line 1 is not valid JSON/);
  assert.ok(!r.stderr.includes('sk-ant'));
  assert.ok(!fs.existsSync(path.join(home, 'dashboard.html')));
});

test('R35: the page data-version equals .claude-plugin/plugin.json version', () => {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  const main = /<main\b[^>]*>/.exec(html)[0];
  const version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;
  assert.equal(/data-version="([^"]*)"/.exec(main)[1], version);
});
