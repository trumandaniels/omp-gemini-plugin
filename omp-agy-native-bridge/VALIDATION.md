# Validation Record

## Historical baseline

The original packaged prototype was validated on **2026-08-18** in the artifact-generation environment with:

```bash
npm run check
```

That baseline reported:

- 25 TypeScript files stripped and syntax-checked;
- 20 tests passed;
- 0 tests failed, skipped, or cancelled;
- a temporary provider-runtime smoke test completed with `start → text_start → text_delta → text_end → done`;
- a contract-level TypeScript check against temporary OMP declarations passed;
- `npm pack --dry-run --json` passed.

Those numbers describe the original baseline. They must not be presented as the current branch's full-suite result after later parser, image-transport, or harness-isolation changes.

## Current parser and image-transport changes

The current code includes regression coverage for:

- concatenated AGY bridge objects;
- truncated completion chatter after a valid first object;
- bridge JSON nested inside the outer `text` field;
- recovery of nested OMP tool calls without accepting unavailable tools;
- ordinary JSON/prose remaining user-visible;
- explicit Gemini image-capability inference;
- `capabilities.image`, `capabilities.vision`, and `supportsImages` overrides;
- conservative treatment of `official-agy/auto`;
- image-block detection;
- base64 and matching data-URL decoding;
- supported media-type validation;
- image-count and aggregate-byte limits;
- private workspace staging and cleanup;
- conversation placeholders that omit raw image bytes;
- AGY `@file` prompt-media mapping;
- bridge configuration validation for image capability fields.

A focused standalone harness for the image-capability, staging, cleanup, serialization, and prompt-mapping helpers completed with:

```text
10 passed
0 failed
```

## Current provider-harness isolation changes

The current branch additionally covers the reported fail-closed error where AGY emitted tool steps despite provider mode selecting the tool-less bridge agent.

Changes under test:

- the bundled markdown agent explicitly disables `inheritCustomizations`;
- legacy `inherit_user` and `inheritMcp` opt-outs remain for compatibility;
- MCP servers, skills, plugins, rules, shell execution, and subagent invocation are explicitly disabled;
- the doctor compares the installed agent file with the bundled definition instead of checking existence alone;
- the runtime guard names unexpected tools and collapses repeated `ACTIVE`/`DONE` updates for the same invocation;
- only read-only AGY operations targeting an exact staged image file, or its private staging directory, are accepted as media hydration;
- reads outside staged media, writes, commands, searches, MCP calls, and subagents still fail closed.

A focused Node 22 test run covering the new agent-definition, stale-file, lifecycle-deduplication, exact-media-read, out-of-scope-read, write-rejection, subagent-rejection, and error-diagnostic helpers completed with:

```text
11 passed
0 failed
```

The exact repository tests representing the current parser, media, and isolation cases include:

```text
test/agent-definition.test.ts
test/agent-install.test.ts
test/config.test.ts
test/harness-guard.test.ts
test/media.test.ts
test/messages.test.ts
test/model-capabilities.test.ts
test/nested-output.test.ts
test/prompt.test.ts
test/schema.test.ts
```

## Required repository checks before merge/release

Run from `omp-agy-native-bridge/` in a checkout of the current branch:

```bash
npm run check:source
npm test
npm install
npm run typecheck
npm pack --dry-run --json
```

The GitHub connector environment used to publish this branch cannot clone the repository or install its exact peer dependencies, so it did **not** rerun the complete repository suite or exact-package typecheck after the harness-isolation changes. Do not replace this statement with a claimed full pass until the commands above have actually completed against the branch.

## Live acceptance required for provider isolation

On the same machine and account used by OMP:

```bash
git pull
cd omp-agy-native-bridge
npm run install-agent -- --force
npm run doctor:live
```

Then fully terminate all OMP and AGY processes and start a new OMP session.

Acceptance criteria:

- `doctor` reports `PASS tool-less bridge agent contents`;
- a plain provider request emits no AGY tool or subagent steps;
- an OMP repository task is returned as an OMP-native tool call rather than executed inside AGY;
- an image turn may hydrate only its exact `.omp-agy-media-*` attachment files through a read-only AGY operation;
- any other AGY operation is rejected with unique tool name(s) and lifecycle-update count;
- `rejectAgyToolUseInProviderMode` remains enabled.

## Live acceptance required for image input

Unit tests validate the bridge-controlled mechanics: capability registration, decoding, staging, prompt construction, limits, cleanup, and exact staged-media tool scoping. They do not prove that a particular authenticated AGY build resolves `@file` media mentions in print mode.

Run these checks in the same environment where OMP runs:

```bash
agy --version
agy models
agy agents
npm run install-agent -- --force
npm run doctor:live
```

Then, in a disposable directory containing a small PNG:

```bash
agy -p "Describe @./test.png in one sentence." --output-format json --print-timeout 2m
```

If the direct command succeeds, configure OMP:

```yaml
modelRoles:
  vision: official-agy/gemini-3.7-flash
```

Restart OMP and test both paths:

1. attach/paste an image into a normal session using `official-agy/gemini-3.7-flash`;
2. invoke OMP's `inspect_image` tool against the same image.

Acceptance criteria:

- `/model` or model inspection reports the explicit Gemini bridge model as image-capable;
- `inspect_image` does not reject the model before invocation;
- the model describes visible image content rather than only the placeholder text;
- no raw base64 appears in prompts or rendered output;
- `.omp-agy-media-*` is removed after success, provider error, and cancellation;
- unsupported or oversized image inputs fail before AGY launch;
- no AGY tool may access anything outside the exact staged-media files;
- OMP tools and permissions remain authoritative.

## Other live checks not performed here

The following still require the user's machine and account:

- live official `agy` authentication through the operating-system keyring;
- a real account-backed Gemini model request;
- current account quota and model entitlement;
- loading through the user's exact OMP build;
- native OMP read/edit/bash tool loops against a live Gemini response;
- real OMP `task` fan-out through this provider;
- native Windows process-tree behavior;
- headless AGY media handling for every supported image format.

## Status statement

The repository contains tested bridge-controlled parser, image-staging, stale-agent detection, narrowly scoped media hydration, and harness-diagnostic mechanics. Live compatibility with the user's authenticated AGY build, exact OMP installation, and account-selected model remains an acceptance requirement rather than an assumed fact.
