# Explicit Implementation Instructions: Official `agy` as a Native-Like OMP Provider

## Audience

These instructions are intentionally explicit enough for a weaker coding model to execute without inventing a different architecture. The ZIP already contains a reference implementation. Treat it as the starting point, run its tests, and make only evidence-backed compatibility fixes.

## Mission

Build and verify an OMP extension that uses the **official Google Antigravity `agy` CLI** for model access while keeping OMP in charge of tools, edits, permissions, history, and subagents.

The finished user experience must be:

```text
/model
→ official-agy/gemini-...
```

Then ordinary OMP prompting must work:

```text
Read src/index.ts, inspect the registered tools, and fix the bug.
```

Gemini must request OMP's real `read`, `edit`, `bash`, `task`, and other available tools. Antigravity must not independently edit the workspace in provider mode.

The extension must also expose a separate `agy_delegate` tool for the opposite use case: deliberately delegate a self-contained job to the normal official Antigravity harness, including its own tools and subagents.

## Fixed architecture — do not redesign

Implement exactly two paths.

### Path A: `official-agy` provider

- Register an OMP provider with `pi.registerProvider`.
- Give it a **unique custom API ID**, not `google-generative-ai` or another built-in ID.
- Supply a non-empty registration-time model array so cold-start model selection works; always include `auto` and synchronously supplement it from `agy models`.
- Implement `streamSimple`.
- On every OMP model call:
  1. receive OMP `Context` and active `Tool[]`;
  2. serialize a bounded OMP prompt and tool catalog;
  3. generate a terminal JSON schema;
  4. spawn the official `agy` binary with `-p`, `--output-format stream-json`, `--json-schema`, `--agent omp-bridge-model`, `--sandbox`, and a timeout;
  5. parse NDJSON strictly;
  6. require exactly one terminal `result` with `status: SUCCESS`;
  7. parse `structured_output`;
  8. convert text and tool calls into native OMP `AssistantMessageEvent`s;
  9. let OMP execute tool calls normally.
- Do not pass `--continue` or `--conversation` in provider mode.
- Do not allow Antigravity tools or subagents in provider mode.

### Path B: `agy_delegate` tool

- Register one OMP tool named `agy_delegate`.
- Spawn a normal official `agy` headless run without the tool-less bridge agent and without a response schema.
- Allow the normal Antigravity harness to use its own tools/subagents under its permissions.
- Stream human-readable progress summaries into OMP `onUpdate`.
- Return the final response, conversation ID, usage, tool summaries, and subagent summaries as the OMP tool result.

### State authority

OMP is the only source of truth for provider-mode state. Do not create a second persistent Antigravity conversation for the same session.

This decision is required because OMP can branch, compact, change tools, rewind, and create child sessions. An `agy` conversation ID cannot mirror those transformations reliably.

## Absolute prohibitions

Do not:

- implement or copy an Antigravity OAuth flow;
- read tokens from the official keyring;
- use OMP's `google-antigravity` OAuth provider;
- call an unofficial OAuth wrapper;
- pass `--dangerously-skip-permissions`;
- let both Antigravity and OMP edit the same workspace in provider mode;
- shell out to a recursive `omp` process to execute every tool;
- invent a nonexistent `pi.callTool` API;
- use `--continue` for provider mode;
- silently fall back to another provider or model;
- swallow malformed NDJSON or an unknown terminal status;
- treat exit code zero alone as proof of successful work;
- replace the registration-time model array with `fetchDynamicModels`-only discovery until OMP's cold-start behavior has been verified on the target release.

## Repository map

The implementation is divided as follows:

```text
src/index.ts                 Extension registration; provider registration must be last.
src/config.ts                JSON config, environment overrides, bootstrap model, validation.
src/model-discovery.ts        Synchronous `agy models` parsing before provider registration.
src/env.ts                    Bounded child environment and explicit secret passthrough.
src/types.ts                 Local protocol and config types.
src/semaphore.ts             Bounded in-process agy concurrency.
src/schema.ts                OMP tool schema serialization and terminal-output validation.
src/messages.ts              Safe OMP history serialization; omit hidden reasoning and image bytes.
src/prompt.ts                Tool-less model-shim instruction and current OMP context.
src/provider.ts              Native OMP AssistantMessageEvent translation.
src/delegate-tool.ts         Normal nested Antigravity agent tool.
src/agent-install.ts         Global custom-agent installer.
src/doctor.ts                Binary/model/agent checks.
src/agy/ndjson.ts            Strict NDJSON event parser.
src/agy/runner.ts            Process lifecycle, schema temp file, cancellation, terminal status.
agents/omp-bridge-model/...  Antigravity custom agent with no tools and no subagent capability.
scripts/install-agent.ts     CLI installer for custom agent.
scripts/doctor.ts            CLI doctor.
test/                        Pure unit/process tests using a fake agy executable.
```

