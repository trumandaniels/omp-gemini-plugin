import type { AgyEffort, BridgeModelDefinition } from "./types.ts";

export interface ResolvedAgyModelSelection {
  /** Exact slug for `agy --model`; undefined means AGY auto/default model. */
  model?: string;
  /** Optional value for `agy --effort`; omit when the exact slug already encodes the tier. */
  effort?: AgyEffort;
}

function normalizeReasoning(value: unknown): AgyEffort | undefined {
  if (value === "off") return "low";
  if (value === "auto") return undefined;
  if (typeof value !== "string") return undefined;
  switch (value) {
    case "minimal":
      return "low";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
    case "max":
      return "high";
    default:
      return undefined;
  }
}

function highestAvailableEffort(routeMap: Partial<Record<AgyEffort, string>>): AgyEffort {
  if (routeMap.high) return "high";
  if (routeMap.medium) return "medium";
  return "low";
}

function pickTierRoute(
  routes: Partial<Record<AgyEffort, string>>,
  requested: AgyEffort,
): string {
  const fallbackOrder: Record<AgyEffort, AgyEffort[]> = {
    low: ["low", "medium", "high"],
    medium: ["medium", "low", "high"],
    high: ["high", "medium", "low"],
  };
  for (const attempt of fallbackOrder[requested]) {
    const route = routes[attempt];
    if (route) return route;
  }
  throw new Error(`No usable AGY route found for effort ${requested}`);
}

export function resolveAgyModelSelection(
  model: BridgeModelDefinition,
  options: {
    reasoning?: unknown;
    disableReasoning?: boolean;
  },
  defaultEffort?: AgyEffort,
): ResolvedAgyModelSelection {
  const normalizedEffort = options?.disableReasoning === true ? "low" : normalizeReasoning(options?.reasoning);

  if (model.id === "auto") {
    // A custom auto entry may explicitly advertise no reasoning. In that case
    // never forward --effort: some AGY routes reject effort on non-reasoning
    // models, and OMP already exposes no thinking control for this model.
    const effort = model.reasoning
      ? normalizedEffort ?? model.effort ?? defaultEffort
      : undefined;
    return { model: undefined, effort };
  }

  if (model.agyModelIdsByEffort !== undefined) {
    const routes = model.agyModelIdsByEffort;
    const keys = Object.keys(routes);
    if (keys.length === 0) {
      throw new Error(`agyModelIdsByEffort is empty for ${model.id}`);
    }

    const requested = normalizedEffort ?? model.effort ?? defaultEffort ?? highestAvailableEffort(routes);
    const route = pickTierRoute(routes, requested);
    return { model: route, effort: undefined };
  }

  // Direct AGY model slugs support the CLI's --effort flag only when this model
  // is reasoning-capable. Apply the bridge-wide default just as we do for auto
  // and tiered models, but never leak a global effort into a non-reasoning route.
  const effort = model.reasoning
    ? normalizedEffort ?? model.effort ?? defaultEffort
    : undefined;
  return {
    model: model.agyModelId ?? model.id,
    effort,
  };
}
