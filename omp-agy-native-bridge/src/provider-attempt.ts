import { AgyRunError } from "./agy/runner.ts";
import {
  assertProviderHarnessIsToolless,
  providerHarnessSnapshotsComplete,
  retryableProviderControlToolNames,
  unexpectedProviderHarnessToolSteps,
  type ProviderHarnessGuardOptions,
} from "./harness-guard.ts";
import {
  appendMissingOmpRecipientRetryInstruction,
  appendProviderHarnessRetryInstruction,
} from "./prompt.ts";
import type { AgyRunResult, AgyStepUpdateEvent, AgyUsage } from "./types.ts";

const MISSING_OMP_RECIPIENT = /^recipient\s+["'`“”‘’]?omp["'`“”‘’]?\s+(?:was\s+)?not\s+found\.?$/i;
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

/**
 * Classify only the exact, side-effect-free AGY routing failure observed when
 * the model mistakes OMP for an Antigravity message recipient. Any subagent,
 * unrelated tool, non-OMP recipient, missing recipient parameter, or truncated
 * activity snapshot keeps the failure closed. Exact staged-media reads may
 * coexist because the harness guard has already scoped those to bridge-owned
 * temporary image inputs.
 */
export function isRetryableMissingOmpRecipientError(
  error: unknown,
  options: ProviderHarnessGuardOptions = {},
): error is AgyRunError {
  if (!(error instanceof AgyRunError)) return false;
  if (error.terminal?.status !== "ERROR") return false;
  const terminalError = error.terminal.error;
  if (typeof terminalError !== "string" || !MISSING_OMP_RECIPIENT.test(terminalError.trim())) return false;
  if (!providerHarnessSnapshotsComplete(error)) return false;
  if (error.subagents.length > 0) return false;

  const unexpected = unexpectedProviderHarnessToolSteps(error.toolSteps, options);
  if (unexpected.length === 0) {
    // Some AGY versions emit only the terminal failure and omit the failed
    // send_message lifecycle event. The exact nonexistent-recipient diagnostic
    // proves that no message was delivered, so one corrected retry is safe.
    return true;
  }

  for (const event of unexpected) {
    if (normalizedToken(toolStepName(event)) !== "sendmessage") return false;
    const recipients = collectRecipients(event.step_update.tool_info?.parameters ?? {});
    if (recipients.length === 0) return false;
    if (recipients.some((recipient) => normalizedToken(recipient) !== "omp")) return false;
  }

  return true;
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
}

export interface ProviderAttemptOutcome {
  result: AgyRunResult;
  /** Usage from attempts whose outputs were deliberately discarded before the final result. */
  discardedUsage: AgyUsage[];
  attempts: number;
}

/**
 * Run at most two AGY processes for one OMP provider turn.
 *
 * A second attempt is allowed only for one of three tightly bounded cases:
 * 1. the exact `recipient "omp" not found` routing error with complete activity
 *    snapshots, no AGY subagent, no non-media workspace activity, and only an
 *    explicitly OMP-targeted send_message attempt when lifecycle data exists;
 * 2. an AGY permission-conversion failure for a known forbidden provider-mode
 *    control tool, before that tool executes and with no unrelated activity; or
 * 3. an otherwise successful read-only AGY control probe already classified by
 *    `retryableProviderControlToolNames`, again with complete snapshots.
 *
 * The discarded result/error is never returned to OMP or inserted into history.
 */
export async function runProviderAttempts(options: ProviderAttemptOptions): Promise<ProviderAttemptOutcome> {
  const discardedUsage: AgyUsage[] = [];
  let attempts = 0;
  let retried = false;

  const invoke = async (prompt: string): Promise<AgyRunResult> => {
    attempts += 1;
    return options.invoke(prompt);
  };

  const guardOptions = options.guardOptions ?? {};
  let result: AgyRunResult;
  try {
    result = await invoke(options.initialPrompt);
  } catch (error) {
    if (!options.enforceToolless) throw error;

    if (isRetryableMissingOmpRecipientError(error, guardOptions)) {
      if (error.terminal?.usage) discardedUsage.push(error.terminal.usage);
      retried = true;
      result = await invoke(appendMissingOmpRecipientRetryInstruction(options.initialPrompt));
    } else {
      const permissionTool = retryablePermissionConversionTool(error, guardOptions);
      if (!permissionTool) throw error;
      if (error instanceof AgyRunError && error.terminal?.usage) {
        discardedUsage.push(error.terminal.usage);
      }
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
