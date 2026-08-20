import assert from "node:assert/strict";
import test from "node:test";

import { aliasOmpToolCatalog, restoreOmpToolNames } from "../src/tool-alias.ts";

test("OMP tools receive opaque AGY-facing aliases", () => {
  const aliases = aliasOmpToolCatalog([
    { name: "task", description: "Run an OMP subagent", parameters: { type: "object" } },
    { name: "read", description: "Read through OMP", parameters: { type: "object" } },
  ]);

  assert.deepEqual(aliases.wireCatalog.map((tool) => tool.name), [
    "omp_capability_01",
    "omp_capability_02",
  ]);
  assert.equal(aliases.wireToOmpToolName.omp_capability_01, "task");
  assert.equal(aliases.ompToWireToolName.read, "omp_capability_02");
  assert.doesNotMatch(aliases.wireCatalog[0]?.name ?? "", /task|manage/i);
});

test("validated wire aliases restore exact OMP tool names", () => {
  const aliases = aliasOmpToolCatalog([
    { name: "task", description: "Run an OMP subagent", parameters: { type: "object" } },
  ]);

  assert.deepEqual(
    restoreOmpToolNames(
      {
        text: "",
        tool_calls: [{ name: "omp_capability_01", arguments: { prompt: "audit it" } }],
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
        tool_calls: [{ name: "omp_capability_99", arguments: {} }],
        finish_reason: "tool_use",
      },
      {},
    ),
    /unknown OMP capability alias/,
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
