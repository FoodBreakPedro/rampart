'use strict';
// Packs: versioned Markdown modules that hold hunt classes (code packs) and read-only probes (host packs). See packs/_template.md.
//   node scripts/packs.cjs list | show <name> | validate [<name>] [--json]
// A pack file is front-matter (`key: value` lines and `key:` followed by `- item` lines, nothing else) and a Markdown body with
// the H2 sections Hunt classes, Baseline, Probes (host packs) and Sources. Each class or probe is an H3, `### <id>: <title>`,
// followed by `**Label:** value` paragraphs. HTML comments are ignored. The Sources section is for readers; the data is the
// `sources` front-matter list.
//
// listPacks(dir?)            names of the packs in dir (default packs/ at the plugin root), sorted; files starting with `_`
//                            (the template) are left out, a missing dir has none.
// readPack(name, dir?)       the parsed pack. Throws when the file is missing, has no front-matter, or its `name` is not the
//                            file name. Anything else wrong (a missing field, a bad value) is left for validatePack, so a
//                            half-written pack can still be shown and checked.
// validatePack(pack)         {ok, errors: [{path, message}]}: the pack schema, plus every class field filled, unique ids, and
//                            every probe argv a non-empty array of strings. Messages never contain the offending value.
// packsFor(system, dir?)     the packs for a system: those named in system.packs, else those whose appliesTo has system.type.
// CLI exit codes: 0 ok, 1 a pack is invalid or something unexpected, 2 a bad command, bad arguments or an unknown pack.

const fs = require('node:fs');
const path = require('node:path');
const { validate, loadSchema } = require('./lib/validate.cjs');
const { redact } = require('./lib/redact.cjs');

const PACKS_DIR = path.join(__dirname, '..', 'packs');
const USAGE = 'usage: node scripts/packs.cjs list | show <name> | validate [<name>] [--json]';
const NAME_RE = /^_?[a-z0-9][a-z0-9-]*$/; // the same shape the pack schema allows for name
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

const CLASS_LABELS = {
  'look for': 'lookFor',
  'confirm by': 'confirmBy',
  'disprove by': 'disproveBy',
  'severity when confirmed': 'severity',
  cwe: 'cwe',
};
const PROBE_LABELS = { via: 'via', argv: 'argv', expect: 'expect', scrub: 'scrub', path: 'path' };

// ---- listing --------------------------------------------------------------------------------

function listPacks(dir = PACKS_DIR) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_'))
    .map((e) => e.name.slice(0, -3))
    .sort();
}

// ---- parsing --------------------------------------------------------------------------------

// Front-matter text to {key: string | string[]}. Throws on a line it does not understand.
function parseFrontMatter(text) {
  const data = {};
  let list = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(line) || /^-\s+(.*)$/.exec(line);
    if (item) {
      if (list === null) throw new SyntaxError('front-matter: a list item has no key above it');
      list.push(item[1].trim());
      continue;
    }
    const pair = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line);
    if (!pair) throw new SyntaxError('front-matter: a line is not "key: value" or "- item"');
    if (pair[2] === '') {
      list = [];
      data[pair[1]] = list;
    } else {
      list = null;
      data[pair[1]] = pair[2].trim();
    }
  }
  return data;
}

// "url | date" to {url, date}; text with no date keeps the url and leaves date undefined for the validator.
function parseSource(text) {
  const at = text.lastIndexOf('|');
  if (at === -1) return { url: text.trim(), date: undefined };
  return { url: text.slice(0, at).trim(), date: text.slice(at + 1).trim() };
}

// Lines of one H3 body to {field: text}. A `**Label:** value` line opens a field; the lines after it, up to the next label,
// continue it. Labels not in `labels` are ignored.
function parseFields(lines, labels) {
  const fields = {};
  let current = null;
  for (const line of lines) {
    const label = /^\*\*([^*]+?):\*\*\s?(.*)$/.exec(line);
    if (label) {
      current = labels[label[1].trim().toLowerCase()] || null;
      if (current) fields[current] = label[2];
    } else if (current) {
      fields[current] += `\n${line}`;
    }
  }
  for (const key of Object.keys(fields)) fields[key] = fields[key].trim();
  return fields;
}

