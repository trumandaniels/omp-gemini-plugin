import assert from "node:assert/strict";
import test from "node:test";

import { unwrapNestedBridgeOutput } from "../src/nested-output.ts";

test("unwrapNestedBridgeOutput recovers fenced host requests serialized inside response", () => {
  const nested = [
    {
      response: "",
      host_requests: [
        { action_id: "glob", input: { i: "Listing repository root files", path: "*" } },
        { action_id: "read", input: { i: "Reading README if present", path: "README.md" } },
      ],
    },
    {
      response: "Completed.",
      host_requests: [],
    },
  ].map((value) => JSON.stringify(value, null, 2)).join("\n");

  assert.deepEqual(
    unwrapNestedBridgeOutput(
      {
        text: `\`\`\`json\n${nested}\n\`\`\``,
        tool_calls: [],
        finish_reason: "stop",
      },
      ["glob", "read"],
    ),
    {
      text: "",
      tool_calls: [
        { name: "glob", arguments: { i: "Listing repository root files", path: "*" } },
        { name: "read", arguments: { i: "Reading README if present", path: "README.md" } },
      ],
      finish_reason: "tool_use",
    },
  );
});

test("unwrapNestedBridgeOutput recovers fenced responses with escaped Markdown backticks", () => {
  const answer = "Observed `formatCount` returning `${count} items`.";
  const first = JSON.stringify({ response: answer, host_requests: [] }).replaceAll("`", "\\`");
  const chatter = JSON.stringify({ response: "Task complete.", host_requests: [] });
  const leaked = `\`\`\`json\n${first}\n\`\`\`\n\`\`\`json\n${chatter}\n\`\`\``;

  assert.deepEqual(
    unwrapNestedBridgeOutput(
      { text: leaked, tool_calls: [], finish_reason: "stop" },
      [],
    ),
    {
      text: answer,
      tool_calls: [],
      finish_reason: "stop",
    },
  );
});

test("unwrapNestedBridgeOutput recovers a bare host request serialized inside response", () => {
  const nested = JSON.stringify({
    action_id: "host_action_02",
    input: {
      i: "Reading remaining component lines",
      path: "src/editor/Editor.tsx:880-1142",
    },
  });

  assert.deepEqual(
    unwrapNestedBridgeOutput(
      { text: nested, tool_calls: [], finish_reason: "stop" },
      ["host_action_01", "host_action_02"],
    ),
    {
      text: "",
      tool_calls: [
        {
          name: "host_action_02",
          arguments: {
            i: "Reading remaining component lines",
            path: "src/editor/Editor.tsx:880-1142",
          },
        },
      ],
      finish_reason: "tool_use",
    },
  );
});

test("unwrapNestedBridgeOutput recovers a bare batch of host requests", () => {
  const nested = JSON.stringify([
    { action_id: "glob", input: { path: "src/**" } },
    { action_id: "read", input: { path: "README.md" } },
  ]);

  assert.deepEqual(
    unwrapNestedBridgeOutput(
      { text: nested, tool_calls: [], finish_reason: "stop" },
      ["glob", "read"],
    ),
    {
      text: "",
      tool_calls: [
        { name: "glob", arguments: { path: "src/**" } },
        { name: "read", arguments: { path: "README.md" } },
      ],
      finish_reason: "tool_use",
    },
  );
});

test("unwrapNestedBridgeOutput recursively unwraps a double-encoded host response", () => {
  const innermost = JSON.stringify({
    response: "Recovered answer.",
    host_requests: [],
  });
  const middle = JSON.stringify({
    response: innermost,
    host_requests: [],
  });

  assert.deepEqual(
    unwrapNestedBridgeOutput(
      { text: middle, tool_calls: [], finish_reason: "stop" },
      [],
    ),
    { text: "Recovered answer.", tool_calls: [], finish_reason: "stop" },
  );
});

test("unwrapNestedBridgeOutput preserves ordinary text that contains JSON", () => {
  const output = {
    text: 'Example config: {"capabilities":{"image":true}}',
    tool_calls: [],
    finish_reason: "stop" as const,
  };
  assert.deepEqual(unwrapNestedBridgeOutput(output, []), output);
});

test("unwrapNestedBridgeOutput preserves JSON-only user-visible text that is not a bridge object", () => {
  const output = {
    text: '{"capabilities":{"image":true}}',
    tool_calls: [],
    finish_reason: "stop" as const,
  };
  assert.deepEqual(unwrapNestedBridgeOutput(output, []), output);
});

test("unwrapNestedBridgeOutput never executes an unavailable nested host request", () => {
  const nested = JSON.stringify({
    response: "",
    host_requests: [{ action_id: "unavailable", input: {} }],
  });
  const output = { text: nested, tool_calls: [], finish_reason: "stop" as const };
  assert.deepEqual(unwrapNestedBridgeOutput(output, ["read"]), output);
});

test("unwrapNestedBridgeOutput leaves already-native tool calls unchanged", () => {
  const output = {
    text: "",
    tool_calls: [{ name: "read", arguments: { path: "README.md" } }],
    finish_reason: "tool_use" as const,
  };
  assert.deepEqual(unwrapNestedBridgeOutput(output, ["read"]), output);
});
