import type { BridgeModelDefinition } from "./types.ts";

export type BridgeModelInput = Array<"text" | "image">;

function isGeminiModelId(value: string | undefined): boolean {
  return typeof value === "string" && value.toLowerCase().startsWith("gemini-");
}

/** Resolve whether one logical bridge model should be exposed to OMP as vision-capable. */
export function bridgeModelSupportsImages(model: BridgeModelDefinition): boolean {
  if (typeof model.supportsImages === "boolean") return model.supportsImages;

  const capabilities = model.capabilities;
  if (capabilities && (capabilities.image !== undefined || capabilities.vision !== undefined)) {
    return capabilities.image === true || capabilities.vision === true;
  }

  // `agy models` currently exposes slugs/names, not structured capability metadata.
  // Gemini logical families are multimodal; `auto` remains conservative because its
  // actual account-selected model is unknown at provider registration time.
  if (model.id === "auto") return false;
  if (isGeminiModelId(model.id) || isGeminiModelId(model.agyModelId)) return true;
  return Object.values(model.agyModelIdsByEffort ?? {}).some(isGeminiModelId);
}

/** Produce the exact OMP model-input metadata used by provider registration. */
export function bridgeModelInput(model: BridgeModelDefinition, imageTransportEnabled: boolean): BridgeModelInput {
  return imageTransportEnabled && bridgeModelSupportsImages(model)
    ? ["text", "image"]
    : ["text"];
}
