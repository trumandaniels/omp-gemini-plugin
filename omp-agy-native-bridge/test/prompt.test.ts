import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildProviderPrompt } from "../src/prompt.ts";

test("provider prompt tells agy to request OMP task instead of native subagents", () => {
  const result = buildProviderPrompt(
    {
      systemPrompt: ["Be accurate."],
      messages: [{ role: "user", content: "Inspect the project", timestamp: 1 }],
      tools: [
        {
          name: "task",
          description: "Spawn OMP subagents",
          parameters: { type: "object", properties: { prompt: { type: "string" } } },
        },
      ],
    },
    DEFAULT_CONFIG,
  );
  assert.deepEqual(result.toolNames, ["task"]);
  assert.match(result.prompt, /Do NOT invoke Antigravity tools/);
  assert.match(result.prompt, /OMP-native subagents/);
  assert.match(result.prompt, /Inspect the project/);
});
