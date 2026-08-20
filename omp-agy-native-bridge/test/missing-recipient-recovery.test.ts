import assert from "node:assert/strict";
import test from "node:test";

import { AgyRunError, type AgyRunErrorDetails } from "../src/agy/runner.ts";
import { synthesizeMissingRecipientRecovery } from "../src/missing-recipient-recovery.ts";
import { runProviderAttempts } from "../src/provider-attempt.ts";
import type { SerializedTool } from "../src/schema.ts";
import type { AgyRunResult, AgyStepUpdateEvent } from "../src/types.ts";

function sendMessageParametersEvent(
  state: string,
  parameters: Record<string, unknown>,
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

function sendMessageEvent(
  state: string,
  recipient: string,
  message: string,
): AgyStepUpdateEvent {
  return sendMessageParametersEvent(state, { recipient, message });
}

function missingRecipientError(
  recipient: string,
  message: string,
  overrides: Partial<AgyRunErrorDetails> = {},
): AgyRunError {
  const errorMessage = `recipient "${recipient}" not found`;
  return new AgyRunError(`agy failed: ${errorMessage}`, {
    exitCode: 1,
    status: "ERROR",
    terminal: {
      status: "ERROR",
      error: errorMessage,
      usage: { input_tokens: 5, output_tokens: 1, thinking_tokens: 1, total_tokens: 7 },
    },
    toolSteps: [
      sendMessageEvent("ACTIVE", recipient, message),
      sendMessageEvent("DONE", recipient, message),
    ],
    subagents: [],
    ...overrides,
  });
}

function successfulResult(): AgyRunResult {
  return {
    terminal: {
      status: "SUCCESS",
      structured_output: { text: "ok", tool_calls: [], finish_reason: "stop" },
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    },
    events: [],
    stderr: "",
    exitCode: 0,
    signalCode: null,
    toolSteps: [],
    subagents: [],
  };
}

const batchTaskTool: SerializedTool = {
  name: "task",
  description: "Spawn OMP subagents",
  parameters: {
    type: "object",
    properties: {
      context: { type: "string" },
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: { task: { type: "string" } },
          required: ["task"],
        },
      },
    },
    required: ["context", "tasks"],
  },
};

const flatTaskTool: SerializedTool = {
  name: "task",
  description: "Spawn one OMP subagent",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string" },
      name: { type: "string" },
    },
    required: ["task"],
  },
};

test("failed send_message to OMP recovers only a valid bridge envelope", () => {
  const envelope = JSON.stringify({
    text: "The audit is complete.",
    tool_calls: [],
    finish_reason: "stop",
  });
  const result = synthesizeMissingRecipientRecovery(
    missingRecipientError("omp", envelope),
    "omp",
    [],
  );

  assert.deepEqual(result?.terminal.structured_output, {
    text: "The audit is complete.",
    tool_calls: [],
    finish_reason: "stop",
  });
  assert.equal(result?.toolSteps.length, 0);
  assert.equal(
    synthesizeMissingRecipientRecovery(
      missingRecipientError("omp", "plain final text"),
      "omp",
      [],
    ),
    undefined,
  );
});

test("failed send_message to subagent becomes an OMP batch task call", () => {
  const result = synthesizeMissingRecipientRecovery(
    missingRecipientError("subagent", "Audit the website UI and propose concrete fixes."),
    "subagent",
    [batchTaskTool],
  );

  assert.deepEqual(result?.terminal.structured_output, {
    text: "",
    tool_calls: [
      {
        name: "task",
        arguments: {
          context: "Delegated from the current parent OMP turn. Work in the current repository and complete the task exactly as requested.",
          tasks: [{ task: "Audit the website UI and propose concrete fixes." }],
        },
      },
    ],
    finish_reason: "tool_use",
  });
});

test("failed send_message to literal task becomes the real OMP task tool call", () => {
  const result = synthesizeMissingRecipientRecovery(
    missingRecipientError("task", "Audit the website UI and UX and return concrete fixes."),
    "task",
    [batchTaskTool],
  );

  assert.deepEqual(result?.terminal.structured_output, {
    text: "",
    tool_calls: [
      {
        name: "task",
        arguments: {
          context: "Delegated from the current parent OMP turn. Work in the current repository and complete the task exactly as requested.",
          tasks: [{ task: "Audit the website UI and UX and return concrete fixes." }],
        },
      },
    ],
    finish_reason: "tool_use",
  });
});

test("task recovery accepts AGY casing and nested parameter variants", () => {
  const taskText = "Inspect portal-shell.tsx and fix the UI distinction without running project-wide validation.";
  const error = missingRecipientError("task", "unused", {
    toolSteps: [
      sendMessageParametersEvent("ACTIVE", {
        Input: {
          Recipient: "task",
          Message: { Text: taskText },
        },
      }),
      sendMessageParametersEvent("DONE", {
        input: {
          recipient_name: "task",
          content: { text: taskText },
        },
      }),
    ],
  });

  const result = synthesizeMissingRecipientRecovery(error, "task", [batchTaskTool]);
  assert.deepEqual(result?.terminal.structured_output, {
    text: "",
    tool_calls: [
      {
        name: "task",
        arguments: {
          context: "Delegated from the current parent OMP turn. Work in the current repository and complete the task exactly as requested.",
          tasks: [{ task: taskText }],
        },
      },
    ],
    finish_reason: "tool_use",
  });
});

