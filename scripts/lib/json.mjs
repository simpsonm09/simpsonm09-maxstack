import { compareUtf8 } from './paths.mjs';

const TOKEN = /^(?:"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/;

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function decodeUtf8(bytes, label) {
  try {
    // ignoreBOM keeps a leading byte order mark in the text, so the JSON reader can refuse it.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${label}: file is not valid UTF-8`);
  }
}

// JSON.parse keeps the last of two equal keys without a word. This parser refuses them.
export function parseJsonStrict(text, label) {
  let rest = text;
  const fail = (message) => {
    throw new Error(`${label}: ${message}`);
  };
  if (text.startsWith('﻿')) fail('a byte order mark is not allowed in JSON');
  // JSON whitespace is exactly space, tab, CR, and LF. The regex class \s would also take NBSP.
  const skip = () => {
    rest = rest.replace(/^[ \t\r\n]+/, '');
  };
  const take = (char) => {
    skip();
    if (rest[0] !== char) fail(`expected ${JSON.stringify(char)}`);
    rest = rest.slice(1);
  };
  const list = (close, item) => {
    rest = rest.slice(1);
    const items = [];
    skip();
    while (rest[0] !== close) {
      if (items.length) take(',');
      items.push(item());
      skip();
    }
    rest = rest.slice(1);
    return items;
  };
  const member = () => {
    skip();
    const key = TOKEN.exec(rest);
    if (!key?.[0].startsWith('"')) fail('expected a JSON property name');
    rest = rest.slice(key[0].length);
    take(':');
    return [literal(key[0]), value()];
  };
  const literal = (token) => {
    try {
      return JSON.parse(token);
    } catch {
      return fail(`invalid JSON string ${token.slice(0, 20)}`);
    }
  };
  const unique = (entries) => {
    const names = new Set();
    for (const [name] of entries) {
      if (names.has(name)) fail(`duplicate JSON property ${JSON.stringify(name)}`);
      names.add(name);
    }
    return Object.fromEntries(entries);
  };
  function value() {
    skip();
    if (rest[0] === '{') return unique(list('}', member));
    if (rest[0] === '[') return list(']', value);
    const token = TOKEN.exec(rest);
    if (!token) fail('invalid JSON value');
    rest = rest.slice(token[0].length);
    return literal(token[0]);
  }
  const result = value();
  skip();
  if (rest.length) fail('trailing data after the JSON value');
  return result;
}

function serialize(value, depth) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const inner = '  '.repeat(depth + 1);
  const outer = '  '.repeat(depth);
  if (Array.isArray(value)) {
    return value.length ? `[\n${value.map((item) => inner + serialize(item, depth + 1)).join(',\n')}\n${outer}]` : '[]';
  }
  const keys = Object.keys(value).sort(compareUtf8);
  if (!keys.length) return '{}';
  const lines = keys.map((key) => `${inner}${JSON.stringify(key)}: ${serialize(value[key], depth + 1)}`);
  return `{\n${lines.join(',\n')}\n${outer}}`;
}

export function jsonBytes(value) {
  return Buffer.from(`${serialize(value, 0)}\n`, 'utf8');
}
