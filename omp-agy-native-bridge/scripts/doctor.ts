#!/usr/bin/env node
import { loadBridgeConfig } from "../src/config.ts";
import { discoverAgyModelsSync, mergeDiscoveredModels } from "../src/model-discovery.ts";
import { runDoctor } from "../src/doctor.ts";

const baseConfig = loadBridgeConfig(process.cwd());
const discovery = baseConfig.discoverModels
  ? discoverAgyModelsSync(baseConfig, process.cwd())
  : { ok: false, models: [], stdout: "", stderr: "model discovery disabled", status: null };
const config = {
  ...baseConfig,
  models: mergeDiscoveredModels(baseConfig.models, discovery, baseConfig),
};
const report = await runDoctor(config, process.cwd(), { live: process.argv.includes("--live") });
console.log(report.summary);
process.exitCode = report.ok ? 0 : 1;
