# Research: Remote controller for opencode (sessions + approvals) via Telegram

**Date:** 2026-10-04
**Scope:** opencode v1.17.6 (Homebrew CLI), OpenCode Desktop 1.18.33 (running on this Mac), upstream `dev` @ `907b3bc518fa48e90e8ec24dd327d13eee71c36c` (2026-10-02), npm `@opencode-ai/sdk@1.18.34`, Telegram Bot API (current page, Bot API 10.3).

**Summary / recommended architecture.** opencode is client/server: every UI (TUI, IDE, Web, Desktop) is a client of an HTTP server that exposes an OpenAPI spec, an SSE event stream, and explicit REST endpoints for *answering permission prompts* (`POST /permission/:requestID/reply` and the older `POST /session/:id/permissions/:permissionID`) and *answering agent questions* (`POST /question/:requestID/reply`) [S2][S12][S13]. "Session finished" is signalled by the `session.status` event with `status.type === "idle"` (plus deprecated `session.idle`, `session.error`, `session.deleted`) [S16]; "a question/approval popped up" is signalled by `permission.asked` and `question.asked` [S14][S15]. Build the controller as an **opencode plugin that runs inside the server process** (it receives an already-authenticated SDK client and an `event` hook for every event, so no password/port discovery and no inbound networking are needed) [S19]; the plugin talks to Telegram over **outbound-only long polling (`getUpdates`)** [S29], so nothing is exposed on the laptop and no tunnel is required. If the bridge must instead be an external process, it needs the server URL + basic-auth password, which OpenCode Desktop does **not persist anywhere readable** (verified below) — that is the single biggest gap [S20][S24][S28]. The fallback for remote reachability of a separate process is `tailscale serve` / Cloudflare Tunnel (both outbound-only or tailnet-only) rather than binding opencode to `0.0.0.0` [S32][S33][S8].

---

## 1. How opencode runs

### 1.1 The server is the product; UIs are clients

- `opencode` (no args) starts a TUI **and** a server; the TUI is a client of that server. `opencode serve` starts a standalone headless server. The server publishes an OpenAPI 3.1 spec at `http://<host>:<port>/doc` [S2].
- The TUI picks a random port/hostname when it starts; you can pin it with `--hostname`/`--port` so other clients can attach [S2].
- CLI surface (verified locally with `opencode --help`, `opencode serve --help`, `opencode --version` → `1.17.6`) [S25]:

  ```
  opencode serve [--port N] [--hostname H] [--cors origin] [--mdns] [--mdns-domain D] [--print-logs] [--log-level L] [--pure]
    --port      default 0   (0 = ephemeral/random)
    --hostname  default 127.0.0.1
    --mdns      default false ("enable mDNS service discovery (defaults hostname to 0.0.0.0)")
  opencode attach <url>   # attach a TUI to a running server
    -p, --password   basic auth password (defaults to OPENCODE_SERVER_PASSWORD)
    -u, --username   basic auth username (defaults to OPENCODE_SERVER_USERNAME or 'opencode')
    -s, --session <id>  --continue  --fork
  opencode web            # server + web UI
  opencode session list|delete
  ```

  Source agrees: `packages/opencode/src/cli/network.ts:8-36` declares `port` default `0`, `hostname` default `"127.0.0.1"`, and `mdns` forcing `0.0.0.0` [S8].
  ⚠️ The docs page for `serve` claims `--port` default `4096` [S2]; the CLI help and source both say `0`. Treat the docs value as stale.

### 1.2 Host/port/auth configuration

- Flags: `--port`, `--hostname`, `--mdns`, `--mdns-domain`, `--cors` [S2][S8].
- Config keys (`opencode.json`, global or project): a `server` object with `port`, `hostname`, `mdns`, `mdnsDomain`, `cors` — "Server configuration for opencode serve and web commands" [S6] (schema: `packages/core/src/v1/config/server.ts`). Flags override config; config overrides defaults (`packages/opencode/src/cli/network.ts:66-84`) [S8].
- Auth: set `OPENCODE_SERVER_PASSWORD` → HTTP Basic auth, username defaults to `opencode` (`OPENCODE_SERVER_USERNAME` to override); applies to `opencode serve` and `opencode web` [S2]. Implementation: `packages/opencode/src/server/auth.ts` (`required()` is true only when the password is non-empty; `header()` builds `Basic base64(user:pass)`) [S9]. If the variable is unset the server is **completely unauthenticated** [S9][S10].
- Every API route is wrapped in an `Authorization` middleware that returns `401` + `WWW-Authenticate: Basic realm="Secure Area"` when creds are wrong [S10]. Credentials may also be supplied as `?auth_token=<base64(user:pass)>` on the query string (useful for `EventSource`, which cannot set headers) — note this puts the secret in URLs/logs [S10].
- No TLS: the server speaks plain HTTP. There is no config key for TLS/certificates [S6].

### 1.3 What OpenCode Desktop actually starts (open source, same repo)

OpenCode Desktop is **not closed source** — it is `packages/desktop` in the canonical repo (README: "The OpenCode Desktop app, built with Electron") [S20]. The installed app is `/Applications/OpenCode.app`, version **1.18.33**, bundle id `ai.opencode.desktop`, Electron 42.3.3 (verified via `defaults read …CFBundleShortVersionString` and process annotations) [S28].

Verified on this machine (read-only):

1. The desktop main process forks an Electron `utilityProcess` from `sidecar.js` (`utilityProcess.fork(sidecar, …, { serviceName: "opencode server" })`, `packages/desktop/src/main/server.ts:57-64`) [S21][S22].
2. The sidecar **runs the opencode server in-process** (it does not exec the Homebrew CLI):

   ```js
   // packages/desktop/src/main/sidecar.js:18-31
   prepareSidecarEnv(command.password, command.userDataPath)   // sets OPENCODE_SERVER_USERNAME/PASSWORD
   const { Server } = await import("./chunks/node-….js")
   listener = await Server.listen({
     port: command.port, hostname: command.hostname,
     username: "opencode", password: command.password,
     cors: ["oc://renderer"],
   })
   ```

   [S21]
3. Port/hostname/password selection (`packages/desktop/src/main/index.ts:350-390`) [S20]:
   - port = `OPENCODE_PORT` env if set and parseable, otherwise **ephemeral** (`listen(0, "127.0.0.1")` then close → pick that port);
   - `hostname = "127.0.0.1"` — **hard-coded localhost-only**;
   - `password = randomUUID()` — regenerated every launch, username `opencode`.
