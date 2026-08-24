import assert from "node:assert/strict";
import test from "node:test";

import { serializeConversation } from "../src/messages.ts";

test("conversation serialization uses neutral host history and omits private reasoning", () => {
  const serialized = serializeConversation(
    {
      systemPrompt: ["System"],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private" },
            { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "contents" }],
        },
      ],
    },
    { maxHistoryChars: 100_000 },
  );
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.messages[0].content[1].requestId, "call-1");
  assert.equal(parsed.messages[0].content[1].type, "host_request_history");
  assert.equal(parsed.messages[1].requestId, "call-1");
  assert.equal(parsed.messages[1].role, "host_result");
  assert.doesNotMatch(serialized, /private|tool_call|tool_result/);
});

test("conversation serialization replaces image bytes with attachment placeholders", () => {
  const serialized = serializeConversation(
    {
      systemPrompt: [],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Inspect this" },
            { type: "image", data: "PRIVATE-BASE64-DATA", mimeType: "image/png" },
          ],
        },
      ],
    },
    { maxHistoryChars: 100_000 },
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
  const parsed = JSON.parse(serialized);
  assert.deepEqual(parsed.messages[0].content[1], {
    type: "image_attachment",
    attachmentIndex: 1,
    mediaType: "image/png",
  });
  assert.doesNotMatch(serialized, /PRIVATE-BASE64-DATA/);
});

test("conversation serialization compacts old host results and reports omitted context", () => {
  const messages = Array.from({ length: 6 }, (_, index) => [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { path: `${index}.txt` } }],
    },
    {
      role: "toolResult",
      toolCallId: `call-${index}`,
      toolName: "read",
      content: [{ type: "text", text: `${index}:` + "x".repeat(300) }],
    },
  ]).flat();

  const parsed = JSON.parse(
    serializeConversation({ systemPrompt: [], messages }, { maxHistoryChars: 4_650 }),
  );

  assert.deepEqual(parsed.historyCompaction, {
    compactedHostResults: 2,
    omittedCharacters: 658,
  });
  assert.equal(parsed.messages[1].content[0].type, "host_result_compacted");
  assert.equal(parsed.messages[3].content[0].type, "host_result_compacted");
  assert.match(parsed.messages[5].content[0].text, /^2:x+$/);
  assert.match(parsed.messages.at(-1).content[0].text, /^5:x+$/);
});

test("conversation serialization preserves four recent exact host results", () => {
  assert.throws(
    () =>
      serializeConversation(
        {
          systemPrompt: [],
          messages: Array.from({ length: 4 }, (_, index) => ({
            role: "toolResult",
            toolCallId: `call-${index}`,
            toolName: "read",
            content: [{ type: "text", text: "x".repeat(1_000) }],
          })),
        },
        { maxHistoryChars: 100 },
      ),
    /four most recent host results/,
  );
});
