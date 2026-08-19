import assert from "node:assert/strict";
import { chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AgyRunError, runAgy, type AgyRunErrorDetails } from "../src/agy/runner.ts";
import {
  isRetryableMissingOmpRecipientError,
  runProviderAttempts,
} from "../src/provider-attempt.ts";
import type { AgyRunResult, AgyStepUpdateEvent } from "../src/types.ts";

const fakeAgy = fileURLToPath(new URL("./fixtures/fake-agy", import.meta.url));
await chmod(fakeAgy, 0o755);

function sendMessageEvent(
  state: string,
  parameters: Record<string, unknown> = { recipient: "omp", message: "continue" },
): AgyStepUpdateEvent {
  return {
    event: "step_update",
    step_update: {
      conversation_id: "conversation-1",
      step_index: 7,
      state,
      step_type: "tool",
      tool_name: "send_message",
      tool_info: {
        name: "send_message",
        parameters,
      },
    },
  };
}

function readFileEvent(path: string): AgyStepUpdateEvent {
  return {
    event: "step_update",
    step_update: {
      conversation_id: "conversation-1",
      step_index: 6,
      state: "DONE",
      step_type: "tool",
      tool_name: "read_file",
      tool_info: { name: "read_file", parameters: { path } },
    },
  };
}

function missingRecipientError(overrides: Partial<AgyRunErrorDetails> = {}): AgyRunError {
  return new AgyRunError('agy failed: recipient "omp" not found', {
    exitCode: 1,
    status: "ERROR",
    terminal: {
      status: "ERROR",
      error: 'recipient "omp" not found',
      usage: { input_tokens: 5, output_tokens: 1, thinking_tokens: 1, total_tokens: 7 },
    },
    toolSteps: [sendMessageEvent("ACTIVE"), sendMessageEvent("DONE")],
    subagents: [],
    ...overrides,
  });
}

function successfulResult(toolSteps: AgyStepUpdateEvent[] = []): AgyRunResult {
  return {
    terminal: {
      status: "SUCCESS",
      response: "ok",
      structured_output: { text: "ok", tool_calls: [], finish_reason: "stop" },
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    },
    events: [],
    stderr: "",
    exitCode: 0,
    signalCode: null,
    toolSteps,
    subagents: [],
  };
}

test("runProviderAttempts recovers the exact missing OMP recipient failure once", async () => {
  const outcome = await runProviderAttempts({
    initialPrompt: "FAKE:MISSING_OMP_RECIPIENT",
    enforceToolless: true,
    agentName: "omp-bridge-model",
    invoke: (prompt) =>
      runAgy({
        prompt,
        cwd: process.cwd(),
        binary: fakeAgy,
        agent: "omp-bridge-model",
        printTimeout: "1m",
        hardTimeoutMs: 10_000,
        sandbox: true,
        maxPromptBytes: 100_000,
        maxStderrBytes: 10_000,
        killGraceMs: 100,
        sanitizeAccountEnvironment: true,
        schema: { type: "object" },
      }),
  });

  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.discardedUsage.length, 1);
  assert.equal(outcome.discardedUsage[0]?.total_tokens, 7);
  assert.deepEqual(outcome.result.terminal.structured_output, {
    text: "recovered without AGY messaging",
    tool_calls: [],
    finish_reason: "stop",
  });
});

test("missing-recipient classification accepts an exact OMP send with scoped media hydration", () => {
  const cwd = process.cwd();
  const mediaPath = resolve(cwd, ".omp-agy-media-test/image-1.png");
  const error = missingRecipientError({
    toolSteps: [
      readFileEvent(mediaPath),
      sendMessageEvent("ACTIVE"),
      sendMessageEvent("DONE"),
    ],
  });

  assert.equal(
    isRetryableMissingOmpRecipientError(error, { cwd, allowedMediaPaths: [mediaPath] }),
    true,
  );
});

test("missing-recipient classification accepts an exact terminal failure without a lifecycle event", () => {
  assert.equal(
    isRetryableMissingOmpRecipientError(missingRecipientError({ toolSteps: [], toolStepCount: 0 })),
    true,
  );
});

