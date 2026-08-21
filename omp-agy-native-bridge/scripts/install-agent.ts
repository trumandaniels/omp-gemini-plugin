#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { installAgentFile, installProviderSafetyHook } from "../src/agent-install.ts";

const force = process.argv.includes("--force");
const source = fileURLToPath(new URL("../agents/omp-bridge-model/agent.md", import.meta.url));
const hookSource = fileURLToPath(new URL("../agents/omp-bridge-model/provider-safety-hook.cjs", import.meta.url));
const destination = await installAgentFile(source, "omp-bridge-model", force);
const hook = await installProviderSafetyHook(hookSource, force);
console.log(`Installed Antigravity bridge agent: ${destination}`);
console.log(`Installed provider safety hook: ${hook.scriptPath}`);
console.log(`Registered provider safety hook: ${hook.hooksPath}`);
