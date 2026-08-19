import assert from "node:assert/strict";
import test from "node:test";

import {
  assertProviderHarnessIsToolless,
  providerHarnessActivitySummary,
  uniqueAgyToolSteps,
} from "../src/harness-guard.ts";
import type { AgyStepUpdateEvent } from "../src/types.ts";

function toolEvent(state: string, stepIndex: number, name: string): AgyStepUpdateEvent {
  return {
    event: "step_update",
    step_update: {
      conversation_id: "conversation-1",
      step_index: stepIndex,
      state,
      step_type: "tool",
      tool_name: name,
      tool_info: { name, parameters: { path: "README.md" } },
    },
  };
}

test("uniqueAgyToolSteps collapses ACTIVE and DONE updates", () => {
  const updates = [
    toolEvent("ACTIVE", 1, "read_file"),
    toolEvent("DONE", 1, "read_file"),
    toolEvent("ACTIVE", 2, "codesearch"),
    toolEvent("DONE", 2, "codesearch"),
  ];
  assert.equal(uniqueAgyToolSteps(updates).length, 2);
  assert.equal(
    providerHarnessActivitySummary({ toolSteps: updates, subagents: [] }),
    "2 tool invocation(s) from 4 lifecycle update(s) [codesearch, read_file], 0 subagent(s)",
  );
});

test("assertProviderHarnessIsToolless names unexpected tools and repair action", () => {
  assert.throws(
    () =>
      assertProviderHarnessIsToolless(
        {
          toolSteps: [toolEvent("DONE", 1, "read_file")],
          subagents: [],
        },
        "omp-bridge-model",
      ),
    /read_file.*agy-install-agent.*fully restart OMP/,
  );
});

test("assertProviderHarnessIsToolless accepts an isolated run", () => {
  assert.doesNotThrow(() =>
    assertProviderHarnessIsToolless({ toolSteps: [], subagents: [] }, "omp-bridge-model"),
  );
});
