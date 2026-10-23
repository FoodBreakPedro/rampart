'use strict';
// A minimal DOM for running dashboard/index.html's script under node:test. The project has no npm dependencies, so there
// is no jsdom: this implements only what the page uses (building nodes, attributes, hidden/open, a few simple selectors,
// focus, events) and parses the page's own static markup.
//   createDocument(markup) -> {document}: the markup parsed into <body>.
// Removing a node that holds the focus moves the focus to <body>, as a browser does, so a test can tell a node patched in
// place (focus kept) from one replaced (focus lost).

const { inspect } = require('node:util');

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (text) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
  return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
});

function makeEvent(type, init = {}) {
  return {
    type, target: null, currentTarget: null, button: 0, key: undefined,
    metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
    ...init,
  };
}

// ---- selectors: compound selectors (tag, #id, .class, [attr], [attr="v"]) in a comma list; no combinators ----

function parseSelector(text) {
  return String(text).split(',').map((part) => {
    const s = part.trim();
    const m = /^([a-zA-Z][\w-]*|\*)?((?:#[\w-]+|\.[\w-]+|\[[^\]]+\])*)$/.exec(s);
    if (!s || !m) throw new Error(`mini-dom: unsupported selector "${s}"`);
    const parts = { tag: m[1] && m[1] !== '*' ? m[1].toUpperCase() : null, ids: [], classes: [], attrs: [] };
    for (const [token] of m[2].matchAll(/#[\w-]+|\.[\w-]+|\[[^\]]+\]/g)) {
      if (token[0] === '#') parts.ids.push(token.slice(1));
      else if (token[0] === '.') parts.classes.push(token.slice(1));
      else {
        const a = /^\[\s*([^\s=\]]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]$/.exec(token);
        if (!a) throw new Error(`mini-dom: unsupported attribute selector "${token}"`);
        const value = a[2] ?? a[3] ?? a[4];
        parts.attrs.push({ name: a[1].toLowerCase(), value });
      }
    }
    return parts;
  });
}

function matchesCompound(el, c) {
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.ids.some((id) => el.id !== id)) return false;
  const classes = el.className.split(/\s+/);
  if (c.classes.some((cls) => !classes.includes(cls))) return false;
  return c.attrs.every((a) => el.hasAttribute(a.name) && (a.value === undefined || el.getAttribute(a.name) === a.value));
}

// ---- nodes ----

class Node {
  constructor(doc) {
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
    this._listeners = {};
  }

  // A short form for assertion messages: the default inspection walks the whole (cyclic) tree and takes minutes.
  [inspect.custom]() {
    if (this.nodeType === 3) return `#text ${JSON.stringify(this.nodeValue)}`;
    if (this.nodeType === 9) return '#document';
    const attrs = this.attributes.filter((a) => ['id', 'class', 'data-key'].includes(a.name)).map((a) => ` ${a.name}="${a.value}"`).join('');
    return `<${this.tagName.toLowerCase()}${attrs}>`;
  }

  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] || null;
  }

  appendChild(child) { return this.insertBefore(child, null); }

  insertBefore(child, ref) {
    if (child === ref) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    let i = -1;
    if (ref) {
      i = this.childNodes.indexOf(ref);
      if (i === -1) throw new Error('mini-dom: insertBefore reference is not a child');
    }
    if (i === -1) this.childNodes.push(child);
    else this.childNodes.splice(i, 0, child);
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i === -1) throw new Error('mini-dom: removeChild of a node that is not a child');
    this.childNodes.splice(i, 1);
    child.parentNode = null;
    const doc = this.ownerDocument;
    if (doc && doc.activeElement && child.contains(doc.activeElement)) doc.activeElement = doc.body;
    return child;
  }

  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  replaceWith(node) {
    const parent = this.parentNode;
    if (!parent) return;
    parent.insertBefore(node, this);
    parent.removeChild(this);
  }

  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn); }

  dispatchEvent(event) {
    event.target = this;
    for (let n = this; n && !event.stopped; n = n.parentNode) {
      event.currentTarget = n;
      for (const fn of (n._listeners[event.type] || []).slice()) fn.call(n, event);
    }
    return !event.defaultPrevented;
  }
}

class Text extends Node {
  constructor(doc, value) {
    super(doc);
    this.nodeValue = String(value);
  }
  get nodeType() { return 3; }
  get nodeName() { return '#text'; }
  get textContent() { return this.nodeValue; }
  set textContent(v) { this.nodeValue = String(v); }
}

class Element extends Node {
  constructor(doc, tag) {
    super(doc);
    this.tagName = tag.toUpperCase();
    this._attrs = new Map();
    this._value = undefined;
    this._checked = undefined;
  }

