#!/usr/bin/env node
// Helix TaskSet validator: the checks `helix-loop validate` runs on a plan, with no dependencies.
//
//   node scripts/validate.mjs <plan-dir> [--schema-dir <dir>] [--reqs <file>]
//
// <plan-dir> holds taskset.yaml, tasks/T-####.yaml and human/HT-##.yaml (JSON files with the same
// names and a .json extension work too). It prints one problem per line as `ID: message`, warnings as
// `ID: warning: message`, then a summary line, and exits 0 when there are no errors, 1 when there are.
//
// The schemas are read, in order, from --schema-dir, <plan-dir>/schema, the skill's own schema/
// (next to scripts/), and helix-loop's schema/ when run from its source tree.
// Requirement coverage is checked when --reqs names a file, or <plan-dir>/reqs.txt exists: one
// requirement ID per line, first word only, `#` starts a comment.
//
// What `helix-loop validate` checks and this script does not: spec citations against spec/index.json,
// and each task's rendered prompt against the prompt budget. Both need the loop's spec index.
//
// The YAML reader covers the subset TaskSets use:
// - block mappings and block sequences, by indentation (spaces, never tabs), `- key: value` items;
// - flow sequences and flow mappings, `[a, "b"]` and `{ name: X }`, which may span lines;
// - plain, 'single' and "double" quoted scalars, each on one line; plain scalars may continue on more
//   indented lines, which fold into one line;
// - block scalars `|` and `>`, with `-` or `+` chomping;
// - null, ~, true, false, integers and decimals; anything else plain is a string (dates stay strings);
// - comments, and a leading `---`.
// Anchors, aliases, tags, complex keys and multi-document files are refused with an error.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------------------------------
// YAML subset reader

