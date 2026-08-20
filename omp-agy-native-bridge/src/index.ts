import { fileURLToPath } from "node:url";

import type { Api } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { installAgentFile } from "./agent-install.ts";
import { loadBridgeConfig } from "./config.ts";
import { discoverAgyModelsSync, mergeDiscoveredModels } from "./model-discovery.ts";
import { registerAgyDelegateTool } from "./delegate-tool.ts";
import { runDoctor } from "./doctor.ts";
import { buildOmpProviderModels } from "./provider-models.ts";
import { createAgyProviderStream } from "./provider.ts";
import { Semaphore } from "./semaphore.ts";

export default function officialAgyBridge(pi: ExtensionAPI): void {
  // Resolve and validate everything before mutating OMP's provider registry.
  const baseConfig = loadBridgeConfig(process.cwd());
  const discovery = baseConfig.discoverModels
    ? discoverAgyModelsSync(baseConfig, process.cwd())
    : { ok: false, models: [], stdout: "", stderr: "model discovery disabled", status: null };
  const config = {
    ...baseConfig,
    models: mergeDiscoveredModels(baseConfig.models, discovery, baseConfig),
  };
  const semaphore = new Semaphore(config.maxConcurrent);
  const providerModels = buildOmpProviderModels(
    config.models,
    config.enableImageInput,
    config.defaultEffort,
  );
  const streamSimple = createAgyProviderStream(config, semaphore, process.cwd());
  const bundledAgent = fileURLToPath(new URL("../agents/omp-bridge-model/agent.md", import.meta.url));

  if (config.enableDelegateTool) {
    registerAgyDelegateTool(pi, config, semaphore);
  }

  pi.registerCommand("agy-doctor", {
    description: "Check the official agy binary, model list, and bridge custom agent.",
    handler: async (_args, ctx) => {
      const report = await runDoctor(config, ctx.cwd, { expectedAgentPath: bundledAgent });
      ctx.ui.notify(report.summary, report.ok ? "info" : "error");
    },
  });

  pi.registerCommand("agy-install-agent", {
    description: "Install or update the global tool-less Antigravity agent used by provider mode.",
    handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm(
        "Install Antigravity bridge agent",
        `Write ${config.agentName} into ~/.gemini/config/agents? Existing contents will be replaced after confirmation.`,
      );
      if (!confirmed) return;
      const destination = await installAgentFile(bundledAgent, config.agentName, true);
      ctx.ui.notify(`Installed ${destination}. Restart agy/OMP before provider use.`, "info");
    },
  });

  // Keep this registration last. A thrown initialization error before this line
  // must not leave a half-configured provider behind in affected OMP versions.
  pi.registerProvider(config.providerId, {
    baseUrl: "http://127.0.0.1/official-agy-cli",
    apiKey: "agy-local-official-cli",
    api: config.apiId as Api,
    streamSimple,
    models: providerModels,
  });
}
