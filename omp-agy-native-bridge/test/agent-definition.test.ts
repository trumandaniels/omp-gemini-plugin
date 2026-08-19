import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const agentPath = fileURLToPath(new URL("../agents/omp-bridge-model/agent.md", import.meta.url));

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

test("bundled provider agent routes named subagents and schedules through OMP only", async () => {
  const source = await readFile(agentPath, "utf8");
  assert.match(
    source,
    /references to agents, subagents, named subagents, tasks, background jobs, schedules, reminders, or recurring work mean OMP facilities/,
  );
  assert.match(source, /Questions about how OMP subagents work are informational/);
  assert.match(source, /request the OMP `task` tool/);
  assert.match(source, /use an OMP scheduling\/automation tool only when one is present/);
  assert.match(source, /never call Antigravity `schedule`/);
  assert.match(source, /how to make named subagents\?/);
  for (const tool of [
    "schedule",
    "manage_task",
    "manage_subagents",
    "manage_inbox",
    "define_subagent",
    "invoke_subagent",
    "send_message",
  ]) {
    assert.match(source, new RegExp(`\\b${tool}\\b`));
  }
  assert.match(source, /An OMP tool may be named `hub` or `read`/);
  assert.match(source, /request it only through terminal structured output/);
});

test("bundled provider agent never treats OMP or OMP tool names as AGY recipients", async () => {
  const source = await readFile(agentPath, "utf8");
  assert.match(source, /OMP is the host application and tool dispatcher/);
  assert.match(source, /not an Antigravity agent, recipient, inbox, conversation peer, or addressable name/);
  assert.match(source, /Never send a message to a recipient named `omp`, `parent`, or `main`/);
  assert.match(source, /Every tool name supplied by OMP is a structured tool name, not an Antigravity recipient/);
  assert.match(source, /Names such as `read`, `glob`, `grep`, `bash`, `edit`, `write`, `task`, `hub`, and `inspect_image`/);
  assert.match(source, /Never call Antigravity `send_message` or `manage_inbox` with an OMP tool name as the recipient/);
  assert.match(source, /enforced terminal structured output is already the return channel/);
  assert.match(source, /place the answer in `text`, or request OMP tools in `tool_calls`/);
});

test("bundled provider agent continues from incomplete OMP tool results", async () => {
  const source = await readFile(agentPath, "utf8");
  assert.match(source, /After OMP supplies a tool result/);
  assert.match(source, /returning the next OMP tool call or the final answer/);
  assert.match(source, /truncated, limit-reached, skipped, missing, or otherwise incomplete/);
  assert.match(source, /request narrower OMP tool calls instead of treating it as complete/);
  assert.match(source, /Never claim exhaustive discovery from an incomplete listing/);
});
