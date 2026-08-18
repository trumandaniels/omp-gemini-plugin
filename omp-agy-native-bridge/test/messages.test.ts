import assert from "node:assert/strict";
import test from "node:test";

import { serializeConversation } from "../src/messages.ts";

test("conversation serialization preserves tool-call IDs and omits private reasoning", () => {
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
  assert.equal(parsed.messages[0].content[1].id, "call-1");
  assert.equal(parsed.messages[1].toolCallId, "call-1");
  assert.doesNotMatch(serialized, /private/);
});

test("conversation serialization fails rather than silently dropping canonical history", () => {
  assert.throws(
    () =>
      serializeConversation(
        { systemPrompt: [], messages: [{ role: "user", content: "x".repeat(1_000) }] },
        { maxHistoryChars: 100 },
      ),
    /Compact the OMP session/,
  );
});