  get nodeType() { return 1; }
  get nodeName() { return this.tagName; }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return this._attrs.has(key) ? this._attrs.get(key) : null;
  }
  setAttribute(name, value) { this._attrs.set(String(name).toLowerCase(), String(value)); }
  hasAttribute(name) { return this._attrs.has(String(name).toLowerCase()); }
  removeAttribute(name) { this._attrs.delete(String(name).toLowerCase()); }
  get attributes() { return Array.from(this._attrs, ([name, value]) => ({ name, value })); }

  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get classList() {
    const el = this;
    const read = () => el.className.split(/\s+/).filter(Boolean);
    const write = (list) => el.setAttribute('class', list.join(' '));
    return {
      add: (...names) => write([...new Set([...read(), ...names])]),
      remove: (...names) => write(read().filter((c) => !names.includes(c))),
      contains: (name) => read().includes(name),
      toggle: (name, force) => {
        const on = force === undefined ? !read().includes(name) : Boolean(force);
        write(on ? [...new Set([...read(), name])] : read().filter((c) => c !== name));
        return on;
      },
    };
  }

  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get open() { return this.hasAttribute('open'); }
  set open(v) { if (v) this.setAttribute('open', ''); else this.removeAttribute('open'); }
  get disabled() { return this.hasAttribute('disabled'); }
  // checked: what was set, else the checked attribute (the attribute stops counting once the property is set, as in a browser).
  get checked() { return this._checked !== undefined ? this._checked : this.hasAttribute('checked'); }
  set checked(v) { this._checked = Boolean(v); }
  set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }

  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }

  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) {
    this.replaceChildren();
    if (String(v) !== '') this.appendChild(new Text(this.ownerDocument, v));
  }

  replaceChildren(...nodes) {
    while (this.childNodes.length) this.removeChild(this.childNodes[0]);
    this.append(...nodes);
  }
  append(...nodes) {
    for (const n of nodes) this.appendChild(typeof n === 'object' ? n : new Text(this.ownerDocument, n));
  }

  // select: the value set on it when one of its options has it, else the selected or first option. option: its value
  // attribute or its text. input and textarea: what was set, else the value attribute.
  get value() {
    if (this.tagName === 'SELECT') {
      const options = this.querySelectorAll('option');
      if (this._value !== undefined && options.some((o) => o.value === this._value)) return this._value;
      const chosen = options.find((o) => o.hasAttribute('selected')) || options[0];
      return chosen ? chosen.value : '';
    }
    if (this.tagName === 'OPTION') return this.hasAttribute('value') ? this.getAttribute('value') : this.textContent;
    return this._value !== undefined ? this._value : (this.getAttribute('value') || '');
  }
  set value(v) { this._value = String(v); }

  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  click() { this.dispatchEvent(makeEvent('click')); }
  select() {}
  setSelectionRange() {}
  scrollIntoView() {}
  scrollBy() {}
  getBoundingClientRect() { return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }; }
  get scrollWidth() { return 0; }
  get clientWidth() { return 0; }
  get scrollLeft() { return 0; }

  matches(selector) { return parseSelector(selector).some((c) => matchesCompound(this, c)); }
  closest(selector) {
    const list = parseSelector(selector);
    for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (list.some((c) => matchesCompound(n, c))) return n;
    return null;
  }
  querySelectorAll(selector) {
    const list = parseSelector(selector);
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (list.some((c) => matchesCompound(child, c))) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class Document extends Node {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.documentElement = new Element(this, 'html');
    this.head = new Element(this, 'head');
    this.body = new Element(this, 'body');
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }
  get nodeType() { return 9; }
  createElement(tag) { return new Element(this, tag); }
  createTextNode(value) { return new Text(this, value); }
  getElementById(id) { return this.documentElement.querySelectorAll(`#${id}`)[0] || null; }
  querySelector(selector) { return this.documentElement.querySelector(selector); }
  querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); }
  get textContent() { return null; }
}

// ---- parsing the page's static markup ----

const OPEN_RE = /^<([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/;
const CLOSE_RE = /^<\/([a-zA-Z][\w-]*)\s*>/;
const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parseInto(doc, root, html) {
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[i] === '<') {
      const rest = html.slice(i);
      const close = CLOSE_RE.exec(rest);
      if (close) {
        const tag = close[1].toUpperCase();
        const at = stack.map((n) => n.tagName).lastIndexOf(tag);
        if (at > 0) stack.length = at;
        i += close[0].length;
        continue;
      }
      const open = OPEN_RE.exec(rest);
      if (open) {
        const tag = open[1].toLowerCase();
        const el = doc.createElement(tag);
        for (const [, name, dq, sq, bare] of open[2].matchAll(ATTR_RE)) el.setAttribute(name, decode(dq ?? sq ?? bare ?? ''));
        top().appendChild(el);
        i += open[0].length;
        if (RAW.has(tag)) {
          const end = html.toLowerCase().indexOf(`</${tag}`, i);
          const stop = end === -1 ? html.length : end;
          if (stop > i) el.appendChild(doc.createTextNode(html.slice(i, stop)));
          i = end === -1 ? html.length : html.indexOf('>', end) + 1;
        } else if (!VOID.has(tag) && !open[3]) {
          stack.push(el);
        }
        continue;
      }
    }
    const next = html.indexOf('<', i + 1);
    const stop = next === -1 ? html.length : next;
    top().appendChild(doc.createTextNode(decode(html.slice(i, stop))));
    i = stop;
  }
}

function createDocument(markup) {
  const document = new Document();
  parseInto(document, document.body, markup);
  return { document };
}

module.exports = { createDocument, makeEvent };
