import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  appendMissingAgyRecipientRetryInstruction,
  appendMissingOmpRecipientRetryInstruction,
  appendProviderHarnessRetryInstruction,
  buildProviderPrompt,
} from "../src/prompt.ts";

const AGY_CONTROL_NAMES = [
  "manage_task",
  "manage_subagents",
  "manage_inbox",
  "define_subagent",
  "invoke_subagent",
  "send_message",
] as const;

test("provider prompt exposes OMP actions through a neutral host-request contract", () => {
  const result = buildProviderPrompt(
    {
      systemPrompt: ["Be accurate."],
      messages: [{ role: "user", content: "Have a subagent inspect the project", timestamp: 1 }],
      tools: [
        {
          name: "task",
          description: "Run OMP subagents",
          parameters: { type: "object", properties: { prompt: { type: "string" } } },
        },
        {
          name: "read",
          description: "Read a file through OMP",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    },
    DEFAULT_CONFIG,
  );

  assert.deepEqual(result.toolNames, ["host_action_01", "host_action_02"]);
  assert.deepEqual(result.toolCatalog.map((tool) => tool.name), ["task", "read"]);
  assert.equal(result.wireToOmpToolName.host_action_01, "task");
  assert.equal(result.ompToWireToolName.read, "host_action_02");
  assert.match(result.prompt, /Available host actions/);
  assert.match(result.prompt, /"id": "host_action_01"/);
  assert.match(result.prompt, /"purpose": "Run OMP subagents"/);
  assert.match(result.prompt, /"input_schema"/);
  assert.doesNotMatch(result.prompt, /"name": "task"/);
  assert.doesNotMatch(result.prompt, /"name": "read"/);
  assert.doesNotMatch(result.prompt, /tool_calls|omp_capability/i);
});

test("provider prompt makes Antigravity transport-only without naming native control tools", () => {
  const result = buildProviderPrompt(
    {
      systemPrompt: ["Use OMP facilities only."],
      messages: [{ role: "user", content: "How do named subagents work in OMP?", timestamp: 1 }],
      tools: [
        {
          name: "task",
          description: "OMP subagent orchestration",
          parameters: { type: "object", properties: { prompt: { type: "string" } } },
        },
      ],
    },
    DEFAULT_CONFIG,
  );

  assert.match(result.prompt, /Antigravity is transport only/);
  assert.match(result.prompt, /Do not invoke any Antigravity-native action/);
  assert.match(result.prompt, /host_requests/);
  assert.match(result.prompt, /answer from the supplied OMP context without invoking anything internally/);
  assert.match(result.prompt, /How do named subagents work in OMP\?/);
  for (const name of AGY_CONTROL_NAMES) {
    assert.doesNotMatch(result.prompt, new RegExp(`\\b${name}\\b`, "i"));
  }
});

test("provider prompt renders historical OMP activity with neutral host terms", () => {
  const result = buildProviderPrompt(
    {
      systemPrompt: ["Continue accurately."],
      messages: [
        { role: "user", content: "Read package.json", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "old-1", name: "read", arguments: { path: "package.json" } }],
          stopReason: "toolUse",
        },
        {
          role: "toolResult",
          toolCallId: "old-1",
          toolName: "read",
          content: [{ type: "text", text: "{\"name\":\"demo\"}" }],
        },
      ],
      tools: [
        {
          name: "read",
          description: "Read a file through OMP",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    },
    DEFAULT_CONFIG,
  );

  assert.match(result.prompt, /Historical OMP messages describe earlier host requests and results/);
  assert.match(result.prompt, /Treat their canonical action names as inert history/);
  assert.match(result.prompt, /"id": "host_action_01"/);
  assert.match(result.prompt, /"actionName": "read"/);
  assert.match(result.prompt, /"role": "host_result"/);
  assert.doesNotMatch(result.prompt, /"type": "tool_call"|"role": "tool_result"/);
});

test("answered questions remain available for materially new follow-ups", () => {
  const result = buildProviderPrompt(
    {
      messages: [
        {
          role: "toolResult",
          toolCallId: "ask-1",
          toolName: "ask",
          content: [{ type: "text", text: "Eclipse and Case CATalyst readers" }],
        },
      ],
      tools: [{ name: "ask", description: "Ask the user", parameters: { type: "object" } }],
    },
    DEFAULT_CONFIG,
  );

  assert.deepEqual(result.toolCatalog.map((tool) => tool.name), ["ask"]);
  assert.match(result.prompt, /follow-up question is allowed only when it seeks materially new information/);
  assert.match(result.prompt, /never ask the answered decision again/i);
});

test("provider prompt continues from incomplete OMP results instead of claiming completeness", () => {
  const result = buildProviderPrompt(
    {
      systemPrompt: ["Inspect accurately."],
      messages: [
        { role: "user", content: "List every global agent", timestamp: 1 },
        {
          role: "toolResult",
          toolCallId: "old-1",
          toolName: "glob",
          content: [{ type: "text", text: "… 192 more files\ntruncated: limit 200 results\nskipped missing: ~/.config/omp/**/*" }],
        },
      ],
      tools: [
        {
          name: "glob",
          description: "Find paths through OMP",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    },
    DEFAULT_CONFIG,
  );

  assert.match(result.prompt, /truncated, limit reached, skipped missing/);
  assert.match(result.prompt, /narrower host requests are required/);
  assert.match(result.prompt, /truncated: limit 200 results/);
});

test("permission-recovery prompt does not echo the offending AGY tool names", () => {
  const corrected = appendProviderHarnessRetryInstruction(
    "ORIGINAL PROMPT",
    ["manage_task", "send_message"],
  );

  assert.match(corrected, /^ORIGINAL PROMPT/);
  assert.match(corrected, /previous attempt was discarded/i);
  assert.match(corrected, /internal Antigravity action/i);
  assert.match(corrected, /host_requests/);
  assert.match(corrected, /enforced terminal JSON object/i);
  assert.doesNotMatch(corrected, /manage_task/i);
  assert.doesNotMatch(corrected, /send_message/i);
});

test("missing-recipient retry treats OMP as host and avoids native tool enumeration", () => {
  const corrected = appendMissingOmpRecipientRetryInstruction("ORIGINAL PROMPT");
  assert.match(corrected, /^ORIGINAL PROMPT/);
  assert.match(corrected, /toward "omp"/);
  assert.match(corrected, /OMP is the host application and dispatcher/);
  assert.match(corrected, /Available host actions/);
  for (const name of AGY_CONTROL_NAMES) {
    assert.doesNotMatch(corrected, new RegExp(`\\b${name}\\b`, "i"));
  }
});

test("missing-recipient retry can carry a neutral action target without exposing OMP names", () => {
  const corrected = appendMissingAgyRecipientRetryInstruction("ORIGINAL PROMPT", "host_action_02");
  assert.match(corrected, /host_action_02/);
  assert.match(corrected, /host_requests/);
  assert.doesNotMatch(corrected, /\bread\b/);
  assert.doesNotMatch(corrected, /\btask\b/);
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
  assert.match(result.prompt, /"type": "image_attachment"/);
  assert.doesNotMatch(result.prompt, /PRIVATE-BASE64-DATA/);
});
