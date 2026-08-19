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
import { AgyRunError, runAgy } from "./agy/runner.ts";
import {
  assertProviderHarnessIsToolless,
  retryableProviderControlToolNames,
  type ProviderHarnessGuardOptions,
} from "./harness-guard.ts";
import { hasBridgeImages, stageBridgeImages, type StagedBridgeImages } from "./media.ts";
import { bridgeModelSupportsImages } from "./model-capabilities.ts";
import { appendProviderHarnessRetryInstruction, buildProviderPrompt } from "./prompt.ts";
import { retryableRecipientOmpFailureToolNames } from "./provider-recovery.ts";
import { buildBridgeOutputSchema, parseAgyTerminalOutput } from "./schema.ts";
import { unwrapNestedBridgeOutput } from "./nested-output.ts";
import { Semaphore } from "./semaphore.ts";
import { resolveAgyModelSelection } from "./model-selection.ts";

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

function addUsage(left: Usage, right: Usage): Usage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  } as Usage;
}

function bridgeModel(config: BridgeConfig, id: string): BridgeModelDefinition | undefined {
  return config.models.find((item) => item.id === id);
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
      let stagedImages: StagedBridgeImages | undefined;
      try {
        release = await semaphore.acquire(options?.signal);
        const requestCwd = (options as SimpleStreamOptions & { cwd?: string } | undefined)?.cwd ?? cwd;
        const selected = bridgeModel(config, model.id);
        if (!selected) {
          throw new Error(`official-agy model is not registered: ${model.id}`);
        }

        if (hasBridgeImages(context)) {
          if (!config.enableImageInput) {
            throw new Error(
              "official-agy image input is disabled. Set enableImageInput=true or AGY_BRIDGE_ENABLE_IMAGES=true.",
            );
          }
          if (!bridgeModelSupportsImages(selected)) {
            throw new Error(
              `official-agy/${selected.id} is not configured for image input. Select an explicit Gemini logical model or set models[].capabilities.image=true in agy-bridge.json.`,
            );
          }
          stagedImages = await stageBridgeImages(context, requestCwd, {
            maxImageCount: config.maxImageCount,
            maxImageBytes: config.maxImageBytes,
          });
        }

        const promptResult = buildProviderPrompt(context, config, stagedImages?.attachments ?? []);
        const schema = buildBridgeOutputSchema(promptResult.toolNames);
        const resolved = resolveAgyModelSelection(
          selected,
          {
            reasoning: options?.reasoning,
            disableReasoning: options?.disableReasoning,
          },
          config.defaultEffort,
        );
        const guardOptions: ProviderHarnessGuardOptions = {
          cwd: requestCwd,
          allowedMediaPaths: stagedImages?.attachments.map((attachment) => attachment.absolutePath) ?? [],
        };
        const invoke = (prompt: string) => runAgy({
          prompt,
          cwd: requestCwd,
          binary: config.agyBinary,
          model: resolved.model,
          effort: resolved.effort,
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

        let result: Awaited<ReturnType<typeof invoke>>;
        let totalUsage = emptyUsage();
        let correctedOnce = false;

        try {
          result = await invoke(promptResult.prompt);
          totalUsage = mapUsage(result.terminal.usage as Record<string, unknown> | undefined);
        } catch (error) {
          const retryTools = config.rejectAgyToolUseInProviderMode
            ? retryableRecipientOmpFailureToolNames(error, guardOptions)
            : undefined;
          if (!retryTools) throw error;

          correctedOnce = true;
          if (error instanceof AgyRunError) {
            totalUsage = mapUsage(error.terminal?.usage as Record<string, unknown> | undefined);
          }
          const retryPrompt = appendProviderHarnessRetryInstruction(promptResult.prompt, retryTools);
          result = await invoke(retryPrompt);
          totalUsage = addUsage(
            totalUsage,
            mapUsage(result.terminal.usage as Record<string, unknown> | undefined),
          );
        }

        if (config.rejectAgyToolUseInProviderMode) {
          const retryTools = !correctedOnce && result.subagents.length === 0
            ? retryableProviderControlToolNames(result.toolSteps, guardOptions)
            : undefined;
          if (retryTools) {
            correctedOnce = true;
            const retryPrompt = appendProviderHarnessRetryInstruction(promptResult.prompt, retryTools);
            const retryResult = await invoke(retryPrompt);
            totalUsage = addUsage(
              totalUsage,
              mapUsage(retryResult.terminal.usage as Record<string, unknown> | undefined),
            );
            result = retryResult;
          }
          assertProviderHarnessIsToolless(result, config.agentName, guardOptions);
        }

        const output = unwrapNestedBridgeOutput(
          parseAgyTerminalOutput(result.terminal, promptResult.toolNames),
          promptResult.toolNames,
        );
        emitText(stream, message, output.text);
        for (const call of output.tool_calls) emitToolCall(stream, message, call);

        message.stopReason = output.tool_calls.length > 0 ? "toolUse" : "stop";
        message.usage = totalUsage;
        message.duration = performance.now() - perfStart;
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
        try {
          await stagedImages?.cleanup();
        } catch {
          // Temporary-media cleanup must never replace the provider result/error.
        }
        release?.();
      }
    })();

    return stream;
  };
}
