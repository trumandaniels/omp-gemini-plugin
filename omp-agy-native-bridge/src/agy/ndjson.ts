import type { AgyStreamEvent } from "../types.ts";

/**
 * Parse one documented AGY stream-json event. Unknown future event names are
 * ignored for forward compatibility; malformed payloads for the three events
 * the bridge relies on remain hard failures, and runner.ts still requires one
 * successful terminal `result` event.
 */
export function parseAgyEventLine(line: string): AgyStreamEvent | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Invalid agy NDJSON line: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("agy NDJSON event must be a JSON object");
  }
  const event = parsed as Record<string, unknown>;
  if (typeof event.event !== "string" || event.event.trim() === "") {
    throw new Error("agy NDJSON event must contain a non-empty string event name");
  }
  if (event.event !== "init" && event.event !== "step_update" && event.event !== "result") {
    return undefined;
  }
  if (event.event === "init" && (!event.init || typeof event.init !== "object" || Array.isArray(event.init))) {
    throw new Error("agy init event is missing init payload");
  }
  if (
    event.event === "step_update"
    && (!event.step_update || typeof event.step_update !== "object" || Array.isArray(event.step_update))
  ) {
    throw new Error("agy step_update event is missing step_update payload");
  }
  if (event.event === "result" && (!event.result || typeof event.result !== "object" || Array.isArray(event.result))) {
    throw new Error("agy result event is missing result payload");
  }
  return parsed as AgyStreamEvent;
}
