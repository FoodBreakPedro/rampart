const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const store = require('../scripts/store.cjs');
const { runDir } = require('../scripts/lib/paths.cjs');
const { runProbes } = require('../scripts/infra-probe.cjs');

const CLI = path.join(__dirname, '..', 'scripts', 'infra-probe.cjs');
const SHIM = `node:${path.join(__dirname, 'fixtures', 'bin', 'fake-ssh.cjs')}`;
const SLUG = 'example-app';
const TARGET = '<ssh-user>@192.0.2.10';

const probe = (id, argv, extra = {}) => ({ id, title: id, via: 'ssh', argv, expect: 'x', scrub: 'none', ...extra });
const PACK = {
  name: 'docker-host', version: '1.0.0', kinds: ['host'],
  probes: [
    probe('containers', ['docker', 'ps', '--format', '{{.Names}} {{.Ports}}']),
    probe('env', ['docker', 'inspect', 'n8n'], { scrub: 'env' }),
    probe('quoted', ['echo', "it's here", 'a b']),
  ],
};
const COMMANDS = {
  containers: "'docker' 'ps' '--format' '{{.Names}} {{.Ports}}'",
  env: "'docker' 'inspect' 'n8n'",
  quoted: "'echo' 'it'\\''s here' 'a b'",
};

let home;
let probesDir;
let argvOut;
let servers;
const saved = { home: process.env.RAMPART_HOME, ssh: process.env.RAMPART_SSH };

