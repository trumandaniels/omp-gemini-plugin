# Paste This Into GPT Spark

You are implementing and validating the repository in this ZIP. You must read `IMPLEMENTATION_INSTRUCTIONS.md`, `ARCHITECTURE.md`, `SECURITY.md`, and the existing source before editing anything.

## Objective

Make the included OMP extension work against the user's installed OMP and official Google Antigravity `agy` CLI.

Provider mode must register `official-agy/*` models. OMP must own the agent loop and execute its native tools and `task` subagents. The official `agy` process must only return structured text/tool-call decisions through a tool-less custom agent.

The separate `agy_delegate` tool may run the normal Antigravity harness with its own tools/subagents.

## Do not redesign

Do not:

- implement OAuth or copy credentials;
- use OMP `/login google-antigravity`;
- use a community OAuth wrapper;
- add `--dangerously-skip-permissions`;
- let Antigravity tools run in provider mode;
- use `--continue` or `--conversation` in provider mode;
- recursively invoke OMP for each tool;
- invent `pi.callTool`;
- replace the unique custom API ID with a built-in API ID;
- replace the `auto` plus registration-time model array with `fetchDynamicModels`-only discovery;
- silently fall back on parse/model/provider errors;
- remove tests to make the build pass.

## Required procedure

1. Run and record:

   ```bash
   omp --version
   agy --version
   node --version
   agy models
   agy agents
   npm test
   ```

2. Inspect actual installed OMP type declarations for:

   ```text
   ExtensionAPI
   ProviderConfig
   registerProvider
   streamSimple
   AssistantMessageEvent
   Context
   Tool
   SimpleStreamOptions
   registerTool
   registerCommand
   ```

3. Compare those declarations with `src/index.ts`, `src/provider.ts`, and `src/delegate-tool.ts`.

4. Fix only concrete mismatches. Add a failing test before each protocol or behavior fix.

5. Install the bundled tool-less agent:

   ```bash
   npm run install-agent -- --force
   agy agents
   ```

6. Install or run the extension:

   ```bash
   omp --extension "$PWD"
   ```

   or:

   ```bash
   omp plugin install "$PWD"
   omp plugin doctor
   ```

7. Run `/agy-doctor` and verify `/model` shows `official-agy/auto`.

8. Complete live tests in a disposable repository:

   - plain text response;
   - OMP `read` tool call;
   - OMP edit plus read-back verification;
   - OMP `task` fan-out with two child sessions;
   - cancellation;
   - unknown model failure;
   - malformed fake NDJSON failure;
   - unexpected Antigravity tool-step rejection;
   - `agy_delegate` progress and result.

9. Configure OMP model roles so child task sessions use the provider:

   ```yaml
   modelRoles:
     default: official-agy/gemini-3.1-pro-high
     smol: official-agy/gemini-3.7-flash-medium
     task: official-agy/gemini-3.7-flash-high
     slow: official-agy/gemini-3.1-pro-high
     plan: official-agy/gemini-3.1-pro-high
   ```

10. Run all tests again and report exact results.

## Core invariants

- OMP history is canonical. Every provider turn is a fresh stateless `agy` call with reconstructed OMP context.
- Provider mode selects `--agent omp-bridge-model`.
- The custom agent has `tools: []` and `subagent: false`.
- Terminal output uses `--json-schema` and is locally validated.
- OMP tool calls are emitted as native `AssistantMessageEvent` events.
- OMP executes the calls; the bridge never directly invokes an arbitrary OMP tool.
- Any Antigravity `tool` step or `subagent_info` in provider mode is an error.
- The bridge never logs or writes the full prompt or credentials.
- The provider registration is the last mutation in the extension factory.

## Deliverables

Return:

1. changed files;
2. exact commands run;
3. tests and live checks with pass/fail status;
4. unresolved compatibility gaps;
5. current `agy models` output relevant to configured models;
6. any change made to documented behavior;
7. one commit per stage from the required sequence.

Do not say “implemented” without showing test evidence. Do not claim live authentication/model success when only fake-process tests ran.
