import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { assertSafeAgentName } from "./agent-name.ts";

const PROVIDER_HOOK_NAME = "omp-agy-provider-boundary";

export function globalAgentPath(agentName = "omp-bridge-model"): string {
  assertSafeAgentName(agentName);
  return join(homedir(), ".gemini", "config", "agents", agentName, "agent.md");
}

export function globalProviderHookScriptPath(): string {
  return join(homedir(), ".gemini", "config", "omp-agy-native-bridge", "provider-safety-hook.cjs");
}

export function globalHooksPath(): string {
  return join(homedir(), ".gemini", "config", "hooks.json");
}

export function agentDefinitionsMatch(expected: string, actual: string): boolean {
  const normalize = (value: string) => value.replace(/\r\n/g, "\n").trimEnd();
  return normalize(expected) === normalize(actual);
}

export async function agentFilesMatch(expectedPath: string, actualPath: string): Promise<boolean> {
  if (!existsSync(expectedPath) || !existsSync(actualPath)) return false;
  const [expected, actual] = await Promise.all([
    readFile(expectedPath, "utf8"),
    readFile(actualPath, "utf8"),
  ]);
  return agentDefinitionsMatch(expected, actual);
}

function providerHookDefinition(scriptPath: string): Record<string, unknown> {
  return {
    PreToolUse: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: `node "${scriptPath}"`,
            timeout: 5,
          },
        ],
      },
    ],
  };
}

async function readHooksConfig(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Antigravity hooks config must contain a JSON object: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const mode = existsSync(path) ? (await stat(path)).mode : 0o600;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export interface ProviderSafetyHookStatus {
  scriptPath: string;
  hooksPath: string;
  scriptCurrent: boolean;
  registrationCurrent: boolean;
}

export async function providerSafetyHookStatus(sourcePath: string): Promise<ProviderSafetyHookStatus> {
  const scriptPath = globalProviderHookScriptPath();
  const hooksPath = globalHooksPath();
  const scriptCurrent = await agentFilesMatch(sourcePath, scriptPath);
  let registrationCurrent = false;
  try {
    const hooks = await readHooksConfig(hooksPath);
    registrationCurrent = JSON.stringify(hooks[PROVIDER_HOOK_NAME])
      === JSON.stringify(providerHookDefinition(scriptPath));
  } catch {
    // Doctor reports the stale registration without mutating an invalid user file.
  }
  return { scriptPath, hooksPath, scriptCurrent, registrationCurrent };
}

export async function installProviderSafetyHook(sourcePath: string, force = false): Promise<ProviderSafetyHookStatus> {
  const scriptPath = globalProviderHookScriptPath();
  await mkdir(dirname(scriptPath), { recursive: true });
  if (existsSync(scriptPath) && !force && !await agentFilesMatch(sourcePath, scriptPath)) {
    throw new Error(`Provider safety hook already exists with different contents: ${scriptPath}. Re-run with --force after reviewing it.`);
  }
  const content = await readFile(sourcePath, "utf8");
  await writeFile(scriptPath, content, { encoding: "utf8", mode: 0o700 });

  const hooksPath = globalHooksPath();
  const hooks = await readHooksConfig(hooksPath);
  const expected = providerHookDefinition(scriptPath);
  if (
    hooks[PROVIDER_HOOK_NAME] !== undefined
    && !force
    && JSON.stringify(hooks[PROVIDER_HOOK_NAME]) !== JSON.stringify(expected)
  ) {
    throw new Error(`Provider hook registration already exists with different contents: ${hooksPath}. Re-run with --force after reviewing it.`);
  }
  hooks[PROVIDER_HOOK_NAME] = expected;
  await writeJsonAtomic(hooksPath, hooks);
  return { scriptPath, hooksPath, scriptCurrent: true, registrationCurrent: true };
}

export async function installAgentFile(
  sourcePath: string,
  agentName = "omp-bridge-model",
  force = false,
): Promise<string> {
  const destination = globalAgentPath(agentName);
  await mkdir(dirname(destination), { recursive: true });
  if (existsSync(destination) && !force) {
    const [existing, source] = await Promise.all([
      readFile(destination, "utf8"),
      readFile(sourcePath, "utf8"),
    ]);
    if (agentDefinitionsMatch(source, existing)) return destination;
    throw new Error(`Agent already exists with different contents: ${destination}. Re-run with --force after reviewing it.`);
  }
  if (force) {
    const content = await readFile(sourcePath, "utf8");
    await writeFile(destination, content, "utf8");
  } else {
    await copyFile(sourcePath, destination);
  }
  return destination;
}
