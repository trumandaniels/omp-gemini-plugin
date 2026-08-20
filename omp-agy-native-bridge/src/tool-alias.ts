import type { SerializedTool } from "./schema.ts";
import type { BridgeStructuredOutput } from "./types.ts";

export interface AliasedToolCatalog {
  wireCatalog: SerializedTool[];
  wireToOmpToolName: Readonly<Record<string, string>>;
  ompToWireToolName: Readonly<Record<string, string>>;
}

const WIRE_PREFIX = "omp_capability_";

/**
 * Give every OMP tool an opaque provider-wire name.
 *
 * Antigravity has its own built-in tool namespace. Reusing OMP names such as
 * `task`, `read`, or `hub` in the AGY-facing schema makes model-side tool routing
 * more likely to confuse an OMP request with an Antigravity-native action. The
 * bridge therefore exposes only deterministic opaque aliases to AGY and restores
 * the real OMP names after the terminal envelope has been validated.
 */
export function aliasOmpToolCatalog(catalog: readonly SerializedTool[]): AliasedToolCatalog {
  const wireToOmpToolName: Record<string, string> = Object.create(null) as Record<string, string>;
  const ompToWireToolName: Record<string, string> = Object.create(null) as Record<string, string>;
  const seenOmpNames = new Set<string>();

  const wireCatalog = catalog.map((tool, index) => {
    if (seenOmpNames.has(tool.name)) {
      throw new Error(`Duplicate OMP tool name in provider catalog: ${tool.name}`);
    }
    seenOmpNames.add(tool.name);

    const wireName = `${WIRE_PREFIX}${String(index + 1).padStart(2, "0")}`;
    wireToOmpToolName[wireName] = tool.name;
    // Deterministic host-side recovery can synthesize an already-canonical OMP
    // call without passing through AGY. Identity entries let the final restore
    // step accept that trusted host result while the actual AGY schema still
    // exposes only opaque aliases.
    wireToOmpToolName[tool.name] = tool.name;
    ompToWireToolName[tool.name] = wireName;
    return {
      ...tool,
      name: wireName,
      description: [
        "OMP host capability. Request it only by returning this alias in the outer tool_calls array; do not execute an Antigravity-native action.",
        tool.description,
      ].filter(Boolean).join("\n"),
    };
  });

  return { wireCatalog, wireToOmpToolName, ompToWireToolName };
}

export function restoreOmpToolNames(
  output: BridgeStructuredOutput,
  wireToOmpToolName: Readonly<Record<string, string>>,
): BridgeStructuredOutput {
  return {
    ...output,
    tool_calls: output.tool_calls.map((call, index) => {
      const ompName = wireToOmpToolName[call.name];
      if (!ompName) {
        throw new Error(`tool_calls[${index}] named unknown OMP capability alias: ${call.name}`);
      }
      return { ...call, name: ompName };
    }),
  };
}
