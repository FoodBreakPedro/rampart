const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDocument, makeEvent } = require('./fixtures/mini-dom.cjs');

// Live mode of dashboard/index.html: the page script runs in a vm context over a minimal DOM (tests/fixtures/mini-dom.cjs),
// with a stub window.claude whose db replays the documents under tests/fixtures/db/<collection>/<id>.json and lets a test
// push later snapshots.

const TEMPLATE = path.join(__dirname, '..', 'dashboard', 'index.html');
const FIXTURE_DB = path.join(__dirname, 'fixtures', 'db');
const COLLECTIONS = ['projects', 'findings', 'runs', 'jobs', 'executors', 'packs', 'meta'];
const OWNER_ID = 'u_owner_placeholder';

const clone = (v) => JSON.parse(JSON.stringify(v));
function deepFreeze(v) {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(deepFreeze);
    Object.freeze(v);
  }
  return v;
}

// {collection: {id: body}} from the fixture tree.
function fixtureDocs() {
  const out = {};
  for (const c of fs.readdirSync(FIXTURE_DB)) {
    out[c] = {};
    for (const file of fs.readdirSync(path.join(FIXTURE_DB, c))) {
      out[c][file.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(FIXTURE_DB, c, file), 'utf8'));
    }
  }
  return out;
}

// A db stub with the shape of db.d.ts: collection(c).onSnapshot(next, error) delivers the collection soon after it is
// registered and again on every push; doc(path).get/set/update/delete. Snapshots and bodies are frozen, like the real ones.
// Options: failOn {c: code} ends c's subscription with that error instead of delivering; pending [c] delivers nothing for
// c until release(c); cachedFirst {c: 'empty' | 'full'} first delivers a fromCache snapshot (no documents, or the seed's),
// and the definitive one only on release(c); holdWrites keeps each update() unsettled in `held` until the test calls its
// resolve() (the write lands and is delivered) or reject(reason). update() merges nested objects and replaces anything else
// (arrays included), as db.d.ts says.
function stubDb(seed, { failOn = {}, pending = [], cachedFirst = {}, holdWrites = false } = {}) {
  const docs = {};
  const subs = [];
  const writes = [];
  const held = [];
  const meta = Object.freeze({ fromCache: false, hasPendingWrites: false });
  const cachedMeta = Object.freeze({ fromCache: true, hasPendingWrites: false });
  for (const c of Object.keys(seed)) docs[c] = new Map(Object.entries(seed[c]).map(([id, b]) => [id, deepFreeze(clone(b))]));
  const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const merge = (base, patch) => {
    const out = { ...(isPlain(base) ? base : {}) };
    for (const [k, v] of Object.entries(patch)) out[k] = isPlain(v) && isPlain(out[k]) ? merge(out[k], v) : v;
    return out;
  };
  const docSnap = (id, body) => Object.freeze({ id, exists: body !== undefined, data: () => body, metadata: meta });

  function snapshotFor(sub, { cached = null } = {}) {
    const map = cached === 'empty' ? new Map() : docs[sub.collection] || new Map();
    const ids = Array.from(map.keys()).sort();
    const list = ids.map((id) => docSnap(id, map.get(id)));
    const changes = [];
    ids.forEach((id, i) => {
      if (!sub.seen.has(id)) changes.push({ type: 'added', doc: list[i], oldIndex: -1, newIndex: i });
      else if (sub.seen.get(id) !== map.get(id)) changes.push({ type: 'modified', doc: list[i], oldIndex: i, newIndex: i });
    });
    for (const [id, body] of sub.seen) {
      if (!map.has(id)) changes.push({ type: 'removed', doc: docSnap(id, body), oldIndex: 0, newIndex: -1 });
    }
    sub.seen = new Map(map);
    return Object.freeze({ docs: list, size: list.length, empty: list.length === 0, docChanges: () => changes, metadata: cached ? cachedMeta : meta });
  }
  const deliver = (c) => subs.filter((s) => s.collection === c && s.active).forEach((s) => s.next(snapshotFor(s)));
  const put = (c, id, body) => {
    docs[c] = docs[c] || new Map();
    if (body === undefined) docs[c].delete(id);
    else docs[c].set(id, deepFreeze(clone(body)));
  };

  const docRef = (p) => {
    const [c, id] = p.split('/');
    return Object.freeze({
      id,
      path: p,
      get: async () => docSnap(id, docs[c] && docs[c].get(id)),
      set: async (data) => {
        writes.push({ op: 'set', path: p, data: clone(data) });
        put(c, id, data);
        deliver(c);
      },
      update: (data) => {
        writes.push({ op: 'update', path: p, data: clone(data) });
        const land = () => {
          put(c, id, merge(docs[c].get(id), data));
          deliver(c);
        };
        if (!holdWrites) return Promise.resolve().then(land);
        return new Promise((resolve, reject) => held.push({ path: p, resolve: () => { land(); resolve(); }, reject }));
      },
      delete: async () => {
        writes.push({ op: 'delete', path: p });
        put(c, id, undefined);
        deliver(c);
      },
    });
  };

  const db = Object.freeze({
    doc: docRef,
    collection: (c) => Object.freeze({
      path: c,
      doc: (id) => docRef(`${c}/${id}`),
      onSnapshot(next, error) {
        const sub = { collection: c, next, error, active: true, seen: new Map() };
        subs.push(sub);
        setImmediate(() => {
          if (!sub.active) return;
          if (failOn[c]) {
            sub.active = false;
            error({ code: failOn[c], message: failOn[c] });
          } else if (cachedFirst[c]) next(snapshotFor(sub, { cached: cachedFirst[c] }));
          else if (!pending.includes(c)) next(snapshotFor(sub));
        });
        return () => { sub.active = false; };
      },
    }),
  });
  return {
    db,
    subs,
    writes,
    held,
    push(c, id, body) { put(c, id, body); deliver(c); },
    remove(c, id) { put(c, id, undefined); deliver(c); },
    release: (c) => deliver(c),
    fail(c, code) { subs.filter((s) => s.collection === c && s.active).forEach((s) => { s.active = false; s.error({ code, message: code }); }); },
  };
}

const stubUser = ({ owner = false, can = null, id = OWNER_ID } = {}) => Object.freeze({
  isOwner: async () => owner,
  canEdit: async () => owner,
  can: async (name) => (name === 'data.write' ? can : can === null ? null : false),
  id: async () => id,
});

// window.claude with use(name) recording each name asked for.
function stubClaude({ db = null, user = null, mcp = null, downloads = null } = {}) {
  const asked = [];
  return {
    asked,
    use: async (name) => {
      asked.push(name);
      if (name === 'db') return db;
      if (name === 'user') return user;
      if (name === 'mcp') return mcp;
      if (name === 'downloads') return downloads;
      return null;
    },
  };
}

