# Paste This Into GPT Spark

You are implementing and validating this repository. You must read `IMPLEMENTATION_INSTRUCTIONS.md`, `ARCHITECTURE.md`, `SECURITY.md`, `TROUBLESHOOTING.md`, `VALIDATION.md`, and the existing source before editing anything.

## Objective

Make the included OMP extension work against the user's installed OMP and official Google Antigravity `agy` CLI.

Provider mode must register `official-agy/*` models. OMP must own the agent loop and execute its native tools and `task` subagents. The official `agy` process must return structured text/tool-call decisions through a tool-less custom agent.

Explicit image-capable Gemini routes must also work with OMP `modelRoles.vision` and `inspect_image`. OMP image blocks must be transported through the official CLI boundary without putting raw base64 into the text prompt.

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
- mark every unknown `auto` route image-capable;
- put raw image base64 into the reconstructed text conversation;
- remove tests to make the build pass.

## Required procedure

1. Run and record:

   ```bash
   omp --version
   agy --version
   node --version
   agy models
   agy agents
   npm run check:source
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
   Model.input
   ImageContent
   Tool
   SimpleStreamOptions
   registerTool
   registerCommand
   ```

3. Compare those declarations with `src/index.ts`, `src/provider.ts`, `src/media.ts`, `src/messages.ts`, `src/prompt.ts`, and `src/delegate-tool.ts`.

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

7. Run `/agy-doctor` and verify `/model` shows `official-agy/auto` plus the discovered explicit Gemini logical models.

8. Complete live tests in a disposable repository:

   - plain text response;
   - OMP `read` tool call;
   - OMP edit plus read-back verification;
   - OMP `task` fan-out with two child sessions;
   - cancellation;
   - unknown model failure;
   - malformed fake NDJSON failure;
   - unexpected Antigravity tool-step rejection;
   - nested bridge JSON containing OMP tool calls;
   - `agy_delegate` progress and result.

9. Configure OMP model roles:

   ```yaml
   modelRoles:
     default: official-agy/gemini-3.1-pro
     smol: official-agy/gemini-3.7-flash
     task: official-agy/gemini-3.7-flash
     slow: official-agy/gemini-3.1-pro
     plan: official-agy/gemini-3.1-pro
     vision: official-agy/gemini-3.7-flash
   ```

10. Validate image support in two stages:

    First prove the installed official CLI can resolve media in print mode:

    ```bash
    agy -p "Describe @./test.png in one sentence." --output-format json --print-timeout 2m
    ```

    Then restart OMP and test both an attached screenshot and the `inspect_image` tool. Verify:

    - the explicit Gemini model is registered with `input: ["text", "image"]`;
    - `inspect_image` does not reject the model before invocation;
    - the model describes visible image content;
    - raw base64 does not appear in the prompt or output;
    - `.omp-agy-media-*` is removed after success, failure, and cancellation;
    - unsupported and oversized images fail before AGY launch.

11. Document and run:

    - `off`/`minimal`/`low` uses `...-low` internally;
    - `medium` uses `...-medium`;
    - `high`/`xhigh`/`max` uses `...-high`.

12. Run all tests again and report exact results:

    ```bash
    npm run check:source
    npm test
    npm install
    npm run typecheck
    npm pack --dry-run --json
    ```

## Core invariants

- OMP history is canonical. Every provider turn is a fresh stateless `agy` call with reconstructed OMP context.
- Provider mode selects `--agent omp-bridge-model`.
- The custom agent has `tools: []` and `subagent: false`.
- Terminal output uses `--json-schema` and is locally validated.
- Nested bridge-shaped output may be unwrapped only after validating the same OMP tool allowlist.
- OMP tool calls are emitted as native `AssistantMessageEvent` events.
- OMP executes the calls; the bridge never directly invokes an arbitrary OMP tool.
- Any Antigravity `tool` step or `subagent_info` in provider mode is an error.
- Explicit OMP image inputs are the only prompt-media exception to the no-workspace-inspection boundary.
- Image media is bounded, staged privately, referenced explicitly, and removed in `finally`.
- `official-agy/auto` remains text-only unless the operator explicitly marks it image-capable.
- The bridge never logs or writes the full text prompt or credentials.
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

Do not say “implemented” without showing test evidence. Do not claim live authentication, model, or image success when only fake-process/unit tests ran.
