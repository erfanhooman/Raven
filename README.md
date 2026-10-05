# Raven

> Control your coding agents from Telegram. One bot for [opencode](https://opencode.ai), [Claude Code](https://docs.claude.com/en/docs/claude-code), and [Codex CLI](https://developers.openai.com/codex) — chat with live sessions, approve permissions, and get notified when work finishes.

[![npm version](https://img.shields.io/npm/v/@erfanhooman/raven)](https://www.npmjs.com/package/@erfanhooman/raven)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org)
[![Platform: macOS | Linux | Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)](https://github.com/erfanhooman/Raven)

## Table of Contents

- [About](#about)
- [Getting Started](#getting-started)
- [Features](#features)
- [How It Works](#how-it-works)
- [Usage](#usage)
- [Security](#security)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Uninstall](#uninstall)
- [Contributing](#contributing)
- [License](#license)
- [Contact](#contact)

## About

Coding agents do their best work when they can run long tasks unattended — but that creates a practical problem: you leave your desk and lose visibility. Did the run finish? Is it stuck on a permission prompt? Did the API call fail and retry? Checking requires a remote desktop, SSH session, or open port.

Raven solves this with a Telegram bot that runs on your own machine and talks to the agents you already use. There is no hosted intermediary, no VPN, and no inbound ports. Your Mac makes outbound HTTPS calls to the Telegram Bot API; your phone just talks to Telegram.

What Raven connects:

- **opencode** — via a plugin (`~/.config/opencode/plugins/raven.js`) that loads into opencode / OpenCode Desktop.
- **Claude Code and Codex** — via a background daemon (`dev.raven.daemon`) that drives the real `claude` and `codex` CLIs, so these work even when OpenCode is closed.

### The problem it solves

1. **Missed turn completions** — long builds, refactors, and research tasks finish while you are away.
2. **Blocked permission prompts** — the agent waits for `Allow / Deny` on file edits, shell commands, or patches and cannot proceed.
3. **Unanswered clarifying questions** — opencode asks which option you want and stalls without input.
4. **No lightweight remote control** — alternatives require exposing your machine to the network.

Raven delivers turn notifications, live streaming cards, one-tap permission approvals, question answering, model and mode switching, and session management — all from Telegram.

## Getting Started

> New here? Start here. Install Raven in about 2 minutes, then pair your Telegram account.

### Prerequisites

- Node.js >= 18 — check with `node --version`
- At least one agent client installed: opencode, Claude Code (`claude`), or Codex CLI (`codex`)
- A Telegram bot token — create one in about a minute via [@BotFather](https://t.me/BotFather) with `/newbot`

### Platform support

| OS | Status | Notes |
| -- | ------ | ----- |
| macOS | Full | Verified. Background service via launchd (`raven service`), desktop notifications, VS Code extension binary detection. |
| Linux | Full | Verified in a `node:18` container (`status`, binary lookup via `PATH`, log reading). Run `raven run` under systemd/pm2 — `raven service` is macOS-only. |
| Windows | Supported | Config lives in `%APPDATA%\raven`; `claude`/`codex` are found via `PATH` (including `claude.cmd` shims) and the VS Code extension bundle. No auto-start service yet — keep `raven run` alive with Task Scheduler and pass `--no-service` to setup. |

`raven setup` detects the platform automatically: on Linux and Windows it skips the launchd step and tells you how to keep the daemon running instead.

### Installation

#### Option A — npm (recommended)

```bash
npm install -g @erfanhooman/raven
raven setup
```

#### Option B — from source

```bash
git clone https://github.com/erfanhooman/Raven.git
cd Raven
./install.sh
```

Both `raven setup` and `./install.sh` accept:

- `--token <bot token>`
- `--proxy <http://… or socks5://…>`
- `--no-service` (skip the launchd service)
- `-y` (non-interactive)

### What setup does

1. Prompts for the bot token (hidden input) and validates it with Telegram `getMe`.
2. Writes `~/.config/raven/raven.json` with mode `0600`. Migrates a legacy `telegram-bridge.json` config if present.
3. Installs the opencode plugin to `~/.config/opencode/plugins/raven.js` and removes legacy `telegram-bridge.*` plugins.
4. Installs a background service so the daemon starts at login and serves Claude Code + Codex even while OpenCode is closed. macOS uses a launchd agent (`dev.raven.daemon`); on Linux/Windows setup skips this step — run `raven run` under systemd, Task Scheduler, or pm2 instead (or pass `--no-service`).
5. Prints pairing instructions.

### Pairing your Telegram account

1. Restart OpenCode Desktop (plugins load at startup), or run `raven run` in a terminal.
2. Open your bot in Telegram and send `/start`.
3. Raven prints a 6-character one-time code in the terminal and as a macOS notification. You can re-display it anytime with `raven pair`.
4. Send `/pair CODE` to the bot. The Home screen appears and your chat ID is whitelisted.

To add another device or account, repeat the steps from that chat. To revoke access, send `/unpair` (self) or `/unpair <chatId>` (revoke another chat) from any paired chat.

## Features

| Area | What you can do |
| ---- | --------------- |
| Chat with sessions | Send plain text to your focused session; open conversation history, download transcripts (opencode), and revert (opencode) |
| Turn notifications | Get a fresh `✅ finished` message (with the assistant's reply) so your phone pings, plus the live card updated in place |
| Live streaming | Watch a single live card update in place with the tail of the answer as it streams; no reasoning or tool noise |
| Permission approvals | Approve tool use from your lock screen with **Allow / Always / Reject**; the agent waits for your decision |
| Question answering | Answer opencode questions with single-tap or multi-select buttons + Submit |
| Stop control | Interrupt a long turn with Stop on the live card, workspace, or Home |
| Session management | Browse sessions grouped by project and client, create new sessions, switch focus |
| Model picker | Pick from the real model list per client; custom model IDs supported for gateways |
| Build / plan modes | Toggle build and plan modes for opencode and Claude Code (hidden for Codex, which has no plan mode) |
| Agent workspaces | Open a dedicated session for an opencode agent with `/agent`; all input routes there until `/agent close` |
| Multi-client | opencode (`🖥`), Claude Code (`🧩`), and Codex (`⬢`) in one Home screen |
| Notifications control | Toggle idle, error, permission, question, and session events in Settings |
| Proxy support | Run behind HTTP/SOCKS proxies where Telegram is filtered |

## How It Works

```text
Your phone (Telegram) ──outbound HTTPS──► Telegram Bot API
                                               ▲
                                      getUpdates long-poll
                                      (leader election)
                                               │
                                    ┌──────────┴───────────┐
                                    │   Raven on your Mac  │
                                    │  ├─ opencode plugin │  runs inside opencode / OpenCode Desktop
                                    │  └─ raven daemon    │  Claude Code + Codex (launchd, auto-start)
                                    └──────────────────────┘
```

- Only one process polls Telegram at a time. Leadership is coordinated through `~/.config/raven/leader.lock`, so you can run OpenCode Desktop and `raven run` simultaneously without duplicate polling.
- The Home screen and every other screen edit a single control-panel message in place to avoid chat spam.
- Model and mode selections are pins: they survive the app's state sync, are sent with your next message, and un-pin once the client adopts them.

## Usage

### Telegram commands

| Command | Description |
| ------- | ----------- |
| `/start` | Home — focused session, model, build/plan mode, git branch, connection status |
| `/sessions` | Browse sessions grouped by project and client |
| `/new [title]` | Create a new session |
| `/agent [name \| close]` | Open a dedicated opencode agent workspace, or close it |
| `/inbox` | Pending permissions and questions |
| `/settings` | Notifications, agent workspace model, model defaults |
| `/abort` | Stop the focused turn |
| `/skip` | Answer a pending question with "none" |
| `/word args` | Any other `/command` runs the matching opencode command |
| Plain text | Sends a message to the focused session (or open agent workspace) |

Model changes made in the desktop app are reflected in Telegram. If you pinned a different model in Telegram, use `Follow the app's model` in the picker to release the pin.

### Claude Code notes

Create a `New Claude Code session` from the bot. Sessions are stored under `~/.claude/projects`, so you can later resume them locally with `claude --resume <id>`.

Models accept alias names (`sonnet`, `opus`, `haiku`, `default`) or any exact model ID as free text, which also works behind custom gateways.

Limitation: an interactive terminal (TUI) session cannot be mirrored from outside — Claude Code does not expose that. Bot sessions are the supported bridge.

### Codex notes

Create a `New Codex thread` or open existing threads from `codex app-server`. Supported interactions include chat, streaming tails, turn notifications, and exec/patch approval round-trips. Codex has no plan mode, so the mode control is hidden.

### CLI reference

```text
raven setup            wizard: token, config, plugin, background service (macOS)
raven run              run the daemon in the foreground (Ctrl-C stops)
raven pair             show the pending pairing code
raven status           paired chats, leader, link health, detected client binaries
raven logs [-f]        tail the bridge log (pure-Node, works on all platforms)
raven service install|remove|status   (macOS launchd only)
raven uninstall [--purge]
```

`raven status` is the fastest way to diagnose installation issues — it shows the config path, paired chats, leader lock, link status, and whether `opencode`, `claude`, and `codex` binaries were detected.

## Security

A bot token alone grants no access. Every Telegram chat must be paired from a person with access to your computer:

1. An unknown chat sends `/start`; Raven generates a 6-character one-time code.
2. The code is shown only on your machine (terminal, notification, `raven pair`).
3. The user sends `/pair CODE` to the bot within 10 minutes.
4. On success, the chat ID is added to `authorizedChatIds` in `~/.config/raven/raven.json`.

Additional protections:

- Codes expire after 10 minutes and allow 5 attempts.
- Codes are bound to the requesting chat to prevent pasting a code from another chat.
- Unpaired chats receive only pairing instructions; they cannot read sessions, permissions, or questions.
- Optional owner approval: set `"pairing": { "ownerApprove": true }` to require an existing paired device to tap Approve before a new chat is authorized.
- All traffic is outbound-only HTTPS to `api.telegram.org`. Nothing listens on your machine.

## Configuration

Config file: `~/.config/raven/raven.json`

```jsonc
{
  "botToken": "123456:ABC…", // required
  "authorizedChatIds": [123456789], // populated by pairing
  "proxy": "", // e.g. "http://127.0.0.1:10809" or "socks5://…"
  "botName": "Raven",
  "pairing": { "ownerApprove": false },
  "notify": { "idle": true, "error": true, "permission": true, "question": true, "session": false },
  "relay": true, // include assistant replies on live cards
  "logLevel": "info", // use "debug" for per-action spool logs
  "clients": {
    "claude": { "bin": "", "workspace": "" }, // bin auto-detected; set manually to override
    "codex": { "bin": "" } // also finds the VS Code extension's bundled binary
  }
}
```

Proxy notes:

- If Telegram is blocked on your network, run an HTTP/SOCKS proxy on the Mac (for example V2Ray or Clash) and set `proxy` in the config or `HTTPS_PROXY` in the environment.
- Phone-side MTProto proxies do not apply — the Mac itself connects to `api.telegram.org`.

## Troubleshooting

- **No active pairing code** — the code expired or belongs to another chat. Send `/start` again from that chat, then run `raven pair`.
- **Plugin changes not visible** — restart OpenCode Desktop after `raven setup` or upgrades. Plugins load at startup.
- **Telegram 409 errors in logs** — another poller is using the same bot token. Stop the other poller; Raven elects a single leader via `~/.config/raven/leader.lock`.
- **Codex not found** — install `@openai/codex`, or set `clients.codex.bin` to a codex binary >= 0.160 (the VS Code extension's bundled binary is supported).
- **Claude turns never finish** — run `raven status`. If `ANTHROPIC_BASE_URL` in `~/.claude/settings.json` points to a local gateway, verify the gateway is running and the selected model ID is one it accepts.
- **Need logs** — run `raven logs -f`. Files: `~/.config/raven/raven.log` (`%APPDATA%\raven\raven.log` on Windows), plus `daemon.out` / `daemon.err` for the macOS launchd service.

## Development

```bash
npm install
npm run build        # esbuild → dist/raven-plugin.js, dist/raven-cli.js (~200 KB, zero runtime deps)
npm run typecheck
npm test             # opencode suite: real opencode serve + mock Telegram
npm run test:agents  # Claude + Codex drivers vs protocol-accurate fakes
npm run smoke:agents -- --real   # optional: real claude/codex binaries end-to-end
```

The published npm package ships only `dist/` and `README.md`. Tests, fakes, and docs are excluded.

Built with Node.js, TypeScript, and esbuild. No runtime dependencies.

## Uninstall

```bash
raven uninstall [--purge]
```

Or from a source checkout:

```bash
./uninstall.sh
```

This removes the background service (macOS) and the opencode plugin. Configuration and logs in `~/.config/raven/` (`%APPDATA%\raven` on Windows) are kept unless `--purge` is passed.

## Contributing

Contributions are welcome:

1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/your-feature`).
3. Commit your changes.
4. Push to the branch (`git push origin feature/your-feature`).
5. Open a pull request.

Please include tests for driver or protocol changes (`npm test`, `npm run test:agents`) and update this README when user-facing behavior changes.

## License

Distributed under the MIT License. See [LICENSE](LICENSE) for details.

## Contact

Project link: [https://github.com/erfanhooman/Raven](https://github.com/erfanhooman/Raven)

Issues and feature requests: please use the GitHub issue tracker.
