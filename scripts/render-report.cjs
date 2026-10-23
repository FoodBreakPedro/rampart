'use strict';
// The human report of one run (REPORT.md in the run directory), per skills/rampart/specs/report-spec.md: title, headline,
// Coverage, Findings, Skips, Score after this run.
//
//   renderReport(slug, runId, {now}?)   the Markdown; also written atomically to <run dir>/REPORT.md.
//
// What it reads: run.json and units.json of the run, the findings the run touched (verification.run === runId, or lastSeen at
// or after the run's start; same system and one of the run's layers), dispositions (findings this run closed) and scoreProject.
// What it never reads into the output: evidence, exploit scenarios, preconditions and recommendations. A finding appears as id,
// title, location and status; every string is redacted again, cut to one line and escaped so repository text cannot add a heading
// or break a table.
// CLI: node scripts/render-report.cjs --project <slug> --run <runId> [--open]   prints the path; --open also opens it with the
// OS default app (a failure to open is a warning). Exit 0 ok, 2 for a usage error or a project or run that does not resolve, 1 else.

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const store = require('./store.cjs');
const { scoreProject } = require('./score.cjs');
const { redact } = require('./lib/redact.cjs');
const { writeAtomic } = require('./lib/atomic.cjs');
const { runDir } = require('./lib/paths.cjs');
const exec = require('./lib/exec.cjs');

const TITLE_CAP = 140;
const UNIT_LIST_CAP = 30;
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

// One line of safe Markdown text: redacted, whitespace (newlines included) collapsed, capped, structure characters escaped.
function clean(value, cap = TITLE_CAP) {
  let s = redact(String(value ?? '')).replace(/\s+/g, ' ').trim();
  if (s.length > cap) s = `${s.slice(0, cap - 1).trimEnd()}...`;
  // Links, images, emphasis and autolinks are made inert: a previewer must not fetch or link anything repository text names.
  return s
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;')
    .replace(/<(?=[A-Za-z/!?])/g, '&lt;')
    .replace(/[|[\]()!*_]/g, '\\$&')
    .replace(/`/g, "'")
    .replace(/:\/\//g, ':\\/\\/')
    .replace(/\bwww\./gi, (m) => `${m[0]}${m.slice(1, 3)}\\.`)
    .replace(/^(#+|[>+-]|\d+[.)])(?=\s|$)/, '\\$1');
}

function locationOf(loc) {
  if (!loc || typeof loc !== 'object') return 'unknown location';
  if (loc.path !== undefined && loc.package === undefined) return loc.symbol ? `${loc.path}:${loc.symbol}` : String(loc.path);
  if (loc.host !== undefined) return [loc.host, loc.service, loc.setting].filter((p) => p !== undefined && p !== '').join(' ');
  if (loc.url !== undefined) return String(loc.url);
  if (loc.package !== undefined) return [loc.package, loc.path].filter(Boolean).join(' ');
  return 'unknown location';
}

const readJsonOrNull = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
};

function unitList(ids) {
  const shown = ids.slice(0, UNIT_LIST_CAP).map((id) => clean(id, 80));
  const extra = ids.length - shown.length;
  return `${shown.join(', ')}${extra > 0 ? `, and ${extra} more` : ''}`;
}

function revisionText(run) {
  const r = run.revision;
  if (!r || !r.commit) return null;
  return `${clean(String(r.commit).slice(0, 12))}${r.dirty ? ' (uncommitted changes)' : ''}`;
}

function touchedBy(run, units, findings) {
  const layers = run.layers || [];
  const system = units ? units.system : null;
  return findings.filter((f) => {
    if (!f || (system && f.system !== system)) return false;
    if (!system && !(run.systems || []).includes(f.system)) return false;
    if (layers.length && !layers.includes(f.layer)) return false;
    if (f.verification && f.verification.run === run.runId) return true;
    if (typeof f.lastSeen !== 'string' || f.lastSeen < run.startedAt) return false;
    // A finished run owns only sightings up to its end; a later run's sighting belongs to that run's report.
    return !run.finishedAt || f.lastSeen <= run.finishedAt;
  });
}

function trendText(result) {
  return result.trend === null || result.trend === undefined ? 'no trend yet' : `${result.trend > 0 ? '+' : ''}${result.trend.toFixed(1)}`;
}

function headline(project, run, units, touched, closed, result) {
  const layer = units ? units.layer : (run.layers || []).join(', ');
  const system = units ? units.system : (run.systems || []).join(', ');
  const sys = (project.systems || []).find((s) => s.id === system);
  const at = [];
  const rev = revisionText(run);
  if (rev) at.push(`revision ${rev}`);
  if (sys && sys.host && sys.host.ssh) at.push(`host ${clean(String(sys.host.ssh).replace(/^[^@]*@/, ''))}`);
  const counted = touched.filter((f) => f.class !== 'hardening');
  const hardening = touched.length - counted.length;
  const fresh = counted.filter((f) => typeof f.firstSeen === 'string' && f.firstSeen >= run.startedAt).length;
  const regressed = counted.filter((f) => f.status === 'regressed').length;
  const state = run.status === 'done' ? 'finished' : run.status;
  return [
    `${clean(run.job)} at ${clean(layer)} ran against ${clean(system || 'no system')}${at.length ? ` (${at.join('; ')})` : ''} and ${state}.`,
    `${counted.length} finding${counted.length === 1 ? '' : 's'} survived verification (${fresh} new, ${regressed} regressed) plus ${hardening} hardening note${hardening === 1 ? '' : 's'};`,
    `${closed} closed by this run.`,
    `Project score after the run: grade ${result.grade}, ${result.score.toFixed(1)}, trend ${trendText(result)}.`,
  ].join(' ');
}

function coverageSection(run, units) {
  const lines = ['## Coverage', ''];
  if (!units) {
    lines.push('No unit data was recorded for this run.');
  } else {
    const covered = (units.units || []).filter((u) => u.status === 'covered');
    lines.push(`### ${clean(units.system)} ${clean(units.layer)}`, '');
    lines.push(`- Units examined: ${covered.length}${covered.length ? ` (${unitList(covered.map((u) => u.id))})` : ''}`);
    const packs = [...new Set((units.classes || []).map((c) => `${c.pack}@${c.packVersion}`))].sort();
    lines.push(`- Packs: ${packs.length ? packs.map((p) => clean(p)).join(', ') : 'none'}`);
    const rev = revisionText(run);
    if (rev) lines.push(`- Revision: ${rev}`);
    if (run.tool && run.tool.name) lines.push(`- Tool: ${clean(run.tool.name)}${run.tool.version ? ` ${clean(run.tool.version)}` : ''}`);
  }
  return lines.join('\n');
}

