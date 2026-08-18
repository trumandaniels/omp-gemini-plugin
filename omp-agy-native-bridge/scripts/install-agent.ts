#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { installAgentFile } from "../src/agent-install.ts";

const force = process.argv.includes("--force");
const source = fileURLToPath(new URL("../agents/omp-bridge-model/agent.md", import.meta.url));
const destination = await installAgentFile(source, "omp-bridge-model", force);
console.log(`Installed Antigravity bridge agent: ${destination}`);