## Phase 0 — establish the exact target versions

Before editing code, run:

```bash
omp --version
agy --version
node --version
agy models
agy agents
```

Record the output in your work log. Do not assume model slugs from this document remain current.

Confirm the installed OMP package exposes:

- `ExtensionAPI.registerProvider`;
- provider config `streamSimple`;
- `createAssistantMessageEventStream`;
- `Context`, `Tool`, `AssistantMessage`, `ToolCall`, `Usage`, and `SimpleStreamOptions` types;
- extension `registerTool` and `registerCommand`.

Use installed package declarations or the current OMP source. Do not write against an old Pi fork based only on memory.

Run the reference tests before changing anything:

```bash
npm test
```

Expected result: all tests pass.

## Phase 1 — install and authenticate the official CLI

Use Google's official installation instructions. In Linux/WSL:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
agy
```

Complete the official browser login. Then exit and verify cached headless authentication:

```bash
agy -p "Reply with exactly READY." \
  --output-format json \
  --print-timeout 2m
```

Expected:

- process exits zero;
- JSON `status` is `SUCCESS`;
- response is present;
- no interactive prompt occurs.

Do this in the same environment as OMP. A Windows keyring login is not automatically a WSL keyring login.

## Phase 2 — install the tool-less Antigravity agent

Provider mode must select a custom agent with no tools.

Run:

```bash
npm run install-agent -- --force
```

The file must end up at:

```text
~/.gemini/config/agents/omp-bridge-model/agent.md
```

It must contain frontmatter equivalent to:

```yaml
name: omp-bridge-model
tools: []
mainAgent: true
subagent: false
model: inherit
commandExecutionPolicy: off
mcpServers: []
skills: []
plugins: []
```

Verify discovery:

```bash
agy agents
```

Do not add file, shell, MCP, browser, or subagent tools to this agent. Provider-mode actions must flow back to OMP.

## Phase 3 — configuration implementation

Use `src/config.ts`.

### Required config resolution

Load in this order:

1. built-in defaults;
2. `~/.omp/agent/agy-bridge.json`;
3. `<cwd>/.omp/agy-bridge.json`;
4. environment overrides.

Project settings override user settings. Environment overrides are last.

### Required defaults

Use:

```text
providerId = official-agy
apiId = official-agy-cli-v1
agyBinary = agy
agentName = omp-bridge-model
printTimeout = 15m
sandbox = true
maxConcurrent = 3
sanitizeAccountEnvironment = true
rejectAgyToolUseInProviderMode = true
enableDelegateTool = true
```

Use a lower prompt-byte limit on native Windows than on Linux/WSL.

### Validation

Reject at extension load time:

- empty IDs or executable name;
- non-positive integer limits;
- duplicate model IDs;
- empty model list;
- invalid model token metadata.

Perform all validation before registering the provider.

### Registration-time models

Always keep an `auto` entry that omits `--model`. Before provider registration, synchronously run `agy models`, parse exact slugs, merge them with configured entries, and pass the resulting ordinary `models` array to `registerProvider`. If discovery fails, `auto` must still remain available.

Do not depend solely on OMP `fetchDynamicModels`, because extension-only dynamic models have had cold-start resolution failures. The synchronous discovery here is outside that OMP path: it produces a static array for the current process before registration.

## Phase 4 — official process runner

Implement in `src/agy/runner.ts`.

### Arguments

Provider mode must produce an argument list equivalent to:

```bash
agy \
  -p "$PROMPT" \
  --output-format stream-json \
  --json-schema /tmp/.../response.schema.json \
  --agent omp-bridge-model \
  --model <slug-when-pinned> \
  --effort <optional> \
  --sandbox \
  --print-timeout 15m
