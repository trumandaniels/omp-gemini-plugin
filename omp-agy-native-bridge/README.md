# OMP ↔ Official Antigravity CLI Bridge

This package is an experimental OMP extension that calls the **official** Google Antigravity `agy` executable while making Gemini behave as much like a native OMP model as the CLI boundary permits.

It provides two deliberately different integrations:

1. **`official-agy/*` model provider** — OMP owns the agent loop. `agy` is constrained to a tool-less structured-response shim. Gemini requests OMP tools, including OMP's `task` subagent tool, and OMP executes them normally.
2. **`agy_delegate` tool** — OMP delegates a complete task to the normal official Antigravity agent harness. Antigravity may use its own tools and subagents, and returns a final result to OMP.

The first mode is the closest practical approximation of “native OMP through the official CLI.” The second is intentionally an agent-inside-an-agent.

## What “native-like” means here

In provider mode, the control flow is:

```text
User
  → OMP agent loop
  → official-agy extension provider
  → spawn official `agy -p ... --output-format stream-json --json-schema ...`
  → tool-less Antigravity custom agent returns structured text/tool calls
  → extension emits native OMP AssistantMessageEvent events
  → OMP executes read/edit/bash/task/etc.
  → OMP sends tool results through a new `agy` call
```

OMP therefore remains authoritative for:

- conversation history and branches;
- context compaction;
- active tool schemas;
- permissions and approvals;
- edits, shell commands, tests, and verification;
- `task` subagents, isolation, and agent artifacts;
- retry and cancellation behavior around OMP tools.

`agy` remains authoritative for:

- Google account authentication via the official binary and OS keyring;
- model access under the signed-in Antigravity account;
- one model inference/harness invocation per OMP model turn.

## Current status

This package is a **working prototype**, not a claim of production readiness. The repository includes source checks plus fake-process and unit coverage; run `npm check` against your checkout. A live end-to-end run still requires your locally installed and authenticated `agy` plus your installed OMP version.

Known structural limitations are documented in [ARCHITECTURE.md](ARCHITECTURE.md) and [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md).

## Requirements

- OMP with extension provider registration (`pi.registerProvider` and `streamSimple`).
- Node.js 22+ for the helper scripts/tests. OMP itself runs the TypeScript extension through its Bun-based extension loader.
- Official Antigravity CLI (`agy`) installed in the **same environment** as OMP.
- One successful interactive `agy` login in that environment.
- Linux or WSL is strongly preferred for provider mode because the full OMP prompt is passed as a process argument. Windows has a much smaller process command-line ceiling.

## Install the official CLI and authenticate

Linux or WSL:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
agy
```

Complete the official browser sign-in, then verify headless mode:

```bash
agy -p "Reply with exactly READY." --output-format json --print-timeout 2m
```

The bridge does not read, copy, or store the OAuth tokens itself. The official `agy` process retrieves its cached account session from the OS keyring.

## Install the bridge

From this extracted directory:

```bash
npm check
npm run install-agent -- --force
omp plugin install "$PWD"
omp plugin doctor
```

For a one-off run without persistent plugin installation:

```bash
omp --extension "$PWD"
```

Restart OMP after installing the plugin or custom Antigravity agent.

## First run

Inside OMP:

```text
/agy-doctor
/model
```

Choose `official-agy/auto`, or choose any exact model currently shown by OMP.
For example, a current installation might expose:

```text
official-agy/gemini-3.1-pro
official-agy/gemini-3.7-flash
official-agy/claude-sonnet-4-6
official-agy/claude-opus-4-6-thinking
official-agy/gpt-oss-120b-medium
```

For Gemini logical families, the thinking selector controls the exact AGY
tier:

- `off`, `minimal`, `low` → `...-low`
- `medium` → `...-medium`
- `high`, `xhigh`, `max` → `...-high`

Claude and OpenAI model entries use the exact slugs returned by `agy models`.
Availability depends on the signed-in Antigravity account. `auto` still omits
`--model` and only forwards an explicit thinking level.

The extension always registers `auto`, synchronously runs `agy models` before
provider registration, and registers all discovered Gemini, Claude, and OpenAI
slugs as an ordinary static model array for that OMP process. You may also pin
or override entries in `.omp/agy-bridge.json`. Unknown pinned slugs fail loudly
in official headless mode; they do not silently fall back.

Try a tool loop:

```text
Read package.json and explain the scripts. Do not guess.
```

Try OMP-native subagents:

```text
Use task to have two subagents independently inspect the test strategy and the extension architecture, then synthesize their findings.
```

For OMP child sessions to use the bridge too, configure model roles as shown in [`examples/omp-config.yml`](examples/omp-config.yml).

## Image input and `modelRoles.vision`

Discovered explicit Gemini logical models such as `official-agy/gemini-3.7-flash` are registered with OMP as accepting both text and image input. Configure the OMP vision role explicitly so `inspect_image` has a deterministic route:

```yaml
modelRoles:
  vision: official-agy/gemini-3.7-flash
