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

function messageRecipients(parameters: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["recipient", "recipientName", "to", "target"] as const) {
    const value = parameters[key];
    if (typeof value === "string") out.push(value);
  }
  const recipients = parameters.recipients;
  if (Array.isArray(recipients)) {
    for (const value of recipients) {
      if (typeof value === "string") out.push(value);
    }
  }
  return out;
}

function failedSendMessage(error: AgyRunError, recipient: string): string | undefined {
  const expectedRecipient = normalizedToken(recipient);
  const messages: string[] = [];
  for (const event of error.toolSteps) {
    if (normalizedToken(toolStepName(event)) !== "sendmessage") continue;
    const parameters = event.step_update.tool_info?.parameters;
    if (!parameters) continue;

    const recipients = messageRecipients(parameters);
    if (recipients.length === 0) return undefined;
    if (recipients.some((value) => normalizedToken(value) !== expectedRecipient)) return undefined;

    for (const key of ["message", "content", "text", "body", "prompt", "task"] as const) {
      const value = parameters[key];
      if (typeof value === "string" && value.trim() !== "") {
        messages.push(value.trim());
        break;
      }
    }
  }

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

  // OMP defaults to task.batch=true, whose model-facing shape is
  // { context, tasks: [{ task, ... }] }. Respect and validate the exact schema
  // supplied by OMP rather than assuming a particular installed OMP version.
  const tasksSchema = properties.tasks;
  if (isRecord(tasksSchema)) {
    const itemSchema = isRecord(tasksSchema.items) ? tasksSchema.items : undefined;
    const itemProperties = itemSchema && isRecord(itemSchema.properties) ? itemSchema.properties : undefined;
    if (!itemProperties || !Object.prototype.hasOwnProperty.call(itemProperties, "task")) return undefined;
    if (required.has("context") && !Object.prototype.hasOwnProperty.call(properties, "context")) return undefined;

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

/**
 * Convert a proven side-effect-free AGY missing-recipient failure into the OMP
 * response the model was trying to deliver, without asking AGY to reason again.
 *
 * This deliberately handles only cases with unambiguous transport semantics:
 * - recipient omp/parent/main + a valid bridge JSON envelope => that envelope;
 * - recipient agent/subagent/subagents/named-subagent (or task) + one substantive
 *   failed message => an OMP task tool call, but only when the current task
 *   schema exposes a recognizable flat or batch shape.
 *
 * Other recipients (for example `read`) still use the bounded prompt retry path
 * because a free-form send_message payload cannot be safely converted into that
 * tool's structured arguments.
 */
export function synthesizeMissingRecipientRecovery(
  error: unknown,
  recipient: string,
  tools: readonly SerializedTool[],
): AgyRunResult | undefined {
  if (!(error instanceof AgyRunError)) return undefined;
  const message = failedSendMessage(error, recipient);
  if (!message) return undefined;

  const normalizedRecipient = normalizedToken(recipient);
  if (HOST_RETURN_RECIPIENTS.has(normalizedRecipient)) {
    const output = structuredHostReturn(message, tools);
    return output ? syntheticResult(output) : undefined;
  }

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
