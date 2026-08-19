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

## `inspect_image` says the official-agy model does not support image input

OMP does not read `capabilities.image` directly from the bridge config at call time. It checks the registered model's `input` array. Upgrade/reinstall this bridge and restart OMP so explicit Gemini logical models are registered with:

```json
{
  "input": ["text", "image"]
}
```

Configure a deterministic vision role in `~/.omp/agent/config.yml` or `<repo>/.omp/config.yml`:

```yaml
modelRoles:
  vision: official-agy/gemini-3.7-flash
```

Use an explicit logical Gemini model rather than `official-agy/auto`. `auto` remains text-only by default because the bridge cannot know which account model the CLI will select.

For a custom or pinned model entry, explicitly mark image support in `agy-bridge.json`:

```json
{
  "models": [
    {
      "id": "my-vision-route",
      "name": "My vision route",
      "reasoning": true,
      "contextWindow": 1000000,
      "maxTokens": 64000,
      "agyModelId": "gemini-example",
      "capabilities": {
        "image": true
      }
    }
  ]
}
```

`supportsImages: true` is an equivalent bridge-native override. After editing either OMP or bridge configuration, fully restart OMP; provider metadata is registered at process startup.

## The model is marked vision-capable but the screenshot is not understood

The bridge transports OMP image blocks by writing private temporary files under `.omp-agy-media-*` in the request workspace and adding AGY `@file` media mentions to the headless prompt.

Check, in order:

1. `enableImageInput` is `true` and `AGY_BRIDGE_ENABLE_IMAGES` is not `false`.
2. The selected role is an explicit image-capable model, not `official-agy/auto`.
3. The input is PNG, JPEG, GIF, WebP, BMP, TIFF, or SVG.
4. The turn does not exceed `maxImageCount` or `maxImageBytes`.
5. Your installed `agy` build supports ordinary media/file-mention preprocessing in print mode.
6. The custom agent was reinstalled after upgrading this bridge:

   ```bash
   npm run install-agent -- --force
   ```

Run an isolated AGY test in a disposable directory with a small image:

```bash
agy -p "Describe @./test.png in one sentence." --output-format json --print-timeout 2m
```

If that direct command cannot see the image, the bridge cannot repair the installed CLI's headless media behavior. Upgrade `agy` or configure another OMP-native vision provider for `modelRoles.vision`.

A force-killed process or host crash can leave `.omp-agy-media-*` behind. Remove stale directories only after confirming no bridge process is active:

```bash
find . -maxdepth 1 -type d -name '.omp-agy-media-*' -print
```

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

## Raw bridge JSON appears instead of a tool card or answer

The bridge handles three known AGY output shapes:

- several concatenated bridge objects;
- valid first output followed by truncated completion chatter;
- a bridge object serialized again inside the outer `text` field.

Upgrade/reinstall the plugin and restart OMP. If raw JSON still appears, capture the complete terminal `result.response` and `result.structured_output` values with secrets removed. Do not rely only on the rendered TUI screenshot; exact escaping and fence placement determine which parser path ran.

## A tool call has invalid arguments

OMP should return a normal tool error and invoke the model again. The terminal schema restricts tool names but intentionally does not embed every full OMP tool schema because some schemas are large or use constructs Antigravity's structured-output implementation may reject.

The prompt still contains a bounded textual schema catalog. Do not execute arguments directly inside the bridge.

## Subagents or one-shot tools use another model

Selecting the provider for the parent does not rewrite OMP role configuration. Add:

```yaml
modelRoles:
  default: official-agy/gemini-3.1-pro
  smol: official-agy/gemini-3.7-flash
  task: official-agy/gemini-3.7-flash
  slow: official-agy/gemini-3.1-pro
  plan: official-agy/gemini-3.1-pro
  vision: official-agy/gemini-3.7-flash
```

Use `/model` or OMP config inspection to verify the resolved child/one-shot role and the active thinking level.

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