4. Observed live: `lsof` shows `OpenCode … TCP 127.0.0.1:58051 (LISTEN)` for the node utility process, and `curl http://127.0.0.1:58051/doc` → `401 Unauthorized`, `www-authenticate: Basic realm="Secure Area"` [S23][S28]. Port `58062` (main Electron process) is not the opencode API (`/doc` → 404) [S23].
5. The desktop logs the URL (but **never** the password):
   `~/Library/Application Support/ai.opencode.desktop/logs/20261004T054505/main.log`:
   `sidecar connection started { version: 'v1' }` / `spawning sidecar { url: 'http://127.0.0.1:58051' }` / `server ready { url: 'http://127.0.0.1:58051' }` [S24]. (`grep -c password` on that log = 0.)
6. Env of the sidecar process at fork time does **not** contain `OPENCODE_SERVER_PASSWORD` (the sidecar assigns it to `process.env` *inside* itself, `sidecar.js:47-53`), so `ps eww <pid>` cannot recover it either [S21][S28].
7. The password is handed to the renderer over IPC only (`awaitInitialization(): Promise<{url, username, password}>`, `packages/desktop/src/preload/types.ts:17-22`) [S20]; the on-disk `electron-store` keys are `defaultServerUrl`, settings, window state — **no password** (`packages/desktop/src/main/store-keys.ts`) and no such file exists in `~/Library/Application Support/ai.opencode.desktop/` [S28].
8. Version skew to be aware of: desktop sidecar = 1.18.33 (its own bundled server code), Homebrew CLI = 1.17.6, npm/SDK/docs = 1.18.34, repo `dev` = 907b3bc. All four were checked for the routes below and all contain `/question/:requestID/reply` and `permission/:requestID/reply` [S27][S34].
9. `OPENCODE_CLIENT=desktop` is set in the desktop env; the optional `OPENCODE_SIDECAR_V2=1` code path would instead spawn a bundled `opencode-cli service start` daemon and read the password back with `opencode service get password` (`index.ts:4005-4039`) — but `/Applications/OpenCode.app/Contents/Resources/` contains **no** `opencode-cli` and the Homebrew 1.17.6 CLI has no `service` subcommand, so this path is not available here [S20][S28][S25].

---

## 2. Remote session management

All of the following are on the server (exact paths from `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:77-103` [S11], cross-checked against the published docs table [S2] and the generated SDK [S3]).

### 2.1 Sessions

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/session` | `scope`, `path`, `roots`, `start`, `search`, `limit`, `directory` | `Session[]` (most recently updated first) |
| POST | `/session` | `{ parentID?, title? }` | `Session` |
| GET | `/session/status` | — | `{ [sessionID]: SessionStatus }` where status ∈ `{type:"idle"} \| {type:"busy"} \| {type:"retry",attempt,message,action?,next}` [S16] |
| GET | `/session/:sessionID` | — | `Session` |
| PATCH | `/session/:sessionID` | `{ title?, metadata?, permission?, time.archived? }` | `Session` |
| DELETE | `/session/:sessionID` | — | `boolean` |
| POST | `/session/:sessionID/abort` | — | `boolean` (abort a running turn) |
| POST | `/session/:sessionID/fork` | `{ messageID? }` | `Session` |
| GET | `/session/:sessionID/children` · `/todo` · `/diff` | | `Session[]` / `Todo[]` / `FileDiff[]` |
| POST | `/session/:sessionID/share` · DELETE same | | `Session` (share link) |
| POST | `/session/:sessionID/summarize` | `{ providerID, modelID, auto? }` | `boolean` |
| POST | `/session/:sessionID/revert` / `/unrevert` | `{ messageID, partID? }` | `boolean` |

### 2.2 Sending messages (this is "attach to a running session")

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/session/:id/message` | `limit?`, `before?` | `{ info: Message, parts: Part[] }[]` |
| POST | `/session/:id/message` | `{ messageID?, model?, agent?, noReply?, system?, tools?, parts: [{type:"text",text}] }` | `{ info, parts }` — **blocks until the assistant reply is done** [S2] |
| POST | `/session/:id/prompt_async` | same as above | `204 No Content` — fire-and-forget; completion is observed via events [S2][S11] |
| POST | `/session/:id/command` | `{ messageID?, agent?, model?, command, arguments }` | `{ info, parts }` (slash commands) |
| POST | `/session/:id/shell` | `{ agent, model?, command }` | `{ info, parts }` |
| GET | `/session/:id/message/:messageID` | | `{ info, parts }` |
| DELETE | `/session/:id/message/:messageID` (+ `/part/:partID`), PATCH part | | `boolean` |

There is **no** WebSocket "attach" protocol for messages — attaching = plain HTTP calls to the same server the desktop is using. A TUI can attach with `opencode attach http://127.0.0.1:<port> -p <password> -s <sessionID>` [S25].

### 2.3 SDK equivalents (`@opencode-ai/sdk`, npm latest `1.18.34`) [S3][S34]

```ts
import { createOpencodeClient } from "@opencode-ai/sdk"
const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:58051",
  headers: { Authorization: "Basic " + Buffer.from(`opencode:${pw}`).toString("base64") } })

await client.session.list()
await client.session.create({ body: { title: "…" } })
await client.session.prompt({ path: { id }, body: { parts: [{ type: "text", text: "…" }] } })
await client.session.promptAsync({ path: { id }, body: { parts: [...] } })   // 204
await client.session.status()                                                // GET /session/status
await client.session.abort({ path: { id } })
await client.postSessionIdPermissionsPermissionId({                          // deprecated route
  path: { id: sessionID, permissionID }, body: { response: "once" | "always" | "reject" } }) [S38]
const stream = await client.event.subscribe()                                // GET /event, SSE
for await (const ev of stream.stream) { /* ev.type, ev.properties */ }
```

The **v1** (root) SDK export only carries the deprecated permission endpoint. The **v2** export (`@opencode-ai/sdk/v2`) is generated from the newer spec and additionally has `GET /permission`, `POST /permission/{requestID}/reply`, `GET /question`, `POST /question/{requestID}/reply`, `POST /question/{requestID}/reject`, plus `POST /session/{sessionID}/prompt_async` (`packages/sdk/js/src/v2/gen/sdk.gen.ts:3007-3189, 4139`) [S3]. The v1 root export does **not** expose `/question` or `/permission` as methods (`packages/sdk/js/src/gen/sdk.gen.ts:1157-1207`) [S3] — for those, call raw `fetch` or use the v2 subpath.

