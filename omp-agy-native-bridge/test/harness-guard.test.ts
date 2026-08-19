import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  assertProviderHarnessIsToolless,
  providerHarnessActivitySummary,
  retryableFailedProviderControlToolNames,
  retryableProviderControlToolNames,
  unexpectedProviderHarnessToolSteps,
  uniqueAgyToolSteps,
} from "../src/harness-guard.ts";
import type { AgyStepUpdateEvent } from "../src/types.ts";

function toolEvent(
  state: string,
  stepIndex: number,
  name: string,
  parameters: Record<string, unknown> = { path: "README.md" },
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

test("provider guard puts the exact AGY control tool before the long diagnostic", () => {
  assert.throws(
    () =>
      assertProviderHarnessIsToolless(
        {
          toolSteps: [
            toolEvent("ACTIVE", 7, "manage_subagents", { Action: "list" }),
            toolEvent("DONE", 7, "manage_subagents", { Action: "list" }),
          ],
          subagents: [],
        },
        "omp-bridge-model",
      ),
    /^Error: Forbidden AGY provider tool\(s\): manage_subagents\./,
  );
});

test("retryableProviderControlToolNames accepts only harmless list and status probes", () => {
  assert.deepEqual(
    retryableProviderControlToolNames([
      toolEvent("ACTIVE", 1, "manage_subagents", { Action: "list" }),
      toolEvent("DONE", 1, "manage_subagents", { Action: "list" }),
      toolEvent("DONE", 2, "manage_task", { action: "status", TaskId: "task-1" }),
    ]),
    ["manage_subagents", "manage_task"],
  );
});

test("retryableProviderControlToolNames rejects mutating AGY control actions", () => {
  for (const event of [
    toolEvent("DONE", 1, "manage_subagents", { Action: "kill_all" }),
    toolEvent("DONE", 1, "manage_task", { Action: "kill", TaskId: "task-1" }),
    toolEvent("DONE", 1, "manage_task", { Action: "send_input", TaskId: "task-1", Input: "x" }),
    toolEvent("DONE", 1, "define_subagent", { name: "Worker" }),
    toolEvent("DONE", 1, "invoke_subagent", { Subagents: [] }),
  ]) {
    assert.equal(retryableProviderControlToolNames([event]), undefined);
  }
});

test("retryableFailedProviderControlToolNames accepts a rejected send_message with no delivery", () => {
  const toolSteps = [
    toolEvent("ACTIVE", 4, "send_message", { to: "omp", message: "done" }),
    toolEvent("DONE", 4, "send_message", { to: "omp", message: "done" }),
  ];
  assert.deepEqual(
    retryableFailedProviderControlToolNames({
      message: 'agy failed: recipient "omp" not found',
      status: "ERROR",
      terminal: { status: "ERROR", error: 'recipient "omp" not found' },
      toolSteps,
      subagents: [],
    }),
    ["send_message"],
  );
});

test("retryableFailedProviderControlToolNames supports old AGY errors without tool lifecycle events", () => {
  assert.deepEqual(
    retryableFailedProviderControlToolNames({
      message: "agy failed",
      status: "ERROR",
      terminal: { status: "ERROR", error: "recipient 'omp' not found" },
      toolSteps: [],
      subagents: [],
    }),
    ["send_message"],
  );
});

test("retryableFailedProviderControlToolNames rejects ambiguous or unsafe failures", () => {
  const send = toolEvent("DONE", 1, "send_message", { to: "omp", message: "x" });
  const read = toolEvent("DONE", 2, "read_file", { path: "README.md" });
  const base = {
    message: 'agy failed: recipient "omp" not found',
    status: "ERROR",
    terminal: { status: "ERROR", error: 'recipient "omp" not found' },
    subagents: [] as unknown[],
  };
  assert.equal(
    retryableFailedProviderControlToolNames({ ...base, status: "SUCCESS", terminal: { status: "SUCCESS" }, toolSteps: [send] }),
    undefined,
  );
  assert.equal(
    retryableFailedProviderControlToolNames({ ...base, terminal: { status: "ERROR", error: "permission denied" }, toolSteps: [send] }),
    undefined,
  );
  assert.equal(
    retryableFailedProviderControlToolNames({ ...base, toolSteps: [send, read] }),
    undefined,
  );
  assert.equal(
    retryableFailedProviderControlToolNames({ ...base, toolSteps: [send], subagents: [{ role: "worker" }] }),
    undefined,
  );
});

test("assertProviderHarnessIsToolless allows duplicate read lifecycle events for an exact staged image", () => {
  const cwd = process.cwd();
  const mediaPath = resolve(cwd, ".omp-agy-media-test/image-1.png");
  const updates = [
    toolEvent("ACTIVE", 1, "read_file", { path: mediaPath }),
    toolEvent("DONE", 1, "read_file", { path: mediaPath }),
  ];
  assert.equal(
    unexpectedProviderHarnessToolSteps(updates, { cwd, allowedMediaPaths: [mediaPath] }).length,
    0,
  );
  assert.doesNotThrow(() =>
    assertProviderHarnessIsToolless(
      { toolSteps: updates, subagents: [] },
      "omp-bridge-model",
      { cwd, allowedMediaPaths: [mediaPath] },
    ),
  );
});

test("assertProviderHarnessIsToolless accepts a read of the private staged-media directory", () => {
  const cwd = process.cwd();
  const mediaPath = resolve(cwd, ".omp-agy-media-test/image-1.png");
  const mediaDirectory = resolve(cwd, ".omp-agy-media-test");
  assert.doesNotThrow(() =>
    assertProviderHarnessIsToolless(
      {
        toolSteps: [toolEvent("DONE", 1, "view_files", { paths: [mediaDirectory] })],
        subagents: [],
      },
      "omp-bridge-model",
      { cwd, allowedMediaPaths: [mediaPath] },
    ),
  );
});

test("assertProviderHarnessIsToolless rejects a read outside staged media", () => {
  const cwd = process.cwd();
  const mediaPath = resolve(cwd, ".omp-agy-media-test/image-1.png");
  assert.throws(
    () =>
      assertProviderHarnessIsToolless(
        {
          toolSteps: [toolEvent("DONE", 1, "read_file", { path: "README.md" })],
          subagents: [],
        },
        "omp-bridge-model",
        { cwd, allowedMediaPaths: [mediaPath] },
      ),
    /read_file.*agy-install-agent.*fully restart OMP/,
  );
});

test("assertProviderHarnessIsToolless rejects a write even when it targets staged media", () => {
  const cwd = process.cwd();
  const mediaPath = resolve(cwd, ".omp-agy-media-test/image-1.png");
  assert.throws(
    () =>
      assertProviderHarnessIsToolless(
        {
          toolSteps: [toolEvent("DONE", 1, "write_file", { path: mediaPath })],
          subagents: [],
        },
        "omp-bridge-model",
        { cwd, allowedMediaPaths: [mediaPath] },
      ),
    /write_file/,
  );
});

test("assertProviderHarnessIsToolless rejects a media read without a concrete file target", () => {
  const cwd = process.cwd();
  const mediaPath = resolve(cwd, ".omp-agy-media-test/image-1.png");
  assert.throws(
    () =>
      assertProviderHarnessIsToolless(
        {
          toolSteps: [toolEvent("DONE", 1, "read_image", { description: "the screenshot" })],
          subagents: [],
        },
        "omp-bridge-model",
        { cwd, allowedMediaPaths: [mediaPath] },
      ),
    /read_image/,
  );
});

test("assertProviderHarnessIsToolless rejects subagents even with safe media reads", () => {
  const cwd = process.cwd();
  const mediaPath = resolve(cwd, ".omp-agy-media-test/image-1.png");
  assert.throws(
    () =>
      assertProviderHarnessIsToolless(
        {
          toolSteps: [toolEvent("DONE", 1, "read_file", { path: mediaPath })],
          subagents: [{ role: "research" }],
        },
        "omp-bridge-model",
        { cwd, allowedMediaPaths: [mediaPath] },
      ),
    /1 subagent/,
  );
});

test("assertProviderHarnessIsToolless accepts an isolated run", () => {
  assert.doesNotThrow(() =>
    assertProviderHarnessIsToolless({ toolSteps: [], subagents: [] }, "omp-bridge-model"),
  );
});
