import { spawnSync } from "node:child_process";

import type { AgyEffort, BridgeConfig, BridgeModelDefinition } from "./types.ts";

const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const MODEL_TOKEN = /(?:^|[\s|•>*-])((?:gemini|claude|gpt-oss)[A-Za-z0-9._:/+-]*)/g;

export interface ModelDiscoveryResult {
  ok: boolean;
  models: string[];
  stdout: string;
  stderr: string;
  status: number | null;
  error?: string;
}

export function splitTieredGeminiModelId(id: string): { logicalId: string; effort: AgyEffort } | undefined {
  const match = /^(gemini-.+)-(low|medium|high)$/.exec(id);
  if (!match) return undefined;
  return {
    logicalId: match[1],
    effort: match[2] as AgyEffort,
  };
}

function collapseConfiguredModel(model: BridgeModelDefinition): BridgeModelDefinition {
  if (model.id === "auto") return { ...model };
  const parsed = splitTieredGeminiModelId(model.id);
  if (parsed && !model.agyModelIdsByEffort) {
    return {
      ...model,
      id: parsed.logicalId,
      agyModelId: undefined,
      agyModelIdsByEffort: { [parsed.effort]: model.id },
      name: model.name ?? `${parsed.logicalId} via official agy`,
    };
  }
  if (!model.agyModelIdsByEffort && !model.agyModelId) {
    return { ...model, agyModelId: model.id, name: model.name ?? `${model.id} via official agy` };
  }
  return { ...model };
}

function collapseDiscoveredModel(
  id: string,
  config: Pick<BridgeConfig, "discoveredContextWindow" | "discoveredMaxTokens">,
): BridgeModelDefinition {
  const parsed = splitTieredGeminiModelId(id);
  if (parsed) {
    return {
      id: parsed.logicalId,
      name: `${parsed.logicalId} via official agy`,
      reasoning: true,
      contextWindow: config.discoveredContextWindow,
      maxTokens: config.discoveredMaxTokens,
      agyModelIdsByEffort: { [parsed.effort]: id },
    };
  }
  return {
    id,
    name: `${id} via official agy`,
    reasoning: true,
    contextWindow: config.discoveredContextWindow,
    maxTokens: config.discoveredMaxTokens,
    agyModelId: id,
  };
}

function mergeModel(
  into: Map<string, BridgeModelDefinition>,
  candidate: BridgeModelDefinition,
): void {
  const existing = into.get(candidate.id);
  if (!existing) {
    into.set(candidate.id, { ...candidate });
    return;
  }
  existing.contextWindow = Math.max(existing.contextWindow, candidate.contextWindow);
  existing.maxTokens = Math.max(existing.maxTokens, candidate.maxTokens);
  if (existing.effort === undefined) existing.effort = candidate.effort;
  if (existing.agyModelId === undefined && candidate.agyModelId !== undefined) {
    existing.agyModelId = candidate.agyModelId;
  }
  if (candidate.agyModelIdsByEffort) {
    existing.agyModelIdsByEffort = existing.agyModelIdsByEffort || {};
    for (const [effort, route] of Object.entries(candidate.agyModelIdsByEffort)) {
      if (route && existing.agyModelIdsByEffort[effort as AgyEffort] === undefined) {
        existing.agyModelIdsByEffort[effort as AgyEffort] = route;
      }
    }
  }
  if (candidate.name && existing.name !== candidate.name) {
    existing.name = existing.name || candidate.name;
  }
}

export function parseAgyModelsOutput(stdout: string): string[] {
  const clean = stdout.replace(ANSI_ESCAPE, "");
  const found: string[] = [];
  const seen = new Set<string>();
  for (const line of clean.split(/\r?\n/)) {
    MODEL_TOKEN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MODEL_TOKEN.exec(line)) !== null) {
      const slug = match[1].replace(/[,*]$/, "");
      if (!seen.has(slug)) {
        seen.add(slug);
        found.push(slug);
      }
    }
  }
  return found;
}

export function discoverAgyModelsSync(
  config: Pick<BridgeConfig, "agyBinary">,
  cwd = process.cwd(),
  timeoutMs = 10_000,
): ModelDiscoveryResult {
  const result = spawnSync(config.agyBinary, ["models"], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
    maxBuffer: 4 * 1024 * 1024,
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      models: [],
      stdout,
      stderr,
      status: result.status,
      error: result.error?.message,
    };
  }
  return {
    ok: true,
    models: parseAgyModelsOutput(stdout),
    stdout,
    stderr,
    status: result.status,
  };
}

export function mergeDiscoveredModels(
  configured: readonly BridgeModelDefinition[],
  discovery: ModelDiscoveryResult,
  config: Pick<
    BridgeConfig,
    "includeNonGeminiModels" | "discoveredContextWindow" | "discoveredMaxTokens"
  >,
): BridgeModelDefinition[] {
  const byId = new Map<string, BridgeModelDefinition>();
  for (const model of configured) {
    mergeModel(byId, collapseConfiguredModel(model));
  }
  if (discovery.ok) {
    for (const id of discovery.models) {
      if (!config.includeNonGeminiModels && !id.toLowerCase().startsWith("gemini")) continue;
      mergeModel(byId, collapseDiscoveredModel(id, config));
    }
  }
  if (!byId.has("auto")) {
    byId.set("auto", {
      id: "auto",
      name: "Antigravity CLI (Current Default)",
      reasoning: true,
      contextWindow: config.discoveredContextWindow,
      maxTokens: config.discoveredMaxTokens,
    });
  }
  const auto = byId.get("auto")!;
  return [auto, ...[...byId.values()].filter((model) => model.id !== "auto").sort((a, b) => a.id.localeCompare(b.id))];
}
