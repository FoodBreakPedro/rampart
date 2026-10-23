const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDocument } = require('./fixtures/mini-dom.cjs');

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
function stubDb(seed, { failOn = {} } = {}) {
  const docs = {};
  const subs = [];
  const writes = [];
  const meta = Object.freeze({ fromCache: false, hasPendingWrites: false });
  for (const c of Object.keys(seed)) docs[c] = new Map(Object.entries(seed[c]).map(([id, b]) => [id, deepFreeze(clone(b))]));
  const docSnap = (id, body) => Object.freeze({ id, exists: body !== undefined, data: () => body, metadata: meta });

  function snapshotFor(sub) {
    const map = docs[sub.collection] || new Map();
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
    return Object.freeze({ docs: list, size: list.length, empty: list.length === 0, docChanges: () => changes, metadata: meta });
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
      update: async (data) => {
        writes.push({ op: 'update', path: p, data: clone(data) });
        put(c, id, { ...docs[c].get(id), ...data });
        deliver(c);
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
          } else next(snapshotFor(sub));
        });
        return () => { sub.active = false; };
      },
    }),
  });
  return {
    db,
    subs,
    writes,
    push(c, id, body) { put(c, id, body); deliver(c); },
    remove(c, id) { put(c, id, undefined); deliver(c); },
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
function stubClaude({ db = null, user = null } = {}) {
  const asked = [];
  return {
    asked,
    use: async (name) => {
      asked.push(name);
      if (name === 'db') return db;
      if (name === 'user') return user;
      return null;
    },
  };
}

// The page, booted over the mini DOM: its markup after </style> (the data slot filled with `inline`), its one inline script
// run in a fresh context whose window has `claude` when given.
function bootPage({ inline = '', claude, hash = '' } = {}) {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  const scriptAt = html.indexOf('<script>');
  const markup = html.slice(html.indexOf('</style>') + '</style>'.length, scriptAt)
    .replace(/(<script id="rampart-data" type="application\/json">)(<\/script>)/, (m, open, close) => `${open}${inline}${close}`);
  const { document } = createDocument(markup);
  const script = /<script>([\s\S]*?)<\/script>/.exec(html.slice(scriptAt))[1];
  const location = { hash };
  const setHash = (url) => { location.hash = String(url).replace(/^[^#]*/, ''); };
  const intervals = [];
  const errors = [];
  const win = {
    document,
    location,
    history: { pushState: (s, t, url) => setHash(url), replaceState: (s, t, url) => setHash(url) },
    navigator: { platform: 'test' },
    console: { ...console, error: (...args) => errors.push(args), warn: (...args) => errors.push(args) },
    setTimeout,
    clearTimeout,
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
  return { api, document, window: win, intervals, errors, $: (id) => document.getElementById(id) };
}

// Let the stub's setImmediate deliveries and the page's promise chains run.
async function settle() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

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

async function bootLive({ seed = withHeartbeat(fixtureDocs(), new Date().toISOString()), user = stubUser(), hash = '' } = {}) {
  const store = stubDb(seed);
  const claude = stubClaude({ db: store.db, user });
  const page = bootPage({ claude, hash });
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
  assert.equal(tile(document, 'example-app'), before, 'same <li>');
  assert.equal(before.querySelector('.card'), card, 'same card');
  assert.equal(before.querySelector('.score-value'), value, 'same score node, text patched');
  assert.equal(before.querySelector('.grade').textContent, 'B');
  assert.match(before.querySelector('.grade').className, /grade-B/, 'class patched');
  assert.equal(tile(document, 'example-site'), other, 'the other tile is untouched');
  assert.equal(store.subs.length, COLLECTIONS.length, 'no new subscription on update');
  assert.equal($('carousel').children.length, 2);
});

test('live mode: a project doc added or removed adds or removes its tile; the rest stay', async () => {
  const { document, store } = await bootLive();
  const app = tile(document, 'example-app');
  store.push('projects', 'example-new', { slug: 'example-new', name: 'Example New', systems: [], score: { score: 50, grade: 'D', systems: {} } });
  await settle();
  assert.ok(tile(document, 'example-new'));
  assert.equal(tile(document, 'example-app'), app);
  store.remove('projects', 'example-site');
  await settle();
  assert.equal(tile(document, 'example-site'), null);
  assert.equal(tile(document, 'example-app'), app);
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
  assert.equal(document.activeElement, summary);
  const seed = fixtureDocs();
  store.push('findings', 'b71e04c9d2a8', {
    ...seed.findings.b71e04c9d2a8, status: 'false_positive',
    disposition: { status: 'false_positive', reason: 'Not reachable', by: OWNER_ID, at: '2026-10-23T19:10:00Z' },
  });
  await settle();
  assert.equal(document.activeElement, summary, 'focus stays where it was');
  assert.equal(details.open, true, 'the open details stays open');
  assert.equal(document.querySelector('tr[data-key="a3f9c21be0d4"]'), rowA, 'the untouched row is the same node');
  assert.equal(document.querySelector('tr[data-key="b71e04c9d2a8"]'), rowB, 'the changed row is patched in place');
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
  assert.equal(document.activeElement, select);
  assert.equal(select.value, 'HIGH');
  assert.equal(document.querySelector('tr[data-key="mobile"]'), sheetRow);
  assert.equal(document.querySelector('tr[data-key="job-0001"]'), jobRow);
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

test('live mode: until every collection has answered the page shows the loading state, not "No data yet"', () => {
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

test('live mode: a terminal subscription error before the first data falls back to the empty state', async () => {
  const store = stubDb({}, { failOn: { projects: 'revoked' } });
  const claude = stubClaude({ db: store.db, user: stubUser() });
  const { $, errors } = bootPage({ claude });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(!visible($('loading-view')));
  assert.ok(visible($('empty-view')));
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
    const { $, api } = await bootLive({ user });
    assert.equal($('main').getAttribute('data-access'), expected, JSON.stringify(user && { owner: user.isOwner.toString() }));
    assert.equal(api.canWrite(), expected === 'write');
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
