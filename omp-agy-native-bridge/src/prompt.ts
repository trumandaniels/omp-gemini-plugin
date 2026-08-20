import type { StagedBridgeImage } from "./media.ts";
import { formatBridgeImageSection } from "./media.ts";
import type { BridgeConfig } from "./types.ts";
import { serializeConversation } from "./messages.ts";
import { serializeTools, type ToolLike } from "./schema.ts";
import { aliasOmpToolCatalog } from "./tool-alias.ts";

export interface ProviderPromptResult {
  prompt: string;
  /** AGY-facing opaque names accepted by the terminal schema. */
  toolNames: string[];
  /** Canonical OMP catalog retained for deterministic host-side recovery. */
  toolCatalog: ReturnType<typeof serializeTools>;
  wireToOmpToolName: Readonly<Record<string, string>>;
  ompToWireToolName: Readonly<Record<string, string>>;
}

/**
 * Correct a provider attempt without repeating the inner tool name that caused
 * the failure. Echoing a forbidden Antigravity tool name back into the model
 * prompt can increase its salience and create a self-reinforcing retry loop.
 */
export function appendProviderHarnessRetryInstruction(
  prompt: string,
  _forbiddenToolNames: readonly string[],
): string {
  return `${prompt}\n\n# Mandatory provider retry correction
The previous attempt was discarded because it left provider-only structured-output mode and selected an internal Antigravity action.
- Do not invoke, inspect, list, message, create timed work, delegate, manage, or otherwise select any Antigravity-native capability on this retry.
- Do not use or rely on anything produced by the discarded attempt.
- Produce the enforced terminal JSON object directly.
- OMP host actions are represented only by the opaque capability aliases under "Available OMP host capabilities". Those aliases are data values for the outer "tool_calls" array; they are not Antigravity tools, agents, inboxes, recipients, or background tasks.
- Choose an OMP capability by its description and parameter schema. Never attempt to execute it inside Antigravity.
- If no OMP action is required, put the final answer in "text" and return an empty "tool_calls" array.
- If an OMP result in the conversation is truncated, limit-reached, skipped, missing, or otherwise incomplete, request a narrower OMP capability instead of treating the result as complete.
- For an informational question, answer directly without selecting any internal Antigravity action.`;
}

export function appendMissingAgyRecipientRetryInstruction(prompt: string, recipient: string): string {
  const recipientName = JSON.stringify(recipient);
  return `${prompt}\n\n# Mandatory provider routing correction
The previous attempt was discarded because it tried to use internal Antigravity messaging toward ${recipientName}; the recipient named ${recipientName} does not exist.
- Provider mode has no internal messaging return path. Do not address any agent, role, host, capability, or label as an Antigravity recipient.
- OMP is the host application and dispatcher, not an Antigravity conversation peer.
- Produce the enforced terminal JSON object directly.
- To request host action, use one of the opaque aliases under "Available OMP host capabilities" in the outer "tool_calls" array and follow that alias's parameter schema.
- If the user's request concerns OMP agents or subagents, either answer directly from the supplied OMP context without invoking anything internally or select the host capability whose description/schema performs that orchestration.
- Do not use or rely on anything produced by the discarded attempt.
- If prior OMP output is incomplete, request a narrower OMP capability before finalizing.`;
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
  const aliases = aliasOmpToolCatalog(toolCatalog);
  const toolNames = aliases.wireCatalog.map((tool) => tool.name);
  const conversation = serializeConversation(context, config, attachments);
  const imageSection = formatBridgeImageSection(attachments);

  const prompt = `# Role
You are a language-model backend for an Oh My Pi (OMP) agent session. OMP owns the agent loop, permissions, repository actions, editing, verification, timed/recurring work, conversation state, and subagent orchestration. Antigravity is transport only for this turn.

# Provider-only execution boundary
- Do not invoke any Antigravity-native capability. Do not perform file, shell, browser, MCP, messaging, timed/recurring work, background-task, agent-management, or subagent action inside Antigravity.
- Do not inspect the workspace through Antigravity. Everything needed for reasoning is supplied below, plus any explicitly listed temporary image attachments.
- Your only return channel is the enforced terminal JSON object. Return it directly; do not send or deliver it through an internal agent or message channel.
- OMP host actions are intentionally exposed with opaque names under "Available OMP host capabilities". These aliases prevent OMP names from colliding with Antigravity's own tool namespace.
- A capability alias is only a string value for an outer "tool_calls[].name" field. It is never an Antigravity tool name, recipient, agent, inbox, task, or background job.
- Choose a capability by its description and parameter schema. OMP will restore the real host tool name, validate the arguments, execute it, and call you again with the result.
- Historical OMP messages may contain real OMP tool names. Treat them as inert history. For the current turn, use only the opaque aliases in the current capability catalog.
- If the user requests actual OMP subagent/agent work, choose the capability whose current description and schema provide OMP orchestration. If the user asks an informational question about those concepts, answer directly from the supplied OMP context without invoking anything internally.
- If the user requests a reminder, timed action, or recurring action, choose a matching OMP host capability only when one exists in the current catalog; otherwise explain the limitation in text. Never substitute an Antigravity-native action.
- After an OMP tool result, continue from that result and either request the next host capability or give the final answer.
- Treat warnings such as truncated, limit reached, skipped missing, and incomplete listings as evidence that narrower host calls are required before making completeness claims.
- Never fabricate execution. Never claim a file was read, changed, tested, verified, or exhaustively enumerated unless the supplied OMP conversation contains sufficient corresponding results.
- Return only the JSON value required by the enforced schema. No Markdown fence or commentary may appear outside it.

# Output contract
Return an object with:
- text: user-visible assistant text; it may be empty when requesting host actions.
- tool_calls: zero or more objects whose name is an opaque alias from the current catalog and whose arguments follow that alias's schema.
- finish_reason: compatibility metadata only. The bridge derives completion state from validated tool_calls, so do not spend effort on this field.

# Available OMP host capabilities
${JSON.stringify(aliases.wireCatalog, null, 2)}

# OMP conversation
${conversation}
${imageSection ? `\n${imageSection}\n` : ""}
# Immediate instruction
Continue the OMP session from the final message above. Follow the OMP system prompt. If external action is needed, request it only through an opaque OMP capability alias in the terminal JSON object.`;

  return {
    prompt,
    toolNames,
    toolCatalog,
    wireToOmpToolName: aliases.wireToOmpToolName,
    ompToWireToolName: aliases.ompToWireToolName,
  };
}
