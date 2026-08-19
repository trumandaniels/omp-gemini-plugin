import { spawnSync, type SpawnSyncReturns } from "node:child_process";

import { buildAgyEnvironment } from "./env.ts";
import type { AgyEffort, BridgeConfig, BridgeModelDefinition } from "./types.ts";

const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const MODEL_TOKEN = /(?:^|[\s|•>*-])((?:gemini|claude|gpt-oss)[A-Za-z0-9._:/+-]*)/g;
const MODEL_SLUG = /^(?:gemini|claude|gpt-oss)[A-Za-z0-9._:/+-]*$/i;

export interface ModelDiscoveryResult {
  ok: boolean;
  models: string[];
  stdout: string;
  stderr: string;
  status: number | null;
  error?: string;
  format?: "json" | "table";
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

function addModelSlug(value: unknown, found: string[], seen: Set<string>): void {
  if (typeof value !== "string") return;
  const slug = value.trim().replace(/[,*]$/, "");
  if (!MODEL_SLUG.test(slug) || seen.has(slug)) return;
  seen.add(slug);
  found.push(slug);
}

/** Parse the machine-readable shapes emitted by current and older AGY builds. */
export function parseAgyModelsJson(stdout: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return [];
  }

  const found: string[] = [];
  const seenSlugs = new Set<string>();
  const seenObjects = new WeakSet<object>();
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 12) return;
    if (typeof value === "string") {
      addModelSlug(value, found, seenSlugs);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);

    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }

    const record = value as Record<string, unknown>;
    for (const key of ["id", "model", "model_id", "modelId", "slug", "name"] as const) {
      addModelSlug(record[key], found, seenSlugs);
    }
    for (const [key, child] of Object.entries(record)) {
      addModelSlug(key, found, seenSlugs);
      visit(child, depth + 1);
    }
  };
  visit(parsed);
  return found;
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

type DiscoveryConfig = Pick<BridgeConfig, "agyBinary"> & Partial<Pick<BridgeConfig, "sanitizeAccountEnvironment">>;

function runModelsCommand(
  config: DiscoveryConfig,
  args: string[],
  cwd: string,
  timeoutMs: number,
  baseEnv: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  return spawnSync(config.agyBinary, args, {
    cwd,
    env: buildAgyEnvironment(config.sanitizeAccountEnvironment ?? true, baseEnv),
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
    maxBuffer: 4 * 1024 * 1024,
  });
}

export function discoverAgyModelsSync(
  config: DiscoveryConfig,
  cwd = process.cwd(),
  timeoutMs = 10_000,
  baseEnv: NodeJS.ProcessEnv = process.env,
): ModelDiscoveryResult {
  // AGY 1.1.12+ documents machine-readable output for `models`. Prefer it,
  // while retaining the table parser for older installed binaries.
  const jsonResult = runModelsCommand(
    config,
    ["models", "--output-format", "json"],
    cwd,
    timeoutMs,
    baseEnv,
  );
  const jsonStdout = jsonResult.stdout || "";
  const jsonStderr = jsonResult.stderr || "";
  if (!jsonResult.error && jsonResult.status === 0) {
    const models = parseAgyModelsJson(jsonStdout);
    if (models.length > 0) {
      return {
        ok: true,
        models,
        stdout: jsonStdout,
        stderr: jsonStderr,
        status: jsonResult.status,
        format: "json",
      };
    }
  }

  const tableResult = runModelsCommand(config, ["models"], cwd, timeoutMs, baseEnv);
  const stdout = tableResult.stdout || "";
  const tableStderr = tableResult.stderr || "";
  const stderr = [jsonStderr.trim(), tableStderr.trim()].filter(Boolean).join("\n");
  if (tableResult.error || tableResult.status !== 0) {
    return {
      ok: false,
      models: [],
      stdout,
      stderr,
      status: tableResult.status,
      error: tableResult.error?.message ?? jsonResult.error?.message,
      format: "table",
    };
  }
  return {
    ok: true,
    models: parseAgyModelsOutput(stdout),
    stdout,
    stderr,
    status: tableResult.status,
    format: "table",
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
