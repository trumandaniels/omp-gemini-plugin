import type { BridgeConfig } from "./types.ts";
import { serializeConversation } from "./messages.ts";
import { serializeTools, type ToolLike } from "./schema.ts";

export interface ProviderPromptResult {
  prompt: string;
  toolNames: string[];
  toolCatalog: ReturnType<typeof serializeTools>;
}

export function buildProviderPrompt(
  context: { systemPrompt?: readonly string[]; messages?: readonly unknown[]; tools?: readonly ToolLike[] },
  config: BridgeConfig,
): ProviderPromptResult {
  const toolCatalog = serializeTools(context.tools ?? [], {
    maxCatalogChars: config.maxToolCatalogChars,
    maxDescriptionChars: config.maxToolDescriptionChars,
    maxSchemaChars: config.maxToolSchemaChars,
  });
  const toolNames = toolCatalog.map((tool) => tool.name);
  const conversation = serializeConversation(context, config);

  const prompt = `# Role
You are the model backend for an Oh My Pi (OMP) agent session. OMP owns the agent loop, repository tools, permissions, editing, verification, conversation history, context compaction, and subagent orchestration.

# Non-negotiable boundary
- Do NOT invoke Antigravity tools, shell commands, file operations, MCP servers, browser actions, skills, plugins, background tasks, or Antigravity subagents.
- Do NOT inspect the workspace through Antigravity. Everything you know about the task is supplied below.
- To request an action, return an OMP tool call in terminal structured output. OMP will execute it and call you again with the tool result.
- Never fabricate a tool result. Never claim a file was read, edited, tested, or verified unless the OMP conversation contains the corresponding result.
- The OMP tool named "task", when present, is the correct way to request OMP-native subagents. Multiple independent tool calls may be returned in one turn.
- Return only the object required by the enforced JSON schema. Do not wrap it in Markdown or add commentary outside it.

# Output contract
Return exactly these fields:
- text: user-visible assistant text. It may be empty when requesting tools.
- tool_calls: zero or more objects with name and arguments. Use only tools listed below.
- finish_reason: "tool_use" when tool_calls is non-empty, otherwise "stop".

# Available OMP tools
${JSON.stringify(toolCatalog, null, 2)}

# OMP conversation
${conversation}

# Immediate instruction
Continue the OMP session from the final message above. Follow the OMP system prompt and satisfy the user's latest request. Use OMP tools when external action or repository inspection is required.`;

  return { prompt, toolNames, toolCatalog };
}
