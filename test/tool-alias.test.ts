import assert from "node:assert/strict";
import test from "node:test";

import { aliasOmpToolCatalog, restoreOmpToolNames } from "../src/tool-alias.ts";

test("OMP actions receive neutral AGY-facing IDs and catalog fields", () => {
  const aliases = aliasOmpToolCatalog([
    { name: "task", description: "Run an OMP subagent", parameters: { type: "object" } },
    { name: "read", description: "Read through OMP", parameters: { type: "object" } },
  ]);

  assert.deepEqual(aliases.wireCatalog.map((action) => action.id), [
    "host_action_01",
    "host_action_02",
  ]);
  assert.deepEqual(aliases.wireCatalog[0], {
    id: "host_action_01",
    purpose: "Run an OMP subagent",
    input_schema: { type: "object" },
  });
  assert.equal(aliases.wireToOmpToolName.host_action_01, "task");
  assert.equal(aliases.ompToWireToolName.read, "host_action_02");
  assert.doesNotMatch(JSON.stringify(aliases.wireCatalog), /"name"|"description"|"parameters"/);
});

test("validated wire aliases restore exact OMP tool names", () => {
  const aliases = aliasOmpToolCatalog([
    { name: "task", description: "Run an OMP subagent", parameters: { type: "object" } },
  ]);

  assert.deepEqual(
    restoreOmpToolNames(
      {
        text: "",
        tool_calls: [{ name: "host_action_01", arguments: { prompt: "audit it" } }],
        finish_reason: "tool_use",
      },
      aliases.wireToOmpToolName,
    ),
    {
      text: "",
      tool_calls: [{ name: "task", arguments: { prompt: "audit it" } }],
      finish_reason: "tool_use",
    },
  );
});

test("unknown wire aliases fail closed", () => {
  assert.throws(
    () => restoreOmpToolNames(
      {
        text: "",
        tool_calls: [{ name: "host_action_99", arguments: {} }],
        finish_reason: "tool_use",
      },
      {},
    ),
    /unknown action ID/,
  );
});

test("duplicate OMP tool names are rejected before provider invocation", () => {
  assert.throws(
    () => aliasOmpToolCatalog([
      { name: "read", description: "first", parameters: { type: "object" } },
      { name: "read", description: "second", parameters: { type: "object" } },
    ]),
    /Duplicate OMP tool name/,
  );
});
