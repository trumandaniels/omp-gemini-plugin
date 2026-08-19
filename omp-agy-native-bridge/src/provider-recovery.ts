import { AgyRunError } from "./agy/runner.ts";
import {
  unexpectedProviderHarnessToolSteps,
  type ProviderHarnessGuardOptions,
} from "./harness-guard.ts";
import type { AgyStepUpdateEvent } from "./types.ts";

const RECIPIENT_OMP_NOT_FOUND = /\brecipient\s+["'`“”‘’]?omp["'`“”‘’]?\s+(?:was\s+)?not\s+found\b/i;

function normalizedToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function toolStepName(event: AgyStepUpdateEvent): string {
  return event.step_update.tool_info?.name
    ?? event.step_update.tool_name
    ?? "unknown";
}

function isRecipientKey(value: string): boolean {
  const key = normalizedToken(value);
  return key === "recipient" || key === "to" || key === "target" || key === "recipientname";
}

function collectRecipients(value: unknown, parentKey = ""): string[] {
  if (typeof value === "string") return isRecipientKey(parentKey) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => collectRecipients(item, parentKey));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => collectRecipients(child, key));
}

function hasRecipientOmpDiagnostic(error: AgyRunError): boolean {
  return [error.terminal?.error, error.message, error.stderr]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .some((value) => RECIPIENT_OMP_NOT_FOUND.test(value));
}

/**
 * Classify one AGY `send_message` attempt that failed before delivery because
 * OMP is not an Antigravity recipient. The provider may discard and retry this
 * exact failure once; any other tool or any observed subagent remains fatal.
 */
export function retryableRecipientOmpFailureToolNames(
  error: unknown,
  options: ProviderHarnessGuardOptions = {},
): string[] | undefined {
  if (!(error instanceof AgyRunError) || !hasRecipientOmpDiagnostic(error)) return undefined;
  if (error.subagents.length > 0) return undefined;

  const unexpected = unexpectedProviderHarnessToolSteps(error.toolSteps, options);
  if (unexpected.length === 0) {
    // Some AGY builds emit only the terminal tool failure, not the preceding
    // lifecycle event. The exact nonexistent-recipient diagnostic proves that
    // no message was delivered, so a single corrected retry is still safe.
    return ["send_message"];
  }

  for (const event of unexpected) {
    if (normalizedToken(toolStepName(event)) !== "sendmessage") return undefined;
    const recipients = collectRecipients(event.step_update.tool_info?.parameters ?? {});
    if (recipients.some((recipient) => normalizedToken(recipient) !== "omp")) return undefined;
  }

  return [...new Set(unexpected.map(toolStepName))].sort((left, right) => left.localeCompare(right));
}
