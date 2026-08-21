import type { ToolChoice } from "@oh-my-pi/pi-ai";

import type { ToolLike } from "./schema.ts";
import type { BridgeStructuredOutput } from "./types.ts";

export interface BridgeToolChoiceResolution {
  tools: readonly ToolLike[];
  requireToolCall: boolean;
  requiredToolName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function namedToolChoice(choice: ToolChoice | undefined): string | undefined {
  if (!choice || typeof choice === "string") return undefined;
  if (choice.type === "computer") return "computer";

  const value = choice as unknown as Record<string, unknown>;
  if (typeof value.name === "string" && value.name.trim() !== "") return value.name;
  const fn = value.function;
  if (isRecord(fn) && typeof fn.name === "string" && fn.name.trim() !== "") return fn.name;
  return undefined;
}

/**
 * Translate OMP's provider-agnostic tool choice into the bridge's tool catalog.
 *
 * Named choices are implemented by narrowing the catalog to exactly that tool,
 * which works even though AGY itself has no OMP-native tool-choice parameter.
 * `none` removes the catalog entirely. `required`/`any` keep the active catalog
 * but require at least one validated OMP tool call in the terminal envelope.
 */
export function resolveBridgeToolChoice(
  tools: readonly ToolLike[],
  choice: ToolChoice | undefined,
): BridgeToolChoiceResolution {
  if (choice === "none") return { tools: [], requireToolCall: false };

  const named = namedToolChoice(choice);
  if (named) {
    const selected = tools.find((tool) => tool.name === named);
    if (!selected) {
      throw new Error(`OMP tool choice requires unavailable tool: ${named}`);
    }
    return { tools: [selected], requireToolCall: true, requiredToolName: named };
  }

  const requireToolCall = choice === "required" || choice === "any";
  if (requireToolCall && tools.length === 0) {
    throw new Error("OMP tool choice requires a tool call, but this turn has no available OMP tools");
  }
  return { tools, requireToolCall };
}

export function appendToolChoiceInstruction(
  prompt: string,
  resolution: Pick<BridgeToolChoiceResolution, "requireToolCall" | "requiredToolName">,
): string {
  if (!resolution.requireToolCall) return prompt;
  const target = resolution.requiredToolName
    ? `the host action ${JSON.stringify(resolution.requiredToolName)}`
    : "at least one available host action";
  return `${prompt}\n\n# Host-action requirement\nThis turn requires external work. Return ${target} in "host_requests" using "action_id" and "input". Do not answer with only "response", and do not invoke any Antigravity-native action.`;
}

/** Fail closed when AGY ignores a host-level forced-tool requirement. */
export function assertBridgeToolChoiceSatisfied(
  output: Pick<BridgeStructuredOutput, "tool_calls">,
  resolution: Pick<BridgeToolChoiceResolution, "requireToolCall" | "requiredToolName">,
): void {
  if (!resolution.requireToolCall) return;
  if (output.tool_calls.length === 0) {
    const target = resolution.requiredToolName
      ? `OMP tool ${JSON.stringify(resolution.requiredToolName)}`
      : "an OMP tool call";
    throw new Error(`AGY returned no tool call, but this OMP turn requires ${target}`);
  }
  if (
    resolution.requiredToolName
    && output.tool_calls.some((call) => call.name !== resolution.requiredToolName)
  ) {
    throw new Error(
      `AGY violated OMP tool choice: expected only ${resolution.requiredToolName}`,
    );
  }
}
