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
        response: "ok",
        host_requests: [],
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
      structured_output: '{"response":"ok","host_requests":[]}',
      response: "ignored",
    },
    ["read"],
  );
  assert.equal(parsed.text, "ok");
});

test("parseAgyTerminalOutput parses JSON response when structured_output is absent", () => {
  const parsed = parseAgyTerminalOutput(
    {
      response: '{"response":"from response","host_requests":[]}',
    },
    ["read"],
  );
  assert.equal(parsed.text, "from response");
  assert.equal(parsed.tool_calls.length, 0);
});

test("parseAgyTerminalOutput treats a bare protocol request as a host action", () => {
  assert.deepEqual(
    parseAgyTerminalOutput(
      {
        response: JSON.stringify({
          request_id: "next-read",
          action_id: "host_action_02",
          input: { path: "src/editor/Editor.tsx:880-1142" },
        }),
      },
      ["host_action_01", "host_action_02"],
    ),
    {
      text: "",
      tool_calls: [
        {
          id: "next-read",
          name: "host_action_02",
          arguments: { path: "src/editor/Editor.tsx:880-1142" },
        },
      ],
      finish_reason: "tool_use",
    },
  );
});

test("parseAgyTerminalOutput preserves ordinary JSON arrays containing non-request objects", () => {
  const value = [
    { action_id: "display-only", input: { value: 1 } },
    { label: "not a host request" },
  ];

  assert.deepEqual(parseAgyTerminalOutput({ response: JSON.stringify(value) }, ["host_action_01"]), {
    text: JSON.stringify(value, null, 2),
    tool_calls: [],
    finish_reason: "stop",
  });
});

test("parseAgyTerminalOutput keeps the first result when agy concatenates completion objects", () => {
  const response = [
    { response: "Test acknowledged. Ready for instructions.", host_requests: [] },
    { response: "Task complete. Ready for next instructions.", host_requests: [] },
    { response: "Task complete.", host_requests: [] },
    { response: "Completed.", host_requests: [] },
  ].map((value) => JSON.stringify(value)).join("\n");

  assert.deepEqual(parseAgyTerminalOutput({ response }, []), {
    text: "Test acknowledged. Ready for instructions.",
    tool_calls: [],
    finish_reason: "stop",
  });
});

test("parseAgyTerminalOutput preserves a first host request before concatenated completion chatter", () => {
  const response = [
    {
      response: 'Read the "{draft}" file.',
      host_requests: [
        {
          action_id: "read",
          input: {
            path: "notes/{draft}.md",
            selection: { lines: [1, 2] },
          },
        },
      ],
    },
    {
      response: "Completed.",
      host_requests: [],
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
    response: "Long answer with {braces}, [arrays], and markdown.",
    host_requests: [],
  });
  const completeChatter = JSON.stringify({
    response: "Task complete.",
    host_requests: [],
  });
  const response = `${first}\n${completeChatter}\n{"response":"truncated`;

  assert.deepEqual(parseAgyTerminalOutput({ response }, []), {
    text: "Long answer with {braces}, [arrays], and markdown.",
    tool_calls: [],
    finish_reason: "stop",
  });
});

test("parseAgyTerminalOutput handles separately fenced completion objects", () => {
  const first = JSON.stringify({
    response: "First fenced result.",
    host_requests: [],
  });
  const chatter = JSON.stringify({
    response: "Completed.",
    host_requests: [],
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
      response: "Structured first result.",
      host_requests: [],
    },
    {
      response: "Completed.",
      host_requests: [],
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
      response: "```json\n{\"response\":\"json\",\"host_requests\":[]}\n```",
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
  const response = 'prefix\n{"response":"json","host_requests":[]}\nsuffix';
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
      response: '{"response":"null handled","host_requests":[]}',
    },
    [],
  );
  assert.equal(parsed.text, "null handled");
});

test("parseAgyTerminalOutput recovers malformed serialized structured_output from response", () => {
  assert.deepEqual(
    parseAgyTerminalOutput(
      {
        structured_output: "not-json",
        response: '{"response":"fallback","host_requests":[]}',
      },
      ["read"],
    ),
    { text: "fallback", tool_calls: [], finish_reason: "stop" },
  );
});

test("parseAgyTerminalOutput normalizes scalar text values", () => {
  assert.deepEqual(
    parseAgyTerminalOutput(
      {
        response: '{"response":1,"host_requests":[]}',
      },
      [],
    ),
    { text: "1", tool_calls: [], finish_reason: "stop" },
  );
  assert.equal(parseBridgeStructuredOutput({ text: false }, []).text, "false");
});

test("parseAgyTerminalOutput rejects unknown host actions in response JSON", () => {
  assert.throws(
    () =>
      parseAgyTerminalOutput(
        {
          response: '{"response":"action?","host_requests":[{"action_id":"fake","input":{}}]}',
        },
        ["read", "write"],
      ),
    /unavailable host action/,
  );
});

test("parseAgyTerminalOutput rejects blank output", () => {
  assert.throws(() => parseAgyTerminalOutput({}, []), /agy returned neither structured_output nor non-empty response text/);
  assert.throws(
    () => parseAgyTerminalOutput({ response: "   \n" }, []),
    /agy returned neither structured_output nor non-empty response text/,
  );
  assert.throws(
    () => parseBridgeStructuredOutput({}, []),
    /must contain text or at least one tool call/,
  );
});
