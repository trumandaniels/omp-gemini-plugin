import { AgyRunError } from "./agy/runner.ts";
import {
  assertProviderHarnessIsToolless,
  retryableProviderControlToolNames,
  uniqueAgyToolSteps,
  type ProviderHarnessGuardOptions,
} from "./harness-guard.ts";
import {
  appendMissingOmpRecipientRetryInstruction,
  appendProviderHarnessRetryInstruction,
} from "./prompt.ts";
import type { AgyRunResult, AgyUsage } from "./types.ts";

const MISSING_OMP_RECIPIENT = /^recipient\s+(?:["']omp["']|omp)\s+not\s+found\.?$/i;

function normalizedToolName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function toolStepName(result: AgyRunResult["toolSteps"][number]): string {
  return result.step_update.tool_info?.name
    ?? result.step_update.tool_name
    ?? "unknown";
}

/**
 * Classify only the exact, side-effect-free AGY routing failure observed when
 * the model mistakes OMP for an Antigravity message recipient. Any subagent or
 * unrelated tool activity keeps the failure closed.
 */
export function isRetryableMissingOmpRecipientError(error: unknown): error is AgyRunError {
  if (!(error instanceof AgyRunError)) return false;
  if (error.terminal?.status !== "ERROR") return false;
  const terminalError = error.terminal.error;
  if (typeof terminalError !== "string" || !MISSING_OMP_RECIPIENT.test(terminalError.trim())) return false;
  if (error.subagents.length > 0) return false;

  const tools = uniqueAgyToolSteps(error.toolSteps);
  return tools.every((event) => normalizedToolName(toolStepName(event)) === "sendmessage");
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
 * A second attempt is allowed only for one of two tightly bounded cases:
 * 1. the exact `recipient "omp" not found` routing error with no AGY subagent or
 *    non-send-message tool activity; or
 * 2. an otherwise successful read-only AGY control probe already classified by
 *    `retryableProviderControlToolNames`.
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

  let result: AgyRunResult;
  try {
    result = await invoke(options.initialPrompt);
  } catch (error) {
    if (!options.enforceToolless || !isRetryableMissingOmpRecipientError(error)) throw error;
    if (error.terminal?.usage) discardedUsage.push(error.terminal.usage);
    retried = true;
    result = await invoke(appendMissingOmpRecipientRetryInstruction(options.initialPrompt));
  }

  if (options.enforceToolless) {
    const guardOptions = options.guardOptions ?? {};
    const retryTools = result.subagents.length === 0
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
