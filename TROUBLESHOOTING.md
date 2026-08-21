# Troubleshooting

## `/model` does not show `official-agy`

Check the extension is loaded:

```bash
omp plugin list
omp plugin doctor
```

For a one-off diagnosis:

```bash
omp --extension /absolute/path/to/checkout
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

## The bridge says the custom agent is missing or stale

Install the exact agent definition bundled with the same bridge checkout:

```bash
sfw-npm run install-agent -- --force
```

Or, from inside OMP:

```text
/agy-install-agent
```

Expected path:

```text
~/.gemini/config/agents/omp-bridge-model/agent.md
```

The same command installs a provider-only `PreToolUse` boundary and registers its managed hook:

```text
~/.gemini/config/omp-agy-native-bridge/provider-safety-hook.cjs
~/.gemini/config/hooks.json
```

Verify discovery and exact-file freshness:

```bash
agy agents
sfw-npm run doctor
```

`doctor` should report all three of these as `PASS`:

```text
tool-less bridge agent file
tool-less bridge agent contents
provider pre-tool safety boundary
```

Fully exit every OMP and `agy` process after replacing the agent, then start a new OMP process. Custom-agent definitions and provider metadata are loaded at process startup.

## Provider-mode agy unexpectedly used its own harness

This is an intentional fail-closed error: provider mode must return OMP tool requests, not execute Antigravity tools itself.

Antigravity CLI 1.1.14 introduced the `inheritCustomizations` switch for markdown agents. Without an explicit opt-out, a declarative agent may inherit personal skills, rules, plugins, subagents, or MCP servers even when it declares `tools: []`. Older bridge-agent files did not include that opt-out.

The current bundled agent explicitly sets:

```yaml
tools: []
subagent: false
commandExecutionPolicy: off
inheritCustomizations: false
inherit_user: false
inheritMcp: false
mcpServers: []
skills: []
plugins: []
rules: []
```

AGY 1.1.13 and later may still expose fundamental control tools such as `manage_task` to declarative primary agents. Prompt instructions and `tools: []` are not an execution boundary. The installed `PreToolUse` hook allows only side-effect-free status probes and exact staged-image reads during provider processes; it denies messaging, mutation, execution, delegation, and other Antigravity-native actions before execution. It remains inert for normal AGY and `agy_delegate` runs. When AGY misroutes an answer through blocked internal messaging, the bridge deterministically reconstructs the intended OMP return instead of trusting an executed message.

Repair from the repository root:

```bash
git switch main
git pull
sfw-npm run install-agent -- --force
sfw-npm run doctor:live
```

If the plugin was installed from this checkout rather than linked, reinstall it too:

```bash
omp plugin install "$PWD"
```

Then fully terminate and restart OMP. Merely dismissing the message or starting a new turn does not reload the custom-agent definition or hook configuration.

The improved error reports unique tool invocation names and distinguishes them from repeated `ACTIVE`/`DONE` lifecycle updates. If the failure remains after a clean reinstall and restart, copy the complete new error. A message such as:

```text
2 tool invocation(s) from 6 lifecycle update(s) [codesearch, read_file]
```

is much more diagnostic than the previous raw count.

If AGY emits more tool or subagent activity than the bridge can retain in its bounded diagnostic snapshots, provider mode fails closed rather than deciding that the unseen activity was safe.

Do **not** set `rejectAgyToolUseInProviderMode: false` as a workaround. That would allow Antigravity and OMP to become competing workspace harnesses, bypassing OMP's native tool cards and permission boundary.

## `agy failed: recipient "omp" not found`

This means the Antigravity model mistook OMP for an addressable Antigravity agent or inbox and attempted an internal `send_message` call. OMP is the host application and tool dispatcher; it is not an AGY recipient.

Current provider mode recognizes only the exact, side-effect-free form of this failure. It discards the failed attempt and retries once when all of the following are true:

- the terminal status is `ERROR`;
- the terminal error is exactly `recipient "omp" not found`;
- no Antigravity subagent was observed;
- every complete AGY tool snapshot belongs to `send_message`;
- the activity snapshots were not truncated.

The failed message result is never inserted into OMP history. Token usage from the discarded attempt is still counted. There is one shared retry budget, so one OMP provider turn can launch at most two AGY processes.

Update the installed bridge agent and provider hook before retesting.

```bash
git switch main
git pull
sfw-npm run install-agent -- --force
omp plugin install "$PWD"
sfw-npm run doctor:live
```

Then fully terminate every OMP and AGY process and restart OMP. A native OMP coordination tool named `hub` remains available when it appears in the OMP tool catalog; the fix blocks only Antigravity messaging and coordination tools from being invoked inside provider mode.

If the same error survives the one corrective retry, or if any file/search/command/MCP/subagent activity accompanies it, the bridge deliberately returns an error instead of silently continuing.

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

## AGY rejects `--effort` for a Claude or OpenAI model

AGY accepts `--effort` only for direct Gemini routes. The bridge therefore omits
the flag for Claude, OpenAI, other non-Gemini model families, and `auto`.

Upgrade or relink the bridge if an error reports an invalid selection such as
`--model "claude-..." --effort "medium"`. Fully restart OMP after updating the
plugin so the provider loads the corrected model-selection logic.

## The model is marked vision-capable but the screenshot is not understood

The bridge writes OMP image blocks as private files under an `omp-agy-media-*` operating-system temporary directory. It adds that directory to the current AGY process with `--add-dir` and uses absolute AGY `@file` media mentions in the headless prompt.

Check, in order:

1. `enableImageInput` is `true` and `AGY_BRIDGE_ENABLE_IMAGES` is not `false`.
2. The selected role is an explicit image-capable model, not `official-agy/auto`.
3. The input is PNG, JPEG, GIF, WebP, BMP, TIFF, or SVG.
4. The turn does not exceed `maxImageCount` or `maxImageBytes`.
5. Your installed `agy` build supports ordinary media/file-mention preprocessing in print mode.
6. The custom agent was reinstalled after upgrading this bridge:

   ```bash
   sfw-npm run install-agent -- --force
   ```

Run an isolated AGY test in a disposable directory with a small image:

```bash
agy -p "Describe @./test.png in one sentence." --output-format json --print-timeout 2m
```

If that direct command cannot see the image, the bridge cannot repair the installed CLI's headless media behavior. Upgrade `agy` or configure another OMP-native vision provider for `modelRoles.vision`.

A force-killed process or host crash can leave an `omp-agy-media-*` directory under the operating-system temporary directory. Remove a stale directory only after confirming that no bridge process is using it.

## Prompt exceeds `AGY_BRIDGE_MAX_PROMPT_BYTES`

Provider mode sends the reconstructed OMP context through the official CLI's non-TTY stdin prompt. The bridge still rejects contexts above `AGY_BRIDGE_MAX_PROMPT_BYTES`. Solutions, in order:

1. compact the OMP session;
2. start a new OMP session with a concise handoff;
3. reduce verbose tool output;
4. raise the limit after checking available memory and the installed CLI behavior;
5. use `agy_delegate` for one self-contained task;
6. use a future SDK or local authenticated sidecar transport if the official CLI exposes one.

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
sfw-npm install
sfw-npm run typecheck
```

OMP runtime may still load the extension through host package compatibility even when this extracted development directory has no local peer installation. Typecheck should be run in a real implementation repository before publishing.
