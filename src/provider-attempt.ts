import { AgyRunError } from "./agy/runner.ts";
import {
  assertProviderHarnessIsToolless,
  providerHarnessSnapshotsComplete,
  retryableProviderControlToolNames,
  unexpectedProviderHarnessToolSteps,
  uniqueAgyToolSteps,
  PROVIDER_TOOL_BLOCK_MARKER,
  type ProviderHarnessGuardOptions,
} from "./harness-guard.ts";
import { synthesizeMissingRecipientRecovery } from "./missing-recipient-recovery.ts";
import {
  appendMissingAgyRecipientRetryInstruction,
  appendProviderHarnessRetryInstruction,
  appendProviderProgressRetryInstruction,
} from "./prompt.ts";
import type { SerializedTool } from "./schema.ts";
import type { AgyRunResult, AgyStepUpdateEvent, AgyUsage } from "./types.ts";

const MISSING_RECIPIENT = /^recipient\s+(?:"([^"]+)"|'([^']+)'|`([^`]+)`|“([^”]+)”|‘([^’]+)’|([a-zA-Z0-9_.-]+))\s+(?:was\s+)?not\s+found\.?$/i;
const PERMISSION_CONVERSION_FAILURE = /^declaring permissions:\s*cortex tool\s+([a-zA-Z0-9_.-]+):\s*convert tool call for permissions:/i;
const INVALID_TASK_ID_FAILURE = /^invalid task ID format:\s*"([^"\r\n]+)"\.?$/i;
const UNKNOWN_TOOL_FAILURE =
  /^unknown tool:\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([a-zA-Z0-9_.-]+))(?:\s*-\s*check spelling)?\.?$/i;
const INVALID_PROVIDER_ACTION_ARGUMENTS = /^invalid arguments:\s*-\s*missing properties\s+(.+)$/is;
const PROGRESS_NARRATION =
  /^(?:(?:let(?:'|’)s|i(?:'|’)ll|i\s+will)\s+)?(?:check|inspect|search|read|look|review|run|open|examine|find|verify|continue|update|edit|implement|create|add|fix|test)\b/i;
const REQUIRED_PROVIDER_ACTION_PROPERTIES: Readonly<Record<string, true>> = {
  action: true,
  toolsummary: true,
  toolaction: true,
};
const MAX_PROVIDER_PROGRESS_RECOVERIES = 2;
const MAX_PROVIDER_TRANSPORT_RECOVERIES = 3;
const PROVIDER_BOUNDARY_DENIAL = new RegExp(
  `^tool call denied by pre-tool hook:\\s*${PROVIDER_TOOL_BLOCK_MARKER}:`,
  "i",
);
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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

function isProgressOnlyProviderResult(
  result: AgyRunResult,
  aliases: Readonly<Record<string, string>> | undefined,
): boolean {
  if (!aliases || Object.keys(aliases).length === 0) return false;
  const structured = result.terminal.structured_output;
  if (!isRecord(structured)) return false;
  const requests = structured.host_requests ?? structured.tool_calls;
  if (requests !== undefined && requests !== null && (!Array.isArray(requests) || requests.length > 0)) return false;
  const response = structured.response ?? structured.text;
  if (typeof response !== "string") return false;
  const text = response.trim();
  return text.length > 0
    && text.length <= 400
    && !text.includes("\n")
    && PROGRESS_NARRATION.test(text);
}

function appendFinalMissingRecipientCorrection(
  prompt: string,
  recipients: readonly string[],
): string {
  const names = [...new Set(recipients.map((recipient) => recipient.trim()).filter(Boolean))]
    .map((recipient) => JSON.stringify(recipient))
    .join(", ") || "unknown";
  return `${prompt}\n\n# Final provider routing correction
A corrected provider attempt still tried internal Antigravity messaging toward missing recipient(s): ${names}.
This is the final safe routing recovery for this OMP turn.
- Do not select any Antigravity-native action of any kind.
- Do not address OMP, a host action ID, a role label, or any other name as an Antigravity recipient.
- The enforced terminal JSON object is the only return channel.
- If external work is needed, select an ID from "Available host actions" and place it in "host_requests[].action_id" with its input under "input".
- Otherwise put the final answer in "response" and return an empty "host_requests" array.
- Continue only from the supplied OMP prompt and ignore all internal routing attempts from discarded runs.`;
}