test("failed send_message to subagent respects the flat OMP task schema", () => {
  const result = synthesizeMissingRecipientRecovery(
    missingRecipientError("subagent", "Inspect portal-shell.tsx."),
    "subagent",
    [flatTaskTool],
  );

  assert.deepEqual(result?.terminal.structured_output, {
    text: "",
    tool_calls: [
      {
        name: "task",
        arguments: { task: "Inspect portal-shell.tsx." },
      },
    ],
    finish_reason: "tool_use",
  });
});

test("deterministic recovery refuses ambiguous, control-only, unsupported, or underivable task schemas", () => {
  const ambiguous = missingRecipientError("subagent", "first task", {
    toolSteps: [
      sendMessageEvent("ACTIVE", "subagent", "first task"),
      sendMessageEvent("DONE", "subagent", "second task"),
    ],
  });
  assert.equal(synthesizeMissingRecipientRecovery(ambiguous, "subagent", [batchTaskTool]), undefined);
  assert.equal(
    synthesizeMissingRecipientRecovery(
      missingRecipientError("subagent", "continue"),
      "subagent",
      [batchTaskTool],
    ),
    undefined,
  );
  assert.equal(
    synthesizeMissingRecipientRecovery(
      missingRecipientError("read", "package.json"),
      "read",
      [batchTaskTool],
    ),
    undefined,
  );
  assert.equal(
    synthesizeMissingRecipientRecovery(
      missingRecipientError("subagent", "Audit the UI"),
      "subagent",
      [],
    ),
    undefined,
  );

  const taskWithUnknownRequiredField: SerializedTool = {
    ...batchTaskTool,
    parameters: {
      ...batchTaskTool.parameters,
      properties: {
        ...(batchTaskTool.parameters.properties as Record<string, unknown>),
        mystery: { type: "string" },
      },
      required: ["context", "tasks", "mystery"],
    },
  };
  assert.equal(
    synthesizeMissingRecipientRecovery(
      missingRecipientError("task", "Audit the UI and return concrete fixes."),
      "task",
      [taskWithUnknownRequiredField],
    ),
    undefined,
  );
});

test("provider attempts short-circuit a proven subagent routing failure into OMP task", async () => {
  let calls = 0;
  const outcome = await runProviderAttempts({
    initialPrompt: "Have a subagent audit the UI",
    enforceToolless: true,
    agentName: "omp-bridge-model",
    ompTools: [batchTaskTool],
    invoke: async () => {
      calls += 1;
      throw missingRecipientError("subagent", "Audit the website UI and UX and return concrete fixes.");
    },
  });

  assert.equal(calls, 1);
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.discardedUsage.length, 1);
  assert.equal(outcome.discardedUsage[0]?.total_tokens, 7);
  assert.deepEqual(outcome.result.terminal.structured_output, {
    text: "",
    tool_calls: [
      {
        name: "task",
        arguments: {
          context: "Delegated from the current parent OMP turn. Work in the current repository and complete the task exactly as requested.",
          tasks: [{ task: "Audit the website UI and UX and return concrete fixes." }],
        },
      },
    ],
    finish_reason: "tool_use",
  });
});

test("provider attempts short-circuit recipient task with AGY parameter casing into OMP task", async () => {
  let calls = 0;
  const taskText = "Audit the website UI and UX and return concrete fixes without running project-wide validation.";
  const error = missingRecipientError("task", "unused", {
    toolSteps: [
      sendMessageParametersEvent("ACTIVE", { Recipient: "task", Message: taskText }),
      sendMessageParametersEvent("DONE", { Recipient: "task", Message: taskText }),
    ],
  });

  const outcome = await runProviderAttempts({
    initialPrompt: "Have a subagent audit the UI",
    enforceToolless: true,
    agentName: "omp-bridge-model",
    ompTools: [batchTaskTool],
    invoke: async () => {
      calls += 1;
      throw error;
    },
  });

  assert.equal(calls, 1);
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.discardedUsage.length, 1);
  assert.deepEqual(outcome.result.terminal.structured_output, {
    text: "",
    tool_calls: [
      {
        name: "task",
        arguments: {
          context: "Delegated from the current parent OMP turn. Work in the current repository and complete the task exactly as requested.",
          tasks: [{ task: taskText }],
        },
      },
    ],
    finish_reason: "tool_use",
  });
});

test("provider attempts can recover an exact bridge envelope addressed to OMP", async () => {
  let calls = 0;
  const envelope = JSON.stringify({
    text: "I found three UI issues.",
    tool_calls: [],
    finish_reason: "stop",
  });
  const outcome = await runProviderAttempts({
    initialPrompt: "Audit the project",
    enforceToolless: true,
    agentName: "omp-bridge-model",
    ompTools: [],
    invoke: async () => {
      calls += 1;
      throw missingRecipientError("omp", envelope);
    },
  });

  assert.equal(calls, 1);
  assert.equal(outcome.attempts, 1);
  assert.deepEqual(outcome.result.terminal.structured_output, {
    text: "I found three UI issues.",
    tool_calls: [],
    finish_reason: "stop",
  });
});

test("unsupported missing recipients keep the existing bounded retry path", async () => {
  let calls = 0;
  const outcome = await runProviderAttempts({
    initialPrompt: "Read package.json",
    enforceToolless: true,
    agentName: "omp-bridge-model",
    ompTools: [batchTaskTool],
    invoke: async () => {
      calls += 1;
      if (calls === 1) throw missingRecipientError("read", "package.json");
      return successfulResult();
    },
  });

  assert.equal(calls, 2);
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.result.terminal.status, "SUCCESS");
});
