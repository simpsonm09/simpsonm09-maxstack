import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { decodeUtf8, isObject, parseJsonStrict } from './json.mjs';
import { assertNoLinkedPath, compareUtf8, rejectDevicePath, safeRelativePath, safeSegment, statBelow, statOrNull } from './paths.mjs';

export const LAYER_NAME = /^[a-z0-9][a-z0-9-]*$/;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const MCP_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const FRAGMENT = 'opencode.fragment.jsonc';
const MANIFEST = '.claude-plugin/plugin.json';

// One --layers value holds several roots separated by ';', unless the whole value (or its
// name=path path) is itself an existing directory, in which case the ';' is part of the name.
export function splitLayerValue(value) {
  const named = /^([^=/\\:]+)=(.+)$/.exec(value);
  if (statOrNull(resolve(named ? named[2] : value))?.isDirectory()) return [value];
  return value.split(';');
}

export function layerIdentity(argument) {
  const named = /^([^=/\\:]+)=(.+)$/.exec(argument);
  const root = resolve(named ? named[2] : argument);
  const name = named ? named[1] : basename(root);
  if (!LAYER_NAME.test(name)) {
    throw new Error(`layer name ${JSON.stringify(name)} must be lowercase letters, digits, and hyphens; use name=path to choose one`);
  }
  return { name, root };
}

// Reads the layer roots in command-line order: skills as byte copies, the plugin name check,
// and OpenCode MCP servers from the fragment. Nothing else in a layer is read.
export function loadLayers(sources) {
  if (!sources.length) throw new Error('--layers requires one or more layer roots');
  const names = new Set();
  const warnings = [];
  const layers = sources.map((argument) => {
    rejectDevicePath(argument.replace(/^[^=/\\:]+=/, ''), 'layer root');
    if (!argument) throw new Error('layer root must not be empty');
    const { name, root } = layerIdentity(argument);
    if (names.has(name)) throw new Error(`duplicate layer name ${name}`);
    names.add(name);
    return loadLayer(name, root, warnings);
  });
  return { layers, warnings };
}

function loadLayer(name, root, warnings) {
  assertNoLinkedPath(root, `layer ${name}`);
  const stat = statOrNull(root);
  if (!stat?.isDirectory()) throw new Error(`layer root must be an existing directory: ${root}`);
  const label = `layer ${name}`;
  if (statBelow(root, 'neutral-layer.json', label)) {
    throw new Error(`${label}: neutral-layer.json is not read by this generator; remove it`);
  }
  // A folder with none of these is not a layer. Refusing it stops a mistyped root from
  // reading as "no skills" and removing the output that a real layer produced.
  const evidence = [statBelow(root, 'skills', label), statBelow(root, MANIFEST, label), statBelow(root, FRAGMENT, label)];
  if (!evidence.some(Boolean)) {
    throw new Error(`${label}: ${root} has no skills/, ${MANIFEST}, or ${FRAGMENT}; it is not a layer`);
  }
  if (evidence[1]) {
    const plugin = readJsonBelow(root, MANIFEST);
    if (plugin?.name !== name) throw new Error(`${join(root, MANIFEST)}: plugin name ${JSON.stringify(plugin?.name)} must match layer ${name}`);
  }
  return { name, root, servers: readServers(root, name), skills: readSkills(root, name, warnings) };
}

// Every metadata read goes through statBelow, so a junction or link under the root is refused.
function readJsonBelow(root, relative) {
  const path = join(root, ...relative.split('/'));
  return parseJsonStrict(decodeUtf8(readFileSync(path), path), path);
}

