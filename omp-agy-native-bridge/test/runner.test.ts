import assert from "node:assert/strict";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AgyRunError, runAgy } from "../src/agy/runner.ts";

const fakeAgy = fileURLToPath(new URL("./fixtures/fake-agy", import.meta.url));

await chmod(fakeAgy, 0o755);

function baseRunOptions(prompt: string) {
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
  } as const;
}

test("runAgy parses official stream-json shape", async () => {
  const result = await runAgy({
    ...baseRunOptions("hello"),
    model: "fake-model",
    effort: "high",
    agent: "omp-bridge-model",
    schema: { type: "object" },
  });
  assert.equal(result.terminal.status, "SUCCESS");
  assert.deepEqual(result.terminal.structured_output, {
    response: "ok",
    host_requests: [],
  });
  assert.equal(result.toolSteps.length, 0);
  assert.equal(result.toolStepCount, 0);
  assert.equal(result.subagentCount, 0);
  assert.equal(result.eventCount, 3);
});

test("runAgy tolerates an exact duplicate terminal result", async () => {
  const result = await runAgy(baseRunOptions("FAKE:DUPLICATE_RESULT"));
  assert.equal(result.terminal.status, "SUCCESS");
  assert.equal(result.terminal.response, JSON.stringify({ response: "ok", host_requests: [] }));
  assert.equal(result.eventCount, 4);
});

test("runAgy rejects conflicting duplicate terminal results", async () => {
  await assert.rejects(
    runAgy(baseRunOptions("FAKE:CONFLICTING_RESULT")),
    /conflicting terminal result events/,
  );
});

test("runAgy transports prompts larger than the host argv budget through stdin", async () => {
  const result = await runAgy({
    ...baseRunOptions(`large-context\n${"x".repeat(300_000)}`),
    maxPromptBytes: 400_000,
  });
  assert.equal(result.terminal.status, "SUCCESS");
});

test("runAgy accepts successful plain-text responses without structured_output", async () => {
  const result = await runAgy(baseRunOptions("FAKE:PLAIN"));
  assert.equal(result.terminal.status, "SUCCESS");
  assert.equal(result.terminal.response, "plain provider response");
  assert.equal(result.terminal.structured_output, undefined);
  assert.equal(result.toolSteps.length, 0);
});

test("runAgy refuses prompts above the configured bridge byte limit", async () => {
  await assert.rejects(
    runAgy({
      ...baseRunOptions("x".repeat(101)),
      maxPromptBytes: 100,
    }),
    /above AGY_BRIDGE_MAX_PROMPT_BYTES/,
  );
});

test("runAgy captures nested Antigravity tool and subagent metadata", async () => {
  const result = await runAgy(baseRunOptions("FAKE:TOOL"));
  assert.equal(result.toolSteps.length, 1);
  assert.equal(result.toolStepCount, 1);
  assert.equal(result.subagents.length, 1);
  assert.equal(result.subagentCount, 1);
  assert.equal(result.subagents[0]?.role, "reviewer");
});

test("runAgy terminates the child when an event callback fails", async () => {
  await assert.rejects(
    runAgy({
      ...baseRunOptions("hello"),
      onEvent: () => {
        throw new Error("renderer disconnected");
      },
    }),
    /event callback failed: renderer disconnected/,
  );
});

test("runAgy rejects non-success terminal status", async () => {
  await assert.rejects(
    runAgy(baseRunOptions("FAKE:ERROR")),
    /agy failed: fake failure/,
  );
});

test("runAgy preserves terminal and complete activity counts on a failed provider turn", async () => {
  await assert.rejects(
    runAgy({
      ...baseRunOptions("FAKE:MISSING_OMP_RECIPIENT"),
      agent: "omp-bridge-model",
      schema: { type: "object" },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AgyRunError);
      assert.equal(error.status, "ERROR");
      assert.equal(error.terminal?.error, 'recipient "omp" not found');
      assert.equal(error.toolSteps.length, 2);
      assert.equal(error.toolStepCount, 2);
      assert.equal(error.toolSteps[0]?.step_update.tool_name, "send_message");
      assert.equal(error.subagents.length, 0);
      assert.equal(error.subagentCount, 0);
      assert.equal(error.eventCount, 4);
      assert.equal(error.terminal?.usage?.total_tokens, 7);
      return true;
    },
  );
});
