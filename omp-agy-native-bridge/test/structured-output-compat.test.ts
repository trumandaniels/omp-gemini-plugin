import assert from "node:assert/strict";
import test from "node:test";

import { buildBridgeOutputSchema, parseBridgeStructuredOutput, parseHostResponseOutput } from "../src/schema.ts";

test("outer schema uses only neutral host-response fields", () => {
  const schema = buildBridgeOutputSchema(["host_action_01"]) as {
    required?: string[];
    additionalProperties?: boolean;
    properties: {
      response: Record<string, unknown>;
      host_requests: { items: { required?: string[]; properties: Record<string, unknown> } };
    };
  };

  assert.equal(schema.required, undefined);
  assert.equal(schema.additionalProperties, true);
  assert.deepEqual(schema.properties.response, {});
  assert.deepEqual(schema.properties.host_requests.items.properties.request_id, {});
  assert.deepEqual(schema.properties.host_requests.items.properties.input, {});
  assert.deepEqual(schema.properties.host_requests.items.required, ["action_id"]);
  assert.deepEqual(schema.properties.host_requests.items.properties.action_id, {
    type: "string",
    enum: ["host_action_01"],
  });
  assert.doesNotMatch(JSON.stringify(schema), /tool_calls|finish_reason|arguments/);
});

test("host requests normalize into the internal OMP call representation", () => {
  assert.deepEqual(
    parseHostResponseOutput(
      {
        response: "",
        host_requests: [
          {
            request_id: 17,
            action_id: "host_action_01",
            input: '{"path":"README.md","offset":1}',
          },
        ],
      },
      ["host_action_01"],
    ),
    {
      text: "",
      tool_calls: [
        {
          id: "17",
          name: "host_action_01",
          arguments: { path: "README.md", offset: 1 },
        },
      ],
      finish_reason: "tool_use",
    },
  );
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

test("missing, null, or blank tool arguments normalize to an empty object", () => {
  for (const argumentsValue of [undefined, null, ""]) {
    const parsed = parseBridgeStructuredOutput(
      {
        tool_calls: [
          {
            name: "read",
            ...(argumentsValue === undefined ? {} : { arguments: argumentsValue }),
          },
        ],
      },
      ["read"],
    );
    assert.deepEqual(parsed.tool_calls[0]?.arguments, {});
  }
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
  for (const argumentsValue of ["[]", '"README.md"', "not-json", 7]) {
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

test("plain JSON structured output is rendered but never inferred as a tool call", () => {
  assert.deepEqual(parseBridgeStructuredOutput({ answer: 42, extra: true }, ["read"]), {
    text: '{\n  "answer": 42,\n  "extra": true\n}',
    tool_calls: [],
    finish_reason: "stop",
  });
});
