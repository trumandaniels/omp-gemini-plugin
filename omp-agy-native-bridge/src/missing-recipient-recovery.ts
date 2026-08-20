import { AgyRunError } from "./agy/runner.ts";
import { parseBridgeStructuredOutput, type SerializedTool } from "./schema.ts";
import type { AgyRunResult, AgyStepUpdateEvent, BridgeStructuredOutput } from "./types.ts";

const HOST_RETURN_RECIPIENTS = new Set(["omp", "parent", "main"]);
const SUBAGENT_ROLE_RECIPIENTS = new Set([
  "agent",
  "agents",
  "subagent",
  "subagents",
  "namedsubagent",
]);
const CONTROL_ONLY_MESSAGES = new Set([
  "continue",
  "done",
  "go",
  "next",
  "ok",
  "proceed",
  "resume",
]);
const RECIPIENT_PARAMETER_KEYS = new Set([
  "recipient",
  "recipients",
  "recipientname",
  "to",
  "target",
]);
const MESSAGE_PARAMETER_KEYS = new Set([
  "message",
  "content",
  "text",
  "body",
  "prompt",
  "task",
]);
const MAX_PARAMETER_SCAN_DEPTH = 16;

function normalizedToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function toolStepName(event: AgyStepUpdateEvent): string {
  return event.step_update.tool_info?.name
    ?? event.step_update.tool_name
    ?? "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * AGY's streamed tool parameter keys are not a stable API surface: releases and
 * tool adapters have emitted casing/style variants such as Recipient/Message,
 * recipient_name, and nested input objects. Scan the captured JSON by normalized
 * key name instead of assuming one exact object shape. The provider guard uses
 * the same principle when proving that a missing-recipient failure is safe.
 */
function collectParameterStrings(
  value: unknown,
  acceptedKeys: ReadonlySet<string>,
  parentKey = "",
  depth = 0,
): string[] {
  if (depth > MAX_PARAMETER_SCAN_DEPTH) return [];
  const normalizedParent = normalizedToken(parentKey);

  if (typeof value === "string") {
    return acceptedKeys.has(normalizedParent) ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectParameterStrings(item, acceptedKeys, parentKey, depth + 1));
  }
  if (!isRecord(value)) return [];

  return Object.entries(value).flatMap(([key, child]) =>
    collectParameterStrings(child, acceptedKeys, key, depth + 1));
}

function failedSendMessage(error: AgyRunError, recipient: string): string | undefined {
  const expectedRecipient = normalizedToken(recipient);
  const messages: string[] = [];
  let sawSendMessage = false;

  for (const event of error.toolSteps) {
    if (normalizedToken(toolStepName(event)) !== "sendmessage") continue;
    sawSendMessage = true;
    const parameters = event.step_update.tool_info?.parameters;
    if (!parameters) return undefined;

    const recipients = collectParameterStrings(parameters, RECIPIENT_PARAMETER_KEYS)
      .map((value) => value.trim())
      .filter(Boolean);
    if (recipients.length === 0) return undefined;
    if (recipients.some((value) => normalizedToken(value) !== expectedRecipient)) return undefined;

    const eventMessages = collectParameterStrings(parameters, MESSAGE_PARAMETER_KEYS)
      .map((value) => value.trim())
      .filter(Boolean);
    messages.push(...eventMessages);
  }

  // Deterministic synthesis requires the actual undelivered payload. A terminal-
  // only missing-recipient error is still safe for the bounded prompt retry, but
  // there is not enough information here to manufacture an OMP tool call.
  if (!sawSendMessage) return undefined;
  const unique = [...new Set(messages)];
  return unique.length === 1 ? unique[0] : undefined;
}

function schemaProperties(tool: SerializedTool): Record<string, unknown> | undefined {
  return isRecord(tool.parameters.properties) ? tool.parameters.properties : undefined;
}

function requiredKeys(schema: Record<string, unknown>): Set<string> {
  return new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  );
}

function taskArguments(tool: SerializedTool, task: string): Record<string, unknown> | undefined {
  const properties = schemaProperties(tool);
  if (!properties) return undefined;
  const required = requiredKeys(tool.parameters);

  // OMP defaults to task.batch=true. The model-facing wire shape is
  // { context, tasks: [{ task, ... }] }; agent/name/effort/etc. are item fields.
  // Respect the exact live schema serialized from OMP rather than hard-coding a
  // bridge-specific task shape because task.batch and other settings are dynamic.
  const tasksSchema = properties.tasks;
  if (isRecord(tasksSchema)) {
    const itemSchema = isRecord(tasksSchema.items) ? tasksSchema.items : undefined;
    const itemProperties = itemSchema && isRecord(itemSchema.properties) ? itemSchema.properties : undefined;
    if (!itemProperties || !Object.prototype.hasOwnProperty.call(itemProperties, "task")) return undefined;
    if (required.has("context") && !Object.prototype.hasOwnProperty.call(properties, "context")) return undefined;

    // Fail closed if this OMP version/config requires another top-level field we
    // cannot derive safely from an undelivered AGY message.
    for (const key of required) {
      if (key !== "context" && key !== "tasks") return undefined;
    }

    const itemRequired = requiredKeys(itemSchema ?? {});
    for (const key of itemRequired) {
      if (key !== "task") return undefined;
    }

    const args: Record<string, unknown> = {
      tasks: [{ task }],
    };
    if (Object.prototype.hasOwnProperty.call(properties, "context")) {
      args.context = "Delegated from the current parent OMP turn. Work in the current repository and complete the task exactly as requested.";
    }
    return args;
  }

  // task.batch=false exposes a flat { task, ... } shape.
  if (Object.prototype.hasOwnProperty.call(properties, "task")) {
    for (const key of required) {
      if (key !== "task") return undefined;
    }
    return { task };
  }

  return undefined;
}

