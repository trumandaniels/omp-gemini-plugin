# OMP ↔ Official Antigravity CLI Bridge

An [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) extension that connects OMP to the official Google Antigravity `agy` CLI.

The bridge keeps OMP in control of conversation history, tools, permissions, edits, and subagents while using an authenticated `agy` installation for model access.

## Integrations

- **`official-agy/*` provider** — Runs a tool-less Antigravity model shim and translates its structured response into native OMP text and tool calls. OMP executes the calls through its normal agent loop.
- **`agy_delegate` tool** — Delegates a bounded task to the normal Antigravity harness, including its own tools and subagents. This is intentionally nested-agent mode, not native OMP integration.

## Requirements

- OMP with extension provider support.
- Node.js 22+ for local scripts and tests.
- The official `agy` CLI installed and authenticated in the same environment as OMP.
- Linux or WSL is recommended because native Windows process-tree behavior differs.

The bridge does not read or store Google credentials. Authentication remains inside the official `agy` process and its operating-system keyring session.

## Install

From the repository root:

```bash
sfw-npm install
sfw-npm run install-agent -- --force
omp plugin install "$PWD"
omp plugin doctor
```

Restart OMP after installing the extension or custom Antigravity agent. For a one-off run without installing the plugin:

```bash
omp --extension "$PWD"
```

Inside OMP, open `/models`, run `/agy-doctor`, then select `official-agy/auto` or a discovered `official-agy/<model>` entry.

## Configuration

Copy the example configuration when you need model pins, role settings, or runtime limits:

```bash
mkdir -p .omp
cp examples/agy-bridge.json .omp/agy-bridge.json
```

Project configuration is loaded from `.omp/agy-bridge.json`; user configuration may be stored at `~/.omp/agent/agy-bridge.json`. Environment variables can override both. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for operational checks and [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) for CLI-boundary constraints.

## Development

```bash
sfw-npm test
sfw-npm run check
sfw-npm run typecheck
```

The test suite uses a fake `agy` process. Live model access still requires your OMP installation, authenticated Antigravity account, current model entitlement, and local CLI behavior; this repository does not claim those checks pass automatically.

## Documentation

- [Architecture](ARCHITECTURE.md) — state ownership and provider/delegate data flow.
- [Security model](SECURITY.md) — credential boundaries, process isolation, and fail-closed behavior.
- [Troubleshooting](TROUBLESHOOTING.md) — diagnosis by symptom.
- [Known limitations](docs/KNOWN_LIMITATIONS.md) — behavior imposed by the official CLI boundary.
