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

Those numbers describe the original baseline. They must not be presented as the current branch's full-suite result after later parser and image-transport changes.

## Current parser and image-transport changes

The current change set adds regression coverage for:

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

A focused standalone harness for the new image-capability, staging, cleanup, serialization, and prompt-mapping helpers completed with:

```text
10 passed
0 failed
```

The exact repository tests representing these cases are under:

```text
test/config.test.ts
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

The GitHub connector environment used to publish this branch cannot clone the repository or install dependencies, so it did **not** rerun the complete repository suite or exact peer-package typecheck after the image changes. Do not replace this statement with a claimed full pass until the commands above have actually completed against the branch.

## Live acceptance required for image input

Unit tests validate the bridge-controlled mechanics: capability registration, decoding, staging, prompt construction, limits, and cleanup. They do not prove that a particular authenticated AGY build resolves `@file` media mentions in print mode.

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

The repository contains a tested prototype of the bridge-controlled parser and image-staging mechanics. Live compatibility with the user's authenticated AGY build, exact OMP installation, and account-selected model remains an acceptance requirement rather than an assumed fact.
