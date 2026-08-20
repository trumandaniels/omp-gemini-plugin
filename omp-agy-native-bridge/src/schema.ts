import { toolWireSchema as ompToolWireSchema } from "@oh-my-pi/pi-ai/utils/schema/wire";

import type { BridgeStructuredOutput } from "./types.ts";

export interface ToolLike {
  name: string;
  description: string;
  parameters: unknown;
}

export interface SerializedTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const MAX_NESTED_OBJECT_OUTPUT_DEPTH = 4;
const MAX_STRUCTURED_TEXT_DEPTH = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Detect a bridge-shaped object from semantic fields only.
 *
 * `finish_reason` is deliberately excluded: it is redundant transport metadata.
 * `text` and `tool_calls` are optional at the compatibility boundary because
 * empty text is normal for tool turns and an omitted/nullable tool list means
 * "no tool calls". The parser still rejects an output with no semantic content.
 */
function isBridgeEnvelope(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const hasText = Object.prototype.hasOwnProperty.call(value, "text");
  const hasToolCalls = Object.prototype.hasOwnProperty.call(value, "tool_calls");
  if (!hasText && !hasToolCalls) return false;
  return value.tool_calls === undefined || value.tool_calls === null || Array.isArray(value.tool_calls);
}

function firstBridgeEnvelope(value: unknown): Record<string, unknown> | undefined {
  if (isBridgeEnvelope(value)) return value;
  if (!Array.isArray(value)) return undefined;
  return value.find(isBridgeEnvelope);
}

function toolCallsOrEmpty(value: unknown): unknown[] | undefined {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : undefined;
}

function nestedBridgeEnvelope(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const calls = toolCallsOrEmpty(value.tool_calls);
  if (!calls || calls.length > 0) return undefined;
  return firstBridgeEnvelope(value.text);
}

function structuredTextFromContainer(value: unknown, depth = 0): string | undefined {
  if (depth > MAX_STRUCTURED_TEXT_DEPTH) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";

  if (Array.isArray(value)) {
    if (value.length === 0) return "";
    const parts: string[] = [];
    for (const item of value) {
      const part = structuredTextFromContainer(item, depth + 1);
      if (part === undefined) return undefined;
      if (part !== "") parts.push(part);
    }
    return parts.join("\n");
  }

  if (!isRecord(value)) return undefined;
  if (Object.keys(value).length === 0) return "";

  for (const key of ["text", "value", "content", "parts", "markdown"] as const) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const text = structuredTextFromContainer(value[key], depth + 1);
    if (text !== undefined) return text;
  }

  return undefined;
}

function describeStructuredTextType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (isRecord(value)) {
    const keys = Object.keys(value).slice(0, 6);
    return keys.length > 0 ? `object with keys ${keys.join(", ")}` : "empty object";
  }
  return typeof value;
}

function normalizeBridgeText(value: unknown): string {
  if (typeof value === "string") return value;

  const extracted = structuredTextFromContainer(value);
  if (extracted !== undefined) return extracted;

  // AGY occasionally places a JSON answer object/array into the schema's text
  // slot. It is safe to render that value as user-visible JSON because this path
  // never executes tools. Bridge-shaped nested objects are promoted and fully
  // validated before reaching this fallback.
  if (Array.isArray(value) || isRecord(value)) {
    try {
      const encoded = JSON.stringify(value, null, 2);
      if (encoded !== undefined) return encoded;
    } catch {
      // Fall through to the explicit validation error below.
    }
  }

  throw new Error(
    `agy structured_output.text must be text-compatible JSON; got ${describeStructuredTextType(value)}`,
  );
}

function normalizeSerializedBridgeOutput(value: string): string {
  const trimmed = value.trim();
  const wholeFence = /^(```|~~~)(?:json)?\s*([\s\S]*?)\s*\1$/i.exec(trimmed);
  if (wholeFence) return wholeFence[2].trim();

  // AGY may fence each schema-shaped response separately. Remove only the first
  // opening fence; the prefix parser below deliberately ignores everything after
  // the first complete bridge object.
  return trimmed.replace(/^(?:```|~~~)(?:json)?\s*/i, "").trimStart();
}

