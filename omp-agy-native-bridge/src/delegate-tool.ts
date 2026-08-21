import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { AgyRunError, runAgy } from "./agy/runner.ts";
import { DelegateProgressCollector } from "./delegate-progress.ts";
import { Semaphore } from "./semaphore.ts";
import type { AgyEffort, AgyRunOptions, AgyRunResult, BridgeConfig } from "./types.ts";

interface DelegateParams {
  prompt: string;
  model?: string;
  effort?: AgyEffort;
  agent?: string;
  conversation_id?: string;
  sandbox?: boolean;
}

const INVALID_TASK_ID_FAILURE = /^invalid task ID format:\s*"([^"\r\n]+)"\.?$/i;
const DELEGATE_TASK_ID_INSTRUCTION = `# Antigravity task-ID safety
If you use manage_task, first list the current tasks and pass only exact TaskId values returned by manage_task in this conversation. Never invent a task ID or use a placeholder such as "dummy".`;

interface DelegateRunOutcome {
  result: AgyRunResult;
  recoveredInvalidTaskId?: string;
}

function invalidTaskIdRecovery(
  error: unknown,
): { conversationId: string; invalidTaskId: string } | undefined {
  if (!(error instanceof AgyRunError)) return undefined;
  if (error.terminal?.status !== "ERROR") return undefined;
  const diagnostic = error.terminal.error;
  if (typeof diagnostic !== "string") return undefined;
  const match = INVALID_TASK_ID_FAILURE.exec(diagnostic.trim());
  if (!match) return undefined;
  const conversationId = error.terminal.conversation_id?.trim();
  if (!conversationId) return undefined;
  return { conversationId, invalidTaskId: match[1] };
}

function taskIdRecoveryPrompt(invalidTaskId: string): string {
  return `# Mandatory task-ID correction
The previous manage_task call was rejected because ${JSON.stringify(invalidTaskId)} is not a real task ID.
- Continue from the current conversation state; do not replay work already completed.
- Call manage_task with Action "list" before any status, kill, or send_input action.
- Use only an exact TaskId returned by that list. Never invent or substitute a placeholder task ID.`;
}

/**
 * Run one delegated AGY conversation. A model-generated placeholder task ID can
 * terminate AGY before it can self-correct, so resume that exact conversation
 * once with an explicit correction. Never replay the original delegated task.
 */
export async function runAgyDelegate(
  options: AgyRunOptions,
  invoke: (runOptions: AgyRunOptions) => Promise<AgyRunResult> = runAgy,
): Promise<DelegateRunOutcome> {
  try {
    return {
      result: await invoke({
        ...options,
        prompt: `${options.prompt}\n\n${DELEGATE_TASK_ID_INSTRUCTION}`,
      }),
    };
  } catch (error) {
    const recovery = invalidTaskIdRecovery(error);
    if (!recovery) throw error;
    return {
      result: await invoke({
        ...options,
        prompt: taskIdRecoveryPrompt(recovery.invalidTaskId),
        conversationId: recovery.conversationId,
      }),
      recoveredInvalidTaskId: recovery.invalidTaskId,
    };
  }
}

export function registerAgyDelegateTool(
  pi: ExtensionAPI,
  config: BridgeConfig,
  semaphore: Semaphore,
): void {
  pi.registerTool({
    name: "agy_delegate",
    label: "Official Antigravity Delegate",
    description:
      "Delegate a bounded task to the official agy CLI. Unlike the official-agy model provider, this nested agent may use Antigravity's own tools and subagents. Use for self-contained research, code review, or implementation tasks whose result can be returned to OMP as text. Do not use when OMP must own every edit or tool call. Independently verify consequential claims with OMP tools.",
    loadMode: "essential",
    approval: "exec",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", minLength: 1, description: "Complete standalone task for Antigravity." },
        model: { type: "string", minLength: 1, description: "Optional exact slug from `agy models`." },
        effort: { type: "string", enum: ["low", "medium", "high"] },
        agent: { type: "string", minLength: 1, description: "Optional Antigravity agent. Omit for the normal tool-capable agent." },
        conversation_id: { type: "string", minLength: 1, description: "Optional prior agy conversation to resume." },
        sandbox: { type: "boolean", description: "Whether to add --sandbox. Defaults to bridge config." },
      },
      required: ["prompt"],
    },
    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as DelegateParams;
      const release = await semaphore.acquire(signal);
      const progress = new DelegateProgressCollector();

      try {

        const outcome = await runAgyDelegate({
          prompt: params.prompt,
          cwd: ctx.cwd,
          binary: config.agyBinary,
          model: params.model,
          effort: params.effort,
          agent: params.agent,
          conversationId: params.conversation_id,
          printTimeout: config.printTimeout,
          hardTimeoutMs: config.hardTimeoutMs,
          sandbox: params.sandbox ?? config.sandbox,
          maxPromptBytes: config.maxPromptBytes,
          maxStderrBytes: config.maxStderrBytes,
          killGraceMs: config.killGraceMs,
          sanitizeAccountEnvironment: config.sanitizeAccountEnvironment,
          signal,
          onEvent: (event) => {
            for (const update of progress.ingest(event)) {
              onUpdate?.({ content: [{ type: "text", text: update.text }], details: update.details });
            }
          },
        });
        const result = outcome.result;
        const summary = progress.summary();

        return {
          content: [{ type: "text", text: result.terminal.response ?? "Antigravity completed without response text." }],
          details: {
            conversationId: result.terminal.conversation_id,
            status: result.terminal.status,
            durationSeconds: result.terminal.duration_seconds,
            usage: result.terminal.usage,
            tools: summary.tools,
            recoveredInvalidTaskId: outcome.recoveredInvalidTaskId,
            subagents: summary.subagents,
            progress: {
              ...summary.progress,
              observedToolLifecycleUpdates: result.toolStepCount ?? result.toolSteps.length,
              observedSubagentUpdates: result.subagentCount ?? result.subagents.length,
            },
            stderr: result.stderr || undefined,
          },
        };
      } finally {
        release();
      }
    },
  });
}
