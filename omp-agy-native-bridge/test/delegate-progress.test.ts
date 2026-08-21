import assert from "node:assert/strict";
import test from "node:test";

import { AgyRunError } from "../src/agy/runner.ts";
import { runAgyDelegate } from "../src/delegate-tool.ts";
import {
  DELEGATE_PROGRESS_LIMITS,
  DelegateProgressCollector,
} from "../src/delegate-progress.ts";
import type { AgyRunOptions, AgyRunResult, AgyStepUpdateEvent } from "../src/types.ts";

function responseEvent(text: string): AgyStepUpdateEvent {
  return {
    event: "step_update",
    step_update: {
      conversation_id: "conversation-1",
      step_index: 1,
      state: "ACTIVE",
      step_type: "agent_response",
      text_delta: text,
    },
  };
}

function toolEvent(
  stepIndex: number,
  state: string,
  output: string,
  parameters: Record<string, unknown> = { path: "README.md" },
): AgyStepUpdateEvent {
  return {
    event: "step_update",
    step_update: {
      conversation_id: "conversation-1",
      step_index: stepIndex,
      state,
      step_type: "tool",
      tool_name: "read_file",
      tool_info: {
        name: "read_file",
        parameters,
        output,
      },
    },
  };
}

const runOptions: AgyRunOptions = {
  prompt: "Inspect the requested files and report the result.",
  cwd: "/workspace",
  binary: "agy",
  printTimeout: "5m",
  hardTimeoutMs: 300_000,
  sandbox: false,
  maxPromptBytes: 1_000_000,
  maxStderrBytes: 10_000,
  killGraceMs: 1_000,
  sanitizeAccountEnvironment: true,
};

const successfulRun: AgyRunResult = {
  terminal: {
    status: "SUCCESS",
    conversation_id: "conversation-real",
    response: "done",
  },
  events: [],
  stderr: "",
  exitCode: 0,
  signalCode: null,
  toolSteps: [],
  subagents: [],
};

function invalidTaskIdFailure(taskId: string, conversationId = "conversation-real"): AgyRunError {
  return new AgyRunError(`agy failed: invalid task ID format: "${taskId}"`, {
    status: "ERROR",
    terminal: {
      status: "ERROR",
      conversation_id: conversationId,
      error: `invalid task ID format: "${taskId}"`,
    },
  });
}

test("DelegateProgressCollector keeps a bounded response tail", () => {
  const collector = new DelegateProgressCollector();
  const long = "a".repeat(DELEGATE_PROGRESS_LIMITS.responseChars + 5_000);
  const updates = collector.ingest(responseEvent(long));

  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.text.length, DELEGATE_PROGRESS_LIMITS.responsePreviewChars);
  assert.match(updates[0]?.text ?? "", /^…/);
  assert.equal(collector.summary().progress.responseTruncated, true);
});

test("DelegateProgressCollector collapses ACTIVE and DONE lifecycle updates", () => {
  const collector = new DelegateProgressCollector();
  collector.ingest(toolEvent(7, "ACTIVE", "starting"));
  collector.ingest(toolEvent(7, "DONE", "finished"));

  const summary = collector.summary();
  assert.equal(summary.tools.length, 1);
  assert.equal(summary.tools[0]?.state, "DONE");
  assert.equal(summary.tools[0]?.output, "finished");
  assert.equal(summary.progress.omittedToolInvocations, 0);
});

test("DelegateProgressCollector bounds tool details and records overflow once per invocation", () => {
  const collector = new DelegateProgressCollector();
  collector.ingest(
    toolEvent(
      1,
      "DONE",
      "x".repeat(DELEGATE_PROGRESS_LIMITS.toolOutputChars + 500),
      { payload: "y".repeat(DELEGATE_PROGRESS_LIMITS.jsonDetailChars + 500) },
    ),
  );
  for (let index = 2; index <= DELEGATE_PROGRESS_LIMITS.toolInvocations + 2; index += 1) {
    collector.ingest(toolEvent(index, "ACTIVE", ""));
    collector.ingest(toolEvent(index, "DONE", ""));
  }

  const summary = collector.summary();
  assert.equal(summary.tools.length, DELEGATE_PROGRESS_LIMITS.toolInvocations);
  assert.equal(summary.progress.omittedToolInvocations, 2);
  assert.equal(String(summary.tools[0]?.output).length, DELEGATE_PROGRESS_LIMITS.toolOutputChars);
  assert.deepEqual(summary.tools[0]?.parameters && typeof summary.tools[0].parameters === "object"
    ? Object.keys(summary.tools[0].parameters as Record<string, unknown>).sort()
    : [], ["originalChars", "preview", "truncated"]);
});

