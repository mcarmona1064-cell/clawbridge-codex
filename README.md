<p align="center">
  <img src="assets/clawbridge-logo.png" alt="ClawBridge" width="400">
</p>

<p align="center">
  ClawBridge Codex — self-hosted, multi-channel AI agents powered by OpenAI Codex.
</p>

<p align="center">
  <a href="https://clawbridge.dev">clawbridge.dev</a>&nbsp; • &nbsp;
  <a href="https://docs.clawbridge.dev">docs</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="README_ja.md">日本語</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="repo tokens" valign="middle"></a>
</p>

---

## Why I Built ClawBridge

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project, but I wouldn't have been able to sleep if I had given complex software I didn't understand full access to my life. OpenClaw has nearly half a million lines of code, 53 config files, and 70+ dependencies. Its security is at the application level rather than true OS-level isolation.

ClawBridge keeps the useful parts — message routing, persistent context, channels, tools, and scheduled work — while staying small enough to understand. Codex agents run in isolated Linux containers with explicit filesystem mounts.

## Quick Start

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/mcarmona1064-cell/clawbridge-codex/main/clawbridge.sh)
```

One command checks/install prerequisites where supported, then launches the interactive setup wizard.

If you already have Node installed:

```bash
npx clawbridge-codex
```

If installed globally:

```bash
clawbridge-codex
```

To migrate from an existing OpenClaw or NanoClaw install, choose the migration path in the setup wizard.

---

## Features

- 🤖 **Multi-channel AI agents** — Telegram, WhatsApp, Discord, Slack, and more
- 🤖 **OpenAI Codex CLI integration** — agents run through `@openai/codex` inside isolated containers
- 🔐 **Subscription OAuth** — setup runs `codex login --device-auth`; the runtime avoids accidental API-key billing
- 🧠 **Optional semantic memory** — Hindsight retain/recall/reflect memory can be enabled during setup
- 🔌 **Connect your tools** — Google, HubSpot, Slack, and more via MCP
- 👁 **Vision and document analysis** via GPT-4o
- 🔒 **Container-isolated, self-hosted** — your data stays yours, agents run in Docker sandboxes
- 🛡️ **Prompt injection protection** — built-in guards against malicious message injection attacks
- 🤝 **Multi-agent orchestration** — agents can delegate tasks, pass files, and run parallel workflows
- ⚡ **Skills system** — browser automation, web search, scheduling, self-customization, and more
- 🚀 **Migrate from OpenClaw or NanoClaw** in minutes

## Architecture

```
messaging apps → host process (router) → inbound.db → container (Bun, Codex) → outbound.db → host process (delivery) → messaging apps
```

A single Node host orchestrates per-session agent containers. Agents run in Docker with explicit filesystem mounts. Codex auth is copied from host `~/.codex/auth.json` into the per-agent-group `.codex` state directory and mounted at `/home/node/.codex`; channel tokens and host-only settings live in `~/.clawbridge/.env`. See [docs/architecture.md](docs/architecture.md) for the full writeup.

## AI Provider

ClawBridge uses OpenAI Codex via the official `@openai/codex` CLI. Setup installs the CLI if needed and runs:

```bash
codex login --device-auth
```

Agent containers run `codex exec --json` / `codex exec resume --json`. The Codex subprocess strips `OPENAI_API_KEY`, `CODEX_API_KEY`, and `OPENAI_BASE_URL` from its environment so the agent runtime stays on subscription OAuth instead of silently switching to API-key billing.

## Setup, health checks, and upgrades

Setup is interactive by default:

```bash
clawbridge-codex
```

During setup ClawBridge:

- verifies Docker and Node
- installs `@openai/codex` if missing
- authenticates Codex with `codex login --device-auth`
- creates `~/.clawbridge/.env`
- links `~/.clawbridge/docker-compose.yml` to the installed package so upgrades pick up compose changes
- optionally enables Hindsight semantic memory
- builds the agent container image
- starts the background service with launchd on macOS or systemd on Linux
- verifies the service, agent, and selected channel

Run a health check any time:

```bash
clawbridge-codex doctor
```

Run auto-fix mode for repairable problems:

```bash
clawbridge-codex doctor --fix
```

`doctor --fix` can restart the background service, start Hindsight containers, rebuild a missing agent image, recreate the docker-compose symlink, restart channel connections, and normalize Hindsight model settings.

Upgrade to the latest release:

```bash
clawbridge-codex upgrade
# or
clawbridge-codex update
```

Upgrade checks npm for the latest version, stops the running service, installs the latest `clawbridge-codex` package, refreshes the compose symlink, rebuilds the agent image, restarts the service, and runs `doctor`. Your `~/.clawbridge` data, conversations, and memories are preserved.

## Memory and Hindsight

Every agent group has persistent files, including `AGENTS.local.md`, Codex session state, and conversation history. For semantic memory, setup can enable Hindsight. Hindsight runs as host-side Docker services (`hindsight-api` and `hindsight-db`), not inside the agent container. The host retrieves memory and injects relevant context into each agent turn.

If Hindsight is configured, `clawbridge-codex doctor` checks the containers and `/health`; `doctor --fix` can start the containers and set the default OpenAI model env vars. Retain/recall default to `gpt-4o-mini`; reflect defaults to `gpt-4o`.

## Philosophy

**Small enough to understand.** One process, a few source files, and no microservices. If you want to understand the full ClawBridge codebase, ask Codex to walk you through it.

**Secure by isolation.** Agents run in Linux containers and can only see what is explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for the individual user.** ClawBridge is designed to be bespoke. You can fork it and have Codex modify it to match your exact workflow.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that changes are reviewable.

**Best harness, best model.** ClawBridge natively uses the OpenAI Codex CLI via subscription OAuth, so you get GPT models and Codex's toolset, including the ability to modify and expand your own ClawBridge fork.

## What It Supports

- **Multi-channel messaging** — WhatsApp, Telegram, Discord, Slack, Microsoft Teams, Matrix, Google Chat, Webex, Linear, GitHub, WeChat, and email via Resend
- **Flexible isolation** — connect each channel to its own agent, share one agent across many channels, or fold multiple channels into a single shared session
- **Per-agent workspace** — each agent group has its own persona, memory, container, and allowed mounts
- **Scheduled tasks** — recurring jobs that run Codex and can message you back
- **Web access** — search and fetch content from the web
- **Container isolation** — agents are sandboxed in Docker, with optional Docker Sandboxes or Apple Container support
- **Credential security** — Codex uses subscription OAuth from `~/.codex/auth.json`; channel credentials remain host-side in `~/.clawbridge/.env`; Hindsight credentials are not passed into agent containers

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From a channel you own or administer, you can manage groups and tasks:

```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

