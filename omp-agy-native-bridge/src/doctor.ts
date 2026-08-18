import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { globalAgentPath } from "./agent-install.ts";
import { runAgy } from "./agy/runner.ts";
import { parseAgyModelsOutput } from "./model-discovery.ts";
import { buildBridgeOutputSchema, parseBridgeStructuredOutput } from "./schema.ts";
import type { BridgeConfig } from "./types.ts";

export interface DoctorReport {
  ok: boolean;
  summary: string;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

async function capture(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 10_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
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

export async function runDoctor(
  config: BridgeConfig,
  cwd = process.cwd(),
  options: { live?: boolean } = {},
): Promise<DoctorReport> {
  const checks: DoctorReport["checks"] = [];
  const version = await capture(config.agyBinary, ["--version"], cwd);
  checks.push({
    name: "agy binary",
    ok: version.code === 0,
    detail: version.code === 0 ? version.stdout.trim() || version.stderr.trim() || "available" : version.stderr.trim() || "not found",
  });

  const models = version.code === 0 ? await capture(config.agyBinary, ["models"], cwd) : undefined;
  const modelSlugs = models?.code === 0 ? parseAgyModelsOutput(models.stdout) : [];
  checks.push({
    name: "agy models",
    ok: models?.code === 0 && modelSlugs.length > 0,
    detail: models?.code === 0
      ? `${modelSlugs.length} model slug(s): ${modelSlugs.slice(0, 8).join(", ")}${modelSlugs.length > 8 ? ", …" : ""}`
      : models?.stderr.trim() || "skipped because agy is unavailable",
  });

  const agentPath = globalAgentPath(config.agentName);
  checks.push({
    name: "tool-less bridge agent file",
    ok: existsSync(agentPath),
    detail: agentPath,
  });

  const agents = version.code === 0 ? await capture(config.agyBinary, ["agents"], cwd) : undefined;
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

  if (models?.code === 0) {
    const listed = new Set(modelSlugs);
    const stale = config.models
      .filter((model) => model.id !== "auto" && !listed.has(model.id))
      .map((model) => model.id);
    checks.push({
      name: "configured model catalog",
      ok: stale.length === 0,
      detail: stale.length === 0 ? "all exact configured model slugs are currently listed" : `stale/unavailable: ${stale.join(", ")}`,
    });
  }

  if (options.live && version.code === 0 && agentListed) {
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
      const output = parseBridgeStructuredOutput(result.terminal.structured_output, []);
      const safeHarness = result.toolSteps.length === 0 && result.subagents.length === 0;
      checks.push({
        name: "live provider transport",
        ok: output.text.trim() === "READY" && safeHarness,
        detail: safeHarness
          ? `structured output=${JSON.stringify(output)}`
          : `unexpected inner tools=${result.toolSteps.length}, subagents=${result.subagents.length}`,
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
