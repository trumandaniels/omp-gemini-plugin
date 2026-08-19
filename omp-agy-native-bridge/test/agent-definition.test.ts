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
    "hub",
  ]) {
    assert.match(source, new RegExp(`\\b${tool}\\b`));
  }
});

test("bundled provider agent never treats OMP as an AGY recipient", async () => {
  const source = await readFile(agentPath, "utf8");
  assert.match(source, /OMP is the host application and tool dispatcher/);
  assert.match(source, /not an Antigravity agent, recipient, inbox, conversation peer, or addressable name/);
  assert.match(source, /Never send a message to a recipient named `omp`/);
  assert.match(source, /Return text or OMP tool calls only through the enforced terminal structured output/);
});
