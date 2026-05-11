<p align="center">
  <img src="assets/clawbridge-logo.png" alt="ClawBridge" width="400">
</p>

<p align="center">
  ClawBridge Agent — AI agent platform for businesses. Self-hosted, multi-channel, container-isolated.
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

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project, but I wouldn't have been able to sleep if I had given complex software I didn't understand full access to my life. OpenClaw has nearly half a million lines of code, 53 config files, and 70+ dependencies. Its security is at the application level (allowlists, pairing codes) rather than true OS-level isolation. Everything runs in one Node process with shared memory.

ClawBridge provides that same core functionality, but in a codebase small enough to understand: one process and a handful of files. Claude agents run in their own Linux containers with filesystem isolation, not merely behind permission checks.

## Quick Start

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/other2368-byte/clawbridge-agent/main/clawbridge.sh)
```

One command — installs Node, pnpm, and Docker if missing, then walks you through setup interactively. Works on a fresh machine.

Or if you already have Node installed:

```bash
npx clawbridge-agent setup
```

To migrate from an existing install:

```bash
npx clawbridge-agent setup --migrate
```

---

## 🏢 Need a Managed Setup?

Don't want to deal with servers, Docker, and configuration? **Clawbridge Agency** handles everything for you — VPS provisioning, full installation, channel setup, custom AI persona, and ongoing support.

| | Self-Host | Managed by Clawbridge Agency |
|---|---|---|
| Setup | You do it | We handle everything |
| Updates | `clawbridge upgrade` | Done for you |
| Channel config | DIY | Included |
| Custom persona & memory | DIY | Included |
| Support | Community / GitHub | Direct email |

🌐 **[clawbridgeagency.com](https://clawbridgeagency.com)** • 📩 **[hello@clawbridgeagency.com](mailto:hello@clawbridgeagency.com)**

---

## Features

- 🤖 **Multi-channel AI agents** — Telegram, WhatsApp, Discord, Slack, iMessage, 15+ more
- 🔀 **Two AI backends** — Claude (Anthropic OAuth) or OpenAI Codex (ChatGPT Plus/Pro OAuth) — no per-message API billing, uses your existing subscription
- 🧠 **Persistent memory** — Hindsight memory system with retain, recall, and reflect — agents remember context across sessions
- 🔌 **Connect your tools** — Google, HubSpot, Slack, and more via MCP
- 📞 **Voice agents** via Retell AI
- 👁 **Vision & document analysis** via Claude
- 🔒 **Container-isolated, self-hosted** — your data stays yours, agents run in Docker sandboxes
- 🛡️ **Prompt injection protection** — built-in skill guards against malicious message injection attacks
- 🤝 **Multi-agent orchestration** — agents can delegate tasks to other specialist agents, pass files between them, and run parallel workflows
- ⚡ **In-session subagents** — Claude and Codex spawn parallel subagents natively within a single session for faster task execution, no extra setup needed
- ⚡ **Skills system** — browser automation, web search, scheduling, self-customization, and more
- 🚀 **Migrate from OpenClaw or NanoClaw** in minutes

## Architecture

```
messaging apps → host process (router) → inbound.db → container (Bun, Claude/Codex Agent) → outbound.db → host process (delivery) → messaging apps
```

A single Node host orchestrates per-session agent containers. Agents run in Docker with explicit filesystem mounts. Credentials are injected directly from `~/.clawbridge/.env` into container environment variables at spawn time. See [docs/architecture.md](docs/architecture.md) for the full writeup.

## AI Provider Choice

ClawBridge supports two AI backends. You choose during setup — no switching required after install.

### Claude (Anthropic OAuth)
Uses your existing **Claude Pro/Max subscription** — no API billing. Authenticate once with `claude setup-token`. Hindsight memory uses Claude Haiku for retain/recall and Sonnet for reflect.

### OpenAI Codex (ChatGPT OAuth)
Uses your existing **ChatGPT Plus or Pro subscription** — no API billing. Authenticate once with `codex login --device-auth`. Hindsight memory uses `gpt-4.1-mini` for all operations.

Both providers are fully isolated — choosing one won't interfere with the other.

## Philosophy

**Small enough to understand.** One process, a few source files and no microservices. If you want to understand the full ClawBridge codebase, just ask Claude Code to walk you through it.

**Secure by isolation.** Agents run in Linux containers and they can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for the individual user.** ClawBridge isn't a monolithic framework; it's software that fits each user's exact needs. Instead of becoming bloatware, ClawBridge is designed to be bespoke. You make your own fork and have Claude Code modify it to match your needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that it's safe to make changes.

**AI-native, hybrid by design.** The install and onboarding flow is an optimized scripted path, fast and deterministic. When a step needs judgment, whether a failed install, a guided decision, or a customization, control hands off to Claude Code seamlessly. Beyond setup there's no monitoring dashboard or debugging UI either: describe the problem in chat and Claude Code handles it.

**Skills over features.** Trunk ships the registry and infrastructure, not specific channel adapters or alternative agent providers. Channels (Discord, Slack, Telegram, WhatsApp, …) live on a long-lived `channels` branch; alternative providers (OpenCode, Ollama) live on `providers`. You run `/add-telegram`, `/add-opencode`, etc. and the skill copies exactly the module(s) you need into your fork. No feature you didn't ask for.

**Best harness, best model.** ClawBridge natively uses Claude Code via Anthropic's official Claude Agent SDK, so you get the latest Claude models and Claude Code's full toolset, including the ability to modify and expand your own ClawBridge fork. Other providers are drop-in options: OpenAI Codex (ChatGPT Plus/Pro subscription), `/add-opencode` for OpenRouter, Google, DeepSeek and more via OpenCode, and `/add-ollama-provider` for local open-weight models. Provider is configurable per install.

## What It Supports

- **Multi-channel messaging** — WhatsApp, Telegram, Discord, Slack, Microsoft Teams, iMessage, Matrix, Google Chat, Webex, Linear, GitHub, WeChat, and email via Resend. Installed on demand with `/add-<channel>` skills. Run one or many at the same time.
- **Flexible isolation** — connect each channel to its own agent for full privacy, share one agent across many channels for unified memory with separate conversations, or fold multiple channels into a single shared session so one conversation spans many surfaces. Pick per channel via `/manage-channels`. See [docs/isolation-model.md](docs/isolation-model.md).
- **Per-agent workspace** — each agent group has its own persona, its own memory, its own container, and only the mounts you allow. Nothing crosses the boundary unless you wire it to.
- **Scheduled tasks** — recurring jobs that run Claude or Codex and can message you back
- **Web access** — search and fetch content from the web
- **Container isolation** — agents are sandboxed in Docker (macOS/Linux/WSL2), with optional [Docker Sandboxes](docs/docker-sandboxes.md) micro-VM isolation or Apple Container as a macOS-native opt-in
- **Credential security** — agents never hold raw API keys. Credentials are injected directly from ~/.clawbridge/.env at container spawn time, so the agent process never sees them as environment variables it can exfiltrate.

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

## Customizing your agent

Edit `~/.clawbridge/groups/main/CLAUDE.local.md` (Claude) or `AGENTS.local.md` (Codex) to customize your agent's persona. This is the only file you need to touch — the system configuration is managed automatically.

The file is created with a default template on first run. Open it and change anything:
- Agent name and personality
- Background knowledge about you or your team
- Behavioral preferences and response style

## Customizing

ClawBridge doesn't use configuration files. To make changes, just tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

## Contributing

**Don't add features. Add skills.**

If you want to add a new channel or agent provider, don't add it to trunk. New channel adapters land on the `channels` branch; new agent providers land on `providers`. Users install them in their own fork with `/add-<name>` skills, which copy the relevant module(s) into the standard paths, wire the registration, and pin dependencies.

This keeps trunk as pure registry and infra, and every fork stays lean — users get the channels and providers they asked for and nothing else.

### RFS (Request for Skills)

Skills we'd like to see:

**Communication Channels**
- `/add-signal` — Add Signal as a channel

## Requirements

- macOS or Linux VPS (Ubuntu, Debian, CentOS — any distro with Docker)
- Node.js 20+ and pnpm 10+ (the installer will install both if missing)
- [Docker Desktop](https://docker.com/products/docker-desktop) (macOS/Windows) or Docker Engine (Linux)
- [Claude Code](https://claude.ai/download) for `/customize`, `/debug`, error recovery during setup, and all `/add-<channel>` skills

## Key Files

- `src/index.ts` — entry point: DB init, channel adapters, delivery polls, sweep
- `src/router.ts` — inbound routing: messaging group → agent group → session → `inbound.db`
- `src/delivery.ts` — polls `outbound.db`, delivers via adapter, handles system actions
- `src/host-sweep.ts` — 60s sweep: stale detection, due-message wake, recurrence
- `src/session-manager.ts` — resolves sessions, opens `inbound.db` / `outbound.db`
- `src/container-runner.ts` — spawns per-agent-group containers, credential injection
- `src/providers/` — host-side provider config (`claude` and `codex` built in)
- `src/db/` — central DB (users, roles, agent groups, messaging groups, wiring, migrations)
- `src/channels/` — channel adapter infra (adapters installed via `/add-<channel>` skills)
- `container/agent-runner/` — Bun agent-runner: poll loop, MCP tools, provider abstraction
- `container/Dockerfile` — Claude container image
- `container/Dockerfile.codex` — Codex container image
- `groups/<folder>/` — per-agent-group filesystem (persona, memory, skills, container config)

## FAQ

**Why Docker?**

Docker provides cross-platform support (macOS, Linux and Windows via WSL2) and a mature ecosystem. On macOS, you can optionally switch to Apple Container via `/convert-to-apple-container` for a lighter-weight native runtime.

**Can I run this on Linux or Windows?**

Yes. ClawBridge runs on macOS (local machine) and Linux VPS (Ubuntu, Debian, CentOS, etc.). Just run `bash clawbridge.sh` on either. Windows via WSL2 also works.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. Credentials never enter the container raw — they're injected at spawn time and never written to disk inside the container. For VPS hardening (SSH keys, firewall, fail2ban), see the [VPS hardening guide](docs/vps-hardening.md).

**Do I need to pay per message?**

No. ClawBridge uses OAuth subscriptions, not API billing. Claude backend uses your Claude Pro/Max subscription. Codex backend uses your ChatGPT Plus/Pro subscription. You pay a flat monthly rate to Anthropic or OpenAI — not per token.

**Can I use third-party or open-source models?**

Yes. The supported path is `/add-opencode` (OpenRouter, OpenAI, Google, DeepSeek, and more via OpenCode config) or `/add-ollama-provider` (local open-weight models via Ollama).

**How do I debug issues?**

Ask Claude Code. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach that underlies ClawBridge.

**Why isn't the setup working for me?**

If a step fails, `clawbridge.sh` hands off to Claude Code to diagnose and resume. If that doesn't resolve it, run `claude`, then `/debug`.

**What changes will be accepted into the codebase?**

Only security fixes, bug fixes, and clear improvements will be accepted to the base configuration. Everything else (new capabilities, OS compatibility, enhancements) should be contributed as skills on the `channels` or `providers` branch.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

Need a managed setup? Visit **[clawbridgeagency.com](https://clawbridgeagency.com)** or email **[hello@clawbridgeagency.com](mailto:hello@clawbridgeagency.com)**

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes, or the [full release history](https://docs.clawbridge.dev/changelog) on the documentation site.

## License

MIT
