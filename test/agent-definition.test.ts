import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const agentPath = fileURLToPath(new URL("../agents/omp-bridge-model/agent.md", import.meta.url));

const AGY_CONTROL_NAMES = [
  "manage_task",
  "manage_subagents",
  "manage_inbox",
  "define_subagent",
  "invoke_subagent",
  "send_message",
] as const;

test("bundled provider agent opts out of all user customizations", async () => {
  const source = await readFile(agentPath, "utf8");
  assert.match(source, /^tools:\s*\[\]\s*$/m);
  assert.match(source, /^subagent:\s*false\s*$/m);
  assert.match(source, /^commandExecutionPolicy:\s*off\s*$/m);
  assert.match(source, /^inheritCustomizations:\s*false\s*$/m);
  assert.match(source, /^inherit_user:\s*false\s*$/m);
  assert.match(source, /^inheritMcp:\s*false\s*$/m);
  assert.match(source, /^mcpServers:\s*\[\]\s*$/m);
  assert.match(source, /^skills:\s*\[\]\s*$/m);
  assert.match(source, /^plugins:\s*\[\]\s*$/m);
  assert.match(source, /^rules:\s*\[\]\s*$/m);
});

test("bundled provider agent makes Antigravity transport-only", async () => {
  const source = await readFile(agentPath, "utf8");
  assert.match(source, /Antigravity is transport only/);
  assert.match(source, /Never invoke any Antigravity-native action/);
  assert.match(source, /Do not attempt to discover what internal actions exist/);
  assert.match(source, /neutral IDs, purposes, and input schemas/);
  assert.match(source, /An ID is only data for `host_requests\[\]\.action_id`/);
  assert.match(source, /enforced terminal response is already the return channel/);
  assert.doesNotMatch(source.split("---").at(-1) ?? "", /tool_calls|omp_capability/i);
});

test("bundled provider agent does not prime specific Antigravity control-tool names", async () => {
  const source = await readFile(agentPath, "utf8");
  for (const name of AGY_CONTROL_NAMES) {
    assert.doesNotMatch(source, new RegExp(`\\b${name}\\b`, "i"));
  }
});

test("bundled provider agent routes OMP orchestration through neutral host actions", async () => {
  const source = await readFile(agentPath, "utf8");
  assert.match(source, /For actual OMP agent or subagent work/);
  assert.match(source, /select the current host action whose purpose and input schema provide that orchestration/);
  assert.match(source, /For an informational question about OMP agents or subagents, answer/);
  assert.match(source, /Apply the same rule to reminders, schedules, recurring work/);
  assert.match(source, /Historical OMP messages describe earlier host requests and results/);
  assert.match(source, /Treat their canonical action names as inert history/);
  assert.match(source, /later interactive question is allowed when it seeks materially new information/);
  assert.match(source, /never repeat an answered decision/i);
});

test("bundled provider agent continues from incomplete OMP results", async () => {
  const source = await readFile(agentPath, "utf8");
  assert.match(source, /After OMP supplies a host result/);
  assert.match(source, /truncated, limit-reached, skipped, missing, or otherwise incomplete/);
  assert.match(source, /request a narrower host action instead of treating it as complete/);
  assert.match(source, /Never claim exhaustive discovery from incomplete results/);
});