Directory/workspace routing: clients may send `x-opencode-directory` / `x-opencode-workspace` headers or `directory=` / `workspace=` query params to select the instance (`packages/sdk/js/src/client.ts:17-34`, `v2/client.ts`) [S3].

---

## 3. Events & notifications

### 3.1 How to subscribe

Two SSE endpoints (`text/event-stream`, `Cache-Control: no-cache`, 10-second `server.heartbeat`, first frame is `server.connected`) [S2]:

- **`GET /event`** — instance/directory-scoped. Payload per frame: `{ "id", "type", "properties" }`, filtered to `event.location.directory === <instance directory>` and the current workspace (`handlers/event.ts:21-106`) [S17]. There is **no `Last-Event-ID` replay**: the SSE `id` field is literally `undefined` (`eventData()` in `handlers/event.ts:11-18`) [S17] → a reconnecting client must re-snapshot state via `GET /session/status`, `GET /permission`, `GET /question`.
- **`GET /global/event`** — **all directories/instances** (GlobalBus). Payload envelope: `{ directory, project?, workspace?, payload: { id, type, properties } }` (`handlers/global.ts:22-75`, schema `GlobalEventSchema` in `groups/global.ts:31-45`) [S18]. **This is the right endpoint for an external bridge** that must watch every project.

Subscription via SDK: `client.event.subscribe()` → `GET /event` using `client.get.sse(...)` (`packages/sdk/js/src/gen/sdk.gen.ts:1147-1155`) [S38]; docs example iterates `events.stream` [S3]. No WebSocket event channel exists (there is a `websocket-tracker` for PTY only) [S17].

### 3.2 Event names relevant to this project

Enumerated from source (`packages/schema/src/event-manifest.ts` builds `Definitions` / `ServerDefinitions` from `define({ type: … })` calls) [S40] and matching the documented plugin event list [S4]:

| Want | Event | Payload (`properties`) | Source |
|---|---|---|---|
| Permission/tool-approval popped up | `permission.asked` | `{ id: "per_…", sessionID, permission, patterns[], metadata{}, always[], tool?: {messageID, callID} }` | [S14] (`packages/schema/src/v1/permission.ts` `Request` + `Asked`) |
| Permission answered | `permission.replied` | `{ sessionID, requestID, reply: "once"\|"always"\|"reject" }` | [S14] |
| New-style permission (v2) | `permission.v2.asked` / `permission.v2.replied` | `PermissionV2.Request` / reply | `packages/schema/src/permission.ts:43` [S40] |
| Agent asked a question | `question.asked` | `{ id: "que_…", sessionID, questions: [{question, header, options:[{label,description}], multiple?, custom?}], tool?: {messageID, callID} }` | [S15] |
| Question answered / dismissed | `question.replied` `{sessionID,requestID,answers: string[][]}` / `question.rejected` `{sessionID,requestID}` | | [S15] |
| New-style question (v2) | `question.v2.asked` / `.replied` / `.rejected` | same shape (`QuestionV2.*`) | `packages/schema/src/question.ts:70-84` [S40] |
| **Turn finished ("session ended")** | `session.status` | `{ sessionID, status: {type:"idle"} \| {type:"busy"} \| {type:"retry",attempt,message,action?,next} }` | [S16]; published by `packages/opencode/src/session/status.ts:34-41` |
| (deprecated twin) | `session.idle` | `{ sessionID }` | [S16]; still published alongside `session.status` when idle, marked `// deprecated` |
| Turn failed | `session.error` | session error object | [S4] |
| Session lifecycle | `session.created` / `session.updated` / `session.deleted` / `session.compacted` / `session.diff` | per schema | [S4] |
| Streaming output | `message.updated`, `message.part.updated`, `message.part.removed`, `message.removed`, `message.part.delta` | | [S4][S40] |
| Bookkeeping | `server.connected`, `server.heartbeat`, `server.instance.disposed`, `session.status`, `todo.updated`, `tool.execute.before/after` (plugin-side), `file.edited`, `lsp.updated`, `installation.updated`, `command.executed`, `tui.*`, `shell.env` | | [S4] |

Note: `session.status` state lives **in memory** per instance (`InstanceState` map, `session/status.ts:24-42`) — it is not durable, so an idle event is only delivered while you are connected [S16].

### 3.3 Plugin hooks (the alternative to SSE)

`export interface Hooks` in `packages/plugin/src/index.ts:222-330` [S19]:

- `event?: (input: { event: { id, type, properties } }) => Promise<void>` — receives **every** event, filtered to the instance's directory (`packages/opencode/src/plugin/index.ts:252-260`) [S19]. This is the one hook you need for notifications.
- `permission.ask?: (input: Permission, output: { status: "ask"|"deny"|"allow" }) => Promise<void>` — can force allow/deny before the prompt (not a substitute for asking the user) [S19].
- `tool.execute.before` / `tool.execute.after`, `command.execute.before`, `shell.env`, `chat.message`, `chat.params`, `chat.headers`, `config`, `dispose`, `auth`, `provider`, `tool: {...}` (custom tools), plus `experimental.session.compacting`, `experimental.chat.system.transform`, etc. [S19].
- Plugin input: `{ client /* authenticated SDK client */, project, directory, worktree, serverUrl, $ }` — the client is built with `headers: ServerAuth.headers()` so it already carries Basic auth (`packages/opencode/src/plugin/index.ts:144-165`) [S19].
- Loading: `.opencode/plugins/` (project) or `~/.config/opencode/plugins/` (global), or npm packages listed in `opencode.json` `plugin[]` [S4]. Docs' canonical notification example hooks `event` and fires on `event.type === "session.idle"` [S4].
- Documented hook names in the docs page (same set as source for the ones listed there): `command.executed`, `file.edited`, `file.watcher.updated`, `installation.updated`, `lsp.client.diagnostics`, `lsp.updated`, `message.part.removed`, `message.part.updated`, `message.removed`, `message.updated`, `permission.asked`, `permission.replied`, `server.connected`, `session.created`, `session.compacted`, `session.deleted`, `session.diff`, `session.error`, `session.idle`, `session.status`, `session.updated`, `todo.updated`, `shell.env`, `tool.execute.after`, `tool.execute.before`, `tui.prompt.append`, `tui.command.execute`, `tui.toast.show` [S4].

