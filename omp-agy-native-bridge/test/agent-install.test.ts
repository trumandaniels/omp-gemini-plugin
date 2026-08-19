import assert from "node:assert/strict";
import test from "node:test";

import { agentDefinitionsMatch } from "../src/agent-install.ts";

test("agentDefinitionsMatch tolerates line endings and final newlines", () => {
  assert.equal(agentDefinitionsMatch("a\nb\n", "a\r\nb\r\n\r\n"), true);
});

test("agentDefinitionsMatch detects stale isolation settings", () => {
  const bundled = "tools: []\ninheritCustomizations: false\n";
  const installed = "tools: []\n";
  assert.equal(agentDefinitionsMatch(bundled, installed), false);
});
