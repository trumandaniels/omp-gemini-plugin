import assert from "node:assert/strict";
import test from "node:test";

import { parseAgyAgentsOutput } from "../src/doctor.ts";

test("parseAgyAgentsOutput parses machine-readable agent arrays without metadata noise", () => {
  assert.deepEqual(
    parseAgyAgentsOutput(
      JSON.stringify({
        agents: [
          {
            name: "omp-bridge-model",
            description: "Tool-less provider shim",
            subagent: false,
          },
          {
            id: "reviewer",
            description: "Quality review",
          },
        ],
      }),
    ),
    ["omp-bridge-model", "reviewer"],
  );
});

test("parseAgyAgentsOutput parses slug-keyed maps", () => {
  assert.deepEqual(
    parseAgyAgentsOutput(
      JSON.stringify({
        data: {
          "omp-bridge-model": { description: "Bridge" },
          scout: { description: "Read-only research" },
        },
      }),
    ),
    ["omp-bridge-model", "scout"],
  );
});

test("parseAgyAgentsOutput reads only the first human-table column", () => {
  const output = `Available agents
NAME                  DESCRIPTION
* omp-bridge-model    Uses reviewer in its description
  scout               Mentions omp-bridge-model but is a different row
`;
  assert.deepEqual(parseAgyAgentsOutput(output), ["Available", "NAME", "omp-bridge-model", "scout"]);
});

test("parseAgyAgentsOutput strips ANSI and deduplicates names", () => {
  const output = "\u001b[32m* omp-bridge-model\u001b[0m\n  omp-bridge-model\n";
  assert.deepEqual(parseAgyAgentsOutput(output), ["omp-bridge-model"]);
});
