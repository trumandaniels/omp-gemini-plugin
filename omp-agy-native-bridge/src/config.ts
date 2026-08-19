import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
  maxPromptBytes: process.platform === "win32" ? 24_000 : 1_500_000,
  maxHistoryChars: 900_000,
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
  includeNonGeminiModels: false,
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
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Bridge config must be a JSON object: ${path}`);
  }
  return parsed as PartialBridgeConfig;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
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

function envEffort(name: string, fallback?: AgyEffort): AgyEffort | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (raw === "low" || raw === "medium" || raw === "high") return raw;
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
    if (!model.id || !model.name) throw new Error("Every bridge model needs id and name");
    if (seen.has(model.id)) throw new Error(`Duplicate bridge model id: ${model.id}`);
    seen.add(model.id);
    if (model.contextWindow <= 0 || model.maxTokens <= 0) {
      throw new Error(`Invalid token limits for model ${model.id}`);
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
