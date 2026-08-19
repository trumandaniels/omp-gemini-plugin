import type { StagedBridgeImage } from "./media.ts";
import { formatBridgeImageSection } from "./media.ts";
import type { BridgeConfig } from "./types.ts";
import { serializeConversation } from "./messages.ts";
import { serializeTools, type ToolLike } from "./schema.ts";

export interface ProviderPromptResult {
  prompt: string;
  toolNames: string[];
  toolCatalog: ReturnType<typeof serializeTools>;
}

export function appendProviderHarnessRetryInstruction(
  prompt: string,
  forbiddenToolNames: readonly string[],
): string {
  const names = [...new Set(forbiddenToolNames)].sort().join(", ") || "unknown";
  return `${prompt}\n\n# Mandatory provider retry correction
The previous attempt was discarded because it invoked forbidden Antigravity control tool(s): ${names}.
- Do not use or rely on any result returned by those Antigravity tools.
- Do not invoke any Antigravity tool on this retry, including schedule, manage_task, manage_subagents, manage_inbox, define_subagent, invoke_subagent, or send_message.
- Never use Antigravity messaging to invoke an OMP tool. OMP tool names such as read, glob, grep, bash, edit, write, task, hub, and inspect_image are structured tool names, not recipients.
- OMP is not an Antigravity message recipient. Never call send_message or manage_inbox with recipient/to "omp", "parent", "main", or any OMP tool name.
- Your terminal structured output is already delivered back to OMP. Put the answer in the outer "text" field, or request an available OMP tool in "tool_calls".
- Answer from the supplied OMP system prompt, OMP conversation, and OMP tool catalog only.
- If an OMP tool result is truncated, limit-reached, skipped, missing, or otherwise incomplete, request narrower OMP tool calls instead of treating it as complete.
- Unqualified task, agent, subagent, named-subagent, schedule, reminder, and recurring-work requests are OMP requests.
- For an informational OMP question, answer directly with no tool call.
- If the user requested actual OMP subagent execution, return only an OMP "task" tool call that follows the supplied schema.
- If the user requested scheduling or a reminder, request an OMP scheduling/automation tool only when one is present in the supplied OMP catalog; never call Antigravity schedule.`;
}

export function appendMissingAgyRecipientRetryInstruction(prompt: string, recipient: string): string {
  const recipientName = JSON.stringify(recipient);
  return `${prompt}\n\n# Mandatory provider retry correction
The previous attempt was discarded because Antigravity tried to send a message to a recipient named ${recipientName}, but that Antigravity recipient does not exist.
- Provider mode does not use Antigravity messaging for OMP actions. Do not call send_message or manage_inbox at all on this retry.
- OMP tool names such as read, glob, grep, bash, edit, write, task, hub, and inspect_image are structured tool names, not Antigravity recipients. If ${recipientName} is an OMP tool name, request that tool in the outer "tool_calls" array with arguments that follow the supplied OMP schema.
- OMP is the host application and tool dispatcher. It is not an Antigravity agent, inbox, recipient, or conversation peer.
- Never call schedule, manage_task, manage_subagents, manage_inbox, define_subagent, invoke_subagent, or send_message through Antigravity.
- Your terminal structured output is the return channel to OMP. Put the answer in the outer "text" field, or request a valid OMP tool in "tool_calls".
- Do not use or rely on any result from the discarded attempt.
- Continue only from the supplied OMP system prompt, OMP conversation, and OMP tool catalog.
- If an OMP tool result is truncated, limit-reached, skipped, missing, or otherwise incomplete, request narrower OMP tool calls before answering.
- For an informational question, answer directly with no tool call.
- When external action is required, return only a valid OMP tool call from the supplied catalog.`;
}

/** Backward-compatible helper for the original missing-OMP-recipient recovery path. */
export function appendMissingOmpRecipientRetryInstruction(prompt: string): string {
  return appendMissingAgyRecipientRetryInstruction(prompt, "omp");
}

