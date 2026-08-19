import assert from "node:assert/strict";
import test from "node:test";

import {
  DELEGATE_PROGRESS_LIMITS,
  DelegateProgressCollector,
} from "../src/delegate-progress.ts";
import type { AgyStepUpdateEvent } from "../src/types.ts";

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
