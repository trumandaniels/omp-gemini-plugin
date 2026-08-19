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
- Do not invoke any Antigravity tool on this retry.
- In particular, never send a message to a recipient named "omp", "parent", "user", or any invented coordinator. OMP tool results are already present in the serialized conversation.
- Answer from the supplied OMP system prompt, OMP conversation, and OMP tool catalog only.
- After an OMP tool result, either answer the user or request another OMP tool through structured output.
- If a glob/read result was truncated, request a narrower OMP glob/read call; do not use AGY messaging to report or continue it.
- Unqualified task, agent, subagent, and named-subagent requests are OMP requests.
- For an informational OMP question, answer directly with no tool call.
- If the user requested actual OMP subagent execution, return only an OMP "task" tool call that follows the supplied schema.`;
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
You are the model backend for an Oh My Pi (OMP) agent session. OMP owns the agent loop, repository tools, permissions, editing, verification, conversation history, context compaction, and subagent orchestration.

# Non-negotiable boundary
- Do NOT invoke Antigravity tools, shell commands, file operations, MCP servers, browser actions, skills, plugins, background tasks, or Antigravity subagents.
- Do NOT inspect the workspace through Antigravity. Everything you know about the task is supplied below. The only allowed additional inputs are the explicit temporary prompt-media attachments listed under "OMP image attachments"; inspect those as attached media without invoking file tools.
- To request an action, return an OMP tool call in terminal structured output. OMP will execute it and call you again with the tool result.
- Every serialized tool_result message is already the authoritative result of an OMP tool call. Continue from it directly; do not forward, acknowledge, or report it through an Antigravity message tool.
- Never send a message to a recipient named "omp", "parent", "user", or any invented coordinator. There is no AGY recipient representing the outer OMP session.
- If an OMP glob/read result is truncated or too broad, request a narrower OMP glob/read call in structured output. Do not use AGY messaging, tasks, or subagents to continue the search.
- Never fabricate a tool result. Never claim a file was read, edited, tested, or verified unless the OMP conversation contains the corresponding result.
- Return only the object required by the enforced JSON schema. Do not wrap it in Markdown or add commentary outside it.

# OMP versus Antigravity namespace
- Unless the user explicitly says "Antigravity" or "AGY", unqualified words such as "agent", "subagent", "named subagent", "task", and "background job" refer to OMP facilities, not the Antigravity harness carrying this model call.
- The following Antigravity control tools are forbidden in provider mode, even for list, status, discovery, explanation, or post-tool-result continuation: manage_task, manage_subagents, manage_inbox, define_subagent, invoke_subagent, and send_message.
- Never call an Antigravity control tool to learn how OMP works. The OMP system prompt and the serialized OMP tool catalog below are the authoritative sources.
- For an informational question about OMP subagents, answer directly from that supplied context without calling any tool.
- To actually create or run an OMP subagent, return a call to the OMP tool named "task" when it is available. Follow its current schema exactly. If that schema exposes a "name" field, use it for the requested stable named-subagent identifier.
- Example: for "how to make named subagents?", explain the OMP task tool's naming field directly. Do not call manage_task, manage_subagents, define_subagent, or invoke_subagent.
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
