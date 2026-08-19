import assert from "node:assert/strict";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AgyRunError, runAgy } from "../src/agy/runner.ts";
import type { AgyRunOptions } from "../src/types.ts";

const fakeAgy = fileURLToPath(new URL("./fixtures/fake-agy", import.meta.url));

await chmod(fakeAgy, 0o755);

function options(prompt: string): AgyRunOptions {
  return {
    prompt,
    cwd: process.cwd(),
    binary: fakeAgy,
    printTimeout: "1m",
    hardTimeoutMs: 10_000,
    sandbox: true,
    maxPromptBytes: 100_000,
    maxStderrBytes: 10_000,
    killGraceMs: 100,
    sanitizeAccountEnvironment: true,
  };
}

test("runAgy parses official stream-json shape", async () => {
  const result = await runAgy({
    ...options("hello"),
    model: "fake-model",
    effort: "high",
    agent: "omp-bridge-model",
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
  const result = await runAgy(options("FAKE:PLAIN"));
  assert.equal(result.terminal.status, "SUCCESS");
  assert.equal(result.terminal.response, "plain provider response");
  assert.equal(result.terminal.structured_output, undefined);
  assert.equal(result.toolSteps.length, 0);
});

test("runAgy refuses oversized argv prompts", async () => {
  await assert.rejects(
    runAgy({ ...options("x".repeat(101)), maxPromptBytes: 100 }),
    /above AGY_BRIDGE_MAX_PROMPT_BYTES/,
  );
});

test("runAgy captures nested Antigravity tool and subagent metadata", async () => {
  const result = await runAgy(options("FAKE:TOOL"));
  assert.equal(result.toolSteps.length, 1);
  assert.equal(result.subagents.length, 1);
  assert.equal(result.subagents[0]?.role, "reviewer");
});

test("runAgy terminates the child when an event callback fails", async () => {
  await assert.rejects(
    runAgy({
      ...options("hello"),
      onEvent: () => {
        throw new Error("renderer disconnected");
      },
    }),
    /event callback failed: renderer disconnected/,
  );
});

test("runAgy rejects non-success terminal status", async () => {
  await assert.rejects(runAgy(options("FAKE:ERROR")), /agy failed: fake failure/);
});

test("AgyRunError retains failed tool lifecycle, terminal error, and usage", async () => {
  await assert.rejects(
    runAgy(options("FAKE:RECIPIENT_NOT_FOUND")),
    (error: unknown) => {
      assert.ok(error instanceof AgyRunError);
      assert.equal(error.status, "ERROR");
      assert.equal(error.terminal?.error, 'recipient "omp" not found');
      assert.equal(error.terminal?.usage?.total_tokens, 9);
      assert.equal(error.toolSteps.length, 2);
      assert.deepEqual(
        error.toolSteps.map((event) => event.step_update.state),
        ["ACTIVE", "DONE"],
      );
      assert.equal(error.toolSteps[0]?.step_update.tool_info?.name, "send_message");
      assert.equal(error.subagents.length, 0);
      assert.equal(error.events.some((event) => event.event === "result"), true);
      return true;
    },
  );
});
