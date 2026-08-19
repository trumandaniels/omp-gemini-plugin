import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";

import type { AgyResultPayload, AgyRunResult, AgyStepUpdateEvent } from "./types.ts";

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

function normalizedToolName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isReadOnlyMediaTool(value: string): boolean {
  const name = normalizedToolName(value);
  return /^(?:read|view|inspect|load)(?:file|files|image|images|media|attachment|attachments)(?:content)?$/.test(name);
}

function isFileTargetKey(value: string): boolean {
  const key = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return key.endsWith("path")
    || key.endsWith("paths")
    || key === "file"
    || key === "files"
    || key === "filename"
    || key === "filenames"
    || key === "uri"
    || key === "uris";
}

function collectFileTargets(value: unknown, parentKey = ""): string[] {
  if (typeof value === "string") return isFileTargetKey(parentKey) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => collectFileTargets(item, parentKey));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => collectFileTargets(child, key));
}

function canonicalPath(value: string, cwd: string): string | undefined {
  let path = value.trim();
  if (path.startsWith("@")) path = path.slice(1);
  try {
    if (path.startsWith("file://")) path = fileURLToPath(path);
  } catch {
    return undefined;
  }
  if (path === "") return undefined;
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

export interface ProviderHarnessGuardOptions {
  cwd?: string;
  /** Exact user-supplied temporary media files that AGY may read to hydrate prompt attachments. */
  allowedMediaPaths?: readonly string[];
}

function isAllowedMediaRead(
  event: AgyStepUpdateEvent,
  options: ProviderHarnessGuardOptions,
): boolean {
  if (!isReadOnlyMediaTool(toolStepName(event))) return false;
  const cwd = options.cwd ?? process.cwd();
  const allowedFiles = new Set(
    (options.allowedMediaPaths ?? [])
      .map((path) => canonicalPath(path, cwd))
      .filter((path): path is string => Boolean(path)),
  );
  if (allowedFiles.size === 0) return false;
  const allowedDirectories = new Set([...allowedFiles].map(dirname));
  const targets = collectFileTargets(event.step_update.tool_info?.parameters ?? {});
  if (targets.length === 0) return false;
  return targets.every((target) => {
    const canonical = canonicalPath(target, cwd);
    return canonical !== undefined
      && (allowedFiles.has(canonical) || allowedDirectories.has(canonical));
  });
}

export function unexpectedProviderHarnessToolSteps(
  events: readonly AgyStepUpdateEvent[],
  options: ProviderHarnessGuardOptions = {},
): AgyStepUpdateEvent[] {
  return uniqueAgyToolSteps(events).filter((event) => !isAllowedMediaRead(event, options));
}

function toolAction(event: AgyStepUpdateEvent): string | undefined {
  const parameters = event.step_update.tool_info?.parameters;
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return undefined;
  for (const [key, value] of Object.entries(parameters)) {
    if (normalizedToolName(key) === "action" && typeof value === "string") {
      return normalizedToolName(value);
    }
  }
  return undefined;
}

const RETRYABLE_CONTROL_ACTIONS = new Map<string, ReadonlySet<string>>([
  ["managetask", new Set(["list", "status"])],
  ["managesubagents", new Set(["list"])],
]);

/**
 * Return the harmless AGY control probes that may be discarded and retried once.
 * Mutating actions such as kill, kill_all, send_input, define, or invoke never qualify.
 */
export function retryableProviderControlToolNames(
  events: readonly AgyStepUpdateEvent[],
  options: ProviderHarnessGuardOptions = {},
): string[] | undefined {
  const unexpected = unexpectedProviderHarnessToolSteps(events, options);
  if (unexpected.length === 0) return undefined;
  for (const event of unexpected) {
    const allowedActions = RETRYABLE_CONTROL_ACTIONS.get(normalizedToolName(toolStepName(event)));
    const action = toolAction(event);
    if (!allowedActions || !action || !allowedActions.has(action)) return undefined;
  }
  return [...new Set(unexpected.map(toolStepName))].sort((left, right) => left.localeCompare(right));
}

export interface FailedProviderHarnessAttempt {
  message?: string;
  stderr?: string;
  status?: string;
  terminal?: AgyResultPayload;
  toolSteps: readonly AgyStepUpdateEvent[];
  subagents: readonly unknown[];
}

function failedAttemptDiagnostic(attempt: FailedProviderHarnessAttempt): string {
  // Prefer the terminal provider diagnostic when AGY supplied one. Do not let a
  // generic wrapper message containing stale text override a contradictory
  // terminal error; the retry classifier must prove non-delivery fail-closed.
  const terminalError = attempt.terminal?.error?.trim();
  if (terminalError) return terminalError;
  return [attempt.message, attempt.stderr]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .join("\n");
}

/**
 * Classify the one failed AGY action that is safe to discard and retry: a
 * `send_message` attempt rejected because its recipient does not exist. Since
 * AGY confirms non-delivery, no message side effect occurred. Every other
 * failed control, file, command, MCP, or subagent action remains fail-closed.
 */
export function retryableFailedProviderControlToolNames(
  attempt: FailedProviderHarnessAttempt,
  options: ProviderHarnessGuardOptions = {},
): string[] | undefined {
  if (attempt.subagents.length > 0) return undefined;
  const status = attempt.terminal?.status ?? attempt.status;
  if (status !== "ERROR" && status !== "INVALID") return undefined;
  if (!/recipient\s+(?:"[^"]+"|'[^']+'|\S+)\s+not\s+found/i.test(failedAttemptDiagnostic(attempt))) {
    return undefined;
  }

  const unexpected = unexpectedProviderHarnessToolSteps(attempt.toolSteps, options);
  if (unexpected.length === 0) {
    // Older AGY builds may emit only the terminal recipient-not-found error and
    // omit the failed tool lifecycle event. The diagnostic proves non-delivery.
    return ["send_message"];
  }
  if (unexpected.some((event) => normalizedToolName(toolStepName(event)) !== "sendmessage")) {
    return undefined;
  }
  return [...new Set(unexpected.map(toolStepName))].sort((left, right) => left.localeCompare(right));
}

function activitySummaryFromSteps(
  toolSteps: readonly AgyStepUpdateEvent[],
  lifecycleCount: number,
  subagentCount: number,
): string {
  const counts = new Map<string, number>();
  for (const event of toolSteps) {
    const name = toolStepName(event);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const tools = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => count > 1 ? `${name}×${count}` : name)
    .join(", ");
  const lifecycle = lifecycleCount !== toolSteps.length
    ? ` from ${lifecycleCount} lifecycle update(s)`
    : "";
  return `${toolSteps.length} tool invocation(s)${lifecycle}${tools ? ` [${tools}]` : ""}, ${subagentCount} subagent(s)`;
}

function unexpectedToolNames(toolSteps: readonly AgyStepUpdateEvent[]): string {
  const names = [...new Set(toolSteps.map(toolStepName))].sort((left, right) => left.localeCompare(right));
  return names.length > 0 ? names.join(", ") : "none";
}

export function providerHarnessActivitySummary(
  result: Pick<AgyRunResult, "toolSteps" | "subagents">,
): string {
  return activitySummaryFromSteps(
    uniqueAgyToolSteps(result.toolSteps),
    result.toolSteps.length,
    result.subagents.length,
  );
}

export function assertProviderHarnessIsToolless(
  result: Pick<AgyRunResult, "toolSteps" | "subagents">,
  agentName: string,
  options: ProviderHarnessGuardOptions = {},
): void {
  const unexpectedTools = unexpectedProviderHarnessToolSteps(result.toolSteps, options);
  if (unexpectedTools.length === 0 && result.subagents.length === 0) return;
  const names = unexpectedToolNames(unexpectedTools);
  throw new Error(
    `Forbidden AGY provider tool(s): ${names}. `
      + `Provider-mode agy unexpectedly used its own harness (${activitySummaryFromSteps(unexpectedTools, result.toolSteps.length, result.subagents.length)}). `
      + `The installed ${agentName} definition is stale, inherited AGY customizations, or the model misrouted an OMP request to an AGY control tool. `
      + "Run /agy-install-agent (or npm run install-agent -- --force), fully restart OMP, and retry.",
  );
}
