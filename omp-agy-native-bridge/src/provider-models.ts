import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { bridgeModelInput } from "./model-capabilities.ts";
import type { AgyEffort, BridgeModelDefinition } from "./types.ts";

type OmpProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1];
export type OmpProviderModelConfig = NonNullable<OmpProviderConfig["models"]>[number];
type OmpEffort = NonNullable<OmpProviderModelConfig["thinking"]>["efforts"][number];

const EFFORT_FALLBACK_ORDER: Record<AgyEffort, AgyEffort[]> = {
  low: ["low", "medium", "high"],
  medium: ["medium", "low", "high"],
  high: ["high", "medium", "low"],
};

function defaultTierEffort(
  routes: Partial<Record<AgyEffort, string>>,
  preferred?: AgyEffort,
): AgyEffort {
  if (preferred) {
    for (const effort of EFFORT_FALLBACK_ORDER[preferred]) {
      if (routes[effort]) return effort;
    }
  }
  if (routes.high) return "high";
  if (routes.medium) return "medium";
  return "low";
}

function thinkingConfig(
  model: BridgeModelDefinition,
  defaultEffort?: AgyEffort,
): OmpProviderModelConfig["thinking"] {
  if (!model.reasoning) return undefined;
  const routes = model.agyModelIdsByEffort;
  if (!routes) return undefined;

  const efforts: OmpEffort[] = [];
  if (routes.low) efforts.push("low" as OmpEffort);
  if (routes.medium) efforts.push("medium" as OmpEffort);
  if (routes.high) efforts.push("high" as OmpEffort);
  if (efforts.length === 0) {
    throw new Error(`agyModelIdsByEffort is empty for ${model.id}`);
  }

  // OMP's selector default must match the effort the bridge would actually
  // route when the caller supplies no explicit reasoning level. Otherwise the
  // UI can show "high" while AGY_BRIDGE_EFFORT/defaultEffort says "low".
  const defaultLevel = defaultTierEffort(routes, model.effort ?? defaultEffort) as OmpEffort;

  return {
    mode: "effort",
    efforts,
    defaultLevel,
    requiresEffort: true,
  };
}

/** Build model metadata using OMP's current extension registration contract. */
export function buildOmpProviderModels(
  models: readonly BridgeModelDefinition[],
  imageTransportEnabled: boolean,
  defaultEffort?: AgyEffort,
): OmpProviderModelConfig[] {
  return models.map((model): OmpProviderModelConfig => ({
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    thinking: thinkingConfig(model, defaultEffort),
    input: bridgeModelInput(model, imageTransportEnabled),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }));
}