function object(value, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function onlyKeys(value, allowed, label) {
  for (const key of Object.keys(object(value, label))) {
    if (!allowed.includes(key)) throw new Error(`${label}: unsupported key ${JSON.stringify(key)}`);
  }
}

function readServers(root, name) {
  const path = join(root, FRAGMENT);
  const servers = new Map();
  if (!statBelow(root, FRAGMENT, `layer ${name}`)) return servers;
  const fragment = readJsonBelow(root, FRAGMENT);
  onlyKeys(fragment, ['mcp'], path);
  if (fragment.mcp === undefined) return servers;
  onlyKeys(fragment.mcp, ['servers'], `${path}: mcp`);
  const declared = object(fragment.mcp.servers ?? {}, `${path}: mcp.servers`);
  for (const [name, value] of Object.entries(declared)) {
    if (!MCP_NAME.test(name)) throw new Error(`${path}: invalid MCP server name ${JSON.stringify(name)}`);
    servers.set(name, serverRecord(value, `${path}: MCP server ${name}`));
  }
  return servers;
}

// The OpenCode V2 shape is the only MCP shape projected. Environment and header references
// are unsupported keys, so they fail closed.
function serverRecord(value, label) {
  const server = object(value, label);
  const record = server.type === 'local' ? localServer(server, label) : remoteServer(server, label);
  if (server.disabled !== undefined && typeof server.disabled !== 'boolean') throw new Error(`${label}: disabled must be boolean`);
  if (server.disabled === true) record.disabled = true;
  return record;
}

function localServer(server, label) {
  onlyKeys(server, ['type', 'command', 'disabled'], label);
  const command = server.command;
  if (!Array.isArray(command) || !command.length || !command.every((part) => typeof part === 'string' && part.length)) {
    throw new Error(`${label}: command must be a non-empty array of non-empty strings`);
  }
  return { type: 'local', command: [...command] };
}

function remoteServer(server, label) {
  onlyKeys(server, ['type', 'url', 'disabled'], label);
  if (server.type !== 'remote') throw new Error(`${label}: type must be local or remote`);
  return { type: 'remote', url: checkedUrl(server.url, label) };
}

function checkedUrl(value, label) {
  if (typeof value !== 'string' || !/^https?:\/\//.test(value) || /[\s\p{Cc}]/u.test(value)) {
    throw new Error(`${label}: URL must be an http or https URL without whitespace or control characters`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label}: URL is not valid`);
  }
  if (parsed.username || parsed.password) throw new Error(`${label}: URL credentials are forbidden`);
  return value;
}

function readSkills(root, layer, warnings) {
  const dir = join(root, 'skills');
  const stat = statBelow(root, 'skills', `layer ${layer}`);
  if (!stat) return [];
  if (!stat.isDirectory()) throw new Error(`layer ${layer}: skills must be a directory`);
  const skills = [];
  for (const entry of listEntries(dir, `layer ${layer} skills`)) {
    if (entry.startsWith('.')) continue;
    const path = join(dir, entry);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error(`layer ${layer}: symbolic link or junction at skills/${entry}`);
    if (!info.isDirectory()) {
      warnings.push(`ignored skills/${entry}: not a skill folder`);
      continue;
    }
    skills.push(readSkill(path, entry, layer));
  }
  return skills;
}

function listEntries(dir, label) {
  const names = readdirSync(dir).sort(compareUtf8);
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
    throw new Error(`${label}: names differ only by case in ${dir}`);
  }
  return names;
}

function readSkill(dir, name, layer) {
  const label = `${layer}/${name}`;
  safeSegment(name, label);
  if (!SKILL_NAME.test(name)) throw new Error(`${label}: skill folder names must be letters, digits, and hyphens`);
  // Collecting first refuses links, so SKILL.md is never read through one.
  const files = collectFiles(dir, '', label);
  const skill = files.find((file) => file.path === 'SKILL.md');
  if (!skill) throw new Error(`${label}: a file named exactly SKILL.md is required`);
  const fields = frontmatterFields(skill.bytes, `${label}/SKILL.md`);
  if (fields.get('name') !== name) {
    throw new Error(`${label}: frontmatter name ${JSON.stringify(fields.get('name'))} must equal the folder name`);
  }
  return { name, files };
}

// A tolerant reader for name, description, and model lines. It is not a YAML parser. Bytes are
// copied unchanged, and each runtime parses its own frontmatter.
export function frontmatterFields(bytes, label) {
  const lines = bytes.toString('utf8').replace(/^﻿/, '').split(/\r?\n/);
  const end = lines.indexOf('---', 1);
  if (lines[0] !== '---' || end < 0) throw new Error(`${label}: needs a --- frontmatter block`);
  const fields = new Map();
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (match) fields.set(match[1], unquote(match[2].trim()));
  }
  if (fields.has('model')) throw new Error(`${label}: frontmatter model is not allowed; maxstack sets no model`);
  for (const key of ['name', 'description']) {
    if (!fields.get(key)) throw new Error(`${label}: frontmatter ${key} is missing or empty`);
  }
  return fields;
}

function unquote(value) {
  return /^(["'])(.*)\1$/.exec(value)?.[2] ?? value;
}

// Copies every file in a skill except node_modules. Symbolic links and junctions are refused.
function collectFiles(dir, prefix, label, files = []) {
  for (const entry of listEntries(dir, label)) {
    const relative = prefix ? `${prefix}/${entry}` : entry;
    const path = join(dir, entry);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error(`${label}: symbolic link or junction at ${relative}`);
    if (info.isDirectory()) {
      if (entry !== 'node_modules') collectFiles(path, relative, label, files);
    } else if (info.isFile()) {
      files.push({ path: safeRelativePath(relative, label), bytes: readFileSync(path) });
    } else {
      throw new Error(`${label}: unsupported entry ${relative}`);
    }
  }
  return files;
}
