import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  appendMissingOmpRecipientRetryInstruction,
  appendProviderHarnessRetryInstruction,
  buildProviderPrompt,
} from "../src/prompt.ts";

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
  assert.match(result.prompt, /To actually create or run an OMP subagent, return a call to the OMP tool named "task"/);
  assert.match(result.prompt, /Inspect the project/);
});

test("provider prompt answers named OMP subagent questions without AGY control tools", () => {
  const result = buildProviderPrompt(
    {
      systemPrompt: ["You are OMP."],
      messages: [{ role: "user", content: "how to make named subagents?", timestamp: 1 }],
      tools: [
        {
          name: "task",
          description: "Run OMP subagents",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string" },
              agent: { type: "string" },
              task: { type: "string" },
            },
          },
        },
        {
          name: "hub",
          description: "OMP agent coordination",
          parameters: { type: "object" },
        },
      ],
    },
    DEFAULT_CONFIG,
  );

  assert.match(result.prompt, /unqualified words such as "agent", "subagent", "named subagent"/);
  assert.match(result.prompt, /For an informational question about OMP subagents, answer directly/);
  assert.match(result.prompt, /how to make named subagents\?/);
  assert.match(result.prompt, /It is not an Antigravity recipient/);
  assert.match(result.prompt, /Never send a message to a recipient named "omp"/);
  for (const tool of [
    "manage_task",
    "manage_subagents",
    "manage_inbox",
    "define_subagent",
    "invoke_subagent",
    "send_message",
  ]) {
    assert.match(result.prompt, new RegExp(`\\b${tool}\\b`));
  }
  assert.match(result.prompt, /An OMP tool may have a similar coordination name such as "hub"/);
  assert.match(result.prompt, /"name": "hub"/);
  assert.match(result.prompt, /If that schema exposes a "name" field/);
  assert.match(result.prompt, /"name": \{/);
});

test("provider retry correction discards AGY list probes and insists on OMP semantics", () => {
  const corrected = appendProviderHarnessRetryInstruction(
    "ORIGINAL PROMPT",
    ["manage_task", "manage_subagents", "manage_task"],
  );
  assert.match(corrected, /^ORIGINAL PROMPT/);
  assert.match(corrected, /manage_subagents, manage_task/);
  assert.match(corrected, /previous attempt was discarded/i);
  assert.match(corrected, /Do not invoke any Antigravity tool on this retry/);
  assert.match(corrected, /informational OMP question, answer directly with no tool call/);
  assert.match(corrected, /return only an OMP "task" tool call/);
});

test("missing-recipient retry correction treats OMP as the host, not an AGY peer", () => {
  const corrected = appendMissingOmpRecipientRetryInstruction("ORIGINAL PROMPT");
  assert.match(corrected, /^ORIGINAL PROMPT/);
  assert.match(corrected, /recipient named "omp"/);
  assert.match(corrected, /OMP is the host application and tool dispatcher/);
  assert.match(corrected, /not an Antigravity agent, inbox, recipient, or conversation peer/);
  assert.match(corrected, /Do not call send_message/);
  assert.match(corrected, /return only a valid OMP tool call/);
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
