import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { runAgy } from "./agy/runner.ts";
import { Semaphore } from "./semaphore.ts";
import type { AgyEffort, AgyStreamEvent, BridgeConfig } from "./types.ts";

interface DelegateParams {
  prompt: string;
  model?: string;
  effort?: AgyEffort;
  agent?: string;
  conversation_id?: string;
  sandbox?: boolean;
}

function short(value: string | undefined, max = 240): string {
  if (!value) return "";
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
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
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", minLength: 1, description: "Complete standalone task for Antigravity." },
        model: { type: "string", description: "Optional exact slug from `agy models`." },
        effort: { type: "string", enum: ["low", "medium", "high"] },
        agent: { type: "string", description: "Optional Antigravity agent. Leave empty for the normal tool-capable agent." },
        conversation_id: { type: "string", description: "Optional prior agy conversation to resume." },
        sandbox: { type: "boolean", description: "Whether to add --sandbox. Defaults to bridge config." },
      },
      required: ["prompt"],
    },
    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as DelegateParams;
      const release = await semaphore.acquire(signal);
      const toolEvents: Array<Record<string, unknown>> = [];
      const subagents: Array<Record<string, unknown>> = [];
      let streamedText = "";

      const update = (text: string, details: Record<string, unknown>) => {
        onUpdate?.({ content: [{ type: "text", text }], details });
      };

      const onEvent = (event: AgyStreamEvent) => {
        if (event.event === "init") {
          update(
            `Antigravity started${event.init.model ? ` with ${event.init.model}` : ""}.`,
            { phase: "init", conversationId: event.conversation_id, init: event.init },
          );
          return;
        }
        if (event.event !== "step_update") return;
        const step = event.step_update;
        if (step.step_type === "agent_response" && step.text_delta) {
          streamedText += step.text_delta;
          update(short(streamedText, 2_000), { phase: "response", state: step.state });
        }
        if (step.step_type === "tool") {
          const detail = {
            name: step.tool_info?.name ?? step.tool_name,
            parameters: step.tool_info?.parameters,
            output: short(step.tool_info?.output, 1_000),
            error: step.tool_info?.error,
          };
          toolEvents.push(detail);
          update(`Antigravity tool: ${String(detail.name ?? "unknown")}`, { phase: "tool", ...detail });
        }
        for (const agent of step.subagent_info?.subagents ?? []) {
          subagents.push(agent as Record<string, unknown>);
          update(`Antigravity subagent: ${agent.role ?? agent.type_name ?? "unknown"}`, {
            phase: "subagent",
            ...agent,
          });
        }
      };

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
          onEvent,
        });

        return {
          content: [{ type: "text", text: result.terminal.response ?? "Antigravity completed without response text." }],
          details: {
            conversationId: result.terminal.conversation_id,
            status: result.terminal.status,
            durationSeconds: result.terminal.duration_seconds,
            usage: result.terminal.usage,
            tools: toolEvents,
            subagents,
            stderr: result.stderr || undefined,
          },
        };
      } finally {
        release();
      }
    },
  });
}