```

For each provider turn containing image blocks, the bridge:

1. validates the media type, count, and aggregate decoded size;
2. writes private temporary image files inside the request workspace;
3. maps the conversation's image blocks to numbered placeholders;
4. adds normal AGY `@file` media mentions to the headless prompt;
5. removes the temporary directory after the AGY process finishes.

The raw base64 image bytes are never inserted into the model's textual conversation transcript.

`official-agy/auto` remains text-only by default because provider registration cannot know which account model the CLI will choose. To explicitly mark a configured entry as image-capable, add either field inside that model entry:

```json
{
  "capabilities": {
    "image": true
  }
}
```

or:

```json
{
  "supportsImages": true
}
```

Set `supportsImages: false` to override the automatic Gemini-family inference. Set `enableImageInput: false` or `AGY_BRIDGE_ENABLE_IMAGES=false` to disable the transport globally.

## Configuration

Copy [`examples/agy-bridge.json`](examples/agy-bridge.json) to either:

```text
~/.omp/agent/agy-bridge.json
<repo>/.omp/agy-bridge.json
```

Project config overrides user config. Environment overrides include:

```text
AGY_BRIDGE_BIN
AGY_BRIDGE_AGENT
AGY_BRIDGE_PRINT_TIMEOUT
AGY_BRIDGE_EFFORT
AGY_BRIDGE_SANDBOX
AGY_BRIDGE_MAX_CONCURRENT
AGY_BRIDGE_MAX_PROMPT_BYTES
AGY_BRIDGE_HARD_TIMEOUT_MS
AGY_BRIDGE_SANITIZE_ACCOUNT_ENV
AGY_BRIDGE_REJECT_AGY_TOOLS
AGY_BRIDGE_ENABLE_DELEGATE
AGY_BRIDGE_ENABLE_IMAGES
AGY_BRIDGE_MAX_IMAGES
AGY_BRIDGE_MAX_IMAGE_BYTES
AGY_BRIDGE_DISCOVER_MODELS
AGY_BRIDGE_INCLUDE_NON_GEMINI
AGY_BRIDGE_PASSTHROUGH_ENV
```

All supported model families are discovered by default. Set
`includeNonGeminiModels: false` or `AGY_BRIDGE_INCLUDE_NON_GEMINI=false` to
limit automatic discovery to Gemini models. Explicit entries in `models`
remain available.

By default, the child environment removes Gemini/Vertex routing variables and other credential-shaped environment variables before launching `agy`, while preserving normal process and Linux keyring/DBus plumbing. This reduces accidental credential leakage and makes account-backed mode less likely to switch to an API key. Set `sanitizeAccountEnvironment: false` only for a deliberate trusted deployment. To retain a specific variable, name it explicitly in comma-separated `AGY_BRIDGE_PASSTHROUGH_ENV`.

## Delegate mode

The extension also registers this OMP tool:

```text
agy_delegate
```

Use it when you want the official Antigravity harness itself to own a bounded task, including its tools and subagents. Example intent:

```text
Delegate a read-only architecture review to Antigravity, then independently verify its cited files with OMP tools.
```

Delegate mode does **not** make Antigravity tools appear as OMP-native tool cards. OMP receives progress summaries and a final nested-agent result.

## Development commands

```bash
npm test
npm run check:source
npm check
npm run doctor
npm run install-agent -- --force
npm install
npm run typecheck
```

`npm run typecheck` requires the peer packages and Node type declarations to be installed. Runtime plugin loading does not require a compiled bundle.

## Read next

- [IMPLEMENTATION_INSTRUCTIONS.md](IMPLEMENTATION_INSTRUCTIONS.md) — exact instructions for a weaker coding model.
- [ARCHITECTURE.md](ARCHITECTURE.md) — data flow and state ownership.
- [SECURITY.md](SECURITY.md) — credentials, permissions, and fail-closed rules.
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — diagnosis by symptom.
- [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) — unavoidable CLI-boundary gaps.
- [VALIDATION.md](VALIDATION.md) — validation record and live-check requirements.
- [GPT_SPARK_EXECUTION_PROMPT.md](GPT_SPARK_EXECUTION_PROMPT.md) — paste-ready implementation prompt.
