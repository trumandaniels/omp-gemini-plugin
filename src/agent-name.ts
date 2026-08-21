const INVALID_AGENT_NAME = /[<>:"/\\|?*\u0000-\u001f]/;

/** Validate an AGY custom-agent name before it is used as a filesystem segment. */
export function assertSafeAgentName(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error("Bridge config agentName must be a non-empty name without leading or trailing whitespace");
  }
  if (value === "." || value === ".." || value.length > 128 || INVALID_AGENT_NAME.test(value)) {
    throw new Error(
      "Bridge config agentName must be a single portable filename segment without path separators or reserved characters",
    );
  }
}
