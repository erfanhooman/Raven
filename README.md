# Raven

> Control your coding agents from Telegram — [opencode](https://opencode.ai), [Claude Code](https://docs.claude.com/en/docs/claude-code), and [Codex CLI](https://developers.openai.com/codex) in one bot.

[![npm version](https://img.shields.io/npm/v/@erfanhooman/raven)](https://www.npmjs.com/package/@erfanhooman/raven)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org)
[![Platform: macOS | Linux | Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)](https://github.com/erfanhooman/Raven)

## Install

Requires Node >= 18, at least one agent client (opencode, `claude`, or `codex`), and a bot token from [@BotFather](https://t.me/BotFather).

```bash
npm install -g @erfanhooman/raven
raven setup
```

Or from source:

```bash
git clone https://github.com/erfanhooman/Raven.git
cd Raven
./install.sh
```

Flags for both: `--token <bot token>`, `--proxy <http://…|socks5://…>`, `--no-service`, `-y`.

## How Raven runs

- **opencode** — a plugin loads inside OpenCode; nothing else to run.
- **Claude Code & Codex** — driven by the **Raven daemon**. `raven setup` installs it as a background service on every OS (macOS launchd · Windows logon · Linux systemd user), or run `raven run` yourself. If the daemon isn't running, Claude/Codex won't respond in Telegram (opencode still will). Check with `raven service status`.

Both are CLI integrations — Raven drives the `claude` and `codex` CLIs directly (codex ≥ 0.160; a VS Code extension's bundled codex CLI binary is detected as a fallback). No GUI app integration.

## Pairing

1. Restart OpenCode Desktop (or run `raven run`).
2. In Telegram send `/start` to your bot.
3. A pairing-code banner appears in the terminal, plus a desktop notification. Re-read anytime: `raven pair`.
4. Send `/pair CODE` to the bot.

| Action | Terminal | Telegram |
| ------ | -------- | -------- |
| Show code + paired chats | `raven pair` | `/pairs` |
| Revoke a chat | `raven pair revoke <chatId>` | `/unpair <chatId>` |

## Platform support

| OS | Status |
| -- | ------ |
| macOS | Full — launchd service (`raven service`), notifications |
| Linux | Full — systemd user service, notifications |
| Windows | Supported — logon autostart (hidden), notifications; config in `%APPDATA%\raven` |

`raven setup` detects the platform and installs the matching background service (`--no-service` to skip).

## Features

- One Home screen for opencode, Claude Code, and Codex sessions
- `✅ finished` notifications, live streaming cards, one-tap permission approvals
- Answer questions, stop turns, browse/create sessions
- Model picker and build/plan mode per session (Codex has no plan mode)
- Agent workspaces (`/agent`), notification toggles, HTTP/SOCKS proxy support

## Telegram commands

| Command | Description |
| ------- | ----------- |
| `/start` | Home — session, model, mode, connection status |
| `/sessions` | Browse sessions by project and client |
| `/new [title]` | Create a session |
| `/agent [name \| close]` | Open/close an opencode agent workspace |
| `/inbox` | Pending permissions and questions |
| `/settings` | Notifications and profile |
| `/pairs` · `/unpair <id>` | List / revoke paired chats |
| `/abort` · `/skip` | Stop the turn · answer with "none" |
| `/word args` | Runs the matching opencode command |
| Plain text | Sends a message to the focused session |

## CLI

```text
raven setup                  wizard: token, config, plugin, service (macOS)
raven run                    run the daemon in the foreground (Ctrl-C stops)
raven pair                   pending code + paired chats
raven pair revoke <chatId>   unpair a chat (notifies it on Telegram)
raven status                 paired chats, leader, link health, binaries
raven logs [-f]              tail the bridge log (all platforms)
raven service install|remove|status   (launchd / Windows logon / systemd)
raven uninstall [--purge]
```

## Security

- The bot token alone grants nothing — every chat must pair with a 6-character code shown only on your machine (10-minute expiry, 5 attempts, bound to its chat).
- Optional owner approval: `"pairing": { "ownerApprove": true }`.
- Outbound HTTPS to `api.telegram.org` only; nothing listens on your machine.

## Configuration

Config: `~/.config/raven/raven.json` (`%APPDATA%\raven` on Windows).

```jsonc
{
  "botToken": "123456:ABC…", // required
  "authorizedChatIds": [123456789], // populated by pairing
  "proxy": "", // e.g. "http://127.0.0.1:10809" or "socks5://…"
  "botName": "Raven",
  "pairing": { "ownerApprove": false },
  "notify": { "idle": true, "error": true, "permission": true, "question": true, "session": false },
  "relay": true, // include assistant replies on live cards
  "logLevel": "info", // "debug" for per-action logs
  "clients": {
    "claude": { "bin": "", "workspace": "" }, // auto-detected; set to override
    "codex": { "bin": "" } // also finds the VS Code extension's binary
  }
}
```

## Troubleshooting

- **No active pairing code** — it expired; send `/start` again, then `raven pair`.
- **Plugin changes not visible** — restart OpenCode Desktop after setup/upgrade.
- **Telegram 409 in logs** — another poller uses the same token; Raven elects one leader via `~/.config/raven/leader.lock`.
- **Codex not found** — install `@openai/codex` or set `clients.codex.bin` (codex >= 0.160).
- **Logs** — `raven logs -f`; file at `~/.config/raven/raven.log`.

## Development

```bash
npm install
npm run build        # esbuild → dist/ (~200 KB, zero runtime deps)
npm run typecheck
npm run test:platform  # service command builders (win/linux, no OS touched)
npm run test:agents  # self-contained driver suite (no agents needed)
npm test             # opencode suite (requires `opencode` installed)
```

CI runs typecheck + `test:agents` on every push; pushing a `v*` tag publishes to npm automatically (requires the `NPM_TOKEN` repo secret).

## Uninstall

```bash
raven uninstall [--purge]   # or ./uninstall.sh
```

Keeps config/logs unless `--purge` is passed.

## License

MIT — see [LICENSE](LICENSE).
