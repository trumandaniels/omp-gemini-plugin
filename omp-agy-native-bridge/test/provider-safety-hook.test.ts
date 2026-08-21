import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { BLOCK_MARKER, decide } = require("../agents/omp-bridge-model/provider-safety-hook.cjs") as {
  BLOCK_MARKER: string;
  decide(input: unknown, env?: NodeJS.ProcessEnv): { decision: string; reason?: string };
};

const workspace = resolve(".provider-hook-workspace");
const mediaPath = resolve(workspace, ".omp-agy-media/image.png");

function hookInput(name: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    workspacePaths: [workspace],
    toolCall: { name, args },
  };
}

test("provider hook is inert outside bridge provider processes", () => {
  assert.deepEqual(decide(hookInput("send_message", {}), {}), { decision: "allow" });
});
test("provider hook allows only side-effect-free control probes", () => {
  for (const [name, args] of [
    ["manage_task", { Action: "list" }],
    ["manage_task", { Action: "status", TaskId: "task-1" }],
    ["manage_subagents", { Action: "list" }],
  ] as const) {
    assert.deepEqual(decide(hookInput(name, args), { OMP_AGY_PROVIDER_MODE: "1" }), { decision: "allow" });
  }
  for (const [name, args] of [
    ["send_message", { Recipient: "omp", Message: "continue" }],
    ["manage_task", { Action: "kill", TaskId: "task-1" }],
    ["manage_task", { Action: "send_input", TaskId: "task-1", Input: "continue" }],
    ["schedule", { DurationSeconds: 30, Prompt: "continue" }],
    ["define_subagent", { name: "worker" }],
    ["invoke_subagent", {}],
    ["run_command", {}],
  ] as const) {
    const result = decide(hookInput(name, args), { OMP_AGY_PROVIDER_MODE: "1" });
    assert.equal(result.decision, "deny");
    assert.match(result.reason ?? "", new RegExp(BLOCK_MARKER));
  }
});

test("provider hook allows only exact staged-media reads", () => {
  const env = {
    OMP_AGY_PROVIDER_MODE: "1",
    OMP_AGY_PROVIDER_MEDIA_PATHS: JSON.stringify([mediaPath]),
  };
  assert.deepEqual(decide(hookInput("view_files", { paths: [mediaPath] }), env), { decision: "allow" });
  assert.deepEqual(decide(hookInput("view_files", { paths: [resolve(workspace, "README.md")] }), env).decision, "deny");
  assert.deepEqual(decide(hookInput("write_to_file", { path: mediaPath }), env).decision, "deny");
});