function appendPermissionConversionRecovery(
  prompt: string,
  _toolNames: readonly string[],
  recoveryNumber: number,
): string {
  // Do not echo the offending Antigravity tool name back into the model prompt.
  // Repeating that name makes the same provider-native route more salient and can
  // turn a recoverable mistake into a deterministic retry loop.
  const corrected = appendProviderHarnessRetryInstruction(prompt, []);
  if (recoveryNumber <= 1) return corrected;
  return `${corrected}\n\n# Repeated provider transport correction
This is safe recovery attempt ${recoveryNumber} after another pre-execution internal-action routing failure.
- A corrected attempt still selected the Antigravity harness. Do not plan, coordinate, inspect, message, create timed work, delegate, or manage work through Antigravity.
- Skip internal action selection entirely and produce the enforced terminal JSON object directly.
- External OMP work belongs only in "host_requests" using IDs supplied under "Available host actions". A normal answer belongs only in "response".`;
}

/**
 * Classify only an exact, side-effect-free AGY missing-recipient failure.
 *
 * Provider mode forbids Antigravity messaging entirely, but the model can still
 * misroute an OMP capability alias through AGY messaging. A retry is safe only
 * when the terminal diagnostic proves that no recipient existed, activity
 * snapshots are complete, no AGY subagent ran, and every non-media lifecycle
 * event is the failed message targeting that exact nonexistent recipient.
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
    // messaging lifecycle event. The exact nonexistent-recipient diagnostic
    // proves that no message was delivered, so a corrected retry is safe.
    return missingRecipient;
  }

  const expectedRecipient = normalizedToken(missingRecipient);
  const controlEvents: AgyStepUpdateEvent[] = [];
  for (const event of unexpected) {
    if (normalizedToken(toolStepName(event)) !== "sendmessage") {
      controlEvents.push(event);
      continue;
    }
    const recipients = collectRecipients(event.step_update.tool_info?.parameters ?? {});
    if (recipients.length === 0) return undefined;
    if (recipients.some((recipient) => normalizedToken(recipient) !== expectedRecipient)) return undefined;
  }
  if (controlEvents.length > 0 && !retryableProviderControlToolNames(controlEvents, options)) return undefined;

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
 * that tool call into a permission descriptor. Recovery is safe only when the
 * diagnostic proves permission conversion failed before execution, every
 * captured activity record is complete, no subagent exists, and no non-media
 * AGY tool lifecycle event was observed.
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
  if (!providerHarnessSnapshotsComplete(error)) return undefined;
  if (error.subagents.length > 0) return undefined;
  if (unexpectedProviderHarnessToolSteps(error.toolSteps, options).length > 0) return undefined;
  return toolName;
}

/**
 * AGY validates some provider-native action envelopes before emitting a tool
 * lifecycle event. Recover only its exact missing-action-metadata diagnostic;
 * broader invalid-argument errors may belong to OMP host actions.
 */
export function retryableInvalidProviderActionArguments(
  error: unknown,
  options: ProviderHarnessGuardOptions = {},
): boolean {
  if (!(error instanceof AgyRunError) || error.terminal?.status !== "ERROR") return false;
  const terminalError = error.terminal.error;
  if (typeof terminalError !== "string") return false;
  const match = INVALID_PROVIDER_ACTION_ARGUMENTS.exec(terminalError.trim());
  if (!match) return false;
  const properties = [...match[1].matchAll(/'([^']+)'/g)]
    .map((candidate) => normalizedToken(candidate[1]));
  if (
    properties.length !== 3
    || properties.some((property) => !REQUIRED_PROVIDER_ACTION_PROPERTIES[property])
    || Object.keys(REQUIRED_PROVIDER_ACTION_PROPERTIES)
      .some((required) => !properties.includes(required))
  ) {
    return false;
  }
  if (!providerHarnessSnapshotsComplete(error) || error.subagents.length > 0) return false;
  return unexpectedProviderHarnessToolSteps(error.toolSteps, options).length === 0;
}