function system(over = {}) {
  return { id: 'host', type: 'docker-host', name: 'Host', packs: ['docker-host'], host: { ssh: TARGET }, live: { url: 'http://127.0.0.1:1' }, executor: 'local', layers: { INFRA: { cadenceDays: 30 } }, ...over };
}
function writeProject(sys, extra = {}) {
  store.writeProject({
    slug: SLUG, name: 'Example App', criticality: 'high',
    ownerAttestation: { statement: 'I own every system listed here', by: '<owner>', at: '2026-10-23T00:00:00Z' },
    defaultExecutor: 'local', cloudAllowed: false, systems: [sys], created: '2026-10-23T00:00:00Z', updated: '2026-10-23T00:00:00Z', ...extra,
  });
}
// Canned remote output: files = {probeId: text}; index maps each remote command to its probe (or {probe, exit}).
function canned(files, index) {
  for (const [id, text] of Object.entries(files)) fs.writeFileSync(path.join(probesDir, `${id}.txt`), text);
  fs.writeFileSync(path.join(probesDir, 'index.json'), JSON.stringify(index));
}
const calls = () => (fs.existsSync(argvOut) ? fs.readFileSync(argvOut, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const observations = (runId) => JSON.parse(fs.readFileSync(path.join(runDir(SLUG, runId), 'observations.json'), 'utf8'));

test.beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart infra store '));
  probesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rampart infra probes '));
  argvOut = path.join(probesDir, 'argv.jsonl');
  servers = [];
  process.env.RAMPART_HOME = home;
  process.env.RAMPART_SSH = SHIM;
  process.env.FAKE_PROBES = probesDir;
  process.env.FAKE_ARGV_OUT = argvOut;
  delete process.env.FAKE_EXIT;
  delete process.env.FAKE_SLEEP_MS;
  writeProject(system());
});
test.afterEach(async () => {
  for (const s of servers) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(probesDir, { recursive: true, force: true });
  for (const [k, v] of [['RAMPART_HOME', saved.home], ['RAMPART_SSH', saved.ssh]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  for (const k of ['FAKE_PROBES', 'FAKE_ARGV_OUT', 'FAKE_EXIT', 'FAKE_SLEEP_MS']) delete process.env[k];
});

test('canned docker ps output is stored scrubbed, in raw/ and in observations.json, and the run is done', async () => {
  canned({ containers: 'web nginx:1.27 0.0.0.0:443->443/tcp\n' }, { [COMMANDS.containers]: 'containers' });
  const r = await runProbes({ project: SLUG, system: 'host', pack: PACK, probes: ['containers'] });
  assert.equal(r.run.status, 'done');
  assert.equal(r.run.job, 'audit');
  assert.deepEqual(r.run.layers, ['INFRA']);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.observations.length, 1);
  const o = r.observations[0];
  assert.deepEqual([o.probeId, o.via, o.ok, o.exitCode], ['containers', 'ssh', true, 0]);
  assert.equal(o.text, 'web nginx:1.27 0.0.0.0:443->443/tcp\n');
  assert.equal(typeof o.durationMs, 'number');
  assert.equal(o.rawPath, path.join(runDir(SLUG, r.run.runId), 'raw', 'probe-containers.txt'));
  assert.equal(fs.readFileSync(o.rawPath, 'utf8'), o.text);
  assert.deepEqual(observations(r.run.runId), { observations: r.observations, skipped: [] });
  assert.equal(r.run.counts.hardening, 0);
});

test('with no probes given, every probe of the pack runs', async () => {
  canned({ containers: 'a\n', env: 'b\n' }, { [COMMANDS.containers]: 'containers', [COMMANDS.env]: 'env', [COMMANDS.quoted]: 'containers' });
  const r = await runProbes({ project: SLUG, system: 'host', pack: PACK });
  assert.deepEqual(r.observations.map((o) => o.probeId), ['containers', 'env', 'quoted']);
});

test('scrub env: NAME=value becomes NAME=[set], NAME= stays empty, allowlisted "NAME value" lines stay, no secret reaches disk', async () => {
  canned({ env: '/n8n\nN8N_SECURE_COOKIE true\nKEY=secretvalue\nEMPTY=\nDB_PASS=hunter2hunter2\n' }, { [COMMANDS.env]: 'env' });
  const r = await runProbes({ project: SLUG, system: 'host', pack: PACK, probes: ['env'] });
  assert.equal(r.observations[0].text, '/n8n\nN8N_SECURE_COOKIE true\nKEY=[set]\nEMPTY=\nDB_PASS=[set]\n');
  for (const file of [r.observations[0].rawPath, path.join(runDir(SLUG, r.run.runId), 'observations.json')]) {
    const body = fs.readFileSync(file, 'utf8');
    assert.ok(!body.includes('secretvalue') && !body.includes('hunter2'), file);
  }
});

test('redact() runs over output of a probe whose scrub is none', async () => {
  const secret = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz012345';
  canned({ containers: `token ${secret}\n` }, { [COMMANDS.containers]: 'containers' });
  const r = await runProbes({ project: SLUG, system: 'host', pack: PACK, probes: ['containers'] });
  assert.ok(!r.observations[0].text.includes(secret));
});

test('the ssh argv is pinned: BatchMode, ConnectTimeout, target, --, one single-quoted command', async () => {
  canned({ quoted: 'ok\n' }, { [COMMANDS.quoted]: 'quoted' });
  await runProbes({ project: SLUG, system: 'host', pack: PACK, probes: ['quoted'] });
  assert.deepEqual(calls().map((c) => c.argv), [['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', TARGET, '--', COMMANDS.quoted]]);
});

test('FAKE_EXIT=255 on the first probe skips the run: "ssh could not connect", and the remaining probes are not run', async () => {
  process.env.FAKE_EXIT = '255';
  const r = await runProbes({ project: SLUG, system: 'host', pack: PACK, probes: ['containers', 'env'] });
  assert.equal(r.run.status, 'skipped');
  assert.match(r.run.reason, /ssh could not connect/);
  assert.deepEqual(r.observations, []);
  assert.equal(r.skipped.length, 2);
  assert.match(r.skipped[0].reason, /ssh could not connect/);
  assert.equal(r.skipped[1].probeId, 'env');
  assert.equal(calls().length, 1);
  assert.deepEqual(observations(r.run.runId).skipped, r.skipped);
  assert.equal(store.readRuns(SLUG)[0].status, 'skipped');
});

test('a timeout on the first probe skips the run without hanging past timeoutMs', async () => {
  process.env.FAKE_SLEEP_MS = '5000';
  const started = Date.now();
  const r = await runProbes({ project: SLUG, system: 'host', pack: PACK, probes: ['containers'], timeoutMs: 300 });
  assert.ok(Date.now() - started < 3000);
  assert.equal(r.run.status, 'skipped');
  assert.match(r.run.reason, /timed out after 300 ms/);
});

test('a probe that is not in the pack is refused with a RangeError and no run is created', async () => {
  await assert.rejects(runProbes({ project: SLUG, system: 'host', pack: PACK, probes: ['rm-rf'] }), RangeError);
  assert.deepEqual(store.readRuns(SLUG), []);
  assert.deepEqual(calls(), []);
});

test('a project without the owner attestation is refused', async () => {
  const file = path.join(home, 'projects', SLUG, 'project.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete doc.ownerAttestation;
  fs.writeFileSync(file, JSON.stringify(doc));
  await assert.rejects(runProbes({ project: SLUG, system: 'host', pack: PACK }), /ownerAttestation/);
});

test('an unknown system is a RangeError', async () => {
  await assert.rejects(runProbes({ project: SLUG, system: 'nope', pack: PACK }), RangeError);
});

test('a probe that exits non-zero by design is an observation with ok false, its text kept and scrubbed', async () => {
  canned({ env: 'Permission denied\nSECRET=abc12345\n' }, { [COMMANDS.env]: { probe: 'env', exit: 1 } });
  const r = await runProbes({ project: SLUG, system: 'host', pack: PACK, probes: ['env'] });
  assert.equal(r.run.status, 'done');
  assert.deepEqual([r.observations[0].ok, r.observations[0].exitCode], [false, 1]);
  assert.equal(r.observations[0].text, 'Permission denied\nSECRET=[set]\n');
  assert.deepEqual(r.skipped, []);
});

test('a later probe that cannot connect goes to skipped[] and the run continues and finishes done', async () => {
  canned({ containers: 'web\n', env: 'x\n' }, {
    [COMMANDS.containers]: 'containers',
    [COMMANDS.env]: { exit: 255 },
    [COMMANDS.quoted]: 'env',
  });
  const r = await runProbes({ project: SLUG, system: 'host', pack: PACK });
  assert.equal(r.run.status, 'done');
  assert.deepEqual(r.observations.map((o) => o.probeId), ['containers', 'quoted']);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].probeId, 'env');
  assert.match(r.skipped[0].reason, /ssh could not connect/);
  assert.equal(calls().length, 3);
});

