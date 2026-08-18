# Troubleshooting

## `/model` does not show `official-agy`

Check the extension is loaded:

```bash
omp plugin list
omp plugin doctor
```

For a one-off diagnosis:

```bash
omp --extension /absolute/path/to/omp-agy-native-bridge
```

The package manifest must contain:

```json
{
  "omp": { "extensions": ["./src/index.ts"] }
}
```

Restart OMP after installation. Extension-registered models are static in this prototype so they can appear during cold startup.

## `agy` command not found

Install the official binary in the same operating environment as OMP:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
command -v agy
agy --version
```

A Windows installation does not automatically make the binary available inside WSL. Install/authenticate inside WSL when OMP runs inside WSL, or set `AGY_BRIDGE_BIN` to a working wrapper.

## Authentication required

Run the interactive official CLI once:

```bash
agy
```

Complete browser authentication, exit the TUI, then test:

```bash
agy -p "Reply READY" --output-format json --print-timeout 2m
```

Headless mode uses cached credentials and will not complete a new interactive sign-in from the provider subprocess.

## The bridge says the custom agent is missing

Install it:

```bash
npm run install-agent -- --force
```

Expected path:

```text
~/.gemini/config/agents/omp-bridge-model/agent.md
```

Verify discovery:

```bash
agy agents
```

Then restart OMP.

## Provider-mode agy unexpectedly used its own tools

This is a fail-closed error. Common causes:

- the custom agent was not installed;
- `agentName` points at a different agent;
- an existing agent file was not overwritten;
- an Antigravity update changed custom-agent behavior;
- the CLI ignored `--agent`.

Repair:

```bash
npm run install-agent -- --force
agy agents
AGY_BRIDGE_AGENT=omp-bridge-model npm run doctor
```

Do not set `rejectAgyToolUseInProviderMode: false` until you have inspected the stream and understood the change. Allowing both Antigravity and OMP to act on the workspace creates two competing harnesses.

## Unknown model selection

Official headless mode exits nonzero when a pinned slug is unknown.

```bash
agy models
```

Use:

```text
official-agy/auto
```

for the current default. Exact slugs are synchronously read from `agy models` and registered as a normal model array before the provider is added; configured entries in `.omp/agy-bridge.json` are merged in. This avoids depending on OMP extension-only `fetchDynamicModels` during cold start.

## Prompt exceeds `AGY_BRIDGE_MAX_PROMPT_BYTES`

Provider mode sends the reconstructed OMP context through the `-p` process argument. Solutions, in order:

1. compact the OMP session;
2. start a new OMP session with a concise handoff;
3. reduce verbose tool output;
4. raise the limit on Linux/WSL after checking `getconf ARG_MAX`;
5. use `agy_delegate` for one self-contained task;
6. implement the future SDK/IPC transport described in the implementation plan.

Do not raise the Windows default blindly; Windows process command lines are much smaller than Linux `ARG_MAX`.

## No token-by-token text appears

Expected in provider mode. `--json-schema` constrains the terminal result, so the bridge waits for validated `structured_output` before exposing text and tool calls to OMP.

Delegate mode can show incremental progress because it does not reinterpret the final response as an OMP function-call envelope.

## A tool call has invalid arguments

OMP should return a normal tool error and invoke the model again. The terminal schema restricts tool names but intentionally does not embed every full OMP tool schema because some schemas are large or use constructs Antigravity's structured-output implementation may reject.

The prompt still contains a bounded textual schema catalog. Do not execute arguments directly inside the bridge.

## Subagents use another model

Selecting the provider for the parent does not rewrite OMP role configuration. Add:

```yaml
modelRoles:
  default: official-agy/gemini-3.1-pro-high
  smol: official-agy/gemini-3.7-flash-medium
  task: official-agy/gemini-3.7-flash-high
  slow: official-agy/gemini-3.1-pro-high
  plan: official-agy/gemini-3.1-pro-high
```

Use `/model` or OMP config inspection to verify the resolved child role.

## Subagents appear stuck or run serially

Compare:

```text
task.maxConcurrency
AGY_BRIDGE_MAX_CONCURRENT
```

The effective throughput is no greater than the smaller bound. Also remember each subagent may make several provider turns as it uses tools.

## `agy_delegate` edits files unexpectedly

Delegate mode runs the normal Antigravity harness. It is allowed to use its own tools according to Antigravity permissions. Use:

- a read-only task;
- a separate worktree;
- scoped Antigravity permission rules;
- `sandbox: true`;
- provider mode when OMP must own every action.

## Headless run exits zero but work is incomplete

Official headless mode can soft-deny approval-requiring tools and still continue. Inspect:

- `details.stderr` from `agy_delegate`;
- streamed tool errors;
- the final response for claimed versus observed actions.

Never equate process exit code zero with successful tool execution. The runner additionally requires `status: SUCCESS`, but soft denial can still occur inside a successful nested run.

## Child process does not cancel

The runner sends `SIGTERM`, waits `killGraceMs`, then sends `SIGKILL`. On Windows, process-tree semantics may differ. WSL/Linux is recommended.

A production implementation should use a platform-specific process-group kill and job object on native Windows.

## Typecheck cannot find OMP packages

Install development peers:

```bash
npm install
npm run typecheck
```

OMP runtime may still load the extension through host package compatibility even when this extracted development directory has no local peer installation. Typecheck should be run in a real implementation repository before publishing.