/**
 * AGY sometimes tries to execute an opaque OMP wire alias as a native tool.
 * Its exact unknown-tool diagnostic is pre-execution, so retry only when the
 * rejected name belongs to this turn's alias catalog and no other activity ran.
 */
export function retryableUnknownProviderCapability(
  error: unknown,
  aliases: Readonly<Record<string, string>> | undefined,
  options: ProviderHarnessGuardOptions = {},
): string | undefined {
  if (!(error instanceof AgyRunError) || error.terminal?.status !== "ERROR" || !aliases) return undefined;
  const terminalError = error.terminal.error;
  if (typeof terminalError !== "string") return undefined;
  const match = UNKNOWN_TOOL_FAILURE.exec(terminalError.trim());
  const toolName = match?.slice(1).find((value): value is string => Boolean(value));
  if (!toolName || aliases[toolName] === undefined || aliases[toolName] === toolName) return undefined;
  if (!providerHarnessSnapshotsComplete(error) || error.subagents.length > 0) return undefined;
  if (unexpectedProviderHarnessToolSteps(error.toolSteps, options).length > 0) return undefined;
  return toolName;
}

/**
 * AGY rejects a fabricated task ID before a task-control action can execute.
 * Treat that exact failure like permission conversion only when the complete
 * activity snapshot contains no work beyond harmless control probes.
 */
export function retryableInvalidTaskId(
  error: unknown,
  options: ProviderHarnessGuardOptions = {},
): string | undefined {
  if (!(error instanceof AgyRunError)) return undefined;
  if (error.terminal?.status !== "ERROR") return undefined;
  const terminalError = error.terminal.error;
  if (typeof terminalError !== "string") return undefined;
  const match = INVALID_TASK_ID_FAILURE.exec(terminalError.trim());
  if (!match) return undefined;
  if (!providerHarnessSnapshotsComplete(error) || error.subagents.length > 0) return undefined;

  const unexpected = unexpectedProviderHarnessToolSteps(error.toolSteps, options);
  if (unexpected.length > 0 && !retryableProviderControlToolNames(unexpected, options)) return undefined;
  return match[1];
}

/**
 * The installed provider hook returns this exact marker only after denying a
 * native AGY action before execution. A corrected retry is safe when all
 * activity snapshots are complete and contain no other executable activity.
 */
export function retryableProviderBoundaryDenial(
  error: unknown,
  options: ProviderHarnessGuardOptions = {},
): boolean {
  if (!(error instanceof AgyRunError)) return false;
  if (error.terminal?.status !== "ERROR") return false;
  if (typeof error.terminal.error !== "string" || !PROVIDER_BOUNDARY_DENIAL.test(error.terminal.error.trim())) {
    return false;
  }
  if (!providerHarnessSnapshotsComplete(error) || error.subagents.length > 0) return false;
  const unexpected = unexpectedProviderHarnessToolSteps(error.toolSteps, options);
  return unexpected.length === 0
    || retryableProviderControlToolNames(unexpected, options) !== undefined;
}

