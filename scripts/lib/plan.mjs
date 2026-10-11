import { jsonBytes } from './json.mjs';
import { compareUtf8 } from './paths.mjs';

export const RUNTIMES = ['claude', 'copilot', 'opencode', 'pi'];

// Returns the complete generated tree for one runtime as Map<path, {bytes, layers}>.
// Every path is relative to the output directory. Nothing is written here.
export function planGeneration(runtime, layers) {
  if (!RUNTIMES.includes(runtime)) {
    throw new Error(`unsupported runtime ${JSON.stringify(runtime)}; expected ${RUNTIMES.join(', ')}`);
  }
  const files = new Map();
  const bareNames = new Set();
  for (const layer of layers) {
    if (runtime === 'claude' || runtime === 'copilot') {
      addFile(files, `.claude/plugins/${layer.name}/.claude-plugin/plugin.json`, jsonBytes({ name: layer.name }), [layer.name]);
    }
    for (const skill of layer.skills) {
      if (runtime === 'opencode' || runtime === 'pi') claimBareName(bareNames, skill.name);
      const base = skillBase(runtime, layer.name);
      for (const file of skill.files) addFile(files, `${base}/${skill.name}/${file.path}`, file.bytes, [layer.name]);
    }
  }
  projectServers(runtime, layers, files);
  return files;
}

function skillBase(runtime, layer) {
  if (runtime === 'opencode') return '.opencode/skills';
  if (runtime === 'pi') return '.pi/agent/skills';
  return `.claude/plugins/${layer}/skills`;
}

// OpenCode and Pi discover skills by bare name, so two layers cannot share one, even by case.
function claimBareName(names, skill) {
  const key = skill.toLowerCase();
  if (names.has(key)) throw new Error(`duplicate skill ${skill} across layers`);
  names.add(key);
}

function addFile(files, path, bytes, layers) {
  if (files.has(path)) throw new Error(`generated path collision at ${path}`);
  files.set(path, { bytes, layers });
}

// Later layers override earlier servers with the same name. Only OpenCode projects MCP.
// Claude, Copilot, and Pi refuse any server until their delivery is verified.
function projectServers(runtime, layers, files) {
  const merged = new Map();
  const foldedNames = new Map();
  const contributors = [];
  for (const layer of layers) {
    if (layer.servers.size) contributors.push(layer.name);
    for (const [name, server] of layer.servers) {
      const folded = name.toLowerCase();
      if (foldedNames.has(folded) && foldedNames.get(folded) !== name) {
        throw new Error(`MCP server case collision: ${foldedNames.get(folded)} and ${name}`);
      }
      foldedNames.set(folded, name);
      merged.set(name, server);
    }
  }
  if (!merged.size) return;
  if (runtime !== 'opencode') {
    throw new Error(`nonempty MCP is not projected for ${runtime}: its delivery is unverified; remove the servers or target opencode`);
  }
  const servers = Object.fromEntries([...merged].sort(([left], [right]) => compareUtf8(left, right)));
  files.set('opencode.jsonc', { bytes: jsonBytes({ mcp: { servers } }), layers: contributors });
}
