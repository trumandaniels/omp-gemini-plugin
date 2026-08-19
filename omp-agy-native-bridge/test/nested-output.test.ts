import assert from "node:assert/strict";
import test from "node:test";

import { unwrapNestedBridgeOutput } from "../src/nested-output.ts";

test("unwrapNestedBridgeOutput recovers a fenced tool call serialized inside text", () => {
  const nested = [
    {
      text: "",
      tool_calls: [
        { name: "glob", arguments: { i: "Listing repository root files", path: "*" } },
        { name: "read", arguments: { i: "Reading README if present", path: "README.md" } },
      ],
      finish_reason: "tool_use",
    },
    {
      text: "Completed.",
      tool_calls: [],
      finish_reason: "stop",
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

test("unwrapNestedBridgeOutput recursively unwraps a double-encoded bridge result", () => {
  const innermost = JSON.stringify({
    text: "Recovered answer.",
    tool_calls: [],
    finish_reason: "stop",
  });
  const middle = JSON.stringify({
    text: innermost,
    tool_calls: [],
    finish_reason: "stop",
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

test("unwrapNestedBridgeOutput never executes a nested unavailable tool", () => {
  const nested = JSON.stringify({
    text: "",
    tool_calls: [{ name: "unavailable", arguments: {} }],
    finish_reason: "tool_use",
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
