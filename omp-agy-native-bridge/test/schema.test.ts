import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBridgeOutputSchema,
  parseAgyTerminalOutput,
  parseBridgeStructuredOutput,
  parameterSchema,
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

test("parseAgyTerminalOutput validates structured_output object", () => {
  const parsed = parseAgyTerminalOutput(
    {
      structured_output: {
        text: "ok",
        tool_calls: [],
        finish_reason: "stop",
      },
      response: "ignored",
    },
    ["read"],
  );
  assert.deepEqual(parsed, {
    text: "ok",
    tool_calls: [],
    finish_reason: "stop",
  });
});

test("parseAgyTerminalOutput parses JSON string in structured_output", () => {
  const parsed = parseAgyTerminalOutput(
    {
      structured_output: '{"text":"ok","tool_calls":[],"finish_reason":"stop"}',
      response: "ignored",
    },
    ["read"],
  );
  assert.equal(parsed.text, "ok");
});

test("parseAgyTerminalOutput parses JSON response when structured_output is absent", () => {
  const parsed = parseAgyTerminalOutput(
    {
      response: '{"text":"from response","tool_calls":[],"finish_reason":"stop"}',
    },
    ["read"],
  );
  assert.equal(parsed.text, "from response");
  assert.equal(parsed.tool_calls.length, 0);
});

test("parseAgyTerminalOutput unwraps fenced JSON in response", () => {
  const parsed = parseAgyTerminalOutput(
    {
      response: "```json\n{\"text\":\"json\",\"tool_calls\":[],\"finish_reason\":\"stop\"}\n```",
    },
    ["read"],
  );
  assert.equal(parsed.text, "json");
});

test("parseAgyTerminalOutput falls back to plain text response", () => {
  const parsed = parseAgyTerminalOutput(
    {
      response: "plain provider response",
    },
    [],
  );
  assert.deepEqual(parsed, {
    text: "plain provider response",
    tool_calls: [],
    finish_reason: "stop",
  });
});

test("parseAgyTerminalOutput falls through when structured_output is null", () => {
  const parsed = parseAgyTerminalOutput(
    {
      structured_output: null,
      response: '{"text":"null handled","tool_calls":[],"finish_reason":"stop"}',
    },
    [],
  );
  assert.equal(parsed.text, "null handled");
});

test("parseAgyTerminalOutput rejects malformed structured_output even with good response", () => {
  assert.throws(
    () =>
      parseAgyTerminalOutput(
        {
          structured_output: "not-json",
          response: '{"text":"fallback","tool_calls":[],"finish_reason":"stop"}',
        },
        ["read"],
      ),
    /Unexpected token|must be an object|structured_output must be an object/,
  );
});

test("parseAgyTerminalOutput rejects invalid parsed JSON response schema", () => {
  assert.throws(
    () =>
      parseAgyTerminalOutput(
        {
          response: '{"text":1,"tool_calls":[],"finish_reason":"stop"}',
        },
        [],
      ),
    /structured_output\.text must be a string/,
  );
});

test("parseAgyTerminalOutput rejects unknown tools in response JSON", () => {
  assert.throws(
    () =>
      parseAgyTerminalOutput(
        {
          response: '{"text":"tool?","tool_calls":[{"name":"fake","arguments":{}}],"finish_reason":"tool_use"}',
        },
        ["read", "write"],
      ),
    /unavailable OMP tool/,
  );
});

test("parseAgyTerminalOutput rejects blank output", () => {
  assert.throws(() => parseAgyTerminalOutput({}, []), /agy returned neither structured_output nor non-empty response text/);
  assert.throws(
    () => parseAgyTerminalOutput({ response: "   \n" }, []),
    /agy returned neither structured_output nor non-empty response text/,
  );
});
