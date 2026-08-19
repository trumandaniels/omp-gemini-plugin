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

test("provider prompt maps staged OMP images to AGY prompt-media mentions", () => {
  const result = buildProviderPrompt(
    {
      systemPrompt: ["Be accurate."],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Explain the screenshot" },
            { type: "image", data: "PRIVATE-BASE64-DATA", mimeType: "image/png" },
          ],
        },
      ],
      tools: [],
    },
    DEFAULT_CONFIG,
    [
      {
        attachmentIndex: 1,
        messageIndex: 0,
        contentIndex: 1,
        mediaType: "image/png",
        sizeBytes: 10,
        absolutePath: "/tmp/image.png",
        promptPath: "./.omp-agy-media-test/image-1.png",
      },
    ],
  );

  assert.match(result.prompt, /# OMP image attachments/);
  assert.match(result.prompt, /@\.\/\.omp-agy-media-test\/image-1\.png/);
  assert.match(result.prompt, /inspect those as attached media without invoking file tools/);
  assert.match(result.prompt, /"type": "image_attachment"/);
  assert.doesNotMatch(result.prompt, /PRIVATE-BASE64-DATA/);
});
