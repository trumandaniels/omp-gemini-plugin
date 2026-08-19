import assert from "node:assert/strict";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AgyRunError, runAgy } from "../src/agy/runner.ts";

const fakeAgy = fileURLToPath(new URL("./fixtures/fake-agy", import.meta.url));

await chmod(fakeAgy, 0o755);

test("runAgy parses official stream-json shape", async () => {
  const result = await runAgy({
    prompt: "hello",
    cwd: process.cwd(),
    binary: fakeAgy,
    model: "fake-model",
    effort: "high",
    agent: "omp-bridge-model",
    printTimeout: "1m",
    hardTimeoutMs: 10_000,
    sandbox: true,
    maxPromptBytes: 100_000,
    maxStderrBytes: 10_000,
    killGraceMs: 100,
    sanitizeAccountEnvironment: true,
    schema: { type: "object" },
  });
  assert.equal(result.terminal.status, "SUCCESS");
  assert.deepEqual(result.terminal.structured_output, {
    text: "ok",
    tool_calls: [],
    finish_reason: "stop",
  });
  assert.equal(result.toolSteps.length, 0);
});

test("runAgy accepts successful plain-text responses without structured_output", async () => {
  const result = await runAgy({
    prompt: "FAKE:PLAIN",
    cwd: process.cwd(),
    binary: fakeAgy,
    printTimeout: "1m",
    hardTimeoutMs: 10_000,
    sandbox: true,
    maxPromptBytes: 100_000,
    maxStderrBytes: 10_000,
    killGraceMs: 100,
    sanitizeAccountEnvironment: true,
  });
  assert.equal(result.terminal.status, "SUCCESS");
  assert.equal(result.terminal.response, "plain provider response");
  assert.equal(result.terminal.structured_output, undefined);
  assert.equal(result.toolSteps.length, 0);
});

test("runAgy refuses oversized argv prompts", async () => {
  await assert.rejects(
    runAgy({
      prompt: "x".repeat(101),
      cwd: process.cwd(),
      binary: fakeAgy,
      printTimeout: "1m",
      hardTimeoutMs: 10_000,
      sandbox: true,
      maxPromptBytes: 100,
      maxStderrBytes: 10_000,
      killGraceMs: 100,
      sanitizeAccountEnvironment: true,
    }),
    /above AGY_BRIDGE_MAX_PROMPT_BYTES/,
  );
});

test("runAgy captures nested Antigravity tool and subagent metadata", async () => {
  const result = await runAgy({
    prompt: "FAKE:TOOL",
    cwd: process.cwd(),
    binary: fakeAgy,
    printTimeout: "1m",
    hardTimeoutMs: 10_000,
    sandbox: true,
    maxPromptBytes: 100_000,
    maxStderrBytes: 10_000,
    killGraceMs: 100,
    sanitizeAccountEnvironment: true,
  });
  assert.equal(result.toolSteps.length, 1);
  assert.equal(result.subagents.length, 1);
  assert.equal(result.subagents[0]?.role, "reviewer");
});

test("runAgy preserves terminal and tool events on a failed recipient lookup", async () => {
  let caught: unknown;
  try {
    await runAgy({
      prompt: "FAKE:RECIPIENT_OMP",
      cwd: process.cwd(),
      binary: fakeAgy,
      printTimeout: "1m",
      hardTimeoutMs: 10_000,
      sandbox: true,
      maxPromptBytes: 100_000,
      maxStderrBytes: 10_000,
      killGraceMs: 100,
      sanitizeAccountEnvironment: true,
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof AgyRunError);
  assert.match(caught.message, /recipient "omp" not found/);
  assert.equal(caught.terminal?.status, "ERROR");
  assert.equal(caught.terminal?.error, 'recipient "omp" not found');
  assert.equal(caught.toolSteps.length, 2);
  assert.equal(caught.toolSteps[0]?.step_update.tool_info?.name, "send_message");
  assert.equal(caught.subagents.length, 0);
  assert.equal(caught.terminal?.usage?.input_tokens, 12);
});

test("runAgy terminates the child when an event callback fails", async () => {
  await assert.rejects(
    runAgy({
      prompt: "hello",
      cwd: process.cwd(),
      binary: fakeAgy,
      printTimeout: "1m",
      hardTimeoutMs: 10_000,
      sandbox: true,
      maxPromptBytes: 100_000,
      maxStderrBytes: 10_000,
      killGraceMs: 100,
      sanitizeAccountEnvironment: true,
      onEvent: () => {
        throw new Error("renderer disconnected");
      },
    }),
    /event callback failed: renderer disconnected/,
  );
});

test("runAgy rejects non-success terminal status", async () => {
  await assert.rejects(
    runAgy({
      prompt: "FAKE:ERROR",
      cwd: process.cwd(),
      binary: fakeAgy,
      printTimeout: "1m",
      hardTimeoutMs: 10_000,
      sandbox: true,
      maxPromptBytes: 100_000,
      maxStderrBytes: 10_000,
      killGraceMs: 100,
      sanitizeAccountEnvironment: true,
    }),
    /agy failed: fake failure/,
  );
});