test("DelegateProgressCollector deduplicates and bounds subagent metadata", () => {
  const collector = new DelegateProgressCollector();
  const event: AgyStepUpdateEvent = {
    event: "step_update",
    step_update: {
      conversation_id: "conversation-1",
      step_index: 1,
      state: "ACTIVE",
      step_type: "checkpoint",
      subagent_info: {
        subagents: [
          { role: "reviewer", conversation_id: "child-1" },
          { role: "reviewer", conversation_id: "child-1", log_uri: "updated" },
        ],
      },
    },
  };
  collector.ingest(event);

  for (let index = 2; index <= DELEGATE_PROGRESS_LIMITS.subagents + 2; index += 1) {
    collector.ingest({
      event: "step_update",
      step_update: {
        conversation_id: "conversation-1",
        step_index: index,
        state: "ACTIVE",
        step_type: "checkpoint",
        subagent_info: {
          subagents: [{ role: "worker", conversation_id: `child-${index}` }],
        },
      },
    });
  }

  const summary = collector.summary();
  assert.equal(summary.subagents.length, DELEGATE_PROGRESS_LIMITS.subagents);
  assert.equal(summary.progress.omittedSubagents, 2);
  assert.equal(summary.subagents[0]?.conversation_id, "child-1");
});

test("runAgyDelegate resumes the same conversation after a placeholder task ID failure", async () => {
  const calls: AgyRunOptions[] = [];
  const outcome = await runAgyDelegate(runOptions, async (options) => {
    calls.push(options);
    if (calls.length === 1) {
      throw new AgyRunError('agy failed: invalid task ID format: "dummy"', {
        status: "ERROR",
        terminal: {
          status: "ERROR",
          conversation_id: "conversation-real",
          error: 'invalid task ID format: "dummy"',
        },
      });
    }
    return successfulRun;
  });

  assert.equal(calls.length, 3);
  assert.match(calls[0]?.prompt ?? "", /Never invent a task ID/);
  assert.equal(calls[1]?.conversationId, "conversation-real");
  assert.match(calls[1]?.prompt ?? "", /"dummy" is not a real task ID/);
  assert.match(calls[1]?.prompt ?? "", /do not replay work already completed/);
  assert.match(calls[1]?.prompt ?? "", /Do not call manage_task again/);
  assert.equal(calls[2]?.conversationId, "conversation-real");
  assert.match(calls[2]?.prompt ?? "", /Return the complete requested result, not a status update/);
  assert.equal(outcome.recoveredInvalidTaskId, "dummy");
  assert.equal(outcome.invalidTaskIdRecoveries, 1);
  assert.equal(outcome.recoveryCompletionTurns, 1);
  assert.equal(outcome.result, successfulRun);
});

test("runAgyDelegate finishes after the corrected conversation invents more task IDs", async () => {
  const calls: AgyRunOptions[] = [];
  const invalidIds = ["task-placeholder", "dummy", "1"];
  const statusRun: AgyRunResult = {
    ...successfulRun,
    terminal: { ...successfulRun.terminal, response: "Status update on dictionary format support analysis." },
  };
  const completedRun: AgyRunResult = {
    ...successfulRun,
    terminal: { ...successfulRun.terminal, response: "Complete dictionary format support analysis." },
  };
  const outcome = await runAgyDelegate(runOptions, async (options) => {
    calls.push(options);
    const invalidId = invalidIds[calls.length - 1];
    if (invalidId) throw invalidTaskIdFailure(invalidId);
    return calls.length === 4 ? statusRun : completedRun;
  });

  assert.equal(calls.length, 5);
  assert.equal(calls[1]?.conversationId, "conversation-real");
  assert.equal(calls[2]?.conversationId, "conversation-real");
  assert.equal(calls[3]?.conversationId, "conversation-real");
  assert.equal(calls[4]?.conversationId, "conversation-real");
  assert.match(calls[1]?.prompt ?? "", /"task-placeholder" is not a real task ID/);
  assert.match(calls[2]?.prompt ?? "", /"dummy" is not a real task ID/);
  assert.match(calls[3]?.prompt ?? "", /"1" is not a real task ID/);
  assert.match(calls[4]?.prompt ?? "", /Return the complete requested result, not a status update/);
  assert.equal(outcome.recoveredInvalidTaskId, "task-placeholder");
  assert.equal(outcome.invalidTaskIdRecoveries, 3);
  assert.equal(outcome.recoveryCompletionTurns, 1);
  assert.equal(outcome.result, completedRun);
});

test("runAgyDelegate bounds repeated invalid task ID recovery", async () => {
  let calls = 0;
  const finalFailure = invalidTaskIdFailure("fourth");

  await assert.rejects(
    runAgyDelegate(runOptions, async () => {
      calls += 1;
      if (calls === 4) throw finalFailure;
      throw invalidTaskIdFailure(`invalid-${calls}`);
    }),
    (error: unknown) => error === finalFailure,
  );
  assert.equal(calls, 4);
});

test("runAgyDelegate does not replay work when the failed conversation cannot be resumed", async () => {
  let calls = 0;
  const failure = new AgyRunError('agy failed: invalid task ID format: "dummy"', {
    status: "ERROR",
    terminal: {
      status: "ERROR",
      error: 'invalid task ID format: "dummy"',
    },
  });

  await assert.rejects(
    runAgyDelegate(runOptions, async () => {
      calls += 1;
      throw failure;
    }),
    (error: unknown) => error === failure,
  );
  assert.equal(calls, 1);
});