export function parseYaml(text, source = 'yaml') {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let i = 0;
  const fail = (message, at = i) => {
    throw new Error(`${source}:${at + 1}: ${message}`);
  };

  const indentOf = (line) => line.length - line.trimStart().length;
  const isBlank = (line) => line.trim() === '' || line.trimStart().startsWith('#');
  // The next line that holds content, skipping blanks and comments.
  const peek = () => {
    while (i < lines.length && isBlank(lines[i])) i++;
    return i < lines.length ? lines[i] : null;
  };
  const isSeqItem = (content) => content === '-' || content.startsWith('- ');

  for (const [n, line] of lines.entries()) if (/^\s*\t/.test(line)) fail('tabs are not allowed for indentation', n);
  if (/^---(\s+#.*)?\s*$/.test(peek() ?? '')) i++;

  function parseNode(minIndent) {
    const line = peek();
    if (line === null || indentOf(line) < minIndent) return null;
    const ind = indentOf(line);
    const content = line.slice(ind);
    if (isSeqItem(content)) return parseSeq(ind);
    if (splitKey(content)) return parseMap(ind);
    i++;
    return scalarWithContinuation(content, ind - 1);
  }

  function parseMap(ind) {
    const out = {};
    for (let line = peek(); line !== null && indentOf(line) === ind; line = peek()) {
      const content = line.slice(ind);
      if (content === '---' || content === '...') fail('only one document per file is supported');
      if (isSeqItem(content)) fail('a sequence item where a mapping key was expected');
      const kv = splitKey(content);
      if (!kv) fail(`expected "key: value", got "${content}"`);
      if (Object.hasOwn(out, kv.key)) fail(`duplicate key "${kv.key}"`);
      i++;
      out[kv.key] = parseValue(kv.rest, ind, true);
    }
    const next = peek();
    if (next !== null && indentOf(next) > ind) fail('unexpected indentation');
    return out;
  }

  function parseSeq(ind) {
    const out = [];
    for (let line = peek(); line !== null && indentOf(line) === ind && isSeqItem(line.slice(ind)); line = peek()) {
      const after = line.slice(ind + 1);
      const rest = after.trimStart();
      if (rest === '' || rest.startsWith('#')) {
        i++;
        out.push(parseNode(ind + 1));
        continue;
      }
      const col = ind + 1 + (after.length - rest.length);
      if (isSeqItem(rest) || (!/^[[{"'|>]/.test(rest) && splitKey(rest)) || /^["'][^"']*["']\s*:(\s|$)/.test(rest)) {
        // A nested sequence or a mapping that starts on the dash's line: read it as if it were indented.
        lines[i] = ' '.repeat(col) + rest;
        out.push(isSeqItem(rest) ? parseSeq(col) : parseMap(col));
        continue;
      }
      i++;
      out.push(parseValue(rest, ind, false));
    }
    return out;
  }

  // The value after "key:" or "- ". `parent` is the indentation of the key or the dash.
  function parseValue(rest, parent, inMap) {
    const value = stripComment(rest).trim();
    if (value === '') {
      const next = peek();
      if (next === null) return null;
      const ind = indentOf(next);
      if (ind > parent) return parseNode(parent + 1);
      // A block sequence may sit at its key's own indentation.
      if (inMap && ind === parent && isSeqItem(next.slice(ind))) return parseSeq(ind);
      return null;
    }
    if (/^[|>]/.test(value)) return blockScalar(value, parent);
    if (/^[&*!]/.test(value)) fail('anchors, aliases and tags are not supported', i - 1);
    if (value.startsWith('[') || value.startsWith('{')) return flowValue(value, parent);
    return scalarWithContinuation(value, parent);
  }

  function scalarWithContinuation(value, parent) {
    if (value.startsWith('"') || value.startsWith("'")) return multiLineQuoted(value);
    let text = value;
    // A plain scalar continues on more indented lines that are not keys or items.
    while (i < lines.length && !isBlank(lines[i]) && indentOf(lines[i]) > parent) {
      text += ` ${stripComment(lines[i]).trim()}`;
      i++;
    }
    return plain(text);
  }

  // A quoted scalar may run over several lines: each line break folds to a space, an empty line to a
  // newline, and in double quotes a backslash at the end of a line joins the lines with nothing between.
  function multiLineQuoted(first) {
    const start = i - 1;
    const q = first[0];
    const raw = lines[start].slice(lines[start].indexOf(first));
    if (closesAt(raw, q, 1) >= 0) return quoted(stripComment(raw).trim(), start);
    // Trailing spaces fold away, except one escaped by a backslash.
    const trimEnd = (s) => {
      const t = s.replace(/[ \t]+$/, '');
      return q === '"' && t.length < s.length && /(^|[^\\])(\\\\)*\\$/.test(t) ? s.slice(0, t.length + 1) : t;
    };
    const parts = [trimEnd(raw)];
    for (;;) {
      if (i >= lines.length) fail('unclosed quoted string', start);
      const line = trimEnd(lines[i++].trimStart());
      const end = closesAt(line, q, 0);
      if (end >= 0) {
        if (stripComment(line.slice(end + 1)).trim() !== '') fail('unexpected text after a quoted string', i - 1);
        parts.push(line.slice(0, end + 1));
        break;
      }
      parts.push(line);
    }
    let text = parts[0];
    let pendingBreaks = 0;
    for (const part of parts.slice(1)) {
      if (part === '') {
        pendingBreaks++;
        continue;
      }
      const escaped = q === '"' && /(^|[^\\])(\\\\)*\\$/.test(text);
      if (escaped) text = text.slice(0, -1) + part;
      else text += (pendingBreaks ? '\n'.repeat(pendingBreaks) : ' ') + part;
      pendingBreaks = 0;
    }
    // Newlines folded in are literal; quoted() would refuse them in single quotes only as quotes.
    return q === '"' ? quoted(text.replace(/\n/g, '\\n'), start) : quoted(text, start);
  }

  function blockScalar(header, parent) {
    const m = /^([|>])([-+]?)(\d?)([-+]?)$/.exec(header);
    if (!m) fail(`bad block scalar header "${header}"`, i - 1);
    const folded = m[1] === '>';
    const chomp = m[2] || m[4];
    const body = [];
    let contentIndent = m[3] ? parent + Number(m[3]) : -1;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '') {
        // Spaces past the content's indentation are content.
        body.push(contentIndent >= 0 && line.length > contentIndent ? line.slice(contentIndent) : '');
        i++;
        continue;
      }
      const ind = indentOf(line);
      if (contentIndent < 0) {
        if (ind <= parent) break;
        contentIndent = ind;
      }
      if (ind < contentIndent) break;
      body.push(line.slice(contentIndent));
      i++;
    }
    let trailing = 0;
    while (body.length && body[body.length - 1] === '') {
      body.pop();
      trailing++;
    }
    let text = body.join('\n');
    if (folded && body.length) {
      // Line breaks fold to spaces; n empty lines between two lines are n newlines; lines that are
      // more indented keep their breaks.
      const first = body.findIndex((l) => l !== '');
      text = '\n'.repeat(first) + body[first];
      let prev = body[first];
      let empties = 0;
      for (const line of body.slice(first + 1)) {
        if (line === '') {
          empties++;
          continue;
        }
        if (/^\s/.test(line) || /^\s/.test(prev)) text += '\n'.repeat(empties + 1);
        else text += empties ? '\n'.repeat(empties) : ' ';
        text += line;
        prev = line;
        empties = 0;
      }
    }
    if (body.length === 0) return chomp === '+' ? '\n'.repeat(trailing) : '';
    if (chomp === '-') return text;
    if (chomp === '+') return `${text}\n${'\n'.repeat(trailing)}`;
    return `${text}\n`;
  }

  function flowValue(first, parent) {
    let text = first;
    const start = i - 1;
    for (;;) {
      const r = readFlow(text, 0);
      if (r.ok) {
        if (text.slice(r.end).trim() !== '') fail(`unexpected text after a flow collection: "${text.slice(r.end).trim()}"`, start);
        return r.value;
      }
      if (i >= lines.length || indentOf(lines[i]) <= parent) fail(r.error, start);
      text += ` ${stripComment(lines[i]).trim()}`;
      i++;
    }
  }

  return parseNode(0);
}

// Splits `key: rest` (or `key:` at the end of the line); null when the content is not a key.
function splitKey(content) {
  if (content.startsWith('"') || content.startsWith("'")) {
    const q = content[0];
    let j = 1;
    while (j < content.length) {
      if (q === '"' && content[j] === '\\') j += 2;
      else if (content[j] === q && q === "'" && content[j + 1] === "'") j += 2;
      else if (content[j] === q) break;
      else j++;
    }
    const after = content.slice(j + 1);
    const m = /^\s*:(\s|$)/.exec(after);
    if (!m) return null;
    return { key: quoted(content.slice(0, j + 1), -1), rest: after.slice(m[0].length) };
  }
  if (/^[[{#&*!|>%@`]/.test(content) || content.startsWith('- ') || content === '-') return null;
  const m = /:(\s|$)/.exec(content);
  if (!m || /\s#/.test(content.slice(0, m.index))) return null;
  return { key: content.slice(0, m.index).trim(), rest: content.slice(m.index + m[0].length) };
}

// The index of the quote that closes a quoted scalar begun before `from`, or -1.
function closesAt(s, q, from) {
  for (let j = from; j < s.length; j++) {
    if (q === '"' && s[j] === '\\') j++;
    else if (s[j] === q && q === "'" && s[j + 1] === "'") j++;
    else if (s[j] === q) return j;
  }
  return -1;
}

// Drops a trailing comment: a `#` after whitespace, outside quotes.
function stripComment(s) {
  let q = null;
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (q) {
      if (q === '"' && c === '\\') j++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      if (j === 0 || /[\s[{,:]/.test(s[j - 1])) q = c;
    } else if (c === '#' && (j === 0 || /\s/.test(s[j - 1]))) return s.slice(0, j);
  }
  return s;
}

function quoted(s, line) {
  const where = line >= 0 ? `line ${line + 1}: ` : '';
  const q = s[0];
  if (s.length < 2 || s[s.length - 1] !== q) throw new Error(`${where}a quoted string must end on its own line: ${s}`);
  const body = s.slice(1, -1);
  if (q === "'") {
    if (/'(?!')/.test(body.replace(/''/g, ''))) throw new Error(`${where}unescaped quote in ${s}`);
    return body.replace(/''/g, "'");
  }
  return unescapeDouble(body, where, s);
}

function unescapeDouble(body, where, s) {
  const simple = { '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: ' ', P: ' ' };
  let out = '';
  for (let j = 0; j < body.length; j++) {
    const c = body[j];
    if (c === '"') throw new Error(`${where}unescaped quote in ${s}`);
    if (c !== '\\') {
      out += c;
      continue;
    }
    const e = body[++j];
    if (e !== undefined && e in simple) out += simple[e];
    else if (e === 'x' || e === 'u' || e === 'U') {
      const len = { x: 2, u: 4, U: 8 }[e];
      const hex = body.slice(j + 1, j + 1 + len);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) throw new Error(`${where}bad escape in ${s}`);
      out += String.fromCodePoint(parseInt(hex, 16));
      j += len;
    } else throw new Error(`${where}bad escape \\${e ?? ''} in ${s}`);
  }
  return out;
}

// YAML 1.2 core schema, as the loop's `yaml` package reads it.
function plain(s) {
  const t = s.trim();
  if (/^(null|Null|NULL|~|)$/.test(t)) return null;
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (/^[-+]?[0-9]+$/.test(t)) return Number(t);
  if (/^0x[0-9a-fA-F]+$/.test(t)) return parseInt(t.slice(2), 16);
  if (/^0o[0-7]+$/.test(t)) return parseInt(t.slice(2), 8);
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(t)) return Number(t);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(t)) return t.startsWith('-') ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(t)) return NaN;
  return t;
}

// Reads one flow value at text[pos]; { ok, value, end } or { ok: false, error } when it is unfinished.
function readFlow(text, pos) {
  let p = pos;
  const ws = () => {
    while (p < text.length && /\s/.test(text[p])) p++;
  };
  const unfinished = { ok: false, error: 'unclosed flow collection' };
  function value(inMapKey) {
    ws();
    if (p >= text.length) return unfinished;
    const c = text[p];
    if (c === '[') {
      p++;
      const arr = [];
      for (;;) {
        ws();
        if (p >= text.length) return unfinished;
        if (text[p] === ']') {
          p++;
          return { ok: true, value: arr };
        }
        const v = value(false);
        if (!v.ok) return v;
        arr.push(v.value);
        ws();
        if (p >= text.length) return unfinished;
        if (text[p] === ',') p++;
        else if (text[p] !== ']') throw new Error(`expected , or ] in ${text}`);
      }
    }
    if (c === '{') {
      p++;
      const obj = {};
      for (;;) {
        ws();
        if (p >= text.length) return unfinished;
        if (text[p] === '}') {
          p++;
          return { ok: true, value: obj };
        }
        const k = value(true);
        if (!k.ok) return k;
        ws();
        let v = { ok: true, value: null };
        if (text[p] === ':') {
          p++;
          v = value(false);
          if (!v.ok) return v;
        }
        obj[String(k.value)] = v.value;
        ws();
        if (p >= text.length) return unfinished;
        if (text[p] === ',') p++;
        else if (text[p] !== '}') throw new Error(`expected , or } in ${text}`);
      }
    }
    if (c === '"' || c === "'") {
      let j = p + 1;
      while (j < text.length) {
        if (c === '"' && text[j] === '\\') j += 2;
        else if (c === "'" && text[j] === "'" && text[j + 1] === "'") j += 2;
        else if (text[j] === c) break;
        else j++;
      }
      if (j >= text.length) return unfinished;
      const s = text.slice(p, j + 1);
      p = j + 1;
      return { ok: true, value: quoted(s, -1) };
    }
    let j = p;
    while (j < text.length && !/[,[\]{}]/.test(text[j]) && !(text[j] === ':' && (inMapKey || /[\s,\]}]/.test(text[j + 1] ?? ' ')))) j++;
    const s = text.slice(p, j);
    p = j;
    return { ok: true, value: plain(s) };
  }
  const r = value(false);
  return r.ok ? { ...r, end: p } : r;
}

// ---------------------------------------------------------------------------------------------------
// JSON Schema subset (draft-07 keywords the plan schemas use), with ajv's wording

export function checkSchema(schema, value, path = '') {
  const errors = [];
  const at = path || '/';
  const err = (message) => errors.push(`${at} ${message}`);
  const type = jsonType(value);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = types.some((t) => t === type || (t === 'number' && type === 'integer'));
    if (!ok) {
      err(`must be ${types.join(',')}`);
      return errors;
    }
  }
  if (schema.oneOf) {
    const matched = schema.oneOf.filter((s) => !checkSchema(s, value, path).length).length;
    if (matched !== 1) err(matched ? 'must match exactly one schema in oneOf' : `must match a schema in oneOf`);
  }
  if (schema.const !== undefined && !sameJson(schema.const, value)) err('must be equal to constant');
  if (schema.enum && !schema.enum.some((e) => sameJson(e, value))) err(`must be equal to one of the allowed values: ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if (typeof value === 'string') {
    const len = [...value].length;
    if (schema.minLength !== undefined && len < schema.minLength) err(`must NOT have fewer than ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && len > schema.maxLength) err(`must NOT have more than ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) err(`must match pattern "${schema.pattern}"`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) err(`must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) err(`must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) err(`must NOT have fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) err(`must NOT have more than ${schema.maxItems} items`);
    if (schema.uniqueItems) {
      for (let a = 0; a < value.length; a++) {
        for (let b = a + 1; b < value.length; b++) {
          if (sameJson(value[a], value[b])) err(`must NOT have duplicate items (items ## ${b} and ${a} are identical)`);
        }
      }
    }
    if (schema.items && typeof schema.items === 'object') value.forEach((v, n) => errors.push(...checkSchema(schema.items, v, `${path}/${n}`)));
  }
  if (type === 'object') {
    const keys = Object.keys(value);
    for (const r of schema.required ?? []) if (!Object.hasOwn(value, r)) err(`must have required property '${r}'`);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) err(`must NOT have fewer than ${schema.minProperties} properties`);
    for (const k of keys) {
      const sub = `${path}/${k}`;
      if (schema.propertyNames) errors.push(...checkSchema(schema.propertyNames, k, sub).map((e) => `${e} (property name)`));
      const patterns = Object.entries(schema.patternProperties ?? {}).filter(([p]) => new RegExp(p, 'u').test(k));
      for (const [, s] of patterns) errors.push(...checkSchema(s, value[k], sub));
      if (schema.properties && Object.hasOwn(schema.properties, k)) errors.push(...checkSchema(schema.properties[k], value[k], sub));
      else if (!patterns.length && schema.additionalProperties === false) err(`must NOT have additional property '${k}'`);
      else if (!patterns.length && typeof schema.additionalProperties === 'object') errors.push(...checkSchema(schema.additionalProperties, value[k], sub));
    }
  }
  return errors;
}

function jsonType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------------------------------
// The TaskSet checks

const SECRET_VALUE = [
  /\bsk_(live|test)_[0-9A-Za-z]{10,}/,
  /\bsk-(ant-|proj-)?[0-9A-Za-z_-]{20,}/,
  /\bgh[pousr]_[0-9A-Za-z]{30,}/,
  /\bgithub_pat_[0-9A-Za-z_]{30,}/,
  /\bxox[abprs]-[0-9A-Za-z-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function readDoc(file) {
  const text = readFileSync(file, 'utf8');
  return { value: file.endsWith('.json') ? JSON.parse(text) : parseYaml(text, file), text };
}

function readDir(dir, idPattern, problems) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort()) {
    if (!/\.(ya?ml|json)$/.test(f)) continue;
    const file = join(dir, f);
    let doc;
    try {
      doc = readDoc(file);
    } catch (e) {
      problems.push({ id: f, level: 'error', message: `cannot be read: ${e.message}` });
      continue;
    }
    const id = doc.value?.id;
    if (typeof id !== 'string' || !idPattern.test(id)) {
      problems.push({ id: f, level: 'error', message: 'has no valid id' });
      continue;
    }
    if (f.replace(/\.(ya?ml|json)$/, '') !== id) problems.push({ id, level: 'error', message: `is in ${f}; the file must be named ${id}.yaml` });
    if (out.has(id)) problems.push({ id, level: 'error', message: 'is defined twice' });
    out.set(id, doc);
  }
  return out;
}

export function findSchemaDir(planDir, explicit) {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = explicit ? [explicit] : [join(planDir, 'schema'), join(here, '..', 'schema'), join(here, '..', '..', 'schema')];
  return candidates.find((d) => existsSync(join(d, 'task.schema.json'))) ?? null;
}

function readReqs(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim().split(/\s+/)[0])
    .filter(Boolean);
}

