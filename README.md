# Raven

**Talk to your coding agents from your phone.** One Telegram bot, live on three clients: **opencode**, **Claude Code**, and **Codex**. Chat with running sessions, get notified when a turn finishes, approve (or refuse) tool permissions from your lock screen, stream the answer as it is written, switch models, and open dedicated agent workspaces — no VPN, no open ports, outbound-only HTTPS.

```
Your phone (Telegram) ──outbound HTTPS──► Telegram Bot API
                                             ▲
                                    getUpdates long-poll (leader election)
                                             │
                                  ┌──────────┴───────────┐
                                  │  Raven on your Mac   │
                                  │  ├─ opencode plugin  │  ← runs inside OpenCode / opencode serve
                                  │  └─ raven daemon     │  ← Claude Code + Codex (launchd, auto-start)
                                  └──────────────────────┘
```

## What you get

| Trigger | In Telegram |
|---|---|
| A session finishes a turn | `✅ <title> finished` + the assistant's reply |
| The agent streams an answer | one live card: your prompt, then the tail of the answer (`🤖 …`) updating in place — no thinking/tool noise |
| Agent asks permission (tool approval) | `🔐 Permission needed` + **Allow / Always / Reject** buttons — the agent waits for you |
| Agent auto-retries a failed API call | `🔁 auto-retrying (attempt N)` on the card; a hard failure shows the exact error |
| opencode asks a question | `❓ …` option buttons (single-tap or multi-select + Submit) |
| You answer in the app instead | the Telegram card updates itself: `☑️ answered in app` |
| Turn is running too long | `⏹ Stop` on the live card / workspace / Home |

**One control panel** (a single message every screen edits in place): 🏠 Home (focused session · model · build/plan · git branch · connection status), 📚 Sessions grouped by project and client (🖥 opencode · 🧩 Claude Code · ⬡ Codex), ➕ New, 📥 Inbox, ⚙️ Settings.

**Workspaces** — per session you get Conversation (your prompts, transcript download, revert on opencode), a Model picker (real model list per client), a build⇄plan mode chip (opencode + Claude; Codex hides it), Tasks/Command/More (opencode).

**Agent workspaces (opencode)** — `/agent` lists your configured agents; pick one and it gets a **dedicated session**. Everything you type goes to that agent (even if you focus another project), always in build mode, with its own model you set in ⚙️ Settings. `/agent close` returns.

