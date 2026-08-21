import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { AgyRunError, type AgyRunErrorDetails } from "../src/agy/runner.ts";
import {
  retryablePermissionConversionTool,
  retryableProviderBoundaryDenial,
  runProviderAttempts,
} from "../src/provider-attempt.ts";
import { PROVIDER_TOOL_BLOCK_MARKER } from "../src/harness-guard.ts";
import type { AgyRunResult, AgyStepUpdateEvent } from "../src/types.ts";

const SCHEDULE_DIAGNOSTIC =
  "declaring permissions: cortex tool schedule: convert tool call for permissions: model output error: invalid tool call error (invalid_args) malformed schedule request";
const MANAGE_TASK_DIAGNOSTIC =
  "declaring permissions: cortex tool manage_task: convert tool call for permissions: model output error: invalid tool call error (invalid_args) malformed task request";
const PROVIDER_BOUNDARY_DIAGNOSTIC =
  `tool call denied by pre-tool hook: ${PROVIDER_TOOL_BLOCK_MARKER}: Provider mode forbids Antigravity-native actions.`;

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

test("classifies exact provider-hook denials as safe pre-execution failures", () => {
  assert.equal(
    retryableProviderBoundaryDenial(permissionConversionError(PROVIDER_BOUNDARY_DIAGNOSTIC)),
    true,
  );
  assert.equal(
    retryableProviderBoundaryDenial(
      permissionConversionError(PROVIDER_BOUNDARY_DIAGNOSTIC, { toolStepCount: 1 }),
    ),
    false,
  );
  assert.equal(
    retryableProviderBoundaryDenial(permissionConversionError("tool call denied by pre-tool hook: other hook")),
    false,
  );
});

test("runProviderAttempts retries an exact provider-hook denial", async () => {
  const prompts: string[] = [];
  const outcome = await runProviderAttempts({
    initialPrompt: "ORIGINAL",
    enforceToolless: true,
    agentName: "omp-bridge-model",
    invoke: async (prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) throw permissionConversionError(PROVIDER_BOUNDARY_DIAGNOSTIC);
      return successfulResult();
    },
  });
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.discardedUsage.length, 1);
  assert.match(prompts[1] ?? "", /Mandatory provider retry correction/);
});

test("provider-hook denial recovers a blocked host message after harmless control probes", async () => {
  const manageTask: AgyStepUpdateEvent = {
    event: "step_update",
    step_update: {
      step_index: 1,
      state: "DONE",
      step_type: "tool",
      tool_name: "manage_task",
      tool_info: { name: "manage_task", parameters: { Action: "list" }, output: "No tasks" },
    },
  };
  const sendMessage: AgyStepUpdateEvent = {
    event: "step_update",
    step_update: {
      step_index: 2,
      state: "ERROR",
      step_type: "tool",
      tool_name: "send_message",
      tool_info: {
        name: "send_message",
        parameters: { Recipient: "omp", Message: "Recovered provider answer" },
        error: { type: "TOOL_ERROR", message: PROVIDER_BOUNDARY_DIAGNOSTIC },
      },
    },
  };
  const outcome = await runProviderAttempts({
    initialPrompt: "ORIGINAL",
    enforceToolless: true,
    agentName: "omp-bridge-model",
    ompTools: [],
    invoke: async () => {
      throw permissionConversionError(PROVIDER_BOUNDARY_DIAGNOSTIC, {
        toolSteps: [manageTask, sendMessage],
        toolStepCount: 2,
      });
    },
  });
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.result.terminal.status, "SUCCESS");
  assert.deepEqual(outcome.result.terminal.structured_output, {
    text: "Recovered provider answer",
    tool_calls: [],
    finish_reason: "stop",
  });
});

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

test("runProviderAttempts retries a permission-conversion failure without echoing the tool name", async () => {
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
  assert.match(prompts[1] ?? "", /internal Antigravity action/i);
  assert.match(prompts[1] ?? "", /enforced terminal JSON object/i);
  assert.doesNotMatch(prompts[1] ?? "", /\bschedule\b/i);
});

test("runProviderAttempts recovers repeated manage_task failures without reinforcing manage_task", async () => {
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
  for (const prompt of prompts.slice(1)) assert.doesNotMatch(prompt, /manage_task/i);
  assert.match(prompts[2] ?? "", /Repeated provider transport correction/i);
  assert.match(prompts[3] ?? "", /safe recovery attempt 3/i);
});

test("different AGY permission failures remain de-salienced across retries", async () => {
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
  assert.doesNotMatch(prompts[1] ?? "", /\bschedule\b|manage_task/i);
  assert.doesNotMatch(prompts[2] ?? "", /\bschedule\b|manage_task/i);
  assert.match(prompts[2] ?? "", /Repeated provider transport correction/i);
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