function firstJsonObject(value: string): unknown | undefined {
  const normalized = value.trimStart();
  if (!normalized.startsWith("{")) return undefined;

  const expectedClosers: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      expectedClosers.push("}");
      continue;
    }
    if (char === "[") {
      expectedClosers.push("]");
      continue;
    }
    if (char === "}" || char === "]") {
      if (expectedClosers.pop() !== char) return undefined;
      if (expectedClosers.length === 0) {
        try {
          return JSON.parse(normalized.slice(0, index + 1));
        } catch {
          return undefined;
        }
      }
    }
  }

  return undefined;
}

function parseSerializedBridgeOutput(
  value: string,
  allowedToolNames: readonly string[],
): BridgeStructuredOutput {
  const normalized = normalizeSerializedBridgeOutput(value);
  try {
    return parseBridgeStructuredOutput(JSON.parse(normalized), allowedToolNames);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;

    // The AGY harness can append extra schema-shaped completion messages to the
    // first provider response. Long runs can also truncate that later chatter.
    // The first complete object is the actual provider turn, so validate it and
    // ignore all later bytes rather than requiring the entire tail to be valid.
    const first = firstJsonObject(normalized);
    if (first !== undefined) return parseBridgeStructuredOutput(first, allowedToolNames);
    throw error;
  }
}

function parseResponseOrPlainText(response: string, allowedToolNames: readonly string[]): BridgeStructuredOutput {
  try {
    return parseSerializedBridgeOutput(response, allowedToolNames);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return {
      text: response,
      tool_calls: [],
      finish_reason: "stop",
    };
  }
}

export function parseAgyTerminalOutput(
  terminal: { structured_output?: unknown; response?: string },
  allowedToolNames: readonly string[],
): BridgeStructuredOutput {
  if (terminal.structured_output !== undefined && terminal.structured_output !== null) {
    try {
      return typeof terminal.structured_output === "string"
        ? parseSerializedBridgeOutput(terminal.structured_output, allowedToolNames)
        : parseBridgeStructuredOutput(terminal.structured_output, allowedToolNames);
    } catch (error) {
      // A syntactically malformed serialized structured_output has no trustworthy
      // executable semantics. If AGY also supplied its normal response channel,
      // recover from that channel instead. Semantic validation failures (for
      // example an unavailable tool name) are deliberately NOT swallowed.
      const response = terminal.response;
      if (
        typeof terminal.structured_output === "string"
        && error instanceof SyntaxError
        && typeof response === "string"
        && response.trim() !== ""
      ) {
        return parseResponseOrPlainText(response, allowedToolNames);
      }
      throw error;
    }
  }

  const response = terminal.response;
  if (typeof response !== "string" || response.trim() === "") {
    throw new Error("agy returned neither structured_output nor non-empty response text");
  }
  return parseResponseOrPlainText(response, allowedToolNames);
}

const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function sanitizeJsonValue(value: unknown, path: string, depth = 0): unknown {
  if (depth > 80) throw new Error(`${path} is too deeply nested`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeJsonValue(item, `${path}[${index}]`, depth + 1));
  }
  if (!isRecord(value)) throw new Error(`${path} contains a non-JSON value`);
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_JSON_KEYS.has(key)) throw new Error(`${path} contains forbidden key ${key}`);
    result[key] = sanitizeJsonValue(child, `${path}.${key}`, depth + 1);
  }
  return result;
}

function normalizeToolArguments(value: unknown, index: number): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  let candidate = value;
  if (typeof candidate === "string") {
    const trimmed = candidate.trim();
    if (trimmed === "") return {};
    try {
      candidate = JSON.parse(trimmed);
    } catch {
      throw new Error(`tool_calls[${index}].arguments must be an object or a JSON-encoded object`);
    }
  }
  if (!isRecord(candidate)) {
    throw new Error(`tool_calls[${index}].arguments must be an object or a JSON-encoded object`);
  }
  return sanitizeJsonValue(candidate, `tool_calls[${index}].arguments`) as Record<string, unknown>;
}

function normalizeToolCallId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  // Tool-call ids are correlation metadata, not model intent. Invalid ids are
  // omitted so provider.ts can synthesize a fresh UUID instead of failing an
  // otherwise valid tool request.
  return undefined;
}