**Claude Code** — create a `🧩 New Claude Code session` from the bot; it answers, streams, and asks permissions via the real `claude` CLI. The session lands in `~/.claude/projects`, so you can open the same conversation later with `claude --resume <id>`. Models: alias names (`sonnet`, `opus`, `haiku`, `default`) or any exact model id (free-text) — works behind gateways too. (A live interactive TUI session cannot be mirrored from outside — Claude doesn't expose that; bot sessions are the bridge.)

**Codex** — `⬢ New Codex thread` or existing threads from `codex app-server`. Chat, streaming tails, turn notifications, and real **exec/patch approval round-trips**. Codex has no plan mode, so the UI hides it.

## Security — pairing, not open doors

A bot token alone is not access. Every Telegram chat must be **paired**:

1. On first start (or whenever an unknown chat sends `/start`), Raven generates a **6-character one-time code** — printed in your terminal, shown as a macOS notification, and readable anytime with `raven pair`.
2. Only a person who can *see that code on your computer* can authorize a chat: the user sends `/pair CODE` to the bot.
3. The chat id is whitelisted in `~/.config/raven/raven.json` (mode 600). Codes expire in 10 minutes, tolerate 5 wrong tries, and are tied to the requesting chat (paste protection).
4. Add another account anytime: `/start` from it → `raven pair` → `/pair CODE`. Revoke with `/unpair` (self) or `/unpair <chatId>` (any paired owner), from Telegram.
5. Optional extra gate: `"pairing": { "ownerApprove": true }` in the config makes existing paired devices tap **Approve/Deny** before a new code can take effect. (Default: off.)

Unpaired chats can never read sessions, permissions, or questions — they get exactly one message: how to pair. Everything else stays outbound-only HTTPS; nothing is listening on your Mac.

## Requirements

- macOS (Linux works too; `raven service` is macOS launchd-only — run `raven run` under any supervisor elsewhere)
- Node.js ≥ 18 (`node --version`)
- At least one client: [opencode](https://opencode.ai) / [Claude Code](https://docs.claude.com/en/docs/claude-code) / [Codex CLI](https://developers.openai.com/codex)
- A Telegram bot — 60 seconds to make: talk to [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token

## Install

### Option A — npm

```bash
npm install -g @erfanhooman/raven
raven setup
```

### Option B — GitHub (HTTPS or SSH)

```bash
git clone https://github.com/erfanhooman/raven.git   # or: git clone git@github.com:erfanhooman/raven.git
cd raven
./install.sh
```

Flags for both `install.sh` and `raven setup`: `--token <bot token>` · `--proxy <http://… or socks5://…>` · `--no-service` · `-y`.

### What setup does

1. Asks for the bot token (hidden input) and verifies it with `getMe`.
2. Writes `~/.config/raven/raven.json` (0600) — migrates an old `telegram-bridge.json` config automatically.
3. Installs the **opencode plugin** → `~/.config/opencode/plugins/raven.js` (loads into every opencode/ OpenCode Desktop instance; removes legacy `telegram-bridge.*`).
4. Installs a **launchd agent** (`dev.raven.daemon`) so the daemon runs at login — it serves Claude Code + Codex even while OpenCode is closed. `--no-service` to skip.
5. Tells you to pair.

### First pairing

1. Restart OpenCode Desktop (or run `raven run` in a terminal — one leader is auto-elected, so running both is fine).
2. Open your bot in Telegram → send `/start`.
3. Your terminal / a macOS notification shows `🔐 Pairing request … code XXXXXX` (also via `raven pair`).
4. Send `/pair XXXXXX` to the bot. Home appears. Done — that chat id is whitelisted.

## Commands (in Telegram)

`/start` Home · `/sessions` · `/new [title]` · `/agent [name|close]` (opencode agents) · `/inbox` · `/settings` (notifications + agent workspace + model) · `/abort` stop the focused turn · `/skip` answer a pending question with "none" · any other `/word args` runs the matching opencode command · **plain text** talks to your last focused session (or the open agent workspace).

Model & mode picks are **pins**: they survive the app's constant state-sync, are sent with your next message, and un-pin automatically once the client adopts them. `↩️ Follow the app's model` in the picker releases a pin manually.

## raven CLI

```
raven setup            wizard: token, config, plugin, launchd service
raven run              run the daemon in the foreground (Ctrl-C stops)
raven pair             show the pending pairing code
raven status           paired chats, leader, link health, detected client binaries
raven logs [-f]        tail ~/.config/raven/raven.log
raven service install|remove|status
raven uninstall [--purge]
```

## Configuration — `~/.config/raven/raven.json`

```jsonc
{
  "botToken": "123456:ABC…",        // required
  "authorizedChatIds": [123456789], // populated by pairing; edit by hand if you must
  "proxy": "",                       // http://127.0.0.1:10809 or socks5://… — needed where Telegram is filtered
  "botName": "Raven",
  "pairing": { "ownerApprove": false },
  "notify": { "idle": true, "error": true, "permission": true, "question": true, "session": false },
  "relay": true,                     // put assistant replies on the live cards
  "logLevel": "info",                // "debug" adds per-action spool logs
  "clients": {
    "claude": { "bin": "", "workspace": "" },   // bin auto-detected (~/.local/bin/claude etc.)
    "codex":  { "bin": "" }                     // also finds the VS Code extension's bundled binary
  }
}
```

If Telegram is blocked on your network, run an HTTP/SOCKS proxy on the Mac (V2Ray/Clash/etc.) and set `proxy` (or `HTTPS_PROXY`). Phone-side MTProto proxies do **not** apply — the Mac talks to `api.telegram.org` itself.

## Troubleshooting

- **"No active pairing code"** — the code expired (10 min) or came from another chat. `/start` again from that chat, then `raven pair`.
- **OpenCode restart needed** — plugins load at startup; after `raven setup`/upgrades, quit and reopen OpenCode Desktop.
- **Two leaders** — impossible by design (lockfile `~/.config/raven/leader.lock`); if another getUpdates poller uses the same token you'll see 409 backoff logs — stop the other poller.
- **Codex not found** — install `@openai/codex`, or point `clients.codex.bin` at any codex binary ≥ 0.160 (the VS Code extension's bundled one works).
- **Claude turns never finish** — run `raven status`; if your Claude routes through a local gateway (`ANTHROPIC_BASE_URL` in `~/.claude/settings.json`), check that it is running and that the model name you pick is one it accepts (free-text custom model id exists exactly for gateways).
- **Logs** — `raven logs -f` (also `~/.config/raven/raven.log`, `daemon.out/.err` for launchd).

## Development

```bash
npm install
npm run build        # esbuild → dist/raven-plugin.js, dist/raven-cli.js (~200 KB, zero runtime deps)
npm run typecheck
npm test             # opencode suite: real opencode serve + mock Telegram  (161 assertions)
npm run test:agents  # Claude + Codex drivers vs protocol-accurate fakes    (32 assertions)
npm run smoke:agents -- --real   # optional: real claude/codex binaries end-to-end
```

The published npm package ships only `dist/` + README — tests, fakes, and docs stay out.

## Uninstall

`raven uninstall [--purge]` (or `./uninstall.sh`) — removes the launchd agent, the plugin, and optionally the config dir.
