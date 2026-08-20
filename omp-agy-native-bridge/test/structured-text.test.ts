import assert from "node:assert/strict";
import test from "node:test";

import { parseAgyTerminalOutput, parseBridgeStructuredOutput } from "../src/schema.ts";

test("tool-use output accepts null text as an empty user-visible prefix", () => {
  assert.deepEqual(
    parseBridgeStructuredOutput(
      {
        text: null,
        tool_calls: [{ name: "glob", arguments: { path: "~/.omp/agent/*" } }],
        finish_reason: "tool_use",
      },
      ["glob"],
    ),
    {
      text: "",
      tool_calls: [{ name: "glob", arguments: { path: "~/.omp/agent/*" } }],
      finish_reason: "tool_use",
    },
  );
});

test("tool-use output accepts an empty text array", () => {
  const parsed = parseBridgeStructuredOutput(
    {
      text: [],
      tool_calls: [{ name: "read", arguments: { path: "~/.omp/agent/config.yml" } }],
      finish_reason: "tool_use",
    },
    ["read"],
  );
  assert.equal(parsed.text, "");
  assert.equal(parsed.tool_calls[0]?.name, "read");
});

test("content-block arrays are flattened into user-visible text", () => {
  const parsed = parseBridgeStructuredOutput(
    {
      text: [
        { type: "text", text: "Global agent configuration contains:" },
        { type: "text", text: "- modelRoles\n- task settings" },
      ],
      tool_calls: [],
      finish_reason: "stop",
    },
    [],
  );
  assert.equal(parsed.text, "Global agent configuration contains:\n- modelRoles\n- task settings");
});

test("Gemini-style parts objects are flattened into text", () => {
  const parsed = parseBridgeStructuredOutput(
    {
      text: {
        parts: [
          { text: "First paragraph." },
          { text: "Second paragraph." },
        ],
      },
      tool_calls: [],
      finish_reason: "stop",
    },
    [],
  );
  assert.equal(parsed.text, "First paragraph.\nSecond paragraph.");
});

test("JSON answer objects in the text slot are rendered instead of crashing", () => {
  const parsed = parseBridgeStructuredOutput(
    {
      text: {
        modelRoles: { default: "official-agy/gemini-3.7-flash" },
        task: { maxConcurrency: 3 },
      },
      tool_calls: [],
      finish_reason: "stop",
    },
    [],
  );
  assert.match(parsed.text, /"modelRoles"/);
  assert.match(parsed.text, /"maxConcurrency": 3/);
});

test("an object-valued nested bridge response is promoted and validated", () => {
  const parsed = parseAgyTerminalOutput(
    {
      structured_output: {
        text: {
          text: "",
          tool_calls: [
            {
              name: "glob",
              arguments: { path: "~/.omp/agent/*" },
            },
          ],
          finish_reason: "tool_use",
        },
        tool_calls: [],
        finish_reason: "stop",
      },
    },
    ["glob"],
  );
  assert.deepEqual(parsed, {
    text: "",
    tool_calls: [{ name: "glob", arguments: { path: "~/.omp/agent/*" } }],
    finish_reason: "tool_use",
  });
});

test("an array-valued nested bridge response keeps the first provider turn", () => {
  const parsed = parseAgyTerminalOutput(
    {
      structured_output: {
        text: [
          {
            text: "Actual answer.",
            tool_calls: [],
            finish_reason: "stop",
          },
          {
            text: "Completed.",
            tool_calls: [],
            finish_reason: "stop",
          },
        ],
        tool_calls: [],
        finish_reason: "stop",
      },
    },
    [],
  );
  assert.equal(parsed.text, "Actual answer.");
});

test("nested bridge objects cannot smuggle unavailable OMP tools", () => {
  assert.throws(
    () =>
      parseBridgeStructuredOutput(
        {
          text: {
            text: "",
            tool_calls: [{ name: "write", arguments: { path: "x", content: "y" } }],
            finish_reason: "tool_use",
          },
          tool_calls: [],
          finish_reason: "stop",
        },
        ["read"],
      ),
    /unavailable OMP tool/,
  );
});

test("scalar JSON text is rendered instead of crashing", () => {
  assert.equal(
    parseBridgeStructuredOutput({ text: 42, tool_calls: [], finish_reason: "stop" }, []).text,
    "42",
  );
  assert.equal(
    parseBridgeStructuredOutput({ text: true, tool_calls: [], finish_reason: "stop" }, []).text,
    "true",
  );
});
