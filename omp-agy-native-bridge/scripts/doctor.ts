#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { loadBridgeConfig } from "../src/config.ts";
import { runDoctor } from "../src/doctor.ts";

// runDoctor performs its own live model discovery. Do not pre-discover here:
// doing so launches two back-to-back AGY account/eligibility checks before the
// live provider smoke test and makes the diagnostic itself materially different
// from one normal bridge call.
const config = loadBridgeConfig(process.cwd());
const bundledAgent = fileURLToPath(new URL("../agents/omp-bridge-model/agent.md", import.meta.url));
const report = await runDoctor(config, process.cwd(), {
  live: process.argv.includes("--live"),
  expectedAgentPath: bundledAgent,
});
console.log(report.summary);
process.exitCode = report.ok ? 0 : 1;