## Customizing

Edit `~/.clawbridge/groups/main/AGENTS.local.md` to customize your agent's persona. The file is created with a default template on first run.

You can change:

- agent name and personality
- background knowledge about you or your team
- behavioral preferences and response style

For code-level changes, ask Codex from your checkout or use `/customize` if that skill is installed.

## Requirements

- macOS, Linux, or Windows via WSL2
- Node.js 20+; pnpm is only needed for local development from a checkout
- Docker Desktop on macOS/Windows, or Docker Engine on Linux
- [Codex CLI](https://github.com/openai/codex) — setup installs it if missing and authenticates with `codex login --device-auth`

## Key Files

- `src/index.ts` — entry point: DB init, channel adapters, delivery polls, sweep
- `src/router.ts` — inbound routing: messaging group → agent group → session → `inbound.db`
- `src/delivery.ts` — polls `outbound.db`, delivers via adapter, handles system actions
- `src/host-sweep.ts` — 60s sweep: stale detection, due-message wake, recurrence
- `src/session-manager.ts` — resolves sessions, opens `inbound.db` / `outbound.db`
- `src/container-runner.ts` — spawns per-agent-group Codex containers
- `src/providers/` — host-side provider config; Codex is built in
- `src/db/` — central DB: users, roles, agent groups, messaging groups, wiring, migrations
- `src/channels/` — channel adapter infra
- `container/agent-runner/` — Bun runner: poll loop, MCP tools, provider abstraction
- `container/Dockerfile` — Codex container image
- `groups/<folder>/` — per-agent-group filesystem: persona, memory, skills, container config

## FAQ

**Why Docker?**

Docker provides cross-platform support and a mature ecosystem. On macOS, you can optionally switch to Apple Container via `/convert-to-apple-container` for a lighter-weight native runtime.

**Can I run this on Linux or Windows?**

Yes. ClawBridge runs on macOS and Linux VPS hosts. Windows via WSL2 also works.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. Host-side Hindsight and channel credentials do not get passed into agent containers.

**Do I need to pay per message?**

No for the agent runtime. ClawBridge uses Codex subscription OAuth, not API-key billing, for agent execution.

**Can I use third-party or open-source models?**

Yes. Use `/add-ollama-provider` for local open-weight models via Ollama.

**How do I debug issues?**

Start with:

```bash
clawbridge-codex doctor
clawbridge-codex doctor --fix
```

Doctor checks Docker, the background service, Codex auth, Hindsight, channels, storage, and the agent image. If a check still fails, inspect logs under `~/.clawbridge/logs/`.

**Why isn't setup working for me?**

Re-run setup after fixing the reported prerequisite, or run `clawbridge-codex doctor --fix` for repairable issues. Common fixes are starting Docker Desktop, re-running `codex login --device-auth`, or restarting the launchd/systemd service.

## Contributing

Security fixes, bug fixes, and clear improvements are welcome. Larger capabilities should be contributed as skills or maintained in a fork.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes, or the [full release history](https://docs.clawbridge.dev/changelog) on the documentation site.

## License

MIT
