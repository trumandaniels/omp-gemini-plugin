import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function globalAgentPath(agentName = "omp-bridge-model"): string {
  return join(homedir(), ".gemini", "config", "agents", agentName, "agent.md");
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
    if (existing === source) return destination;
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
