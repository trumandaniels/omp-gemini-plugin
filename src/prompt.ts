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
 * Correct a provider attempt without repeating the internal action name that
 * caused the failure. Echoing it can reinforce the same routing mistake.
 */
export function appendProviderHarnessRetryInstruction(
  prompt: string,
  _forbiddenToolNames: readonly string[],
): string {
  return `${prompt}\n\n# Mandatory provider retry correction
The previous attempt was discarded because it left provider-only response mode and selected an internal Antigravity action.
- Do not invoke, inspect, list, message, create timed work, delegate, manage, or otherwise select any Antigravity-native action on this retry.
- Do not use or rely on anything produced by the discarded attempt.
- Produce the enforced terminal JSON object directly.
- External OMP work is represented only by IDs under "Available host actions". Put requests in the outer "host_requests" array using "action_id" and "input"; never execute those IDs inside Antigravity.
- Choose an action from its purpose and input schema.
- If no external action is required, put the final answer in "response" and return an empty "host_requests" array.
- If an OMP result in the conversation is truncated, limit-reached, skipped, missing, or otherwise incomplete, request a narrower host action instead of treating the result as complete.
- For an informational question, answer directly without selecting any internal Antigravity action.`;
}

export function appendProviderProgressRetryInstruction(prompt: string): string {
  return `${prompt}\n\n# Mandatory continuation correction
The previous attempt was discarded because it returned only progress narration. A response without a host request ends the OMP loop.
- Do not repeat, paraphrase, or rely on the discarded progress message.
- If actionable work remains, keep "response" empty and return the next necessary action in "host_requests" now.
- Return a non-empty "response" with no host requests only when it is the complete final answer to the user's request.
- Do not announce what you will inspect, search, read, edit, run, or verify. Request that host action in the same terminal JSON object instead.`;
}

export function appendMissingAgyRecipientRetryInstruction(prompt: string, recipient: string): string {
  const recipientName = JSON.stringify(recipient);
  return `${prompt}\n\n# Mandatory provider routing correction
The previous attempt was discarded because it tried to use internal Antigravity messaging toward ${recipientName}; the recipient named ${recipientName} does not exist.
- Provider mode has no internal messaging return path. Do not address any agent, role, host, action ID, or label as an Antigravity recipient.
- OMP is the host application and dispatcher, not an Antigravity conversation peer.
- Produce the enforced terminal JSON object directly.
- To request external work, select an ID under "Available host actions" and place it in "host_requests[].action_id" with its input under "input".
- If the user's request concerns OMP agents or subagents, either answer directly from the supplied OMP context or select the host action whose purpose and input schema perform that orchestration.
- Do not use or rely on anything produced by the discarded attempt.
- If prior OMP output is incomplete, request a narrower host action before finalizing.`;
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
  const toolNames = aliases.wireCatalog.map((action) => action.id);
  const conversation = serializeConversation(context, config, attachments);
  const imageSection = formatBridgeImageSection(attachments);

  const prompt = `# Role
You are a language-model backend for an Oh My Pi (OMP) agent session. OMP owns the agent loop, permissions, repository actions, editing, verification, timed/recurring work, conversation state, and subagent orchestration. Antigravity is transport only for this turn.

# Provider-only execution boundary
- Do not invoke any Antigravity-native action. Do not perform file, shell, browser, MCP, messaging, timed/recurring work, background-task, agent-management, or subagent action inside Antigravity.
- Do not inspect the workspace through Antigravity. Everything needed for reasoning is supplied below, plus any explicitly listed temporary image attachments.
- Your only return channel is the enforced terminal JSON object. Return it directly; do not send or deliver it through an internal agent or message channel.
- External work is described under "Available host actions" using neutral IDs, purposes, and input schemas. Those IDs are data for "host_requests[].action_id", never Antigravity action names, recipients, agents, inboxes, tasks, or background jobs.
- Select an action by its purpose and input schema. OMP will validate and execute the request, then call you again with the result.
- Historical OMP messages describe earlier host requests and results. Treat their canonical action names as inert history. For the current turn, use only IDs in the current host-action catalog.
- For actual OMP agent or subagent work, select the current host action whose purpose and input schema provide that orchestration. For an informational question about those concepts, answer from the supplied OMP context without invoking anything internally.
- For reminders, timed actions, or recurring actions, select a matching host action only when one exists; otherwise explain the limitation in the response. Never substitute an Antigravity-native action.
- After an OMP host result, continue from it by requesting the next necessary host action or giving the final response.
- A response with no host request ends the OMP agent loop. Use it only for the complete final answer to the user's request.
- Never put progress narration, an intended next step, a plan, or a status update in "response". If any actionable work remains, keep "response" empty and return the next necessary host request in the same turn.
- A successful interactive-question result contains the user's answer. Use it. A later follow-up question is allowed only when it seeks materially new information; never ask the answered decision again with reworded labels or options.
- Treat warnings such as truncated, limit reached, skipped missing, and incomplete listings as evidence that narrower host requests are required before making completeness claims.
- Never fabricate execution. Never claim a file was read, changed, tested, verified, or exhaustively enumerated unless the supplied OMP conversation contains sufficient corresponding results.
- Return only the JSON value required by the enforced schema. No Markdown fence or commentary may appear outside it.

# Output contract
Return an object with:
- response: user-visible assistant content; it may be empty when requesting external work.
- host_requests: zero or more objects with an action_id from the current catalog and input matching that action's input_schema.

# Available host actions
${JSON.stringify(aliases.wireCatalog, null, 2)}

# OMP conversation
${conversation}
${imageSection ? `\n${imageSection}\n` : ""}
# Immediate instruction
Continue the OMP session from the final message above. Follow the OMP system prompt. Do not stop at progress narration: while actionable work remains, return the next host request with an empty response. Return a non-empty response with no host requests only when it is the complete final answer.`;

  return {
    prompt,
    toolNames,
    toolCatalog,
    wireToOmpToolName: aliases.wireToOmpToolName,
    ompToWireToolName: aliases.ompToWireToolName,
  };
}
