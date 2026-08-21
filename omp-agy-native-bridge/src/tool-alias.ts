import type { SerializedTool } from "./schema.ts";
import type { BridgeStructuredOutput } from "./types.ts";

export interface HostActionCatalogEntry {
  id: string;
  purpose: string;
  input_schema: Record<string, unknown>;
}

export interface AliasedToolCatalog {
  wireCatalog: HostActionCatalogEntry[];
  wireToOmpToolName: Readonly<Record<string, string>>;
  ompToWireToolName: Readonly<Record<string, string>>;
}

const WIRE_PREFIX = "host_action_";

/**
 * Give every OMP action an opaque provider-wire identifier.
 *
 * Antigravity has its own native action namespace. Reusing OMP names or a
 * function-call-shaped catalog makes Gemini more likely to route a host request
 * through that namespace. The bridge exposes neutral IDs and catalog fields,
 * then restores canonical OMP names only after AGY returns.
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
    // Identity entries let trusted host-synthesized calls pass final restoration.
    // Only neutral IDs are exposed in the actual AGY schema and prompt catalog.
    wireToOmpToolName[tool.name] = tool.name;
    ompToWireToolName[tool.name] = wireName;
    return {
      id: wireName,
      purpose: tool.description,
      input_schema: tool.parameters,
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
        throw new Error(`host request ${index} named unknown action ID: ${call.name}`);
      }
      return { ...call, name: ompName };
    }),
  };
}