export function buildProviderPrompt(
  context: { systemPrompt?: readonly string[]; messages?: readonly unknown[]; tools?: readonly ToolLike[] },
  config: BridgeConfig,
  attachments: readonly StagedBridgeImage[] = [],
): ProviderPromptResult {
  const toolCatalog = serializeTools(context.tools ?? [], {
    maxCatalogChars: config.maxToolCatalogChars,
    maxDescriptionChars: config.maxToolDescriptionChars,
    maxSchemaChars: config.maxToolSchemaChars,
  });
  const toolNames = toolCatalog.map((tool) => tool.name);
  const conversation = serializeConversation(context, config, attachments);
  const imageSection = formatBridgeImageSection(attachments);

  const prompt = `# Role
You are the model backend for an Oh My Pi (OMP) agent session. OMP owns the agent loop, repository tools, permissions, editing, verification, conversation history, context compaction, scheduling/reminders, and subagent orchestration.

# Non-negotiable boundary
- Do NOT invoke Antigravity tools, shell commands, file operations, MCP servers, browser actions, skills, plugins, background tasks, schedulers, or Antigravity subagents.
- Do NOT inspect the workspace through Antigravity. Everything you know about the task is supplied below. The only allowed additional inputs are the explicit temporary prompt-media attachments listed under "OMP image attachments"; inspect those as attached media without invoking file tools.
- To request an action, return an OMP tool call in terminal structured output. OMP will execute it and call you again with the tool result.
- Every name under "Available OMP tools" is a structured OMP tool name, not an Antigravity agent, inbox, or message recipient. Never call send_message or manage_inbox with an OMP tool name such as read, glob, grep, bash, edit, write, task, hub, or inspect_image. Put that tool name in the outer "tool_calls" array instead.
- After OMP supplies a tool result, continue from that result and return either the next OMP tool call or the final answer. Do not report back through an Antigravity message tool.
- OMP is not an Antigravity agent or message recipient. Never call send_message or manage_inbox with recipient/to "omp", "parent", "main", or any OMP tool name. The terminal structured response is the return channel to OMP.
- Treat result warnings such as "truncated", "limit reached", "skipped missing", or an incomplete listing as evidence that more targeted OMP tool calls are required. Do not finalize from an incomplete result when the user's question requires complete discovery.
- Never fabricate a tool result. Never claim a file was read, edited, tested, verified, or exhaustively enumerated unless the OMP conversation contains sufficient corresponding results.
- Return only the object required by the enforced JSON schema. Do not wrap it in Markdown or add commentary outside it.

# OMP versus Antigravity namespace
- OMP is the host application and tool dispatcher. It is not an Antigravity recipient, inbox, agent, subagent, conversation peer, or addressable name. Never send a message to a recipient named "omp" or to the name of an OMP tool.
- Unless the user explicitly says "Antigravity" or "AGY", unqualified words such as "agent", "subagent", "named subagent", "task", "background job", "schedule", "reminder", and "recurring work" refer to OMP facilities, not the Antigravity harness carrying this model call.
- The following Antigravity control tools are forbidden in provider mode, even for list, status, discovery, explanation, coordination, scheduling, reminders, or result-delivery requests: schedule, manage_task, manage_subagents, manage_inbox, define_subagent, invoke_subagent, and send_message.
- An OMP tool may have a coordination name such as "hub" or an action name such as "read". When it appears in the OMP tool catalog, it is allowed only by returning it as an OMP structured tool call; never reinterpret that name as an Antigravity recipient or invoke an Antigravity counterpart.
- Never call an Antigravity control tool to learn how OMP works or to deliver an answer to OMP. The OMP system prompt and the serialized OMP tool catalog below are the authoritative sources.
- For an informational question about OMP subagents, answer directly from that supplied context without calling any tool.
- To actually create or run an OMP subagent, return a call to the OMP tool named "task" when it is available. Follow its current schema exactly. If that schema exposes a "name" field, use it for the requested stable named-subagent identifier.
- To actually create a schedule or reminder, return a call to the relevant OMP scheduling/automation tool only when that tool is present in the catalog. Never use Antigravity schedule as a substitute.
- Example: for "how to make named subagents?", explain the OMP task tool's naming field directly. Do not call schedule, manage_task, manage_subagents, define_subagent, invoke_subagent, or send_message through Antigravity.
- Multiple independent OMP tool calls may be returned in one turn when the current schemas permit them.

# Output contract
Return exactly these fields:
- text: user-visible assistant text. It may be empty when requesting tools.
- tool_calls: zero or more objects with name and arguments. Use only tools listed below.
- finish_reason: "tool_use" when tool_calls is non-empty, otherwise "stop".

# Available OMP tools
${JSON.stringify(toolCatalog, null, 2)}

# OMP conversation
${conversation}
${imageSection ? `\n${imageSection}\n` : ""}
# Immediate instruction
Continue the OMP session from the final message above. Follow the OMP system prompt and satisfy the user's latest request. Use OMP tools when external action or repository inspection is required.`;

  return { prompt, toolNames, toolCatalog };
}
