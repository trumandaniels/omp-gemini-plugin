import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBridgeOutputSchema,
  parseAgyTerminalOutput,
  parseBridgeStructuredOutput,
  parameterSchema,
  serializeTools,
} from "../src/schema.ts";

test("parseBridgeStructuredOutput canonicalizes finish reason from tool calls", () => {
  assert.deepEqual(
    parseBridgeStructuredOutput(
      {
        text: "",
        tool_calls: [{ name: "read", arguments: { path: "README.md" } }],
        finish_reason: "stop",
      },
      ["read"],
    ),
    {
      text: "",
      tool_calls: [{ name: "read", arguments: { path: "README.md" } }],
      finish_reason: "tool_use",
    },
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

test("parseAgyTerminalOutput keeps the first result when agy concatenates completion objects", () => {
  const response = [
    {
      text: "Test acknowledged. Ready for instructions.",
      tool_calls: [],
      finish_reason: "stop",
    },
    {
      text: "Task complete. Ready for next instructions.",
      tool_calls: [],
      finish_reason: "stop",
    },
    {
      text: "Task complete.",
      tool_calls: [],
      finish_reason: "stop",
    },
    {
      text: "Completed.",
      tool_calls: [],
      finish_reason: "stop",
    },
  ].map((value) => JSON.stringify(value)).join("\n");

  assert.deepEqual(parseAgyTerminalOutput({ response }, []), {
    text: "Test acknowledged. Ready for instructions.",
    tool_calls: [],
    finish_reason: "stop",
  });
});

test("parseAgyTerminalOutput preserves a first tool call before concatenated completion chatter", () => {
  const response = [
    {
      text: 'Read the "{draft}" file.',
      tool_calls: [
        {
          name: "read",
          arguments: {
            path: "notes/{draft}.md",
            selection: { lines: [1, 2] },
          },
        },
      ],
      finish_reason: "tool_use",
    },
    {
      text: "Completed.",
      tool_calls: [],
      finish_reason: "stop",
    },
  ].map((value) => JSON.stringify(value)).join("\n\n");

  assert.deepEqual(parseAgyTerminalOutput({ response }, ["read"]), {
    text: 'Read the "{draft}" file.',
    tool_calls: [
      {
        name: "read",
        arguments: {
          path: "notes/{draft}.md",
          selection: { lines: [1, 2] },
        },
      },
    ],
    finish_reason: "tool_use",
  });
});

test("parseAgyTerminalOutput keeps the first result when later chatter is truncated", () => {
  const first = JSON.stringify({
    text: "Long answer with {braces}, [arrays], and markdown.",
    tool_calls: [],
    finish_reason: "stop",
  });
  const completeChatter = JSON.stringify({
    text: "Task complete.",
    tool_calls: [],
    finish_reason: "stop",
  });
  const response = `${first}\n${completeChatter}\n{"text":"truncated`;

  assert.deepEqual(parseAgyTerminalOutput({ response }, []), {
    text: "Long answer with {braces}, [arrays], and markdown.",
    tool_calls: [],
    finish_reason: "stop",
  });
});

test("parseAgyTerminalOutput handles separately fenced completion objects", () => {
  const first = JSON.stringify({
    text: "First fenced result.",
    tool_calls: [],
    finish_reason: "stop",
  });
  const chatter = JSON.stringify({
    text: "Completed.",
    tool_calls: [],
    finish_reason: "stop",
  });
  const response = `\`\`\`json\n${first}\n\`\`\`\n\`\`\`json\n${chatter}\n\`\`\``;

  assert.deepEqual(parseAgyTerminalOutput({ response }, []), {
    text: "First fenced result.",
    tool_calls: [],
    finish_reason: "stop",
  });
});

test("parseAgyTerminalOutput handles concatenated structured_output strings", () => {
  const structuredOutput = [
    {
      text: "Structured first result.",
      tool_calls: [],
      finish_reason: "stop",
    },
    {
      text: "Completed.",
      tool_calls: [],
      finish_reason: "stop",
    },
  ].map((value) => JSON.stringify(value)).join("\n");

  assert.deepEqual(parseAgyTerminalOutput({ structured_output: structuredOutput }, []), {
    text: "Structured first result.",
    tool_calls: [],
    finish_reason: "stop",
  });
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

test("parseAgyTerminalOutput does not swallow prose around a JSON object", () => {
  const response = 'prefix\n{"text":"json","tool_calls":[],"finish_reason":"stop"}\nsuffix';
  assert.deepEqual(parseAgyTerminalOutput({ response }, []), {
    text: response,
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
