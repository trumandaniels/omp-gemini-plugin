import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBridgeOutputSchema,
  parameterSchema,
  parseBridgeStructuredOutput,
  serializeTools,
} from "../src/schema.ts";

test("buildBridgeOutputSchema includes only available tool names", () => {
  const schema = buildBridgeOutputSchema(["read", "task"]);
  const text = JSON.stringify(schema);
  assert.match(text, /read/);
  assert.match(text, /task/);
  assert.doesNotMatch(text, /bash/);
});

test("parseBridgeStructuredOutput validates finish reason", () => {
  assert.deepEqual(
    parseBridgeStructuredOutput(
      {
        text: "",
        tool_calls: [{ name: "read", arguments: { path: "README.md" } }],
        finish_reason: "tool_use",
      },
      ["read"],
    ),
    {
      text: "",
      tool_calls: [{ name: "read", arguments: { path: "README.md" } }],
      finish_reason: "tool_use",
    },
  );
  assert.throws(
    () => parseBridgeStructuredOutput({ text: "", tool_calls: [], finish_reason: "tool_use" }, ["read"]),
    /finish_reason must be stop/,
  );
});

test("parameterSchema accepts a TypeBox-like JSON schema", () => {
  const schema = parameterSchema({
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  });
  assert.equal(schema.type, "object");
});

test("serializeTools truncates overly large schemas", () => {
  const [tool] = serializeTools(
    [{ name: "huge", description: "x", parameters: { type: "object", description: "a".repeat(10_000) } }],
    { maxCatalogChars: 20_000, maxDescriptionChars: 100, maxSchemaChars: 500 },
  );
  assert.equal(tool.name, "huge");
  assert.match(String(tool.parameters.description), /omitted/);
});
