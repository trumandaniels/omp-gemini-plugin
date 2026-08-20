import assert from "node:assert/strict";
import test from "node:test";

import { buildBridgeOutputSchema, parseBridgeStructuredOutput } from "../src/schema.ts";

test("outer schema leaves non-semantic text/id/arguments representation to the adapter", () => {
  const schema = buildBridgeOutputSchema(["read"]) as {
    properties: {
      text: Record<string, unknown>;
      tool_calls: { items: { properties: Record<string, unknown> } };
    };
  };

  assert.deepEqual(schema.properties.text, {});
  assert.deepEqual(schema.properties.tool_calls.items.properties.id, {});
  assert.deepEqual(schema.properties.tool_calls.items.properties.arguments, {});
  assert.deepEqual(schema.properties.tool_calls.items.properties.name, {
    type: "string",
    enum: ["read"],
  });
});

test("JSON-encoded tool arguments are normalized before OMP dispatch", () => {
  assert.deepEqual(
    parseBridgeStructuredOutput(
      {
        text: "",
        tool_calls: [
          {
            id: 17,
            name: "read",
            arguments: '{"path":"README.md","offset":1}',
          },
        ],
      },
      ["read"],
    ),
    {
      text: "",
      tool_calls: [
        {
          id: "17",
          name: "read",
          arguments: { path: "README.md", offset: 1 },
        },
      ],
      finish_reason: "tool_use",
    },
  );
});

test("invalid correlation ids are regenerated later instead of killing the turn", () => {
  const parsed = parseBridgeStructuredOutput(
    {
      text: "",
      tool_calls: [{ id: { unexpected: true }, name: "read", arguments: { path: "README.md" } }],
    },
    ["read"],
  );
  assert.equal(parsed.tool_calls[0]?.id, undefined);
});

test("argument compatibility never accepts a non-object payload", () => {
  for (const argumentsValue of ["[]", '"README.md"', "not-json", 7, null]) {
    assert.throws(
      () =>
        parseBridgeStructuredOutput(
          {
            text: "",
            tool_calls: [{ name: "read", arguments: argumentsValue }],
          },
          ["read"],
        ),
      /arguments must be an object or a JSON-encoded object/,
    );
  }
});

test("argument normalization still rejects prototype-pollution keys", () => {
  assert.throws(
    () =>
      parseBridgeStructuredOutput(
        {
          text: "",
          tool_calls: [
            {
              name: "read",
              arguments: '{"constructor":{"prototype":{"polluted":true}}}',
            },
          ],
        },
        ["read"],
      ),
    /forbidden key constructor/,
  );
});
