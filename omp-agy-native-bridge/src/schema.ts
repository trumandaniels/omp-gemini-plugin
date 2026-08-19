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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

export function parseAgyTerminalOutput(
  terminal: { structured_output?: unknown; response?: string },
  allowedToolNames: readonly string[],
): BridgeStructuredOutput {
  if (terminal.structured_output !== undefined && terminal.structured_output !== null) {
    return typeof terminal.structured_output === "string"
      ? parseSerializedBridgeOutput(terminal.structured_output, allowedToolNames)
      : parseBridgeStructuredOutput(terminal.structured_output, allowedToolNames);
  }

  const response = terminal.response;
  if (typeof response !== "string" || response.trim() === "") {
    throw new Error("agy returned neither structured_output nor non-empty response text");
  }

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
    let schema = parameterSchema(tool.parameters);
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
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      name: uniqueNames.length > 0 ? { type: "string", enum: uniqueNames } : { type: "string" },
      arguments: { type: "object" },
    },
    required: ["name", "arguments"],
  };

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      text: { type: "string" },
      tool_calls: uniqueNames.length > 0
        ? { type: "array", items: toolCallItems, maxItems: 32 }
        : { type: "array", maxItems: 0 },
      finish_reason: {
        type: "string",
        enum: uniqueNames.length > 0 ? ["stop", "tool_use"] : ["stop"],
      },
    },
    required: ["text", "tool_calls", "finish_reason"],
  };
}

export function parseBridgeStructuredOutput(
  value: unknown,
  allowedToolNames: readonly string[],
): BridgeStructuredOutput {
  if (!isRecord(value)) throw new Error("agy structured_output must be an object");
  if (typeof value.text !== "string") throw new Error("agy structured_output.text must be a string");
  if (!Array.isArray(value.tool_calls)) throw new Error("agy structured_output.tool_calls must be an array");
  if (value.finish_reason !== "stop" && value.finish_reason !== "tool_use") {
    throw new Error("agy structured_output.finish_reason must be stop or tool_use");
  }
  if (value.tool_calls.length > 32) throw new Error("agy requested more than 32 tools in one turn");

  const allowed = new Set(allowedToolNames);
  const callIds = new Set<string>();
  const calls = value.tool_calls.map((item, index) => {
    if (!isRecord(item)) throw new Error(`tool_calls[${index}] must be an object`);
    if (typeof item.name !== "string" || !allowed.has(item.name)) {
      throw new Error(`tool_calls[${index}] named unavailable OMP tool: ${String(item.name)}`);
    }
    if (!isRecord(item.arguments)) {
      throw new Error(`tool_calls[${index}].arguments must be an object`);
    }
    if (item.id !== undefined && (typeof item.id !== "string" || item.id.trim() === "")) {
      throw new Error(`tool_calls[${index}].id must be a non-empty string when supplied`);
    }
    if (typeof item.id === "string") {
      if (callIds.has(item.id)) throw new Error(`Duplicate tool call id: ${item.id}`);
      callIds.add(item.id);
    }
    return {
      ...(typeof item.id === "string" ? { id: item.id } : {}),
      name: item.name,
      arguments: sanitizeJsonValue(item.arguments, `tool_calls[${index}].arguments`) as Record<string, unknown>,
    };
  });

  if (calls.length > 0 && value.finish_reason !== "tool_use") {
    throw new Error("finish_reason must be tool_use when tool_calls is non-empty");
  }
  if (calls.length === 0 && value.finish_reason !== "stop") {
    throw new Error("finish_reason must be stop when tool_calls is empty");
  }
  if (calls.length === 0 && value.text.length === 0) {
    throw new Error("agy structured_output must contain text or at least one tool call");
  }

  return {
    text: value.text,
    tool_calls: calls,
    finish_reason: value.finish_reason,
  };
}
