# Primary Sources Snapshot

Checked on 2026-08-18. Re-verify before publishing or relying on exact flags.

## Google Antigravity

- Headless mode: https://www.antigravity.google/docs/cli/headless
  - `agy -p` single-run behavior.
  - cached credentials.
  - `text`, `json`, and `stream-json` output.
  - terminal `structured_output` with `--json-schema`.
  - `init`, `step_update`, and `result` NDJSON events.
  - tool/subagent metadata.
  - model, effort, agent, sandbox, timeout, and conversation flags.
  - soft-denial and dangerous permission behavior.
- Installation and authentication: https://www.antigravity.google/docs/cli/install
  - official installer locations.
  - operating-system keyring session behavior.
- Background tasks and subagents: https://www.antigravity.google/docs/cli/subagents
- Custom subagent/agent format: https://www.antigravity.google/docs/subagents
  - `.agents/agents/...` and `~/.gemini/config/agents/...` discovery.
  - `tools`, `mainAgent`, `subagent`, `model`, and `commandExecutionPolicy` frontmatter.

## Oh My Pi

- Repository: https://github.com/can1357/oh-my-pi
- Extension API and provider registration:
  - `packages/coding-agent/src/extensibility/extensions/types.ts`
- AI message and stream event contracts:
  - `packages/ai/src/types.ts`
  - `packages/ai/src/utils/event-stream.ts`
  - `packages/ai/src/providers/mock.ts`
- Extension loading:
  - `docs/extension-loading.md`
  - `docs/extensions.md`
- Models and provider configuration:
  - `docs/models.md`
  - `docs/providers.md`
- OMP model roles:
  - `docs/settings.md`
- OMP `task` subagents:
  - `docs/tools/task.md`
- Dynamic extension model cold-start issue:
  - https://github.com/can1357/oh-my-pi/issues/4216
- Extension initialization partial-registration concern:
  - https://github.com/can1357/oh-my-pi/issues/7472

## Design consequence derived from the sources

The official CLI can emit machine-readable terminal structured output, and OMP extensions can register a custom model stream. Therefore a provider adapter can translate one terminal Antigravity response into native OMP message/tool-call events.

The sources do not expose a supported OMP extension method for arbitrary programmatic invocation of every active tool. Therefore this package returns tool calls to OMP's normal agent loop instead of attempting an unsupported external tool RPC.
