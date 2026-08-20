import assert from "node:assert/strict";
import test from "node:test";

import {
  appendToolChoiceInstruction,
  assertBridgeToolChoiceSatisfied,
  resolveBridgeToolChoice,
} from "../src/tool-choice.ts";

const tools = [
  { name: "read", description: "Read", parameters: { type: "object" } },
  { name: "write", description: "Write", parameters: { type: "object" } },
];

test("toolChoice none removes every OMP tool from the AGY catalog", () => {
  const resolved = resolveBridgeToolChoice(tools, "none");
  assert.deepEqual(resolved.tools, []);
  assert.equal(resolved.requireToolCall, false);
});

test("named tool choices narrow the catalog and force that exact tool", () => {
  for (const choice of [
    { type: "function", name: "read" },
    { type: "function", function: { name: "read" } },
    { type: "tool", name: "read" },
  ] as const) {
    const resolved = resolveBridgeToolChoice(tools, choice);
    assert.deepEqual(resolved.tools.map((tool) => tool.name), ["read"]);
    assert.equal(resolved.requireToolCall, true);
    assert.equal(resolved.requiredToolName, "read");
  }
});

test("required and any force at least one available OMP tool", () => {
  for (const choice of ["required", "any"] as const) {
    const resolved = resolveBridgeToolChoice(tools, choice);
    assert.equal(resolved.tools.length, 2);
    assert.equal(resolved.requireToolCall, true);
    assert.equal(resolved.requiredToolName, undefined);
  }
});

test("forced tool choice fails before AGY when no matching tool is active", () => {
  assert.throws(
    () => resolveBridgeToolChoice(tools, { type: "function", name: "bash" }),
    /requires unavailable tool: bash/,
  );
  assert.throws(
    () => resolveBridgeToolChoice([], "required"),
    /no available OMP tools/,
  );
});

test("computer choice maps only to an active computer tool", () => {
  assert.throws(
    () => resolveBridgeToolChoice(tools, { type: "computer" }),
    /requires unavailable tool: computer/,
  );
  const resolved = resolveBridgeToolChoice(
    [...tools, { name: "computer", description: "Computer", parameters: { type: "object" } }],
    { type: "computer" },
  );
  assert.deepEqual(resolved.tools.map((tool) => tool.name), ["computer"]);
  assert.equal(resolved.requiredToolName, "computer");
});

test("tool-forced prompt correction survives as an explicit provider constraint", () => {
  const prompt = appendToolChoiceInstruction("base", {
    requireToolCall: true,
    requiredToolName: "read",
  });
  assert.match(prompt, /tool-forced/i);
  assert.match(prompt, /OMP tool "read"/);
  assert.match(prompt, /outer "tool_calls" array/);
});

test("forced-tool result validation rejects text-only or wrong-tool completions", () => {
  const resolution = { requireToolCall: true, requiredToolName: "read" };
  assert.throws(
    () => assertBridgeToolChoiceSatisfied({ tool_calls: [] }, resolution),
    /requires OMP tool "read"/,
  );
  assert.throws(
    () =>
      assertBridgeToolChoiceSatisfied(
        { tool_calls: [{ name: "write", arguments: {} }] },
        resolution,
      ),
    /expected only read/,
  );
  assert.doesNotThrow(() =>
    assertBridgeToolChoiceSatisfied(
      { tool_calls: [{ name: "read", arguments: {} }] },
      resolution,
    ),
  );
});
