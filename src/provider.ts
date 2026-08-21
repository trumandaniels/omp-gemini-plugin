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
import { hasBridgeImages, stageBridgeImages, type StagedBridgeImages } from "./media.ts";
import { bridgeModelSupportsImages } from "./model-capabilities.ts";
import { buildProviderPrompt } from "./prompt.ts";
import { runProviderAttempts } from "./provider-attempt.ts";
import { buildBridgeOutputSchema, parseAgyTerminalOutput } from "./schema.ts";
import { unwrapNestedBridgeOutput } from "./nested-output.ts";
import { Semaphore } from "./semaphore.ts";
import { resolveAgyModelSelection } from "./model-selection.ts";
import { restoreOmpToolNames } from "./tool-alias.ts";
import {
  appendToolChoiceInstruction,
  assertBridgeToolChoiceSatisfied,
  resolveBridgeToolChoice,
} from "./tool-choice.ts";
import { addUsage, mapAgyUsage } from "./usage.ts";

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

const EMPTY_OUTPUT_ERROR = /(?:returned neither structured_output nor non-empty response text|structured_output must contain output data|structured_output must contain text or at least one tool call)/i;

function mayAcceptEmptyOutput(
  error: unknown,
  terminal: { structured_output?: unknown; response?: string },
): boolean {
  if (error instanceof Error && EMPTY_OUTPUT_ERROR.test(error.message)) return true;
  return error instanceof SyntaxError
    && typeof terminal.structured_output === "string"
    && terminal.structured_output.trim() === ""
    && (typeof terminal.response !== "string" || terminal.response.trim() === "");
}

function parseProviderOutput(
  terminal: { structured_output?: unknown; response?: string },
  toolNames: readonly string[],
  acceptEmpty: boolean,
): BridgeStructuredOutput {
  try {
    return unwrapNestedBridgeOutput(
      parseAgyTerminalOutput(terminal, toolNames),
      toolNames,
    );
  } catch (error) {
    if (!acceptEmpty || !mayAcceptEmptyOutput(error, terminal)) throw error;
    return { text: "", tool_calls: [], finish_reason: "stop" };
  }
}

/**
 * `acceptEmptyResponse` is present in newer OMP SimpleStreamOptions but did not
 * exist in OMP 17.2.12. Read it through a structural compatibility extension so
 * one bridge build typechecks against both host generations while preserving the
 * newer runtime behavior when the field is supplied.
 */
function acceptsEmptyResponse(options?: SimpleStreamOptions): boolean {
  const compat = options as (SimpleStreamOptions & { acceptEmptyResponse?: boolean }) | undefined;
  return compat?.acceptEmptyResponse === true;
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
        const requestCwd = options?.cwd ?? cwd;
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
          stagedImages = await stageBridgeImages(context, {
            maxImageCount: config.maxImageCount,
            maxImageBytes: config.maxImageBytes,
          });
        }

        // OMP's toolChoice is a host-level semantic constraint. AGY has no
        // native concept of OMP actions, so enforce it by narrowing the catalog,
        // assigning neutral wire IDs, and validating restored OMP calls.
        const toolChoice = resolveBridgeToolChoice(context.tools ?? [], options?.toolChoice);
        const promptResult = buildProviderPrompt(
          { ...context, tools: toolChoice.tools },
          config,
          stagedImages?.attachments ?? [],
        );
        const schema = buildBridgeOutputSchema(promptResult.toolNames);
        const requiredWireName = toolChoice.requiredToolName
          ? promptResult.ompToWireToolName[toolChoice.requiredToolName]
          : undefined;
        if (toolChoice.requiredToolName && !requiredWireName) {
          throw new Error(`OMP tool choice was not assigned a provider alias: ${toolChoice.requiredToolName}`);
        }
        const initialPrompt = appendToolChoiceInstruction(promptResult.prompt, {
          requireToolCall: toolChoice.requireToolCall,
          requiredToolName: requiredWireName,
        });
        const resolved = resolveAgyModelSelection(
          selected,
          {
            reasoning: options?.reasoning,
            disableReasoning: options?.disableReasoning,
          },
          config.defaultEffort,
        );

        const outcome = await runProviderAttempts({
          initialPrompt,
          enforceToolless: config.rejectAgyToolUseInProviderMode,
          agentName: config.agentName,
          ompTools: promptResult.toolCatalog,
          recipientAliases: promptResult.wireToOmpToolName,
          guardOptions: {
            cwd: requestCwd,
            allowedMediaPaths: stagedImages?.attachments.map((attachment) => attachment.absolutePath) ?? [],
          },
          invoke: (prompt) => runAgy({
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
            additionalWorkspaceDirectories: stagedImages?.workspaceDirectory
              ? [stagedImages.workspaceDirectory]
              : [],
            providerBoundary: {
              allowedMediaPaths: stagedImages?.attachments.map((attachment) => attachment.absolutePath) ?? [],
            },
            schema,
            signal: options?.signal,
          }),
        });
        const result = outcome.result;

        let totalUsage = mapAgyUsage(result.terminal.usage);
        for (const discarded of outcome.discardedUsage) {
          totalUsage = addUsage(mapAgyUsage(discarded), totalUsage);
        }

        const wireOutput = parseProviderOutput(
          result.terminal,
          promptResult.toolNames,
          acceptsEmptyResponse(options) && !toolChoice.requireToolCall,
        );
        const output = restoreOmpToolNames(wireOutput, promptResult.wireToOmpToolName);
        assertBridgeToolChoiceSatisfied(output, toolChoice);
        emitText(stream, message, output.text);
        for (const call of output.tool_calls) emitToolCall(stream, message, call);

        const stopReason: "stop" | "toolUse" = output.tool_calls.length > 0 ? "toolUse" : "stop";
        message.stopReason = stopReason;
        message.usage = totalUsage;
        message.duration = performance.now() - perfStart;
        stream.push({
          type: "done",
          reason: stopReason,
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