function jsonClone(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") return undefined;
    if (item && typeof item === "object") {
      if (seen.has(item)) return "[Circular]";
      seen.add(item);
    }
    return item;
  });
  return encoded === undefined ? undefined : JSON.parse(encoded);
}

export function parameterSchema(parameters: unknown): Record<string, unknown> {
  if ((isRecord(parameters) || typeof parameters === "function") && parameters !== null) {
    const converter = (parameters as { toJsonSchema?: unknown }).toJsonSchema;
    if (typeof converter === "function") {
      for (const args of [
        [{ target: "draft-2020-12", fallback: (ctx: { base?: unknown }) => ctx.base ?? {} }],
        [{ target: "draft-07", fallback: "any" }],
        [{}],
        [],
      ] as const) {
        try {
          const convert = converter as (...values: unknown[]) => unknown;
          const converted = convert.apply(parameters, [...args]);
          const cloned = jsonClone(converted);
          if (isRecord(cloned)) return cloned;
        } catch {
          // Try the next known omptype conversion shape.
        }
      }
    }
    if (typeof parameters === "function") {
      return { type: "object", additionalProperties: true };
    }
    for (const key of ["jsonSchema", "schema", "definition"] as const) {
      const cloned = jsonClone(parameters[key]);
      if (isRecord(cloned)) return cloned;
    }
    const cloned = jsonClone(parameters);
    if (isRecord(cloned) && ("type" in cloned || "properties" in cloned || "$ref" in cloned)) {
      return cloned;
    }
  }
  return { type: "object", additionalProperties: true };
}

function hostToolParameterSchema(tool: ToolLike): Record<string, unknown> | undefined {
  try {
    const convert = ompToolWireSchema as unknown as (tool: ToolLike) => Record<string, unknown>;
    const cloned = jsonClone(convert(tool));
    return isRecord(cloned) ? cloned : undefined;
  } catch {
    // Host schema conversion is an optimization, not a loading invariant. Keep a
    // local compatibility converter as the fail-safe for older or changed OMPs.
    return undefined;
  }
}

