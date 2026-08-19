import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  appendMissingAgyRecipientRetryInstruction,
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
  assert.match(result.prompt, /An OMP tool may have a coordination name such as "hub" or an action name such as "read"/);
  assert.match(result.prompt, /"name": "hub"/);
  assert.match(result.prompt, /If that schema exposes a "name" field/);
  assert.match(result.prompt, /"name": \{/);
});

test("provider prompt treats OMP tool names as structured calls, never AGY recipients", () => {
  const result = buildProviderPrompt(
    {
      systemPrompt: ["Inspect accurately."],
      messages: [{ role: "user", content: "Read package.json", timestamp: 1 }],
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
        {
          name: "glob",
          description: "Find files",
          parameters: { type: "object", properties: { pattern: { type: "string" } } },
        },
      ],
    },
    DEFAULT_CONFIG,
  );

  assert.match(result.prompt, /Every name under "Available OMP tools" is a structured OMP tool name/);
  assert.match(result.prompt, /Never call send_message or manage_inbox with an OMP tool name such as read, glob, grep, bash/);
  assert.match(result.prompt, /Put that tool name in the outer "tool_calls" array instead/);
  assert.match(result.prompt, /never reinterpret that name as an Antigravity recipient/);
});

test("provider prompt treats structured output as the return channel after an incomplete OMP result", () => {
  const result = buildProviderPrompt(
    {
      systemPrompt: ["Inspect global OMP configuration accurately."],
      messages: [
        {
          role: "user",
          content: "what are inside the global config of agents? e.g. what agents do I already have globally?",
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "glob",
              arguments: {
                path: "/home/truman/.omp/**/*;/home/truman/.config/omp/**/*",
              },
            },
          ],
          stopReason: "toolUse",
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "glob",
          content: [
            {
              type: "text",
              text: "/home/truman/.omp/agent/config.yml\n… 192 more files\ntruncated: limit 200 results\nskipped missing: /home/truman/.config/omp/**/*",
            },
          ],
        },
      ],
      tools: [
        {
          name: "glob",
          description: "Find paths",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
        {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    },
    DEFAULT_CONFIG,
  );

  assert.match(result.prompt, /After OMP supplies a tool result/);
  assert.match(result.prompt, /Do not report back through an Antigravity message tool/);
  assert.match(result.prompt, /OMP is not an Antigravity agent or message recipient/);
  assert.match(result.prompt, /Never call send_message or manage_inbox with recipient\/to "omp", "parent", "main", or any OMP tool name/);
  assert.match(result.prompt, /terminal structured response is the return channel to OMP/);
  assert.match(result.prompt, /Treat result warnings such as "truncated", "limit reached", "skipped missing"/);
  assert.match(result.prompt, /more targeted OMP tool calls are required/);
  assert.match(result.prompt, /Do not finalize from an incomplete result/);
  assert.match(result.prompt, /what agents do I already have globally\?/);
  assert.match(result.prompt, /truncated: limit 200 results/);
  assert.match(result.prompt, /skipped missing: \/home\/truman\/\.config\/omp\/\*\*\/\*/);
});

test("provider retry correction discards AGY probes and insists on structured return", () => {
  const corrected = appendProviderHarnessRetryInstruction(
    "ORIGINAL PROMPT",
    ["send_message", "manage_task", "send_message"],
  );
  assert.match(corrected, /^ORIGINAL PROMPT/);
  assert.match(corrected, /manage_task, send_message/);
  assert.match(corrected, /previous attempt was discarded/i);
  assert.match(corrected, /Do not invoke any Antigravity tool on this retry/);
  assert.match(corrected, /OMP tool names such as read, glob, grep, bash/);
  assert.match(corrected, /OMP is not an Antigravity message recipient/);
  assert.match(corrected, /Never call send_message or manage_inbox with recipient\/to "omp", "parent", "main", or any OMP tool name/);
  assert.match(corrected, /Put the answer in the outer "text" field/);
  assert.match(corrected, /If an OMP tool result is truncated, limit-reached, skipped, missing, or otherwise incomplete/);
  assert.match(corrected, /informational OMP question, answer directly with no tool call/);
  assert.match(corrected, /return only an OMP "task" tool call/);
});

test("missing-recipient retry correction treats OMP as the host, not an AGY peer", () => {
  const corrected = appendMissingOmpRecipientRetryInstruction("ORIGINAL PROMPT");
  assert.match(corrected, /^ORIGINAL PROMPT/);
  assert.match(corrected, /recipient named "omp"/);
  assert.match(corrected, /OMP is the host application and tool dispatcher/);
  assert.match(corrected, /not an Antigravity agent, inbox, recipient, or conversation peer/);
  assert.match(corrected, /Do not call send_message or manage_inbox at all on this retry/);
  assert.match(corrected, /terminal structured output is the return channel to OMP/);
  assert.match(corrected, /request narrower OMP tool calls before answering/);
  assert.match(corrected, /return only a valid OMP tool call/);
});

test("missing-recipient retry correction redirects read to OMP structured tool_calls", () => {
  const corrected = appendMissingAgyRecipientRetryInstruction("ORIGINAL PROMPT", "read");
  assert.match(corrected, /recipient named "read"/);
  assert.match(corrected, /OMP tool names such as read, glob, grep, bash/);
  assert.match(corrected, /If "read" is an OMP tool name/);
  assert.match(corrected, /outer "tool_calls" array/);
  assert.match(corrected, /Do not call send_message or manage_inbox at all on this retry/);
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
