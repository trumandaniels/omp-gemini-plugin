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
          type: "tool_call",
          id: String(item.id ?? ""),
          name: String(item.name ?? ""),
          arguments: jsonSafe(item.arguments ?? {}),
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
      role: "tool_result",
      toolCallId: String(item.toolCallId ?? ""),
      toolName: String(item.toolName ?? "unknown"),
      isError: Boolean(item.isError),
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

export function serializeConversation(
  context: { systemPrompt?: readonly string[]; messages?: readonly unknown[] },
  config: Pick<BridgeConfig, "maxHistoryChars">,
  attachments: readonly StagedBridgeImage[] = [],
): string {
  const images = new Map(
    attachments.map((attachment) => [imageKey(attachment.messageIndex, attachment.contentIndex), attachment]),
  );
  const serialized = JSON.stringify(
    {
      systemPrompt: (context.systemPrompt ?? []).map(String),
      messages: (context.messages ?? []).map((message, index) => normalizeMessage(message, index, images)),
    },
    null,
    2,
  );

  if (serialized.length > config.maxHistoryChars) {
    throw new Error(
      `OMP history is ${serialized.length.toLocaleString()} characters, above maxHistoryChars=${config.maxHistoryChars.toLocaleString()}. Compact the OMP session instead of silently dropping canonical history.`,
    );
  }
  return serialized;
}
