import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { runAgy } from "./agy/runner.ts";
import { DelegateProgressCollector } from "./delegate-progress.ts";
import { Semaphore } from "./semaphore.ts";
import type { AgyEffort, BridgeConfig } from "./types.ts";

interface DelegateParams {
  prompt: string;
  model?: string;
  effort?: AgyEffort;
  agent?: string;
  conversation_id?: string;
  sandbox?: boolean;
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
        const result = await runAgy({
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
        const summary = progress.summary();

        return {
          content: [{ type: "text", text: result.terminal.response ?? "Antigravity completed without response text." }],
          details: {
            conversationId: result.terminal.conversation_id,
            status: result.terminal.status,
            durationSeconds: result.terminal.duration_seconds,
            usage: result.terminal.usage,
            tools: summary.tools,
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
