import { spawnSync } from "node:child_process";

import { buildAgyEnvironment } from "./env.ts";
import type { AgyEffort, BridgeConfig, BridgeModelDefinition } from "./types.ts";

const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const MODEL_TOKEN = /(?:^|[\s|•>*-])((?:gemini|claude|gpt-oss)[A-Za-z0-9._:/+-]*)/g;
const MODEL_ID = /^(?:gemini|claude|gpt-oss)[A-Za-z0-9._:/+-]*$/;

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

function addModelId(found: string[], seen: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  const id = value.trim().replace(/[,*]$/, "");
  if (!MODEL_ID.test(id) || seen.has(id)) return;
  seen.add(id);
  found.push(id);
}

function collectJsonModelIds(value: unknown, found: string[], seen: Set<string>, depth = 0): void {
  if (depth > 16 || value === null || value === undefined) return;
  if (typeof value === "string") {
    addModelId(found, seen, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectJsonModelIds(item, found, seen, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // Some AGY versions return a map keyed by model slug; others return an
    // array of objects with id/model/slug fields. Support both without treating
    // arbitrary descriptive strings as model identifiers.
    addModelId(found, seen, key);
    if (["id", "model", "modelId", "model_id", "slug", "name"].includes(key)) {
      addModelId(found, seen, child);
    }
    if (["models", "items", "data", "availableModels", "available_models", "result"].includes(key)) {
      collectJsonModelIds(child, found, seen, depth + 1);
    }
  }
}

export function parseAgyModelsOutput(stdout: string): string[] {
  const clean = stdout.replace(ANSI_ESCAPE, "").trim();
  const found: string[] = [];
  const seen = new Set<string>();

  if (clean.startsWith("{") || clean.startsWith("[")) {
    try {
      collectJsonModelIds(JSON.parse(clean), found, seen);
      if (found.length > 0) return found;
    } catch {
      // Fall back to the stable table parser for older/mixed CLI output.
    }
  }

  for (const line of clean.split(/\r?\n/)) {
    MODEL_TOKEN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MODEL_TOKEN.exec(line)) !== null) {
      addModelId(found, seen, match[1]);
    }
  }
  return found;
}

interface DiscoveryCommandResult {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: string;
}

function runModelsCommand(
  config: Pick<BridgeConfig, "agyBinary"> & Partial<Pick<BridgeConfig, "sanitizeAccountEnvironment">>,
  args: string[],
  cwd: string,
  timeoutMs: number,
): DiscoveryCommandResult {
  const result = spawnSync(config.agyBinary, args, {
    cwd,
    env: buildAgyEnvironment(config.sanitizeAccountEnvironment ?? true),
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
    error: result.error?.message,
  };
}

export function discoverAgyModelsSync(
  config: Pick<BridgeConfig, "agyBinary"> & Partial<Pick<BridgeConfig, "sanitizeAccountEnvironment">>,
  cwd = process.cwd(),
  timeoutMs = 30_000,
): ModelDiscoveryResult {
  // Prefer the long-standing human-readable command. Current AGY builds in the
  // wild can reject `models --output-format json` even when nearby releases
  // advertise it. The table parser is deterministic for model slugs and this
  // path avoids launching a second eligibility/account-bootstrap process on
  // the common case.
  const plain = runModelsCommand(config, ["models"], cwd, timeoutMs);
  if (plain.status !== 0 || plain.error) {
    // An alternate output format cannot repair an authentication, TLS,
    // entitlement, timeout, or process-start failure. Preserve the first
    // operational error and do not immediately hammer the same AGY bootstrap
    // path with another process.
    return {
      ok: false,
      models: [],
      ...plain,
    };
  }

  const plainModels = parseAgyModelsOutput(plain.stdout);
  if (plainModels.length > 0) {
    return { ok: true, models: plainModels, ...plain };
  }

  // Keep machine-readable discovery only as a parser/format compatibility
  // fallback when the plain command itself succeeded but yielded no recognized
  // model slugs.
  const machine = runModelsCommand(config, ["models", "--output-format", "json"], cwd, timeoutMs);
  const machineModels = machine.status === 0 && !machine.error
    ? parseAgyModelsOutput(machine.stdout)
    : [];
  if (machineModels.length > 0) {
    return { ok: true, models: machineModels, ...machine };
  }

  const diagnostics = [plain.stderr.trim(), machine.stderr.trim()].filter(Boolean).join("\n");
  return {
    ok: false,
    models: [],
    stdout: machine.stdout || plain.stdout,
    stderr: diagnostics,
    status: machine.status ?? plain.status,
    error:
      machine.error
      ?? plain.error
      ?? (machine.status === 0 && plain.status === 0 ? "agy models returned no recognized model slugs" : undefined),
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