```

Delegate mode omits `--json-schema` and normally omits `--agent` unless the caller explicitly supplies one.

Never concatenate a shell command string. Use `spawn(binary, args, options)` so the prompt is one literal process argument and shell metacharacters are not interpreted.

### Stdin/stdout/stderr

Use:

```text
stdin  = ignore
stdout = pipe, strict NDJSON
stderr = pipe, bounded diagnostics
```

Ignoring stdin prevents the child from waiting for input. Official headless mode must already be authenticated.

### Account environment

When `sanitizeAccountEnvironment` is true, remove known Gemini API-key and Vertex routing variables plus credential-shaped variables such as API keys, access tokens, passwords, cookies, and private-key variables. Preserve `HOME`, `PATH`, DBus/keyring variables, locale, and normal process essentials.

Support an explicit comma-separated `AGY_BRIDGE_PASSTHROUGH_ENV` escape hatch for variables the user has reviewed and intentionally wants the child to receive. A production successor should move to a tested allowlist rather than silently inheriting the full parent environment.

### Prompt size

Measure UTF-8 bytes before spawn. Fail with a clear compaction instruction when the prompt exceeds `maxPromptBytes`.

Do not write the prompt to disk in provider mode. The tool-less custom agent cannot read a prompt file, and adding file tools would violate the architecture.

### Schema temp file

Create an OS temporary directory, write only the response schema, and delete the directory in `finally`.

### Cancellation and timeout

- forward the OMP `AbortSignal`;
- send `SIGTERM` first;
- after `killGraceMs`, send `SIGKILL`;
- add a bridge hard timeout slightly above `--print-timeout`;
- remove listeners and timers after exit.

Create the child exit promise immediately after `spawn`. Do not attach the `exit` listener only after stdout finishes, because a fast child could exit before the listener is registered.

### NDJSON validation

Accept only top-level events:

```text
init
step_update
result
```

Require their matching payload objects. Reject malformed JSON and unknown event types.

Collect:

- all events;
- tool steps;
- reported subagents;
- bounded stderr;
- terminal result;
- exit and signal codes.

Require exactly one terminal result.

Success requires both:

```text
exit code == 0
terminal.status == SUCCESS
```

This still does not prove nested tools succeeded; delegate mode must surface tool errors and stderr.

## Phase 5 — prompt and context translation

Implement in `src/messages.ts`, `src/schema.ts`, and `src/prompt.ts`.

### Conversation serialization

Serialize:

- OMP system prompt sections;
- user messages;
- developer messages;
- assistant visible text;
- assistant tool calls;
- OMP tool results and error status.

Do not serialize:

- hidden/private thinking content;
- raw image base64;
- arbitrary object internals that cannot be safely encoded.

Replace unsupported images with a concise placeholder. Advertise the provider as text-only.

### History bounding

Always preserve the system prompt and most recent messages. When exceeding `maxHistoryChars`, omit oldest message blocks and insert a visible history-notice marker.

Do not independently summarize old messages inside the extension. OMP is responsible for semantic compaction.

### Tool catalog

For every active OMP tool include:

```json
{
  "name": "...",
  "description": "...",
  "parameters": { "type": "object" }
}
```

Attempt to convert omptype/ArkType/TypeBox-like parameters to JSON Schema. Support:

- `toJsonSchema(...)` when present;
- plain JSON Schema objects;
- known schema-holder properties as a fallback.

Bound description, individual schema, and whole-catalog sizes. When a schema is too large, replace it with a permissive object schema and a note. OMP remains the final argument validator.

### Terminal schema

Enforce an object with:

```json
{
  "text": "string",
  "tool_calls": [
    {
      "id": "optional string",
      "name": "one of current OMP tools",
      "arguments": {}
    }
  ],
  "finish_reason": "stop | tool_use"
}
```

Do not embed every full tool argument schema into the terminal schema in the MVP. Large or advanced tool schemas can make structured generation fragile. Restrict the name there and include argument schemas in the prompt.

### Local validation

After terminal generation, reject:

- non-object output;
- missing text/tool_calls/finish_reason;
- unknown OMP tool names;
- non-object arguments;
- non-string IDs;
- over 32 tool calls;
- `tool_use` with no calls;
- `stop` with calls.

Do not downgrade a validation failure to plain text.

## Phase 6 — native OMP stream translation

Implement in `src/provider.ts`.

### Start event

Create one mutable `AssistantMessage` and emit `start` immediately.

Populate:

```text
role = assistant
content = []
api = model.api
provider = model.provider
model = model.id
empty usage
stopReason = stop
timestamp = now
```

### Text blocks

For non-empty text:

```text
append {type: text, text}
emit text_start
emit text_delta
emit text_end
```

### Tool calls

For each validated call:

```text
append ToolCall with generated UUID when id missing
emit toolcall_start
emit toolcall_delta containing serialized arguments
emit toolcall_end
```

### Done

Use:

```text
stopReason = toolUse when any calls exist
stopReason = stop otherwise
```

Map official usage to OMP usage. Treat `cache_read_tokens` separately and document the assumption that non-cached OMP input is `max(0, input_tokens - cache_read_tokens)`. Costs are zero because the CLI does not expose per-request currency cost and this path is intended for subscription access.

### Error

On cancellation emit OMP `error` with reason `aborted`. On any other failure emit reason `error`. Include a useful message and duration. Do not call a fallback provider.

### Provider-mode harness check

After `agy` returns, if any Antigravity tool step or subagent was observed and strict mode is enabled, fail before emitting model output.

This catches a missing or ignored tool-less custom agent.

## Phase 7 — OMP-native subagent behavior

Do not create a custom subagent system in the bridge.

The model must call OMP's existing `task` tool. The prompt explicitly explains this.

Configure OMP roles, for example:

```yaml
modelRoles:
  default: official-agy/gemini-3.1-pro
  smol: official-agy/gemini-3.7-flash
  task: official-agy/gemini-3.7-flash
  slow: official-agy/gemini-3.1-pro
  plan: official-agy/gemini-3.1-pro
