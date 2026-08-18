import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG, DEFAULT_MODELS } from "../src/config.ts";
import { mergeDiscoveredModels, parseAgyModelsOutput } from "../src/model-discovery.ts";

test("parseAgyModelsOutput extracts current model slugs from table-like output", () => {
  const output = `Available models\nMODEL                         DESCRIPTION\n* gemini-3.1-pro-high         Gemini Pro\n  gemini-3.7-flash-medium     Fast\n  claude-sonnet-4-6           Claude\n`;
  assert.deepEqual(parseAgyModelsOutput(output), [
    "gemini-3.1-pro-high",
    "gemini-3.7-flash-medium",
    "claude-sonnet-4-6",
  ]);
});

test("mergeDiscoveredModels always keeps auto and filters non-Gemini by default", () => {
  const models = mergeDiscoveredModels(
    DEFAULT_MODELS,
    {
      ok: true,
      models: ["gemini-3.1-pro-high", "claude-sonnet-4-6"],
      stdout: "",
      stderr: "",
      status: 0,
    },
    DEFAULT_CONFIG,
  );
  assert.deepEqual(models.map((model) => model.id), ["auto", "gemini-3.1-pro-high"]);
});