test('<sitePath> is replaced whole or inside an element with host.sitePath; an invalid value falls back to public_html', async () => {
  const pack = { probes: [probe('wp', ['wp', '--path=<sitePath>', 'core', 'version']), probe('ls', ['ls', '<sitePath>'])] };
  writeProject(system({ host: { ssh: TARGET, sitePath: 'domains/example.invalid/public_html' } }));
  canned({}, {});
  await runProbes({ project: SLUG, system: 'host', pack });
  assert.deepEqual(calls().map((c) => c.argv[6]), ["'wp' '--path=domains/example.invalid/public_html' 'core' 'version'", "'ls' 'domains/example.invalid/public_html'"]);

  for (const bad of ['../etc', 'a b', 'a;rm', "x'y", '~/site', '~', '/a/../b', '$(id)']) {
    fs.rmSync(argvOut, { force: true });
    writeProject(system({ host: { ssh: TARGET, sitePath: bad } }));
    await runProbes({ project: SLUG, system: 'host', pack, probes: ['ls'] });
    assert.equal(calls()[0].argv[6], "'ls' 'public_html'", bad);
  }
  fs.rmSync(argvOut, { force: true });
  writeProject(system({ host: { ssh: TARGET } }));
  await runProbes({ project: SLUG, system: 'host', pack, probes: ['ls'] });
  assert.equal(calls()[0].argv[6], "'ls' 'public_html'");
});

test('a host.ssh that looks like an option is never passed to ssh', async () => {
  writeProject(system({ host: { ssh: '-oProxyCommand=evil' } }));
  const r = await runProbes({ project: SLUG, system: 'host', pack: PACK, probes: ['containers'] });
  assert.equal(calls().length, 0);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.run.status, 'done');
});

test('--run reuse: the given run gets the files and stays as it was; without it the runner creates and finishes its own', async () => {
  canned({ containers: 'web\n' }, { [COMMANDS.containers]: 'containers' });
  const mine = store.createRun(SLUG, { job: 'audit', layers: ['INFRA'], systems: ['host'], executor: 'local' });
  const r = await runProbes({ project: SLUG, system: 'host', pack: PACK, probes: ['containers'], runId: mine.runId });
  assert.equal(r.run.runId, mine.runId);
  assert.equal(r.run.status, 'running');
  assert.equal(store.readRuns(SLUG).length, 1);
  assert.equal(observations(mine.runId).observations.length, 1);

  const own = await runProbes({ project: SLUG, system: 'host', pack: PACK, probes: ['containers'] });
  assert.notEqual(own.run.runId, mine.runId);
  assert.equal(store.readRuns(SLUG).length, 2);
});

