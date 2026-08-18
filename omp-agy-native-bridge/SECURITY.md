# Security Model

## Credential boundary

The bridge never reads or persists Google OAuth tokens.

Authentication remains:

```text
OMP extension → spawn official agy → official agy reads OS keyring → Google
```

The bridge stores no copied refresh token, access token, browser cookie, or Google password. Treat the `agy` binary and its keyring session as the trust boundary.

## Account-backed mode

`sanitizeAccountEnvironment` defaults to `true`. The child environment removes known Gemini API-key/Vertex routing variables and credential-shaped environment names. The explicitly enumerated account-routing variables include:

```text
GEMINI_API_KEY
GOOGLE_API_KEY
GOOGLE_GENAI_USE_VERTEXAI
GOOGLE_APPLICATION_CREDENTIALS
GOOGLE_CLOUD_PROJECT
GOOGLE_CLOUD_LOCATION
VERTEX_AI_PROJECT
VERTEX_AI_LOCATION
```

This reduces accidental switching from a signed-in subscription session to a metered API configuration. It does not prove which account or billing route Google ultimately uses. Verify your local `agy` configuration and usage page.

It also strips names shaped like API keys, tokens, passwords, cookies, credentials, secrets, and private keys. Set the option to `false` only for an intentional trusted deployment, or retain reviewed variables individually with comma-separated `AGY_BRIDGE_PASSTHROUGH_ENV`.

## Provider-mode privilege separation

Provider mode installs a custom Antigravity agent with:

```yaml
tools: []
subagent: false
commandExecutionPolicy: off
```

The runtime prompt repeats the boundary. The bridge fails closed if the official stream reports Antigravity tool steps or subagents while provider mode is active.

This gives defense in depth:

1. custom-agent capability restriction;
2. runtime system instruction;
3. structured terminal schema;
4. stream inspection;
5. OMP tool argument validation and permissions.

## Never use the dangerous flag

The provider and delegate implementations do not pass:

```text
--dangerously-skip-permissions
```

Official headless mode may soft-deny tools that require approval and still exit successfully. Delegate mode includes stderr and tool errors in its details so the parent OMP model can detect incomplete work. Provider mode should use no Antigravity tools at all, so a soft-denial notice indicates configuration drift.

## Prompt injection

All repository text and tool output included in the reconstructed OMP context is untrusted data. The bridge prompt establishes that:

- OMP system instructions outrank repository content;
- Antigravity cannot execute its own tools in provider mode;
- requests for action must become OMP tool calls;
- the model must not fabricate results.

This reduces but does not eliminate model-level prompt injection. OMP's own approval, sandbox, and workspace policies remain necessary.

## Extension loading risk

OMP extensions run in-process and are not sandboxed. Review this package before installation.

The extension performs all potentially throwing configuration work before registering the provider, and registers the provider last. This limits exposure to OMP versions where a failed extension initialization may preserve provider registrations made before the failure.

## Subprocess environment

With sanitization enabled, the child inherits normal process values such as `PATH`, `HOME`, locale, and keyring/session-bus plumbing, but credential-shaped variables are removed unless explicitly passed through. This is safer than copying the full OMP environment, although name-based filtering cannot classify every secret.

A production hardening pass should replace the denylist with a tested explicit allowlist. Do not remove Linux DBus/keyring variables blindly or account authentication may stop working.

## Temporary files

Provider mode writes only the JSON response schema into a fresh operating-system temporary directory. It does not write prompts or tokens to disk. The directory is removed in `finally`.

OMP itself may persist conversation histories containing user prompts and tool results according to normal OMP settings.

## Workspace access

Provider-mode `agy` is launched with `--sandbox`, but the principal protection is the tool-less custom agent. The prompt contains repository excerpts already obtained by OMP; Antigravity should not inspect the workspace independently.

Delegate mode is different: the normal Antigravity harness may read/write the active workspace under its settings and permissions. Use a disposable worktree or read-only prompt for risky tasks.

## Denial of service and quotas

Every OMP model turn creates a process and consumes Antigravity quota. Tool loops and OMP subagents multiply that load. The semaphore limits concurrent processes but not total turns.

Add run budgets, per-session request ceilings, and cross-process concurrency before unattended or overnight operation.

## Output validation

Provider mode rejects:

- malformed NDJSON;
- unknown stream event types;
- missing or multiple terminal result events;
- non-success terminal status;
- unavailable OMP tool names;
- non-object tool arguments;
- inconsistent finish reasons;
- more than 32 tool calls in one model turn;
- unexpected Antigravity tool/subagent activity.

Fail closed rather than falling back to raw text or another provider.
