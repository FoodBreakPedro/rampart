'use strict';
const fs = require('node:fs');
const path = require('node:path');

// A small JSON Schema validator for the Rampart schemas. It is the only validation code in the project.
// Keywords: type (a name or a list of names), required, properties, enum, items, additionalProperties: false,
// oneOf, pattern, minimum, minLength. Anything else in a schema (title, description, $schema) is ignored.
// Errors are strings like `systems[0].layers.L1.cadenceDays: expected integer >= 1`; the root is `$`.
// Messages name types and constraints, never the offending value, so a bad credential cannot leak through one.

const SPECS_DIR = path.join(__dirname, '..', '..', 'skills', 'rampart', 'specs');
const SCHEMA_NAMES = ['project', 'finding', 'run', 'job', 'pack', 'coverage', 'candidate', 'vote'];

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;
const join = (parent, key) => (parent === '$' ? key : `${parent}.${key}`);

function kindOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function isType(v, type) {
  if (type === 'integer') return Number.isInteger(v);
  if (type === 'number') return typeof v === 'number' && Number.isFinite(v);
  return kindOf(v) === type;
}

const regexes = new Map();
function regex(source) {
  if (!regexes.has(source)) regexes.set(source, new RegExp(source));
  return regexes.get(source);
}

const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

function walk(schema, value, at, errors) {
  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    if (!types.some((t) => isType(value, t))) {
      errors.push(`${at}: expected ${types.join(' or ')}, got ${kindOf(value)}`);
      return; // the other keywords assume the right type
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${at}: expected one of ${schema.enum.map(show).join(', ')}`);
  }
  if (schema.oneOf) {
    const matched = schema.oneOf.filter((branch) => {
      const scratch = [];
      walk(branch, value, at, scratch);
      return scratch.length === 0;
    }).length;
    if (matched !== 1) errors.push(`${at}: matched ${matched} of ${schema.oneOf.length} oneOf branches`);
  }
  if (typeof value === 'string') {
    if (schema.pattern !== undefined && !regex(schema.pattern).test(value)) {
      errors.push(`${at}: does not match pattern ${schema.pattern}`);
    }
    if (schema.minLength !== undefined && [...value].length < schema.minLength) {
      errors.push(`${at}: expected string of at least ${schema.minLength} character${schema.minLength === 1 ? '' : 's'}`);
    }
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    const noun = typeof schema.type === 'string' ? schema.type : 'number';
    errors.push(`${at}: expected ${noun} >= ${schema.minimum}`);
  }
  if (kindOf(value) === 'array' && schema.items) {
    value.forEach((item, i) => walk(schema.items, item, `${at}[${i}]`, errors));
  }
  if (kindOf(value) === 'object') {
    const props = schema.properties || {};
    for (const key of schema.required || []) {
      if (!has(value, key)) errors.push(`${join(at, key)}: required property missing`);
    }
    for (const key of Object.keys(props)) {
      if (has(value, key)) walk(props[key], value[key], join(at, key), errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) errors.push(`${join(at, key)}: unexpected property`);
      }
    }
  }
}

// validate(schema, value) -> {ok, errors}. Bad input produces errors, never an exception.
function validate(schema, value) {
  const errors = [];
  walk(schema, value, '$', errors);
  return { ok: errors.length === 0, errors };
}

const cache = new Map();

// loadSchema('project'|'finding'|'run'|'job'|'pack'|'coverage'|'candidate'|'vote') -> parsed schema, read from the repo (not from the cwd) and cached.
function loadSchema(name) {
  if (!SCHEMA_NAMES.includes(name)) {
    throw new Error(`loadSchema: unknown schema ${JSON.stringify(name)} (expected one of ${SCHEMA_NAMES.join(', ')})`);
  }
  if (!cache.has(name)) {
    cache.set(name, JSON.parse(fs.readFileSync(path.join(SPECS_DIR, `${name}-schema.json`), 'utf8')));
  }
  return cache.get(name);
}

module.exports = { validate, loadSchema };