// Returns every problem as { id, level: 'error' | 'warning', message }.
export function validateTaskSet(planDir, opts = {}) {
  const problems = [];
  const error = (id, message) => problems.push({ id, level: 'error', message });
  const warn = (id, message) => problems.push({ id, level: 'warning', message });

  const schemaDir = findSchemaDir(planDir, opts.schemaDir);
  if (!schemaDir) {
    error('schema', 'no task.schema.json found; pass --schema-dir');
    return { problems, tasks: 0, human: 0 };
  }
  const loadSchema = (name) => {
    const f = join(schemaDir, name);
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
  };
  const taskSchema = loadSchema('task.schema.json');
  const humanSchema = loadSchema('human.schema.json');
  const tasksetSchema = loadSchema('taskset.schema.json');
  // The stages are the TaskSet's own (taskset.yaml `stages`); without that list, any stage name is fine.
  let stages = [];

  // taskset.yaml: lanes and epics.
  let taskset = null;
  const tsFile = ['taskset.yaml', 'taskset.yml', 'taskset.json'].map((f) => join(planDir, f)).find(existsSync);
  if (!tsFile) error('taskset.yaml', 'missing: a TaskSet declares its lanes and epics in taskset.yaml');
  else {
    try {
      taskset = readDoc(tsFile).value;
      if (tasksetSchema) for (const e of checkSchema(tasksetSchema, taskset)) error('taskset.yaml', `schema: ${e}`);
      stages = (taskset?.stages ?? []).map((s) => (typeof s === 'string' ? s : s?.key)).filter(Boolean);
      for (const [lane, l] of Object.entries(taskset?.lanes ?? {})) {
        for (const [key, epic] of Object.entries(l?.epics ?? {})) {
          if (epic?.stage !== undefined && stages.length && !stages.includes(epic.stage)) {
            error(`${lane}/${key}`, `stage ${epic.stage} is not one of the TaskSet's stages (${stages.join(', ')})`);
          }
        }
      }
    } catch (e) {
      error('taskset.yaml', `cannot be read: ${e.message}`);
    }
  }

  const tasks = readDir(join(planDir, 'tasks'), /^T-\d+$/, problems);
  const human = readDir(join(planDir, 'human'), /^HT-\d+$/, problems);

  // Schema, as `helix-loop validate` runs it with ajv.
  const schemaPaths = new Map();
  for (const [docs, schema] of [[tasks, taskSchema], [human, humanSchema]]) {
    if (!schema) continue;
    for (const [id, { value }] of docs) {
      const errs = checkSchema(schema, value);
      schemaPaths.set(id, errs.map((e) => e.split(' ')[0]));
      for (const e of errs) error(id, `schema: ${e}`);
    }
  }

  // Normalised, as the loop loads them.
  const T = new Map([...tasks].map(([id, { value }]) => [id, { ...value, blocked_by: arr(value.blocked_by), reqs: arr(value.reqs), acceptance: arr(value.acceptance) }]));
  const H = new Map([...human].map(([id, { value }]) => [id, { ...value, blocked_by: arr(value.blocked_by) }]));
  const exists = (id) => T.has(id) || H.has(id);

  // Dependencies: every blocker resolves, none is the task itself, none sits in a later stage, only
  // design work waits on design work, and there is no cycle.
  const edges = new Map();
  for (const [id, t] of T) edges.set(id, t.blocked_by);
  for (const [id, h] of H) edges.set(id, h.blocked_by);
  for (const [id, deps] of edges) {
    for (const d of deps) {
      if (d === id) error(id, 'blocked by itself');
      else if (!exists(d)) error(id, `blocked_by ${d}, which does not exist`);
    }
  }
  for (const [id, t] of T) {
    for (const d of t.blocked_by) {
      const dep = T.get(d);
      if (dep && stages.indexOf(dep.stage) > stages.indexOf(t.stage)) error(id, `blocked by ${d} in ${dep.stage}, a later stage than its own ${t.stage}`);
      if (dep?.role === 'design' && t.role !== 'design') error(id, `blocked by ${d}, a design-role task; only design-role tasks may wait on design work`);
    }
  }
  for (const cycle of findCycles(edges, exists)) error(cycle[0], `dependency cycle: ${cycle.join(' → ')}`);

  // Lanes and epics: every task is in a lane its repo names and an epic that lane declares.
  if (taskset?.lanes) {
    const lanes = Object.entries(taskset.lanes);
    const used = new Set();
    for (const [id, t] of T) {
      const lane = lanes.find(([key, l]) => l?.repo === t.repo) ?? lanes.find(([key]) => key === t.repo);
      if (!lane) {
        error(id, `repo ${t.repo} is not a lane in taskset.yaml`);
        continue;
      }
      const [laneKey, l] = lane;
      if (!t.epic) {
        error(id, `has no epic; set epic to one of lane ${laneKey}'s epics (${Object.keys(l.epics ?? {}).join(', ')})`);
        continue;
      }
      const epic = l.epics?.[t.epic];
      if (!epic) {
        error(id, `epic ${t.epic} is not declared in lane ${laneKey} in taskset.yaml`);
        continue;
      }
      used.add(`${laneKey}/${t.epic}`);
      if (epic.stage && t.stage && epic.stage !== t.stage) warn(id, `stage ${t.stage} differs from its epic ${t.epic}'s stage ${epic.stage}: leave the epic's stage out when its tasks span stages`);
    }
    for (const [laneKey, l] of lanes) {
      for (const key of Object.keys(l?.epics ?? {})) if (!used.has(`${laneKey}/${key}`)) warn(`${laneKey}/${key}`, 'epic has no tasks');
    }
  }

  // Size, tests and state.
  for (const [id, t] of T) {
    const est = t.estimate_passes;
    if (typeof est === 'number') {
      if (est > 3 && !schemaPaths.get(id)?.includes('/estimate_passes')) error(id, `estimate_passes ${est} is more than 3 passes; split it`);
      else if (est > 1 && est <= 3) warn(id, `estimate_passes ${est}: more than one pass; split it unless splitting would leave something half-built`);
    }
    if (t.acceptance.length === 0) warn(id, 'names no acceptance test');
    for (const a of t.acceptance) {
      const tags = /\[([^\]]+)\]/.exec(String(a))?.[1]?.split(/,\s*/) ?? [];
      for (const tag of tags) if (!t.reqs.includes(tag)) error(id, `acceptance "${a}" is tagged ${tag}, which is not in the task's reqs`);
    }
    if (t.status === 'claimed' && !t.claimed_by) error(id, 'claimed but claimed_by is empty');
    if (t.status !== undefined && t.status !== 'claimed' && t.claimed_by) error(id, `status ${t.status} but claimed_by ${t.claimed_by}`);
  }
  for (const [id, h] of H) {
    if ((h.agent_can_help === 'yes' || h.agent_can_help === 'partly') && !String(h.handoff_prompt ?? '').trim()) {
      warn(id, `agent_can_help is ${h.agent_can_help} but there is no handoff_prompt`);
    }
  }

  // Never a secret value, anywhere in the TaskSet.
  for (const [id, { text }] of [...tasks, ...human]) {
    if (SECRET_VALUE.some((re) => re.test(text))) error(id, 'holds what looks like a secret value; name the secret and where it is stored instead');
  }

  // Coverage: every requirement is delivered by a task, and no task cites an unknown one.
  const reqsFile = opts.reqs ?? (existsSync(join(planDir, 'reqs.txt')) ? join(planDir, 'reqs.txt') : null);
  if (reqsFile) {
    const known = new Set(readReqs(reqsFile));
    const claimed = new Set();
    for (const [id, t] of T) {
      for (const r of t.reqs) {
        if (!known.has(r)) error(id, `cites ${r}, which is not in ${reqsFile.split(/[\\/]/).pop()}`);
        claimed.add(r);
      }
    }
    for (const r of known) if (!claimed.has(r)) error(r, 'no task delivers this requirement');
  }

  return { problems, tasks: T.size, human: H.size };
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