function syntheticResult(output: BridgeStructuredOutput): AgyRunResult {
  return {
    terminal: {
      status: "SUCCESS",
      response: JSON.stringify(output),
      structured_output: output,
    },
    events: [],
    stderr: "",
    exitCode: 0,
    signalCode: null,
    toolSteps: [],
    subagents: [],
    eventCount: 0,
    toolStepCount: 0,
    subagentCount: 0,
  };
}

function structuredHostReturn(message: string, tools: readonly SerializedTool[]): BridgeStructuredOutput | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return undefined;
  }
  try {
    return parseBridgeStructuredOutput(parsed, tools.map((tool) => tool.name));
  } catch {
    return undefined;
  }
}

function structuredToolReturn(
  message: string,
  recipient: string,
  tools: readonly SerializedTool[],
): BridgeStructuredOutput | undefined {
  const tool = tools.find((candidate) => normalizedToken(candidate.name) === normalizedToken(recipient));
  if (!tool) return undefined;

  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(message);
  } catch {
    return undefined;
  }
  if (!isRecord(argumentsValue)) return undefined;

  try {
    return parseBridgeStructuredOutput({
      text: "",
      tool_calls: [{ name: tool.name, arguments: argumentsValue }],
      finish_reason: "tool_use",
    }, tools.map((candidate) => candidate.name));
  } catch {
    return undefined;
  }
}

/**
 * Convert a proven side-effect-free AGY missing-recipient failure into the OMP
 * response the model was trying to deliver, without asking AGY to reason again.
 *
 * OMP semantics matter here:
 * - `task` is an OMP tool, never an address. With task.batch enabled (the OMP
 *   default), its model-facing shape is { context, tasks: [{ task, ... }] };
 *   with task.batch disabled it is the flat task item shape.
 * - agent/subagent are OMP orchestration concepts; spawning is performed by the
 *   OMP `task` tool, not by messaging a recipient named "subagent".
 * - `hub` is the OMP surface for messaging already-spawned agent IDs; a generic
 *   `task` or `subagent` recipient is not valid OMP or AGY routing.
 *
 * This deliberately handles only cases with unambiguous transport semantics:
 * - recipient omp/parent/main + a bridge envelope or substantive plain text =>
 *   that host return;
 * - recipient matching an available OMP tool + JSON-object payload => a call to
 *   that exact tool;
 * - recipient task or a generic agent/subagent role + one substantive failed
 *   message => an OMP task tool call using the exact live OMP task schema.
 *
 * Free-form messages to ordinary tool recipients still use the bounded prompt
 * retry path because their structured arguments cannot be derived safely.
 */
export function synthesizeMissingRecipientRecovery(
  error: unknown,
  recipient: string,
  tools: readonly SerializedTool[],
  failedRecipient = recipient,
): AgyRunResult | undefined {
  if (!(error instanceof AgyRunError)) return undefined;
  const message = failedSendMessage(error, failedRecipient);
  if (!message) return undefined;
  const normalizedRecipient = normalizedToken(recipient);
  if (HOST_RETURN_RECIPIENTS.has(normalizedRecipient)) {
    const output = structuredHostReturn(message, tools);
    if (output) return syntheticResult(output);
    if (message.length < 2 || CONTROL_ONLY_MESSAGES.has(normalizedToken(message))) return undefined;
    return syntheticResult({ text: message, tool_calls: [], finish_reason: "stop" });
  }

  const toolOutput = structuredToolReturn(message, recipient, tools);
  if (toolOutput) return syntheticResult(toolOutput);

  const isSubagentRole = SUBAGENT_ROLE_RECIPIENTS.has(normalizedRecipient);
  const isTaskRecipient = normalizedRecipient === "task";
  if (!isSubagentRole && !isTaskRecipient) return undefined;
  if (message.length < 8 || CONTROL_ONLY_MESSAGES.has(normalizedToken(message))) return undefined;

  const taskTool = tools.find((tool) => normalizedToken(tool.name) === "task");
  if (!taskTool) return undefined;
  const args = taskArguments(taskTool, message);
  if (!args) return undefined;

  return syntheticResult({
    text: "",
    tool_calls: [{ name: taskTool.name, arguments: args }],
    finish_reason: "tool_use",
  });
}
