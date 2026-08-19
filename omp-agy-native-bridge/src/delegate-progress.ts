import type { AgyStepUpdateEvent, AgyStreamEvent } from "./types.ts";

export const DELEGATE_PROGRESS_LIMITS = {
  responseChars: 32_000,
  responsePreviewChars: 2_000,
  toolInvocations: 200,
  subagents: 200,
  jsonDetailChars: 4_000,
  toolOutputChars: 1_000,
} as const;

export interface DelegateProgressUpdate {
  text: string;
  details: Record<string, unknown>;
}

export interface DelegateProgressSummary {
  tools: Array<Record<string, unknown>>;
  subagents: Array<Record<string, unknown>>;
  progress: {
    responseTruncated: boolean;
    omittedToolInvocations: number;
    omittedSubagents: number;
  };
}

function tail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `…${value.slice(-(maxChars - 1))}`;
}

function appendTail(
  current: string,
  chunk: string,
  maxChars: number,
): { value: string; truncated: boolean } {
  const combined = current + chunk;
  if (combined.length <= maxChars) return { value: combined, truncated: false };
  const marker = "…[earlier Antigravity response omitted]\n";
  return {
    value: marker + combined.slice(-(maxChars - marker.length)),
    truncated: true,
  };
}

function jsonPreview(value: unknown, maxChars: number): unknown {
  if (value === undefined) return undefined;
  const seen = new WeakSet<object>();
  let encoded: string;
  try {
    encoded = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return item.toString();
      if (typeof item === "function" || typeof item === "symbol") return undefined;
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[Circular]";
        seen.add(item);
      }
      return item;
    }) ?? "null";
  } catch {
    return "[unserializable]";
  }
  if (encoded.length <= maxChars) {
    try {
      return JSON.parse(encoded);
    } catch {
      return encoded;
    }
  }
  return {
    truncated: true,
    originalChars: encoded.length,
    preview: `${encoded.slice(0, Math.max(0, maxChars - 1))}…`,
  };
}

function toolName(event: AgyStepUpdateEvent): string {
  return event.step_update.tool_info?.name
    ?? event.step_update.tool_name
    ?? "unknown";
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}

function toolIdentity(event: AgyStepUpdateEvent): string {
  const step = event.step_update;
  if (step.step_index !== undefined) {
    return `${step.conversation_id ?? ""}:${String(step.step_index)}`;
  }
  return `${step.conversation_id ?? ""}:${toolName(event)}:${stableJson(step.tool_info?.parameters ?? {})}`;
}

function subagentIdentity(agent: Record<string, unknown>, ordinal: number): string {
  for (const key of ["conversation_id", "log_uri"] as const) {
    const value = agent[key];
    if (typeof value === "string" && value !== "") return `${key}:${value}`;
  }
  return `${String(agent.type_name ?? "")}:${String(agent.role ?? "")}:${ordinal}:${stableJson(agent.workspace_uris ?? [])}`;
}

/**
 * Bounded, lifecycle-aware progress state for the nested `agy_delegate` tool.
 * OMP receives useful summaries without retaining every streamed delta or both
 * ACTIVE/DONE copies of every AGY tool invocation indefinitely.
 */
export class DelegateProgressCollector {
  private responseText = "";
  private responseTruncated = false;
  private readonly tools = new Map<string, Record<string, unknown>>();
  private readonly omittedToolIds = new Set<string>();
  private readonly subagents = new Map<string, Record<string, unknown>>();
  private readonly omittedSubagentIds = new Set<string>();

  ingest(event: AgyStreamEvent): DelegateProgressUpdate[] {
    if (event.event === "init") {
      return [{
        text: `Antigravity started${event.init.model ? ` with ${event.init.model}` : ""}.`,
        details: {
          phase: "init",
          conversationId: event.conversation_id,
          init: jsonPreview(event.init, DELEGATE_PROGRESS_LIMITS.jsonDetailChars),
        },
      }];
    }
    if (event.event !== "step_update") return [];

    const updates: DelegateProgressUpdate[] = [];
    const step = event.step_update;
    if (step.step_type === "agent_response" && step.text_delta) {
      const appended = appendTail(
        this.responseText,
        step.text_delta,
        DELEGATE_PROGRESS_LIMITS.responseChars,
      );
      this.responseText = appended.value;
      this.responseTruncated ||= appended.truncated;
      updates.push({
        text: tail(this.responseText, DELEGATE_PROGRESS_LIMITS.responsePreviewChars),
        details: {
          phase: "response",
          state: step.state,
          responseTruncated: this.responseTruncated,
        },
      });
    }

    if (step.step_type === "tool") {
      const identity = toolIdentity(event);
      const detail: Record<string, unknown> = {
        name: toolName(event),
        state: step.state,
        parameters: jsonPreview(step.tool_info?.parameters, DELEGATE_PROGRESS_LIMITS.jsonDetailChars),
        output: step.tool_info?.output
          ? tail(step.tool_info.output, DELEGATE_PROGRESS_LIMITS.toolOutputChars)
          : undefined,
        error: jsonPreview(step.tool_info?.error, DELEGATE_PROGRESS_LIMITS.jsonDetailChars),
      };
      if (this.tools.has(identity)) {
        this.tools.set(identity, detail);
      } else if (this.tools.size < DELEGATE_PROGRESS_LIMITS.toolInvocations) {
        this.tools.set(identity, detail);
      } else if (!this.omittedToolIds.has(identity)) {
        this.omittedToolIds.add(identity);
      }
      updates.push({
        text: `Antigravity tool: ${String(detail.name)}`,
        details: { phase: "tool", ...detail },
      });
    }

    for (const [ordinal, rawAgent] of (step.subagent_info?.subagents ?? []).entries()) {
      const agent = rawAgent as Record<string, unknown>;
      const identity = subagentIdentity(agent, ordinal);
      const summarized = jsonPreview(agent, DELEGATE_PROGRESS_LIMITS.jsonDetailChars);
      const detail = summarized && typeof summarized === "object" && !Array.isArray(summarized)
        ? summarized as Record<string, unknown>
        : { value: summarized };
      if (this.subagents.has(identity)) {
        this.subagents.set(identity, detail);
      } else if (this.subagents.size < DELEGATE_PROGRESS_LIMITS.subagents) {
        this.subagents.set(identity, detail);
      } else if (!this.omittedSubagentIds.has(identity)) {
        this.omittedSubagentIds.add(identity);
      }
      updates.push({
        text: `Antigravity subagent: ${String(agent.role ?? agent.type_name ?? "unknown")}`,
        details: { phase: "subagent", ...detail },
      });
    }

    return updates;
  }

  summary(): DelegateProgressSummary {
    return {
      tools: [...this.tools.values()],
      subagents: [...this.subagents.values()],
      progress: {
        responseTruncated: this.responseTruncated,
        omittedToolInvocations: this.omittedToolIds.size,
        omittedSubagents: this.omittedSubagentIds.size,
      },
    };
  }
}
