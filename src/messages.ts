import type { StagedBridgeImage } from "./media.ts";
import type { BridgeConfig } from "./types.ts";

function jsonSafe(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "function" || typeof item === "symbol") return undefined;
    if (typeof item === "bigint") return item.toString();
    if (typeof item === "number" && !Number.isFinite(item)) return String(item);
    if (item && typeof item === "object") {
      if (seen.has(item)) return "[circular omitted]";
      seen.add(item);
    }
    return item;
  });
  if (encoded === undefined) return null;
  try {
    return JSON.parse(encoded);
  } catch {
    return "[unserializable]";
  }
}

function imageKey(messageIndex: number, contentIndex: number): string {
  return `${messageIndex}:${contentIndex}`;
}

function normalizeContent(
  content: unknown,
  messageIndex: number,
  images: ReadonlyMap<string, StagedBridgeImage>,
): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [{ type: "text", text: String(content ?? "") }];

  return content.map((block, contentIndex) => {
    if (!block || typeof block !== "object") return { type: "text", text: String(block ?? "") };
    const item = block as Record<string, unknown>;
    switch (item.type) {
      case "text":
        return { type: "text", text: String(item.text ?? "") };
      case "image": {
        const attachment = images.get(imageKey(messageIndex, contentIndex));
        return attachment
          ? {
              type: "image_attachment",
              attachmentIndex: attachment.attachmentIndex,
              mediaType: attachment.mediaType,
            }
          : {
              type: "image_omitted",
              mediaType: String(item.mimeType ?? item.mediaType ?? "unknown"),
            };
      }
      case "thinking":
      case "redactedThinking":
        return { type: "reasoning_omitted" };
      case "toolCall":
        return {
          type: "host_request_history",
          requestId: String(item.id ?? ""),
          actionName: String(item.name ?? ""),
          input: jsonSafe(item.arguments ?? {}),
        };
      case "serverToolUse":
        return { type: "server_tool_omitted", name: String(item.name ?? "") };
      case "webSearchResult":
        return { type: "web_search_result_omitted" };
      default:
        return { type: `${String(item.type ?? "unknown")}_omitted` };
    }
  });
}

function normalizeMessage(
  message: unknown,
  messageIndex: number,
  images: ReadonlyMap<string, StagedBridgeImage>,
): Record<string, unknown> {
  if (!message || typeof message !== "object") {
    return { role: "unknown", content: [{ type: "text", text: String(message ?? "") }] };
  }
  const item = message as Record<string, unknown>;
  const role = String(item.role ?? "unknown");
  if (role === "toolResult") {
    return {
      role: "host_result",
      requestId: String(item.toolCallId ?? ""),
      actionName: String(item.toolName ?? "unknown"),
      failed: Boolean(item.isError),
      content: normalizeContent(item.content, messageIndex, images),
    };
  }
  return {
    role,
    content: normalizeContent(item.content, messageIndex, images),
    ...(role === "assistant" && typeof item.stopReason === "string"
      ? { stopReason: item.stopReason }
      : {}),
  };
}

const EXACT_RECENT_HOST_RESULTS = 4;

function encodedConversation(
  systemPrompt: readonly string[],
  messages: readonly Record<string, unknown>[],
  compaction?: { compactedHostResults: number; omittedCharacters: number },
): string {
  return JSON.stringify(
    {
      systemPrompt,
      messages,
      ...(compaction ? { historyCompaction: compaction } : {}),
    },
    null,
    2,
  );
}

function compactHostResult(message: Record<string, unknown>): number {
  const content = JSON.stringify(message.content ?? []);
  message.content = [
    {
      type: "host_result_compacted",
      omittedCharacters: content.length,
      instruction:
        "This older host result was removed to bound provider context. Request a fresh narrow host action if its exact content is needed.",
    },
  ];
  return content.length;
}

export function serializeConversation(
  context: { systemPrompt?: readonly string[]; messages?: readonly unknown[] },
  config: Pick<BridgeConfig, "maxHistoryChars">,
  attachments: readonly StagedBridgeImage[] = [],
): string {
  const images = new Map(
    attachments.map((attachment) => [imageKey(attachment.messageIndex, attachment.contentIndex), attachment]),
  );
  const systemPrompt = (context.systemPrompt ?? []).map(String);
  const messages = (context.messages ?? []).map((message, index) => normalizeMessage(message, index, images));
  const original = encodedConversation(systemPrompt, messages);
  if (original.length <= config.maxHistoryChars) return original;

  const hostResultIndexes = messages
    .map((message, index) => message.role === "host_result" ? index : -1)
    .filter((index) => index >= 0);
  const compactableIndexes = hostResultIndexes.slice(
    0,
    Math.max(0, hostResultIndexes.length - EXACT_RECENT_HOST_RESULTS),
  );
  let compactedHostResults = 0;
  let omittedCharacters = 0;
  let serialized = original;

  for (const index of compactableIndexes) {
    omittedCharacters += compactHostResult(messages[index]);
    compactedHostResults += 1;
    serialized = encodedConversation(systemPrompt, messages, {
      compactedHostResults,
      omittedCharacters,
    });
    if (serialized.length <= config.maxHistoryChars) return serialized;
  }

  throw new Error(
    `OMP history is ${serialized.length.toLocaleString()} characters after compacting ${compactedHostResults} older host results, above maxHistoryChars=${config.maxHistoryChars.toLocaleString()}. The system prompt, user messages, or four most recent host results require a narrower OMP action or explicit session compaction.`,
  );
}
