import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { agentFilesMatch, globalAgentPath } from "./agent-install.ts";
import { runAgy } from "./agy/runner.ts";
import { buildAgyEnvironment } from "./env.ts";
import {
  providerHarnessActivitySummary,
  providerHarnessSnapshotsComplete,
} from "./harness-guard.ts";
import { discoverAgyModelsSync } from "./model-discovery.ts";
import { buildBridgeOutputSchema, parseAgyTerminalOutput } from "./schema.ts";
import type { BridgeModelDefinition, BridgeConfig } from "./types.ts";

const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const PORTABLE_AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AGENT_NAME_FIELDS = new Set(["name", "id", "agent", "agentName", "agent_name", "slug"]);
const AGENT_LIST_FIELDS = new Set([
  "agents",
  "items",
  "data",
  "result",
  "customAgents",
  "custom_agents",
]);

function configuredModelSlugs(model: BridgeModelDefinition): string[] {
  if (model.id === "auto") return [];
  if (model.agyModelIdsByEffort) {
    return Object.values(model.agyModelIdsByEffort).filter((value): value is string => typeof value === "string");
  }
  if (model.agyModelId) return [model.agyModelId];
  return [model.id];
}

function addAgentName(found: string[], seen: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  const name = value.trim();
  if (!PORTABLE_AGENT_NAME.test(name) || seen.has(name)) return;
  seen.add(name);
  found.push(name);
}

function collectJsonAgentNames(value: unknown, found: string[], seen: Set<string>, depth = 0): void {
  if (depth > 16 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonAgentNames(item, found, seen, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // Support both an array of agent objects and a map keyed by agent name.
    // Only object-valued, non-metadata keys can be interpreted as map keys;
    // otherwise fields such as `name` or `description` would become false agents.
    if (
      !AGENT_NAME_FIELDS.has(key)
      && !AGENT_LIST_FIELDS.has(key)
      && PORTABLE_AGENT_NAME.test(key)
      && child !== null
      && typeof child === "object"
    ) {
      addAgentName(found, seen, key);
    }
    if (AGENT_NAME_FIELDS.has(key)) {
      addAgentName(found, seen, child);
    }
    if (AGENT_LIST_FIELDS.has(key)) {
      collectJsonAgentNames(child, found, seen, depth + 1);
    }
  }
}

export function parseAgyAgentsOutput(stdout: string): string[] {
  const clean = stdout.replace(ANSI_ESCAPE, "").trim();
  const found: string[] = [];
  const seen = new Set<string>();

  if (clean.startsWith("{") || clean.startsWith("[")) {
    try {
      collectJsonAgentNames(JSON.parse(clean), found, seen);
      if (found.length > 0) return found;
    } catch {
      // Fall through to the human-readable table parser.
    }
  }

  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine
      .trim()
      .replace(/^[|>*•-]+\s*/, "");
    if (!line) continue;
    // Agent tables put the name in the first column. Split on a table separator,
    // tab, or a run of at least two spaces so names in descriptions do not count.
    const firstColumn = line.split(/\s{2,}|\t|\|/, 1)[0]?.trim() ?? "";
    const firstToken = firstColumn.split(/\s+/, 1)[0] ?? "";
    addAgentName(found, seen, firstToken.replace(/[,*:]$/, ""));
  }
  return found;
}

