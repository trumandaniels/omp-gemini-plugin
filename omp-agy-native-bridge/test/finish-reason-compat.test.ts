import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBridgeOutputSchema,
  parseAgyTerminalOutput,
  parseBridgeStructuredOutput,
} from "../src/schema.ts";

test("finish_reason and empty envelope fields are compatibility metadata", () => {
  const schema = buildBridgeOutputSchema(["read"]) as {
    required?: string[];
    properties?: Record<string, unknown>;
  };

  assert.equal(schema.required, undefined);
  assert.ok(schema.properties?.finish_reason);
});

test("parser derives tool_use when finish_reason and text are missing", () => {
  assert.deepEqual(
    parseBridgeStructuredOutput(
      {
        tool_calls: [{ name: "read", arguments: { path: "README.md" } }],
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

test("parser derives stop when tool_calls is omitted or null", () => {
  assert.deepEqual(parseBridgeStructuredOutput({ text: "done" }, ["read"]), {
    text: "done",
    tool_calls: [],
    finish_reason: "stop",
  });
  assert.deepEqual(parseBridgeStructuredOutput({ text: "done", tool_calls: null }, ["read"]), {
    text: "done",
    tool_calls: [],
    finish_reason: "stop",
  });
});

test("parser ignores conflicting or future finish_reason values", () => {
  for (const finish_reason of ["stop", "toolUse", "TOOL_USE", "length", null, 7]) {
    const parsed = parseBridgeStructuredOutput(
      {
        text: "",
        tool_calls: [{ name: "read", arguments: { path: "README.md" } }],
        finish_reason,
      },
      ["read"],
    );
    assert.equal(parsed.finish_reason, "tool_use");
  }

  for (const finish_reason of ["tool_use", "STOP", "complete", undefined]) {
    const parsed = parseBridgeStructuredOutput(
      {
        text: "done",
        tool_calls: [],
        ...(finish_reason === undefined ? {} : { finish_reason }),
      },
      ["read"],
    );
    assert.equal(parsed.finish_reason, "stop");
  }
});

test("terminal structured output without finish_reason is accepted", () => {
  assert.deepEqual(
    parseAgyTerminalOutput(
      {
        structured_output: {
          text: "finished",
          tool_calls: [],
        },
      },
      [],
    ),
    {
      text: "finished",
      tool_calls: [],
      finish_reason: "stop",
    },
  );
});

test("finish_reason compatibility does not weaken tool validation", () => {
  assert.throws(
    () => parseBridgeStructuredOutput(
      {
        text: "",
        tool_calls: [{ name: "not-an-omp-tool", arguments: {} }],
        finish_reason: "anything",
      },
      ["read"],
    ),
    /unavailable OMP tool/,
  );

  assert.throws(
    () => parseBridgeStructuredOutput(
      {
        text: "",
        tool_calls: [{ name: "read", arguments: "README.md" }],
      },
      ["read"],
    ),
    /arguments must be an object/,
  );
});
