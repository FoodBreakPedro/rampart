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
const COLLECTIONS = ['projects', 'findings', 'runs', 'jobs', 'executors', 'meta'];
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
// resolve() (the write lands and is delivered) or reject(reason).
function stubDb(seed, { failOn = {}, pending = [], cachedFirst = {}, holdWrites = false } = {}) {
  const docs = {};
  const subs = [];
  const writes = [];
  const held = [];
  const meta = Object.freeze({ fromCache: false, hasPendingWrites: false });
  const cachedMeta = Object.freeze({ fromCache: true, hasPendingWrites: false });
  for (const c of Object.keys(seed)) docs[c] = new Map(Object.entries(seed[c]).map(([id, b]) => [id, deepFreeze(clone(b))]));
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
          put(c, id, { ...docs[c].get(id), ...data });
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
function stubClaude({ db = null, user = null, mcp = null } = {}) {
  const asked = [];
  return {
    asked,
    use: async (name) => {
      asked.push(name);
      if (name === 'db') return db;
      if (name === 'user') return user;
      if (name === 'mcp') return mcp;
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

async function bootLive({ seed = withHeartbeat(fixtureDocs(), new Date().toISOString()), user = stubUser(), hash = '', options, mcp = null, engines = null } = {}) {
  const store = stubDb(seed, options);
  const claude = stubClaude({ db: store.db, user, mcp });
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

test('jobs: the cloud route calls create_session with the pinned prompt and stores the session id it returns', async () => {
  const variants = [
    [{ session_id: 'session-a' }, 'session-a'],
    [{ id: 'session-b' }, 'session-b'],
    [{ sessionId: 'session-c' }, 'session-c'],
    [{}, null],
    ['plain text', null],
  ];
  for (const [payload, expected] of variants) {
    const mcp = stubMcp({ payload });
    const { document, store } = await bootLive({ seed: jobSeed({ cloudAllowed: true }), user: ownerUser(), hash: '#p-example-app', mcp: mcp.ns });
    const job = await queueFrom(document, store, layerButton(document, 'mobile', 'L1'));
    assert.equal(job.executorKind, 'cloud');
    assert.equal(mcp.calls.length, 1);
    const [call] = mcp.calls;
    assert.equal(call.server, REMOTE);
    assert.equal(call.tool, 'create_session');
    assert.deepEqual(Object.keys(call.input).sort(), ['prompt', 'source_url', 'title']);
    assert.equal(call.input.prompt, `/rampart audit L1 --project example-app --system mobile --job ${job.id}`);
    assert.equal(call.input.source_url, 'https://github.com/<owner>/example-app');
    assert.ok(typeof call.input.title === 'string' && call.input.title.length > 0);
    const updates = jobWrites(store).filter((w) => w.op === 'update');
    if (expected) {
      assert.equal(updates.length, 1, JSON.stringify(payload));
      assert.equal(updates[0].path, `jobs/${job.id}`);
      assert.deepEqual(Object.keys(updates[0].data).sort(), ['sessionId', 'updatedAt']);
      assert.equal(updates[0].data.sessionId, expected);
    } else {
      assert.deepEqual(updates, [], `nothing stored for ${JSON.stringify(payload)}`);
    }
    const stored = await readDoc(store, `jobs/${job.id}`);
    assert.equal(stored.status, 'queued');
    assert.deepEqual(isValidJob(stored).errors, []);
  }
});

test('jobs: a create_session rejection (or no mcp) keeps the job queued, tries once and says to start /rampart watch', async () => {
  const cases = [
    stubMcp({ reject: { code: 'tool_error', message: 'RAW-tool', retryable: true } }),
    stubMcp({ reject: { code: 'server_not_connected', message: 'RAW-server' } }),
    null,
  ];
  for (const mcp of cases) {
    const { document, store, $, errors } = await bootLive({ seed: jobSeed({ cloudAllowed: true }), user: ownerUser(), hash: '#p-example-app', mcp: mcp && mcp.ns });
    const job = await queueFrom(document, store, layerButton(document, 'mobile', 'L1'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await settle();
    if (mcp) assert.equal(mcp.calls.length, 1, 'never retried');
    const writes = jobWrites(store);
    assert.equal(writes.length, 2, 'the job doc, then the switch to local (R33)');
    assert.equal(writes[1].op, 'update');
    assert.deepEqual(Object.keys(writes[1].data).sort(), ['executorKind', 'updatedAt']);
    assert.equal(writes[1].data.executorKind, 'local');
    const stored = await readDoc(store, `jobs/${job.id}`);
    assert.equal(stored.status, 'queued', 'it stays queued');
    assert.equal(stored.executorKind, 'local', 'so a local watch can run it');
    assert.deepEqual(isValidJob(stored).errors, []);
    assert.doesNotMatch($('toast').textContent, /may have started/, 'a definite refusal is not ambiguous');
    assert.match(rowFor(document, job.id).textContent, /Queued · start \/rampart watch/);
    assert.match($('toast').textContent, /\/rampart watch/);
    assert.doesNotMatch($('toast').textContent, /RAW-|\[object/);
    assert.deepEqual(errors, []);
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
  // The same page does reach the cloud for the repo-backed system, so the check above is not vacuous.
  await queueFrom(document, store, layerButton(document, 'mobile', 'L3'));
  assert.equal(mcp.calls.filter((c) => c.tool === 'create_session').length, 1);
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
  assert.equal(job.executorKind, 'cloud');
  assert.deepEqual(job.costEstimate, jobsLib.costEstimate({ type: 'verify', openVerified: 1 }));
  assert.deepEqual(isValidJob(job).errors, []);
  assert.equal(mcp.calls[0].input.prompt, `/rampart verify --project example-app --finding b71e04c9d2a8 --job ${job.id}`);
  assert.equal(mcp.calls[0].input.source_url, 'https://github.com/<owner>/example-app');
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

test('jobs: an ambiguous create_session failure switches the job to local and says a cloud session may have started (R33)', async () => {
  for (const code of ['server_unavailable', 'upstream_error']) {
    const mcp = stubMcp({ reject: { code, message: 'RAW', retryable: true } });
    const { document, store, $ } = await bootLive({ seed: jobSeed({ cloudAllowed: true }), user: ownerUser(), hash: '#p-example-app', mcp: mcp.ns });
    const job = await queueFrom(document, store, layerButton(document, 'mobile', 'L1'));
    await settle();
    assert.equal(mcp.calls.length, 1, 'never retried');
    const stored = await readDoc(store, `jobs/${job.id}`);
    assert.equal(stored.executorKind, 'local');
    assert.equal(stored.status, 'queued');
    assert.match($('toast').textContent, /may have started/);
    assert.match($('toast').textContent, /\/rampart watch/);
    assert.doesNotMatch($('toast').textContent, /RAW/);
  }
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

test('jobs: requeue dispatches on the fresh route: create_session when it is now cloud, send_message when local', async () => {
  let mcp = stubMcp({ payload: { session_id: 'session-r' } });
  let page = await requeueStale(staleSeed({ cloudAllowed: true, executorKind: 'local' }), mcp);
  assert.equal(page.patch.executorKind, 'cloud');
  assert.deepEqual(mcp.calls.map((c) => c.tool), ['create_session']);
  assert.equal(mcp.calls[0].input.prompt, '/rampart audit L1 --project example-app --system mobile --job job-stale');
  assert.equal((await readDoc(page.store, 'jobs/job-stale')).sessionId, 'session-r');

  mcp = stubMcp({ payload: {} });
  page = await requeueStale(staleSeed({ cloudAllowed: false, remoteControl: true, executorKind: 'local' }), mcp);
  assert.equal(page.patch.executorKind, 'local');
  assert.deepEqual(mcp.calls, [{
    server: REMOTE, tool: 'send_message', input: { session_id: 'session-placeholder', message: '/rampart watch --claim job-stale' },
  }]);
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
