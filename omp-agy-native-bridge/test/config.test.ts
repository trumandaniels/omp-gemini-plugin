import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG, validateBridgeConfig } from "../src/config.ts";

test("default prompt budget is platform-independent after stdin transport", () => {
  assert.equal(DEFAULT_CONFIG.maxPromptBytes, 1_500_000);
});

test("bridge config accepts capabilities.image on a model", () => {
  assert.doesNotThrow(() =>
    validateBridgeConfig({
      ...DEFAULT_CONFIG,
      models: [
        {
          id: "custom-vision",
          name: "Custom vision model",
          reasoning: true,
          contextWindow: 1_000_000,
          maxTokens: 64_000,
          capabilities: { image: true },
        },
      ],
    }),
  );
});

test("bridge config rejects non-boolean image capabilities", () => {
  assert.throws(
    () =>
      validateBridgeConfig({
        ...DEFAULT_CONFIG,
        models: [
          {
            id: "bad-vision",
            name: "Bad vision model",
            reasoning: true,
            contextWindow: 1_000_000,
            maxTokens: 64_000,
            capabilities: { image: "yes" as unknown as boolean },
          },
        ],
      }),
    /capabilities\.image must be boolean/,
  );
});

test("bridge config rejects unsafe custom-agent path segments", () => {
  for (const agentName of ["../escape", "nested/agent", "nested\\agent", ".", "..", " trailing ", "bad:name"]) {
    assert.throws(
      () => validateBridgeConfig({ ...DEFAULT_CONFIG, agentName }),
      /agentName/,
    );
  }
});

test("bridge config validates booleans and default effort from JSON-shaped values", () => {
  assert.throws(
    () => validateBridgeConfig({ ...DEFAULT_CONFIG, sandbox: "false" as unknown as boolean }),
    /sandbox must be boolean/,
  );
  assert.throws(
    () => validateBridgeConfig({ ...DEFAULT_CONFIG, defaultEffort: "max" as unknown as "high" }),
    /defaultEffort must be low, medium, high/,
  );
});

test("bridge config rejects ambiguous or malformed effort route maps", () => {
  const baseModel = {
    id: "route-test",
    name: "Route test",
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  };

  assert.throws(
    () =>
      validateBridgeConfig({
        ...DEFAULT_CONFIG,
        models: [{ ...baseModel, agyModelId: "exact", agyModelIdsByEffort: { high: "tier-high" } }],
      }),
    /cannot define both agyModelId and agyModelIdsByEffort/,
  );
  assert.throws(
    () => validateBridgeConfig({ ...DEFAULT_CONFIG, models: [{ ...baseModel, agyModelIdsByEffort: {} }] }),
    /must contain at least one route/,
  );
  assert.throws(
    () =>
      validateBridgeConfig({
        ...DEFAULT_CONFIG,
        models: [
          {
            ...baseModel,
            agyModelIdsByEffort: { ultra: "tier-ultra" } as unknown as { high: string },
          },
        ],
      }),
    /unsupported effort route: ultra/,
  );
  assert.throws(
    () =>
      validateBridgeConfig({
        ...DEFAULT_CONFIG,
        models: [{ ...baseModel, agyModelIdsByEffort: { high: "" } }],
      }),
    /route high must be a non-empty string/,
  );
});

test("bridge config validates model runtime primitives", () => {
  assert.throws(
    () =>
      validateBridgeConfig({
        ...DEFAULT_CONFIG,
        models: [
          {
            id: "bad-reasoning",
            name: "Bad reasoning",
            reasoning: "yes" as unknown as boolean,
            contextWindow: 1_000_000,
            maxTokens: 64_000,
          },
        ],
      }),
    /reasoning must be boolean/,
  );
  assert.throws(
    () =>
      validateBridgeConfig({
        ...DEFAULT_CONFIG,
        models: [
          {
            id: "bad-context",
            name: "Bad context",
            reasoning: true,
            contextWindow: 1.5,
            maxTokens: 64_000,
          },
        ],
      }),
    /Invalid contextWindow/,
  );
});