```

Then each OMP child session uses the bridge through its own normal provider calls.

Bound both:

```text
OMP task.maxConcurrency
bridge maxConcurrent
```

Do not let a model return dozens of parallel `task` calls unrestricted. The terminal parser's 32-call ceiling is a final emergency bound, not a recommended task fan-out.

## Phase 8 — delegate tool

Implement in `src/delegate-tool.ts`.

### Parameters

Accept:

```text
prompt (required)
model (optional exact slug)
effort (low|medium|high)
agent (optional)
conversation_id (optional; delegate mode only)
sandbox (optional)
```

### Progress mapping

On `init`, show model/conversation startup.

On `agent_response`, show bounded incremental text.

On `tool` steps, show tool name and retain bounded parameters/output/error in details.

On `subagent_info`, show role/type and retain conversation/log/workspace references.

### Result

Return final response text and structured details:

```text
conversationId
status
durationSeconds
usage
tools
subagents
stderr when non-empty
```

Explain in the tool description that this is a nested Antigravity harness, that it is not an OMP-native tool loop, and that OMP should independently verify consequential claims.

## Phase 9 — extension registration safety

Implement in `src/index.ts`.

Before any `registerProvider` call:

1. load and validate config;
2. construct semaphore;
3. construct stream closure;
4. resolve bundled agent path;
5. build static model definitions.

Then register optional tool and commands. Register the provider as the final operation in the factory.

Use:

```text
baseUrl = http://127.0.0.1/official-agy-cli
apiKey = non-secret local sentinel
api = unique custom API ID
streamSimple = bridge stream function
models = static definitions
```

The sentinel exists only to satisfy provider availability logic. It is never sent to Google.

## Phase 10 — commands and installation

Register:

```text
/agy-doctor
/agy-install-agent
```

`/agy-doctor` checks:

- `agy --version`;
- `agy models`;
- custom agent file existence;
- static exact model slugs against current model output.

`/agy-install-agent` must ask for confirmation before overwriting the global agent file.

Also keep standalone scripts for use before OMP loads:

```bash
npm run doctor
npm run install-agent -- --force
```

## Phase 11 — tests

### Unit tests already required

- NDJSON accepts documented events and rejects unknown ones.
- terminal output validates tool names and finish reason.
- tool schemas serialize and truncate safely.
- prompt states that OMP owns tools/subagents.
- oversized prompt fails before spawn.
- fake `agy` stream reaches a successful terminal result.

Run:

```bash
npm test
```

### Add these compatibility tests against installed OMP

Create an integration fixture extension or SDK test that:

1. loads the extension;
2. lists models and finds `official-agy/auto`;
3. replaces the configured binary with a fake executable;
4. sends a user prompt with a fake `read` tool;
5. verifies the provider emits a native OMP `ToolCall` named `read`;
6. supplies a tool result on the next turn;
7. verifies final text response;
8. aborts a slow fake process and verifies OMP sees `aborted`;
9. simulates a reported Antigravity tool step and verifies provider mode fails closed.

Do not mark the integration complete until these pass against the exact target OMP version.

### Live smoke tests

Run in a disposable git repository.

#### Text-only

```text
Reply with exactly BRIDGE_READY and use no tools.
```

#### Read

```text
Read README.md and report the first heading. Do not guess.
```

#### Edit

```text
Create bridge-smoke.txt containing one line: official agy bridge works. Then read it back.
```

Review OMP's native tool/edit cards. Confirm no Antigravity workspace tool step appears in bridge diagnostics.

#### OMP subagents

```text
Use task to launch two OMP subagents. One should inspect README.md, the other package.json. Return both exact first lines.
```

Verify:

- OMP shows normal task progress/artifacts;
- child sessions use intended role models;
- no child recursively uses Antigravity's native subagents;
- concurrency does not exceed configured bounds.

#### Delegate

Ask the OMP model to use `agy_delegate` for a read-only review. Verify Antigravity tool/subagent summaries appear inside one OMP tool card, not as native OMP read/edit calls.

## Acceptance criteria

Do not claim completion until all applicable boxes are true:

- [ ] `npm test` passes.
- [ ] Installed OMP loads the extension without warnings.
- [ ] `/model` lists at least `official-agy/auto`.
- [ ] `/agy-doctor` passes binary, model, and custom-agent checks.
- [ ] Provider mode uses the official binary visible in process inspection.
- [ ] Provider mode does not read or store Google OAuth tokens.
- [ ] Provider mode returns ordinary text.
- [ ] Provider mode requests and executes an OMP `read` call.
- [ ] Provider mode requests and executes an OMP edit and verification loop.
- [ ] Provider mode can request OMP `task` subagents.
- [ ] OMP child sessions use configured bridge model roles.
- [ ] Cancellation terminates the child and emits `aborted`.
- [ ] An unknown model slug fails loudly.
- [ ] Malformed or missing terminal NDJSON fails loudly.
- [ ] Unexpected Antigravity tool/subagent activity fails provider mode.
- [ ] No code path adds `--dangerously-skip-permissions`.
- [ ] `agy_delegate` surfaces nested tool/subagent progress and final details.
- [ ] README and troubleshooting describe prompt-size and non-streaming limitations honestly.

## Required commit sequence

Use small commits in this order:

1. `test: establish agy stream and schema fixtures`
2. `feat: add bounded official agy process runner`
3. `feat: serialize omp context and tool catalog`
4. `feat: register native-like official agy provider`
5. `feat: add official agy delegate tool`
6. `feat: add agent installer and doctor commands`
7. `test: add omp provider compatibility coverage`
8. `docs: document install security and limitations`

Do not combine all work into one unreviewable commit.

## Required behavior when a contract differs

If the installed OMP or `agy` contract differs from these instructions:

1. capture the exact command, version, type declaration, event line, or error;
2. write a failing regression test first;
3. make the smallest compatibility fix;
4. preserve the architecture and security boundaries;
5. update `docs/SOURCES.md` and troubleshooting;
6. do not invent a workaround that copies credentials or bypasses permissions.

## Production hardening backlog

After the MVP works, prioritize:

1. real OMP integration tests in CI;
2. cross-process concurrency locking;
3. per-session request and token budgets;
4. platform-specific process-tree cancellation;
5. explicit environment allowlist;
6. version capability probe for `agy` flags and event schema;
7. robust cached model discovery and capability probing as a supplement to the `auto` bootstrap;
8. metrics for queue wait, process startup, model latency, and failures;
9. prompt/context hashing to diagnose replay cost without logging content;
10. migration to an official SDK or documented IPC transport if it can preserve official authentication without argv limits.

## Definition of “as native as possible”

This implementation is successful when OMP—not Antigravity—renders and executes the tool loop, while the official `agy` binary remains the only component touching the Google account session.

It is not successful merely because OMP can run `agy -p` and print its final prose. That is only delegate mode.
