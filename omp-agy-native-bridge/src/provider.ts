import { randomUUID } from "node:crypto";

import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
  type Usage,
} from "@oh-my-pi/pi-ai";

import type { BridgeConfig, BridgeModelDefinition, BridgeStructuredOutput } from "./types.ts";
import { runAgy } from "./agy/runner.ts";
import { buildProviderPrompt } from "./prompt.ts";
import { buildBridgeOutputSchema, parseBridgeStructuredOutput } from "./schema.ts";
import { Semaphore } from "./semaphore.ts";

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  } as Usage;
}

function mapUsage(value: Record<string, unknown> | undefined): Usage {
  const rawInput = Number(value?.input_tokens ?? 0);
  const cacheRead = Number(value?.cache_read_tokens ?? 0);
  const output = Number(value?.output_tokens ?? 0);
  const total = Number(value?.total_tokens ?? rawInput + output);
  return {
    input: Math.max(0, rawInput - cacheRead),
    output: Math.max(0, output),
    cacheRead: Math.max(0, cacheRead),
    cacheWrite: 0,
    totalTokens: Math.max(0, total),
    reasoningTokens: Math.max(0, Number(value?.thinking_tokens ?? 0)),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  } as Usage;
}

function terminalOutput(
  terminal: { structured_output?: unknown; response?: string },
  toolNames: readonly string[],
): BridgeStructuredOutput {
  let value = terminal.structured_output;
  if (value === undefined && terminal.response) {
    try {
      value = JSON.parse(terminal.response);
    } catch {
      throw new Error("agy returned no structured_output and response was not JSON");
    }
  }
  return parseBridgeStructuredOutput(value, toolNames);
}

function bridgeModel(config: BridgeConfig, id: string): BridgeModelDefinition | undefined {
  return config.models.find((item) => item.id === id);
}

function modelSlug(id: string): string | undefined {
  return id === "auto" ? undefined : id;
}

function emitText(stream: AssistantMessageEventStream, message: AssistantMessage, text: string): void {
  if (text === "") return;
  const block = { type: "text" as const, text };
  message.content.push(block);
  const contentIndex = message.content.length - 1;
  stream.push({ type: "text_start", contentIndex, partial: message });
  stream.push({ type: "text_delta", contentIndex, delta: text, partial: message });
  stream.push({ type: "text_end", contentIndex, content: text, partial: message });
}

function emitToolCall(
  stream: AssistantMessageEventStream,
  message: AssistantMessage,
  call: BridgeStructuredOutput["tool_calls"][number],
): void {
  const toolCall: ToolCall = {
    type: "toolCall",
    id: call.id?.trim() || `agy-${randomUUID()}`,
    name: call.name,
    arguments: call.arguments,
  };
  message.content.push(toolCall);
  const contentIndex = message.content.length - 1;
  stream.push({ type: "toolcall_start", contentIndex, partial: message });
  stream.push({
    type: "toolcall_delta",
    contentIndex,
    delta: JSON.stringify(toolCall.arguments),
    partial: message,
  });
  stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function createAgyProviderStream(
  config: BridgeConfig,
  semaphore: Semaphore,
  cwd = process.cwd(),
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const startedAt = Date.now();
    const perfStart = performance.now();
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: startedAt,
    };
    stream.push({ type: "start", partial: message });

    void (async () => {
      let release: (() => void) | undefined;
      try {
        release = await semaphore.acquire(options?.signal);
        const requestCwd = (options as SimpleStreamOptions & { cwd?: string } | undefined)?.cwd ?? cwd;
        const promptResult = buildProviderPrompt(context, config);
        const schema = buildBridgeOutputSchema(promptResult.toolNames);
        const selected = bridgeModel(config, model.id);

        const result = await runAgy({
          prompt: promptResult.prompt,
          cwd: requestCwd,
          binary: config.agyBinary,
          model: modelSlug(model.id),
          effort: selected?.effort ?? (model.id === "auto" ? config.defaultEffort : undefined),
          agent: config.agentName,
          printTimeout: config.printTimeout,
          hardTimeoutMs: config.hardTimeoutMs,
          sandbox: config.sandbox,
          maxPromptBytes: config.maxPromptBytes,
          maxStderrBytes: config.maxStderrBytes,
          killGraceMs: config.killGraceMs,
          sanitizeAccountEnvironment: config.sanitizeAccountEnvironment,
          schema,
          signal: options?.signal,
        });

        if (config.rejectAgyToolUseInProviderMode && (result.toolSteps.length > 0 || result.subagents.length > 0)) {
          throw new Error(
            `Provider-mode agy unexpectedly used its own harness (${result.toolSteps.length} tool step(s), ${result.subagents.length} subagent(s)). Reinstall the tool-less ${config.agentName} custom agent and retry.`,
          );
        }

        const output = terminalOutput(result.terminal, promptResult.toolNames);
        emitText(stream, message, output.text);
        for (const call of output.tool_calls) emitToolCall(stream, message, call);

        message.stopReason = output.tool_calls.length > 0 ? "toolUse" : "stop";
        message.usage = mapUsage(result.terminal.usage as Record<string, unknown> | undefined);
        message.duration = result.terminal.duration_seconds !== undefined
          ? result.terminal.duration_seconds * 1_000
          : performance.now() - perfStart;
        stream.push({
          type: "done",
          reason: message.stopReason as "stop" | "toolUse",
          message,
        });
      } catch (error) {
        const aborted = Boolean(options?.signal?.aborted);
        message.stopReason = aborted ? "aborted" : "error";
        message.errorMessage = errorMessage(error);
        message.duration = performance.now() - perfStart;
        stream.push({
          type: "error",
          reason: aborted ? "aborted" : "error",
          error: message,
        });
      } finally {
        release?.();
      }
    })();

    return stream;
  };
}
