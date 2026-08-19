import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { agentFilesMatch, globalAgentPath } from "./agent-install.ts";
import { runAgy } from "./agy/runner.ts";
import { buildAgyEnvironment } from "./env.ts";
import { providerHarnessActivitySummary } from "./harness-guard.ts";
import { discoverAgyModelsSync } from "./model-discovery.ts";
import { buildBridgeOutputSchema, parseAgyTerminalOutput } from "./schema.ts";
import type { BridgeModelDefinition, BridgeConfig } from "./types.ts";

function configuredModelSlugs(model: BridgeModelDefinition): string[] {
  if (model.id === "auto") return [];
  if (model.agyModelIdsByEffort) {
    return Object.values(model.agyModelIdsByEffort).filter((value): value is string => typeof value === "string");
  }
  if (model.agyModelId) return [model.agyModelId];
  return [model.id];
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
  env: NodeJS.ProcessEnv,
  timeoutMs = 10_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
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

async function captureListCommand(
  command: string,
  subcommand: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const json = await capture(command, [subcommand, "--output-format", "json"], cwd, env);
  if (json.code === 0) return json;
  const table = await capture(command, [subcommand], cwd, env);
  return {
    ...table,
    stderr: [json.stderr.trim(), table.stderr.trim()].filter(Boolean).join("\n"),
  };
}

export async function runDoctor(
  config: BridgeConfig,
  cwd = process.cwd(),
  options: { live?: boolean; expectedAgentPath?: string } = {},
): Promise<DoctorReport> {
  const checks: DoctorReport["checks"] = [];
  const agyEnv = buildAgyEnvironment(config.sanitizeAccountEnvironment);
  const version = await capture(config.agyBinary, ["--version"], cwd, agyEnv);
  checks.push({
    name: "agy binary",
    ok: version.code === 0,
    detail: version.code === 0 ? version.stdout.trim() || version.stderr.trim() || "available" : version.stderr.trim() || "not found",
  });

  const modelDiscovery = version.code === 0
    ? discoverAgyModelsSync(config, cwd)
    : undefined;
  const modelSlugs = modelDiscovery?.models ?? [];
  checks.push({
    name: "agy models",
    ok: modelDiscovery?.ok === true && modelSlugs.length > 0,
    detail: modelDiscovery?.ok
      ? `${modelSlugs.length} model slug(s) via ${modelDiscovery.format ?? "unknown"}: ${modelSlugs.slice(0, 8).join(", ")}${modelSlugs.length > 8 ? ", …" : ""}`
      : modelDiscovery?.stderr.trim() || modelDiscovery?.error || "skipped because agy is unavailable",
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

  const agents = version.code === 0
    ? await captureListCommand(config.agyBinary, "agents", cwd, agyEnv)
    : undefined;
  const agentListed = agents?.code === 0 && agents.stdout.includes(config.agentName);
  checks.push({
    name: "agy agent discovery",
    ok: Boolean(agentListed),
    detail: agents?.code === 0
      ? agentListed
        ? `${config.agentName} is listed by agy agents`
        : `${config.agentName} was not present in agy agents output`
      : agents?.stderr.trim() || "skipped because agy is unavailable",
  });

  if (modelDiscovery?.ok) {
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
      const safeHarness = result.toolSteps.length === 0 && result.subagents.length === 0;
      checks.push({
        name: "live provider transport",
        ok: output.text.trim() === "READY" && safeHarness,
        detail: safeHarness
          ? `structured output=${JSON.stringify(output)}`
          : `unexpected inner harness activity: ${providerHarnessActivitySummary(result)}`,
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
