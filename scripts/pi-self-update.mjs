import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const refusal = (message, status = 2) => {
  process.stderr.write(`${message}\n`);
  process.exit(status);
};

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== 'update' || args[1] !== '--self') {
  refusal('Usage: pi update --self');
}

if (process.env.MAXSTACK_PI_BIN) {
  refusal('MAXSTACK_PI_BIN is set. Refusing to update an overridden Pi.');
}

const prefix = join(dirname(dirname(fileURLToPath(import.meta.url))), 'npm');
const manifest = join(prefix, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json');
if (!existsSync(manifest)) refusal(`Managed Pi package is missing at "${prefix}". Refusing to create a new install.`);
try {
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  if (pkg.name !== '@earendil-works/pi-coding-agent') refusal('Managed Pi package manifest has an unexpected name.');
} catch (error) {
  refusal(`Managed Pi package manifest is invalid: ${error.message}`);
}

const npmArgs = ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '@earendil-works/pi-coding-agent@latest'];
let npmCommand = 'npm';
if (process.platform === 'win32') {
  const envPath = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const currentDirectory = resolve(process.cwd()).toLowerCase();
  const npmCmd = envPath.split(';').map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry && isAbsolute(entry) && resolve(entry).toLowerCase() !== currentDirectory)
    .map((directory) => join(directory, 'npm.cmd'))
    .find((candidate) => existsSync(candidate));
  if (!npmCmd) refusal('npm.cmd was not found on PATH. Refusing to update selected local Pi.', 127);
  npmCommand = join(dirname(npmCmd), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npmCommand)) refusal('npm command-line entry point was not found. Refusing to update selected local Pi.', 127);
}
const result = spawnSync(process.platform === 'win32' ? process.execPath : npmCommand, process.platform === 'win32' ? [npmCommand, ...npmArgs] : npmArgs, {
  stdio: 'inherit',
  windowsHide: true,
  shell: false,
});
if (result.error) refusal(`Could not run npm: ${result.error.message}`, 127);
process.exit(result.status ?? 1);