---

## 4. Answering questions from Telegram

### 4.1 The exact APIs (both exist in 1.17.6 and 1.18.33 binaries) [S27]

**Permissions (tool approvals):**

```
GET  /permission                     -> PermissionV1.Request[]   # pending across all sessions
POST /permission/:requestID/reply    # requestID = "per_…"
     body: { "reply": "once" | "always" | "reject", "message"?: "…" }
     -> boolean            (errors: 400, PermissionNotFoundError)
```
Source: `packages/opencode/src/server/routes/instance/httpapi/groups/permission.ts:13-45`, handler `permissionSvc.reply({ requestID, reply })` [S12]. `"always"` additionally whitelists the `always[]` patterns for the rest of the opencode session; `"reject"` throws `PermissionRejectedError`/`CorrectedError` back at the model (`packages/core/src/v1/permission.ts`) [S14].

Deprecated but still present and documented (and the only one in the **v1 SDK**):

```
POST /session/:sessionID/permissions/:permissionID
     body: { "response": "once" | "always" | "reject" }   -> boolean
```
Source: `groups/session.ts:74-76, 395-409` + `handlers/session.ts:362-378` (OpenAPI annotation `deprecated: true`) [S11]; SDK type `PostSessionIdPermissionsPermissionIdData.body = { response: "once"|"always"|"reject" }` [S38]. ⚠️ The docs page claims `body: { response, remember? }` [S2] — **`remember` does not exist** in the schema/SDK; ignore it.

**Questions (the `question` tool / `question` permission):**

```
GET  /question                       -> Question.Request[]       # pending across all sessions
POST /question/:requestID/reply      # requestID = "que_…"
     body: { "answers": [["<label>", …], …] }   # one array per question, in order
     -> boolean
POST /question/:requestID/reject     -> boolean
```
Source: `groups/question.ts:8-70` [S13]; `Question.Reply = { answers: Answer[] }`, `Answer = string[]` (selected **labels**) [S15]. A custom typed answer is itself returned as a label when `custom` is enabled [S15][S41].

The question flow: the model calls the `question` tool (`packages/opencode/src/tool/question.ts` + `question.txt`) → `Question.ask()` parks a `Deferred` and publishes `question.asked` (`packages/opencode/src/question/index.ts:104`) → answering resolves the deferred and the tool returns the labels to the model [S39][S15]. Permission flow is symmetric (`packages/opencode/src/permission/index.ts:100`) [S39].

### 4.2 Where the bot process runs

Two viable placements, verified:

**(A) Recommended — inside opencode as a plugin (no auth, no port, no tunnel).**
Drop `~/.config/opencode/plugins/telegram-bridge.ts` [S4]. It gets the authenticated `client` + `event` hook [S19], so it can push Telegram messages on `permission.asked` / `question.asked` / `session.status{idle}` and answer via `client.postSessionIdPermissionsPermissionId(...)` (permissions) and a raw `fetch(serverUrl + "/question/" + id + "/reply", { headers: ServerAuth.headers() })` (questions, since the v1 client lacks `/question`) [S3][S19]. Outbound HTTPS to `api.telegram.org` only. Caveat: plugins are loaded **per instance/directory** and the `event` hook is directory-filtered (`plugin/index.ts:254`) [S19] — a global plugin therefore runs once per project instance; dedupe notifications by `sessionID`.

**(B) External daemon next to the desktop app.**
Needs `url` + `password`. Port is discoverable (`lsof -nP -iTCP -sTCP:LISTEN | grep -i opencode`, or the desktop log line `spawning sidecar { url: … }`) [S23][S24]; **the password is not** — not in logs, not in `electron-store`, not in the fork-time process env [S24][S28][S21]. Options: (i) run your *own* `opencode serve --port 4096` with `OPENCODE_SERVER_PASSWORD=…` — but that is a *second* server instance and cannot drive the desktop's in-memory running sessions; (ii) run opencode yourself (TUI/serve) instead of the desktop as the primary server; (iii) wait for/enable the v2 `opencode service get password` path, which is in source but not shipped in this build [S20]. (i)–(iii) are workarounds, not equivalent.

### 4.3 Message flow (plugin variant)

```
        (outbound HTTPS only)                     (loopback HTTP, inside laptop)
 Telegram  <----------------------------------->  opencode server 127.0.0.1:<port>
    ^        getUpdates / sendMessage                  |  SSE /event  (or /global/event)
    |        editMessageText /                         |  REST: /permission, /question
    |        answerCallbackQuery                       v
    |                                          opencode plugin "telegram-bridge"
 user taps [Approve] / [Reject]  ----callback_query--->  hook event()
                                                         -> sendMessage(+InlineKeyboard)
                                                         -> POST /permission/:id/reply
```

```
  model calls tool ──> permission.ask / question tool
                   ──> bus publishes permission.asked | question.asked
                   ──> plugin event() ──> Telegram sendMessage(text, reply_markup=InlineKeyboard)
  user taps button ──> callback_query { data: "per_xxx:once" }
                   ──> bot: answerCallbackQuery(id)            [mandatory, see §5]
                   ──> bot: POST /permission/per_xxx/reply {reply:"once"}
                   ──> bot: editMessageText("✅ approved …")    [optional]
                   ──> permission.replied ──> model resumes
  turn ends ────────> session.status {status:{type:"idle"}} ──> bot: sendMessage("session finished")
```

---

## 5. Telegram Bot API surfaces

All citations are to `https://core.telegram.org/bots/api` section anchors [S29][S30][S31].