export interface DoctorReport {
  ok: boolean;
  summary: string;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

async function capture(
  command: string,
  args: string[],
  cwd: string,
  sanitizeEnvironment: boolean,
  timeoutMs = 10_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: buildAgyEnvironment(sanitizeEnvironment),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value: { code: number | null; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs} ms`.trim() });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => finish({ code: null, stdout, stderr: error.message }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}

async function captureAgents(
  config: Pick<BridgeConfig, "agyBinary" | "sanitizeAccountEnvironment">,
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string; names: string[] }> {
  const machine = await capture(
    config.agyBinary,
    ["agents", "--output-format", "json"],
    cwd,
    config.sanitizeAccountEnvironment,
  );
  const machineNames = machine.code === 0 ? parseAgyAgentsOutput(machine.stdout) : [];
  if (machineNames.length > 0) return { ...machine, names: machineNames };

  const plain = await capture(
    config.agyBinary,
    ["agents"],
    cwd,
    config.sanitizeAccountEnvironment,
  );
  return {
    ...plain,
    stderr: [machine.stderr.trim(), plain.stderr.trim()].filter(Boolean).join("\n"),
    names: plain.code === 0 ? parseAgyAgentsOutput(plain.stdout) : [],
  };
}

export async function runDoctor(
  config: BridgeConfig,
  cwd = process.cwd(),
  options: { live?: boolean; expectedAgentPath?: string } = {},
): Promise<DoctorReport> {
  const checks: DoctorReport["checks"] = [];
  const version = await capture(
    config.agyBinary,
    ["--version"],
    cwd,
    config.sanitizeAccountEnvironment,
  );
  checks.push({
    name: "agy binary",
    ok: version.code === 0,
    detail: version.code === 0 ? version.stdout.trim() || version.stderr.trim() || "available" : version.stderr.trim() || "not found",
  });

  const models = version.code === 0 ? discoverAgyModelsSync(config, cwd) : undefined;
  const modelSlugs = models?.ok ? models.models : [];
  checks.push({
    name: "agy models",
    ok: Boolean(models?.ok && modelSlugs.length > 0),
    detail: models?.ok
      ? `${modelSlugs.length} model slug(s): ${modelSlugs.slice(0, 8).join(", ")}${modelSlugs.length > 8 ? ", …" : ""}`
      : models?.stderr.trim() || models?.error || "skipped because agy is unavailable",
  });

  const agentPath = globalAgentPath(config.agentName);
  const agentPresent = existsSync(agentPath);
  checks.push({
    name: "tool-less bridge agent file",
    ok: agentPresent,
    detail: agentPath,
  });

  let agentCurrent: boolean | undefined;
  if (options.expectedAgentPath) {
    agentCurrent = agentPresent && await agentFilesMatch(options.expectedAgentPath, agentPath);
    checks.push({
      name: "tool-less bridge agent contents",
      ok: agentCurrent,
      detail: agentCurrent
        ? "installed agent matches the bundled isolated definition"
        : "installed agent is stale or customized; run /agy-install-agent (or npm run install-agent -- --force), then fully restart OMP",
    });
  }

  const agents = version.code === 0 ? await captureAgents(config, cwd) : undefined;
  const agentListed = Boolean(agents?.code === 0 && agents.names.includes(config.agentName));
  checks.push({
    name: "agy agent discovery",
    ok: agentListed,
    detail: agents?.code === 0
      ? agentListed
        ? `${config.agentName} is listed by agy agents`
        : `${config.agentName} was not present in the parsed agy agents list${agents.names.length > 0 ? ` (${agents.names.join(", ")})` : ""}`
      : agents?.stderr.trim() || "skipped because agy is unavailable",
  });

  if (models?.ok) {
    const listed = new Set(modelSlugs);
    const configured = new Set(
      config.models
        .flatMap(configuredModelSlugs)
        .filter((model) => model.length > 0),
    );
    const stale = [...configured].filter((slug) => !listed.has(slug));
    checks.push({
      name: "configured model catalog",
      ok: stale.length === 0,
      detail: stale.length === 0 ? "all exact configured model slugs are currently listed" : `stale/unavailable: ${stale.join(", ")}`,
    });
  }

  if (options.live && version.code === 0 && agentListed && agentCurrent !== false) {
    try {
      const result = await runAgy({
        prompt:
          'Return exactly this structured response: {"text":"READY","tool_calls":[],"finish_reason":"stop"}. Do not use tools.',
        cwd,
        binary: config.agyBinary,
        agent: config.agentName,
        printTimeout: "2m",
        hardTimeoutMs: 150_000,
        sandbox: config.sandbox,
        maxPromptBytes: config.maxPromptBytes,
        maxStderrBytes: config.maxStderrBytes,
        killGraceMs: config.killGraceMs,
        sanitizeAccountEnvironment: config.sanitizeAccountEnvironment,
        schema: buildBridgeOutputSchema([]),
      });
      const output = parseAgyTerminalOutput(result.terminal, []);
      const safeHarness = providerHarnessSnapshotsComplete(result)
        && (result.toolStepCount ?? result.toolSteps.length) === 0
        && (result.subagentCount ?? result.subagents.length) === 0;
      checks.push({
        name: "live provider transport",
        ok: output.text.trim() === "READY" && safeHarness,
        detail: safeHarness
          ? `structured output=${JSON.stringify(output)}`
          : `unexpected or incompletely captured inner harness activity: ${providerHarnessActivitySummary(result)}`,
      });
    } catch (error) {
      checks.push({
        name: "live provider transport",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const ok = checks.every((check) => check.ok);
  const lines = checks.map((check) => `${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  return { ok, checks, summary: lines.join("\n") };
}
