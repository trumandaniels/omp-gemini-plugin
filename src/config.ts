import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { assertSafeAgentName } from "./agent-name.ts";
import type { AgyEffort, BridgeConfig, BridgeModelDefinition } from "./types.ts";

export const DEFAULT_MODELS: BridgeModelDefinition[] = [
  {
    id: "auto",
    name: "Antigravity CLI (Current Default)",
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  },
];

export const DEFAULT_CONFIG: BridgeConfig = {
  providerId: "official-agy",
  apiId: "official-agy-cli-v1",
  agyBinary: "agy",
  agentName: "omp-bridge-model",
  defaultEffort: undefined,
  printTimeout: "15m",
  hardTimeoutMs: 16 * 60 * 1_000,
  sandbox: true,
  maxConcurrent: 3,
  // Provider prompts are written to the child's stdin, not argv, so the old
  // native-Windows command-line ceiling no longer applies to this payload.
  maxPromptBytes: 1_500_000,
  maxHistoryChars: 240_000,
  maxToolCatalogChars: 180_000,
  maxToolDescriptionChars: 4_000,
  maxToolSchemaChars: 24_000,
  maxStderrBytes: 65_536,
  killGraceMs: 2_000,
  sanitizeAccountEnvironment: true,
  rejectAgyToolUseInProviderMode: true,
  enableDelegateTool: true,
  enableImageInput: true,
  maxImageCount: 20,
  maxImageBytes: 50 * 1024 * 1024,
  discoverModels: true,
  includeNonGeminiModels: true,
  discoveredContextWindow: 1_000_000,
  discoveredMaxTokens: 64_000,
  models: DEFAULT_MODELS,
};

type PartialBridgeConfig = Partial<Omit<BridgeConfig, "models">> & {
  models?: BridgeModelDefinition[];
};

function readJson(path: string): PartialBridgeConfig | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse bridge config ${path}: ${detail}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Bridge config must be a JSON object: ${path}`);
  }
  return parsed as PartialBridgeConfig;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be true/false or 1/0`);
}

function envInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function isAgyEffort(value: unknown): value is AgyEffort {
  return value === "low" || value === "medium" || value === "high";
}

function envEffort(name: string, fallback?: AgyEffort): AgyEffort | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const normalized = raw.trim();
  if (isAgyEffort(normalized)) return normalized;
  throw new Error(`${name} must be low, medium, high, or empty`);
}

function mergeConfig(base: BridgeConfig, overlay?: PartialBridgeConfig): BridgeConfig {
  if (!overlay) return base;
  return {
    ...base,
    ...overlay,
    models: overlay.models ?? base.models,
  };
}

export function loadBridgeConfig(cwd = process.cwd()): BridgeConfig {
  const userPath = join(homedir(), ".omp", "agent", "agy-bridge.json");
  const projectPath = resolve(cwd, ".omp", "agy-bridge.json");

  let config = mergeConfig({ ...DEFAULT_CONFIG, models: [...DEFAULT_MODELS] }, readJson(userPath));
  config = mergeConfig(config, readJson(projectPath));

  config = {
    ...config,
    agyBinary: process.env.AGY_BRIDGE_BIN ?? config.agyBinary,
    agentName: process.env.AGY_BRIDGE_AGENT ?? config.agentName,
    printTimeout: process.env.AGY_BRIDGE_PRINT_TIMEOUT ?? config.printTimeout,
    defaultEffort: envEffort("AGY_BRIDGE_EFFORT", config.defaultEffort),
    sandbox: envBoolean("AGY_BRIDGE_SANDBOX", config.sandbox),
    sanitizeAccountEnvironment: envBoolean(
      "AGY_BRIDGE_SANITIZE_ACCOUNT_ENV",
      config.sanitizeAccountEnvironment,
    ),
    rejectAgyToolUseInProviderMode: envBoolean(
      "AGY_BRIDGE_REJECT_AGY_TOOLS",
      config.rejectAgyToolUseInProviderMode,
    ),
    enableDelegateTool: envBoolean("AGY_BRIDGE_ENABLE_DELEGATE", config.enableDelegateTool),
    enableImageInput: envBoolean("AGY_BRIDGE_ENABLE_IMAGES", config.enableImageInput),
    discoverModels: envBoolean("AGY_BRIDGE_DISCOVER_MODELS", config.discoverModels),
    includeNonGeminiModels: envBoolean(
      "AGY_BRIDGE_INCLUDE_NON_GEMINI",
      config.includeNonGeminiModels,
    ),
    maxConcurrent: envInteger("AGY_BRIDGE_MAX_CONCURRENT", config.maxConcurrent),
    maxPromptBytes: envInteger("AGY_BRIDGE_MAX_PROMPT_BYTES", config.maxPromptBytes),
    maxImageCount: envInteger("AGY_BRIDGE_MAX_IMAGES", config.maxImageCount),
    maxImageBytes: envInteger("AGY_BRIDGE_MAX_IMAGE_BYTES", config.maxImageBytes),
    hardTimeoutMs: envInteger("AGY_BRIDGE_HARD_TIMEOUT_MS", config.hardTimeoutMs),
    discoveredContextWindow: envInteger(
      "AGY_BRIDGE_DISCOVERED_CONTEXT_WINDOW",
      config.discoveredContextWindow,
    ),
    discoveredMaxTokens: envInteger(
      "AGY_BRIDGE_DISCOVERED_MAX_TOKENS",
      config.discoveredMaxTokens,
    ),
  };

  validateBridgeConfig(config);
  return config;
}

