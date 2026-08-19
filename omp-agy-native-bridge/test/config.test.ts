import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG, validateBridgeConfig } from "../src/config.ts";

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
