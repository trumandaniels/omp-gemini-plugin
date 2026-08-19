import assert from "node:assert/strict";
import test from "node:test";

import { bridgeModelSupportsImages } from "../src/model-capabilities.ts";

const base = { name: "x", reasoning: true, contextWindow: 1, maxTokens: 1 };

test("Gemini logical models default to image-capable", () => {
  assert.equal(bridgeModelSupportsImages({ ...base, id: "gemini-3.7-flash" }), true);
  assert.equal(
    bridgeModelSupportsImages({
      ...base,
      id: "logical",
      agyModelIdsByEffort: { high: "gemini-3.1-pro-high" },
    }),
    true,
  );
});

test("capabilities.image marks configured models image-capable", () => {
  assert.equal(bridgeModelSupportsImages({ ...base, id: "custom", capabilities: { image: true } }), true);
  assert.equal(bridgeModelSupportsImages({ ...base, id: "custom", capabilities: { vision: true } }), true);
});

test("supportsImages false overrides Gemini inference", () => {
  assert.equal(
    bridgeModelSupportsImages({ ...base, id: "gemini-3.7-flash", supportsImages: false }),
    false,
  );
});

test("auto remains text-only without an explicit capability", () => {
  assert.equal(bridgeModelSupportsImages({ ...base, id: "auto" }), false);
  assert.equal(
    bridgeModelSupportsImages({ ...base, id: "auto", capabilities: { image: true } }),
    true,
  );
});
