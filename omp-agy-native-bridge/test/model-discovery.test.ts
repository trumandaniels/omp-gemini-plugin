import assert from "node:assert/strict";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DEFAULT_CONFIG, DEFAULT_MODELS } from "../src/config.ts";
import {
  discoverAgyModelsSync,
  mergeDiscoveredModels,
  parseAgyModelsOutput,
} from "../src/model-discovery.ts";

const fakeAgyModels = fileURLToPath(new URL("./fixtures/fake-agy-models", import.meta.url));
await chmod(fakeAgyModels, 0o755);

test("parseAgyModelsOutput extracts current model slugs from table-like output", () => {
  const output = `Available models
MODEL                         DESCRIPTION
* gemini-3.1-pro-high         Gemini Pro
  gemini-3.7-flash-medium     Fast
  claude-sonnet-4-6           Claude
`;
  assert.deepEqual(parseAgyModelsOutput(output), [
    "gemini-3.1-pro-high",
    "gemini-3.7-flash-medium",
    "claude-sonnet-4-6",
  ]);
});

test("parseAgyModelsOutput accepts machine-readable arrays and slug-keyed maps", () => {
  assert.deepEqual(
    parseAgyModelsOutput(
      JSON.stringify({
        models: [
          { id: "gemini-3.7-flash-low", displayName: "Gemini Flash Low" },
          { model: "gemini-3.7-flash-high" },
          { slug: "claude-sonnet-4-6" },
        ],
      }),
    ),
    ["gemini-3.7-flash-low", "gemini-3.7-flash-high", "claude-sonnet-4-6"],
  );

  assert.deepEqual(
    parseAgyModelsOutput(
      JSON.stringify({
        data: {
          "gemini-3.1-pro-low": { description: "Low" },
          "gemini-3.1-pro-high": { description: "High" },
        },
      }),
    ),
    ["gemini-3.1-pro-low", "gemini-3.1-pro-high"],
  );
});

test("parseAgyModelsOutput ignores descriptive JSON strings that are not model IDs", () => {
  assert.deepEqual(
    parseAgyModelsOutput(
      JSON.stringify({
        models: [{ id: "gemini-3.7-flash-high", description: "gemini is a model family" }],
        note: "claude-sonnet is unavailable",
      }),
    ),
    ["gemini-3.7-flash-high"],
  );
});

test("discoverAgyModelsSync prefers the plain listing and sanitizes account-routing secrets", () => {
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "must-not-leak";
  try {
    const result = discoverAgyModelsSync(
      { agyBinary: fakeAgyModels, sanitizeAccountEnvironment: true },
      process.cwd(),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.models, ["gemini-3.1-pro-low", "gemini-3.1-pro-high"]);
  } finally {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  }
});

test("discoverAgyModelsSync falls back to JSON only when plain output is unrecognized", () => {
  const previous = process.env.FAKE_AGY_MODELS_PLAIN_EMPTY;
  process.env.FAKE_AGY_MODELS_PLAIN_EMPTY = "1";
  try {
    const result = discoverAgyModelsSync(
      { agyBinary: fakeAgyModels, sanitizeAccountEnvironment: true },
      process.cwd(),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.models, ["gemini-3.7-flash-low", "gemini-3.7-flash-high"]);
  } finally {
    if (previous === undefined) delete process.env.FAKE_AGY_MODELS_PLAIN_EMPTY;
    else process.env.FAKE_AGY_MODELS_PLAIN_EMPTY = previous;
  }
});

test("discoverAgyModelsSync preserves a plain transport failure without probing another format", () => {
  const previous = process.env.FAKE_AGY_MODELS_PLAIN_FAIL;
  process.env.FAKE_AGY_MODELS_PLAIN_FAIL = "1";
  try {
    const result = discoverAgyModelsSync(
      { agyBinary: fakeAgyModels, sanitizeAccountEnvironment: true },
      process.cwd(),
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.models, []);
    assert.equal(result.status, 4);
    assert.match(result.stderr, /loadCodeAssist/);
    assert.match(result.stderr, /x509: certificate signed by unknown authority/);
  } finally {
    if (previous === undefined) delete process.env.FAKE_AGY_MODELS_PLAIN_FAIL;
    else process.env.FAKE_AGY_MODELS_PLAIN_FAIL = previous;
  }
});

