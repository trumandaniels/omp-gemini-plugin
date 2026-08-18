# Validation Record

Validated on **2026-08-18** in the artifact-generation environment.

## Automated checks completed

### Packaged source and unit/process suite

Command:

```bash
npm run check
```

Result: **PASS**

- 25 TypeScript source files were stripped with Node's TypeScript parser and syntax-checked as JavaScript modules.
- 20 tests passed.
- 0 tests failed, skipped, or were cancelled.

The suite covers:

- account-mode child-environment filtering and explicit passthrough;
- omission of private reasoning while preserving OMP tool-call/result identity;
- fail-closed history-size handling;
- `agy models` parsing and model-catalog merging;
- strict `init` / `step_update` / `result` NDJSON parsing;
- provider prompt ownership of OMP tools and `task` subagents;
- official-headless-style process spawning through a fake `agy` executable;
- oversized prompt rejection before process spawn;
- detection of nested Antigravity tool/subagent activity;
- event-callback failure and child termination;
- non-success terminal status rejection;
- terminal JSON-schema/tool-name/finish-reason validation;
- tool-schema truncation behavior;
- process-level concurrency and queued cancellation.

### Extension/provider runtime smoke test

Result: **PASS**

A temporary host shim loaded `src/index.ts`, captured the registered `official-agy` provider, invoked its `streamSimple` function with the packaged fake `agy`, and observed this OMP event sequence:

```text
start → text_start → text_delta → text_end → done
```

The final assistant text was `ok`. Temporary host shims were removed and are not included in the ZIP.

### Contract-level TypeScript check

Result: **PASS with a limitation**

The source was type-checked against temporary declarations mirroring the current OMP contracts inspected for:

- `ExtensionAPI.registerProvider`;
- `ProviderConfig.streamSimple`;
- `ToolDefinition.execute`;
- `Context`, `Model`, `SimpleStreamOptions`;
- `AssistantMessage`, `ToolCall`, and usage/event-stream shapes.

This catches internal strict-TypeScript mistakes, but it is **not a substitute** for running `npm install && npm run typecheck` against the exact OMP packages installed on the target machine.

### Package manifest dry run

Command:

```bash
npm pack --dry-run --json
```

Result: **PASS**

The declared extension entry, source, custom Antigravity agent, scripts, examples, and documentation are package-visible.

## Checks not performed here

The following require the user's machine and account, so they were not claimed as completed:

- live official `agy` authentication through the operating-system keyring;
- a real Google AI Pro model request;
- current account quota and model entitlement;
- live `agy models` and `agy agents` output;
- loading through the user's exact OMP build;
- native OMP read/edit/bash tool loops against a live Gemini response;
- real OMP `task` fan-out through this provider;
- native Windows process-tree behavior.

Run these after extraction:

```bash
agy --version
agy models
agy agents
npm run install-agent -- --force
npm install
npm run typecheck
npm run doctor:live
omp --extension "$PWD"
```

Then complete the live acceptance sequence in `IMPLEMENTATION_INSTRUCTIONS.md` inside a disposable repository.

## Status statement

The ZIP contains a tested **working prototype of the bridge mechanics**. It does not claim live compatibility with an unobserved OMP/Antigravity installation or access to the user's Google account.