function blockedProviderMessageRecipient(error: unknown): string | undefined {
  if (!(error instanceof AgyRunError)) return undefined;
  const recipients: string[] = [];
  for (const event of uniqueAgyToolSteps(error.toolSteps)) {
    if (normalizedToken(toolStepName(event)) !== "sendmessage") continue;
    const toolError = event.step_update.tool_info?.error;
    if (
      event.step_update.state !== "ERROR"
      || typeof toolError?.message !== "string"
      || !toolError.message.includes(PROVIDER_TOOL_BLOCK_MARKER)
    ) {
      return undefined;
    }
    const eventRecipients = collectRecipients(event.step_update.tool_info?.parameters ?? {})
      .map((recipient) => recipient.trim())
      .filter(Boolean);
    if (eventRecipients.length === 0) return undefined;
    recipients.push(...eventRecipients);
  }
  const unique = [...new Set(recipients)];
  return unique.length === 1 ? unique[0] : undefined;
}

export interface ProviderAttemptOptions {
  initialPrompt: string;
  invoke(prompt: string): Promise<AgyRunResult>;
  enforceToolless: boolean;
  agentName: string;
  guardOptions?: ProviderHarnessGuardOptions;
  /** Exact canonical OMP tool catalog for deterministic recovery of misrouted messages. */
  ompTools?: readonly SerializedTool[];
  /** Provider alias/canonical-name lookup used only at the deterministic recovery boundary. */
  recipientAliases?: Readonly<Record<string, string>>;
}

export interface ProviderAttemptOutcome {
  result: AgyRunResult;
  /** Usage from attempts whose outputs were deliberately discarded before the final result. */
  discardedUsage: AgyUsage[];
  attempts: number;
}

function encodeSyntheticHostResponse(
  result: AgyRunResult,
  aliases: Readonly<Record<string, string>> | undefined,
): AgyRunResult {
  if (!aliases) return result;
  const structured = result.terminal.structured_output;
  if (!isRecord(structured) || !Array.isArray(structured.tool_calls)) return result;

  const ompToWire = new Map<string, string>();
  for (const [candidate, canonical] of Object.entries(aliases)) {
    if (candidate !== canonical && !ompToWire.has(canonical)) ompToWire.set(canonical, candidate);
  }
  const hostRequests = structured.tool_calls.map((call) => {
    if (!isRecord(call) || typeof call.name !== "string") return call;
    return {
      ...(call.id === undefined ? {} : { request_id: call.id }),
      action_id: ompToWire.get(call.name) ?? call.name,
      input: call.arguments ?? {},
    };
  });
  const wireOutput = {
    response: structured.text ?? "",
    host_requests: hostRequests,
  };

  return {
    ...result,
    terminal: {
      ...result.terminal,
      response: JSON.stringify(wireOutput),
      structured_output: wireOutput,
    },
  };
}

/**
 * Run AGY with tightly bounded provider-mode recovery budgets.
 *
 * Every AGY invocation passes through the same bounded recovery wrapper. It
 * discards proven side-effect-free transport failures and response-only progress
 * narration. Exhausted recovery budgets surface an error instead of ending the
 * OMP loop with incomplete work.
 *
 * When a failed AGY send is unambiguous, prefer deterministic transport recovery
 * over another model call. Provider aliases are mapped to canonical OMP names for
 * synthesis, then host-synthesized calls are mapped back to opaque wire aliases
 * so the provider parser has one consistent contract.
 */