test('--run reuse with an unreachable first probe marks that run skipped; an unknown run is a RangeError', async () => {
  process.env.FAKE_EXIT = '255';
  const mine = store.createRun(SLUG, { job: 'audit', layers: ['INFRA'], systems: ['host'], executor: 'local' });
  const r = await runProbes({ project: SLUG, system: 'host', pack: PACK, probes: ['containers'], runId: mine.runId });
  assert.equal(r.run.status, 'skipped');
  assert.equal(store.readRuns(SLUG)[0].status, 'skipped');
  await assert.rejects(runProbes({ project: SLUG, system: 'host', pack: PACK, runId: '2020-01-01T00-00-00Z' }), RangeError);
});

function serve(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => { seen.push({ method: req.method, url: req.url }); handler(req, res); });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, seen }));
  });
}

test('http probes use the method in argv[0] against live.url plus path, and keep status and headers only', async () => {
  const site = await serve((req, res) => {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"', 'Set-Cookie': 'sid=COOKIEVALUE123456; HttpOnly' });
    res.end('BODYSECRETTEXT');
  });
  writeProject(system({ live: { url: `${site.url}/` } }));
  const pack = { probes: [probe('get', ['GET'], { via: 'http', path: '/rest/v1/' }), probe('head', ['HEAD'], { via: 'http' })] };
  const r = await runProbes({ project: SLUG, system: 'host', pack });
  assert.deepEqual(site.seen, [{ method: 'GET', url: '/rest/v1/' }, { method: 'HEAD', url: '/' }]);
  const o = r.observations[0];
  assert.deepEqual([o.via, o.ok, o.exitCode], ['http', true, 0]);
  assert.match(o.text, /^HTTP 401$/m);
  assert.match(o.text, /^www-authenticate: Basic/m);
  assert.match(o.text, /^set-cookie: sid=\[set\]; HttpOnly$/m);
  assert.ok(!o.text.includes('COOKIEVALUE') && !o.text.includes('BODYSECRETTEXT'));
  assert.equal(fs.readFileSync(o.rawPath, 'utf8'), o.text);
  assert.equal(calls().length, 0);
});

test('an http probe against a closed port skips the run; a redirect is reported, not followed', async () => {
  const pack = { probes: [probe('get', ['GET'], { via: 'http' })] };
  const r = await runProbes({ project: SLUG, system: 'host', pack });
  assert.equal(r.run.status, 'skipped');
  assert.match(r.run.reason, /http request failed/);

  const site = await serve((req, res) => { res.writeHead(301, { Location: '/elsewhere' }); res.end(); });
  writeProject(system({ live: { url: site.url } }));
  const r2 = await runProbes({ project: SLUG, system: 'host', pack });
  assert.match(r2.observations[0].text, /^HTTP 301$/m);
  assert.equal(site.seen.length, 1);
});

test('local probes run on this machine for a docker-host with no host.ssh', async () => {
  writeProject(system({ host: undefined }));
  const pack = { probes: [probe('hello', ['node', '-e', 'console.log("hi")'], { via: 'local' })] };
  const r = await runProbes({ project: SLUG, system: 'host', pack });
  assert.equal(r.observations[0].text, 'hi\n');
  assert.equal(r.observations[0].via, 'local');
  assert.equal(calls().length, 0);
});

test('local probes are refused (recorded in skipped) for a non-docker-host system or one with host.ssh', async () => {
  const pack = { probes: [probe('hello', ['node', '-e', 'console.log("hi")'], { via: 'local' }), probe('again', ['node', '-v'], { via: 'local' })] };
  for (const sys of [system({ host: undefined, type: 'supabase' }), system()]) {
    writeProject(sys);
    const r = await runProbes({ project: SLUG, system: 'host', pack });
    assert.equal(r.run.status, 'done');
    assert.deepEqual(r.observations, []);
    assert.deepEqual(r.skipped.map((s) => s.probeId), ['hello', 'again']);
    assert.match(r.skipped[0].reason, /local probes run only for a docker-host/);
  }
});

