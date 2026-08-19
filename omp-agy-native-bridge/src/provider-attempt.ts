import { AgyRunError } from "./agy/runner.ts";
import {
  assertProviderHarnessIsToolless,
  providerHarnessSnapshotsComplete,
  retryableProviderControlToolNames,
  unexpectedProviderHarnessToolSteps,
  type ProviderHarnessGuardOptions,
} from "./harness-guard.ts";
import { synthesizeMissingRecipientRecovery } from "./missing-recipient-recovery.ts";
import {
  appendMissingAgyRecipientRetryInstruction,
  appendProviderHarnessRetryInstruction,
} from "./prompt.ts";
import type { SerializedTool } from "./schema.ts";
import type { AgyRunResult, AgyStepUpdateEvent, AgyUsage } from "./types.ts";

const MISSING_RECIPIENT = /^recipient\s+(?:"([^"]+)"|'([^']+)'|`([^`]+)`|“([^”]+)”|‘([^’]+)’|([a-zA-Z0-9_.-]+))\s+(?:was\s+)?not\s+found\.?$/i;
const PERMISSION_CONVERSION_FAILURE = /^declaring permissions:\s*cortex tool\s+([a-zA-Z0-9_.-]+):\s*convert tool call for permissions:/i;
const RETRYABLE_PERMISSION_CONVERSION_TOOLS = new Set([
  "schedule",
  "managetask",
  "managesubagents",
  "manageinbox",
  "definesubagent",
  "invokesubagent",
  "sendmessage",
]);

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
  return key === "recipient"
    || key === "recipients"
    || key === "recipientname"
    || key === "to"
    || key === "target";
}

function collectRecipients(value: unknown, parentKey = ""): string[] {
  if (typeof value === "string") return isRecipientKey(parentKey) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => collectRecipients(item, parentKey));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => collectRecipients(child, key));
}

function missingRecipientName(error: AgyRunError): string | undefined {
  if (error.terminal?.status !== "ERROR") return undefined;
  const terminalError = error.terminal.error;
  if (typeof terminalError !== "string") return undefined;
  const match = MISSING_RECIPIENT.exec(terminalError.trim());
  if (!match) return undefined;
  return match.slice(1).find((value): value is string => typeof value === "string" && value.trim() !== "")?.trim();
}

function recordDiscardedUsage(error: unknown, discardedUsage: AgyUsage[]): void {
  if (error instanceof AgyRunError && error.terminal?.usage) {
    discardedUsage.push(error.terminal.usage);
  }
}

function appendFinalMissingRecipientCorrection(
  prompt: string,
  recipients: readonly string[],
): string {
  const names = [...new Set(recipients.map((recipient) => recipient.trim()).filter(Boolean))]
    .map((recipient) => JSON.stringify(recipient))
    .join(", ") || "unknown";
  return `${prompt}\n\n# Final provider routing correction
A corrected provider attempt still tried to use Antigravity messaging and failed on missing recipient(s): ${names}.
This third attempt is the final safe recovery attempt for this OMP turn.
- DO NOT invoke any Antigravity tool of any kind on this attempt. Do not call send_message, manage_inbox, schedule, manage_task, manage_subagents, define_subagent, or invoke_subagent.
- DO NOT address OMP, an OMP tool name, an OMP role such as agent/subagent/worker/reviewer, or any other label as an Antigravity recipient.
- OMP is already waiting for the enforced terminal structured result. That outer JSON object is the only return channel.
- If you need an OMP action, put the exact available OMP tool name and arguments in the outer \"tool_calls\" array. Do not try to deliver or invoke it through Antigravity messaging.
- If no OMP action is required, put the final answer in the outer \"text\" field with an empty \"tool_calls\" array.
- Continue from the supplied OMP prompt only. Ignore all attempted Antigravity messaging from discarded attempts.`;
}

/**
 * Classify only an exact, side-effect-free AGY missing-recipient failure.
 *
 * Provider mode forbids Antigravity messaging entirely, but the model can still
 * misroute an OMP tool name (for example `read`) through AGY `send_message`.
 * A retry is safe only when the terminal diagnostic proves that no recipient
 * existed, activity snapshots are complete, no AGY subagent ran, and every
 * non-media lifecycle event is the failed send_message targeting that exact
 * missing recipient. Exact staged-media hydration reads may coexist.
 */
export function retryableMissingAgyRecipient(
  error: unknown,
  options: ProviderHarnessGuardOptions = {},
): string | undefined {
  if (!(error instanceof AgyRunError)) return undefined;
  const missingRecipient = missingRecipientName(error);
  if (!missingRecipient) return undefined;
  if (!providerHarnessSnapshotsComplete(error)) return undefined;
  if (error.subagents.length > 0) return undefined;

  const unexpected = unexpectedProviderHarnessToolSteps(error.toolSteps, options);
  if (unexpected.length === 0) {
    // Some AGY versions emit only the terminal failure and omit the failed
    // send_message lifecycle event. The exact nonexistent-recipient diagnostic
    // proves that no message was delivered, so a corrected retry is safe.
    return missingRecipient;
  }

  const expectedRecipient = normalizedToken(missingRecipient);
  for (const event of unexpected) {
    if (normalizedToken(toolStepName(event)) !== "sendmessage") return undefined;
    const recipients = collectRecipients(event.step_update.tool_info?.parameters ?? {});
    if (recipients.length === 0) return undefined;
    if (recipients.some((recipient) => normalizedToken(recipient) !== expectedRecipient)) return undefined;
  }

  return missingRecipient;
}

