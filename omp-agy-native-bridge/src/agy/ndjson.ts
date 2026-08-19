import type { AgyStreamEvent } from "../types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseAgyEventLine(line: string): AgyStreamEvent | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Invalid agy NDJSON line: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error("agy NDJSON event must be a JSON object");
  }
  if (parsed.event !== "init" && parsed.event !== "step_update" && parsed.event !== "result") {
    throw new Error(`Unknown agy NDJSON event: ${String(parsed.event)}`);
  }
  if (parsed.event === "init" && !isRecord(parsed.init)) {
    throw new Error("agy init event is missing object-shaped init payload");
  }
  if (parsed.event === "step_update" && !isRecord(parsed.step_update)) {
    throw new Error("agy step_update event is missing object-shaped step_update payload");
  }
  if (parsed.event === "result" && !isRecord(parsed.result)) {
    throw new Error("agy result event is missing object-shaped result payload");
  }
  return parsed as unknown as AgyStreamEvent;
}