test('CLI: runs the pack probes into --run, exits 0, and prints no probe output', () => {
  writeProject(system());
  canned({ containers: 'web SECRETISH-OUTPUT\n' }, { "'docker' 'ps' '--no-trunc' '--format' '{{.ID}} {{.Names}} {{.Image}} {{.Ports}}'": 'containers' });
  const mine = store.createRun(SLUG, { job: 'audit', layers: ['INFRA'], systems: ['host'], executor: 'local' });
  const res = spawnSync(process.execPath, [CLI, '--project', SLUG, '--system', 'host', '--probe', 'containers', '--run', mine.runId, '--json'], { encoding: 'utf8', env: process.env });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.observations[0].probeId, 'containers');
  assert.ok(!res.stdout.includes('SECRETISH'));
  assert.equal(observations(mine.runId).observations[0].text, 'web SECRETISH-OUTPUT\n');
});

test('CLI: exit 2 for an unreachable host, an unknown probe, and bad arguments', () => {
  writeProject(system());
  const env = { ...process.env, FAKE_EXIT: '255' };
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
  const skipped = cli('--project', SLUG, '--system', 'host', '--probe', 'containers');
  assert.equal(skipped.status, 2);
  assert.match(skipped.stdout, /skipped/);
  assert.match(skipped.stdout, /ssh could not connect/);
  const unknown = cli('--project', SLUG, '--system', 'host', '--probe', 'nope');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /not declared/);
  assert.equal(cli('--project', SLUG).status, 2);
});

test('--run with --probe merges into the existing observations.json: the probe is replaced, the rest stay, the run is untouched', async () => {
  canned({ containers: 'web\n', env: 'x\n', again: 'fresh\n' }, { [COMMANDS.containers]: 'containers', [COMMANDS.env]: 'env', [COMMANDS.quoted]: 'quoted' });
  const mine = store.createRun(SLUG, { job: 'audit', layers: ['INFRA'], systems: ['host'], executor: 'local' });
  await runProbes({ project: SLUG, system: 'host', pack: PACK, runId: mine.runId });
  fs.writeFileSync(path.join(probesDir, 'containers.txt'), 'changed\n');
  const r = await runProbes({ project: SLUG, system: 'host', pack: PACK, probes: ['containers'], runId: mine.runId });
  assert.equal(r.run.status, 'running');
  assert.deepEqual(r.observations.map((o) => o.probeId), ['containers', 'env', 'quoted']);
  assert.equal(r.observations[0].text, 'changed\n');
  assert.deepEqual(observations(mine.runId).observations.map((o) => o.probeId), ['containers', 'env', 'quoted']);
  assert.equal(store.readRuns(SLUG)[0].status, 'running');
});

test('--run with --probe: a skipped entry of a probe that now has an observation is dropped', async () => {
  canned({ containers: 'web\n' }, { [COMMANDS.containers]: 'containers', [COMMANDS.env]: { exit: 255 } });
  const mine = store.createRun(SLUG, { job: 'audit', layers: ['INFRA'], systems: ['host'], executor: 'local' });
  const first = await runProbes({ project: SLUG, system: 'host', pack: PACK, probes: ['containers', 'env'], runId: mine.runId });
  assert.deepEqual(first.skipped.map((x) => x.probeId), ['env']);
  canned({ env: 'now\n' }, { [COMMANDS.containers]: 'containers', [COMMANDS.env]: 'env' });
  const r = await runProbes({ project: SLUG, system: 'host', pack: PACK, probes: ['env'], runId: mine.runId });
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.observations.map((o) => o.probeId), ['containers', 'env']);
});

test('--run with --probe: an unreachable extra probe goes to skipped[]; earlier observations stay and the run is not skipped', async () => {
  canned({ containers: 'web\n' }, { [COMMANDS.containers]: 'containers' });
  const mine = store.createRun(SLUG, { job: 'audit', layers: ['INFRA'], systems: ['host'], executor: 'local' });
  await runProbes({ project: SLUG, system: 'host', pack: PACK, probes: ['containers'], runId: mine.runId });
  process.env.FAKE_EXIT = '255';
  const r = await runProbes({ project: SLUG, system: 'host', pack: PACK, probes: ['env'], runId: mine.runId });
  assert.equal(r.run.status, 'running');
  assert.equal(store.readRuns(SLUG)[0].status, 'running');
  assert.deepEqual(r.observations.map((o) => o.probeId), ['containers']);
  assert.deepEqual(r.skipped.map((x) => x.probeId), ['env']);
  assert.deepEqual(observations(mine.runId).skipped, r.skipped);
});

