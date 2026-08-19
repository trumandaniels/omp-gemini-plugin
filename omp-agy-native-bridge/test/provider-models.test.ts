import assert from "node:assert/strict";
import test from "node:test";

import { buildOmpProviderModels } from "../src/provider-models.ts";

const base = {
  name: "Gemini",
  reasoning: true,
  contextWindow: 1_000_000,
  maxTokens: 64_000,
};

test("buildOmpProviderModels emits only OMP provider-model fields", () => {
  const [model] = buildOmpProviderModels(
    [
      {
        ...base,
        id: "gemini-3.7-flash",
        agyModelIdsByEffort: {
          low: "gemini-3.7-flash-low",
          medium: "gemini-3.7-flash-medium",
          high: "gemini-3.7-flash-high",
        },
      },
    ],
    true,
  );

  assert.deepEqual(model.input, ["text", "image"]);
  assert.deepEqual(model.thinking?.efforts, ["low", "medium", "high"]);
  assert.equal(model.thinking?.defaultLevel, "high");
  assert.equal(model.thinking?.requiresEffort, true);
  assert.equal(Object.prototype.hasOwnProperty.call(model, "capabilities"), false);
  assert.deepEqual(Object.keys(model).sort(), [
    "contextWindow",
    "cost",
    "id",
    "input",
    "maxTokens",
    "name",
    "reasoning",
    "thinking",
  ]);
});

test("buildOmpProviderModels keeps auto conservative for image input", () => {
  const [model] = buildOmpProviderModels(
    [{ ...base, id: "auto", name: "Auto" }],
    true,
  );
  assert.deepEqual(model.input, ["text"]);
  assert.equal(model.thinking, undefined);
});

test("buildOmpProviderModels honors explicit image override and global disable", () => {
  const [enabled] = buildOmpProviderModels(
    [{ ...base, id: "custom", supportsImages: true }],
    true,
  );
  const [disabled] = buildOmpProviderModels(
    [{ ...base, id: "custom", supportsImages: true }],
    false,
  );
  assert.deepEqual(enabled.input, ["text", "image"]);
  assert.deepEqual(disabled.input, ["text"]);
});

test("buildOmpProviderModels rejects an empty tier route map", () => {
  assert.throws(
    () => buildOmpProviderModels([{ ...base, id: "broken", agyModelIdsByEffort: {} }], true),
    /agyModelIdsByEffort is empty/,
  );
});
