#!/usr/bin/env node
// The OpenCode CLI may start a service process that inherits its standard handles.
// This test gives the stand-in CLI a lingering child and runs the verifier with
// stdout as a pipe. The verifier itself must still exit promptly.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts", "verify-opencode-workspace.ps1");
const PROMPT_EXIT_MS = 5_000;
const RUN_CEILING_MS = 30_000;

function findPwsh() {
  for (const name of ["pwsh", "powershell"]) {
    if (spawnSync(name, ["-NoProfile", "-Command", "exit 0"], { windowsHide: true }).status === 0)
      return name;
  }
  return null;
}

const pwsh = findPwsh();

function plainOutput(value) {
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte is the ANSI colour code being removed
      .replace(/\x1B\[[0-9;]*m/g, "")
      .replace(/\s*\|\s*/g, " ")
      .replace(/\s+/g, " ")
  );
}

function powerShellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runWithPipedOutput(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(pwsh, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const started = Date.now();
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    const ceiling = setTimeout(() => {
      // This is the exact verifier process started by this test, not a shared server.
      child.kill();
      rejectRun(
        new Error(
          `the verifier PID ${child.pid} did not exit within ${RUN_CEILING_MS} ms`,
        ),
      );
    }, RUN_CEILING_MS);
    child.once("error", (error) => {
      clearTimeout(ceiling);
      rejectRun(error);
    });
    // Do not wait for 'close': the stand-in's child deliberately keeps inherited
    // handles open. 'exit' is the property the verifier must guarantee.
    child.once("exit", (code, signal) => {
      clearTimeout(ceiling);
      resolveRun({
        code,
        signal,
        stdout,
        stderr,
        elapsed: Date.now() - started,
      });
    });
  });
}

test("the workspace verifier exits promptly with stdout piped when OpenCode leaves a child behind", {
  skip: pwsh ? false : "pwsh is not available",
}, async () => {
  const base = mkdtempSync(join(tmpdir(), "opencode-workspace-check-"));
  const workspace = join(base, "workspace");
  const fake = join(base, "fake-opencode.ps1");
  try {
    mkdirSync(join(workspace, ".opencode"), { recursive: true });
    writeFileSync(join(workspace, "opencode.jsonc"), "{}\n");
    const sources = JSON.stringify([
      { path: join(workspace, "opencode.jsonc") },
      { path: join(workspace, ".opencode") },
    ]);
    const agents = JSON.stringify(
      ["pstack-agent", "pstack-reviewer", "pstack-comment-sicko"].map((id) => ({
        id,
      })),
    );
    writeFileSync(
      fake,
      [
        // This gets no redirected handles of its own, so it holds whichever ones the
        // fake CLI inherited. It exits soon enough to leave no lasting process.
        "$hostPath = (Get-Process -Id $PID).Path",
        "Start-Process -FilePath $hostPath -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 8') | Out-Null",
        "if ($args -contains 'config') {",
        `    Write-Output ${powerShellLiteral(sources)}`,
        "} else {",
        `    Write-Output ${powerShellLiteral(agents)}`,
        "}",
      ].join("\n"),
    );

    const run = await runWithPipedOutput([
      "-NoProfile",
      "-NonInteractive",
      "-File",
      script,
      "-Workspace",
      workspace,
      "-OpenCodeBinary",
      fake,
      "-CallTimeoutSeconds",
      "10",
    ]);
    assert.equal(run.signal, null, `${run.stdout}\n${run.stderr}`);
    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
    assert.ok(
      run.elapsed < PROMPT_EXIT_MS,
      `the verifier took ${run.elapsed} ms with stdout piped`,
    );
    assert.match(
      plainOutput(`${run.stdout}\n${run.stderr}`),
      /PASS: OpenCode resolves the workspace config/,
    );
  } finally {
    // The fake's child has an eight-second lifetime; defer cleanup until it releases
    // its inherited files instead of killing a process this test did not directly start.
    setTimeout(
      () => rmSync(base, { recursive: true, force: true }),
      9_000,
    ).unref();
  }
});