test("mergeDiscoveredModels collapses raw tier aliases into logical Gemini families", () => {
  const models = mergeDiscoveredModels(
    DEFAULT_MODELS,
    {
      ok: true,
      models: [
        "gemini-3.7-flash-low",
        "gemini-3.7-flash-medium",
        "gemini-3.7-flash-high",
        "gemini-3.1-pro-low",
        "gemini-3.1-pro-high",
      ],
      stdout: "",
      stderr: "",
      status: 0,
    },
    DEFAULT_CONFIG,
  );
  assert.deepEqual(
    models.map((model) => model.id),
    ["auto", "gemini-3.1-pro", "gemini-3.7-flash"],
  );
  assert.deepEqual(models[1]?.agyModelIdsByEffort, {
    low: "gemini-3.1-pro-low",
    high: "gemini-3.1-pro-high",
  });
  assert.deepEqual(models[2]?.agyModelIdsByEffort, {
    low: "gemini-3.7-flash-low",
    medium: "gemini-3.7-flash-medium",
    high: "gemini-3.7-flash-high",
  });
});

test("mergeDiscoveredModels drops Gemini suffix IDs from returned logical IDs", () => {
  const models = mergeDiscoveredModels(
    DEFAULT_MODELS,
    {
      ok: true,
      models: ["gemini-3.7-flash-low", "gemini-3.7-flash-medium", "gemini-3.7-flash-high", "claude-sonnet-4-6"],
      stdout: "",
      stderr: "",
      status: 0,
    },
    DEFAULT_CONFIG,
  );
  assert.equal(models.some((model) => /-(low|medium|high)$/.test(model.id)), false);
});

test("mergeDiscoveredModels keeps non-Gemini aliases filtered out by default", () => {
  const models = mergeDiscoveredModels(
    DEFAULT_MODELS,
    {
      ok: true,
      models: ["gemini-3.7-flash-low", "claude-sonnet-4-6", "gpt-oss-120b"],
      stdout: "",
      stderr: "",
      status: 0,
    },
    { ...DEFAULT_CONFIG, includeNonGeminiModels: false },
  );
  const ids = models.map((model) => model.id);
  assert.deepEqual(ids, ["auto", "gemini-3.7-flash"]);
  assert.ok(!ids.includes("claude-sonnet-4-6"));
});

test("mergeDiscoveredModels preserves explicit includeNonGeminiModels", () => {
  const models = mergeDiscoveredModels(
    DEFAULT_MODELS,
    {
      ok: true,
      models: ["gemini-3.1-pro-low", "claude-sonnet-4-6", "gpt-oss-120b"],
      stdout: "",
      stderr: "",
      status: 0,
    },
    { ...DEFAULT_CONFIG, includeNonGeminiModels: true },
  );
  const ids = models.map((model) => model.id);
  assert.deepEqual(ids, ["auto", "claude-sonnet-4-6", "gemini-3.1-pro", "gpt-oss-120b"]);
});

test("configured raw Gemini suffix IDs collapse to logical entries", () => {
  const models = mergeDiscoveredModels(
    [
      {
        id: "gemini-3.7-flash-high",
        name: "Configured high alias",
        reasoning: true,
        contextWindow: 100,
        maxTokens: 100,
      },
    ],
    {
      ok: true,
      models: ["gemini-3.7-flash-low", "gemini-3.7-flash-medium", "gemini-3.7-flash-high"],
      stdout: "",
      stderr: "",
      status: 0,
    },
    DEFAULT_CONFIG,
  );
  assert.deepEqual(models.map((model) => model.id), ["auto", "gemini-3.7-flash"]);
  assert.deepEqual(models[1]?.agyModelIdsByEffort, {
    high: "gemini-3.7-flash-high",
    low: "gemini-3.7-flash-low",
    medium: "gemini-3.7-flash-medium",
  });
  assert.equal(models[1]?.agyModelId, undefined);
});

test("mergeDiscoveredModels keeps configured metadata while merging discovered tiers", () => {
  const models = mergeDiscoveredModels(
    [
      {
        id: "gemini-3.7-flash",
        name: "Gemini 3.7 Flash",
        reasoning: true,
        contextWindow: 10,
        maxTokens: 10,
        effort: "low",
        agyModelIdsByEffort: {
          low: "gemini-3.7-flash-low",
          high: "gemini-3.7-flash-high",
        },
      },
    ],
    {
      ok: true,
      models: ["gemini-3.7-flash-low", "gemini-3.7-flash-medium", "gemini-3.7-flash-high"],
      stdout: "",
      stderr: "",
      status: 0,
    },
    DEFAULT_CONFIG,
  );
  const merged = models.find((model) => model.id === "gemini-3.7-flash");
  assert.equal(merged?.contextWindow, 1_000_000);
  assert.equal(merged?.maxTokens, 64_000);
  assert.deepEqual(merged?.agyModelIdsByEffort, {
    low: "gemini-3.7-flash-low",
    high: "gemini-3.7-flash-high",
    medium: "gemini-3.7-flash-medium",
  });
});
