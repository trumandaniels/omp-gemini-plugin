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

test("bundled provider agent routes named subagents through OMP only", async () => {
  const source = await readFile(agentPath, "utf8");
  assert.match(source, /references to agents, subagents, named subagents, tasks, and background jobs mean OMP facilities/);
  assert.match(source, /Questions about how OMP subagents work are informational/);
  assert.match(source, /request the OMP `task` tool/);
  assert.match(source, /how to make named subagents\?/);
  for (const tool of [
    "manage_task",
    "manage_subagents",
    "manage_inbox",
    "define_subagent",
    "invoke_subagent",
    "send_message",
  ]) {
    assert.match(source, new RegExp(`\\b${tool}\\b`));
  }
});

test("bundled provider agent never reports OMP tool results through AGY messaging", async () => {
  const source = await readFile(agentPath, "utf8");
  assert.match(source, /OMP is not an Antigravity agent or message recipient/);
  assert.match(source, /Never call `send_message` or `manage_inbox` with recipient\/to `omp`, `parent`, or `main`/);
  assert.match(source, /After OMP supplies a tool result/);
  assert.match(source, /final answer in terminal structured output/);
  assert.match(source, /structured output is already delivered back to OMP/);
  assert.match(source, /no separate report-back message is needed/);
});