// Every cycle found by an iterative depth-first search, each as the path that closes it.
function findCycles(edges, exists) {
  const cycles = [];
  const state = new Map(); // 1 visiting, 2 done
  for (const start of edges.keys()) {
    if (state.has(start)) continue;
    const stack = [{ id: start, i: 0 }];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const deps = (edges.get(top.id) ?? []).filter((d) => d !== top.id && exists(d));
      if (top.i < deps.length) {
        const next = deps[top.i++];
        const s = state.get(next);
        if (s === 1) cycles.push([...stack.slice(stack.findIndex((f) => f.id === next)).map((f) => f.id), next]);
        else if (s === undefined) {
          state.set(next, 1);
          stack.push({ id: next, i: 0 });
        }
      } else {
        state.set(top.id, 2);
        stack.pop();
      }
    }
  }
  return cycles;
}

// ---------------------------------------------------------------------------------------------------
// CLI

function main(argv) {
  const args = [...argv];
  const opts = {};
  let planDir = null;
  while (args.length) {
    const a = args.shift();
    if (a === '--schema-dir') opts.schemaDir = resolve(args.shift() ?? '');
    else if (a === '--reqs') opts.reqs = resolve(args.shift() ?? '');
    else if (a === '-h' || a === '--help') {
      console.log('usage: node scripts/validate.mjs <plan-dir> [--schema-dir <dir>] [--reqs <file>]');
      return 0;
    } else if (!planDir) planDir = resolve(a);
    else {
      console.error(`unexpected argument: ${a}`);
      return 1;
    }
  }
  if (!planDir || !existsSync(planDir)) {
    console.error('usage: node scripts/validate.mjs <plan-dir> [--schema-dir <dir>] [--reqs <file>]');
    return 1;
  }
  const { problems, tasks, human } = validateTaskSet(planDir, opts);
  for (const p of problems) console.log(`${p.id}: ${p.level === 'warning' ? 'warning: ' : ''}${p.message}`);
  const errors = problems.filter((p) => p.level === 'error').length;
  console.log(`${tasks} tasks, ${human} human tasks, ${errors} errors, ${problems.length - errors} warnings`);
  return errors ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
