import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { AgyRunError } from "../src/agy/runner.ts";
import { retryableRecipientOmpFailureToolNames } from "../src/provider-recovery.ts";
import type { AgyStepUpdateEvent } from "../src/types.ts";

function toolEvent(
  state: string,
  stepIndex: number,
  name: string,
  parameters: Record<string, unknown>,
): AgyStepUpdateEvent {
  return {
    event: "step_update",
    step_update: {
      conversation_id: "conversation-1",
      step_index: stepIndex,
      state,
      step_type: "tool",
      tool_name: name,
      tool_info: { name, parameters },
    },
  };
}

function recipientError(toolSteps: AgyStepUpdateEvent[] = [], subagents: Array<{ role?: string }> = []): AgyRunError {
  return new AgyRunError('agy failed: recipient "omp" not found', {
    exitCode: 1,
    status: "ERROR",
    terminal: {
      status: "ERROR",
      error: 'recipient "omp" not found',
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    },
    toolSteps,
    subagents,
  });
}

test("recipient OMP failure is retryable when AGY omitted tool lifecycle events", () => {
  assert.deepEqual(retryableRecipientOmpFailureToolNames(recipientError()), ["send_message"]);
});

test("recipient OMP failure collapses send_message lifecycle updates", () => {
  const events = [
    toolEvent("ACTIVE", 1, "send_message", { recipient: "omp", message: "answer" }),
    toolEvent("DONE", 1, "send_message", { recipient: "omp", message: "answer" }),
  ];
  assert.deepEqual(retryableRecipientOmpFailureToolNames(recipientError(events)), ["send_message"]);
});

test("recipient OMP failure permits an unrelated exact staged-media hydration read", () => {
  const cwd = process.cwd();
  const mediaPath = resolve(cwd, ".omp-agy-media-test/image-1.png");
  const events = [
    toolEvent("DONE", 1, "read_file", { path: mediaPath }),
    toolEvent("DONE", 2, "send_message", { to: "omp", message: "answer" }),
  ];
  assert.deepEqual(
    retryableRecipientOmpFailureToolNames(recipientError(events), { cwd, allowedMediaPaths: [mediaPath] }),
    ["send_message"],
  );
});

test("recipient OMP failure is not retryable with another workspace tool", () => {
  const events = [
    toolEvent("DONE", 1, "read_file", { path: "README.md" }),
    toolEvent("DONE", 2, "send_message", { recipient: "omp", message: "answer" }),
  ];
  assert.equal(retryableRecipientOmpFailureToolNames(recipientError(events)), undefined);
});

test("recipient OMP failure is not retryable when the tool targets another recipient", () => {
  const events = [toolEvent("DONE", 1, "send_message", { recipient: "reviewer", message: "answer" })];
  assert.equal(retryableRecipientOmpFailureToolNames(recipientError(events)), undefined);
});

test("recipient OMP failure is not retryable after any observed AGY subagent", () => {
  assert.equal(
    retryableRecipientOmpFailureToolNames(recipientError([], [{ role: "reviewer" }])),
    undefined,
  );
});

test("ordinary provider failures do not enter recipient recovery", () => {
  const error = new AgyRunError("agy failed: quota exhausted", {
    status: "ERROR",
    terminal: { status: "ERROR", error: "quota exhausted" },
  });
  assert.equal(retryableRecipientOmpFailureToolNames(error), undefined);
  assert.equal(retryableRecipientOmpFailureToolNames(new Error('recipient "omp" not found')), undefined);
});