function findingsSection(touched) {
  const lines = ['## Findings', ''];
  if (touched.length === 0) return `${lines.join('\n')}No findings in this run.`;
  const row = (f) => `- \`${/^[0-9a-f]{12}$/.test(f.id) ? f.id : clean(f.id, 20)}\` ${clean(f.title)} (${clean(locationOf(f.location), 200)}) [${clean(f.status)}]`;
  const byClass = (f) => f.class !== 'hardening';
  for (const sev of SEVERITIES) {
    const group = touched.filter((f) => byClass(f) && f.severity === sev);
    if (group.length) lines.push(`### ${sev}`, ...group.map(row), '');
  }
  const hard = touched.filter((f) => !byClass(f));
  if (hard.length) lines.push('### Hardening', ...hard.map(row), '');
  return lines.join('\n').trimEnd();
}

function skipsSection(run, units) {
  const items = [];
  if ((run.status === 'skipped' || run.status === 'failed') && run.reason) items.push(`Run ${run.status}: ${clean(run.reason, 300)}`);
  for (const u of (units && units.units) || []) {
    const id = clean(u.id, 80);
    if (u.status === 'failed' || u.status === 'skipped') items.push(`${id}: ${u.status}${u.reason ? `, ${clean(u.reason, 300)}` : ''}`);
    else if (u.status === 'planned') items.push(`${id}: not examined, the run ended before it was covered`);
    if (Number.isInteger(u.invalid) && u.invalid > 0) items.push(`${id}: ${u.invalid} invalid candidate(s) ignored; findings in this unit were not closed`);
  }
  return ['## Skips', '', items.length ? items.map((i) => `- ${i}`).join('\n') : 'Nothing was skipped.'].join('\n');
}