export function validateBridgeConfig(config: BridgeConfig): void {
  const nonEmpty = [
    ["providerId", config.providerId],
    ["apiId", config.apiId],
    ["agyBinary", config.agyBinary],
    ["agentName", config.agentName],
    ["printTimeout", config.printTimeout],
  ] as const;
  for (const [name, value] of nonEmpty) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`Bridge config ${name} must be a non-empty string`);
    }
  }
  assertSafeAgentName(config.agentName);

  for (const key of [
    "sandbox",
    "sanitizeAccountEnvironment",
    "rejectAgyToolUseInProviderMode",
    "enableDelegateTool",
    "enableImageInput",
    "discoverModels",
    "includeNonGeminiModels",
  ] as const) {
    if (typeof config[key] !== "boolean") {
      throw new Error(`Bridge config ${key} must be boolean`);
    }
  }

  if (config.defaultEffort !== undefined && !isAgyEffort(config.defaultEffort)) {
    throw new Error("Bridge config defaultEffort must be low, medium, high, or omitted");
  }

  for (const key of [
    "hardTimeoutMs",
    "maxConcurrent",
    "maxPromptBytes",
    "maxHistoryChars",
    "maxToolCatalogChars",
    "maxToolDescriptionChars",
    "maxToolSchemaChars",
    "maxStderrBytes",
    "killGraceMs",
    "maxImageCount",
    "maxImageBytes",
    "discoveredContextWindow",
    "discoveredMaxTokens",
  ] as const) {
    const value = config[key];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Bridge config ${key} must be a positive integer`);
    }
  }

  if (!Array.isArray(config.models) || config.models.length === 0) {
    throw new Error("Bridge config models must contain at least one static model");
  }
  const seen = new Set<string>();
  for (const model of config.models) {
    if (!model || typeof model !== "object" || Array.isArray(model)) {
      throw new Error("Every bridge model must be an object");
    }
    if (typeof model.id !== "string" || model.id.trim() === "") {
      throw new Error("Every bridge model needs a non-empty id");
    }
    if (typeof model.name !== "string" || model.name.trim() === "") {
      throw new Error(`Bridge model ${model.id} needs a non-empty name`);
    }
    if (seen.has(model.id)) throw new Error(`Duplicate bridge model id: ${model.id}`);
    seen.add(model.id);
    if (typeof model.reasoning !== "boolean") {
      throw new Error(`Model ${model.id} reasoning must be boolean`);
    }
    if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) {
      throw new Error(`Invalid contextWindow for model ${model.id}`);
    }
    if (!Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0) {
      throw new Error(`Invalid maxTokens for model ${model.id}`);
    }
    if (model.effort !== undefined && !isAgyEffort(model.effort)) {
      throw new Error(`Model ${model.id} effort must be low, medium, high, or omitted`);
    }
    if (!model.reasoning && model.effort !== undefined) {
      throw new Error(`Model ${model.id} cannot define effort when reasoning=false`);
    }
    if (model.agyModelId !== undefined && (typeof model.agyModelId !== "string" || model.agyModelId.trim() === "")) {
      throw new Error(`Model ${model.id} agyModelId must be a non-empty string when supplied`);
    }
    if (model.agyModelIdsByEffort !== undefined) {
      if (!model.reasoning) {
        throw new Error(`Model ${model.id} cannot define agyModelIdsByEffort when reasoning=false`);
      }
      if (!model.agyModelIdsByEffort || typeof model.agyModelIdsByEffort !== "object" || Array.isArray(model.agyModelIdsByEffort)) {
        throw new Error(`Model ${model.id} agyModelIdsByEffort must be an object when supplied`);
      }
      if (model.agyModelId !== undefined) {
        throw new Error(`Model ${model.id} cannot define both agyModelId and agyModelIdsByEffort`);
      }
      const routes = Object.entries(model.agyModelIdsByEffort);
      if (routes.length === 0) {
        throw new Error(`Model ${model.id} agyModelIdsByEffort must contain at least one route`);
      }
      for (const [effort, route] of routes) {
        if (!isAgyEffort(effort)) {
          throw new Error(`Model ${model.id} has unsupported effort route: ${effort}`);
        }
        if (typeof route !== "string" || route.trim() === "") {
          throw new Error(`Model ${model.id} route ${effort} must be a non-empty string`);
        }
      }
    }
    if (model.supportsImages !== undefined && typeof model.supportsImages !== "boolean") {
      throw new Error(`Model ${model.id} supportsImages must be boolean when supplied`);
    }
    if (model.capabilities !== undefined) {
      if (!model.capabilities || typeof model.capabilities !== "object" || Array.isArray(model.capabilities)) {
        throw new Error(`Model ${model.id} capabilities must be an object when supplied`);
      }
      for (const key of ["image", "vision"] as const) {
        const value = model.capabilities[key];
        if (value !== undefined && typeof value !== "boolean") {
          throw new Error(`Model ${model.id} capabilities.${key} must be boolean when supplied`);
        }
      }
    }
  }
}
