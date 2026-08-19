import type { AgyRunResult, AgyStepUpdateEvent } from "./types.ts";

function toolStepName(event: AgyStepUpdateEvent): string {
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

function toolStepIdentity(event: AgyStepUpdateEvent): string {
  const step = event.step_update;
  const conversation = step.conversation_id ?? "";
  if (step.step_index !== undefined) return `${conversation}:${String(step.step_index)}`;
  return `${conversation}:${toolStepName(event)}:${stableJson(step.tool_info?.parameters ?? {})}`;
}

/** Collapse ACTIVE/DONE lifecycle updates for the same AGY tool invocation. */
export function uniqueAgyToolSteps(events: readonly AgyStepUpdateEvent[]): AgyStepUpdateEvent[] {
  const byIdentity = new Map<string, AgyStepUpdateEvent>();
  for (const event of events) byIdentity.set(toolStepIdentity(event), event);
  return [...byIdentity.values()];
}

export function providerHarnessActivitySummary(
  result: Pick<AgyRunResult, "toolSteps" | "subagents">,
): string {
  const uniqueTools = uniqueAgyToolSteps(result.toolSteps);
  const counts = new Map<string, number>();
  for (const event of uniqueTools) {
    const name = toolStepName(event);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const tools = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => count > 1 ? `${name}×${count}` : name)
    .join(", ");
  const lifecycle = result.toolSteps.length !== uniqueTools.length
    ? ` from ${result.toolSteps.length} lifecycle update(s)`
    : "";
  return `${uniqueTools.length} tool invocation(s)${lifecycle}${tools ? ` [${tools}]` : ""}, ${result.subagents.length} subagent(s)`;
}

export function assertProviderHarnessIsToolless(
  result: Pick<AgyRunResult, "toolSteps" | "subagents">,
  agentName: string,
): void {
  if (result.toolSteps.length === 0 && result.subagents.length === 0) return;
  throw new Error(
    `Provider-mode agy unexpectedly used its own harness (${providerHarnessActivitySummary(result)}). `
      + `The installed ${agentName} definition is stale or inherited AGY customizations. `
      + "Run /agy-install-agent (or npm run install-agent -- --force), fully restart OMP, and retry.",
  );
}