- **Transport choice:** "There are two mutually exclusive ways of receiving updates — the [`getUpdates`](#getupdates) method on one hand and [webhooks](#setwebhook) on the other. Incoming updates are stored … not … longer than 24 hours." (`#getting-updates`) [S29].
- **Long polling:** `getUpdates` with `offset` (must be `> highest received update_id`, recalc after each response), `limit` (1–100, default 100), `timeout` (seconds; "Should be positive, short polling should be used for testing purposes only"), `allowed_updates` (e.g. `["message","callback_query"]`). Note: "This method will not work if an outgoing webhook is set up." (`#getupdates`) [S29]. ← **Use this for the laptop: pure outbound HTTPS, no inbound port, no tunnel, no certificate.**
- **Update object:** `update_id` plus exactly one of `message`, `edited_message`, `callback_query`, … (`#update`) [S29].
- **Webhooks:** `setWebhook(url, …, secret_token)` — "If specified, the request will contain a header `X-Telegram-Bot-Api-Secret-Token` with the secret token as content"; `secret_token` is 1–256 chars of `[A-Za-z0-9_-]`; supported webhook ports are **443, 80, 88, 8443**; `allowed_updates`, `max_connections` (1–100, default 40), `drop_pending_updates` (`#setwebhook`) [S29]. Query via `getWebhookInfo` (`#getwebhookinfo`), remove via `deleteWebhook` (`#deletewebhook`) [S29].
- **Sending replies:** `sendMessage(chat_id, text, parse_mode?, entities?, link_preview_options?, disable_notification?, reply_parameters?, reply_markup?)` — `text` is **1–4096 characters after entities parsing**; `reply_markup` accepts `InlineKeyboardMarkup` | `ReplyKeyboardMarkup` | `ReplyKeyboardRemove` | `ForceReply` (`#sendmessage`) [S30]. Formatting via `parse_mode` ("markdown-style or HTML-style") under `#formatting-options` [S30].
- **Inline keyboard for yes/no approvals:** `InlineKeyboardMarkup { inline_keyboard: InlineKeyboardButton[][] }` (`#inlinekeyboardmarkup`); `InlineKeyboardButton` with `text` and `callback_data` — "Data to be sent in a callback query to the bot when the button is pressed, **1-64 bytes**" (`#inlinekeyboardbutton`) [S31]. ⇒ keep `callback_data` short, e.g. `p:per_abc123:once`, and store the mapping locally.
- **Receiving the tap:** `callback_query` in `Update` (`#callbackquery`) carries `id`, `from`, `message`, `data`. "**After the user presses a callback button, Telegram clients will display a progress bar until you call `answerCallbackQuery`. It is, therefore, necessary to react by calling `answerCallbackQuery` even if no notification to the user is needed.**" (`#callbackquery` note) [S31].
- **Acknowledging:** `answerCallbackQuery(callback_query_id, text?, show_alert?, url?, cache_time?)` — `text` is 0–200 chars (`#answercallbackquery`) [S31].
- **Updating the prompt message after answering:** `editMessageText` (`#editmessagetext`) [S31].
- **Bot commands (optional `/sessions`, `/status` menu):** `setMyCommands` (`#setmycommands`) / `getMyCommands` (`#getmycommands`) [S31].
- **Auth/requests:** all queries are `https://api.telegram.org/bot<token>/METHOD_NAME`, GET or POST, params via query string, `application/x-www-form-urlencoded`, `application/json`, or `multipart/form-data`; responses are `{ ok, result?, description?, error_code? }` (`#authorizing-your-bot`, `#making-requests`) [S29].
- **Webhook answering trick:** while processing a webhook you can invoke a Bot API method in the *response body* using a `method` parameter (`#making-requests-when-getting-updates`) [S29].
- A self-hosted [telegram-bot-api](https://github.com/tdlib/telegram-bot-api) server exists but is unnecessary here (`#using-a-local-bot-api-server`) [S29].

---

## 6. Security & reachability

1. **Default posture is good:** `opencode serve` and the desktop both bind `127.0.0.1` only [S8][S2][S20]; the desktop's bind is hard-coded `hostname = "127.0.0.1"` [S20]. `--mdns` (or `server.mdns`) is what flips the hostname to `0.0.0.0` [S8][S6].
2. **Auth:** Basic auth exists only when `OPENCODE_SERVER_PASSWORD` is set [S9]. The desktop always sets it to a per-launch `randomUUID()` [S20] and we observed `401` + `WWW-Authenticate` on the live port [S28]. A manually-run `opencode serve` without that env var has **no auth** — set it [S2][S9].
3. **No TLS.** Everything is plaintext HTTP [S6][S10]. Do not port-forward the opencode port to the internet.
4. **Preferred: keep everything inbound-closed.** The bot process runs on the laptop and only makes *outbound* HTTPS calls to `api.telegram.org` (long polling) [S29]. Nothing needs to be reachable from outside — this is the whole reason to prefer `getUpdates` over a webhook here.
5. **If a webhook or an off-laptop bridge is required:**
   - **Tailscale** — encrypted peer-to-peer WireGuard mesh, "works through firewalls and NAT without requiring port forwarding" (`tailscale.com/kb/1151/what-is-tailscale`) [S32]; `tailscale serve` reverse-proxies a local service inside the tailnet with auto-provisioned HTTPS — "only `http://127.0.0.1` is supported for proxies", `tailscale serve --https=443 localhost:4096`, `--bg` for persistence (`tailscale.com/kb/1242/servesafe`) [S32]. `tailscale funnel` would publish to the whole internet — avoid for an unauthenticated-at-TLS-terminator admin API.
   - **Cloudflare Tunnel** — `cloudflared` creates **outbound-only** connections to Cloudflare's network, so "you do not send traffic to an external IP" and you can "block all inbound traffic" to the origin (`developers.cloudflare.com/cloudflare-one/connections/connect-networks/`) [S33]. Add Cloudflare Access in front; the opencode Basic-auth password is still the second factor.
6. **Credential hygiene:** `?auth_token=` on the query string is convenient for SSE/EventSource but leaks into logs (`authorization.ts:75-83`) [S10]; prefer the `Authorization` header. The desktop never writes the password to disk — do not try to scrape it; if you need a password you control, run `opencode serve` yourself [S20][S24].
7. **Telegram side:** the bot token must be stored where the bridge runs (plugin ⇒ `opencode.json`/env on the laptop); restrict the bot to your own chat id — `CallbackQuery.from.id` is checked before acting [S31].

---

## 7. Gaps & workarounds

| # | Gap | Evidence | Workaround |
|---|---|---|---|
| 1 | **No outbound push.** opencode only *serves* an SSE stream; it cannot notify Telegram itself without code running inside it. | [S2][S17] | Run the bridge as a plugin (§4.2 A) or a local daemon subscribing to SSE. |
| 2 | **Desktop server credentials are undiscoverable to external processes.** Random UUID password, not persisted, not in fork env, not in logs/store. | [S20][S21][S24][S28] | Put the bridge *inside* the server (plugin), or run your own `opencode serve` with a known `OPENCODE_SERVER_PASSWORD`. |
| 3 | **`/event` is directory-scoped** — one SSE connection per project directory; no cross-project view. | [S17] | Use `GET /global/event` (envelope `{directory, project, workspace, payload}`) for a single cross-project stream [S18]. |
| 4 | **No event replay/resume** — SSE frames carry no `id`, state is in-memory. | [S17][S16] | On (re)connect: snapshot `GET /session/status`, `GET /permission`, `GET /question`, then stream; diff to detect events missed while offline. |
| 5 | **`session.idle` is deprecated** (still emitted); `session.status` is the current signal. | [S16] | Subscribe to `session.status` and treat `{type:"idle"}` as "turn finished"; keep `session.idle` as a fallback. |
| 6 | **"Session ended" ≠ "session deleted".** `session.status:idle` fires per turn; a long-lived session stays open. Errors use `session.error`; deletion uses `session.deleted`. | [S16][S4] | Send the Telegram "finished" note on `session.status{idle}`; optionally also on `session.error`. |
| 7 | **Docs/spec drift:** docs say `--port` default 4096 (actual: 0) and `remember` in the permission body (does not exist). | [S2][S8][S38] | Trust the OpenAPI spec at `/doc` and the SDK types. |
| 8 | **New `/permission` + `/question` endpoints are missing from the v1 SDK export** (only the deprecated session-scoped permission call is generated). | [S3][S38] | Import `@opencode-ai/sdk/v2`, or raw `fetch` against `/doc`-documented paths. |
| 9 | **Two generations of events coexist** (`permission.asked` vs `permission.v2.asked`, `question.asked` vs `question.v2.asked`); the TUI/app still consume the v1 names. | [S14][S15][S40] | Handle both name families in the bridge (cheap: switch on `type.endsWith(".asked")`). |
| 10 | **Plugins are per-directory** and their `event` hook is filtered by directory. | [S19] | One global plugin instance per project; dedupe by `sessionID`, or use an external daemon + `/global/event`. |
| 11 | **Telegram `callback_data` ≤ 64 bytes** and `sendMessage.text` ≤ 4096 chars; long tool payloads must be truncated. | [S31][S30] | Encode only the request id + verdict in `callback_data`; fetch full details server-side before sending. |
| 12 | **Webhook mode needs public HTTPS on ports 443/80/88/8443** — incompatible with a localhost-only laptop behind NAT. | [S29] | Use `getUpdates`; if a webhook is mandatory, put it behind Cloudflare Tunnel/Tailscale Funnel + `secret_token`. |
| 13 | Desktop has no documented HTTP knob for a fixed port/password (only `OPENCODE_PORT` env, verified in source). | [S20] | `OPENCODE_PORT=4096 open -a OpenCode` pins the port; password still random — reinforces the plugin route. |
| 14 | No first-party "opencode → mobile push" integration exists; `packages/slack` is in the repo but there is no documented Telegram/notification bridge. | [S1][S4] | Build the bridge; reuse the docs' `osascript` notification plugin as a template [S4]. |

---

## 8. Proposed implementation sketch

**Components**

1. **`opencode` plugin `telegram-bridge`** (`~/.config/opencode/plugins/telegram-bridge.ts`)
   - inputs: bot token + allowed chat ids from `opencode.json` custom key or env;
   - exports `{ "event": async ({event}) => … }` [S19];
   - `state`: `Map<requestID, {chatId, messageId, kind}>` (permissions `per_*`, questions `que_*`).
2. **Telegram egress helper** (inside the plugin): `getUpdates` loop with `timeout=50`, `offset`, `allowed_updates=["message","callback_query"]` [S29]; `sendMessage`/`editMessageText`/`answerCallbackQuery` [S30][S31].
3. **opencode ingress**: authenticated `client` (already provided) [S19] + raw `fetch` for `/question` [S3].
4. **Session registry** (optional, keeps the Telegram chat tidy): on `session.created`/`session.updated`, remember `sessionID → title`; render `/sessions` list from `GET /session`.
5. **Storage**: a small JSON/SQLite file next to the plugin (or reuse opencode's own `opencode.db` — **read-only**; it has `session`, `message`, `part`, `permission`, `todo`, `event` tables, verified with `sqlite3 -readonly … .schema`) [S26]. Prefer your own file: the DB schema is internal and versioned by `data_migration`.
6. *(Alternative to 1-3)* **external daemon** if you control the server (`opencode serve` with your own password): same code, but `createOpencodeClient({ baseUrl })` + `Authorization` header + `GET /global/event` [S3][S18].

**Ordered build steps**

1. Pin reality: write a tiny probe that hits `GET /global/health`, `GET /session/status`, `GET /permission`, `GET /question`, and `GET /event` against a known server (use `opencode serve --port 4096` locally first, not the desktop) and dump the JSON — confirm shapes against `/doc` [S2].
2. Stand up SSE: consume `GET /global/event`, log `type` counts; verify you see `permission.asked`, `question.asked`, `session.status` [S17][S18].
3. Telegram skeleton: `getUpdates` loop + `sendMessage` echo + `/status` command [S29].
4. Wire permission prompts: on `permission.asked` → `sendMessage` with 3-button `InlineKeyboard` (`once` / `always` / `reject`), store `per_*` id [S14][S31].
5. Wire callbacks: on `callback_query` → validate chat/user → `answerCallbackQuery` → `POST /permission/:id/reply {reply}` → `editMessageText` [S31][S12].
6. Wire questions: on `question.asked` → render `questions[].options[]` as inline buttons → `POST /question/:id/reply {answers:[[label]]}` (multi-select: accumulate then send) [S13][S15].
7. Wire completion: on `session.status` `{type:"idle"}` → "✅ session `<title>` finished" (and `session.error` → ❌) [S16].
8. Reconnect hardening: on SSE drop, snapshot `GET /session/status` + `GET /permission` + `GET /question` and reconcile against local state (gap #4) [S17].
9. Package as a global plugin, enable desktop notifications parity, add `OPENCODE_SERVER_PASSWORD` to a self-run `opencode serve` if you later add an external daemon [S4][S2].
10. Only if you truly need off-laptop components: add `tailscale serve --https=443 localhost:<port>` (tailnet-only) or a Cloudflare Tunnel with Access; never `--hostname 0.0.0.0` without auth [S32][S33][S8].

---

## 9. Sources

- **[S1]** https://opencode.ai/docs/ — Intro + docs navigation (canonical repo link `github.com/anomalyco/opencode`, install, share). Fetched 2026-10-04.
- **[S2]** https://opencode.ai/docs/server/ — `opencode serve` usage/flags, `OPENCODE_SERVER_PASSWORD` auth, `/doc` spec, full endpoint table (sessions, `POST /session/:id/permissions/:permissionID`, `/event`, `/global/event`, `/tui/*`).
- **[S3]** https://opencode.ai/docs/sdk/ — `createOpencode` / `createOpencodeClient`, session methods, `postSessionByIdPermissionsByPermissionId`, `event.subscribe()` example. Source cross-check: `packages/sdk/js/src/gen/sdk.gen.ts:1147-1155,1157-1207` and `packages/sdk/js/src/v2/gen/sdk.gen.ts:3007-3189,4095-4139` @ `907b3bc518fa48e90e8ec24dd327d13eee71c36c` (github.com/anomalyco/opencode).
- **[S4]** https://opencode.ai/docs/plugins/ — plugin loading paths, `Hooks` list, documented event names, notification example, desktop-notification note.
- **[S5]** https://opencode.ai/docs/permissions/ — `allow|ask|deny`, `once|always|reject` outcomes, available permissions incl. `question`, defaults.
- **[S6]** https://opencode.ai/docs/config/ — `server.{port,hostname,mdns,mdnsDomain,cors}` (source: `packages/web/src/content/docs/config.mdx:302-325`, `packages/core/src/v1/config/server.ts`).
- **[S7]** https://opencode.ai/docs/network/ — proxy env vars, `NO_PROXY=localhost,127.0.0.1`, "You can configure the server's port and hostname using CLI flags".
- **[S8]** Repo: `packages/opencode/src/cli/network.ts:8-84` (flag defaults `port:0`, `hostname:"127.0.0.1"`, mdns→`0.0.0.0`, flag>config>default precedence) @ `907b3bc`.
- **[S9]** Repo: `packages/opencode/src/server/auth.ts:1-48` (`OPENCODE_SERVER_PASSWORD`, `OPENCODE_SERVER_USERNAME`, `required()`, `header()`).
- **[S10]** Repo: `packages/opencode/src/server/routes/instance/httpapi/middleware/authorization.ts:1-140` (401 + `www-authenticate: Basic realm="Secure Area"`, `?auth_token=` alternative).
- **[S11]** Repo: `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:74-103,395-409` and `…/httpapi/handlers/session.ts:362-378` (`permissionRespond`, `deprecated: true`).
- **[S12]** Repo: `packages/opencode/src/server/routes/instance/httpapi/groups/permission.ts:13-45` (`GET /permission`, `POST /permission/:requestID/reply`, payload `{reply, message?}`).
- **[S13]** Repo: `packages/opencode/src/server/routes/instance/httpapi/groups/question.ts:8-70` (`GET /question`, `POST /question/:requestID/reply` `{answers: string[][]}`, `POST /question/:requestID/reject`).
- **[S14]** Repo: `packages/schema/src/v1/permission.ts:37-75` (`Request`, `Reply = "once"|"always"|"reject"`, `permission.asked`/`permission.replied` event definitions) + `packages/core/src/v1/permission.ts` (Rejected/Corrected/Denied errors).
- **[S15]** Repo: `packages/schema/src/v1/question.ts:14-70` (`QuestionRequest`, `QuestionAnswer = string[]`, `question.asked/replied/rejected`) and `packages/schema/src/question.ts:31-84` (v2).
- **[S16]** Repo: `packages/schema/src/session-status-event.ts:1-50` (`session.status`, deprecated `session.idle`, status union) + `packages/opencode/src/session/status.ts:24-45` (publish on state change, in-memory).
- **[S17]** Repo: `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts:1-106` (SSE endpoint `/event`, envelope `{id,type,properties}`, `server.connected`, 10 s heartbeat, directory/workspace filter, no event ids).
- **[S18]** Repo: `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts:22-75` + `groups/global.ts:31-45,70` (`GET /global/event`, `GlobalEvent` envelope).
- **[S19]** Repo: `packages/plugin/src/index.ts:44-74,222-330` (`PluginInput`, `Hooks`) + `packages/opencode/src/plugin/index.ts:144-165,252-296` (authenticated client, directory-filtered `event` dispatch, `trigger()`).
- **[S20]** Repo: `packages/desktop/` (README "The OpenCode Desktop app, built with Electron"), `src/main/index.ts:350-390` (OPENCODE_PORT / `hostname="127.0.0.1"` / `password=randomUUID()`), `src/main/store-keys.ts`, `src/preload/types.ts:17-22`, `src/main/index.ts:4005-4039` (`opencode service get password`, v2 path), `src/main/index.ts:4108` (`OPENCODE_SIDECAR_V2`).
- **[S21]** App bundle (first-party build of S20): `/Applications/OpenCode.app/Contents/Resources/app.asar` → `out/main/sidecar.js:18-53` (Server.listen with username/password/cors, `prepareSidecarEnv`).
- **[S22]** Repo: `packages/desktop/src/main/server.ts:57-64` (`utilityProcess.fork(sidecar, …, serviceName:"opencode server")`), `SIDECAR_START_STALL_TIMEOUT`.
- **[S23]** Local, 2026-10-04: `lsof -nP -iTCP -sTCP:LISTEN | grep -i opencode` → `127.0.0.1:58051` (node utility) and `127.0.0.1:58062` (main); `curl -si http://127.0.0.1:58051/doc` → 401; `:58062/doc` → 404.
- **[S24]** Local: `~/Library/Application Support/ai.opencode.desktop/logs/20261004T054505/main.log` lines `sidecar connection started { version: 'v1' }`, `spawning sidecar { url: 'http://127.0.0.1:58051' }`, `server ready { url: 'http://127.0.0.1:58051' }`; `grep -c password` → 0.
- **[S25]** Local: `opencode --version` → `1.17.6`; `opencode --help`; `opencode serve --help` (defaults `--port 0`, `--hostname 127.0.0.1`); `opencode attach --help` (`-p/--password`, `-u/--username`, `-s/--session`); `opencode session --help`; `opencode debug --help`; binary at `/opt/homebrew/Cellar/opencode/1.17.6/bin/opencode` (119 MB, no JS bundle shipped — single compiled binary).
- **[S26]** Local, read-only: `sqlite3 -readonly ~/.local/share/opencode/opencode.db .schema` → tables `session, message, part, permission, todo, project, workspace, event, event_sequence, session_message, session_input, session_context_epoch, session_share, account, credential, …` (391 MB file; never written to during this research).
- **[S27]** Local: `grep -F` on the 1.17.6 binary — `/question/:requestID/reply`, `permission/:requestID/reply`, `permission.list`, `question.list`, `permission.reply`, `question.reply`, `permission.asked`, `question.asked`, `session.idle`, `session.status`, `server.connected`, `permissions/:permissionID`, `prompt_async` all present.
- **[S28]** Local: `/Applications/OpenCode.app` → `CFBundleShortVersionString 1.18.33`; process annotations `Electron 42.3.3`, `user-data-dir=…/ai.opencode.desktop`; `ps eww <sidecar pid>` env contains `OPENCODE_CLIENT=desktop` but **no** `OPENCODE_*PASSWORD*`; `curl -si http://127.0.0.1:58051/global/health` → 401 + `www-authenticate: Basic realm="Secure Area"`; `ls …/Contents/Resources/` → no `opencode-cli`; asar extraction performed with `@electron/asar` into a temp dir (app files untouched).
- **[S29]** https://core.telegram.org/bots/api — `#getting-updates`, `#update`, `#getupdates`, `#setwebhook`, `#deletewebhook`, `#getwebhookinfo`, `#authorizing-your-bot`, `#making-requests`, `#using-a-local-bot-api-server`.
- **[S30]** https://core.telegram.org/bots/api — `#sendmessage` (1–4096 char limit, `reply_markup`), `#formatting-options`.
- **[S31]** https://core.telegram.org/bots/api — `#inlinekeyboardmarkup`, `#inlinekeyboardbutton` (callback_data 1–64 bytes), `#callbackquery` (+ mandatory `answerCallbackQuery` note), `#answercallbackquery`, `#editmessagetext`, `#setmycommands`.
- **[S32]** https://tailscale.com/kb/1151/what-is-tailscale (WireGuard peer-to-peer mesh, works through NAT "without requiring port forwarding") and https://tailscale.com/kb/1242/servesafe (`tailscale serve`, reverse proxy limited to `http://127.0.0.1`, `--https=<port>`, `--bg`).
- **[S33]** https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/ (Cloudflare Tunnel: `cloudflared` makes outbound-only connections; block all inbound traffic to the origin).
- **[S34]** npm registry `@opencode-ai/sdk` → `dist-tags.latest = 1.18.34`; `packages/sdk/js/package.json` exports `.`, `./client`, `./server`, `./v2`, `./v2/client`, `./v2/types`.
- **[S38]** Repo: `packages/sdk/js/src/gen/sdk.gen.ts:1147-1155,1157-1176` and `packages/sdk/js/src/gen/types.gen.ts:2889-2900` (`response: "once" | "always" | "reject"`, no `remember`).
- **[S39]** Repo: `packages/opencode/src/permission/index.ts:96-165` and `packages/opencode/src/question/index.ts:100-150` (publish `Asked`/`Replied`/`Rejected`, Deferred parking).
- **[S40]** Repo: `packages/schema/src/event-manifest.ts` (inventory → `Definitions`, `ServerDefinitions`), `packages/schema/src/permission.ts:43`, `packages/schema/src/question.ts:70-84`, `packages/opencode/src/event-v2-bridge.ts` (bridge to GlobalBus).
- **[S41]** Repo: `packages/opencode/src/tool/question.ts` + `question.txt` (the agent-facing question tool) and `packages/opencode/src/tool/index.ts` registry.

---

## Unverified / assumptions

1. **Whether any *supported* way exists to read the OpenCode Desktop's basic-auth password from outside the app.** Verified absent from: desktop logs, `electron-store` files, fork-time process environment, and the app bundle resources [S24][S28][S21]. It *is* passed to the renderer via the `awaitInitialization()` IPC call [S20] — I did not attempt to extract it from the running renderer (that would be an invasive action). Assumption: treat as unavailable; use the plugin route.
2. **Live behaviour of the endpoints was not exercised against the running desktop server.** Only `GET /doc` and `GET /global/health` were probed (both 401) [S28]; no authenticated request was made, no server was started, nothing was modified. Endpoint shapes come from source + OpenAPI/SDK types, not from a live response.
3. **`GET /global/event` payload was verified in source/schema, not observed live.** Same for `permission.asked` / `question.asked` / `session.status` frames [S17][S18][S14][S15][S16].
4. **A second `opencode serve` process opening the same `opencode.db` while the desktop holds in-memory session state is *probably* unable to drive those sessions.** The DB is shared on disk [S26], but live session/turn state is per-process (`InstanceState`, [S16]); I did not test it. Do not assume it works.
5. **Plugin lifecycle per instance:** source proves plugins are instantiated per directory-instance with a directory-filtered `event` hook [S19]; I did not verify that a *global* plugin file is loaded for every project instance the desktop creates (docs say global plugins are always loaded [S4], so this is likely but inferred).
6. **Version skew caveats:** the docs were read from the live site (built from `dev`, Oct 3 2026) while the installed CLI is 1.17.6 and the desktop server is 1.18.33 [S25][S28]. All route strings were confirmed present in the 1.17.6 binary [S27], but subtle payload differences between 1.17.6 and `dev` (e.g. whether `remember` ever existed in 1.17.6) were not exhaustively checked — `grep -F 'remember'` on the 1.17.6 binary returns 10 hits in unknown contexts, which is inconclusive.
7. **`/tui/*` endpoints** (`POST /tui/append-prompt`, `/tui/submit-prompt`, `/tui/control/next`…) [S2] are documented for driving a *terminal* TUI; I did not verify whether they interact meaningfully with the desktop renderer (the desktop uses the Web app, not the TUI).
8. **Telegram claims** are from the live Bot API page (Bot API 10.3, Aug 24 2026 changelog) [S29]; no bot was created and no API call was made during this research.