// The H3 blocks of a section's lines: [{id, title, lines}].
function splitBlocks(lines) {
  const blocks = [];
  for (const line of lines) {
    const heading = /^###\s+(.*)$/.exec(line);
    if (heading) {
      const colon = heading[1].indexOf(':');
      const id = (colon === -1 ? heading[1] : heading[1].slice(0, colon)).trim();
      const title = colon === -1 ? '' : heading[1].slice(colon + 1).trim();
      blocks.push({ id, title, lines: [] });
    } else if (blocks.length > 0) {
      blocks[blocks.length - 1].lines.push(line);
    }
  }
  return blocks;
}

const stripTicks = (text) => {
  const m = /^`([\s\S]*)`$/.exec(text);
  return m ? m[1] : text;
};

function toClass({ id, title, lines }) {
  const f = parseFields(lines, CLASS_LABELS);
  const out = { id, title, lookFor: f.lookFor, confirmBy: f.confirmBy, disproveBy: f.disproveBy };
  // The paragraph starts with the level ("HIGH. Any user can ..."); only the level is kept.
  out.severity = f.severity === undefined ? undefined : (/^[A-Za-z]+/.exec(f.severity) || [''])[0].toUpperCase();
  out.cwe = f.cwe === undefined ? [] : f.cwe.split(/[\s,]+/).filter(Boolean);
  return out;
}

function toProbe({ id, title, lines }) {
  const f = parseFields(lines, PROBE_LABELS);
  const out = { id, title, via: f.via === undefined ? undefined : stripTicks(f.via) };
  if (f.argv !== undefined) {
    const text = stripTicks(f.argv);
    try {
      out.argv = JSON.parse(text);
    } catch {
      out.argv = text; // not JSON: kept as written so validatePack reports it
    }
  }
  out.expect = f.expect;
  out.scrub = f.scrub === undefined ? undefined : stripTicks(f.scrub);
  if (f.path !== undefined) out.path = stripTicks(f.path);
  return out;
}

function readPack(name, dir = PACKS_DIR) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new RangeError('pack name must be a plain file name');
  let text;
  try {
    text = fs.readFileSync(path.join(dir, `${name}.md`), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw new RangeError(`pack ${name} not found`);
    throw err;
  }
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') throw new SyntaxError(`pack ${name}: front-matter missing (the file must start with ---)`);
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) throw new SyntaxError(`pack ${name}: front-matter is not closed with ---`);
  const front = parseFrontMatter(lines.slice(1, end).join('\n'));
  if (front.name !== name) throw new RangeError(`pack ${name}: front-matter name must equal the file name`);

  const sections = {};
  let current = null;
  for (const line of lines.slice(end + 1)) {
    const h2 = /^##\s+(.*?)\s*$/.exec(line);
    if (h2 && !line.startsWith('###')) {
      current = h2[1].toLowerCase();
      sections[current] = [];
    } else if (current) {
      sections[current].push(line);
    }
  }

  return {
    name: front.name,
    version: front.version,
    appliesTo: front.appliesTo,
    kinds: front.kinds,
    sources: Array.isArray(front.sources) ? front.sources.map(parseSource) : front.sources,
    lastReviewed: front.lastReviewed,
    classes: splitBlocks(sections['hunt classes'] || []).map(toClass),
    baseline: (sections.baseline || []).join('\n').trim(),
    probes: splitBlocks(sections.probes || []).map(toProbe),
  };
}

// ---- validation -----------------------------------------------------------------------------

// lib/validate.cjs error strings (`path: message`, root `$`) to {path, message}.
function toError(text) {
  const at = text.indexOf(': ');
  return { path: text.slice(0, at), message: text.slice(at + 2) };
}

