#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["pack", "--dry-run", "--json"], {
  cwd: process.cwd(),
  encoding: "utf8",
  shell: false,
  windowsHide: true,
  maxBuffer: 16 * 1024 * 1024,
});

if (result.error) {
  throw new Error(`Could not run npm pack: ${result.error.message}`);
}
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch (error) {
  throw new Error(
    `npm pack did not return JSON: ${error instanceof Error ? error.message : String(error)}\n${result.stdout.slice(0, 2_000)}`,
  );
}

if (!Array.isArray(report) || report.length !== 1 || !Array.isArray(report[0]?.files)) {
  throw new Error("npm pack returned an unexpected report shape");
}

const entry = report[0];
const paths = entry.files.map((file) => String(file.path));
const forbidden = paths.filter((path) => {
  const normalized = path.replaceAll("\\", "/");
  return normalized.includes(":Zone.Identifier")
    || normalized.startsWith(".tmp-pi/")
    || normalized.startsWith("node_modules/")
    || normalized.startsWith("coverage/")
    || normalized.startsWith("dist/")
    || normalized.startsWith("test/");
});
if (forbidden.length > 0) {
  throw new Error(`Package contains forbidden development/metadata files:\n${forbidden.join("\n")}`);
}

for (const required of [
  "package.json",
  "src/index.ts",
  "agents/omp-bridge-model/agent.md",
  "README.md",
  "LICENSE",
]) {
  if (!paths.includes(required)) throw new Error(`Package is missing required file: ${required}`);
}

const extensionPath = report[0]?.files?.find((file) => file.path === "src/index.ts");
if (!extensionPath || Number(extensionPath.size) <= 0) {
  throw new Error("Packaged OMP extension entrypoint is empty or missing");
}

console.log(
  `Package check passed: ${paths.length} files, ${Number(entry.unpackedSize ?? 0).toLocaleString()} unpacked bytes.`,
);