test("missing-recipient classification rejects other, mixed, or unspecified recipients", () => {
  for (const parameters of [
    { recipient: "parent", message: "continue" },
    { to: "main", message: "continue" },
    { recipients: ["omp", "reviewer"], message: "continue" },
    { message: "continue" },
  ]) {
    assert.equal(
      isRetryableMissingOmpRecipientError(
        missingRecipientError({ toolSteps: [sendMessageEvent("DONE", parameters)] }),
      ),
      false,
    );
  }
});

test("missing-recipient classification rejects unrelated or incomplete AGY activity", () => {
  assert.equal(isRetryableMissingOmpRecipientError(missingRecipientError()), true);
  assert.equal(
    isRetryableMissingOmpRecipientError(
      missingRecipientError({
        toolSteps: [
          {
            ...sendMessageEvent("DONE"),
            step_update: {
              ...sendMessageEvent("DONE").step_update,
              tool_name: "read_file",
              tool_info: { name: "read_file", parameters: { path: "README.md" } },
            },
          },
        ],
      }),
    ),
    false,
  );
  assert.equal(
    isRetryableMissingOmpRecipientError(
      missingRecipientError({ subagents: [{ role: "worker", conversation_id: "child-1" }] }),
    ),
    false,
  );
  assert.equal(
    isRetryableMissingOmpRecipientError(missingRecipientError({ toolStepCount: 501 })),
    false,
  );
  assert.equal(
    isRetryableMissingOmpRecipientError(missingRecipientError({ subagentCount: 1 })),
    false,
  );
});

test("runProviderAttempts forwards staged-media guard options to recipient recovery", async () => {
  const cwd = process.cwd();
  const mediaPath = resolve(cwd, ".omp-agy-media-test/image-1.png");
  let calls = 0;
  const outcome = await runProviderAttempts({
    initialPrompt: "prompt",
    enforceToolless: true,
    agentName: "omp-bridge-model",
    guardOptions: { cwd, allowedMediaPaths: [mediaPath] },
    invoke: async () => {
      calls += 1;
      if (calls === 1) {
        throw missingRecipientError({
          toolSteps: [readFileEvent(mediaPath), sendMessageEvent("DONE")],
        });
      }
      return successfulResult();
    },
  });

  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.result.terminal.status, "SUCCESS");
});

test("runProviderAttempts never performs a third AGY attempt", async () => {
  let calls = 0;
  await assert.rejects(
    runProviderAttempts({
      initialPrompt: "prompt",
      enforceToolless: true,
      agentName: "omp-bridge-model",
      invoke: async () => {
        calls += 1;
        throw missingRecipientError();
      },
    }),
    /recipient "omp" not found/,
  );
  assert.equal(calls, 2);
});

test("runProviderAttempts retries a successful read-only AGY control probe once", async () => {
  let calls = 0;
  const listEvent: AgyStepUpdateEvent = {
    event: "step_update",
    step_update: {
      conversation_id: "conversation-1",
      step_index: 1,
      state: "DONE",
      step_type: "tool",
      tool_name: "manage_subagents",
      tool_info: { name: "manage_subagents", parameters: { Action: "list" } },
    },
  };

  const outcome = await runProviderAttempts({
    initialPrompt: "prompt",
    enforceToolless: true,
    agentName: "omp-bridge-model",
    invoke: async () => {
      calls += 1;
      return calls === 1 ? successfulResult([listEvent]) : successfulResult();
    },
  });

  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.discardedUsage.length, 1);
});

test("runProviderAttempts does not retry a control probe from a truncated snapshot", async () => {
  let calls = 0;
  const result = successfulResult([
    {
      event: "step_update",
      step_update: {
        conversation_id: "conversation-1",
        step_index: 1,
        state: "DONE",
        step_type: "tool",
        tool_name: "manage_subagents",
        tool_info: { name: "manage_subagents", parameters: { Action: "list" } },
      },
    },
  ]);
  result.toolStepCount = 501;

  await assert.rejects(
    runProviderAttempts({
      initialPrompt: "prompt",
      enforceToolless: true,
      agentName: "omp-bridge-model",
      invoke: async () => {
        calls += 1;
        return result;
      },
    }),
    /activity snapshots were truncated/,
  );
  assert.equal(calls, 1);
});
