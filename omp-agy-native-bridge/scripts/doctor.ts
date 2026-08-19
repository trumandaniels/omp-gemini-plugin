#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { loadBridgeConfig } from "../src/config.ts";
import { runDoctor } from "../src/doctor.ts";

// runDoctor owns model discovery. Pre-discovering here launches a second AGY
// account/eligibility check immediately before the live transport check, which
// can amplify transient bootstrap failures and makes the diagnostic unlike a
// normal provider startup.
const config = loadBridgeConfig(process.cwd());
const bundledAgent = fileURLToPath(new URL("../agents/omp-bridge-model/agent.md", import.meta.url));
const report = await runDoctor(config, process.cwd(), {
  live: process.argv.includes("--live"),
  expectedAgentPath: bundledAgent,
});
console.log(report.summary);
process.exitCode = report.ok ? 0 : 1;
