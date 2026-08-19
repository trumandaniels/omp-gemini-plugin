import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { bridgeModelInput } from "./model-capabilities.ts";
import type { BridgeModelDefinition } from "./types.ts";

type OmpProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1];
export type OmpProviderModelConfig = NonNullable<OmpProviderConfig["models"]>[number];
type OmpEffort = NonNullable<OmpProviderModelConfig["thinking"]>["efforts"][number];

function thinkingConfig(model: BridgeModelDefinition): OmpProviderModelConfig["thinking"] {
  const routes = model.agyModelIdsByEffort;
  if (!routes) return undefined;

  const efforts: OmpEffort[] = [];
  if (routes.low) efforts.push("low" as OmpEffort);
  if (routes.medium) efforts.push("medium" as OmpEffort);
  if (routes.high) efforts.push("high" as OmpEffort);
  if (efforts.length === 0) {
    throw new Error(`agyModelIdsByEffort is empty for ${model.id}`);
  }

  const defaultLevel: OmpEffort = routes.high
    ? ("high" as OmpEffort)
    : routes.medium
      ? ("medium" as OmpEffort)
      : ("low" as OmpEffort);

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
): OmpProviderModelConfig[] {
  return models.map((model): OmpProviderModelConfig => ({
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    thinking: thinkingConfig(model),
    input: bridgeModelInput(model, imageTransportEnabled),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }));
}