/** Backward-compatible exact OMP-recipient classifier used by older callers/tests. */
export function isRetryableMissingOmpRecipientError(
  error: unknown,
  options: ProviderHarnessGuardOptions = {},
): error is AgyRunError {
  const recipient = retryableMissingAgyRecipient(error, options);
  return recipient !== undefined && normalizedToken(recipient) === "omp";
}

/**
 * AGY can fail before executing a misrouted inner-harness tool while converting
 * that tool call into a permission descriptor. The CLI reports this as a
 * terminal ERROR such as:
 *
 *   declaring permissions: cortex tool schedule: convert tool call for permissions: ...
 *
 * A single retry is safe only when the named tool is one of the provider-mode
 * tools we explicitly forbid, every captured activity record is complete, no
 * subagent exists, and no non-media AGY tool lifecycle event was observed. The
 * permission-conversion failure occurs before that named tool executes.
 */
export function retryablePermissionConversionTool(
  error: unknown,
  options: ProviderHarnessGuardOptions = {},
): string | undefined {
  if (!(error instanceof AgyRunError)) return undefined;
  if (error.terminal?.status !== "ERROR") return undefined;
  const terminalError = error.terminal.error;
  if (typeof terminalError !== "string") return undefined;
  const match = PERMISSION_CONVERSION_FAILURE.exec(terminalError.trim());
  if (!match) return undefined;
  const toolName = match[1];
  if (!RETRYABLE_PERMISSION_CONVERSION_TOOLS.has(normalizedToken(toolName))) return undefined;
  if (!providerHarnessSnapshotsComplete(error)) return undefined;
  if (error.subagents.length > 0) return undefined;
  if (unexpectedProviderHarnessToolSteps(error.toolSteps, options).length > 0) return undefined;
  return toolName;
}

export interface ProviderAttemptOptions {
  initialPrompt: string;
  invoke(prompt: string): Promise<AgyRunResult>;
  enforceToolless: boolean;
  agentName: string;
  guardOptions?: ProviderHarnessGuardOptions;
  /** Exact OMP tool catalog for deterministic recovery of misrouted messages. */
  ompTools?: readonly SerializedTool[];
}

export interface ProviderAttemptOutcome {
  result: AgyRunResult;
  /** Usage from attempts whose outputs were deliberately discarded before the final result. */
  discardedUsage: AgyUsage[];
  attempts: number;
}

/**
 * Run AGY with a tightly bounded provider-mode recovery budget.
 *
 * When the failed AGY send is unambiguous, prefer deterministic transport
 * recovery over another model call: messages addressed to OMP become final text,
 * while generic subagent-role messages become an OMP `task` tool call using the
 * exact current task schema. This removes the recurring `recipient "omp"` /
 * `recipient "subagent"` loop without trusting arbitrary recipient names.
 *
 * Other missing-recipient failures retain the bounded prompt-retry path. A third
 * AGY process is allowed only when both the first attempt and its corrected retry
 * fail with an exact, side-effect-free missing-recipient error. No fourth attempt
 * is ever made.
 */
export async function runProviderAttempts(options: ProviderAttemptOptions): Promise<ProviderAttemptOutcome> {
  const discardedUsage: AgyUsage[] = [];
  let attempts = 0;
  let retried = false;

  const invoke = async (prompt: string): Promise<AgyRunResult> => {
    attempts += 1;
    return options.invoke(prompt);
  };

  const deterministicRecovery = (error: unknown, recipient: string): AgyRunResult | undefined => {
    if (options.ompTools === undefined) return undefined;
    return synthesizeMissingRecipientRecovery(error, recipient, options.ompTools);
  };

  const guardOptions = options.guardOptions ?? {};
  let result: AgyRunResult;
  try {
    result = await invoke(options.initialPrompt);
  } catch (error) {
    if (!options.enforceToolless) throw error;

    const missingRecipient = retryableMissingAgyRecipient(error, guardOptions);
    if (missingRecipient) {
      recordDiscardedUsage(error, discardedUsage);
      const synthesized = deterministicRecovery(error, missingRecipient);
      if (synthesized) {
        result = synthesized;
      } else {
        retried = true;
        const correctedPrompt = appendMissingAgyRecipientRetryInstruction(options.initialPrompt, missingRecipient);
        try {
          result = await invoke(correctedPrompt);
        } catch (retryError) {
          const repeatedRecipient = retryableMissingAgyRecipient(retryError, guardOptions);
          if (!repeatedRecipient) throw retryError;
          recordDiscardedUsage(retryError, discardedUsage);
          const synthesizedRetry = deterministicRecovery(retryError, repeatedRecipient);
          if (synthesizedRetry) {
            result = synthesizedRetry;
          } else {
            result = await invoke(
              appendFinalMissingRecipientCorrection(correctedPrompt, [missingRecipient, repeatedRecipient]),
            );
          }
        }
      }
    } else {
      const permissionTool = retryablePermissionConversionTool(error, guardOptions);
      if (!permissionTool) throw error;
      recordDiscardedUsage(error, discardedUsage);
      retried = true;
      result = await invoke(appendProviderHarnessRetryInstruction(options.initialPrompt, [permissionTool]));
    }
  }

  if (options.enforceToolless) {
    const retryTools = result.subagents.length === 0 && providerHarnessSnapshotsComplete(result)
      ? retryableProviderControlToolNames(result.toolSteps, guardOptions)
      : undefined;

    if (retryTools && !retried) {
      if (result.terminal.usage) discardedUsage.push(result.terminal.usage);
      retried = true;
      result = await invoke(appendProviderHarnessRetryInstruction(options.initialPrompt, retryTools));
    }

    assertProviderHarnessIsToolless(result, options.agentName, guardOptions);
  }

  return { result, discardedUsage, attempts };
}