function scoreSection(result) {
  const trend = trendText(result);
  const lines = ['## Score after this run', '', `Grade ${result.grade}, score ${result.score.toFixed(1)}, trend ${trend}.`];
  const ids = Object.keys(result.systems);
  if (ids.length) {
    lines.push('', '| System | Grade | Score | Coverage | Findings | Hardening |', '| --- | --- | --- | --- | --- | --- |');
    for (const id of ids) {
      const s = result.systems[id];
      lines.push(`| ${clean(id, 60)} | ${s.grade} | ${s.score.toFixed(1)} | ${s.coverage.toFixed(1)} | ${s.findingsScore.toFixed(1)} | ${s.hardening} |`);
    }
  }
  return lines.join('\n');
}

function renderReport(slug, runId, { now = new Date() } = {}) {
  const project = store.readProject(slug);
  if (!project) throw new RangeError(`project ${slug} not found`);
  // Matching against the store's own listing applies its run-id check: an id with a path in it is never a run.
  const run = store.readRuns(slug).find((r) => r.runId === runId);
  if (!run) {
    if (typeof runId !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/.test(runId)) throw new RangeError('runId must look like 2026-10-23T18-02-11Z');
    throw new RangeError(`no run ${runId} in project ${slug}`);
  }
  const dir = runDir(slug, runId);
  const units = readJsonOrNull(path.join(dir, 'units.json'));
  const touched = touchedBy(run, units && typeof units === 'object' ? units : null, store.readFindings(slug));
  const dispositions = store.readDispositions(slug);
  const system = units ? units.system : null;
  const closedIds = Object.entries(dispositions).filter(([id, d]) => d && d.status === 'fixed' && String(d.reason || '').includes(runId)
    && (!system || (store.readFindings(slug).find((f) => f.id === id) || {}).system === system));
  const closed = closedIds.length || (run.counts && run.counts.closed) || 0;

  const layers = units ? units.layer : (run.layers || []).join(', ');
  const result = scoreProject(project, store.readFindings(slug), store.readRuns(slug), now);
  const md = [
    `# ${clean(project.name || slug, 80)}: ${clean(run.job)} ${clean(layers)}, run ${clean(runId, 40)}`,
    '',
    headline(project, run, units, touched, closed, result),
    '',
    coverageSection(run, units),
    '',
    findingsSection(touched),
    '',
    skipsSection(run, units),
    '',
    scoreSection(result),
    '',
  ].join('\n');
  writeAtomic(path.join(dir, 'REPORT.md'), md);
  return md;
}

// ---- the command line ---------------------------------------------------------------------

const USAGE = 'usage: node scripts/render-report.cjs --project <slug> --run <runId> [--open]';

class UsageError extends Error {}

function parse(argv) {
  let values;
  try {
    ({ values } = util.parseArgs({ args: argv, options: { project: { type: 'string' }, run: { type: 'string' }, open: { type: 'boolean' } }, strict: true, allowPositionals: false }));
  } catch (err) {
    throw new UsageError(err.message.split('\n')[0]);
  }
  for (const name of ['project', 'run']) if (values[name] === undefined) throw new UsageError(`--${name} is required`);
  return values;
}

// The command that opens a file with the OS default app.
function openCommand(file, platform = process.platform) {
  if (platform === 'win32') return ['explorer.exe', [file]];
  if (platform === 'darwin') return ['open', [file]];
  return ['xdg-open', [file]];
}

function main(argv, { stdout = process.stdout, stderr = process.stderr, run = exec.run, platform = process.platform } = {}) {
  try {
    const opts = parse(argv);
    renderReport(opts.project, opts.run);
    const file = path.join(runDir(opts.project, opts.run), 'REPORT.md');
    stdout.write(`${file}\n`);
    if (opts.open) {
      const [cmd, args] = openCommand(file, platform);
      let failed = false;
      try {
        const r = run(cmd, args, { timeoutMs: 15000 });
        // explorer.exe exits 1 even when it opened the file, so on Windows only a timeout or a launch error counts.
        failed = r.timedOut || (platform !== 'win32' && r.code !== 0 && r.code !== null);
      } catch {
        failed = true;
      }
      if (failed) stderr.write(`render-report: warning: could not open ${file}\n`);
    }
    return 0;
  } catch (err) {
    stderr.write(`render-report: ${redact(err.message)}\n`);
    if (err instanceof UsageError) stderr.write(`${USAGE}\n`);
    return err instanceof UsageError || err instanceof RangeError ? 2 : 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { renderReport, openCommand, main };
