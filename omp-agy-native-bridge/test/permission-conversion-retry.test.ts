import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { AgyRunError, type AgyRunErrorDetails } from "../src/agy/runner.ts";
import {
  retryablePermissionConversionTool,
  runProviderAttempts,
} from "../src/provider-attempt.ts";
import type { AgyRunResult, AgyStepUpdateEvent } from "../src/types.ts";

const SCHEDULE_DIAGNOSTIC =
  "declaring permissions: cortex tool schedule: convert tool call for permissions: model output error: invalid tool call error (invalid_args) malformed schedule request";
const MANAGE_TASK_DIAGNOSTIC =
  "declaring permissions: cortex tool manage_task: convert tool call for permissions: model output error: invalid tool call error (invalid_args) malformed task request";

function permissionConversionError(
  diagnostic = SCHEDULE_DIAGNOSTIC,
  overrides: Partial<AgyRunErrorDetails> = {},
): AgyRunError {
  return new AgyRunError(`agy failed: ${diagnostic}`, {
    exitCode: 0,
    status: "ERROR",
    terminal: {
      status: "ERROR",
      error: diagnostic,
      usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
    },
    toolSteps: [],
    subagents: [],
    toolStepCount: 0,
    subagentCount: 0,
    ...overrides,
  });
}

function successfulResult(): AgyRunResult {
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
    toolSteps: [],
    subagents: [],
    toolStepCount: 0,
    subagentCount: 0,
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

test("classifies AGY schedule permission-conversion failures as retryable", () => {
  assert.equal(retryablePermissionConversionTool(permissionConversionError()), "schedule");
});

test("classifies future AGY tool names when permission conversion failed before execution", () => {
  const diagnostic =
    "declaring permissions: cortex tool future_control_tool: convert tool call for permissions: model output error: invalid tool call error (invalid_args) bad request";
  assert.equal(retryablePermissionConversionTool(permissionConversionError(diagnostic)), "future_control_tool");
});

test("permission-conversion recovery fails closed on truncated activity or subagents", () => {
  assert.equal(
    retryablePermissionConversionTool(permissionConversionError(SCHEDULE_DIAGNOSTIC, { toolStepCount: 1 })),
    undefined,
  );
  assert.equal(
    retryablePermissionConversionTool(
      permissionConversionError(SCHEDULE_DIAGNOSTIC, {
        subagents: [{ role: "worker", conversation_id: "child-1" }],
        subagentCount: 1,
      }),
    ),
    undefined,
  );
});

test("permission-conversion recovery rejects unrelated AGY tool activity", () => {
  assert.equal(
    retryablePermissionConversionTool(
      permissionConversionError(SCHEDULE_DIAGNOSTIC, {
        toolSteps: [readFileEvent("README.md")],
        toolStepCount: 1,
      }),
    ),
    undefined,
  );
});

test("permission-conversion recovery permits only exact staged-media hydration reads", () => {
  const cwd = process.cwd();
  const mediaPath = resolve(cwd, ".omp-agy-media-test/image-1.png");
  const error = permissionConversionError(SCHEDULE_DIAGNOSTIC, {
    toolSteps: [readFileEvent(mediaPath)],
    toolStepCount: 1,
  });

  assert.equal(
    retryablePermissionConversionTool(error, { cwd, allowedMediaPaths: [mediaPath] }),
    "schedule",
  );
});

test("runProviderAttempts retries a permission-conversion failure and succeeds", async () => {
  const prompts: string[] = [];
  let calls = 0;
  const outcome = await runProviderAttempts({
    initialPrompt: "original OMP provider prompt",
    enforceToolless: true,
    agentName: "omp-bridge-model",
    invoke: async (prompt) => {
      prompts.push(prompt);
      calls += 1;
      if (calls === 1) throw permissionConversionError();
      return successfulResult();
    },
  });

  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.discardedUsage.length, 1);
  assert.equal(outcome.result.terminal.status, "SUCCESS");
  assert.equal(prompts[0], "original OMP provider prompt");
  assert.match(prompts[1] ?? "", /forbidden Antigravity control tool\(s\): schedule/i);
  assert.match(prompts[1] ?? "", /Do not invoke any Antigravity tool on this retry/i);
});

test("runProviderAttempts recovers repeated manage_task permission-conversion failures", async () => {
  const prompts: string[] = [];
  let calls = 0;
  const outcome = await runProviderAttempts({
    initialPrompt: "original OMP provider prompt",
    enforceToolless: true,
    agentName: "omp-bridge-model",
    invoke: async (prompt) => {
      prompts.push(prompt);
      calls += 1;
      if (calls <= 3) throw permissionConversionError(MANAGE_TASK_DIAGNOSTIC);
      return successfulResult();
    },
  });

  assert.equal(outcome.attempts, 4);
  assert.equal(outcome.discardedUsage.length, 3);
  assert.equal(outcome.result.terminal.status, "SUCCESS");
  assert.match(prompts[1] ?? "", /manage_task/i);
  assert.match(prompts[2] ?? "", /Repeated provider transport correction/i);
  assert.match(prompts[3] ?? "", /safe recovery attempt 3/i);
});

test("permission-conversion recovery accumulates different AGY tool names", async () => {
  const prompts: string[] = [];
  let calls = 0;
  const outcome = await runProviderAttempts({
    initialPrompt: "prompt",
    enforceToolless: true,
    agentName: "omp-bridge-model",
    invoke: async (prompt) => {
      prompts.push(prompt);
      calls += 1;
      if (calls === 1) throw permissionConversionError(SCHEDULE_DIAGNOSTIC);
      if (calls === 2) throw permissionConversionError(MANAGE_TASK_DIAGNOSTIC);
      return successfulResult();
    },
  });

  assert.equal(outcome.attempts, 3);
  assert.equal(outcome.discardedUsage.length, 2);
  assert.match(prompts[2] ?? "", /manage_task, schedule|schedule, manage_task/i);
});

test("runProviderAttempts bounds repeated permission-conversion recovery", async () => {
  let calls = 0;
  await assert.rejects(
    runProviderAttempts({
      initialPrompt: "prompt",
      enforceToolless: true,
      agentName: "omp-bridge-model",
      invoke: async () => {
        calls += 1;
        throw permissionConversionError(MANAGE_TASK_DIAGNOSTIC);
      },
    }),
    /cortex tool manage_task/i,
  );
  assert.equal(calls, 4);
});