test('the first-probe skip rule counts the first probe that tried the host: a refused probe does not count', async () => {
  const pack = { probes: [probe('refused', ['node', '-v'], { via: 'local' }), probe('real', ['docker', 'ps']), probe('later', ['docker', 'info'])] };
  process.env.FAKE_EXIT = '255';
  const r = await runProbes({ project: SLUG, system: 'host', pack });
  assert.equal(r.run.status, 'skipped');
  assert.deepEqual(r.skipped.map((x) => x.probeId), ['refused', 'real', 'later']);
  assert.equal(r.skipped[2].reason, 'not run: host unreachable');
  assert.equal(calls().length, 1);

  delete process.env.FAKE_EXIT;
  canned({ real: 'ok\n' }, { "'docker' 'ps'": 'real', "'docker' 'info'": { exit: 255 } });
  const r2 = await runProbes({ project: SLUG, system: 'host', pack });
  assert.equal(r2.run.status, 'done');
  assert.deepEqual(r2.observations.map((o) => o.probeId), ['real']);
});

test('scrub env reduces every assignment form to NAME=[set] and keeps the useful lines', async () => {
  const lines = [
    '/n8n', 'N8N_SECURE_COOKIE true', 'CRLF=secret1\r', 'export EXP=secret2', 'SPACED = secret3', 'EMPTYSP = ',
    '/etc/ssh/sshd_config:PasswordAuthentication no', '/var/lib/docker/containers/abc/hostconfig.json:KEYX=secret4',
    '"KEYQ=secret5",', '"jsonkey": "secret6",', '"tlsverify": true,', '"hosts": ["tcp://0.0.0.0:2375"]', 'YAML_KEY: secret7',
    'MULTI="line one', 'continues secret8', 'closes secret9"', 'AFTER=ok',
    '/x/hostconfig.json:"NetworkMode":"host"', 'ssh: connect failed',
  ];
  canned({ env: `${lines.join('\n')}\n` }, { [COMMANDS.env]: 'env' });
  const r = await runProbes({ project: SLUG, system: 'host', pack: PACK, probes: ['env'] });
  const text = r.observations[0].text;
  assert.deepEqual(text.split('\n'), [
    '/n8n', 'N8N_SECURE_COOKIE true', 'CRLF=[set]', 'export EXP=[set]', 'SPACED=[set]', 'EMPTYSP=',
    '/etc/ssh/sshd_config:PasswordAuthentication no', '/var/lib/docker/containers/abc/hostconfig.json:KEYX=[set]',
    'KEYQ=[set]', 'jsonkey=[set]', '"tlsverify": true,', '"hosts": ["tcp://0.0.0.0:2375"]', 'YAML_KEY=[set]',
    'MULTI=[set]', 'AFTER=[set]',
    '/x/hostconfig.json:"NetworkMode":"host"', 'ssh: connect failed', '',
  ]);
  assert.ok(!/secret\d/.test(fs.readFileSync(r.observations[0].rawPath, 'utf8')));
});

test('a cloud session (CLAUDE_CODE_REMOTE=true) is refused before any probe runs: no run created, a reused run untouched', async () => {
  canned({ containers: 'abc web nginx:1.27 0.0.0.0:80->80/tcp\n' }, { 'docker ps': 'containers' });
  const mine = store.createRun(SLUG, { job: 'audit', layers: ['INFRA'], systems: ['host'], executor: 'local' });
  const before = store.readRuns(SLUG);
  const saved = process.env.CLAUDE_CODE_REMOTE;
  process.env.CLAUDE_CODE_REMOTE = 'true';
  try {
    await assert.rejects(runProbes({ project: SLUG, system: 'host', pack: PACK }), (err) => err instanceof RangeError && /cloud/.test(err.message));
    await assert.rejects(runProbes({ project: SLUG, system: 'host', pack: PACK, probes: ['containers'], runId: mine.runId }), /cloud/);
    const res = spawnSync(process.execPath, [CLI, '--project', SLUG, '--system', 'host', '--probe', 'containers', '--run', mine.runId, '--json'], { encoding: 'utf8', env: process.env });
    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /cloud/);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_REMOTE; else process.env.CLAUDE_CODE_REMOTE = saved;
  }
  assert.deepEqual(store.readRuns(SLUG), before, 'no run created and the reused one is unchanged');
  assert.equal(calls().length, 0, 'ssh was never called');
  assert.ok(!fs.existsSync(path.join(runDir(SLUG, mine.runId), 'observations.json')));
});
