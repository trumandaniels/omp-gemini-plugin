#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const roots = [join(root, "src"), join(root, "scripts"), join(root, "test")];
const files = [];

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (entry.endsWith(".ts")) files.push(full);
  }
}

for (const directory of roots) walk(directory);
const scratch = mkdtempSync(join(tmpdir(), "omp-agy-source-check-"));
let failed = false;
try {
  for (const [index, file] of files.sort().entries()) {
    const source = readFileSync(file, "utf8");
    let javascript;
    try {
      javascript = stripTypeScriptTypes(source, { mode: "strip", sourceMap: false });
    } catch (error) {
      console.error(`TypeScript strip failed for ${file}:`, error);
      failed = true;
      continue;
    }
    const target = join(scratch, `${String(index).padStart(3, "0")}-${basename(file, ".ts")}.mjs`);
    writeFileSync(target, javascript, "utf8");
    const result = spawnSync(process.execPath, ["--check", target], {
      stdio: "inherit",
      shell: false,
    });
    if (result.status !== 0) {
      console.error(`Syntax check failed for ${file}`);
      failed = true;
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log(`Syntax checked ${files.length} TypeScript files.`);
