import { parseAgyTerminalOutput } from "./schema.ts";
import type { BridgeStructuredOutput } from "./types.ts";

const MAX_NESTED_BRIDGE_DEPTH = 4;

/**
 * Nested-output recovery is intentionally more conservative than the top-level
 * structured-output parser. Plain JSON is valid user-visible content, so only
 * unwrap text that carries host-response protocol keys. This preserves exact
 * JSON answers while recovering a serialized response emitted by AGY wrappers.
 */
function looksLikeSerializedBridgeOutput(value: string): boolean {
  const trimmed = value.trimStart();
  const startsLikeJson = trimmed.startsWith("{") || /^(?:```|~~~)(?:json)?(?:\s|$)/i.test(trimmed);
  if (!startsLikeJson) return false;
  return /"(?:host_requests|response)"\s*:/.test(trimmed);
}

function sameBridgeOutput(left: BridgeStructuredOutput, right: BridgeStructuredOutput): boolean {
  return left.text === right.text
    && left.finish_reason === right.finish_reason
    && JSON.stringify(left.tool_calls) === JSON.stringify(right.tool_calls);
}

/**
 * Recover when AGY satisfies the outer JSON schema but serializes another host
 * response inside `response`.
 */
export function unwrapNestedBridgeOutput(
  output: BridgeStructuredOutput,
  allowedToolNames: readonly string[],
): BridgeStructuredOutput {
  let current = output;

  for (let depth = 0; depth < MAX_NESTED_BRIDGE_DEPTH; depth += 1) {
    if (current.finish_reason !== "stop" || current.tool_calls.length > 0) return current;
    if (!looksLikeSerializedBridgeOutput(current.text)) return current;

    let nested: BridgeStructuredOutput;
    try {
      nested = parseAgyTerminalOutput({ response: current.text }, allowedToolNames);
    } catch {
      // JSON-only user answers and invalid nested host requests remain ordinary
      // text. Never execute an unvalidated nested request.
      return current;
    }

    if (sameBridgeOutput(current, nested)) return current;
    current = nested;
  }

  return current;
}
