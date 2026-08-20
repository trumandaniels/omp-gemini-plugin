import assert from "node:assert/strict";
import test from "node:test";

import { resolveAgyModelSelection } from "../src/model-selection.ts";
import type { BridgeModelDefinition } from "../src/types.ts";

function tieredModel(routeOverrides: Partial<Record<"low" | "medium" | "high", string>> = {}): BridgeModelDefinition {
  return {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    reasoning: true,
    contextWindow: 100,
    maxTokens: 100,
    agyModelIdsByEffort: {
      low: "gemini-3.7-flash-low",
      medium: "gemini-3.7-flash-medium",
      high: "gemini-3.7-flash-high",
      ...routeOverrides,
    },
  };
}

function tieredModelWithoutMedium(): BridgeModelDefinition {
  return {
    ...tieredModel(),
    agyModelIdsByEffort: {
      low: "gemini-3.7-flash-low",
      high: "gemini-3.7-flash-high",
    },
  };
}

test("low reasoning selects the low alias", () => {
  const selected = resolveAgyModelSelection(tieredModel(), { reasoning: "low" });
  assert.deepEqual(selected, { model: "gemini-3.7-flash-low", effort: undefined });
});

test("medium reasoning selects the medium alias", () => {
  const selected = resolveAgyModelSelection(tieredModel(), { reasoning: "medium" });
  assert.deepEqual(selected, { model: "gemini-3.7-flash-medium", effort: undefined });
});

test("high reasoning selects the high alias", () => {
  const selected = resolveAgyModelSelection(tieredModel(), { reasoning: "high" });
  assert.deepEqual(selected, { model: "gemini-3.7-flash-high", effort: undefined });
});

test("minimal reasoning selects the low alias", () => {
  const selected = resolveAgyModelSelection(tieredModel(), { reasoning: "minimal" });
  assert.deepEqual(selected, { model: "gemini-3.7-flash-low", effort: undefined });
});

test("disableReasoning selects the low alias", () => {
  const selected = resolveAgyModelSelection(tieredModel(), { reasoning: "high", disableReasoning: true });
  assert.deepEqual(selected, { model: "gemini-3.7-flash-low", effort: undefined });
});

test("off reasoning selects the low alias", () => {
  const selected = resolveAgyModelSelection(tieredModel(), { reasoning: "off" });
  assert.deepEqual(selected, { model: "gemini-3.7-flash-low", effort: undefined });
});

test("xhigh reasoning selects the high alias", () => {
  const selected = resolveAgyModelSelection(tieredModel(), { reasoning: "xhigh" });
  assert.deepEqual(selected, { model: "gemini-3.7-flash-high", effort: undefined });
});

test("max reasoning selects the high alias", () => {
  const selected = resolveAgyModelSelection(tieredModel(), { reasoning: "max" });
  assert.deepEqual(selected, { model: "gemini-3.7-flash-high", effort: undefined });
});

test("undefined reasoning picks highest configured effort by default", () => {
  const selected = resolveAgyModelSelection(tieredModel(), {});
  assert.deepEqual(selected, { model: "gemini-3.7-flash-high", effort: undefined });
});

test("configured defaultEffort overrides highest-effort fallback", () => {
  const selected = resolveAgyModelSelection(tieredModel(), {}, "low");
  assert.deepEqual(selected, { model: "gemini-3.7-flash-low", effort: undefined });
});

test("pro medium falls back deterministically to low", () => {
  const selected = resolveAgyModelSelection(tieredModelWithoutMedium(), { reasoning: "medium" });
  assert.deepEqual(selected, { model: "gemini-3.7-flash-low", effort: undefined });
});

test("auto omits model and forwards selected effort", () => {
  const selected = resolveAgyModelSelection(
    {
      id: "auto",
      name: "Auto",
      reasoning: true,
      contextWindow: 100,
      maxTokens: 100,
      effort: "low",
    },
    { reasoning: "high" },
  );
  assert.deepEqual(selected, { model: undefined, effort: "high" });
});

test("auto forwards undefined effort when no effort is selected", () => {
  const selected = resolveAgyModelSelection(
    {
      id: "auto",
      name: "Auto",
      reasoning: true,
      contextWindow: 100,
      maxTokens: 100,
    },
    {},
  );
  assert.equal(selected.model, undefined);
  assert.equal(selected.effort, undefined);
});

test("non-reasoning auto never inherits a global effort", () => {
  const selected = resolveAgyModelSelection(
    {
      id: "auto",
      name: "Auto without reasoning",
      reasoning: false,
      contextWindow: 100,
      maxTokens: 100,
    },
    { reasoning: "high" },
    "medium",
  );
  assert.deepEqual(selected, { model: undefined, effort: undefined });
});

test("tiered models never return both model slug and effort", () => {
  const selected = resolveAgyModelSelection(tieredModel(), { reasoning: "low" }, "low");
  assert.equal(selected.model, "gemini-3.7-flash-low");
  assert.equal(selected.effort, undefined);
});

test("empty tier map throws", () => {
  assert.throws(
    () =>
      resolveAgyModelSelection(
        {
          id: "gemini-3.7-flash",
          name: "Gemini 3.7 Flash",
          reasoning: true,
          contextWindow: 100,
          maxTokens: 100,
          agyModelIdsByEffort: {},
        },
        { reasoning: "low" },
      ),
    /No usable AGY route found|empty/,
  );
});

test("unknown reasoning string does not crash", () => {
  const selected = resolveAgyModelSelection(tieredModel(), { reasoning: "surprise" });
  assert.equal(selected.model, "gemini-3.7-flash-high");
  assert.equal(selected.effort, undefined);
});

test("direct non-tiered model uses configured slug", () => {
  const selected = resolveAgyModelSelection(
    {
      id: "non-tier",
      name: "Direct",
      reasoning: true,
      contextWindow: 100,
      maxTokens: 100,
      agyModelId: "other-model",
      effort: "medium",
    },
    { reasoning: "high" },
  );
  assert.deepEqual(selected, { model: "other-model", effort: "high" });
});

test("direct non-tiered model honors bridge defaultEffort", () => {
  const selected = resolveAgyModelSelection(
    {
      id: "non-tier",
      name: "Direct",
      reasoning: true,
      contextWindow: 100,
      maxTokens: 100,
      agyModelId: "other-model",
    },
    {},
    "medium",
  );
  assert.deepEqual(selected, { model: "other-model", effort: "medium" });
});

test("direct non-reasoning model never receives an effort flag", () => {
  const selected = resolveAgyModelSelection(
    {
      id: "non-reasoning",
      name: "Direct no reasoning",
      reasoning: false,
      contextWindow: 100,
      maxTokens: 100,
      agyModelId: "other-model",
    },
    { reasoning: "high" },
    "medium",
  );
  assert.deepEqual(selected, { model: "other-model", effort: undefined });
});