// The page, booted over the mini DOM: its markup after </style> (the data slot filled with `inline`), its one inline script
// run in a fresh context whose window has `claude` when given.
function bootPage({ inline = '', claude, hash = '', engines = null } = {}) {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  const scriptAt = html.indexOf('<script>');
  const markup = html.slice(html.indexOf('</style>') + '</style>'.length, scriptAt)
    .replace(/(<script id="rampart-data" type="application\/json">)(<\/script>)/, (m, open, close) => `${open}${inline}${close}`)
    .replace(/data-engines='[^']*'/, (m) => (engines ? `data-engines='${JSON.stringify(engines)}'` : m));
  const { document } = createDocument(markup);
  const script = /<script>([\s\S]*?)<\/script>/.exec(html.slice(scriptAt))[1];
  const location = { hash };
  const setHash = (url) => { location.hash = String(url).replace(/^[^#]*/, ''); };
  const intervals = [];
  const errors = [];
  const deferred = [];
  const win = {
    document,
    location,
    history: { pushState: (s, t, url) => setHash(url), replaceState: (s, t, url) => setHash(url) },
    navigator: { platform: 'test' },
    console: { ...console, error: (...args) => errors.push(args), warn: (...args) => errors.push(args) },
    // Short timers (the toast, animation frames) run; long ones are held until the test calls fireDeferred().
    setTimeout: (fn, ms, ...args) => (ms >= 5000 ? deferred.push({ fn, ms, live: true }) : setTimeout(fn, ms, ...args)),
    clearTimeout: (id) => {
      if (typeof id === 'number') { if (deferred[id - 1]) deferred[id - 1].live = false; } else clearTimeout(id);
    },
    setInterval: (fn, ms) => intervals.push({ fn, ms }),
    clearInterval: () => {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    getComputedStyle: () => ({ columnGap: '16px' }),
    matchMedia: () => ({ matches: false }),
    getSelection: () => '',
    scrollTo: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  if (claude) win.claude = claude;
  win.window = win;
  vm.createContext(win);
  const api = vm.runInContext(`${script}\n;RampartDashboard`, win, { filename: 'dashboard/index.html' });
  const fireDeferred = () => deferred.filter((t) => t.live).forEach((t) => { t.live = false; t.fn(); });
  return { api, document, window: win, intervals, errors, deferred, fireDeferred, $: (id) => document.getElementById(id) };
}

// Let the stub's setImmediate deliveries and the page's promise chains run.
async function settle() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

// Node identity. assert.equal on two DOM nodes that differ builds a diff of the whole cyclic tree, which takes minutes.
const same = (actual, expected, message = 'not the same node') => assert.ok(actual === expected, message);
const visible = (el) => {
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) if (n.hidden) return false;
  return true;
};
const tile = (doc, slug) => doc.querySelector(`li[data-key="${slug}"]`);
const scoreText = (doc, slug) => tile(doc, slug).querySelector('.score-value').textContent;
const withHeartbeat = (seed, at) => {
  const out = clone(seed);
  out.executors['session-placeholder'].heartbeatAt = at;
  return out;
};

async function bootLive({ seed = withHeartbeat(fixtureDocs(), new Date().toISOString()), user = stubUser(), hash = '', options, mcp = null, engines = null, downloads = null } = {}) {
  const store = stubDb(seed, options);
  const claude = stubClaude({ db: store.db, user, mcp, downloads });
  const page = bootPage({ claude, hash, engines });
  await settle();
  return { ...page, store, claude };
}

// ---- assembling page data from DB documents (pure) ------------------------------------------

test('live data: the DB documents assemble into the page data the static mode renders, grouped by project', () => {
  const { api } = bootPage();
  const seed = fixtureDocs();
  const docs = {};
  for (const c of COLLECTIONS) docs[c] = Object.entries(seed[c]).map(([id, data]) => ({ id, data }));
  const data = clone(api.pageDataFromDocs(docs)); // into this realm, so deepEqual compares plain arrays
  assert.equal(api.isData(data), true);
  assert.equal(data.generatedAt, '2026-10-23T18:05:00Z', 'the latest sync time, pushed or pulled, over every machine');
  assert.equal(data.machineId, 'machine-placeholder');
  assert.deepEqual(data.projects.map((p) => p.project.slug), ['example-app', 'example-site'], 'slug order, as buildPage');
  const app = data.projects[0];
  assert.equal(app.score.score, 62.8, 'the score is read from the project doc');
  assert.equal('score' in app.project, false, 'the project carries no score, cadenceOverrides or updatedAt, as in static mode');
  assert.equal('cadenceOverrides' in app.project, false);
  assert.equal('updatedAt' in app.project, false);
  assert.deepEqual(app.findings.map((f) => f.id).sort(), ['a3f9c21be0d4', 'b71e04c9d2a8']);
  assert.deepEqual(app.runs.map((r) => r.runId), ['2026-10-23T18-02-11Z']);
  assert.deepEqual(app.jobs.map((j) => j.id), ['job-0001']);
  assert.deepEqual(app.dispositions, {}, 'a null disposition is no decision');
  const site = data.projects[1];
  assert.deepEqual(Object.keys(site.dispositions), ['c0ffee123456'], "a finding's disposition field is the decision");
  assert.equal(site.dispositions.c0ffee123456.status, 'accepted_risk');
  assert.deepEqual(data.live.executors.map((e) => e.id), ['session-placeholder']);
  assert.equal(data.live.syncedAt, '2026-10-23T18:05:00Z');
});

test('live data: an empty DB is page data with no projects; a project doc without a score still renders', () => {
  const { api } = bootPage();
  const empty = api.pageDataFromDocs({});
  assert.equal(api.isData(empty), true);
  assert.equal(api.hasProjects(empty), false);
  assert.equal(empty.generatedAt, null);
  const bare = api.pageDataFromDocs({ projects: [{ id: 'p1', data: { name: 'P1', systems: [] } }] });
  assert.equal(api.hasProjects(bare), true);
  assert.equal(bare.projects[0].project.slug, 'p1', 'the doc id stands in for a missing slug');
});

test('live data: pack docs assemble into data.packs, sorted by name, with only the public pack facts', () => {
  const { api } = bootPage();
  const seed = fixtureDocs();
  const docs = { packs: Object.entries(seed.packs).map(([id, data]) => ({ id, data })) };
  const data = clone(api.pageDataFromDocs(docs));
  assert.deepEqual(data.packs.map((p) => p.name), ['supabase', 'web-nextjs']);
  assert.deepEqual(data.packs[1], { id: 'web-nextjs', ...seed.packs['web-nextjs'] });
  assert.deepEqual(clone(api.pageDataFromDocs({})).packs, [], 'no packs collection is no packs');
  assert.deepEqual(clone(api.pageDataFromDocs({ packs: [{ id: 'x', data: 'no' }, { id: 'y', data: { version: '1.0.0' } }] })).packs, [], 'a doc without a name is left out');
});

test('live data: an executor is online when any heartbeat is under 5 minutes old', () => {
  const { api } = bootPage();
  const now = Date.parse('2026-10-23T19:00:00Z');
  assert.equal(api.executorOnline([{ heartbeatAt: '2026-10-23T18:56:00Z' }], now), true);
  assert.equal(api.executorOnline([{ heartbeatAt: '2026-10-23T18:54:00Z' }], now), false);
  assert.equal(api.executorOnline([{ heartbeatAt: '2026-10-23T18:50:00Z' }, { heartbeatAt: '2026-10-23T18:59:59Z' }], now), true);
  assert.equal(api.executorOnline([], now), false);
  assert.equal(api.executorOnline([{ heartbeatAt: 'nope' }, null], now), false);
});

// ---- live mode, booted ----------------------------------------------------------------------

test('live mode: renders a tile per project doc, subscribing once per collection, with the live badge', async () => {
  const { document, store, claude, $, intervals } = await bootLive();
  assert.deepEqual(claude.asked.slice(0, 1), ['db']);
  assert.deepEqual(store.subs.map((s) => s.collection).sort(), [...COLLECTIONS].sort(), 'one subscription per collection');
  assert.ok(visible($('tiles-view')));
  assert.ok(!visible($('empty-view')));
  assert.ok(!visible($('loading-view')));
  assert.equal(scoreText(document, 'example-app'), '62.8');
  assert.equal(scoreText(document, 'example-site'), '91.5');
  const badge = $('mode-badge').textContent;
  assert.match(badge, /^Live · synced .+ · executor online$/);
  assert.match(tile(document, 'example-app').querySelector('.card-foot').textContent, /^Synced .+ from machine-placeholder$/);
  assert.ok(intervals.length >= 1, 'the badge re-checks the executor heartbeat on a timer');
});

test('live mode: an onSnapshot update changes one tile score in place, without replacing the node or resubscribing', async () => {
  const { document, store, $ } = await bootLive();
  const before = tile(document, 'example-app');
  const card = before.querySelector('.card');
  const value = before.querySelector('.score-value');
  const other = tile(document, 'example-site');
  const seed = fixtureDocs();
  store.push('projects', 'example-app', { ...seed.projects['example-app'], score: { ...seed.projects['example-app'].score, score: 71.4, grade: 'B' } });
  await settle();
  assert.equal(scoreText(document, 'example-app'), '71.4');
  same(tile(document, 'example-app'), before, 'same <li>');
  same(before.querySelector('.card'), card, 'same card');
  same(before.querySelector('.score-value'), value, 'same score node, text patched');
  assert.equal(before.querySelector('.grade').textContent, 'B');
  assert.match(before.querySelector('.grade').className, /grade-B/, 'class patched');
  same(tile(document, 'example-site'), other, 'the other tile is untouched');
  assert.equal(store.subs.length, COLLECTIONS.length, 'no new subscription on update');
  assert.equal($('carousel').children.length, 2);
});

test('live mode: a project doc added or removed adds or removes its tile; the rest stay', async () => {
  const { document, store } = await bootLive();
  const app = tile(document, 'example-app');
  store.push('projects', 'example-new', { slug: 'example-new', name: 'Example New', systems: [], score: { score: 50, grade: 'D', systems: {} } });
  await settle();
  assert.ok(tile(document, 'example-new'));
  same(tile(document, 'example-app'), app);
  store.remove('projects', 'example-site');
  await settle();
  same(tile(document, 'example-site'), null);
  same(tile(document, 'example-app'), app);
});

test('live mode: a snapshot change for one finding leaves the focus and an open <details> untouched', async () => {
  const { document, store, $ } = await bootLive({ hash: '#p-example-app~status.all' });
  assert.ok(visible($('detail-view')));
  const rowA = document.querySelector('tr[data-key="a3f9c21be0d4"]');
  const rowB = document.querySelector('tr[data-key="b71e04c9d2a8"]');
  assert.ok(rowA && rowB, 'finding rows are keyed by id');
  const details = rowA.querySelector('details');
  details.open = true;
  const summary = details.querySelector('summary');
  summary.focus();
  same(document.activeElement, summary);
  const seed = fixtureDocs();
  store.push('findings', 'b71e04c9d2a8', {
    ...seed.findings.b71e04c9d2a8, status: 'false_positive',
    disposition: { status: 'false_positive', reason: 'Not reachable', by: OWNER_ID, at: '2026-10-23T19:10:00Z' },
  });
  await settle();
  same(document.activeElement, summary, 'focus stays where it was');
  assert.equal(details.open, true, 'the open details stays open');
  same(document.querySelector('tr[data-key="a3f9c21be0d4"]'), rowA, 'the untouched row is the same node');
  same(document.querySelector('tr[data-key="b71e04c9d2a8"]'), rowB, 'the changed row is patched in place');
  assert.equal(rowB.querySelector('.status').textContent, 'False positive');
  assert.match(rowB.className, /is-closed/);
  assert.match(rowB.querySelector('.finding-details').textContent, /False positive: Not reachable/, 'the decision comes from the disposition field');
});

test('live mode: a focused filter select keeps the focus and its value through an update; sheet and run rows are keyed', async () => {
  const { document, store, $ } = await bootLive({ hash: '#p-example-app~severity.HIGH' });
  const select = $('filter-severity');
  select.focus();
  assert.equal(select.value, 'HIGH');
  const sheetRow = document.querySelector('tr[data-key="mobile"]');
  assert.ok(sheetRow, 'score-sheet rows are keyed by system id');
  assert.ok(document.querySelector('tr[data-key="2026-10-23T18-02-11Z"]'), 'run rows are keyed by run id');
  const jobRow = document.querySelector('tr[data-key="job-0001"]');
  assert.ok(jobRow, 'job rows are keyed by job id');
  const seed = fixtureDocs();
  store.push('projects', 'example-app', { ...seed.projects['example-app'], score: { ...seed.projects['example-app'].score, score: 70 } });
  store.push('jobs', 'job-0001', { ...seed.jobs['job-0001'], status: 'running' });
  await settle();
  same(document.activeElement, select);
  assert.equal(select.value, 'HIGH');
  same(document.querySelector('tr[data-key="mobile"]'), sheetRow);
  same(document.querySelector('tr[data-key="job-0001"]'), jobRow);
  assert.match(jobRow.textContent, /Running/);
  assert.equal(document.querySelector('.detail-head').querySelector('.score-value').textContent, '70.0');
});

test('live mode: removing the project on screen goes back to the tiles', async () => {
  const { store, $ } = await bootLive({ hash: '#p-example-site' });
  assert.ok(visible($('detail-view')));
  store.remove('projects', 'example-site');
  await settle();
  assert.ok(visible($('tiles-view')));
  assert.ok(!visible($('detail-view')));
});

test('live mode: the badge says offline when no executor heartbeat is recent, and never synced with no meta/sync', async () => {
  const seed = withHeartbeat(fixtureDocs(), '2026-01-01T00:00:00Z');
  delete seed.meta;
  const { $ } = await bootLive({ seed });
  assert.match($('mode-badge').textContent, /^Live · synced never · executor offline$/);
});

test('live mode: an empty DB shows the empty state, not the loading state, with the live badge', async () => {
  const { $ } = await bootLive({ seed: {} });
  assert.ok(visible($('empty-view')));
  assert.ok(!visible($('loading-view')));
  assert.match($('mode-badge').textContent, /^Live/);
});

test('live mode: while the host has not answered use("db") the page shows the loading state, not "No data yet"', () => {
  const claude = { use: () => new Promise(() => {}) };
  const { $ } = bootPage({ claude });
  assert.ok(visible($('loading-view')));
  assert.ok(!visible($('empty-view')));
});

// ---- no DB: static and empty fallbacks -----------------------------------------------------

const STATIC = {
  generatedAt: '2026-10-23T18:30:00.000Z',
  machineId: 'machine-placeholder',
  projects: [{
    project: { slug: 'example-app', name: 'Example App', systems: [{ id: 'mobile', type: 'mobile-expo', layers: { L1: { cadenceDays: 7 } } }] },
    score: { score: 80, grade: 'B', trend: null, systems: { mobile: { score: 80, grade: 'B', layers: { L1: { credit: 1, lastRun: '2026-10-23T18:00:00Z' } } } } },
    findings: [], runs: [], dispositions: {},
  }],
};

test('static mode: inline data renders as a static snapshot without asking for the db', async () => {
  const claude = stubClaude({ db: stubDb(fixtureDocs()).db });
  const { document, $, intervals } = bootPage({ inline: JSON.stringify(STATIC), claude });
  await settle();
  assert.deepEqual(claude.asked, [], 'inline data is static mode: no claude.use');
  assert.equal(scoreText(document, 'example-app'), '80.0');
  assert.match($('mode-badge').textContent, /^Static snapshot .+/);
  assert.ok(!$('mode-badge').textContent.includes('Live'));
  assert.equal(intervals.length, 0);
  const button = document.querySelector('button.action');
  assert.equal(button.getAttribute('data-command'), '/rampart audit L1 --project example-app --system mobile', 'buttons copy the command');
});

// The rows of the packs table: [name, version, reviewed, applies to, kinds, classes, probes] per row.
const packRows = (document) => Array.from(document.getElementById('packs').querySelectorAll('tr')).map((tr) => Array.from(tr.querySelectorAll('th, td')).map((c) => c.textContent));

test('packs: live mode lists each pack doc, read-only, and a pack removed from the DB leaves the table', async () => {
  const { document, store, $ } = await bootLive();
  assert.ok(visible($('packs-block')), 'the packs block shows with the tiles');
  assert.equal($('packs-block').querySelectorAll('button, input, select, [data-write]').length, 0, 'nothing to click or write');
  assert.deepEqual(packRows(document), [
    ['supabase', '1.0.0', '2026-10-23', 'supabase', 'host', '7', '8'],
    ['web-nextjs', '1.0.0', '2026-10-23', 'web-nextjs', 'code', '14', '0'],
  ]);
  const before = $('packs').querySelector('tr[data-key="supabase"]');
  store.remove('packs', 'web-nextjs');
  await settle();
  assert.deepEqual(packRows(document).map((r) => r[0]), ['supabase']);
  same($('packs').querySelector('tr[data-key="supabase"]'), before, 'the other row is patched in place');
  store.remove('packs', 'supabase');
  await settle();
  assert.ok(!visible($('packs-block')), 'no packs, no block');
});

test('packs: static mode lists the packs in the inline data; inline data without packs hides the block', async () => {
  const packs = [
    { name: 'docker-host', version: '1.2.0', lastReviewed: '2026-10-20', appliesTo: ['docker-host', 'supabase'], kinds: ['host'], classes: 5, probes: 9, updatedAt: '2026-10-20T10:00:00Z' },
  ];
  const { document, $ } = bootPage({ inline: JSON.stringify({ ...STATIC, packs }) });
  await settle();
  assert.ok(visible($('packs-block')));
  assert.deepEqual(packRows(document), [['docker-host', '1.2.0', '2026-10-20', 'docker-host, supabase', 'host', '5', '9']]);
  const bare = bootPage({ inline: JSON.stringify(STATIC) });
  await settle();
  assert.ok(!visible(bare.$('packs-block')), 'older static data carries no packs');
  assert.equal(bare.$('packs').querySelectorAll('tr').length, 0);
});

test('no DB: use("db") resolving null renders the empty state without throwing, and asks for nothing else', async () => {
  const claude = stubClaude({ db: null });
  const { $, errors } = bootPage({ claude });
  await settle();
  assert.deepEqual(claude.asked, ['db']);
  assert.ok(visible($('empty-view')));
  assert.ok(!visible($('loading-view')));
  assert.ok($('empty-hint-error').hidden, 'not the error hint');
  assert.deepEqual(errors, []);
  assert.equal($('main').getAttribute('data-access'), 'read');
});

test('no DB: no window.claude at all (a saved copy of the page) renders the empty state', async () => {
  const { $, errors } = bootPage();
  await settle();
  assert.ok(visible($('empty-view')));
  assert.deepEqual(errors, []);
});

test('no DB: claude.use rejecting is the same as null', async () => {
  const { $, errors } = bootPage({ claude: { use: async () => { throw new Error('bridge gone'); } } });
  await settle();
  assert.ok(visible($('empty-view')));
  assert.ok($('empty-hint-error').hidden);
  assert.deepEqual(errors, []);
});

test('live mode: a terminal subscription error (revoked) before the first data shows the live message, not a static hint', async () => {
  const store = stubDb({}, { failOn: { projects: 'revoked' } });
  const claude = stubClaude({ db: store.db, user: stubUser() });
  const { $, errors } = bootPage({ claude });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(!visible($('loading-view')));
  assert.ok(!visible($('empty-view')), 'not "No data yet" or "run /rampart dashboard again"');
  assert.ok(visible($('unavailable-view')));
  assert.doesNotMatch($('unavailable-view').textContent, /rampart dashboard/);
  assert.match($('mode-badge').textContent, /^Live · updates stopped/);
});

test('live mode: a terminal subscription error after the data keeps the view and marks the badge as stale', async () => {
  const { document, store, $ } = await bootLive();
  const app = tile(document, 'example-app');
  store.fail('findings', 'revoked');
  await settle();
  assert.ok(visible($('tiles-view')));
  same(tile(document, 'example-app'), app);
  assert.match($('mode-badge').textContent, /^Live · updates stopped/);
  assert.doesNotMatch($('mode-badge').textContent, /executor online/, 'an executor state it can no longer see is not claimed');
});

// ---- who may write (R6) and the owner record (R8) -------------------------------------------

test('access: a viewer who is not the owner is read-only; the owner is read-write unless can("data.write") is false', async () => {
  const cases = [
    [stubUser({ owner: false, can: true }), 'read'],
    [stubUser({ owner: false, can: null }), 'read'],
    [stubUser({ owner: true, can: false }), 'read'],
    [null, 'read'],
    [stubUser({ owner: true, can: true }), 'write'],
    [stubUser({ owner: true, can: null }), 'write'],
  ];
  for (const [user, expected] of cases) {
    const { $, api, document } = await bootLive({ user, hash: '#p-example-app~status.all' });
    assert.equal($('main').getAttribute('data-access'), expected, JSON.stringify(user && { owner: user.isOwner.toString() }));
    assert.equal(api.canWrite(), expected === 'write');
    const controls = document.querySelectorAll('[data-write]').length;
    if (expected === 'write') assert.ok(controls > 0, 'the owner sees the write controls');
    else assert.equal(controls, 0, 'no write control for a read-only viewer');
  }
});

test('access: a non-owner sees no write controls and the page writes nothing', async () => {
  const { document, store } = await bootLive({ user: stubUser({ owner: false, can: true }), hash: '#p-example-app' });
  assert.equal(document.querySelectorAll('[data-write]').length, 0, 'no write control is rendered');
  assert.deepEqual(store.writes, []);
});

test('owner record: the owner opening a DB with no meta/owner writes it exactly once, with their id', async () => {
  const before = Date.now();
  const { store } = await bootLive({ user: stubUser({ owner: true, can: true }) });
  const seed = fixtureDocs();
  store.push('projects', 'example-app', seed.projects['example-app']);
  store.push('meta', 'sync', seed.meta.sync);
  await settle();
  assert.equal(store.writes.length, 1);
  const [write] = store.writes;
  assert.equal(write.op, 'set');
  assert.equal(write.path, 'meta/owner');
  assert.deepEqual(Object.keys(write.data).sort(), ['at', 'ownerId']);
  assert.equal(write.data.ownerId, OWNER_ID);
  assert.ok(Date.parse(write.data.at) >= before - 1000);
});

test('owner record: nothing is written when meta/owner exists, for a non-owner, or when the owner has no id', async () => {
  const seed = withHeartbeat(fixtureDocs(), new Date().toISOString());
  seed.meta.owner = { ownerId: OWNER_ID, at: '2026-10-23T00:00:00Z' };
  for (const [s, user] of [
    [seed, stubUser({ owner: true, can: true })],
    [fixtureDocs(), stubUser({ owner: false, can: true })],
    [fixtureDocs(), stubUser({ owner: true, can: true, id: null })],
    [fixtureDocs(), null],
  ]) {
    const { store } = await bootLive({ seed: s, user });
    assert.deepEqual(store.writes, []);
  }
});

// ---- fix round 1 ------------------------------------------------------------------------------

test('patching: a row that leaves the default filter does not take the focus from a row below it', async () => {
  const { document, store } = await bootLive({ hash: '#p-example-app' });
  const rowA = document.querySelector('tr[data-key="a3f9c21be0d4"]');
  const rowB = document.querySelector('tr[data-key="b71e04c9d2a8"]');
  const body = rowA.parentNode;
  assert.deepEqual(body.children.map((r) => r.getAttribute('data-key')), ['a3f9c21be0d4', 'b71e04c9d2a8'], 'A (high) above B (medium)');
  const summary = rowB.querySelector('summary');
  summary.focus();
  const seed = fixtureDocs();
  store.push('findings', 'a3f9c21be0d4', { ...seed.findings.a3f9c21be0d4, status: 'fixed' });
  await settle();
  same(document.querySelector('tr[data-key="a3f9c21be0d4"]'), null, 'A left the open-and-regressed filter');
  same(document.querySelector('tr[data-key="b71e04c9d2a8"]'), rowB, 'B is the same node');
  same(document.activeElement, summary, 'and keeps the focus');
});

test('patching: keyed [A, B, C] to [B, C] with the focus in C moves nothing and keeps the focus', async () => {
  const seed = withHeartbeat(fixtureDocs(), new Date().toISOString());
  seed.projects['example-aaa'] = { slug: 'example-aaa', name: 'Example AAA', systems: [], score: { score: 10, grade: 'F', systems: {} } };
  const { document, store } = await bootLive({ seed });
  const carousel = document.getElementById('carousel');
  assert.deepEqual(carousel.children.map((li) => li.getAttribute('data-key')), ['example-aaa', 'example-app', 'example-site']);
  const link = tile(document, 'example-site').querySelector('.card-link');
  link.focus();
  store.remove('projects', 'example-aaa');
  await settle();
  assert.deepEqual(carousel.children.map((li) => li.getAttribute('data-key')), ['example-app', 'example-site']);
  same(document.activeElement, link);
});

test('user errors: a user capability whose isOwner() rejects leaves the live view showing, read-only', async () => {
  // It rejects after the data has arrived and the tiles are showing.
  const user = Object.freeze({
    isOwner: () => new Promise((resolve, reject) => setTimeout(() => reject(new Error('bridge gone')), 30)),
    can: async () => true,
    id: async () => OWNER_ID,
  });
  const { $, store, errors } = await bootLive({ user });
  assert.ok(visible($('tiles-view')));
  await new Promise((resolve) => setTimeout(resolve, 60));
  await settle();
  assert.ok(visible($('tiles-view')));
  assert.ok(!visible($('empty-view')));
  assert.equal($('main').getAttribute('data-access'), 'read');
  assert.deepEqual(store.writes, []);
  assert.deepEqual(errors, []);
});

test('user errors: can() or id() rejecting is read-only or no owner record, never a blank page', async () => {
  const canFails = Object.freeze({ isOwner: async () => true, can: async () => { throw new Error('x'); }, id: async () => OWNER_ID });
  const idFails = Object.freeze({ isOwner: async () => true, can: async () => true, id: async () => { throw new Error('x'); } });
  let page = await bootLive({ user: canFails });
  assert.ok(visible(page.$('tiles-view')));
  assert.equal(page.$('main').getAttribute('data-access'), 'read');
  assert.deepEqual(page.errors, [], 'never routed into the render-failure path');
  page = await bootLive({ user: idFails });
  assert.ok(visible(page.$('tiles-view')));
  assert.deepEqual(page.store.writes, []);
  assert.deepEqual(page.errors, []);
});

test('answers: the db resolved but one collection not yet delivered is still loading; its delivery draws the page', async () => {
  const { $, store } = await bootLive({ options: { pending: ['runs'] } });
  assert.ok(visible($('loading-view')));
  assert.ok(!visible($('empty-view')));
  store.release('runs');
  await settle();
  assert.ok(visible($('tiles-view')));
});

test('answers: an empty fromCache first snapshot is not an answer; the definitive one is', async () => {
  const { $, store, document } = await bootLive({ options: { cachedFirst: { projects: 'empty' } } });
  assert.ok(visible($('loading-view')), 'an empty cached page could be a cold cache, not an empty store');
  assert.ok(!visible($('empty-view')));
  store.release('projects');
  await settle();
  assert.ok(visible($('tiles-view')));
  assert.ok(tile(document, 'example-app'));
});

test('answers: a non-empty fromCache snapshot counts as an answer', async () => {
  const { $, document } = await bootLive({ options: { cachedFirst: { projects: 'full' } } });
  assert.ok(visible($('tiles-view')));
  assert.ok(tile(document, 'example-app'));
});

test('answers: when a collection never gives a definitive answer the page stops waiting after the timeout', async () => {
  const { $, fireDeferred } = await bootLive({ options: { cachedFirst: { projects: 'empty' } } });
  assert.ok(visible($('loading-view')));
  fireDeferred();
  await settle();
  assert.ok(!visible($('loading-view')), 'the view never hangs on loading');
  assert.ok(visible($('empty-view')));
});

// Every text and attribute value in the document.
function allText(node) {
  if (node.nodeType === 3) return node.nodeValue;
  return [...node.attributes.map((a) => a.value), ...node.childNodes.map(allText)].join('\n');
}

test('people: a decision\'s author shows as Rampart, owner or a viewer, never as a raw user id', async () => {
  const seed = withHeartbeat(fixtureDocs(), new Date().toISOString());
  seed.meta.owner = { ownerId: '<owner-user-id>', at: '2026-10-23T00:00:00Z' };
  const by = (who) => ({ status: 'accepted_risk', reason: 'Tracked', by: who, at: '2026-10-23T19:00:00Z' });
  seed.findings.a3f9c21be0d4 = { ...seed.findings.a3f9c21be0d4, status: 'accepted_risk', disposition: by('u_someone_else') };
  seed.findings.b71e04c9d2a8 = { ...seed.findings.b71e04c9d2a8, status: 'fixed', disposition: { ...by('rampart'), status: 'fixed' } };
  let page = await bootLive({ seed, hash: '#p-example-app~status.all' });
  const details = (id) => page.document.querySelector(`tr[data-key="${id}"]`).querySelector('.finding-details').textContent;
  assert.match(details('a3f9c21be0d4'), /Accepted risk: Tracked \(a viewer, /);
  assert.match(details('b71e04c9d2a8'), /Fixed: Tracked \(Rampart, /);
  assert.ok(!allText(page.document.documentElement).includes('u_someone_else'));
  page = await bootLive({ seed, hash: '#p-example-site~status.all' });
  assert.match(page.document.querySelector('tr[data-key="c0ffee123456"]').querySelector('.finding-details').textContent,
    /Accepted risk: Static brochure site, no scripts \(owner, /);
  assert.ok(!allText(page.document.documentElement).includes('<owner-user-id>'));
});

// ---- dispositions (Task 4) ---------------------------------------------------------------------

const ownerUser = () => stubUser({ owner: true, can: true });
const formFor = (doc, id) => doc.querySelector(`form[data-finding="${id}"]`);
const rowFor = (doc, id) => doc.querySelector(`tr[data-key="${id}"]`);
const decisionWrites = (store) => store.writes.filter((w) => w.path.startsWith('findings/'));

// Pick a status (and type a reason) in a finding's decision form, as a viewer would, then save it.
async function decide(doc, id, status, reason) {
  const form = formFor(doc, id);
  const select = form.querySelector('select');
  select.value = status;
  select.dispatchEvent(makeEvent('change'));
  if (reason !== undefined) {
    const input = form.querySelector('input');
    input.value = reason;
    input.dispatchEvent(makeEvent('input'));
  }
  form.dispatchEvent(makeEvent('submit'));
  await settle();
  return form;
}

test('dispositions: the owner gets a labelled status select and reason input on each finding', async () => {
  const { document } = await bootLive({ user: ownerUser(), hash: '#p-example-app~status.all' });
  for (const id of ['a3f9c21be0d4', 'b71e04c9d2a8']) {
    const form = formFor(document, id);
    assert.ok(form, `a decision form for ${id}`);
    assert.ok(form.hasAttribute('data-write'));
    const select = form.querySelector('select');
    const input = form.querySelector('input');
    assert.ok(select.hasAttribute('data-write') && input.hasAttribute('data-write'));
    assert.ok(form.querySelector('button').hasAttribute('data-write'));
    assert.deepEqual(select.querySelectorAll('option').map((o) => o.value), ['open', 'fixed', 'false_positive', 'accepted_risk']);
    assert.equal(select.value, 'open', 'the current status is selected');
    for (const control of [select, input]) {
      const label = document.querySelector(`label[for="${control.id}"]`);
      assert.ok(label && label.textContent.trim(), `${control.tagName} has a visible label`);
    }
  }
});

test('dispositions: a change writes exactly {status, disposition: {status, reason, by, at}, updatedAt} with one stamp', async () => {
  const before = Date.now();
  const { document, store, $ } = await bootLive({ user: ownerUser(), hash: '#p-example-app~status.all' });
  await decide(document, 'b71e04c9d2a8', 'false_positive', '  Not reachable from the app  ');
  const writes = decisionWrites(store);
  assert.equal(writes.length, 1);
  const [w] = writes;
  assert.equal(w.op, 'update');
  assert.equal(w.path, 'findings/b71e04c9d2a8');
  assert.deepEqual(Object.keys(w.data).sort(), ['disposition', 'status', 'updatedAt']);
  assert.deepEqual(Object.keys(w.data.disposition).sort(), ['at', 'by', 'reason', 'status']);
  assert.equal(w.data.status, 'false_positive');
  assert.equal(w.data.disposition.status, 'false_positive');
  assert.equal(w.data.disposition.reason, 'Not reachable from the app', 'the reason is trimmed');
  assert.equal(w.data.disposition.by, OWNER_ID, 'by is the user id');
  assert.equal(w.data.disposition.at, w.data.updatedAt, 'one ISO stamp');
  assert.equal(new Date(w.data.updatedAt).toISOString(), w.data.updatedAt);
  assert.ok(Date.parse(w.data.updatedAt) >= before - 1000);
  const row = rowFor(document, 'b71e04c9d2a8');
  assert.equal(row.querySelector('.status').textContent, 'False positive');
  assert.match(row.querySelector('.finding-details').textContent, /False positive: Not reachable from the app \(owner, /);
  assert.ok(!allText(document.documentElement).includes(OWNER_ID), 'the user id is never shown');
  assert.match($('toast').textContent, /b71e04c9d2a8/);
  const select = formFor(document, 'b71e04c9d2a8').querySelector('select');
  assert.equal(select.disabled, false, 'enabled again once the write settled');
});

test('dispositions: false positive and accepted risk need a reason; open and fixed store an empty one', async () => {
  const { document, store } = await bootLive({ user: ownerUser(), hash: '#p-example-app~status.all' });
  for (const status of ['accepted_risk', 'false_positive']) {
    const form = await decide(document, 'a3f9c21be0d4', status, '   ');
    assert.equal(decisionWrites(store).length, 0, `${status} without a reason writes nothing`);
    const error = form.querySelector('.decide-error');
    assert.ok(!error.hidden && error.textContent.trim(), 'an inline message says why');
    assert.equal(form.querySelector('input').getAttribute('aria-invalid'), 'true');
  }
  await decide(document, 'a3f9c21be0d4', 'fixed', '');
  const [w] = decisionWrites(store);
  assert.equal(w.data.status, 'fixed');
  assert.equal(w.data.disposition.reason, '');
});

test('dispositions: one write in flight per finding; the control is disabled until it settles', async () => {
  const { document, store } = await bootLive({ user: ownerUser(), hash: '#p-example-app~status.all', options: { holdWrites: true } });
  await decide(document, 'a3f9c21be0d4', 'fixed');
  const form = formFor(document, 'a3f9c21be0d4');
  assert.equal(rowFor(document, 'a3f9c21be0d4').querySelector('.status').textContent, 'Fixed', 'shown at once');
  assert.ok(form.querySelector('select').disabled && form.querySelector('input').disabled && form.querySelector('button').disabled);
  form.dispatchEvent(makeEvent('submit'));
  await settle();
  assert.equal(decisionWrites(store).length, 1, 'a second save while the first is in flight writes nothing');
  store.held[0].resolve();
  await settle();
  assert.equal(form.querySelector('select').disabled, false);
  assert.equal(rowFor(document, 'a3f9c21be0d4').querySelector('.status').textContent, 'Fixed');
});

test('dispositions: a rejected write (any code) reverts the row and toasts what failed, never the raw error', async () => {
  const rejections = [
    { code: 'not_granted', message: 'RAW-not-granted' },
    { code: 'revoked', message: 'RAW-revoked' },
    { code: 'invalid_argument', message: 'RAW-invalid' },
    { code: 'unavailable', message: 'RAW-unavailable' },
    { code: 'something_new', message: 'RAW-new' },
    new Error('RAW-thrown'),
  ];
  for (const reason of rejections) {
    const { document, store, $, errors } = await bootLive({ user: ownerUser(), hash: '#p-example-app~status.all', options: { holdWrites: true } });
    await decide(document, 'b71e04c9d2a8', 'accepted_risk', 'Tracked upstream');
    assert.equal(rowFor(document, 'b71e04c9d2a8').querySelector('.status').textContent, 'Accepted risk');
    store.held[0].reject(reason);
    await settle();
    const row = rowFor(document, 'b71e04c9d2a8');
    assert.equal(row.querySelector('.status').textContent, 'Open', `reverted after ${reason.code || 'a thrown error'}`);
    assert.doesNotMatch(row.querySelector('.finding-details').textContent, /Accepted risk/);
    const form = formFor(document, 'b71e04c9d2a8');
    assert.equal(form.querySelector('select').value, 'open');
    assert.equal(form.querySelector('select').disabled, false);
    const toastText = $('toast').textContent;
    assert.match(toastText, /Could not save the decision on b71e04c9d2a8/);
    assert.doesNotMatch(toastText, /RAW-|\[object|Error/);
    assert.deepEqual(errors, []);
  }
});

test('dispositions: a form being edited keeps its choice and text through an unrelated live update', async () => {
  const { document, store } = await bootLive({ user: ownerUser(), hash: '#p-example-app~status.all' });
  const form = formFor(document, 'b71e04c9d2a8');
  const select = form.querySelector('select');
  const input = form.querySelector('input');
  select.value = 'accepted_risk';
  select.dispatchEvent(makeEvent('change'));
  input.value = 'Half typed';
  input.dispatchEvent(makeEvent('input'));
  input.focus();
  const seed = fixtureDocs();
  store.push('projects', 'example-app', { ...seed.projects['example-app'], score: { ...seed.projects['example-app'].score, score: 70 } });
  await settle();
  same(formFor(document, 'b71e04c9d2a8'), form);
  assert.equal(select.value, 'accepted_risk');
  assert.equal(input.value, 'Half typed');
  same(document.activeElement, input);
  assert.equal(decisionWrites(store).length, 0);
});

test('dispositions: no control for viewers, a signed-out page, can() false, a null user or an owner without an id', async () => {
  for (const user of [
    stubUser({ owner: false, can: true }),
    stubUser({ owner: true, can: false }),
    stubUser({ owner: true, can: true, id: null }),
    null,
  ]) {
    const { document, store } = await bootLive({ user, hash: '#p-example-app~status.all' });
    assert.equal(document.querySelectorAll('[data-write]').length, 0);
    assert.equal(document.querySelectorAll('form').length, 0);
    assert.deepEqual(decisionWrites(store), []);
  }
});

test('dispositions: static mode has no decision control, and a decision never shows a raw user id (R27)', async () => {
  const data = clone(STATIC);
  const finding = (id, status) => ({
    id, project: 'example-app', system: 'mobile', layer: 'L1', source: 'npm-audit', ruleId: `rule-${id}`, title: `Finding ${id}`,
    severity: 'LOW', confidence: 'HIGH', class: 'tool', status, firstSeen: '2026-10-22T00:00:00Z', lastSeen: '2026-10-22T00:00:00Z',
  });
  data.projects[0].findings = [finding('000000000001', 'accepted_risk'), finding('000000000002', 'fixed'), finding('000000000003', 'false_positive')];
  data.projects[0].dispositions = {
    '000000000001': { status: 'accepted_risk', reason: 'Tracked', by: 'u_page_user_placeholder', at: '2026-10-22T10:00:00Z' },
    '000000000002': { status: 'fixed', reason: '', by: 'rampart', at: '2026-10-22T10:00:00Z' },
    '000000000003': { status: 'false_positive', reason: 'Test fixture', by: 'local-name', at: '2026-10-22T10:00:00Z' },
  };
  const claude = stubClaude({ db: stubDb(fixtureDocs()).db, user: ownerUser() });
  const { document } = bootPage({ inline: JSON.stringify(data), claude, hash: '#p-example-app~status.all' });
  await settle();
  assert.equal(document.querySelectorAll('[data-write]').length, 0);
  assert.equal(document.querySelectorAll('form').length, 0);
  const details = (id) => rowFor(document, id).querySelector('.finding-details').textContent;
  assert.match(details('000000000001'), /Accepted risk: Tracked \(dashboard user, /);
  assert.match(details('000000000002'), /Fixed \(Rampart, /);
  assert.match(details('000000000003'), /False positive: Test fixture \(local-name, /);
  // The page's own inline data slot holds the raw store data; what is rendered is <main>.
  assert.ok(!allText(document.getElementById('main')).includes('u_page_user_placeholder'));
  assert.ok(document.querySelector('button.action'), 'the copy-the-command buttons are still there');
});

// ---- jobs (Task 6) -----------------------------------------------------------------------------

const jobsLib = require('../scripts/jobs.cjs');
const { validate, loadSchema } = require('../scripts/lib/validate.cjs');

const REMOTE = 'Claude Code Remote';
const JOB_ID = /^job-\d{8}-\d{6}-[0-9a-f]{4}$/;

// An mcp namespace whose callTool records each call and resolves {payload}, or rejects with `reject`.
function stubMcp({ payload = { session_id: 'session-cloud-placeholder' }, reject = null } = {}) {
  const calls = [];
  const ns = Object.freeze({
    callTool: async (server, tool, input) => {
      calls.push({ server, tool, input: clone(input) });
      if (reject) throw reject;
      return { content: [], payload };
    },
  });
  return { calls, ns };
}

// The fixture DB with a fresh heartbeat and a fresh job-0001, adjusted: example-app's cloudAllowed, the executor's
// remoteControl and heartbeat.
function jobSeed({ cloudAllowed = false, remoteControl = false, heartbeatAt = new Date().toISOString() } = {}) {
  const seed = withHeartbeat(fixtureDocs(), heartbeatAt);
  seed.projects['example-app'].cloudAllowed = cloudAllowed;
  seed.executors['session-placeholder'].remoteControl = remoteControl;
  seed.jobs['job-0001'].confirmedAt = new Date().toISOString();
  seed.jobs['job-0001'].updatedAt = seed.jobs['job-0001'].confirmedAt;
  return seed;
}

const jobWrites = (store) => store.writes.filter((w) => w.path.startsWith('jobs/'));
const jobSets = (store) => jobWrites(store).filter((w) => w.op === 'set');
const sheetOf = (doc) => doc.querySelector('[role="dialog"]');
const layerButton = (doc, system, layer) => doc.querySelector(`button[data-action="queue"][data-system="${system}"][data-layer="${layer}"]`);
const verifyButton = (doc, finding) => doc.querySelector(`button[data-action="queue"][data-finding="${finding}"]`);
const readDoc = async (store, p) => clone((await store.db.doc(p).get()).data());
const isValidJob = (job) => validate(loadSchema('job'), job);

async function press(el) {
  el.dispatchEvent(makeEvent('click'));
  await settle();
}

// Open the confirm sheet from a button and confirm it; returns the job the page set.
async function queueFrom(doc, store, button) {
  await press(button);
  assert.ok(sheetOf(doc), 'the button opens the confirm sheet');
  await press(doc.getElementById('job-sheet-confirm'));
  const sets = jobSets(store);
  return sets.length ? sets[sets.length - 1].data : null;
}

test('jobs: the page copies of PAGE_FUNCTIONS match scripts/jobs.cjs, whitespace aside (R32)', () => {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  const norm = (text) => text.replace(/\s+/g, ' ').trim();
  for (const name of jobsLib.PAGE_FUNCTIONS) {
    const marker = `function ${name}(`;
    const at = html.indexOf(marker);
    assert.ok(at !== -1, `the page has ${name}`);
    assert.equal(html.indexOf(marker, at + 1), -1, `the page has one ${name}`);
    let depth = 0;
    let end = -1;
    for (let i = html.indexOf('{', at); i < html.length; i += 1) {
      if (html[i] === '{') depth += 1;
      else if (html[i] === '}' && (depth -= 1) === 0) {
        end = i + 1;
        break;
      }
    }
    assert.equal(norm(html.slice(at, end)), norm(jobsLib[name].toString()), `${name} matches jobs.cjs`);
  }
});

test('jobs: a viewer in live mode sees the job table but no job control; layer buttons still copy the command', async () => {
  const seed = jobSeed({ cloudAllowed: true, remoteControl: true });
  seed.jobs['job-stale'] = { ...seed.jobs['job-0001'], id: 'job-stale', confirmedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
  const mcp = stubMcp();
  const { document, store } = await bootLive({ seed, user: stubUser({ owner: false, can: true }), hash: '#p-example-app~status.all', mcp: mcp.ns });
  assert.equal(document.querySelectorAll('[data-write]').length, 0);
  assert.ok(rowFor(document, 'job-0001') && rowFor(document, 'job-stale'), 'job rows are there, read-only');
  assert.equal(document.querySelectorAll('button[data-action="requeue"]').length, 0);
  assert.equal(document.querySelectorAll('button[data-action="queue"]').length, 0);
  const copy = document.querySelector('button.action');
  assert.equal(copy.getAttribute('data-command'), '/rampart audit L1 --project example-app --system mobile');
  await press(copy);
  same(sheetOf(document), null, 'no confirm sheet');
  assert.deepEqual(store.writes, []);
  assert.deepEqual(mcp.calls, []);
});

test('jobs: a layer button opens a confirm dialog with type, scope, cost and route; Escape, Cancel and a click outside never queue', async () => {
  const { document, store } = await bootLive({ seed: jobSeed(), user: ownerUser(), hash: '#p-example-app' });
  const button = layerButton(document, 'mobile', 'L1');
  assert.ok(button && button.hasAttribute('data-write'), 'the owner gets a job button tagged data-write');
  button.focus();
  await press(button);
  let sheet = sheetOf(document);
  assert.equal(sheet.getAttribute('aria-modal'), 'true');
  assert.ok(sheet.getAttribute('aria-labelledby'));
  assert.ok(sheet.contains(document.activeElement), 'focus moves into the sheet');
  const text = sheet.textContent;
  const { note } = jobsLib.costEstimate({ type: 'audit', layer: 'L1' });
  assert.match(text, /Audit L1/);
  assert.match(text, /example-app/);
  assert.match(text, /mobile/);
  assert.ok(text.includes(note), 'the cost note is shown');
  assert.match(text, /local executor machine-placeholder/, 'the local executor that would take it, by machine');
  const confirm = document.getElementById('job-sheet-confirm');
  assert.ok(confirm.hasAttribute('data-write'));
  assert.equal(confirm.disabled, false, 'enabled once the cost and route are shown');

  document.activeElement.dispatchEvent(makeEvent('keydown', { key: 'Escape' }));
  await settle();
  same(sheetOf(document), null, 'Escape closes it');
  same(document.activeElement, button, 'focus returns to the button');

  await press(button);
  await press(document.getElementById('job-sheet-cancel'));
  same(sheetOf(document), null, 'Cancel closes it');
  same(document.activeElement, button);

  await press(button);
  sheet = sheetOf(document);
  await press(sheet.parentNode);
  assert.deepEqual(jobWrites(store), [], 'a click outside the sheet queues nothing');
  assert.ok(sheetOf(document), 'and leaves the sheet open');

  // Tab stays inside; with the focus fallen to the page, Tab brings it back and Escape still closes.
  const cancel = document.getElementById('job-sheet-cancel');
  const confirmButton = document.getElementById('job-sheet-confirm');
  confirmButton.focus();
  confirmButton.dispatchEvent(makeEvent('keydown', { key: 'Tab' }));
  same(document.activeElement, cancel, 'Tab from the last control wraps to the first');
  cancel.dispatchEvent(makeEvent('keydown', { key: 'Tab', shiftKey: true }));
  same(document.activeElement, confirmButton, 'Shift+Tab from the first wraps to the last');
  document.body.focus();
  document.body.dispatchEvent(makeEvent('keydown', { key: 'Tab' }));
  assert.ok(sheetOf(document).contains(document.activeElement), 'Tab from the page goes back into the sheet');
  document.body.focus();
  document.body.dispatchEvent(makeEvent('keydown', { key: 'Escape' }));
  await settle();
  same(sheetOf(document), null, 'Escape closes it wherever the focus is');
  same(document.activeElement, button);
  assert.deepEqual(jobWrites(store), []);
});

test('jobs: confirming writes exactly the job doc, valid against the job schema', async () => {
  const before = Date.now();
  const mcp = stubMcp();
  const { document, store } = await bootLive({ seed: jobSeed(), user: ownerUser(), hash: '#p-example-app', mcp: mcp.ns });
  const job = await queueFrom(document, store, layerButton(document, 'mobile', 'L1'));
  const sets = jobSets(store);
  assert.equal(sets.length, 1);
  assert.equal(sets[0].path, `jobs/${job.id}`, 'a new doc, created with set');
  assert.deepEqual(Object.keys(job).sort(), ['confirmedAt', 'costEstimate', 'costShown', 'createdBy', 'executorKind', 'id', 'layer', 'params', 'project', 'status', 'system', 'type', 'updatedAt']);
  assert.match(job.id, JOB_ID);
  assert.equal(job.type, 'audit');
  assert.equal(job.project, 'example-app');
  assert.equal(job.system, 'mobile');
  assert.equal(job.layer, 'L1');
  assert.deepEqual(job.params, {});
  assert.equal(job.executorKind, 'local', 'example-app does not allow cloud');
  assert.equal(job.status, 'queued');
  assert.equal(job.createdBy, OWNER_ID);
  assert.equal(job.confirmedAt, job.updatedAt);
  assert.equal(new Date(job.confirmedAt).toISOString(), job.confirmedAt);
  assert.ok(Date.parse(job.confirmedAt) >= before - 1000);
  assert.deepEqual(job.costEstimate, jobsLib.costEstimate({ type: 'audit', layer: 'L1' }));
  assert.equal(job.costShown, job.costEstimate.note);
  assert.deepEqual(isValidJob(job).errors, []);
  same(sheetOf(document), null, 'the sheet closes on confirm');
  assert.ok(rowFor(document, job.id), 'the new job shows in the table');
  assert.deepEqual(mcp.calls, [], 'an executor without remote control is not nudged');
});

test('jobs: cloud runs are gated (R50): a cloud-eligible job routes local, says why, and never calls create_session', async () => {
  for (const remoteControl of [false, true]) {
    const mcp = stubMcp({ payload: {} });
    const { document, store } = await bootLive({ seed: jobSeed({ cloudAllowed: true, remoteControl }), user: ownerUser(), hash: '#p-example-app', mcp: mcp.ns });
    await press(layerButton(document, 'mobile', 'L1'));
    const sheetText = sheetOf(document).textContent;
    assert.match(sheetText, /local executor/);
    assert.match(sheetText, /cloud runs arrive in a later version/);
    assert.doesNotMatch(sheetText, /cloud session/);
    await press(document.getElementById('job-sheet-confirm'));
    const job = jobSets(store)[0].data;
    assert.equal(job.executorKind, 'local');
    assert.deepEqual(isValidJob(job).errors, []);
    assert.equal(mcp.calls.filter((c) => c.tool === 'create_session').length, 0);
    // A local job still nudges an online remote-control executor.
    assert.deepEqual(mcp.calls.map((c) => c.tool), remoteControl ? ['send_message'] : []);
    assert.deepEqual(jobWrites(store).filter((w) => w.op === 'update'), [], 'no switch to local is needed');
  }
});

test('jobs: the local route nudges an online remote-control executor with send_message, and never calls create_session', async () => {
  const mcp = stubMcp({ payload: {} });
  const { document, store } = await bootLive({ seed: jobSeed({ remoteControl: true }), user: ownerUser(), hash: '#p-example-app', mcp: mcp.ns });
  const job = await queueFrom(document, store, layerButton(document, 'mobile', 'L1'));
  assert.equal(job.executorKind, 'local');
  assert.deepEqual(mcp.calls, [{
    server: REMOTE, tool: 'send_message',
    input: { session_id: 'session-placeholder', message: `/rampart watch --claim ${job.id}` },
  }]);
  assert.doesNotMatch(rowFor(document, job.id).textContent, /start \/rampart watch/);
});

test('jobs: the local route with no executor online calls nothing and shows the queued note; a refused nudge does too', async () => {
  let mcp = stubMcp();
  let page = await bootLive({ seed: jobSeed({ remoteControl: true, heartbeatAt: '2026-01-01T00:00:00Z' }), user: ownerUser(), hash: '#p-example-app', mcp: mcp.ns });
  let button = layerButton(page.document, 'mobile', 'L1');
  await press(button);
  assert.match(sheetOf(page.document).textContent, /local executor offline/);
  await press(page.document.getElementById('job-sheet-confirm'));
  let job = jobSets(page.store)[0].data;
  assert.deepEqual(mcp.calls, [], 'no executor online: no call at all');
  assert.match(rowFor(page.document, job.id).textContent, /Queued · start \/rampart watch/);
  assert.match(page.$('toast').textContent, /\/rampart watch/);

  mcp = stubMcp({ reject: { code: 'server_unavailable', message: 'RAW', retryable: true } });
  page = await bootLive({ seed: jobSeed({ remoteControl: true }), user: ownerUser(), hash: '#p-example-app', mcp: mcp.ns });
  job = await queueFrom(page.document, page.store, layerButton(page.document, 'mobile', 'L1'));
  assert.equal(mcp.calls.length, 1);
  assert.equal(mcp.calls[0].tool, 'send_message');
  assert.match(rowFor(page.document, job.id).textContent, /Queued · start \/rampart watch/);
});

test('jobs: an infra or host-backed job on a cloud-allowed project routes local and never calls create_session (Review Focus 5)', async () => {
  const mcp = stubMcp();
  const { document, store } = await bootLive({
    seed: jobSeed({ cloudAllowed: true }), user: ownerUser(), hash: '#p-example-app~status.all', mcp: mcp.ns, engines: ['L1', 'L3', 'INFRA'],
  });
  for (const button of [layerButton(document, 'db', 'INFRA'), layerButton(document, 'db', 'L3'), verifyButton(document, 'a3f9c21be0d4')]) {
    assert.ok(button, 'a job button');
    await press(button);
    assert.match(sheetOf(document).textContent, /local executor/);
    assert.doesNotMatch(sheetOf(document).textContent, /cloud session/);
    await press(document.getElementById('job-sheet-confirm'));
  }
  const jobs = jobSets(store).map((w) => w.data);
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs.map((j) => j.executorKind), ['local', 'local', 'local']);
  assert.equal(mcp.calls.filter((c) => c.tool === 'create_session').length, 0);
  // The repo-backed system, which would have gone to the cloud, routes local too while cloud runs are gated (R50).
  const repoJob = await queueFrom(document, store, layerButton(document, 'mobile', 'L3'));
  assert.equal(repoJob.executorKind, 'local');
  assert.equal(mcp.calls.filter((c) => c.tool === 'create_session').length, 0);
  for (const job of jobSets(store).map((w) => w.data)) assert.deepEqual(isValidJob(job).errors, []);
});

test('jobs: "Verify still present" queues a verify job for the finding; fix and apply are disabled until Plan 4', async () => {
  const mcp = stubMcp();
  const { document, store } = await bootLive({ seed: jobSeed({ cloudAllowed: true }), user: ownerUser(), hash: '#p-example-app~status.all', mcp: mcp.ns });
  const row = rowFor(document, 'b71e04c9d2a8');
  const disabled = row.querySelectorAll('button').filter((b) => b.disabled && /Diagnose & fix|Apply reviewed patch/.test(b.textContent));
  assert.equal(disabled.length, 2);
  for (const b of disabled) assert.ok(b.hasAttribute('data-write'));
  assert.match(row.textContent, /arrives with the fix flow \(Plan 4\)/);
  const job = await queueFrom(document, store, verifyButton(document, 'b71e04c9d2a8'));
  assert.deepEqual(Object.keys(job).sort(), ['confirmedAt', 'costEstimate', 'costShown', 'createdBy', 'executorKind', 'findingId', 'id', 'params', 'project', 'status', 'system', 'type', 'updatedAt']);
  assert.equal(job.type, 'verify');
  assert.equal(job.findingId, 'b71e04c9d2a8');
  assert.equal(job.system, 'mobile');
  assert.equal(job.executorKind, 'local', 'cloud runs are gated (R50)');
  assert.deepEqual(job.costEstimate, jobsLib.costEstimate({ type: 'verify', openVerified: 1 }));
  assert.deepEqual(isValidJob(job).errors, []);
  assert.deepEqual(mcp.calls, [], 'no cloud session; the executor takes no remote messages');
});

test('jobs: rows show live status: claimed by the executor, running, done or failed with the summary, and a stale queued job', async () => {
  const seed = jobSeed();
  const base = seed.jobs['job-0001'];
  const now = new Date().toISOString();
  seed.jobs['job-claimed'] = { ...base, id: 'job-claimed', status: 'claimed', claimedBy: 'session-placeholder', claimedAt: now };
  seed.jobs['job-running'] = { ...base, id: 'job-running', status: 'running', claimedBy: 'session-placeholder', startedAt: now };
  seed.jobs['job-done'] = { ...base, id: 'job-done', status: 'done', resultSummary: '1 finding added', finishedAt: now };
  seed.jobs['job-failed'] = { ...base, id: 'job-failed', status: 'failed', resultSummary: 'not created by the owner', finishedAt: now };
  seed.jobs['job-stale'] = { ...base, id: 'job-stale', confirmedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
  const { document } = await bootLive({ seed, user: ownerUser(), hash: '#p-example-app' });
  const status = (id) => rowFor(document, id).textContent;
  assert.match(status('job-claimed'), /Claimed by machine-placeholder/);
  assert.match(status('job-running'), /Running/);
  assert.match(status('job-done'), /Done.*1 finding added/);
  assert.match(status('job-failed'), /Failed.*not created by the owner/);
  assert.match(status('job-stale'), /Queued · stale since \d{4}-\d{2}-\d{2}/);
  assert.match(rowFor(document, 'job-stale').className, /is-stale/);
  assert.doesNotMatch(status('job-0001'), /stale since/);
  const requeue = rowFor(document, 'job-stale').querySelector('button[data-action="requeue"]');
  assert.ok(requeue && requeue.hasAttribute('data-write'), 'the owner may requeue a stale job');
  assert.equal(document.querySelectorAll('button[data-action="requeue"]').length, 1, 'only the stale one');
});

test('jobs: requeue re-confirms the same job with a fresh cost and time; it stays queued', async () => {
  const seed = jobSeed();
  seed.jobs['job-stale'] = { ...seed.jobs['job-0001'], id: 'job-stale', confirmedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
  const before = Date.now();
  const { document, store } = await bootLive({ seed, user: ownerUser(), hash: '#p-example-app' });
  await press(rowFor(document, 'job-stale').querySelector('button[data-action="requeue"]'));
  const sheet = sheetOf(document);
  assert.match(sheet.textContent, /Requeue/);
  assert.ok(sheet.textContent.includes(jobsLib.costEstimate({ type: 'audit', layer: 'L1' }).note));
  await press(document.getElementById('job-sheet-confirm'));
  const writes = jobWrites(store);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].op, 'update');
  assert.equal(writes[0].path, 'jobs/job-stale');
  assert.deepEqual(Object.keys(writes[0].data).sort(), ['confirmedAt', 'costEstimate', 'costShown', 'executorKind', 'updatedAt']);
  assert.equal(writes[0].data.executorKind, 'local');
  assert.equal(writes[0].data.confirmedAt, writes[0].data.updatedAt);
  assert.ok(Date.parse(writes[0].data.confirmedAt) >= before - 1000);
  const stored = await readDoc(store, 'jobs/job-stale');
  assert.equal(stored.status, 'queued');
  assert.deepEqual(isValidJob(stored).errors, []);
  assert.doesNotMatch(rowFor(document, 'job-stale').textContent, /stale since/);
  assert.doesNotMatch(rowFor(document, 'job-stale').className, /is-stale/);
  same(rowFor(document, 'job-stale').querySelector('button[data-action="requeue"]'), null);
});

// ---- Task 6 fix round 1 ------------------------------------------------------------------------

test('jobs: an owner whose can("data.write") is false gets no job control at all', async () => {
  const seed = jobSeed({ cloudAllowed: true, remoteControl: true });
  seed.jobs['job-stale'] = { ...seed.jobs['job-0001'], id: 'job-stale', confirmedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
  const mcp = stubMcp();
  const { document, store } = await bootLive({ seed, user: stubUser({ owner: true, can: false }), hash: '#p-example-app~status.all', mcp: mcp.ns });
  assert.equal(document.querySelectorAll('[data-write]').length, 0);
  assert.equal(document.querySelectorAll('button[data-action="queue"]').length, 0);
  assert.equal(document.querySelectorAll('button[data-action="requeue"]').length, 0);
  assert.ok(rowFor(document, 'job-stale'), 'the job table is still there');
  await press(document.querySelector('button.action'));
  same(sheetOf(document), null);
  assert.deepEqual(jobWrites(store), [], 'no job written (the owner record, R8, is not a job)');
  assert.deepEqual(mcp.calls, []);
});

test('jobs: the sheet names the local executor by machine, from local executors only; a cloud session is not one', async () => {
  const seed = jobSeed({ remoteControl: true });
  seed.executors['session-placeholder'].kind = 'cloud';
  const mcp = stubMcp();
  const { document, store } = await bootLive({ seed, user: ownerUser(), hash: '#p-example-app', mcp: mcp.ns });
  await press(layerButton(document, 'mobile', 'L1'));
  assert.match(sheetOf(document).textContent, /local executor offline/);
  await press(document.getElementById('job-sheet-confirm'));
  const job = jobSets(store)[0].data;
  assert.deepEqual(mcp.calls, [], 'a cloud executor is never nudged for a local job');
  assert.match(rowFor(document, job.id).textContent, /Queued · start \/rampart watch/);
});

// A stale job of example-app on `system`, queued with `executorKind` long ago.
function staleSeed({ cloudAllowed, remoteControl = false, system = 'mobile', layer = 'L1', executorKind }) {
  const seed = jobSeed({ cloudAllowed, remoteControl });
  seed.jobs['job-stale'] = {
    ...seed.jobs['job-0001'], id: 'job-stale', system, layer, executorKind, confirmedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
  return seed;
}

async function requeueStale(seed, mcp, engines = null) {
  const page = await bootLive({ seed, user: ownerUser(), hash: '#p-example-app', mcp: mcp.ns, engines });
  await press(rowFor(page.document, 'job-stale').querySelector('button[data-action="requeue"]'));
  const sheetText = sheetOf(page.document).textContent;
  await press(page.document.getElementById('job-sheet-confirm'));
  const patch = jobWrites(page.store).find((w) => w.op === 'update' && 'confirmedAt' in w.data);
  return { ...page, sheetText, patch: patch && patch.data };
}

test('jobs: requeue re-routes on current data; a stale cloud job on a host-backed system or a project without cloud never reaches the cloud (R30a)', async () => {
  for (const seed of [
    staleSeed({ cloudAllowed: true, system: 'db', layer: 'L3', executorKind: 'cloud' }),
    staleSeed({ cloudAllowed: false, system: 'mobile', layer: 'L1', executorKind: 'cloud' }),
  ]) {
    const mcp = stubMcp();
    const { patch, sheetText, store } = await requeueStale(seed, mcp);
    assert.match(sheetText, /local executor/);
    assert.doesNotMatch(sheetText, /cloud session/);
    assert.equal(patch.executorKind, 'local', 'the patch carries the fresh route');
    assert.equal(mcp.calls.filter((c) => c.tool === 'create_session').length, 0);
    const stored = await readDoc(store, 'jobs/job-stale');
    assert.equal(stored.executorKind, 'local');
    assert.deepEqual(isValidJob(stored).errors, []);
  }
});

test('jobs: requeue dispatches on the fresh route: a cloud-eligible job is local now and nudges with send_message (R50)', async () => {
  for (const cloudAllowed of [true, false]) {
    const mcp = stubMcp({ payload: {} });
    const page = await requeueStale(staleSeed({ cloudAllowed, remoteControl: true, executorKind: cloudAllowed ? 'cloud' : 'local' }), mcp);
    assert.equal(page.patch.executorKind, 'local');
    assert.deepEqual(mcp.calls, [{
      server: REMOTE, tool: 'send_message', input: { session_id: 'session-placeholder', message: '/rampart watch --claim job-stale' },
    }]);
  }
});

test('jobs: at confirm a requeue re-reads the job and does nothing when it is no longer queued (R30a)', async () => {
  const seed = staleSeed({ cloudAllowed: true, executorKind: 'local' });
  const mcp = stubMcp();
  const { document, store, $ } = await bootLive({ seed, user: ownerUser(), hash: '#p-example-app', mcp: mcp.ns });
  await press(rowFor(document, 'job-stale').querySelector('button[data-action="requeue"]'));
  assert.ok(sheetOf(document));
  store.push('jobs', 'job-stale', { ...seed.jobs['job-stale'], status: 'claimed', claimedBy: 'session-placeholder', claimedAt: new Date().toISOString() });
  await settle();
  await press(document.getElementById('job-sheet-confirm'));
  assert.deepEqual(jobWrites(store), [], 'nothing written');
  assert.deepEqual(mcp.calls, [], 'nothing dispatched');
  assert.match($('toast').textContent, /job-stale/);
  assert.match($('toast').textContent, /claimed/);
});

// ---- export (Task 7) ---------------------------------------------------------------------------

const EVIDENCE_PLANT = 'EVIDENCE-PLANT-do-not-export';
const EXPLOIT_PLANT = 'EXPLOIT-PLANT-do-not-export';
const REASON_PLANT = 'REASON-PLANT-do-not-export';

// Findings in every location shape and status, each carrying planted evidence, exploit and reason text.
function sarifFindings() {
  const base = (id, over) => ({
    id, project: 'p', system: 's', layer: 'L1', source: 'manual', ruleId: `rule/${id}`, title: `Title ${id}`, severity: 'LOW',
    confidence: 'HIGH', class: 'verified', status: 'open', evidence: `${EVIDENCE_PLANT} ${id}`, exploitScenario: `${EXPLOIT_PLANT} ${id}`,
    recommendation: 'Fix it.', location: { path: 'src/a.js', line: 3 }, ...over,
  });
  return [
    base('000000000001', { severity: 'CRITICAL', location: { path: 'src/app/login.js', line: 42 }, ruleId: 'rule/shared' }),
    base('000000000002', { severity: 'HIGH', status: 'regressed', location: { url: 'https://app.example/login', header: 'csp' }, ruleId: 'rule/shared' }),
    base('000000000003', { severity: 'MEDIUM', location: { host: '192.0.2.10', service: 'ssh', setting: 'PasswordAuthentication' } }),
    base('000000000004', { severity: 'LOW', class: 'tool', location: { package: 'left-pad', ecosystem: 'npm', path: 'package-lock.json' } }),
    base('000000000005', { severity: 'INFO', class: 'hardening', location: { path: 'Dockerfile' } }),
    base('000000000006', { status: 'fixed' }),
    base('000000000007', { status: 'accepted_risk', disposition: { status: 'accepted_risk', reason: REASON_PLANT, by: 'u_x', at: '2026-10-23T00:00:00Z' } }),
    base('000000000008', { status: 'false_positive', disposition: { status: 'false_positive', reason: REASON_PLANT, by: 'u_x', at: '2026-10-23T00:00:00Z' } }),
  ];
}

test('export: toSarif is SARIF 2.1.0 with one result per open finding, one rule per ruleId, and no evidence text', () => {
  const { api } = bootPage();
  const findings = sarifFindings();
  const out = clone(api.toSarif(findings, { toolVersion: '0.3.0-alpha.1' }));
  assert.equal(out.version, '2.1.0');
  assert.equal(out.$schema, 'https://json.schemastore.org/sarif-2.1.0.json');
  assert.equal(out.runs.length, 1);
  const [run] = out.runs;
  assert.equal(run.tool.driver.name, 'Rampart');
  assert.equal(run.tool.driver.version, '0.3.0-alpha.1');
  const open = findings.filter((f) => f.status === 'open' || f.status === 'regressed');
  assert.equal(run.results.length, open.length, 'one result per open or regressed finding');
  assert.deepEqual(run.results.map((r) => r.properties.id), open.map((f) => f.id));
  const ruleIds = [...new Set(open.map((f) => f.ruleId))];
  assert.deepEqual(run.tool.driver.rules.map((r) => r.id), ruleIds, 'one rule per distinct ruleId');
  for (const r of run.results) {
    assert.equal(run.tool.driver.rules[r.ruleIndex].id, r.ruleId, 'ruleIndex points at its rule');
    const f = findings.find((x) => x.id === r.properties.id);
    assert.equal(r.message.text, f.title);
    assert.deepEqual(r.properties, { class: f.class, status: f.status, id: f.id, severity: f.severity });
    assert.deepEqual(r.partialFingerprints, { rampartId: f.id });
  }
  assert.deepEqual(run.results.map((r) => r.level), ['error', 'error', 'warning', 'note', 'note'], 'level from severity');
  const loc = (i) => run.results[i].locations[0];
  assert.deepEqual(loc(0).physicalLocation, { artifactLocation: { uri: 'src/app/login.js' }, region: { startLine: 42 } });
  assert.equal(loc(1).physicalLocation, undefined);
  assert.equal(loc(1).logicalLocations[0].kind, 'url');
  assert.equal(loc(1).logicalLocations[0].name, 'https://app.example/login');
  assert.equal(loc(2).logicalLocations[0].kind, 'host');
  assert.equal(loc(2).logicalLocations[0].name, '192.0.2.10');
  assert.equal(loc(3).logicalLocations[0].kind, 'package');
  assert.equal(loc(3).logicalLocations[0].name, 'left-pad');
  assert.deepEqual(loc(3).physicalLocation, { artifactLocation: { uri: 'package-lock.json' } }, 'the manifest it was found in');
  assert.deepEqual(loc(4).physicalLocation, { artifactLocation: { uri: 'Dockerfile' } }, 'a path without a line has no region');
  const text = JSON.stringify(out);
  for (const plant of [EVIDENCE_PLANT, EXPLOIT_PLANT, REASON_PLANT, 'Fix it.']) assert.ok(!text.includes(plant), `no ${plant} in the SARIF`);
  assert.ok(!/"evidence"|"exploitScenario"|"reason"/.test(text));
  const bare = clone(api.toSarif([]));
  assert.equal(bare.runs[0].results.length, 0);
  assert.deepEqual(bare.runs[0].tool.driver.rules, []);
  assert.equal('version' in bare.runs[0].tool.driver, false, 'no tool version unless given');
});

// A downloads namespace whose save records each request and resolves {status: 'saved'}, or rejects with `reject`.
function stubDownloads({ reject = null } = {}) {
  const saves = [];
  const ns = Object.freeze({
    save: async (req) => {
      saves.push({ filename: req.filename, data: String(req.data) });
      if (reject) throw reject;
      return { status: 'saved' };
    },
  });
  return { saves, ns };
}

const exportButton = (doc, kind) => doc.getElementById(`export-${kind}`);

test('export: a viewer who cannot write still downloads the findings as JSONL and SARIF; nothing is written', async () => {
  const downloads = stubDownloads();
  const seed = fixtureDocs();
  const { document, store, $, errors } = await bootLive({ user: stubUser({ owner: false, can: true }), hash: '#p-example-app', downloads: downloads.ns });
  assert.equal(document.querySelectorAll('[data-write]').length, 0);
  const jsonl = exportButton(document, 'jsonl');
  const sarif = exportButton(document, 'sarif');
  assert.equal(jsonl.textContent, 'Download findings (JSONL)');
  assert.equal(sarif.textContent, 'Download SARIF');
  await press(jsonl);
  assert.equal(downloads.saves.length, 1);
  assert.equal(downloads.saves[0].filename, 'example-app-findings.jsonl.txt');
  const rows = downloads.saves[0].data.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((r) => r.id).sort(), ['a3f9c21be0d4', 'b71e04c9d2a8'], 'every finding of the project, one per line');
  assert.match($('toast').textContent, /example-app-findings\.jsonl\.txt/);
  await press(sarif);
  assert.equal(downloads.saves.length, 2);
  assert.equal(downloads.saves[1].filename, 'example-app-findings.sarif.json');
  const out = JSON.parse(downloads.saves[1].data);
  assert.equal(out.version, '2.1.0');
  assert.equal(out.runs[0].results.length, 2, 'both example-app findings are open');
  for (const id of ['a3f9c21be0d4', 'b71e04c9d2a8']) assert.ok(!downloads.saves[1].data.includes(seed.findings[id].evidence), 'no evidence');
  assert.deepEqual(store.writes, []);
  assert.deepEqual(errors, []);
});

test('export: no downloads namespace hides the buttons, live or static; static mode with one exports without asking for the db', async () => {
  let page = await bootLive({ user: ownerUser(), hash: '#p-example-app' });
  same(exportButton(page.document, 'jsonl'), null);
  same(exportButton(page.document, 'sarif'), null);
  let claude = stubClaude({ db: stubDb(fixtureDocs()).db });
  page = bootPage({ inline: JSON.stringify(STATIC), claude, hash: '#p-example-app' });
  await settle();
  same(exportButton(page.document, 'jsonl'), null, 'static mode without downloads: no button');
  const downloads = stubDownloads();
  claude = stubClaude({ db: stubDb(fixtureDocs()).db, downloads: downloads.ns });
  page = bootPage({ inline: JSON.stringify(STATIC), claude, hash: '#p-example-app' });
  await settle();
  assert.ok(!claude.asked.includes('db'), 'static mode never asks for the db');
  await press(exportButton(page.document, 'sarif'));
  assert.equal(downloads.saves.length, 1);
  assert.equal(downloads.saves[0].filename, 'example-app-findings.sarif.json');
  assert.equal(JSON.parse(downloads.saves[0].data).version, '2.1.0');
});

test('export: a declined save is not an error; an unavailable save hides the buttons; nothing raw reaches the toast', async () => {
  let downloads = stubDownloads({ reject: { code: 'declined', message: 'RAW-declined' } });
  let page = await bootLive({ user: ownerUser(), hash: '#p-example-app', downloads: downloads.ns });
  await press(exportButton(page.document, 'jsonl'));
  assert.equal(downloads.saves.length, 1);
  assert.doesNotMatch(page.$('toast').textContent, /RAW-|Could not|not available/);
  assert.ok(exportButton(page.document, 'jsonl') && !exportButton(page.document, 'jsonl').disabled, 'the buttons stay, ready again');
  assert.deepEqual(page.errors, []);

  downloads = stubDownloads({ reject: { code: 'rate_limited', message: 'RAW-rate' } });
  page = await bootLive({ user: ownerUser(), hash: '#p-example-app', downloads: downloads.ns });
  await press(exportButton(page.document, 'sarif'));
  assert.match(page.$('toast').textContent, /\S/);
  assert.doesNotMatch(page.$('toast').textContent, /RAW-/);
  assert.ok(exportButton(page.document, 'sarif'), 'a busy prompt keeps the buttons');

  downloads = stubDownloads({ reject: { code: 'unavailable', message: 'RAW-unavailable' } });
  page = await bootLive({ user: ownerUser(), hash: '#p-example-app', downloads: downloads.ns });
  await press(exportButton(page.document, 'jsonl'));
  assert.match(page.$('toast').textContent, /not available/);
  assert.doesNotMatch(page.$('toast').textContent, /RAW-/);
  same(exportButton(page.document, 'jsonl'), null, 'unavailable hides the buttons');
  same(exportButton(page.document, 'sarif'), null);
});

// ---- settings (Task 7) -------------------------------------------------------------------------

const settingsForm = (doc, slug) => doc.querySelector(`form[data-settings="${slug}"]`);
const settingsWrites = (store) => store.writes.filter((w) => w.path.startsWith('projects/'));
const cadenceInput = (form, system, layer) => form.querySelector(`input[data-system="${system}"][data-layer="${layer}"]`);

async function saveSettings(form) {
  form.dispatchEvent(makeEvent('submit'));
  await settle();
}

function setField(el, value) {
  if (el.getAttribute('type') === 'checkbox') el.checked = value;
  else el.value = value;
  el.dispatchEvent(makeEvent(el.tagName === 'SELECT' || el.getAttribute('type') === 'checkbox' ? 'change' : 'input'));
}

test('settings: only the owner gets the settings form, and every control in it is tagged data-write', async () => {
  const { document } = await bootLive({ user: ownerUser(), hash: '#p-example-app' });
  const form = settingsForm(document, 'example-app');
  assert.ok(form && form.hasAttribute('data-write'));
  const controls = [...form.querySelectorAll('input'), ...form.querySelectorAll('select'), ...form.querySelectorAll('button')];
  assert.equal(controls.length, 1 + 2 + 5 + 1, 'cloud toggle, executor and effort, one cadence per declared layer, Save');
  for (const control of controls) assert.ok(control.hasAttribute('data-write'), `${control.tagName} ${control.getAttribute('name')} is data-write`);
  for (const control of [...form.querySelectorAll('input'), ...form.querySelectorAll('select')]) {
    const label = document.querySelector(`label[for="${control.id}"]`);
    assert.ok(label && label.textContent.trim(), `${control.getAttribute('name')} has a visible label`);
  }
  assert.equal(form.querySelector('input[name="cloudAllowed"]').checked, false);
  assert.equal(form.querySelector('select[name="defaultExecutor"]').value, 'local');
  assert.equal(form.querySelector('select[name="huntEffort"]').value, 'medium', 'no huntEffort reads as the medium default');
  assert.equal(cadenceInput(form, 'mobile', 'L1').value, '7');
  assert.equal(cadenceInput(form, 'db', 'INFRA').value, '30');
  for (const user of [stubUser({ owner: false, can: true }), stubUser({ owner: true, can: false }), null]) {
    const page = await bootLive({ user, hash: '#p-example-app' });
    same(settingsForm(page.document, 'example-app'), null, 'no settings for a viewer, can() false or a signed-out page');
  }
  const claude = stubClaude({ db: stubDb(fixtureDocs()).db, user: ownerUser() });
  const page = bootPage({ inline: JSON.stringify(STATIC), claude, hash: '#p-example-app' });
  await settle();
  same(settingsForm(page.document, 'example-app'), null, 'no settings in static mode');
});

test('settings: Save writes only the changed keys plus updatedAt; a cadence change writes only its own path', async () => {
  const before = Date.now();
  const { document, store, $ } = await bootLive({ user: ownerUser(), hash: '#p-example-app' });
  let form = settingsForm(document, 'example-app');
  setField(form.querySelector('select[name="huntEffort"]'), 'high');
  await saveSettings(form);
  let writes = settingsWrites(store);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].op, 'update');
  assert.equal(writes[0].path, 'projects/example-app');
  assert.deepEqual(Object.keys(writes[0].data).sort(), ['huntEffort', 'updatedAt']);
  assert.equal(writes[0].data.huntEffort, 'high');
  assert.equal(new Date(writes[0].data.updatedAt).toISOString(), writes[0].data.updatedAt);
  assert.ok(Date.parse(writes[0].data.updatedAt) >= before - 1000);
  assert.match($('toast').textContent, /Saved/);

  form = settingsForm(document, 'example-app');
  setField(cadenceInput(form, 'mobile', 'L1'), '14');
  await saveSettings(form);
  writes = settingsWrites(store);
  assert.equal(writes.length, 2);
  assert.deepEqual(Object.keys(writes[1].data).sort(), ['cadenceOverrides', 'updatedAt']);
  assert.deepEqual(writes[1].data.cadenceOverrides, { mobile: { L1: 14 } });

  form = settingsForm(document, 'example-app');
  setField(form.querySelector('input[name="cloudAllowed"]'), true);
  setField(form.querySelector('select[name="defaultExecutor"]'), 'cloud');
  setField(cadenceInput(form, 'db', 'L3'), '60');
  await saveSettings(form);
  writes = settingsWrites(store);
  assert.equal(writes.length, 3);
  assert.deepEqual(writes[2].data, { cloudAllowed: true, defaultExecutor: 'cloud', cadenceOverrides: { db: { L3: 60 } }, updatedAt: writes[2].data.updatedAt });
  const stored = await readDoc(store, 'projects/example-app');
  assert.deepEqual(stored.cadenceOverrides, { mobile: { L1: 14 }, db: { L3: 60 } }, 'the two cadence writes merged');

  form = settingsForm(document, 'example-app');
  assert.equal(cadenceInput(form, 'mobile', 'L1').value, '14', 'a pending override shows as the cadence');
  await saveSettings(form);
  assert.equal(settingsWrites(store).length, 3, 'nothing changed: nothing written');
  assert.ok(!form.querySelector('.settings-error').hidden);
});

test('settings: a cadence must be a whole number of days from 1 to 365; a bad one writes nothing and says why', async () => {
  const { document, store } = await bootLive({ user: ownerUser(), hash: '#p-example-app' });
  for (const bad of ['0', '366', '1.5', 'abc', '', '-3']) {
    const form = settingsForm(document, 'example-app');
    const input = cadenceInput(form, 'mobile', 'L2');
    setField(input, bad);
    await saveSettings(form);
    assert.equal(settingsWrites(store).length, 0, `${JSON.stringify(bad)} is refused`);
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    const error = form.querySelector('.settings-error');
    assert.ok(!error.hidden && /1 to 365/.test(error.textContent), 'an inline message says why');
  }
  const form = settingsForm(document, 'example-app');
  setField(cadenceInput(form, 'mobile', 'L2'), '365');
  await saveSettings(form);
  assert.deepEqual(settingsWrites(store)[0].data.cadenceOverrides, { mobile: { L2: 365 } });
  assert.equal(cadenceInput(settingsForm(document, 'example-app'), 'mobile', 'L2').hasAttribute('aria-invalid'), false);
});

test('settings: cloud can only be turned on for a project with a repo on github.com; the toggle says why it cannot', async () => {
  const seed = withHeartbeat(fixtureDocs(), new Date().toISOString());
  delete seed.projects['example-app'].systems[0].repo;
  const { document, store } = await bootLive({ seed, user: ownerUser(), hash: '#p-example-app' });
  const form = settingsForm(document, 'example-app');
  const toggle = form.querySelector('input[name="cloudAllowed"]');
  assert.equal(toggle.disabled, true);
  const why = document.getElementById(toggle.getAttribute('aria-describedby'));
  assert.match(why.textContent, /github\.com/);
  toggle.removeAttribute('disabled');
  setField(toggle, true);
  await saveSettings(form);
  assert.equal(settingsWrites(store).length, 0, 'forced on anyway: refused');
  assert.match(form.querySelector('.settings-error').textContent, /github\.com/);

  const allowed = withHeartbeat(fixtureDocs(), new Date().toISOString());
  delete allowed.projects['example-app'].systems[0].repo;
  allowed.projects['example-app'].cloudAllowed = true;
  const page = await bootLive({ seed: allowed, user: ownerUser(), hash: '#p-example-app' });
  const on = settingsForm(page.document, 'example-app').querySelector('input[name="cloudAllowed"]');
  assert.equal(on.disabled, false, 'a project that has cloud on can always turn it off');
  setField(on, false);
  await saveSettings(settingsForm(page.document, 'example-app'));
  assert.deepEqual(Object.keys(settingsWrites(page.store)[0].data).sort(), ['cloudAllowed', 'updatedAt']);
  assert.equal(settingsWrites(page.store)[0].data.cloudAllowed, false);
});

test('settings: cadence shows the system layer plus any pending override; a null override (consumed by a push) is none (R26)', async () => {
  const seed = withHeartbeat(fixtureDocs(), new Date().toISOString());
  seed.projects['example-app'].cadenceOverrides = { mobile: { L1: 3 } };
  const { document, store } = await bootLive({ seed, user: ownerUser(), hash: '#p-example-app' });
  let form = settingsForm(document, 'example-app');
  assert.equal(cadenceInput(form, 'mobile', 'L1').value, '3');
  assert.match(form.textContent, /applies on the next sync/i);
  assert.equal(cadenceInput(form, 'mobile', 'L2').value, '30');
  const pushed = clone(seed.projects['example-app']);
  pushed.cadenceOverrides = null;
  pushed.systems[0].layers.L1.cadenceDays = 3;
  store.push('projects', 'example-app', pushed);
  await settle();
  form = settingsForm(document, 'example-app');
  assert.equal(cadenceInput(form, 'mobile', 'L1').value, '3');
  assert.doesNotMatch(form.textContent, /applies on the next sync/i, 'no pending note once applied');
});

test('settings: a rejected write reverts the form and toasts what failed, never the raw error; one write at a time', async () => {
  const { document, store, $, errors } = await bootLive({ user: ownerUser(), hash: '#p-example-app', options: { holdWrites: true } });
  let form = settingsForm(document, 'example-app');
  setField(form.querySelector('select[name="huntEffort"]'), 'low');
  await saveSettings(form);
  form = settingsForm(document, 'example-app');
  assert.equal(form.querySelector('select[name="huntEffort"]').value, 'low', 'shown at once');
  assert.ok(form.querySelector('button').disabled, 'Save is disabled while the write is in flight');
  await saveSettings(form);
  assert.equal(settingsWrites(store).length, 1, 'a second save while the first is in flight writes nothing');
  store.held[0].reject({ code: 'not_granted', message: 'RAW-not-granted' });
  await settle();
  form = settingsForm(document, 'example-app');
  assert.equal(form.querySelector('select[name="huntEffort"]').value, 'medium', 'reverted');
  assert.equal(form.querySelector('button').disabled, false);
  const text = $('toast').textContent;
  assert.match(text, /Could not save the settings/);
  assert.doesNotMatch(text, /RAW-|\[object|Error/);
  assert.deepEqual(errors, []);
});

test('settings: a form being edited keeps its values through a live update', async () => {
  const seed = withHeartbeat(fixtureDocs(), new Date().toISOString());
  const { document, store } = await bootLive({ seed, user: ownerUser(), hash: '#p-example-app' });
  const form = settingsForm(document, 'example-app');
  const input = cadenceInput(form, 'mobile', 'L1');
  setField(input, '21');
  input.focus();
  store.push('projects', 'example-app', { ...seed.projects['example-app'], score: { ...seed.projects['example-app'].score, score: 70 } });
  await settle();
  same(settingsForm(document, 'example-app'), form);
  assert.equal(input.value, '21');
  same(document.activeElement, input);
  assert.equal(settingsWrites(store).length, 0);
});

// ---- Task 7 fix round 1 ------------------------------------------------------------------------

test('settings: Save writes only the controls the owner changed; a field changed elsewhere meanwhile is not reverted', async () => {
  const seed = withHeartbeat(fixtureDocs(), new Date().toISOString());
  const { document, store } = await bootLive({ seed, user: ownerUser(), hash: '#p-example-app' });
  const form = settingsForm(document, 'example-app');
  setField(form.querySelector('select[name="huntEffort"]'), 'high');
  // Another tab (or a sync) changes the default executor while this form is being edited.
  store.push('projects', 'example-app', { ...seed.projects['example-app'], defaultExecutor: 'cloud', updatedAt: new Date().toISOString() });
  await settle();
  same(settingsForm(document, 'example-app'), form, 'the edited form is kept');
  assert.equal(form.querySelector('select[name="defaultExecutor"]').value, 'local', 'still showing what it showed');
  await saveSettings(form);
  const writes = settingsWrites(store);
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0].data).sort(), ['huntEffort', 'updatedAt'], 'the untouched executor is not written back');
  const stored = await readDoc(store, 'projects/example-app');
  assert.equal(stored.defaultExecutor, 'cloud', 'the other change stands');
  assert.equal(stored.huntEffort, 'high');
});

test('settings: an untouched cadence outside 1 to 365 does not block saving another field', async () => {
  const seed = withHeartbeat(fixtureDocs(), new Date().toISOString());
  seed.projects['example-app'].systems[1].layers.INFRA.cadenceDays = 400;
  const { document, store } = await bootLive({ seed, user: ownerUser(), hash: '#p-example-app' });
  const form = settingsForm(document, 'example-app');
  assert.equal(cadenceInput(form, 'db', 'INFRA').value, '400');
  setField(form.querySelector('select[name="huntEffort"]'), 'low');
  await saveSettings(form);
  const writes = settingsWrites(store);
  assert.equal(writes.length, 1, 'saved');
  assert.deepEqual(Object.keys(writes[0].data).sort(), ['huntEffort', 'updatedAt']);
  assert.equal(cadenceInput(settingsForm(document, 'example-app'), 'db', 'INFRA').hasAttribute('aria-invalid'), false);
});

test('settings: a host-backed system does not make a project eligible for cloud, even with a github repo (R29)', async () => {
  const seed = withHeartbeat(fixtureDocs(), new Date().toISOString());
  delete seed.projects['example-app'].systems[0].repo;
  seed.projects['example-app'].systems[1].repo = { remote: 'github.com/<owner>/example-db', defaultBranch: 'main' };
  const { document } = await bootLive({ seed, user: ownerUser(), hash: '#p-example-app' });
  const toggle = settingsForm(document, 'example-app').querySelector('input[name="cloudAllowed"]');
  assert.equal(toggle.disabled, true, 'db has a github repo but is reached through a host');
});

test('settings: a reverted write unticks a box the owner ticked', async () => {
  const { document, store } = await bootLive({ user: ownerUser(), hash: '#p-example-app', options: { holdWrites: true } });
  const form = settingsForm(document, 'example-app');
  const box = form.querySelector('input[name="cloudAllowed"]');
  setField(box, true);
  await saveSettings(form);
  assert.equal(box.checked, true, 'shown at once');
  store.held[0].reject({ code: 'unavailable', message: 'RAW' });
  await settle();
  same(settingsForm(document, 'example-app').querySelector('input[name="cloudAllowed"]'), box, 'the same box, patched');
  assert.equal(box.checked, false, 'reverted');
});

// A downloads namespace whose save stays unanswered until the test calls answer() or refuse(err).
function heldDownloads() {
  const pending = [];
  const ns = Object.freeze({
    save: (req) => new Promise((resolve, reject) => pending.push({ req, answer: () => resolve({ status: 'saved' }), refuse: reject })),
  });
  return { pending, ns };
}

test('export: both buttons are disabled while a prompt is open; the focus returns to the pressed button after', async () => {
  const downloads = heldDownloads();
  const { document } = await bootLive({ user: ownerUser(), hash: '#p-example-app', downloads: downloads.ns });
  const jsonl = exportButton(document, 'jsonl');
  const sarif = exportButton(document, 'sarif');
  jsonl.focus();
  await press(jsonl);
  assert.equal(downloads.pending.length, 1);
  assert.ok(jsonl.disabled && sarif.disabled, 'disabled while the prompt is open');
  await press(sarif);
  assert.equal(downloads.pending.length, 1, 'no second prompt');
  document.body.focus();
  downloads.pending[0].answer();
  await settle();
  same(exportButton(document, 'jsonl'), jsonl);
  assert.ok(!jsonl.disabled && !sarif.disabled);
  same(document.activeElement, jsonl, 'focus back on the pressed button');
  sarif.focus();
  await press(sarif);
  document.body.focus();
  downloads.pending[1].refuse({ code: 'declined', message: 'RAW' });
  await settle();
  same(document.activeElement, sarif, 'after a declined prompt too');
});

test('export: extension_not_enabled stops: the buttons go and the toast invites no retry', async () => {
  const downloads = stubDownloads({ reject: { code: 'extension_not_enabled', message: 'RAW-ext' } });
  const page = await bootLive({ user: ownerUser(), hash: '#p-example-app', downloads: downloads.ns });
  await press(exportButton(page.document, 'sarif'));
  const text = page.$('toast').textContent;
  assert.match(text, /\S/);
  assert.doesNotMatch(text, /RAW-|try again|again/i);
  same(exportButton(page.document, 'sarif'), null);
  same(exportButton(page.document, 'jsonl'), null);
});
