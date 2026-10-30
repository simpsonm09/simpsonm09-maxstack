import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { python, repoRoot } from './lib/installer-test-kit.mjs';

test('verifier accepts the shell-escaped apostrophe path and rejects a mismatched projection directory', { skip: !python }, () => {
  const base = mkdtempSync(join(tmpdir(), 'maxstack-copilot-verifier-'));
  const workspace = join(base, "O'Brien workspace");
  const bin = join(workspace, '.maxstack', 'bin');
  mkdirSync(bin, { recursive: true });
  try {
    const script = String.raw`
import hashlib, importlib.util, pathlib, sys
module_path, workspace_text = sys.argv[1:]
sys.path.insert(0, str(pathlib.Path(module_path).parent))
spec = importlib.util.spec_from_file_location('verifier', module_path)
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
workspace = pathlib.Path(workspace_text)
bin_dir = workspace / '.maxstack' / 'bin'
projection = workspace / '.maxstack' / 'copilot-instructions'
expected = str(projection).replace('\\', '/')
quoted = "'" + expected.replace("'", "'\\''") + "'"
sh = bin_dir / 'copilot.sh'
sh.write_text('export COPILOT_CUSTOM_INSTRUCTIONS_DIRS="' + '$' + '{COPILOT_CUSTOM_INSTRUCTIONS_DIRS:+' + '$' + '{COPILOT_CUSTOM_INSTRUCTIONS_DIRS},}"' + quoted + '\n', encoding='utf-8')
cmd = bin_dir / 'copilot.cmd'
fake = workspace / 'fake-copilot.exe'
fake.write_text('', encoding='utf-8')
cmd.write_text('set "AGENT_ACCESS_COPILOT_ASK=allow"\nset "COPILOT_CUSTOM_INSTRUCTIONS_DIRS=' + str(projection) + '"\n"' + str(fake) + '" --plugin-dir "' + str(workspace / 'plugin') + '" %*\n', encoding='utf-8')
lock = {'copilot': {'enabled': True, 'cmdSha256': hashlib.sha256(cmd.read_bytes()).hexdigest().upper(), 'shSha256': hashlib.sha256(sh.read_bytes()).hexdigest().upper()}, 'layers': [{'copilot': {'enabled': True, 'pluginDir': 'plugin'}}], 'owned': [{'path': '.maxstack/copilot-instructions/AGENTS.md', 'runtime': 'workspace-instructions', 'preserve': False}]}
failures = []
verifier.check_copilot(lock, workspace, failures)
assert not failures, failures
sh.write_text(sh.read_text(encoding='utf-8').replace(quoted, "'/different/path'"), encoding='utf-8')
lock['copilot']['shSha256'] = hashlib.sha256(sh.read_bytes()).hexdigest().upper()
failures = []
verifier.check_copilot(lock, workspace, failures)
assert any('copilot.sh does not project' in failure for failure in failures), failures
`;
    const result = spawnSync(python, ['-c', script, join(repoRoot, 'scripts', 'verify-workspace-install.py'), workspace], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