export async function runProviderAttempts(options: ProviderAttemptOptions): Promise<ProviderAttemptOutcome> {
  const discardedUsage: AgyUsage[] = [];
  let attempts = 0;
  let providerTransportRecoveries = 0;
  let providerProgressRecoveries = 0;
  const guardOptions = options.guardOptions ?? {};

  const invoke = async (prompt: string): Promise<AgyRunResult> => {
    attempts += 1;
    return options.invoke(prompt);
  };

  const invokeRecoveringProviderTransport = async (prompt: string): Promise<AgyRunResult> => {
    let currentPrompt = prompt;
    while (true) {
      try {
        const result = await invoke(currentPrompt);
        if (!isProgressOnlyProviderResult(result, options.recipientAliases)) return result;
        if (providerProgressRecoveries >= MAX_PROVIDER_PROGRESS_RECOVERIES) {
          throw new Error("agy repeatedly returned progress narration without the next required host action");
        }
        if (result.terminal.usage) discardedUsage.push(result.terminal.usage);
        providerProgressRecoveries += 1;
        currentPrompt = appendProviderProgressRetryInstruction(prompt);
      } catch (error) {
        const permissionTool = retryablePermissionConversionTool(error, guardOptions);
        const invalidTaskId = retryableInvalidTaskId(error, guardOptions);
        const providerBoundaryDenied = retryableProviderBoundaryDenial(error, guardOptions);
        const invalidProviderActionArguments = retryableInvalidProviderActionArguments(error, guardOptions);
        const unknownProviderCapability = retryableUnknownProviderCapability(
          error,
          options.recipientAliases,
          guardOptions,
        );
        if (providerBoundaryDenied) {
          const recipient = blockedProviderMessageRecipient(error);
          const synthesized = recipient ? deterministicRecovery(error, recipient) : undefined;
          if (synthesized) {
            recordDiscardedUsage(error, discardedUsage);
            return synthesized;
          }
        }
        if (
          !permissionTool
          && !invalidTaskId
          && !invalidProviderActionArguments
          && !providerBoundaryDenied
          && !unknownProviderCapability
        ) {
          throw error;
        }
        if (providerTransportRecoveries >= MAX_PROVIDER_TRANSPORT_RECOVERIES) throw error;

        recordDiscardedUsage(error, discardedUsage);
        providerTransportRecoveries += 1;
        currentPrompt = appendPermissionConversionRecovery(
          prompt,
          permissionTool ? [permissionTool] : [],
          providerTransportRecoveries,
        );
      }
    }
  };

  function deterministicRecovery(error: unknown, recipient: string): AgyRunResult | undefined {
    if (options.ompTools === undefined) return undefined;
    const canonicalRecipient = options.recipientAliases?.[recipient] ?? recipient;
    const synthesized = synthesizeMissingRecipientRecovery(
      error,
      canonicalRecipient,
      options.ompTools,
      recipient,
    );
    return synthesized ? encodeSyntheticHostResponse(synthesized, options.recipientAliases) : undefined;
  }

  let result: AgyRunResult;
  try {
    result = await invokeRecoveringProviderTransport(options.initialPrompt);
  } catch (error) {
    if (!options.enforceToolless) throw error;

    const missingRecipient = retryableMissingAgyRecipient(error, guardOptions);
    if (!missingRecipient) throw error;

    recordDiscardedUsage(error, discardedUsage);
    const synthesized = deterministicRecovery(error, missingRecipient);
    if (synthesized) {
      result = synthesized;
    } else {
      const correctedPrompt = appendMissingAgyRecipientRetryInstruction(options.initialPrompt, missingRecipient);
      try {
        result = await invokeRecoveringProviderTransport(correctedPrompt);
      } catch (retryError) {
        const repeatedRecipient = retryableMissingAgyRecipient(retryError, guardOptions);
        if (!repeatedRecipient) throw retryError;
        recordDiscardedUsage(retryError, discardedUsage);
        const synthesizedRetry = deterministicRecovery(retryError, repeatedRecipient);
        if (synthesizedRetry) {
          result = synthesizedRetry;
        } else {
          result = await invokeRecoveringProviderTransport(
            appendFinalMissingRecipientCorrection(correctedPrompt, [missingRecipient, repeatedRecipient]),
          );
        }
      }
    }
  }

  if (options.enforceToolless) {
    const safeProbeTools = result.subagents.length === 0 && providerHarnessSnapshotsComplete(result)
      ? retryableProviderControlToolNames(result.toolSteps, guardOptions)
      : undefined;

    // Read-only status probes are permitted to finish in the same AGY process.
    // Do not discard a complete terminal response or spend another model call
    // merely to make an otherwise safe provider trajectory perfectly tool-less.
    if (!safeProbeTools) assertProviderHarnessIsToolless(result, options.agentName, guardOptions);
  }

  return { result, discardedUsage, attempts };
}