export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 80))}\n…[truncated by omp-agy bridge]`;
}

export function serializeTools(
  tools: readonly ToolLike[],
  limits: {
    maxCatalogChars: number;
    maxDescriptionChars: number;
    maxSchemaChars: number;
  },
): SerializedTool[] {
  const out: SerializedTool[] = [];
  let used = 0;
  const priority = new Map([
    ["task", 0],
    ["read", 1],
    ["grep", 2],
    ["glob", 3],
    ["bash", 4],
    ["edit", 5],
    ["write", 6],
  ]);
  const ordered = tools
    .map((tool, index) => ({ tool, index }))
    .sort((a, b) => (priority.get(a.tool.name) ?? 100) - (priority.get(b.tool.name) ?? 100) || a.index - b.index)
    .map(({ tool }) => tool);
  for (const tool of ordered) {
    const description = truncateText(tool.description ?? "", limits.maxDescriptionChars);
    let schema = hostToolParameterSchema(tool) ?? parameterSchema(tool.parameters);
    let schemaJson = JSON.stringify(schema);
    if (schemaJson.length > limits.maxSchemaChars) {
      schema = {
        type: "object",
        additionalProperties: true,
        description: `Original schema was ${schemaJson.length} characters and was omitted by the bridge. Follow the textual tool description carefully.`,
      };
      schemaJson = JSON.stringify(schema);
    }
    const serialized: SerializedTool = { name: tool.name, description, parameters: schema };
    const size = JSON.stringify(serialized).length;
    if (used + size > limits.maxCatalogChars) {
      throw new Error(
        `OMP tool catalog exceeds maxToolCatalogChars=${limits.maxCatalogChars.toLocaleString()}. Raise the limit or reduce the active tool set; the bridge will not silently hide tools.`,
      );
    }
    out.push(serialized);
    used += size;
  }
  return out;
}

export function buildBridgeOutputSchema(toolNames: readonly string[]): Record<string, unknown> {
  const uniqueNames = [...new Set(toolNames)].sort();
  const toolCallItems: Record<string, unknown> = {
    type: "object",
    additionalProperties: true,
    properties: {
      // `id` and `arguments` are intentionally permissive at the AGY schema
      // boundary. The bridge normalizes correlation ids and fully validates /
      // sanitizes arguments before OMP sees a call. Keeping the outer schema
      // looser prevents recoverable model-wrapper representation drift from
      // becoming an upstream structured-output failure.
      id: {},
      name: uniqueNames.length > 0 ? { type: "string", enum: uniqueNames } : { type: "string" },
      arguments: {},
    },
    required: ["name"],
  };

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: true,
    properties: {
      // Parser support is intentionally wider than plain string: AGY/model
      // wrappers have returned null, content-block arrays, Gemini-style parts,
      // scalar JSON, and JSON answer objects here. None controls execution.
      text: {},
      tool_calls: uniqueNames.length > 0
        ? { type: ["array", "null"], items: toolCallItems, maxItems: 32 }
        : { type: ["array", "null"], maxItems: 0 },
      // Compatibility-only input. Different AGY releases/model wrappers have
      // produced different spellings/shapes here. The bridge never trusts it;
      // canonical completion state is derived from the validated tool calls.
      finish_reason: {},
    },
    // Presence is a semantic question handled after normalization: text-only
    // answers may omit tool_calls, and tool-only turns may omit text.
  };
}

function plainJsonAnswer(value: unknown): BridgeStructuredOutput {
  const text = normalizeBridgeText(value);
  if (text.length === 0) {
    throw new Error("agy structured_output must contain text or at least one tool call");
  }
  return {
    text,
    tool_calls: [],
    finish_reason: "stop",
  };
}

function parseBridgeStructuredOutputInternal(
  value: unknown,
  allowedToolNames: readonly string[],
  depth: number,
): BridgeStructuredOutput {
  if (depth > MAX_NESTED_OBJECT_OUTPUT_DEPTH) {
    throw new Error("agy structured_output contains too many nested bridge envelopes");
  }

  if (Array.isArray(value)) {
    const first = firstBridgeEnvelope(value);
    if (first) return parseBridgeStructuredOutputInternal(first, allowedToolNames, depth + 1);
    return plainJsonAnswer(value);
  }

  if (!isRecord(value)) {
    if (value === null || value === undefined) throw new Error("agy structured_output must contain output data");
    return plainJsonAnswer(value);
  }

  // A JSON answer object that is not bridge-shaped is harmless user-visible
  // content, not a provider protocol failure. Never infer tool execution from it.
  if (!isBridgeEnvelope(value)) return plainJsonAnswer(value);

  const nested = nestedBridgeEnvelope(value);
  if (nested) return parseBridgeStructuredOutputInternal(nested, allowedToolNames, depth + 1);

  const rawCalls = toolCallsOrEmpty(value.tool_calls);
  if (!rawCalls) throw new Error("agy structured_output.tool_calls must be an array or null when supplied");
  const text = normalizeBridgeText(value.text);
  if (rawCalls.length > 32) throw new Error("agy requested more than 32 tools in one turn");

  const allowed = new Set(allowedToolNames);
  const callIds = new Set<string>();
  const calls = rawCalls.map((item, index) => {
    if (!isRecord(item)) throw new Error(`tool_calls[${index}] must be an object`);
    if (typeof item.name !== "string" || !allowed.has(item.name)) {
      throw new Error(`tool_calls[${index}] named unavailable OMP tool: ${String(item.name)}`);
    }

    const argumentsValue = normalizeToolArguments(item.arguments, index);
    const id = normalizeToolCallId(item.id);
    if (id !== undefined) {
      if (callIds.has(id)) throw new Error(`Duplicate tool call id: ${id}`);
      callIds.add(id);
    }

    return {
      ...(id === undefined ? {} : { id }),
      name: item.name,
      arguments: argumentsValue,
    };
  });

  if (calls.length === 0 && text.length === 0) {
    throw new Error("agy structured_output must contain text or at least one tool call");
  }

  const finishReason: BridgeStructuredOutput["finish_reason"] = calls.length > 0 ? "tool_use" : "stop";
  return {
    text,
    tool_calls: calls,
    finish_reason: finishReason,
  };
}

export function parseBridgeStructuredOutput(
  value: unknown,
  allowedToolNames: readonly string[],
): BridgeStructuredOutput {
  return parseBridgeStructuredOutputInternal(value, allowedToolNames, 0);
}
