# Known Limitations

## It is not a raw model transport

The official `agy` executable invokes the Antigravity agent harness. Provider mode constrains that harness to a tool-less custom agent, but process startup, Antigravity system context, checkpointing, and account-side orchestration may still add latency and tokens compared with a direct model API.

## Structured responses are terminal

The official CLI applies `--json-schema` to the terminal result. Native OMP text/tool-call events are emitted after validation, not token by token.

## Full context is replayed

Provider calls are stateless. OMP's bounded context is serialized for every model turn. This is correct for OMP branch semantics but expensive.

## Prompt travels through argv

The CLI exposes `-p/--prompt`; this prototype therefore passes the prompt as one child-process argument. Linux/WSL allows substantially more than native Windows. Large histories must be compacted.

A production successor should use an official SDK, a documented stdin mode, or a local authenticated sidecar protocol if Google exposes one.

## Text input only

The provider advertises only `text` input. OMP image blocks are replaced with placeholders in defensive serialization. The current headless CLI contract does not provide this bridge with a clean native attachment channel while the custom agent has no file tools.

## Tool schemas are bounded

The model prompt contains bounded schemas. The enforced terminal schema restricts tool names and object-shaped arguments, while OMP remains responsible for exact argument validation. Complex or huge schemas may be replaced with a permissive object placeholder plus the tool description.

## Static model bootstrap

Extension-only dynamic provider models have had cold-start resolution problems in OMP. The package always registers `auto`, synchronously runs `agy models`, and turns the result into a normal registration-time model array. Parsing may need updates if the official table format changes; configured model entries remain available as overrides.

## Concurrency is local to one OMP process

The semaphore does not coordinate multiple OMP processes. Parallel terminals can exceed intended `agy` concurrency.

## Delegate mode is opaque

Antigravity's own tools and subagents are visible only through its stream summaries and final result. They do not become native OMP tools, approvals, or edit cards.

## No general OMP tool RPC

The current extension API does not expose a supported arbitrary tool dispatcher for external processes. The bridge can return OMP `ToolCall` objects to the normal agent loop; it cannot call any tool directly from an Antigravity nested loop.

## Protocol drift

Official `stream-json` is documented, but new event types or field changes can occur. The runner currently rejects unknown top-level event types. Update fixtures and parsing deliberately rather than swallowing drift.

## Not verified against your account

The included tests use a fake `agy` executable. They verify process/event/schema behavior but cannot verify your Google entitlement, keyring, quota, model list, or organization policy.