function validatePack(pack) {
  const errors = validate(loadSchema('pack'), pack).errors.map(toError);
  if (pack !== null && typeof pack === 'object') {
    const seen = new Set();
    (Array.isArray(pack.classes) ? pack.classes : []).forEach((c, i) => {
      if (c && Array.isArray(c.cwe) && c.cwe.length === 0) errors.push({ path: `classes[${i}].cwe`, message: 'expected a non-empty array' });
      if (c && typeof c.id === 'string') {
        if (seen.has(c.id)) errors.push({ path: `classes[${i}].id`, message: 'duplicate class id' });
        seen.add(c.id);
      }
    });
    const probeIds = new Set();
    (Array.isArray(pack.probes) ? pack.probes : []).forEach((p, i) => {
      if (!p || typeof p !== 'object') return;
      if (typeof p.id === 'string') {
        if (probeIds.has(p.id)) errors.push({ path: `probes[${i}].id`, message: 'duplicate probe id' });
        probeIds.add(p.id);
      }
      if (Array.isArray(p.argv) && p.argv.length === 0) errors.push({ path: `probes[${i}].argv`, message: 'expected a non-empty array' });
    });
    // A kind promises content: code packs need hunt classes, host packs need probes (a mistyped heading parses as none).
    if (Array.isArray(pack.kinds) && pack.kinds.includes('code') && Array.isArray(pack.classes) && pack.classes.length === 0) {
      errors.push({ path: 'classes', message: 'expected at least one class for a code pack' });
    }
    if (Array.isArray(pack.kinds) && pack.kinds.includes('host') && Array.isArray(pack.probes) && pack.probes.length === 0) {
      errors.push({ path: 'probes', message: 'expected at least one probe for a host pack' });
    }
    for (const key of ['appliesTo', 'kinds', 'sources']) {
      if (Array.isArray(pack[key]) && pack[key].length === 0) errors.push({ path: key, message: 'expected a non-empty array' });
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---- lookup for a system --------------------------------------------------------------------

function packsFor(system, dir = PACKS_DIR) {
  const names = listPacks(dir);
  const named = system && Array.isArray(system.packs) && system.packs.length > 0 ? system.packs : null;
  if (named) return names.filter((n) => named.includes(n)).map((n) => readPack(n, dir));
  const type = system ? system.type : undefined;
  return names.map((n) => readPack(n, dir)).filter((p) => Array.isArray(p.appliesTo) && p.appliesTo.includes(type));
}

// ---- the command line -----------------------------------------------------------------------

class UsageError extends Error {}

// One pack's validation: {name, ok, errors}. A pack that cannot be parsed is invalid, not a crash.
function check(name, dir) {
  try {
    return { name, ...validatePack(readPack(name, dir)) };
  } catch (err) {
    if (err instanceof RangeError || err instanceof SyntaxError) return { name, ok: false, errors: [{ path: '$', message: err.message }] };
    throw err;
  }
}

function runValidate(args, dir, out) {
  const json = args.includes('--json');
  const rest = args.filter((a) => a !== '--json');
  if (rest.length > 1 || rest.some((a) => a.startsWith('-'))) throw new UsageError('validate takes at most one pack name');
  const names = rest.length === 1 ? rest : listPacks(dir);
  const results = names.map((name) => check(name, dir));
  const ok = results.every((r) => r.ok);
  if (json) {
    out(`${JSON.stringify({ ok, packs: results }, null, 2)}\n`);
  } else {
    for (const r of results) {
      out(`${r.ok ? 'ok' : 'INVALID'} ${r.name}\n`);
      for (const e of r.errors) out(`  ${e.path}: ${e.message}\n`);
    }
    if (results.length === 0) out('no packs\n');
  }
  return ok ? 0 : 1;
}

// Run the command and return its exit code. `dir` exists so tests can point at a temp folder.
function main(argv, { stdout = process.stdout, stderr = process.stderr, dir = PACKS_DIR } = {}) {
  const out = (s) => stdout.write(s);
  try {
    const [command, ...args] = argv;
    if (command === 'list' && args.length === 0) {
      for (const name of listPacks(dir)) out(`${name}\n`);
      return 0;
    }
    if (command === 'show' && args.length === 1) {
      out(`${JSON.stringify(readPack(args[0], dir), null, 2)}\n`);
      return 0;
    }
    if (command === 'validate') return runValidate(args, dir, out);
    throw new UsageError(command === undefined ? 'a command is required' : `unknown command or arguments: ${command}`);
  } catch (err) {
    stderr.write(`packs: ${redact(err.message)}\n`);
    if (err instanceof UsageError) stderr.write(`${USAGE}\n`);
    return err instanceof UsageError || err instanceof RangeError ? 2 : 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { listPacks, readPack, validatePack, packsFor, main, PACKS_DIR };
