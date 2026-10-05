import fsp from "node:fs/promises"
import { watch } from "node:fs"
import type { FSWatcher } from "node:fs"
import path from "node:path"
import os from "node:os"
import net from "node:net"
import tls from "node:tls"
import { promises as dns } from "node:dns"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { ravenHome } from "./util.js"

type Dir = string
type InstanceKey = string

type OutItem =
  | { t: "hello"; key: InstanceKey; dir: Dir; serverUrl: string; client?: ClientKind; ts: number }
  | { t: "event"; key: InstanceKey; dir: Dir; serverUrl: string; client?: ClientKind; ts: number; event: { type: string; properties: any } }
  | { t: "ack"; id: string; ok: boolean; data?: any; error?: string; ts: number; key: InstanceKey }

type InboxItem = { id: string; key: InstanceKey; action: string; payload: any; ts: number }

type PromptRec = {
  kind: "permission" | "question"
  key: InstanceKey
  dir: Dir
  sessionID: string
  sentAt: number
  msgs: { chatId: number; messageId: number }[]
  handled?: boolean
  baseText?: string
  permission?: any
  questions?: any[]
  selections?: number[][]
}

type Screen =
  | { name: "home" }
  | { name: "sessions"; page: number }
  | { name: "session"; sid: string }
  | { name: "tasks"; sid: string }
  | { name: "more"; sid: string }
  | { name: "conv"; sid: string; page: number }
  | { name: "models"; sid: string; page: number }
  | { name: "commands"; sid: string; page: number }
  | { name: "newProject" }
  | { name: "inbox" }
  | { name: "inboxItem"; kind: "p" | "q"; id: string }
  | { name: "settings" }
  | { name: "agentSettings" }
  | { name: "agentModels"; page: number }

type PendingInput =
  | { kind: "newTitle"; dir: string; key: InstanceKey; client?: "cl" | "cx" }
  | { kind: "commandArg"; sid: string; command: string }
  | { kind: "modelCustom"; sid: string; providerID: string }

type ModelRef = { providerID: string; modelID: string }

// An agent workspace: a dedicated session per chat. While it is open, typed
// messages go to that agent instead of the focused project session. The agent
// always runs in build mode; its model comes from this record (or the session
// default when unset).
type AgentWorkspace = {
  sid: string
  agent: string
  key: InstanceKey
  dir: Dir
  model?: ModelRef
  openedAt: number
  prev?: { sid: string; key: InstanceKey; dir: Dir; title: string }
}

type State = {
  chats: Record<
    string,
    {
      active?: { sid: string; key: InstanceKey; dir: Dir; title: string }
      ui?: { screen: Screen; panelId?: number; menuSent?: boolean }
      pending?: PendingInput
      agent?: AgentWorkspace
    }
  >
  sessions: Record<string, { key: InstanceKey; dir: Dir; title: string; updated: number; parentID?: string; preview?: string; model?: ModelRef; agent?: string; modelPinned?: boolean; agentPinned?: boolean; modelServer?: ModelRef; agentServer?: string; client?: ClientKind }>
  awaiting: Record<string, { chats: number[]; key: InstanceKey; at: number; cards?: Record<string, number>; lastCardEdit?: number; prompt?: string; stream?: string; streamShown?: boolean; lastStreamEdit?: number; error?: string }>
  lastIdle: Record<string, number>
  lastBusy: Record<string, number>
  dedupe: Record<string, number>
  link: { status: "online" | "offline" | "starting"; since: number; lastError: string; fails: number }
  pairing?: PairingReq | null
}

// One pending pairing request at a time: an unknown Telegram chat hit /start
// and got a short code printed on the user's computer. Only someone who can
// see the code (i.e. has access to this machine) can authorize a chat.
type PairingReq = {
  code: string
  chatId: number
  name: string
  createdAt: number
  attempts: number
  ownerApproved?: boolean
  codeConfirmed?: boolean
}

const PAIR_TTL_MS = 10 * 60_000
const PAIR_MAX_ATTEMPTS = 5
const PAIR_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ" // no ambiguous glyphs


const BUTTON_MAP: Record<string, string> = {
  "🏠 Home": "/start",
  "📚 Sessions": "/sessions",
  "➕ New": "/new",
  "📥 Inbox": "/inbox",
  "⚙️ Settings": "/settings",
}

const BOT_COMMANDS = new Set([
  "start",
  "help",
  "sessions",
  "new",
  "inbox",
  "settings",
  "status",
  "use",
  "open",
  "abort",
  "reload",
  "skip",
  "cancel",
  "agent",
  "pair",
  "unpair",
  "approve",
  "deny",
])

function menuKeyboard() {
  return {
    resize_keyboard: true,
    keyboard: [[{ text: "🏠 Home" }, { text: "📚 Sessions" }], [{ text: "➕ New" }, { text: "⚙️ Settings" }]],
  }
}

// Pre-Raven installs kept their config in the opencode config dir.
function ravenHomeLegacy(): string {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(xdg, "opencode")
}

function clip(s: string, n = 3800): string {
  const str = String(s ?? "")
  return str.length > n ? str.slice(0, n - 1) + "…" : str
}

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(-6)
}

function timeAgo(ms: number): string {
  if (!ms) return ""
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function baseDir(dir: string): string {
  const parts = String(dir ?? "").split("/").filter(Boolean)
  return parts[parts.length - 1] || dir || ""
}

function msgText(withParts: any): string {
  const parts = withParts?.parts ?? []
  const texts = parts
    .filter((p: any) => p?.type === "text" && typeof p.text === "string" && p.text.trim())
    .map((p: any) => String(p.text).trim())
  const tools = parts
    .filter((p: any) => p?.type === "tool" && p?.tool)
    .map((p: any) => {
      const cmd = typeof p.state?.input?.command === "string" ? `: ${clip(p.state.input.command, 60)}` : ""
      const out = typeof p.state?.output === "string" && p.state.output.trim() ? ` → ${clip(p.state.output.trim(), 80)}` : ""
      return `🔧 ${p.tool}${cmd}${out}`
    })
  return [...texts, ...tools].join("\n").trim()
}

function modelFromInfo(m: any): ModelRef | undefined {
  const providerID = String(m?.providerID ?? "")
  const modelID = String(m?.modelID ?? m?.id ?? "")
  if (!providerID || !modelID) return undefined
  return { providerID, modelID }
}

function modelLabelOf(m: ModelRef | undefined): string {
  return m?.modelID || "default"
}

function modeOf(agent: string | undefined): string {
  const a = String(agent ?? "build").toLowerCase()
  return a === "plan" ? "plan" : a === "build" ? "build" : a
}

function modeButtonLabel(mode: string): string {
  return mode === "plan" ? "📋 plan" : mode === "build" ? "🛠 build" : `🤖 ${clip(mode, 24)}`
}

function tailClip(s: string, n = 1500): string {
  const t = String(s ?? "").trim()
  return t.length > n ? "…" + t.slice(-n) : t
}

function stopKeyboard(sid: string) {
  return { inline_keyboard: [[{ text: "⏹ Stop turn", callback_data: `s:abort:${sid}` }]] }
}

function sameModel(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  return !!a && !!b && a.providerID === b.providerID && a.modelID === b.modelID
}

type ModelFields = { model?: ModelRef; modelPinned?: boolean; modelServer?: ModelRef }
type AgentFields = { agent?: string; agentPinned?: boolean; agentServer?: string }

// Merge a value reported by opencode (session.updated / session.list) into the
// registry. A model or mode the user picked in Telegram is a PIN: it must
// survive the server's continuous re-reports of its old value (that used to
// silently clobber the choice, making the pickers "do nothing"), but it
// un-pins automatically once the server adopts it (next prompt sends it).
function mergeServerModel(prev: (ModelFields & Record<string, any>) | undefined, server: ModelRef | undefined): ModelFields {
  if (prev?.modelPinned) {
    if (server && sameModel(server, prev.model)) return { model: server, modelPinned: false, modelServer: server }
    return { model: prev.model, modelPinned: true, modelServer: server ?? prev.modelServer }
  }
  return { model: server ?? prev?.model, modelPinned: false, modelServer: server ?? prev?.modelServer }
}

function mergeServerAgent(prev: (AgentFields & Record<string, any>) | undefined, server: string | undefined): AgentFields {
  if (prev?.agentPinned) {
    if (server && server === prev.agent) return { agent: server, agentPinned: false, agentServer: server }
    return { agent: prev.agent, agentPinned: true, agentServer: server ?? prev.agentServer }
  }
  return { agent: server ?? prev?.agent, agentPinned: false, agentServer: server ?? prev?.agentServer }
}

export type ClientKind = "oc" | "cl" | "cx" | "daemon"

export interface BridgeOpts {
  home: string
  key: InstanceKey
  dir: Dir
  serverUrl: string
  client: ClientKind
  runAction: (action: string, payload: any) => Promise<any>
  onReady?: () => void
}

export interface BridgeHandle {
  feedEvent: (ev: { type: string; properties: any }) => Promise<void>
  dispose: () => Promise<void>
}

export async function startBridge(o: BridgeOpts): Promise<BridgeHandle> {
  {
    const CFG_ROOT = o.home
    const CFG_FILE = path.join(CFG_ROOT, "raven.json")
    const BR = CFG_ROOT
    const OUTBOX = path.join(BR, "outbox")
    const INBOX = path.join(BR, "inbox")
    const LOCK = path.join(BR, "leader.lock")
    const OWNER = path.join(LOCK, "owner.json")
    const STATE_FILE = path.join(BR, "state.json")
    const PROMPTS_FILE = path.join(BR, "prompts.json")
    const OFFSET_FILE = path.join(BR, "telegram-offset")
    const LOG_FILE = path.join(BR, "raven.log")

    const KEY: InstanceKey = o.key
    const MY_DIR: Dir = o.dir
    const CLIENT: ClientKind = o.client
    const SERVER_URL: string = o.serverUrl.replace(/\/+$/, "")

    let disposed = false
    const timers: any[] = []
    let tgRunning = false
    let draining = false
    let kickTimer: any = null
    let inboxKickTimer: any = null
    let inboxing = false
    let warnedMultiServer = false
    const watchers: FSWatcher[] = []
    let offset = 0

    const instances = new Map<InstanceKey, { dir: Dir; serverUrl: string; client: ClientKind; lastSeen: number; fails?: number; downUntil?: number }>()

    // Sessions are namespaced by owning client: "cl_" = Claude Code, "cx_" =
    // Codex, plain "ses_…" = opencode. Everything downstream (routing,
    // capabilities, icons) keys off this prefix.
    function clientOf(sid: string): ClientKind {
      if (sid.startsWith("cl_")) return "cl"
      if (sid.startsWith("cx_")) return "cx"
      return "oc"
    }
    function clientName(c: ClientKind | undefined): string {
      return c === "cl" ? "Claude Code" : c === "cx" ? "Codex" : c === "daemon" ? "raven" : "opencode"
    }
    function clientIcon(c: ClientKind | undefined): string {
      return c === "cl" ? "🧩" : c === "cx" ? "⬢" : "🖥"
    }

    // Circuit breaker: an instance that stops answering (e.g. its server died
    // after a restart) is skipped for a cooldown instead of burning the full
    // action timeout on every command. Any sign of life clears it.
    function noteInstanceResult(key: InstanceKey, ok: boolean) {
      const v = instances.get(key)
      if (!v) return
      if (ok) {
        if (v.fails || v.downUntil) instances.set(key, { ...v, fails: 0, downUntil: 0 })
        return
      }
      const fails = (v.fails ?? 0) + 1
      const wasDown = (v.downUntil ?? 0) > Date.now()
      const downUntil = fails >= 2 ? Date.now() + 45_000 : (v.downUntil ?? 0)
      instances.set(key, { ...v, fails, downUntil })
      if (fails >= 2 && !wasDown) log("info", `instance ${key.slice(0, 8)} not responding — skipping it for 45s (${v.dir})`)
    }

    function isInstanceUp(v: { lastSeen: number; downUntil?: number }): boolean {
      if (Date.now() - v.lastSeen > 300_000) return false
      if ((v.downUntil ?? 0) > Date.now()) return false
      return true
    }
    const waiters = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: any }>()
    const lastLists = new Map<number, { sid: string; key: InstanceKey; dir: Dir; title: string }[]>()
    const lastPickLists = new Map<number, { kind: string; items: any[]; sid?: string }>()
    const lastCardEdit = new Map<string, number>()
    const streamEdits = new Map<string, number>()
    const reconciled = new Map<InstanceKey, number>()
    let firstLockSeen = 0

    const writeChains = new Map<string, Promise<any>>()
    const stateChain: { p: Promise<any> } = { p: Promise.resolve() }
    const workChain: { p: Promise<any> } = { p: Promise.resolve() }

    function scheduleWork(label: string, fn: () => Promise<void>) {
      workChain.p = workChain.p.then(fn).catch((e: any) => log("warn", `${label}: ${e?.message ?? e}`))
      return workChain.p
    }

    let logLevel = "info"
    const log = (level: string, msg: string) => {
      if (level === "debug" && logLevel !== "debug") return
      const line = `${new Date().toISOString()} ${level.toUpperCase()} [${KEY.slice(0, 8)}] ${msg}\n`
      fsp
        .appendFile(LOG_FILE, line)
        .then(() => fsp.stat(LOG_FILE))
        .then((st: { size: number }) => {
          if (st.size > 1_000_000) return fsp.truncate(LOG_FILE, Math.floor(st.size / 2))
        })
        .catch(() => {})
    }

    function atomicWrite(file: string, data: string, mode?: number): Promise<any> {
      const prev = writeChains.get(file) ?? Promise.resolve()
      const next = prev
        .then(async () => {
          const tmp = `${file}.${randomUUID().slice(0, 6)}.tmp`
          await fsp.writeFile(tmp, data, { encoding: "utf8", ...(mode ? { mode } : {}) })
          await fsp.rename(tmp, file)
        })
        .catch((e) => log("warn", `write failed ${path.basename(file)}: ${e?.message ?? e}`))
      writeChains.set(file, next)
      return next
    }

    async function readJSON<T>(file: string, fallback: T): Promise<T> {
      try {
        const raw = await fsp.readFile(file, "utf8")
        return JSON.parse(raw) as T
      } catch {
        return fallback
      }
    }

    async function loadConfig(): Promise<{
      enabled: boolean
      botToken: string
      authorizedChatIds: number[]
      apiBase: string
      proxy: string
      proxySource: string
      botName: string
      botDescription: string
      ownerApprove: boolean
      logLevel: string
      notify: { idle: boolean; error: boolean; permission: boolean; question: boolean; session: boolean }
      relay: boolean
    }> {
      let raw = await readJSON<any>(CFG_FILE, {})
      try {
        logLevel = String((raw as any)?.logLevel || "info")
      } catch {}
      if (!raw || typeof raw !== "object") raw = {}
      // One-time transparent fallback: pre-Raven config in the legacy location.
      if (!raw.botToken && o.home === ravenHome()) {
        const legacy = await readJSON<any>(path.join(ravenHomeLegacy(), "telegram-bridge.json"), {})
        if (legacy?.botToken) raw = { ...legacy, botName: legacy.botName || "Raven", setupDone: true }
      }
      const notify = raw?.notify ?? {}
      const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy || ""
      const cfgProxy = String(raw?.proxy ?? "").trim()
      const ids = new Set<number>()
      for (const x of Array.isArray(raw?.authorizedChatIds) ? raw.authorizedChatIds : []) ids.add(Number(x))
      for (const x of Array.isArray(raw?.chatIds) ? raw.chatIds : []) ids.add(Number(x)) // legacy field
      ids.delete(NaN)
      return {
        enabled: raw?.enabled !== false,
        botToken: String(raw?.botToken ?? ""),
        authorizedChatIds: [...ids].filter((n) => Number.isFinite(n)),
        apiBase: String(raw?.apiBase ?? "https://api.telegram.org").replace(/\/+$/, ""),
        proxy: cfgProxy || envProxy,
        proxySource: cfgProxy ? "config" : envProxy ? "env" : "",
        botName: String(raw?.botName || "Raven"),
        botDescription: String(raw?.botDescription ?? ""),
        ownerApprove: raw?.pairing?.ownerApprove === true,
        logLevel: String(raw?.logLevel || "info"),
        notify: {
          idle: notify.idle !== false,
          error: notify.error !== false,
          permission: notify.permission !== false,
          question: notify.question !== false,
          session: notify.session === true,
        },
        relay: raw?.relay !== false,
      }
    }

    async function patchConfig(patch: Record<string, any>): Promise<void> {
      const cur = await readJSON<any>(CFG_FILE, {})
      const next = { ...cur, ...patch }
      await atomicWrite(CFG_FILE, JSON.stringify(next, null, 2), 0o600)
      log("info", `config updated: ${Object.keys(patch).join(", ")}`)
    }

    async function loadState(): Promise<State> {
      const s = await readJSON<Partial<State>>(STATE_FILE, {})
      return {
        chats: s.chats ?? {},
        sessions: s.sessions ?? {},
        awaiting: s.awaiting ?? {},
        lastIdle: s.lastIdle ?? {},
        lastBusy: s.lastBusy ?? {},
        dedupe: s.dedupe ?? {},
        link: s.link ?? { status: "starting", since: Date.now(), lastError: "", fails: 0 },
        pairing: s.pairing ?? undefined,
      }
    }

    function saveState(s: State) {
      const now = Date.now()
      for (const k of Object.keys(s.dedupe)) if (now - (s.dedupe[k] ?? 0) > 86_400_000) delete s.dedupe[k]
      const sids = Object.keys(s.sessions)
      if (sids.length > 200) {
        sids
          .sort((a, b) => (s.sessions[a]?.updated ?? 0) - (s.sessions[b]?.updated ?? 0))
          .slice(0, sids.length - 200)
          .forEach((sid) => delete s.sessions[sid])
      }
      return atomicWrite(STATE_FILE, JSON.stringify(s))
    }

    function mutateState<T>(fn: (s: State) => T | Promise<T>): Promise<T> {
      const run = stateChain.p.then(async () => {
        const s = await loadState()
        const r = await fn(s)
        await saveState(s)
        return r
      })
      stateChain.p = run.catch(() => {})
      return run
    }

    async function loadPrompts(): Promise<Record<string, PromptRec>> {
      const p = await readJSON<Record<string, PromptRec>>(PROMPTS_FILE, {})
      const now = Date.now()
      let dirty = false
      for (const k of Object.keys(p)) {
        if (now - (p[k]?.sentAt ?? 0) > 7 * 86_400_000) {
          delete p[k]
          dirty = true
        }
      }
      if (dirty) await atomicWrite(PROMPTS_FILE, JSON.stringify(p))
      return p
    }

    async function mutatePrompts<T>(fn: (p: Record<string, PromptRec>) => T | Promise<T>): Promise<T> {
      const run = stateChain.p.then(async () => {
        const p = await loadPrompts()
        const r = await fn(p)
        await atomicWrite(PROMPTS_FILE, JSON.stringify(p))
        return r
      })
      stateChain.p = run.catch(() => {})
      return run
    }

    // Actions run in whichever process owns the session (opencode plugin or the
    // raven daemon). Entries arrive as generic session.* / permission.* actions;
    // the driver translates them to its own client.
    const executeAction = (action: string, payload: any): Promise<any> => o.runAction(action, payload)
    async function submitAction(targetKey: InstanceKey, action: string, payload: any, timeout = 12_000): Promise<any> {
      if (targetKey === KEY) return executeAction(action, payload)
      const id = randomUUID()
      const item: InboxItem = { id, key: targetKey, action, payload, ts: Date.now() }
      await fsp.mkdir(INBOX, { recursive: true })
      await atomicWrite(path.join(INBOX, `${Date.now()}-${id.slice(0, 6)}.json`), JSON.stringify(item))
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id)
          noteInstanceResult(targetKey, false)
          reject(new Error(`${action}: instance did not respond (is that project open?)`))
        }, timeout)
        waiters.set(id, { resolve, reject, timer })
        log("debug", `wait ${action} id=${id.slice(0, 8)} target=${targetKey.slice(0, 8)} waiters=${waiters.size}`)
      })
    }

    let enqueueSeq = 0
    async function enqueue(item: OutItem) {
      try {
        await fsp.mkdir(OUTBOX, { recursive: true })
        // timestamp + monotonic seq keeps same-millisecond events in causal order (random suffixes used to reorder idle before the last stream update)
        const name = `${String(Date.now()).padStart(15, "0")}-${String(++enqueueSeq % 1_000_000).padStart(6, "0")}-${randomUUID().slice(0, 4)}.json`
        await atomicWrite(path.join(OUTBOX, name), JSON.stringify(item))
        // Always kick: drainOutbox itself no-ops for non-leaders after one
        // cheap lock read, so this wakes the leader in ~60ms instead of
        // waiting for the next 3s leaderTick.
        kickDrain()
      } catch (e: any) {
        log("warn", `enqueue failed: ${e?.message ?? e}`)
      }
    }

    function kickDrain() {
      if (kickTimer || disposed) return
      kickTimer = setTimeout(() => {
        kickTimer = null
        void drainOutbox()
      }, 60)
    }

    function kickInbox() {
      if (inboxKickTimer || disposed) return
      inboxKickTimer = setTimeout(() => {
        inboxKickTimer = null
        void inboxTick()
      }, 120)
    }

    function watchDir(dir: string, onChange: () => void) {
      try {
        const w = watch(dir, { persistent: false }, () => {
          if (!disposed) onChange()
        })
        w.on("error", () => {})
        watchers.push(w)
      } catch {}
    }

    async function readOwner(): Promise<{ key: string; hb: number; pid: number } | null> {
      return readJSON<any>(OWNER, null)
    }

    async function isLeader(): Promise<boolean> {
      const o = await readOwner()
      return !!o && o.key === KEY
    }

    async function tryAcquire() {
      try {
        await fsp.mkdir(BR, { recursive: true })
        // Non-recursive on purpose: throws EEXIST when another instance
        // already holds the lock, so only one winner exists. A recursive
        // mkdir would silently succeed for everyone.
        await fsp.mkdir(LOCK)
        await fsp.writeFile(OWNER, JSON.stringify({ key: KEY, pid: process.pid, hb: Date.now() }), "utf8")
        log("info", "acquired leadership")
        return true
      } catch {
        return false
      }
    }

    async function leaderTick() {
      if (disposed) return
      try {
        const o = await readOwner()
        const now = Date.now()
        if (o?.key === KEY) {
          firstLockSeen = 0
          await atomicWrite(OWNER, JSON.stringify({ key: KEY, pid: process.pid, hb: now }))
          await drainOutbox()
          if (!tgRunning) void tgLoop()
          const servers = new Set<string>()
          for (const [, v] of instances.entries()) {
            if (Date.now() - v.lastSeen < 120_000 && v.serverUrl) servers.add(v.serverUrl)
          }
          if (servers.size > 1 && !warnedMultiServer) {
            warnedMultiServer = true
            log("warn", `multiple opencode servers detected (${[...servers].join(", ")}) — is OpenCode open twice? Every project should live in one app instance.`)
          } else if (servers.size <= 1 && warnedMultiServer) {
            warnedMultiServer = false
          }
          return
        }
        const stale = !o || now - (o.hb ?? 0) > 12_000
        const ownerless = !o
        if (ownerless) {
          try {
            const st = await fsp.stat(LOCK)
            if (!firstLockSeen) firstLockSeen = st.mtimeMs
            if (now - firstLockSeen < 5_000) return
          } catch {
            firstLockSeen = 0
          }
        }
        if (stale) {
          try {
            await fsp.rm(LOCK, { recursive: true, force: true })
          } catch {}
          firstLockSeen = 0
          await tryAcquire()
        }
      } catch (e: any) {
        log("warn", `leaderTick: ${e?.message ?? e}`)
      }
    }

    async function drainOutbox() {
      if (draining || disposed) return
      if (!(await isLeader())) return
      draining = true
      try {
        let names: string[] = []
        try {
          names = (await fsp.readdir(OUTBOX)).filter((n: string) => n.endsWith(".json")).sort()
        } catch {
          names = []
        }
        if (names.length) log("debug", `drain sees ${names.length} file(s)`)
        for (const name of names) {
          if (disposed || !(await isLeader())) break
          const file = path.join(OUTBOX, name)
          const ts = Number(name.slice(0, 15)) || 0
          if (Date.now() - ts > 900_000) {
            await fsp.rm(file, { force: true }).catch(() => {})
            continue
          }
          const item = await readJSON<OutItem | null>(file, null)
          await fsp.rm(file, { force: true }).catch(() => {})
          if (!item) continue
          if (item.t === "event" && Date.now() - item.ts > 120_000) {
            log("debug", `dropped stale event ${item.event.type} (age ${Math.round((Date.now() - item.ts) / 1000)}s)`)
            continue
          }
          try {
            await handleOut(item)
          } catch (e: any) {
            log("warn", `outbox ${item.t}: ${e?.message ?? e}`)
          }
        }
        if (await isLeader()) await gcInbox()
      } finally {
        draining = false
      }
    }

    async function gcInbox() {
      try {
        const names = await fsp.readdir(INBOX)
        const now = Date.now()
        for (const name of names) {
          const ts = Number(name.slice(0, 15)) || 0
          if (ts && now - ts > 60_000) await fsp.rm(path.join(INBOX, name), { force: true }).catch(() => {})
        }
      } catch {}
    }

    async function handleOut(item: OutItem) {
      if (item.t === "hello") {
        instances.set(item.key, { dir: item.dir, serverUrl: item.serverUrl, client: item.client ?? "oc", lastSeen: Date.now(), fails: 0, downUntil: 0 })
        scheduleWork(`reconcile ${item.key.slice(0, 8)}`, () => reconcile(item.key))
        return
      }
      if (item.t === "ack") {
        const w = waiters.get(item.id)
        log("debug", `ack ${w ? "hit" : "MISS"} id=${String(item.id).slice(0, 8)} waiters=${waiters.size}`)
        noteInstanceResult(item.key, true)
        if (w) {
          waiters.delete(item.id)
          clearTimeout(w.timer)
          if (item.ok) w.resolve(item.data)
          else w.reject(new Error(item.error || "action failed"))
        }
        return
      }
      if (item.t === "event") {
        instances.set(item.key, { dir: item.dir, serverUrl: item.serverUrl, client: item.client ?? "oc", lastSeen: Date.now(), fails: 0, downUntil: 0 })
        scheduleWork(`event ${item.event.type}`, () => processEvent(item.key, item.dir, item.event))
      }
    }

    async function reconcile(key: InstanceKey) {
      const last = reconciled.get(key) ?? 0
      if (Date.now() - last < 60_000) return
      reconciled.set(key, Date.now())
      try {
        const res = await submitAction(key, "session.list", {}, 8_000)
        log("debug", `reconcile ${key.slice(0, 8)} session.list ok (${(res?.sessions ?? []).length} sessions)`)
        await ingestSessions(key, res?.sessions ?? [], res?.previews)
        const pend = await submitAction(key, "pending", {}, 8_000)
        const cfg = await loadConfig()
        for (const p of pend?.permissions ?? []) await notifyPermission(cfg, key, p)
        for (const q of pend?.questions ?? []) await notifyQuestion(cfg, key, q)
      } catch (e: any) {
        log("debug", `reconcile ${key.slice(0, 8)}: ${e?.message ?? e}`)
        const inst = instances.get(key)
        if (inst) instances.set(key, { ...inst, lastSeen: Date.now() - 600_000 })
      }
    }

    async function ingestSessions(key: InstanceKey, sessions: any[], previews?: Record<string, string>) {
      if (!Array.isArray(sessions)) return
      await mutateState((s) => {
        for (const sess of sessions) {
          if (!sess?.id) continue
          const prev = s.sessions[sess.id]
          s.sessions[sess.id] = {
            key,
            dir: sess.directory ?? prev?.dir ?? MY_DIR,
            title: sess.title || prev?.title || shortId(sess.id),
            updated: sess.time?.updated ?? prev?.updated ?? Date.now(),
            parentID: sess.parentID ?? prev?.parentID,
            preview: previews?.[sess.id] ?? prev?.preview,
            ...mergeServerModel(prev, modelFromInfo(sess.model)),
            ...mergeServerAgent(prev, sess.agent ? modeOf(String(sess.agent)) : undefined),
            client: prev?.client ?? (sess.client ?? clientOf(sess.id)),
          }
        }
      })
    }

    async function sessionTitle(sid: string, fallbackKey?: InstanceKey): Promise<{ title: string; key: InstanceKey; dir: Dir }> {
      const s = await loadState()
      const hit = s.sessions[sid]
      if (hit) return { title: hit.title, key: hit.key, dir: hit.dir }
      const instDir = fallbackKey ? instances.get(fallbackKey)?.dir : undefined
      if (fallbackKey) {
        const inst = instances.get(fallbackKey)
        try {
          const info = await submitAction(fallbackKey, "session.get", { sessionID: sid }, 6_000)
          if (info?.id) {
            await mutateState((st) => {
              const prev = st.sessions[sid]
              st.sessions[sid] = {
                key: fallbackKey,
                dir: info.directory ?? inst?.dir ?? MY_DIR,
                title: info.title || shortId(sid),
                updated: info.time?.updated ?? Date.now(),
                parentID: info.parentID,
                preview: prev?.preview,
                client: prev?.client ?? clientOf(sid),
                ...mergeServerModel(prev, modelFromInfo(info.model)),
                ...mergeServerAgent(prev, info.agent ? modeOf(String(info.agent)) : undefined),
              }
            })
            return { title: info.title || shortId(sid), key: fallbackKey, dir: info.directory ?? inst?.dir ?? MY_DIR }
          }
        } catch {}
      }
      return { title: shortId(sid), key: fallbackKey ?? KEY, dir: instDir ?? MY_DIR }
    }

    async function displayTitle(
      sid: string,
      fallbackKey?: InstanceKey,
    ): Promise<{ title: string; key: InstanceKey; dir: Dir; isSub: boolean }> {
      const base = await sessionTitle(sid, fallbackKey)
      const s = await loadState()
      const parentID = s.sessions[sid]?.parentID
      if (!parentID) return { ...base, isSub: false }
      const parent = s.sessions[parentID]
      const parentTitle = parent?.title || shortId(parentID)
      return { title: `${parentTitle} · subagent`, key: base.key, dir: base.dir, isSub: true }
    }

    async function processEvent(key: InstanceKey, dir: Dir, ev: { type: string; properties: any }) {
      const type = ev.type
      const p = ev.properties ?? {}
      const cfg = await loadConfig()
      if (!cfg.enabled || !cfg.botToken) return

      if (type === "session.created" || type === "session.updated") {
        const info = p.info
        if (info?.id) {
          await mutateState((s) => {
            const prev = s.sessions[info.id]
            s.sessions[info.id] = {
              key,
              dir: info.directory ?? dir,
              title: info.title || prev?.title || shortId(info.id),
              updated: info.time?.updated ?? Date.now(),
              parentID: info.parentID ?? prev?.parentID,
              preview: prev?.preview,
              ...mergeServerModel(prev, modelFromInfo(info.model)),
              ...mergeServerAgent(prev, info.agent ? modeOf(String(info.agent)) : undefined),
              client: prev?.client ?? (info.client ?? clientOf(info.id)),
            }
          })
          if (type === "session.created" && cfg.notify.session) {
            const dk = `sc:${info.id}`
            const sent = await mutateState((s) => {
              if (s.dedupe[dk]) return false
              s.dedupe[dk] = Date.now()
              return true
            })
            if (sent) await broadcast(cfg, `🆕 session: ${info.title || shortId(info.id)}`)
          }
        }
        return
      }

      if (type === "session.deleted") {
        const sid = p.sessionID
        if (sid)
          await mutateState((s) => {
            delete s.sessions[sid]
            delete s.awaiting[sid]
            for (const c of Object.values(s.chats)) {
              if (c.active?.sid === sid) delete c.active
              if (c.agent?.sid === sid) delete c.agent
            }
          })
        return
      }

      if (type === "permission.asked" || type === "permission.v2.asked") {
        await notifyPermission(cfg, key, p)
        return
      }
      if (type === "permission.replied" || type === "permission.v2.replied") {
        await onPermissionReplied(p)
        return
      }
      if (type === "question.asked" || type === "question.v2.asked") {
        await notifyQuestion(cfg, key, p)
        return
      }
      if (type === "question.replied" || type === "question.v2.replied") {
        await onQuestionReplied(p)
        return
      }
      if (type === "question.rejected" || type === "question.v2.rejected") {
        await onQuestionRejected(p)
        return
      }
      if (type === "session.error") {
        const sid = p.sessionID
        const err = p.error
        const msg = String(err?.data?.message ?? err?.message ?? (typeof err === "string" ? err : "unknown error"))
        if (sid) await onSessionError(cfg, sid, msg)
        if (cfg.notify.error) {
          const t = sid ? await displayTitle(sid, key) : null
          await broadcast(cfg, `❌ ${t ? t.title + " " : ""}failed: ${clip(msg, 800)}`)
        }
        return
      }
      if (type === "message.part.updated") {
        const part = p.part ?? {}
        if (part?.type === "text" && p.sessionID && typeof part.text === "string") await onStreamText(cfg, p.sessionID, part.text)
        return
      }
      if (type === "session.status" || type === "session.idle") {
        const sid = p.sessionID
        const status = type === "session.status" ? p.status : { type: "idle" }
        if (!sid || !status) return
        if (status.type === "busy") {
          await mutateState((s) => void (s.lastBusy[sid] = Date.now()))
          await onBusyCard(cfg, sid)
          return
        }
        if (status.type === "retry") {
          await onRetryCard(cfg, sid, status)
          return
        }
        if (status.type !== "idle") return
        await onIdle(cfg, key, sid)
      }
    }

    function turnCardText(title: string, prompt: string, state: string): string {
      return clip([`💬 ${title}`, `You: ${clip(prompt, 500)}`, state].join("\n\n"), 3900)
    }

    async function refreshTurnCards(sid: string, makeState: (title: string, prompt: string) => string | null, force = false) {
      const now = Date.now()
      const info = await mutateState((s) => {
        const a = s.awaiting[sid]
        if (!a) return null
        if (!force && now - (a.lastCardEdit ?? 0) < 20_000) return null
        a.lastCardEdit = now
        return { chats: [...a.chats], prompt: a.prompt ?? "", cards: { ...(a.cards ?? {}) } }
      })
      if (!info) return
      const t = await displayTitle(sid).catch(() => null)
      const stateText = makeState(t?.title ?? shortId(sid), info.prompt)
      if (!stateText) return
      for (const chatId of info.chats) {
        const mid = info.cards[String(chatId)]
        if (mid) await editMessage(chatId, mid, stateText, stopKeyboard(sid)).catch(() => {})
      }
    }

    async function onBusyCard(cfg: any, sid: string) {
      await refreshTurnCards(sid, (title, prompt) => turnCardText(title, prompt, `⏳ working…`))
    }

    // Live tail of the assistant's streaming answer. Only text parts are shown
    // (never reasoning/tools/edits), throttled so Telegram edit limits hold.
    async function onStreamText(_cfg: any, sid: string, text: string) {
      const trimmed = String(text ?? "").trim()
      if (!trimmed) return
      const now = Date.now()
      const info = await mutateState((s) => {
        const a = s.awaiting[sid]
        if (!a) return null
        a.stream = tailClip(trimmed, 1500)
        const force = !a.streamShown
        a.streamShown = true
        if (!force && now - (a.lastStreamEdit ?? 0) < 2_500) return null
        a.lastStreamEdit = now
        return { chats: [...a.chats], cards: { ...(a.cards ?? {}) }, prompt: a.prompt ?? "", stream: a.stream }
      })
      if (!info) return
      const t = await displayTitle(sid).catch(() => null)
      const title = t?.title ?? shortId(sid)
      const body = turnCardText(title, info.prompt, `🤖 ${info.stream}`)
      for (const chatId of info.chats) {
        const mid = info.cards[String(chatId)]
        if (mid) await editMessage(chatId, mid, body, stopKeyboard(sid)).catch(() => {})
      }
      await refreshStreamPanels(sid)
    }

    async function refreshStreamPanels(sid: string) {
      const now = Date.now()
      const st = await loadState()
      for (const ck of Object.keys(st.chats)) {
        const c = st.chats[ck]
        const ui = c?.ui
        if (ui?.panelId && ui.screen?.name === "session" && ui.screen.sid === sid) {
          const chatId = Number(ck)
          const k = `${chatId}:${sid}`
          if (now - (streamEdits.get(k) ?? 0) < 4_000) continue
          streamEdits.set(k, now)
          await showPanel(chatId).catch(() => {})
        }
      }
    }

    async function onRetryCard(_cfg: any, sid: string, status: any) {
      await refreshTurnCards(
        sid,
        (title, prompt) =>
          turnCardText(
            title,
            prompt,
            `⚠️ ${clip(String(status?.message ?? "model error"), 200)}\n🔁 auto-retrying${status?.attempt ? ` (attempt ${status.attempt})` : ""}…`,
          ),
        true,
      )
    }

    async function onSessionError(_cfg: any, sid: string, msg: string) {
      const a = await mutateState((s) => {
        const cur = s.awaiting[sid]
        if (!cur) return null
        cur.error = clip(msg, 400)
        cur.lastCardEdit = 0
        return { chats: [...cur.chats], cards: { ...(cur.cards ?? {}) }, prompt: cur.prompt ?? "" }
      })
      if (!a) return
      const t = await displayTitle(sid).catch(() => null)
      const body = turnCardText(
        t?.title ?? shortId(sid),
        a.prompt,
        `❌ ${clip(msg, 300)}\n\nopencode auto-retries on its own. Tap ⏹ Stop to interrupt it and send something else instead.`,
      )
      for (const chatId of a.chats) {
        const mid = a.cards[String(chatId)]
        if (mid) await editMessage(chatId, mid, body, stopKeyboard(sid)).catch(() => {})
      }
    }

    async function onIdle(cfg: any, key: InstanceKey, sid: string) {
      const now = Date.now()
      const doNotify = await mutateState((s) => {
        const li = s.lastIdle[sid] ?? 0
        if (now - li < 1_500 && (s.lastBusy[sid] ?? 0) < li) return false
        s.lastIdle[sid] = now
        return true
      })
      if (!doNotify) return

      const awaiting = await mutateState((s) => {
        const a = s.awaiting[sid]
        if (a) delete s.awaiting[sid]
        return a ?? null
      })
      const t = await displayTitle(sid, key)
      const title = t.title

      if (awaiting && cfg.relay) {
        let excerpt = ""
        try {
          const regKey = (await loadState()).sessions[sid]?.key ?? awaiting.key
          const msgs = await submitAction(regKey, "session.messages", { sessionID: sid, limit: 20 }, 8_000)
          const arr = Array.isArray(msgs) ? msgs : []
          const cutoff = awaiting.at - 15_000
          let startIdx = 0
          for (let i = arr.length - 1; i >= 0; i--) {
            const m: any = arr[i]
            if (m?.info?.role === "user" && (m?.info?.time?.created ?? 0) >= cutoff) {
              startIdx = i + 1
              break
            }
          }
          const win = arr.slice(startIdx)
          for (let i = win.length - 1; i >= 0 && !excerpt; i--) {
            const m: any = win[i]
            if (m?.info?.role !== "assistant") continue
            const t = (m.parts ?? [])
              .filter((pt: any) => pt?.type === "text" && typeof pt.text === "string" && pt.text.trim())
              .map((pt: any) => pt.text)
              .join("\n")
              .trim()
            if (t) excerpt = t
          }
          if (!excerpt) {
            for (let i = win.length - 1; i >= 0 && !excerpt; i--) {
              const m: any = win[i]
              for (const pt of m?.parts ?? []) {
                if (pt?.type !== "tool") continue
                const out = typeof pt.state?.output === "string" ? pt.state.output.trim() : ""
                const cmd = typeof pt.state?.input?.command === "string" ? pt.state.input.command : ""
                if (out) {
                  excerpt = `🔧 ${pt.tool}: ${clip(out, 700)}`
                  break
                }
                if (cmd) {
                  excerpt = `🔧 ${pt.tool}: ${clip(cmd, 300)}`
                  break
                }
              }
            }
          }
        } catch (e: any) {
          log("debug", `relay fetch: ${e?.message ?? e}`)
        }
        for (const chatId of awaiting.chats) {
          if (!cfg.authorizedChatIds.includes(chatId)) continue
          const body = awaiting.error
            ? `⚠️ ${title}: ${clip(awaiting.error, 400)}${excerpt ? `\n\nlast reply:\n${clip(excerpt, 2700)}` : ""}\n\nYou can send a new instruction now.`
            : excerpt
              ? `✅ ${title} finished\n\n${clip(excerpt, 3400)}`
              : `✅ ${title} finished\n\n(no text reply — check the app)`
          const mid = awaiting.cards?.[String(chatId)]
          // Keep the live card accurate, then ALWAYS send a fresh message:
          // Telegram edits are silent (no sound/badge), so the edit alone is
          // easy to miss. The new message is the audible "it's over" ping.
          if (mid) await editMessage(chatId, mid, body).catch(() => false)
          await tgSend(cfg, chatId, body).catch((e: any) => log("warn", `finish send ${chatId}: ${e?.message ?? e}`))
        }
        await maybeRefreshPanels(awaiting.chats)
        return
      }

      if (t.isSub) {
        log("debug", `subagent idle ${sid} folded into parent (no separate notification)`)
        return
      }
      if (cfg.notify.idle) await broadcast(cfg, `✅ ${title} finished`)
    }

    async function notifyPermission(cfg: any, key: InstanceKey, p: any) {
      if (!cfg.notify.permission) return
      const id = p?.id
      if (!id) return
      const prompts = await loadPrompts()
      if (prompts[id]) return
      const t = await displayTitle(p.sessionID, key)
      const text = permCardText(t, p)
      const keyboard = permCardKeyboard(id)
      const rec: PromptRec = {
        kind: "permission",
        key,
        dir: t.dir,
        sessionID: p.sessionID,
        sentAt: Date.now(),
        msgs: [],
        permission: p,
      }
      for (const chatId of cfg.authorizedChatIds) {
        try {
          const mid = await tgSend(cfg, chatId, text, keyboard)
          if (mid) rec.msgs.push({ chatId, messageId: mid })
        } catch (e: any) {
          log("warn", `permission notify ${chatId}: ${e?.message ?? e}`)
        }
      }
      if (rec.msgs.length) await mutatePrompts((pr) => void (pr[id] = rec))
      log("info", `permission.asked ${id} session=${p.sessionID} notified=${rec.msgs.length}`)
      await maybeRefreshPanels(cfg.authorizedChatIds)
    }

    async function notifyQuestion(cfg: any, key: InstanceKey, p: any) {
      if (!cfg.notify.question) return
      const id = p?.id
      if (!id) return
      const prompts = await loadPrompts()
      if (prompts[id]) return
      const t = await displayTitle(p.sessionID, key)
      const questions = Array.isArray(p.questions) ? p.questions : []
      if (!questions.length) return

      const single = questions.length === 1 && !questions[0].multiple
      const text = questionCardText(t, questions)

      const selections: number[][] = questions.map(() => [])
      const keyboard = buildQuestionKeyboard(id, questions, selections, single)

      const rec: PromptRec = {
        kind: "question",
        key,
        dir: t.dir,
        sessionID: p.sessionID,
        sentAt: Date.now(),
        msgs: [],
        questions,
        selections,
        baseText: text,
      }
      for (const chatId of cfg.authorizedChatIds) {
        try {
          const mid = await tgSend(cfg, chatId, text, keyboard)
          if (mid) rec.msgs.push({ chatId, messageId: mid })
        } catch (e: any) {
          log("warn", `question notify ${chatId}: ${e?.message ?? e}`)
        }
      }
      if (rec.msgs.length) await mutatePrompts((pr) => void (pr[id] = rec))
      log("info", `question.asked ${id} session=${p.sessionID}`)
      await maybeRefreshPanels(cfg.authorizedChatIds)
    }

    function buildQuestionKeyboard(id: string, questions: any[], selections: number[][], single: boolean) {
      const rows: { text: string; callback_data: string }[][] = []
      questions.forEach((q: any, qi: number) => {
        const opts = q.options ?? []
        opts.forEach((o: any, oi: number) => {
          const marked = selections[qi]?.includes(oi)
          if (single) rows.push([{ text: `${marked ? "✅ " : ""}${clip(o.label, 40)}`, callback_data: `qa:${id}:${qi}:${oi}` }])
          else
            rows.push([{ text: `${marked ? "✅ " : ""}${clip(o.label, 40)}`, callback_data: `qt:${id}:${qi}:${oi}` }])
        })
        if (questions.length > 1) rows.push([{ text: `— Q${qi + 1} —`, callback_data: "noop" }])
      })
      if (!single)
        rows.push([
          { text: "Submit", callback_data: `qs:${id}` },
          { text: "Dismiss", callback_data: `qr:${id}` },
        ])
      return { inline_keyboard: rows }
    }

    async function onPermissionReplied(p: any) {
      const id = p.requestID
      if (!id) return
      await mutatePrompts((pr) => {
        const rec = pr[id]
        if (!rec || rec.handled) return
        rec.handled = true
        for (const m of rec.msgs)
          void editMessage(m.chatId, m.messageId, `☑️ answered in app: ${p.reply ?? ""}`).catch(() => {})
      })
    }

    async function onQuestionReplied(p: any) {
      const id = p.requestID
      if (!id) return
      const answers = (p.answers ?? []).flat().join(", ")
      await mutatePrompts((pr) => {
        const rec = pr[id]
        if (!rec || rec.handled) return
        rec.handled = true
        for (const m of rec.msgs) void editMessage(m.chatId, m.messageId, `☑️ answered in app: ${clip(answers, 300)}`).catch(() => {})
      })
    }

    async function onQuestionRejected(p: any) {
      const id = p.requestID
      if (!id) return
      await mutatePrompts((pr) => {
        const rec = pr[id]
        if (!rec || rec.handled) return
        rec.handled = true
        for (const m of rec.msgs) void editMessage(m.chatId, m.messageId, `☑️ dismissed in app`).catch(() => {})
      })
    }

    async function broadcast(cfg: any, text: string) {
      for (const chatId of cfg.authorizedChatIds) {
        await tgSend(cfg, chatId, text).catch((e: any) => log("warn", `broadcast ${chatId}: ${e?.message ?? e}`))
      }
    }

    function redactProxy(proxyUrl: string): string {
      try {
        const u = new URL(proxyUrl)
        return `${u.protocol}//${u.username ? "***@" : ""}${u.hostname}${u.port ? `:${u.port}` : ""}`
      } catch {
        return "(invalid proxy URL)"
      }
    }

    function readSock(sock: net.Socket, want: (buf: Buffer) => number | null, timeoutMs: number): Promise<Buffer> {
      return new Promise((resolve, reject) => {
        let buf = Buffer.alloc(0)
        const timer = setTimeout(() => {
          cleanup()
          try { sock.destroy() } catch {}
          reject(new Error("timed out waiting for proxy response"))
        }, timeoutMs)
        const cleanup = () => {
          clearTimeout(timer)
          sock.off("data", onData)
          sock.off("error", onError)
          sock.off("close", onClose)
        }
        const onData = (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk])
          const need = want(buf)
          if (need === null) {
            cleanup()
            resolve(buf)
          }
        }
        const onError = (e: any) => {
          cleanup()
          reject(e)
        }
        const onClose = () => {
          cleanup()
          reject(new Error("proxy connection closed early"))
        }
        sock.on("data", onData)
        sock.once("error", onError)
        sock.once("close", onClose)
      })
    }

    async function httpConnectTunnel(proxy: URL, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
      const sock = net.connect({ host: proxy.hostname || "127.0.0.1", port: Number(proxy.port || 8080) })
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          try { sock.destroy() } catch {}
          reject(new Error(`timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        sock.once("error", (e) => {
          clearTimeout(timer)
          reject(e)
        })
        sock.once("connect", () => {
          let auth = ""
          if (proxy.username) {
            auth = `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n`
          }
          sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`, (err) => {
            clearTimeout(timer)
            if (err) reject(err)
            else resolve()
          })
        })
      }).catch((e: any) => {
        try { sock.destroy() } catch {}
        throw e
      })
      const head = await readSock(sock, (b) => (b.indexOf("\r\n\r\n") >= 0 ? null : 1), timeoutMs)
      const statusLine = head.slice(0, head.indexOf("\r\n")).toString().trim()
      const m = statusLine.match(/^HTTP\/\S+\s+(\d+)/)
      if (!m || Number(m[1]) !== 200) {
        try { sock.destroy() } catch {}
        throw new Error(`proxy refused CONNECT (${statusLine || "no status line"})`)
      }
      return sock
    }

    async function socksConnectTunnel(proxy: URL, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
      const sock = net.connect({ host: proxy.hostname || "127.0.0.1", port: Number(proxy.port || 1080) })
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          try { sock.destroy() } catch {}
          reject(new Error(`timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        sock.once("error", (e) => {
          clearTimeout(timer)
          reject(e)
        })
        sock.once("connect", () => {
          clearTimeout(timer)
          resolve()
        })
      }).catch((e: any) => {
        try { sock.destroy() } catch {}
        throw e
      })
      const write = (b: Buffer) =>
        new Promise<void>((resolve, reject) => {
          sock.write(b, (err) => (err ? reject(err) : resolve()))
        })
      const hasAuth = !!proxy.username
      await write(Buffer.from(hasAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]))
      const methodPick = await readSock(sock, (b) => (b.length >= 2 ? null : 2), timeoutMs)
      if (methodPick[0] !== 0x05) {
        try { sock.destroy() } catch {}
        throw new Error("proxy is not SOCKS5")
      }
      if (methodPick[1] === 0x02) {
        if (!hasAuth) {
          try { sock.destroy() } catch {}
          throw new Error("proxy requires username/password authentication")
        }
        const user = Buffer.from(decodeURIComponent(proxy.username), "utf8")
        const pass = Buffer.from(decodeURIComponent(proxy.password), "utf8")
        if (user.length > 255 || pass.length > 255) {
          try { sock.destroy() } catch {}
          throw new Error("proxy username/password too long (max 255 bytes)")
        }
        await write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]))
        const authRes = await readSock(sock, (b) => (b.length >= 2 ? null : 2), timeoutMs)
        if (authRes[0] !== 0x01 || authRes[1] !== 0x00) {
          try { sock.destroy() } catch {}
          throw new Error("proxy authentication failed (bad username/password?)")
        }
      } else if (methodPick[1] !== 0x00) {
        try { sock.destroy() } catch {}
        throw new Error("proxy offered no usable auth method")
      }
      let atyp: number
      let addr: Buffer
      if (net.isIP(host) === 4) {
        atyp = 0x01
        addr = Buffer.from(host.split(".").map((x) => Number(x)))
      } else if (net.isIP(host) === 6) {
        try { sock.destroy() } catch {}
        throw new Error("IPv6 targets are not supported through SOCKS in this build")
      } else {
        const name = Buffer.from(host, "utf8")
        if (name.length > 255) {
          try { sock.destroy() } catch {}
          throw new Error("hostname too long for SOCKS")
        }
        atyp = 0x03
        addr = Buffer.concat([Buffer.from([name.length]), name])
      }
      const req = Buffer.alloc(4 + addr.length + 2)
      req[0] = 0x05
      req[1] = 0x01
      req[2] = 0x00
      req[3] = atyp
      addr.copy(req, 4)
      req.writeUInt16BE(port, 4 + addr.length)
      await write(req)
      const head = await readSock(sock, (b) => {
        if (b.length < 4) return 4
        const ra = b[3]
        if (ra === 0x01) return b.length >= 10 ? null : 10
        if (ra === 0x04) return b.length >= 22 ? null : 22
        if (ra === 0x03) {
          if (b.length < 5) return 5
          return b.length >= 5 + b[4] + 2 ? null : 5 + b[4] + 2
        }
        return null
      }, timeoutMs)
      if (head[0] !== 0x05 || head[1] !== 0x00) {
        const reasons: Record<number, string> = { 1: "general failure", 2: "not allowed by ruleset", 3: "network unreachable", 4: "host unreachable", 5: "connection refused", 6: "TTL expired", 7: "command not supported", 8: "address type not supported" }
        try { sock.destroy() } catch {}
        throw new Error(`proxy refused the connection (SOCKS error ${head[1]}: ${reasons[head[1]] ?? "unknown"})`)
      }
      return sock
    }

    async function tgPostViaProxy(proxyUrl: string, url: string, body: Buffer, contentType: string, timeoutMs: number): Promise<any> {
      let proxy: URL
      try {
        proxy = new URL(proxyUrl)
      } catch {
        throw new Error(`bad proxy URL ${redactProxy(proxyUrl)} — use http://host:port or socks5://host:port`)
      }
      const scheme = proxy.protocol.replace(/:$/, "")
      if (scheme !== "http" && scheme !== "socks5" && scheme !== "socks5h") {
        throw new Error(`unsupported proxy scheme "${proxy.protocol}" (${redactProxy(proxyUrl)}) — use http:// or socks5:// (MTProto proxies cannot carry Bot API traffic)`)
      }
      if (!proxy.hostname) throw new Error(`proxy URL has no host: ${redactProxy(proxyUrl)}`)
      const label = redactProxy(proxyUrl)
      const target = new URL(url)
      const targetPort = Number(target.port || (target.protocol === "https:" ? 443 : 80))
      let sock: net.Socket
      try {
        sock =
          scheme === "http"
            ? await httpConnectTunnel(proxy, target.hostname, targetPort, Math.min(timeoutMs, 20_000))
            : await socksConnectTunnel(proxy, target.hostname, targetPort, Math.min(timeoutMs, 20_000))
      } catch (e: any) {
        throw new Error(`proxy ${label} unreachable: ${e?.message ?? e} — is your proxy running?`)
      }
      return await new Promise((resolve, reject) => {
        let settled = false
        let stream: net.Socket | tls.TLSSocket = sock
        const timer = setTimeout(() => {
          fail(new Error(`Telegram request via ${label} timed out after ${timeoutMs}ms — Telegram may be filtered on this network`))
        }, timeoutMs)
        const fail = (e: any) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          try { stream.destroy() } catch {}
          const msg = String(e?.message ?? e)
          reject(new Error(`Telegram via proxy ${label} failed: ${msg}`))
        }
        const chunks: Buffer[] = []
        const finish = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          try { stream.destroy() } catch {}
          const raw = Buffer.concat(chunks).toString("utf8")
          const idx = raw.indexOf("\r\n\r\n")
          const payload = idx >= 0 ? raw.slice(idx + 4) : raw
          try {
            resolve(JSON.parse(payload))
          } catch {
            reject(new Error(`proxy ${label} returned non-JSON from Telegram (first bytes: ${clip(payload.slice(0, 80), 80)})`))
          }
        }
        const headerText =
          `POST ${target.pathname}${target.search} HTTP/1.1\r\n` +
          `Host: ${target.hostname}\r\n` +
          `Content-Type: ${contentType}\r\n` +
          `Content-Length: ${body.length}\r\n` +
          `Connection: close\r\n\r\n`
        const startIO = () => {
          stream.on("data", (c: Buffer) => chunks.push(c))
          stream.once("error", fail)
          stream.once("end", finish)
          stream.once("close", () => {
            if (!settled) {
              if (chunks.length) finish()
              else fail(new Error("connection closed before any response"))
            }
          })
          stream.write(headerText, (err: any) => {
            if (err) {
              fail(err)
              return
            }
            stream.write(body, (err2: any) => {
              if (err2) fail(err2)
            })
          })
        }
        if (target.protocol === "https:") {
          try {
            const tlsSock = tls.connect({ socket: sock, servername: target.hostname, timeout: timeoutMs } as any)
            stream = tlsSock
            tlsSock.once("secureConnect", startIO)
            tlsSock.once("error", fail)
          } catch (e: any) {
            fail(e)
          }
        } else {
          startIO()
        }
      })
    }

    async function tgApi(cfg: any, method: string, params: any, timeoutMs = 35_000, raw?: { body: Buffer; contentType: string }) {
      let j: any
      if (raw) {
        if (cfg.proxy) {
          j = await tgPostViaProxy(cfg.proxy, `${cfg.apiBase}/bot${cfg.botToken}/${method}`, raw.body, raw.contentType, timeoutMs)
        } else {
          const res = await fetch(`${cfg.apiBase}/bot${cfg.botToken}/${method}`, {
            method: "POST",
            headers: { "content-type": raw.contentType },
            body: raw.body as any,
            signal: AbortSignal.timeout(timeoutMs),
          })
          j = await res.json().catch(() => ({ ok: false, description: `http ${res.status}` }))
        }
      } else if (cfg.proxy) {
        j = await tgPostViaProxy(cfg.proxy, `${cfg.apiBase}/bot${cfg.botToken}/${method}`, Buffer.from(JSON.stringify(params), "utf8"), "application/json", timeoutMs)
      } else {
        const res = await fetch(`${cfg.apiBase}/bot${cfg.botToken}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(timeoutMs),
        })
        j = await res.json().catch(() => ({ ok: false, description: `http ${res.status}` }))
      }
      if (!j.ok) {
        const err: any = new Error(`${method}: ${j.description ?? "failed"}`)
        err.telegram = true
        err.code = j.error_code
        throw err
      }
      return j.result
    }

    function buildMultipart(fields: Record<string, string>, file: { field: string; filename: string; contentType: string; content: Buffer }): { body: Buffer; contentType: string } {
      const boundary = `----ocbridge${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`
      const chunks: Buffer[] = []
      for (const [k, v] of Object.entries(fields)) {
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, "utf8"))
      }
      const safeName = file.filename.replace(/["\r\n]/g, "_")
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${safeName}"\r\nContent-Type: ${file.contentType}\r\n\r\n`, "utf8"))
      chunks.push(file.content)
      chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"))
      return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
    }

    async function tgSendDocument(cfg: any, chatId: number, filename: string, content: string, caption?: string): Promise<number | null> {
      const raw = buildMultipart(
        { chat_id: String(chatId), ...(caption ? { caption: clip(caption, 1024) } : {}) },
        { field: "document", filename, contentType: "text/markdown", content: Buffer.from(content, "utf8") },
      )
      try {
        const r = await tgApi(cfg, "sendDocument", {}, 60_000, raw)
        void noteSendOk()
        return r?.message_id ?? null
      } catch (e: any) {
        if (e?.telegram && e.code && e.code < 500) throw e
        await new Promise((r) => setTimeout(r, 1200))
        try {
          const r = await tgApi(cfg, "sendDocument", {}, 60_000, raw)
          void noteSendOk()
          return r?.message_id ?? null
        } catch (e2: any) {
          if (e2?.telegram && e2.code && e2.code < 500) throw e2
          void noteSendFail(e2)
          throw e2
        }
      }
    }

    let sendFails = 0
    async function noteSendOk() {
      sendFails = 0
      try {
        const s = await loadState()
        if (s.link?.status === "offline") await setLinkOnline("send succeeded")
      } catch {}
    }
    async function noteSendFail(e: any) {
      sendFails++
      const short = e?.telegram
        ? `Telegram error ${e.code ?? "?"}: ${clip(String(e.message).replace(/^sendMessage:\s*/, ""), 120)}`
        : shortNetError(e)
      if (sendFails === 1) log("warn", `sendMessage failed (${short}) — retrying automatically`)
      else log("debug", `sendMessage failed (${short}) [${sendFails} in a row]`)
      if (sendFails >= 3) {
        try {
          const s = await loadState()
          if (s.link?.status !== "offline") await setLinkOffline(short)
        } catch {}
      }
    }
    async function tgSend(cfg: any, chatId: number, text: string, keyboard?: any): Promise<number | null> {
      const params: any = { chat_id: chatId, text: clip(text) }
      if (keyboard) params.reply_markup = keyboard
      try {
        const r = await tgApi(cfg, "sendMessage", params)
        void noteSendOk()
        return r?.message_id ?? null
      } catch (e: any) {
        if (e?.telegram && e.code && e.code < 500) throw e
        await new Promise((r) => setTimeout(r, 1200))
        try {
          const r = await tgApi(cfg, "sendMessage", params)
          void noteSendOk()
          return r?.message_id ?? null
        } catch (e2: any) {
          if (e2?.telegram && e2.code && e2.code < 500) throw e2
          void noteSendFail(e2)
          throw e2
        }
      }
    }

    // Returns true when the card now shows the new text. Never throws for
    // benign Telegram errors (message unchanged / deleted); returns false on
    // real failures (network, 5xx) so callers can fall back to sendMessage.
    async function editMessage(chatId: number, messageId: number, text: string, keyboard?: any): Promise<boolean> {
      const cfg = await loadConfig()
      const params: any = { chat_id: chatId, message_id: messageId, text: clip(text) }
      if (keyboard) params.reply_markup = keyboard
      else params.reply_markup = { inline_keyboard: [] }
      try {
        await tgApi(cfg, "editMessageText", params)
        return true
      } catch (e: any) {
        const d = String(e?.message ?? "")
        if (d.includes("message is not modified") || d.includes("message to edit not found")) return true
        log("warn", `editMessage ${messageId} failed: ${d}`)
        return false
      }
    }

    async function answerCallback(id: string, text?: string, alert = false) {
      try {
        const cfg = await loadConfig()
        await tgApi(cfg, "answerCallbackQuery", {
          callback_query_id: id,
          ...(text ? { text: clip(text, 200) } : {}),
          show_alert: alert,
        })
      } catch (e: any) {
        log("debug", `answerCallback: ${e?.message ?? e}`)
      }
    }

    function makePairCode(): string {
      let out = ""
      for (let i = 0; i < 6; i++) out += PAIR_ALPHABET[Math.floor(Math.random() * PAIR_ALPHABET.length)]
      return out
    }

    function pairingHelp(code: string): string {
      return [
        `🔐 Raven isn't paired with this Telegram account yet.`,
        ``,
        `On your computer, Raven shows this code:  ${code}`,
        `Send it back here with:  /pair ${code}`,
        `(expires in 10 minutes)`,
      ].join("\n")
    }

    async function announcePairing(req: PairingReq) {
      const msg = `🔐 Pairing request from "${req.name}" (chat ${req.chatId}) — code ${req.code} (10 min)`
      try {
        console.log(`[raven] ${msg}`)
      } catch {}
      macNotify("Raven — pairing", `Code ${req.code} — send /pair ${req.code} to the bot`)
      log("info", msg)
    }

    async function askOwnersToApprove(cfg: any, req: PairingReq): Promise<void> {
      const text = `🔐 Pairing request: "${req.name}" (chat ${req.chatId})\nTheir code: ${req.code}\nApprove this account?`
      const kb = {
        inline_keyboard: [
          [{ text: "✅ Approve", callback_data: `s:ap:ok:${req.chatId}` }, { text: "❌ Deny", callback_data: `s:ap:no:${req.chatId}` }],
        ],
      }
      for (const chatId of cfg.authorizedChatIds) {
        if (chatId === req.chatId) continue
        await tgSend(cfg, chatId, text, kb).catch(() => {})
      }
    }

    async function patchConfigAddChat(chatId: number): Promise<void> {
      const cur = await readJSON<any>(CFG_FILE, {})
      const ids = new Set<number>()
      for (const x of Array.isArray(cur?.authorizedChatIds) ? cur.authorizedChatIds : []) ids.add(Number(x))
      for (const x of Array.isArray(cur?.chatIds) ? cur.chatIds : []) ids.add(Number(x))
      ids.add(chatId)
      const next = { ...cur, authorizedChatIds: [...ids] }
      delete next.chatIds
      await atomicWrite(CFG_FILE, JSON.stringify(next, null, 2), 0o600)
      log("info", `paired chat ${chatId}`)
    }

    async function patchConfigRemoveChat(chatId: number): Promise<void> {
      const cur = await readJSON<any>(CFG_FILE, {})
      const ids = new Set<number>()
      for (const x of Array.isArray(cur?.authorizedChatIds) ? cur.authorizedChatIds : []) ids.add(Number(x))
      for (const x of Array.isArray(cur?.chatIds) ? cur.chatIds : []) ids.add(Number(x))
      ids.delete(chatId)
      const next = { ...cur, authorizedChatIds: [...ids] }
      delete next.chatIds
      await atomicWrite(CFG_FILE, JSON.stringify(next, null, 2), 0o600)
      log("info", `unpaired chat ${chatId}`)
    }

    async function completePairing(cfg: any, req: PairingReq): Promise<void> {
      await patchConfigAddChat(req.chatId)
      await mutateState((s) => {
        if (s.pairing && s.pairing.chatId === req.chatId) s.pairing = null
      })
      const fresh = await loadConfig()
      const hello = [`✅ Paired! ${fresh.botName} is connected to your coding agents.`, ``, "Type any message to talk, or use the buttons below."]
      if (fresh.botName) {
        try {
          await tgApi(fresh, "setMyName", { name: clip(fresh.botName, 64) })
        } catch {}
      }
      await tgSend(fresh, req.chatId, hello.join("\n"), menuKeyboard()).catch(() => {})
      await showPanel(req.chatId, { name: "home" }, true)
      for (const chatId of fresh.authorizedChatIds) {
        if (chatId === req.chatId) continue
        await tgSend(fresh, chatId, `✅ "${req.name}" (chat ${req.chatId}) is now paired. Revoke with /unpair ${req.chatId}.`).catch(() => {})
      }
    }

    async function pairRequest(cfg: any, chatId: number, name: string): Promise<void> {
      const prev = (await loadState()).pairing
      if (prev && prev.chatId === chatId && Date.now() - prev.createdAt < PAIR_TTL_MS && prev.attempts < PAIR_MAX_ATTEMPTS) {
        await tgSend(cfg, chatId, pairingHelp(prev.code))
        return
      }
      const req: PairingReq = { code: makePairCode(), chatId, name, createdAt: Date.now(), attempts: 0, ownerApproved: false }
      await mutateState((s) => void (s.pairing = req))
      await announcePairing(req)
      if (cfg.ownerApprove) await askOwnersToApprove(cfg, req)
      await tgSend(cfg, chatId, pairingHelp(req.code))
    }

    async function tryPairCode(cfg: any, chatId: number, text: string): Promise<boolean> {
      const t = text.trim()
      const explicit = /^\/pair(?:ing)?\s+(\S+)$/i.exec(t)
      const bare = /^[A-HJ-KM-NP-Z2-9]{6}$/i.test(t) ? t : ""
      const code = String(explicit?.[1] ?? bare).toUpperCase().replace(/O/g, "0").replace(/I|L/g, "1")
      if (!code) return false
      const st = await loadState()
      const req = st.pairing
      if (!req || Date.now() - req.createdAt > PAIR_TTL_MS) {
        await tgSend(cfg, chatId, `No active pairing code here. Send /start to request one.`)
        return true
      }
      if (req.chatId !== chatId || req.code !== code) {
        const attempts = (req.attempts ?? 0) + 1
        const over = attempts >= PAIR_MAX_ATTEMPTS
        await mutateState((s) => {
          if (!s.pairing) return
          if (over) s.pairing = null
          else s.pairing.attempts = attempts
        })
        await tgSend(cfg, chatId, over ? `Wrong code too many times — pairing revoked. /start for a fresh code.` : `Wrong code — ${PAIR_MAX_ATTEMPTS - attempts} tries left.`)
        return true
      }
      if (cfg.ownerApprove && !req.ownerApproved) {
        await mutateState((s) => {
          if (s.pairing && s.pairing.chatId === chatId) s.pairing.codeConfirmed = true
        })
        await tgSend(cfg, chatId, `✅ Code confirmed! Waiting for an owner on another paired device to approve.`)
        return true
      }
      await completePairing(cfg, req)
      return true
    }

    async function handlePairDecision(cfg: any, fromChat: number, targetChat: number, ok: boolean): Promise<void> {
      const st = await loadState()
      const req = st.pairing
      if (!req || req.chatId !== targetChat) {
        await tgSend(cfg, fromChat, `No pending pairing request for chat ${targetChat}.`)
        return
      }
      if (!ok) {
        await mutateState((s) => {
          if (s.pairing && s.pairing.chatId === targetChat) s.pairing = null
        })
        await tgSend(cfg, fromChat, `❌ Pairing for "${req.name}" (chat ${targetChat}) denied.`)
        await tgSend(cfg, targetChat, `❌ Your pairing request was denied.`).catch(() => {})
        return
      }
      if (req.codeConfirmed) {
        await completePairing(cfg, req)
        await tgSend(cfg, fromChat, `✅ "${req.name}" (chat ${targetChat}) paired.`).catch(() => {})
        return
      }
      await mutateState((s) => {
        if (s.pairing && s.pairing.chatId === targetChat) s.pairing.ownerApproved = true
      })
      await tgSend(cfg, fromChat, `✅ Approved. Ask them to send /pair ${req.code} now.`)
      await tgSend(cfg, targetChat, `✅ Approved by the owner! Send /pair ${req.code} to finish.`).catch(() => {})
    }

    async function handleUpdate(u: any) {
      const cfg = await loadConfig()
      if (!cfg.enabled || !cfg.botToken) return
      if (u.callback_query) {
        const cq = u.callback_query
        const chatId = Number(cq.from?.id)
        if (!cfg.authorizedChatIds.includes(chatId)) {
          log("warn", `rejected callback from unpaired chat ${chatId}`)
          return
        }
        await handleCallback(cfg, chatId, cq).catch((e: any) => {
          log("warn", `callback: ${e?.message ?? e}`)
          void answerCallback(cq.id).catch(() => {})
        })
        return
      }
      if (u.message) {
        const m = u.message
        const chatId = Number(m.chat?.id)
        const text = typeof m.text === "string" ? m.text : ""
        if (!cfg.authorizedChatIds.includes(chatId)) {
          const t = text.trim().toLowerCase()
          if (t === "/start" || t === "/help" || t === "/ping" || t === "/pair") {
            const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") || String(m.from?.username ?? "user")
            await pairRequest(cfg, chatId, name)
            return
          }
          if (await tryPairCode(cfg, chatId, text)) return
          log("info", `ignored message from unpaired chat ${chatId}`)
          return
        }
        if (text.length) {
          log("info", `command from ${chatId}: ${text.split(/\s+/)[0].slice(0, 30)}`)
          await handleCommand(cfg, chatId, text).catch((e: any) => {
            log("warn", `command: ${e?.message ?? e}`)
            void tgSend(cfg, chatId, `⚠️ ${clip(String(e?.message ?? e), 500)}`).catch(() => {})
          })
        }
      }
    }

    async function tryEditMessage(chatId: number, messageId: number, text: string, keyboard?: any): Promise<"ok" | "gone" | "error"> {
      const cfg = await loadConfig()
      const params: any = { chat_id: chatId, message_id: messageId, text: clip(text) }
      if (keyboard) params.reply_markup = keyboard
      else params.reply_markup = { inline_keyboard: [] }
      try {
        await tgApi(cfg, "editMessageText", params)
        return "ok"
      } catch (e: any) {
        const d = String(e?.message ?? "")
        if (d.includes("message is not modified")) return "ok"
        if (d.includes("message to edit not found") || d.includes("message can't be edited") || d.includes("MESSAGE_ID_INVALID")) return "gone"
        log("debug", `editMessage: ${d}`)
        return "error"
      }
    }

    async function getUI(chatId: number): Promise<{ screen: Screen; panelId?: number; menuSent?: boolean }> {
      const st = await loadState()
      return st.chats[chatId]?.ui ?? { screen: { name: "home" } }
    }

    async function setScreen(chatId: number, screen: Screen, panelId?: number): Promise<void> {
      await mutateState((s) => {
        const c = s.chats[chatId] ?? (s.chats[chatId] = {})
        c.ui = { screen, ...(panelId !== undefined ? { panelId } : c.ui?.panelId !== undefined ? { panelId: c.ui.panelId } : {}) }
      })
    }

    // fresh=true: explicit user commands (reply-keyboard buttons, slash commands).
    // Sends a brand-new visible message instead of silently editing the old
    // panel, so the user always sees a response. Inline-button callbacks and
    // background refreshes keep editing in place (fresh=false).
    async function showPanel(chatId: number, screen?: Screen, fresh = false): Promise<void> {
      const cfg = await loadConfig()
      const ui = await getUI(chatId)
      const target = screen ?? ui.screen
      const view = await renderScreen(chatId, target)
      if (!view) {
        return
      }
      if (!fresh && ui.panelId) {
        const res = await tryEditMessage(chatId, ui.panelId, view.text, view.keyboard)
        if (res === "ok") {
          if (screen) await setScreen(chatId, screen)
          return
        }
        if (res === "error") log("warn", `panel edit failed, sending a fresh message instead (see debug log for reason)`)
      }
      const uiNow = await getUI(chatId)
      if (!uiNow.menuSent) {
        await tgSend(cfg, chatId, `🎛 Use the buttons below to navigate.`, menuKeyboard()).catch(() => null)
        await mutateState((s) => {
          const c = s.chats[chatId] ?? (s.chats[chatId] = {})
          c.ui = { ...(c.ui ?? { screen: target }), menuSent: true }
        })
      }
      let mid: number | null = null
      try {
        mid = await tgSend(cfg, chatId, view.text, view.keyboard)
      } catch (e: any) {
        mid = null
      }
      await setScreen(chatId, target, mid ?? undefined)
    }

    async function setFocus(chatId: number, ref: { sid: string; key: InstanceKey; dir: Dir; title: string }): Promise<void> {
      await mutateState((s) => {
        s.chats[chatId] = { ...(s.chats[chatId] ?? {}), active: { ...ref } }
      })
    }

    async function getFocus(chatId: number): Promise<{ sid: string; key: InstanceKey; dir: Dir; title: string } | null> {
      const st = await loadState()
      return st.chats[chatId]?.active ?? null
    }

    async function maybeRefreshPanels(chatIds: number[]): Promise<void> {
      for (const chatId of chatIds) {
        try {
          const ui = await getUI(chatId)
          if (ui.screen.name === "home" || ui.screen.name === "inbox" || ui.screen.name === "session") {
            if (ui.panelId) await showPanel(chatId)
          }
        } catch {}
      }
    }

    async function collectPending(): Promise<{ perms: any[]; questions: any[] }> {
      const keys = await liveKeys()
      const results = await Promise.all(keys.map((k) => submitAction(k, "pending", {}, 7_000).catch(() => null)))
      let perms: any[] = []
      let questions: any[] = []
      for (const r of results) {
        if (!r) continue
        perms = perms.concat(r.permissions ?? [])
        questions = questions.concat(r.questions ?? [])
      }
      return { perms, questions }
    }

    async function getKnownDirs(): Promise<{ dir: Dir; key: InstanceKey }[]> {
      const out: { dir: Dir; key: InstanceKey }[] = []
      const seen = new Set<string>()
      const push = (upOnly: boolean) => {
        for (const [key, v] of instances.entries()) {
          if (upOnly ? !isInstanceUp(v) : Date.now() - v.lastSeen > 300_000) continue
          if (!v.dir || seen.has(v.dir)) continue
          seen.add(v.dir)
          out.push({ dir: v.dir, key })
        }
      }
      push(true)
      if (!out.length) push(false)
      return out
    }

    function formatStatus(busy: boolean): string {
      return busy ? "⏳ busy" : "✅ idle"
    }

    async function renderHome(chatId: number): Promise<{ text: string; keyboard: any }> {
      const cfg = await loadConfig()
      const focus = await getFocus(chatId)
      const focusKey = focus ? ((await loadState()).sessions[focus.sid]?.key ?? focus.key) : null
      // Fan these out together: pending + focus detail + git state are independent.
      const [pendingRes, detailRes, gitRes] = await Promise.all([
        collectPending(),
        focus && focusKey ? submitAction(focusKey, "session.detail", { sessionID: focus.sid }, 8_000).catch(() => null) : Promise.resolve(null),
        focus && focusKey ? submitAction(focusKey, "git.state", { dir: focus.dir }, 5_000).catch(() => null) : Promise.resolve(null),
      ])
      const { perms, questions } = pendingRes
      const detail = detailRes
      const pendingLine =
        perms.length || questions.length
          ? `📥 ${perms.length + questions.length} waiting on you — send /inbox to review`
          : `📥 Inbox clear`
      const link = (await loadState()).link
      const linkLine =
        link?.status === "offline"
          ? `📡 Telegram: ❌ unreachable${link.since ? ` since ${new Date(link.since).toLocaleTimeString()}` : ""}${link.lastError ? ` — ${link.lastError}` : ""}\nCheck proxy/VPN on the Mac; the bridge reconnects automatically.`
          : link?.status === "starting"
            ? `📡 Telegram: …connecting`
            : `📡 Telegram: ✅ connected${cfg.proxy ? ` via ${redactProxy(cfg.proxy)}` : ""}`
      if (!focus) {
        return {
          text: clip(
            [`🏠 ${cfg.botName}`, ...(cfg.botDescription ? [cfg.botDescription] : []), "", "No session focused yet.", pendingLine, linkLine, "", "Browse your sessions or start a new one."].join("\n"),
            3900,
          ),
          keyboard: { inline_keyboard: [[{ text: "📚 Browse sessions", callback_data: "s:sessions" }], [{ text: "➕ New session", callback_data: "s:new" }]] },
        }
      }
      const busy = detail?.status?.type === "busy"
      const lastUserHome = [...(detail?.messages ?? [])].reverse().find((m: any) => m?.info?.role === "user")
      const lastUserHomeText = lastUserHome
        ? (lastUserHome.parts ?? [])
            .filter((p: any) => p?.type === "text" && typeof p.text === "string" && p.text.trim())
            .map((p: any) => String(p.text).trim())
            .join("\n")
            .trim()
        : ""
      const kids: any[] = detail?.children ?? []
      const info = detail?.info
      const stH = await loadState()
      const regH = stH.sessions[focus.sid]
      const agentH = stH.chats[chatId]?.agent
      const modelH = agentH?.model ?? regH?.model ?? modelFromInfo(info?.model)
      const modeH = agentH ? "build" : modeOf(regH?.agent ?? info?.agent)
      const clientH = regH?.client ?? clientOf(focus.sid)
      const branchH = gitRes?.branch ? ` · 🌿 ${gitRes.branch}` : ""
      const text = clip(
        [
          `🏠 ${info?.title || focus.title}`,
          `${formatStatus(!!busy)} · ${baseDir(info?.directory ?? focus.dir)}${branchH} · updated ${timeAgo(info?.time?.updated ?? 0)}`,
          `🧠 ${modelLabelOf(modelH)} · ${modeH === "build" && agentH ? "🛠 build" : modeButtonLabel(modeH)}${clientH && clientH !== "oc" ? ` · ${clientIcon(clientH)} ${clientName(clientH)}` : ""}`,
          ...(agentH ? [`🤖 @${agentH.agent} workspace is OPEN — everything you type goes to it`] : []),
          ...(kids.length ? [`↳ ${kids.length} subagent${kids.length > 1 ? "s" : ""} active`] : []),
          ``,
          ...(lastUserHomeText ? ["Latest:", `👤 ${clip(lastUserHomeText.replace(/\s+/g, " "), 300)}`, ``] : []),
          pendingLine,
          linkLine,
          ``,
          agentH ? `Type to talk to @${agentH.agent} · /agent close to leave` : `Type to talk here · Sessions to switch`,
        ].join("\n"),
        3900,
      )
      return {
        text,
        keyboard: {
          inline_keyboard: [
            [{ text: "💬 Open workspace", callback_data: `s:session:${focus.sid}` }],
            ...(agentH
              ? [[{ text: `🤖 @${agentH.agent} workspace`, callback_data: `s:session:${agentH.sid}` }, { text: "⏹ Close agent", callback_data: "s:ag:close" }]]
              : []),
            ...(busy ? [[{ text: "⏹ Stop turn", callback_data: `s:abort:${focus.sid}` }]] : []),
          ],
        },
      }
    }

    async function renderSessionsPage(chatId: number, page: number): Promise<{ text: string; keyboard: any }> {
      const list = await collectSessions()
      lastLists.set(chatId, list)
      const perPage = 8
      const pages = Math.max(1, Math.ceil(list.length / perPage))
      const pg = Math.min(Math.max(0, page), pages - 1)
      const shown = list.slice(pg * perPage, pg * perPage + perPage)
      const st = await loadState()
      const focusSid = st.chats[chatId]?.active?.sid
      const lines: string[] = []
      const rows: any[][] = []
      const groups = new Map<string, typeof shown>()
      for (const s of shown) {
        const g = `${baseDir(s.dir) || s.dir}|${(s as any).client ?? "oc"}`
        if (!groups.has(g)) groups.set(g, [])
        groups.get(g)!.push(s)
      }
      for (const [g, items] of groups) {
        const [gdir, gclient] = g.split("|")
        lines.push(gclient && gclient !== "oc" ? `📂 ${gdir} · ${clientIcon(gclient as any)} ${clientName(gclient as any)}` : `📂 ${gdir}`, ``)
        for (const s of items) {
          const mark = s.sid === focusSid ? " ✳" : ""
          const kids = s.children ? ` · ↳${s.children}` : ""
          lines.push(`${s.busy ? "⏳" : "⚪"} ${clip(s.title, 50)}${mark} · ${timeAgo(s.updated)}${kids}`)
          rows.push([{ text: `${s.busy ? "⏳" : ""}${clip(s.title, 30)}${s.sid === focusSid ? " ✳" : ""}`.trim(), callback_data: `s:session:${s.sid}` }])
        }
        lines.push(``)
      }
      const nav: any[] = []
      if (pg > 0) nav.push({ text: "◀", callback_data: `s:page:${pg - 1}` })
      if (pg < pages - 1) nav.push({ text: "▶", callback_data: `s:page:${pg + 1}` })
      if (nav.length) rows.push(nav)
      rows.push([{ text: "🏠 Home", callback_data: "s:home" }])
      const head = list.length ? `📚 Sessions (${list.length}) — page ${pg + 1}/${pages}` : `📚 No sessions yet`
      return { text: clip([head, "", ...lines, "", "Tap a session to open and focus it."].join("\n"), 3900), keyboard: { inline_keyboard: rows } }
    }

    async function fetchSessionDetail(sid: string): Promise<{ key: InstanceKey; detail: any } | null> {
      const st = await loadState()
      const reg = st.sessions[sid]
      const key = reg?.key ?? (await liveKeys())[0]
      if (!key) return null
      try {
        const detail = await submitAction(key, "session.detail", { sessionID: sid }, 10_000)
        if (!detail?.info) return null
        return { key, detail }
      } catch {
        return null
      }
    }

    async function renderTasksView(sid: string): Promise<{ text: string; keyboard: any } | null> {
      const st = await loadState()
      const reg = st.sessions[sid]
      const key = reg?.key ?? (await liveKeys())[0]
      if (!key) return null
      let todos: any[] = []
      try {
        const r = await submitAction(key, "session.tasks", { sessionID: sid }, 10_000)
        if (Array.isArray(r)) todos = r
      } catch {
        return null
      }
      const title = reg?.title || shortId(sid)
      const rows: any[][] = [[{ text: "💬 Back to session", callback_data: `s:session:${sid}` }]]
      if (!todos.length) {
        return { text: `☑️ Tasks in ${title}\n\nNo todos in this session.`, keyboard: { inline_keyboard: rows } }
      }
      const icon = (s: string) => (s === "completed" ? "✅" : s === "in_progress" ? "⏳" : s === "cancelled" ? "➖" : "⬜")
      const lines = [`☑️ Tasks in ${title}`, ``]
      for (const t of todos.slice(0, 20)) {
        const prio = t.priority && t.priority !== "medium" ? ` [${t.priority}]` : ""
        lines.push(`${icon(String(t.status ?? ""))} ${clip(String(t.content ?? ""), 80)}${prio}`)
      }
      if (todos.length > 20) lines.push(`… +${todos.length - 20} more`)
      return { text: clip(lines.join("\n"), 3900), keyboard: { inline_keyboard: rows } }
    }

    async function renderMoreView(sid: string): Promise<{ text: string; keyboard: any } | null> {
      const got = await fetchSessionDetail(sid)
      if (!got) return null
      const parent = got.detail.info
      const kids: any[] = got.detail.children ?? []
      const title = parent?.title || shortId(sid)
      const rows: any[][] = [[{ text: "💬 Back to session", callback_data: `s:session:${sid}` }]]
      if (!kids.length) {
        return { text: `➕ More — ${title}\n\nNo subagents in this session.\nSubagents appear here read-only when the agent spawns them.`, keyboard: { inline_keyboard: rows } }
      }
      const lines = [`➕ Subagents of ${title} (readonly)`, ``]
      for (const c of kids.slice(0, 10)) {
        const status = c.status?.type === "busy" ? "⏳" : "⚪"
        const agent = c.agent ? ` (@${c.agent})` : ""
        let preview = ""
        try {
          const msgs = await submitAction(got.key, "session.messages", { sessionID: c.id, limit: 1 }, 8_000)
          const last = Array.isArray(msgs) && msgs.length ? msgs[0] : null
          if (last) preview = msgText(last).replace(/\s+/g, " ")
        } catch {}
        lines.push(`${status} ${clip(c.title || shortId(c.id), 50)}${agent}`)
        if (preview) lines.push(`   💬 ${clip(preview, 100)}`)
      }
      if (kids.length > 10) lines.push(`… +${kids.length - 10} more`)
      return { text: clip(lines.join("\n"), 3900), keyboard: { inline_keyboard: rows } }
    }

    type ModelItem = { providerID: string; providerName: string; modelID: string; name: string }

    async function collectModelItems(pickKey: InstanceKey, sessionID = ""): Promise<ModelItem[] | null> {
      let prov: any = null
      try {
        prov = await submitAction(pickKey, "provider.list", { sessionID }, 10_000)
      } catch {
        return null
      }
      // GET /provider -> { all: Provider[], default: {providerID: modelID}, connected: providerID[] }
      // Same catalog the opencode UI shows under /model: every real coding model,
      // grouped by its provider.
      const all: any[] = Array.isArray(prov?.all) ? prov.all : Array.isArray(prov) ? prov : []
      const connected: string[] = Array.isArray(prov?.connected) ? prov.connected.map((x: any) => String(x)) : []
      const items: ModelItem[] = []
      for (const p of all) {
        const pid = String(p?.id ?? p?.providerID ?? "")
        if (!pid) continue
        if (connected.length && !connected.includes(pid)) continue
        const models = p?.models
        const list: any[] = Array.isArray(models) ? models : Object.values(models ?? {})
        for (const m of list) {
          const modelID = String(m?.id ?? "")
          if (!modelID || m?.status === "deprecated") continue
          items.push({ providerID: pid, providerName: String(p?.name ?? pid), modelID, name: String(m?.name ?? modelID) })
        }
      }
      items.sort((a, b) => (a.providerName === b.providerName ? a.name.localeCompare(b.name) : a.providerName.localeCompare(b.providerName)))
      return items
    }

    function renderModelPage(items: ModelItem[], page: number, perPage: number, mkNav: (p: number) => string, mkPick: (i: number) => string, current?: ModelRef, header = `🧠 Pick the model for future prompts in this session`): { text: string; rows: any[][] } {
      const pages = Math.max(1, Math.ceil(items.length / perPage))
      const pg = Math.min(Math.max(0, page), pages - 1)
      const shown = items.slice(pg * perPage, pg * perPage + perPage)
      const lines = [`${header} (page ${pg + 1}/${pages}):`, ``]
      const rows: any[][] = []
      let lastProvider = ""
      shown.forEach((m, i) => {
        if (m.providerName !== lastProvider) {
          lastProvider = m.providerName
          lines.push(`📂 ${m.providerName}`)
        }
        const isCurrent = current?.providerID === m.providerID && current?.modelID === m.modelID
        lines.push(`  ${isCurrent ? "✅" : "•"} ${m.name}`)
        rows.push([{ text: clip(`${isCurrent ? "✅ " : ""}${m.name}`, 40), callback_data: mkPick(pg * perPage + i) }])
      })
      const nav: any[] = []
      if (pg > 0) nav.push({ text: "◀", callback_data: mkNav(pg - 1) })
      if (pg < pages - 1) nav.push({ text: "▶", callback_data: mkNav(pg + 1) })
      if (nav.length) rows.push(nav)
      return { text: clip(lines.join("\n"), 3900), rows }
    }

    async function renderModelPicker(chatId: number, sid: string, page = 0): Promise<{ text: string; keyboard: any } | null> {
      const st = await loadState()
      const reg = st.sessions[sid]
      const current = reg?.model
      const keys = await liveKeys()
      if (!keys.length) return null
      const pickKey = reg?.key && keys.includes(reg.key) ? reg.key : keys[0]
      const items = await collectModelItems(pickKey, sid)
      if (!items) return null
      if (!items.length) return { text: "No models available from connected providers.", keyboard: { inline_keyboard: [[{ text: "💬 Back to session", callback_data: `s:session:${sid}` }]] } }
      lastPickLists.set(chatId, { kind: "model", sid, items })
      const { text, rows } = renderModelPage(
        items,
        page,
        10,
        (p) => `s:model:${sid}:${p}`,
        (i) => `s:mpick:${i}`,
        current,
        `🧠 Pick the model for future prompts in this session — current: ${current ? `${current.providerID}/${current.modelID}` : "unknown"}`,
      )
      if (clientOf(sid) !== "oc") rows.push([{ text: "➕ Other: type a model id…", callback_data: `s:mc:${sid}` }])
      if (reg?.modelPinned) {
        rows.push([{ text: "↩️ Follow the app's model", callback_data: `s:mreset:${sid}` }])
      }
      rows.push([{ text: "💬 Back to session", callback_data: `s:session:${sid}` }])
      return {
        text: clip(reg?.modelPinned ? `${text}\n\n📌 ${modelLabelOf(current)} is pinned from Telegram — it applies to your next message here. Use ↩️ above to follow the app again.` : text, 3900),
        keyboard: { inline_keyboard: rows },
      }
    }

    async function renderAgentSettings(chatId: number): Promise<{ text: string; keyboard: any }> {
      const st = await loadState()
      const ws = st.chats[chatId]?.agent
      const cand = await agentCandidates(chatId)
      const model = ws?.model ?? (ws ? st.sessions[ws.sid]?.model : undefined)
      const modelLabel = modelLabelOf(model)
      const lines = [
        `🤖 Agent workspace`,
        ``,
        ws
          ? `Active: @${ws.agent} — every message you type goes to it.\nModel: ${modelLabel} · Mode: 🛠 build (always)`
          : `Not open. Pick an agent below: it gets its own session, you talk to the\nagent instead of a project, and it answers in its dedicated workspace.\nAlways runs in build mode; set its model under 🧠 below.`,
      ]
      const rows: any[][] = []
      const agents = cand?.agents ?? []
      if (!agents.length) lines.push(``, `(no agents found — is opencode running?)`)
      if (cand?.fallback) lines.push(``, `(agent list unreachable — showing default; opening it will retry the connection)`)
      agents.slice(0, 12).forEach((a: any, i: number) => {
        const name = String(a?.name ?? a?.id ?? `agent ${i + 1}`)
        rows.push([{ text: `${ws?.agent === name ? "✅ " : ""}${clip(name, 30)}`, callback_data: `s:agpick:${i}` }])
      })
      if (agents.length) lastPickLists.set(chatId, { kind: "agentcfg", sid: ws?.sid ?? "", items: agents.slice(0, 12) })
      if (rows.length) rows.push([{ text: "➖ tap an agent to open/switch ➖", callback_data: "noop" }])
      if (ws) {
        rows.push([
          { text: `🧠 Agent model: ${clip(modelLabel, 24)}`, callback_data: "s:am:0" },
          { text: "⏹ Close workspace", callback_data: "s:ag:close" },
        ])
      }
      rows.push([{ text: "⚙️ Back to Settings", callback_data: "s:settings" }])
      rows.push([{ text: "🏠 Home", callback_data: "s:home" }])
      return { text: clip(lines.join("\n"), 3900), keyboard: { inline_keyboard: rows } }
    }

    async function renderAgentModelPicker(chatId: number, page = 0): Promise<{ text: string; keyboard: any } | null> {
      const st = await loadState()
      const ws = st.chats[chatId]?.agent
      if (!ws) return { text: `No agent workspace is open — pick an agent first.`, keyboard: { inline_keyboard: [[{ text: "🤖 Agent workspace", callback_data: "s:ag:open" }], [{ text: "⚙️ Settings", callback_data: "s:settings" }]] } }
      const keys = await liveKeys()
      const pickKey = keys.includes(ws.key) ? ws.key : keys[0]
      if (!pickKey) return null
      const items = await collectModelItems(pickKey)
      if (!items) return null
      if (!items.length) return { text: "No models available from connected providers.", keyboard: { inline_keyboard: [[{ text: "🤖 Agent workspace", callback_data: "s:ag:open" }]] } }
      lastPickLists.set(chatId, { kind: "agentmodel", sid: ws.sid, items })
      const current = ws.model ?? st.sessions[ws.sid]?.model
      const { text, rows } = renderModelPage(items, page, 10, (p) => `s:am:${p}`, (i) => `s:ampick:${i}`, current, `🧠 Model for @${ws.agent} (always build mode)`)
      rows.push([{ text: "🤖 Back to agent workspace", callback_data: "s:ag:open" }])
      return { text, keyboard: { inline_keyboard: rows } }
    }

    async function renderCommandPicker(chatId: number, sid: string, page = 0): Promise<{ text: string; keyboard: any } | null> {
      const st = await loadState()
      const reg = st.sessions[sid]
      if (!reg) return null
      let cmds: any[] = []
      try {
        const r = await submitAction(reg.key, "instance.commands", {}, 8_000)
        if (Array.isArray(r)) cmds = r
      } catch {
        return null
      }
      if (!cmds.length) return { text: "No commands available.", keyboard: { inline_keyboard: [[{ text: "💬 Back to session", callback_data: `s:session:${sid}` }]] } }
      const perPage = 8
      const pages = Math.max(1, Math.ceil(cmds.length / perPage))
      const pg = Math.min(Math.max(0, page), pages - 1)
      const shown = cmds.slice(pg * perPage, pg * perPage + perPage)
      lastPickLists.set(chatId, { kind: "command", sid, items: shown })
      const rows = shown.map((c: any, i: number) => [{ text: clip(String(c.name ?? c.id ?? `command ${i + 1}`), 40), callback_data: `s:cmd:${i}` }])
      const nav: any[] = []
      if (pg > 0) nav.push({ text: "◀", callback_data: `s:cmds:${sid}:${pg - 1}` })
      if (pg < pages - 1) nav.push({ text: "▶", callback_data: `s:cmds:${sid}:${pg + 1}` })
      if (nav.length) rows.push(nav)
      rows.push([{ text: "💬 Back to session", callback_data: `s:session:${sid}` }])
      const lines = [`⌨️ Pick a command to run in this session (page ${pg + 1}/${pages}):`, ``]
      shown.forEach((c: any, i: number) => {
        const name = String(c.name ?? c.id ?? `command ${i + 1}`)
        const desc = c.description ? ` — ${clip(String(c.description).replace(/\s+/g, " "), 80)}` : ""
        lines.push(`${i + 1}. /${name}${desc}`)
      })
      return { text: clip(lines.join("\n"), 3900), keyboard: { inline_keyboard: rows } }
    }

    async function daemonKey(): Promise<InstanceKey | null> {
      for (const [k, v] of instances.entries()) if (v.client === "daemon" && isInstanceUp(v)) return k
      return null
    }

    async function renderNewProject(chatId: number): Promise<{ text: string; keyboard: any }> {
      const dirs = await getKnownDirs()
      const dk = await daemonKey()
      if (!dirs.length && !dk) return { text: `➕ No opencode project is open right now.\n\nOpen a project in OpenCode first, then come back.`, keyboard: { inline_keyboard: [[{ text: "🏠 Home", callback_data: "s:home" }]] } }
      lastPickLists.set(chatId, { kind: "newdir", sid: "", items: dirs })
      const rows = dirs.slice(0, 10).map((d, i) => [{ text: clip(baseDir(d.dir) || d.dir, 40), callback_data: `s:newdir:${i}` }])
      if (dk) rows.push([{ text: "🧩 New Claude Code session", callback_data: "s:newc:cl" }, { text: "⬢ New Codex thread", callback_data: "s:newc:cx" }])
      rows.push([{ text: "🏠 Home", callback_data: "s:home" }])
      return { text: dirs.length ? `➕ New session — pick a project:` : `➕ New session:`, keyboard: { inline_keyboard: rows } }
    }

    async function renderInbox(chatId: number): Promise<{ text: string; keyboard: any }> {
      const { perms, questions } = await collectPending()
      const rows: any[][] = []
      const lines: string[] = []
      if (!perms.length && !questions.length) {
        return { text: `📥 Inbox\n\nAll clear — nothing is waiting on you.`, keyboard: { inline_keyboard: [[{ text: "🏠 Home", callback_data: "s:home" }]] } }
      }
      lines.push(`📥 Inbox — ${perms.length} approval${perms.length === 1 ? "" : "s"}, ${questions.length} question${questions.length === 1 ? "" : "s"}`)
      const st = await loadState()
      let n = 0
      for (const p of perms.slice(0, 8)) {
        n++
        const title = st.sessions[p.sessionID]?.title || shortId(p.sessionID ?? "")
        const what = clip(String(p.permission ?? p.action ?? "permission"), 40)
        lines.push(`🔐 ${what} — ${clip(title, 30)}`)
        rows.push([{ text: `🔐 ${n}. ${clip(what, 24)}`, callback_data: `s:req:p:${p.id}` }])
      }
      for (const q of questions.slice(0, 8)) {
        n++
        const title = st.sessions[q.sessionID]?.title || shortId(q.sessionID ?? "")
        const what = clip(String(q.questions?.[0]?.question ?? q.questions?.[0]?.header ?? "question"), 40)
        lines.push(`❓ ${what} — ${clip(title, 30)}`)
        rows.push([{ text: `❓ ${n}. ${clip(what, 24)}`, callback_data: `s:req:q:${q.id}` }])
      }
      rows.push([{ text: "🏠 Home", callback_data: "s:home" }])
      return { text: clip(lines.join("\n"), 3900), keyboard: { inline_keyboard: rows } }
    }

    function permCardText(t: { title: string }, p: any): string {
      const perm = p.permission ?? p.action ?? "permission"
      const lines = (p.patterns ?? p.resources ?? []).slice(0, 6)
      return clip(
        [`🔐 Permission needed`, `Session: ${t.title}`, `Needs: ${perm}`, ...(lines.length ? ["", ...lines.map((l: any) => `  • ${clip(String(l), 200)}`)] : [])].join("\n"),
      )
    }

    function permCardKeyboard(id: string): any {
      return {
        inline_keyboard: [
          [
            { text: "✅ Allow once", callback_data: `p:${id}:once` },
            { text: "♾ Allow always", callback_data: `p:${id}:always` },
          ],
          [{ text: "❌ Reject", callback_data: `p:${id}:reject` }],
        ],
      }
    }

    function questionCardText(t: { title: string }, questions: any[]): string {
      const single = questions.length === 1 && !questions[0].multiple
      let text = `❓ ${t.title}\n\n`
      questions.forEach((q: any, qi: number) => {
        const opts = (q.options ?? []).map((o: any, oi: number) => `${single ? "" : `${oi + 1}. `}${o.label}${o.description ? ` — ${o.description}` : ""}`)
        text += `${questions.length > 1 ? `Q${qi + 1}. ` : ""}${q.question ?? q.header ?? "?"}\n${opts.join("\n")}\n\n`
        if (q.custom) text += "(custom text answers: answer in the app)\n"
      })
      return clip(text.trim())
    }

    async function renderInboxItem(kind: "p" | "q", id: string): Promise<{ text: string; keyboard: any } | null> {
      const prompts = await loadPrompts()
      const rec = prompts[id]
      if (!rec) return null
      if (kind === "p" && rec.kind === "permission") {
        const t = await displayTitle(rec.sessionID).catch(() => null)
        const title = t?.title ?? shortId(rec.sessionID)
        return { text: permCardText({ title }, rec.permission ?? {}), keyboard: permCardKeyboard(id) }
      }
      if (kind === "q" && rec.kind === "question") {
        const t = await displayTitle(rec.sessionID).catch(() => null)
        const title = t?.title ?? shortId(rec.sessionID)
        const questions = rec.questions ?? []
        const selections = rec.selections ?? questions.map(() => [])
        const single = questions.length === 1 && !questions[0].multiple
        return { text: questionCardText({ title }, questions), keyboard: buildQuestionKeyboard(id, questions, selections, single) }
      }
      return null
    }

    async function renderSettings(chatId: number): Promise<{ text: string; keyboard: any }> {
      const cfg = await loadConfig()
      const st = await loadState()
      const ws = st.chats[chatId]?.agent
      const modelLabel = modelLabelOf(ws?.model ?? (ws ? st.sessions[ws.sid]?.model : undefined))
      const tgl = (label: string, on: boolean, field: string) => ({ text: `${on ? "✅" : "⬜"} ${label}`, callback_data: `s:set:${field}` })
      const agentLine = ws
        ? `Agent workspace: 🤖 @${ws.agent} — OPEN\nmodel: ${modelLabel} · mode: 🛠 build (always)`
        : `Agent workspace: closed — /agent to open one\n(any agent you pick runs in its own session, always in build mode)`
      const text = clip([`⚙️ Settings`, ``, "Notifications:", ``, "Tap to toggle:", ``, agentLine].join("\n"), 3900)
      const rows = [
        [tgl("Finished", cfg.notify.idle, "idle"), tgl("Errors", cfg.notify.error, "error")],
        [tgl("Approvals", cfg.notify.permission, "permission"), tgl("Questions", cfg.notify.question, "question")],
        [tgl("Assistant replies", cfg.relay, "relay")],
        [
          { text: "🤖 Agent workspace", callback_data: "s:ag:open" },
          ...(ws ? [{ text: "⏹ Close", callback_data: "s:ag:close" }] : []),
        ],
        [{ text: "🏠 Home", callback_data: "s:home" }],
      ]
      return { text, keyboard: { inline_keyboard: rows } }
    }

    async function renderScreen(chatId: number, screen: Screen): Promise<{ text: string; keyboard: any } | null> {
      switch (screen.name) {
        case "home":
          return renderHome(chatId)
        case "sessions":
          return renderSessionsPage(chatId, screen.page)
        case "session": {
          const st = await loadState()
          const reg = st.sessions[screen.sid]
          if (!reg) return { text: `Session ${shortId(screen.sid)} is not reachable.`, keyboard: { inline_keyboard: [[{ text: "📚 Sessions", callback_data: "s:sessions" }]] } }
          await setFocus(chatId, { sid: screen.sid, key: reg.key, dir: reg.dir, title: reg.title })
          return renderSessionScreen(chatId, screen.sid)
        }
        case "tasks":
          return renderTasksView(screen.sid)
        case "more":
          return renderMoreView(screen.sid)
        case "conv":
          return renderConversationPage(chatId, screen.sid, screen.page)
        case "models":
          return renderModelPicker(chatId, screen.sid, screen.page ?? 0)
        case "commands":
          return renderCommandPicker(chatId, screen.sid, screen.page ?? 0)
        case "newProject":
          return renderNewProject(chatId)
        case "inbox":
          return renderInbox(chatId)
        case "agentSettings":
          return renderAgentSettings(chatId)
        case "agentModels":
          return renderAgentModelPicker(chatId, screen.page ?? 0)
        case "inboxItem": {
          const view = await renderInboxItem(screen.kind, screen.id)
          if (!view) return { text: `That request was already handled.`, keyboard: { inline_keyboard: [[{ text: "📥 Inbox", callback_data: "s:inbox" }]] } }
          return view
        }
        case "settings":
          return renderSettings(chatId)
      }
    }

    async function renderSessionScreen(chatId: number, sid: string): Promise<{ text: string; keyboard: any } | null> {
      const got = await fetchSessionDetail(sid)
      if (!got) return null
      const { detail, key } = got
      const info = detail.info
      const busy = detail.status?.type === "busy"
      const msgs: any[] = detail.messages ?? []
      const st = await loadState()
      const reg = st.sessions[sid]
      const awaiting = st.awaiting[sid]
      const ws = st.chats[chatId]?.agent
      const isAgentWs = !!ws && ws.sid === sid
      const client = reg?.client ?? clientOf(sid)
      const git = await submitAction(key, "git.state", { dir: reg?.dir }, 5_000).catch(() => null)
      const model = ws?.model ?? reg?.model ?? modelFromInfo(info.model)
      const modelLabel = modelLabelOf(model) + (reg?.modelPinned && !isAgentWs ? " 📌" : "")
      const mode = isAgentWs ? "build" : modeOf(reg?.agent ?? info.agent)
      const lastUser = [...msgs].reverse().find((m: any) => m?.info?.role === "user")
      const lastUserText = lastUser ? textPartsOf(lastUser) : ""
      const lastAssistant = [...msgs].reverse().find((m: any) => m?.info?.role === "assistant" && textPartsOf(m))
      const answerTail = tailClip(awaiting?.stream ?? (lastAssistant ? textPartsOf(lastAssistant) : ""), 900)
      const branchLine = git?.branch
        ? `🌿 ${git.branch}${(git.branches ?? []).filter((b: string) => b !== git.branch).slice(0, 3).map((b: string) => ` · ${b}`).join("")}${(git.branches ?? []).length > 4 ? ` · +${(git.branches ?? []).length - 4} more` : ""}`
        : ""
      const text = clip(
        [
          ...(isAgentWs ? [`🤖 @${ws!.agent} agent workspace`, `Everything you type goes to this agent — 🛠 build (always).`] : []),
          `💬 ${info.title || shortId(sid)}`,
          `${formatStatus(!!busy)} · ${client !== "oc" ? `${clientIcon(client)} ${clientName(client)} · ` : ""}${modelLabel} · ${isAgentWs || client === "cx" ? "🛠 build" : modeButtonLabel(mode)} · updated ${timeAgo(info.time?.updated ?? reg?.updated ?? 0)}`,
          ...(branchLine ? [branchLine] : []),
          ...(lastUserText ? [``, `👤 ${clip(lastUserText.replace(/\s+/g, " "), 500)}`] : []),
          ...(answerTail ? [``, `🤖 ${answerTail}`] : []),
          ``,
          isAgentWs ? `Type to talk to @${ws!.agent}.` : client === "cx" ? `Type here to continue this thread.` : `Type here to continue this session.`,
        ].join("\n"),
        3900,
      )
      const rows: any[][] = isAgentWs
        ? [
            [{ text: "🧠 Agent model", callback_data: "s:am:0" }, { text: "🤖 Change agent", callback_data: "s:ag:open" }],
            [{ text: "⏹ Close workspace", callback_data: "s:ag:close" }, { text: "☑️ Tasks", callback_data: `s:tasks:${sid}` }],
            [{ text: "⌨️ Command", callback_data: `s:cmds:${sid}` }, { text: "🏠 Home", callback_data: "s:home" }],
          ]
        : (() => {
            const r: any[][] = []
            if (client === "oc") {
              r.push(
                [
                  { text: "💬 Conversation", callback_data: `s:conv:${sid}:0` },
                  { text: "🧠 Model", callback_data: `s:model:${sid}` },
                ],
                [
                  { text: `${modeButtonLabel(mode)} · switch`, callback_data: `s:mode:${sid}` },
                  { text: "☑️ Tasks", callback_data: `s:tasks:${sid}` },
                ],
                [
                  { text: "⌨️ Command", callback_data: `s:cmds:${sid}` },
                  { text: "➕ More", callback_data: `s:more:${sid}` },
                ],
              )
            } else {
              if (client === "cx") {
                r.push([{ text: "🧠 Model", callback_data: `s:model:${sid}` }])
              } else {
                r.push([
                  { text: "💬 Conversation", callback_data: `s:conv:${sid}:0` },
                  { text: "🧠 Model", callback_data: `s:model:${sid}` },
                ])
                if (client === "cl") r.push([{ text: `${modeButtonLabel(mode)} · switch`, callback_data: `s:mode:${sid}` }])
              }
            }
            r.push([{ text: "🏠 Home", callback_data: "s:home" }])
            return r
          })()
      if (busy) rows.splice(isAgentWs ? 2 : rows.length - 1, 0, [{ text: "⏹ Stop turn", callback_data: `s:abort:${sid}` }])
      return { text, keyboard: { inline_keyboard: rows } }
    }

    function textPartsOf(m: any): string {
      return ((m?.parts ?? []) as any[])
        .filter((p: any) => p?.type === "text" && typeof p.text === "string" && p.text.trim())
        .map((p: any) => String(p.text).trim())
        .join("\n")
        .trim()
    }

    async function fetchUserPrompts(sid: string): Promise<{ messageID: string; prompt: string }[] | null> {
      const st = await loadState()
      const reg = st.sessions[sid]
      const key = reg?.key ?? (await liveKeys())[0]
      if (!key) return null
      let arr: any[] = []
      try {
        const r = await submitAction(key, "session.history", { sessionID: sid, limit: 30 }, 10_000)
        if (Array.isArray(r)) arr = r
      } catch {
        return null
      }
      return arr
        .filter((m: any) => m?.info?.role === "user" && m?.info?.id)
        .reverse()
        .map((m: any) => ({ messageID: String(m.info.id), prompt: textPartsOf(m) }))
        .filter((u) => u.prompt)
    }

    async function renderConversationPage(chatId: number, sid: string, page: number): Promise<{ text: string; keyboard: any } | null> {
      const st = await loadState()
      const reg = st.sessions[sid]
      const title = reg?.title || shortId(sid)
      const prompts = await fetchUserPrompts(sid)
      if (prompts === null) return null
      const perPage = 5
      const pages = Math.max(1, Math.ceil(prompts.length / perPage))
      const pg = Math.min(Math.max(0, page), pages - 1)
      const shown = prompts.slice(pg * perPage, pg * perPage + perPage)
      lastPickLists.set(chatId, { kind: "conv", sid, items: shown })
      const rows = shown.map((u, i) => [{ text: `${pg * perPage + i + 1}. ${clip(u.prompt.replace(/\s+/g, " "), 40)}`, callback_data: `s:convpick:${i}` }])
      const nav: any[] = []
      if (pg > 0) nav.push({ text: "◀ Newer", callback_data: `s:conv:${sid}:${pg - 1}` })
      if (pg < pages - 1) nav.push({ text: "Older ▶", callback_data: `s:conv:${sid}:${pg + 1}` })
      if (nav.length) rows.push(nav)
      rows.push([{ text: "💬 Back to session", callback_data: `s:session:${sid}` }])
      const lines = [`💬 Conversation — ${title} (page ${pg + 1}/${pages})`, ``]
      if (!shown.length) lines.push("(no prompts yet — type to start)")
      else shown.forEach((u, i) => lines.push(`${pg * perPage + i + 1}. ${clip(u.prompt.replace(/\s+/g, " "), 120)}`))
      return { text: clip(lines.join("\n"), 3900), keyboard: { inline_keyboard: rows } }
    }

    async function exchangeFor(sid: string, messageID: string): Promise<{ userText: string; assistantText: string; title: string } | null> {
      const st = await loadState()
      const reg = st.sessions[sid]
      const key = reg?.key ?? (await liveKeys())[0]
      if (!key) return null
      let arr: any[] = []
      try {
        const r = await submitAction(key, "session.history", { sessionID: sid, limit: 30 }, 10_000)
        if (Array.isArray(r)) arr = r
      } catch {
        return null
      }
      const idx = arr.findIndex((m: any) => m?.info?.id === messageID && m?.info?.role === "user")
      if (idx < 0) return null
      const userText = textPartsOf(arr[idx])
      const following: string[] = []
      for (let i = idx + 1; i < arr.length; i++) {
        const m = arr[i]
        if (m?.info?.role === "user") break
        if (m?.info?.role === "assistant") {
          const t = textPartsOf(m)
          if (t) following.push(t)
        }
      }
      return { userText, assistantText: following.join("\n\n").trim(), title: reg?.title || shortId(sid) }
    }

    function buildTranscript(title: string, modelLabel: string, agentLabel: string, userText: string, assistantText: string): string {
      return [
        `# ${title}`,
        ``,
        `Session transcript exported from Telegram.`,
        ...(modelLabel && modelLabel !== "default" ? [`Model: ${modelLabel}`] : []),
        ...(agentLabel ? [`Agent: ${agentLabel}`] : []),
        ``,
        `## 👤 User`,
        ``,
        userText || "(empty prompt)",
        ``,
        `## 🤖 Assistant`,
        ``,
        assistantText || "(no text reply)",
        ``,
      ].join("\n")
    }

    async function renderExchangeView(chatId: number, sid: string, messageID: string, page: number): Promise<{ text: string; keyboard: any } | null> {
      const ex = await exchangeFor(sid, messageID)
      if (!ex) return null
      lastPickLists.set(chatId, { kind: "conv", sid, page, items: [{ messageID }] } as any)
      const text = clip([`💬 ${ex.title}`, ``, `👤 You:`, clip(ex.userText.replace(/\s+/g, " "), 600), ``, `🤖:`, clip(ex.assistantText.replace(/\s+/g, " ") || "(no text reply)", 600)].join("\n"), 3900)
      const rows = clientOf(sid) === "oc"
        ? [
            [
              { text: "📄 Full transcript", callback_data: `s:convfile:0` },
              { text: "↩️ Revert to here", callback_data: `s:convrvert:0` },
            ],
            [{ text: "🔙 Conversation", callback_data: `s:conv:${sid}:${page}` }],
          ]
        : [
            [{ text: "📄 Full transcript", callback_data: `s:convfile:0` }],
            [{ text: "🔙 Conversation", callback_data: `s:conv:${sid}:${page}` }],
          ]
      return { text, keyboard: { inline_keyboard: rows } }
    }

    async function renderConvConfirm(chatId: number, sid: string, messageID: string, page: number): Promise<{ text: string; keyboard: any } | null> {
      const ex = await exchangeFor(sid, messageID)
      if (!ex) return null
      lastPickLists.set(chatId, { kind: "conv", sid, page, items: [{ messageID }] } as any)
      const text = clip([`⚠️ Revert "${ex.title}" to this prompt?`, ``, `👤 ${clip(ex.userText.replace(/\s+/g, " "), 200)}`, ``, `Agent work after this point will be undone.`].join("\n"), 3900)
      const rows = [[{ text: "✅ Yes, revert", callback_data: `s:convdo:0` }, { text: "Cancel", callback_data: `s:conv:${sid}:${page}` }]]
      return { text, keyboard: { inline_keyboard: rows } }
    }

    // ── Agent workspace ───────────────────────────────────────────────────
    // One dedicated session per chat. While it is open every typed message
    // goes to that agent (always in build mode), not to the focused project
    // session. The model comes from the workspace record; when unset the
    // opencode session default is used.

    async function agentCandidates(chatId: number): Promise<{ key: InstanceKey; agents: any[]; fallback?: boolean } | null> {
      const keys = await liveKeys()
      if (!keys.length) return null
      const pick = await getFocus(chatId)
      const st = await loadState()
      const focusKey = pick ? st.sessions[pick.sid]?.key ?? pick.key : null
      const key = focusKey && keys.includes(focusKey) ? focusKey : keys[0]
      let r: any = null
      let failed = false
      try {
        r = await submitAction(key, "instance.agents", {}, 8_000)
      } catch (e: any) {
        failed = true
        log("warn", `instance.agents unreachable (${key.slice(0, 8)}): ${e?.message ?? e}`)
      }
      const list = Array.isArray(r) ? r : []
      const agents = list.filter((a: any) => {
        const mode = String(a?.mode ?? "primary").toLowerCase()
        const name = String(a?.name ?? a?.id ?? "").toLowerCase()
        // Agent workspaces are always build-mode, so the read-only "plan"
        // agent is not offered here.
        return mode !== "subagent" && a?.hidden !== true && name !== "plan"
      })
      if (failed && !agents.length) {
        // opencode always ships a built-in build agent: offer it so /agent
        // stays usable; opening it surfaces the real transport error if the
        // instance is truly down.
        return { key, agents: [{ name: "build", mode: "primary" }], fallback: true }
      }
      return { key, agents }
    }

    async function openAgentWorkspace(chatId: number, nameRaw: string): Promise<{ ok: boolean; reason?: string }> {
      const cfg = await loadConfig()
      const cand = await agentCandidates(chatId)
      if (!cand) {
        await tgSend(cfg, chatId, `⚠️ No opencode instance is live right now — open a project first.`)
        return { ok: false }
      }
      const wanted = String(nameRaw ?? "").trim().toLowerCase().replace(/^@/, "")
      const hit = cand.agents.find((a: any) => String(a?.name ?? a?.id ?? "").toLowerCase() === wanted)
      if (!hit) {
        const names = cand.agents.map((a: any) => `/${String(a?.name ?? a?.id ?? "")}`).slice(0, 12)
        await tgSend(cfg, chatId, `🤖 Unknown agent "${nameRaw}". Available:\n${names.join(" · ") || "(none)"}`)
        return { ok: false }
      }
      const name = String(hit.name ?? hit.id)
      const st = await loadState()
      const existing = st.chats[chatId]?.agent
      let ws: AgentWorkspace | undefined
      if (existing?.agent === name && st.sessions[existing.sid]) {
        ws = existing
      } else {
        let sid = ""
        let title = `🤖 ${name}`
        let dir = cand.key === KEY ? MY_DIR : instances.get(cand.key)?.dir ?? MY_DIR
        try {
          const sess: any = await submitAction(cand.key, "session.create", { title })
          if (!sess?.id) throw new Error("no id")
          sid = String(sess.id)
          title = sess.title || title
          dir = sess.directory ?? dir
        } catch (e: any) {
          await tgSend(cfg, chatId, `⚠️ could not create the agent session: ${clip(String(e?.message ?? e), 200)}`)
          return { ok: false }
        }
        await mutateState((s) => {
          s.sessions[sid] = {
            key: cand.key,
            dir,
            title,
            updated: Date.now(),
            model: existing?.model ?? undefined,
            modelPinned: !!existing?.model,
            agent: name,
            agentPinned: true,
          }
        })
        ws = { sid, agent: name, key: cand.key, dir, model: existing?.model, openedAt: Date.now() }
      }
      await mutateState((s) => {
        const c = s.chats[chatId] ?? (s.chats[chatId] = {})
        const withPrev: AgentWorkspace = { ...ws!, prev: existing?.prev ?? c.active ?? undefined }
        c.agent = withPrev
        c.active = { sid: ws!.sid, key: ws!.key, dir: ws!.dir, title: s.sessions[ws!.sid]?.title ?? `🤖 ${ws!.agent}` }
      })
      await showPanel(chatId, { name: "session", sid: ws.sid })
      return { ok: true }
    }

    async function closeAgentWorkspace(chatId: number): Promise<void> {
      const cfg = await loadConfig()
      const st = await loadState()
      const ws = st.chats[chatId]?.agent
      await mutateState((s) => {
        const c = s.chats[chatId]
        if (c) delete c.agent
        if (ws?.prev && c?.active?.sid === ws.sid) c.active = ws.prev
      })
      if (!ws) {
        await tgSend(cfg, chatId, `No agent workspace is open.`)
        return
      }
      await tgSend(cfg, chatId, `⏹ Closed the @${ws.agent} workspace. The session stays in 📚 Sessions; typing goes to your focused session again.`)
      await showPanel(chatId, { name: "home" }, true)
    }

    async function setAgentModel(chatId: number, model: ModelRef | undefined): Promise<void> {
      const st = await loadState()
      const ws = st.chats[chatId]?.agent
      if (!ws) return
      await mutateState((s) => {
        const c = s.chats[chatId]
        if (c?.agent) c.agent.model = model
        const sess = s.sessions[ws.sid]
        if (sess) {
          sess.model = model
          sess.modelPinned = !!model
        }
      })
    }

    async function sendPrompt(chatId: number, text: string): Promise<void> {
      const cfg = await loadConfig()
      const st = await loadState()
      const ws = st.chats[chatId]?.agent
      const focus = ws ? null : st.chats[chatId]?.active ?? null
      const target = ws
        ? { sid: ws.sid, key: ws.key, dir: ws.dir, title: st.sessions[ws.sid]?.title ?? `🤖 ${ws.agent}` }
        : focus
      if (!target) {
        await showPanel(chatId, { name: "sessions", page: 0 })
        await tgSend(cfg, chatId, `Pick a session first — then type to talk to it.`)
        return
      }
      const reg = st.sessions[target.sid]
      const key = ws?.key ?? reg?.key ?? target.key
      const model = ws ? ws.model ?? reg?.model : reg?.model
      const agent = ws ? ws.agent : reg?.agent
      log(
        "info",
        `prompt: session=${target.sid.slice(-6)} model=${model ? `${model.providerID}/${model.modelID}` : "(server default)"} agent=${agent || "(server default)"} ws=${!!ws}`,
      )
      const cardMid = await tgSend(cfg, chatId, turnCardText(target.title, text, `⏳ sending…`), stopKeyboard(target.sid)).catch(() => null)
      await mutateState((s) => {
        const a = s.awaiting[target.sid] ?? { chats: [], key, at: Date.now() }
        if (!a.chats.includes(chatId)) a.chats.push(chatId)
        a.key = key
        a.at = Date.now()
        a.prompt = text
        a.stream = undefined
        a.streamShown = false
        a.lastStreamEdit = 0
        a.error = undefined
        a.cards = { ...(a.cards ?? {}), ...(cardMid ? { [String(chatId)]: cardMid } : {}) }
        s.awaiting[target.sid] = a
      })
      try {
        await submitAction(key, "session.prompt", { sessionID: target.sid, text, ...(model ? { model } : {}), ...(agent ? { agent } : {}) })
      } catch (e: any) {
        await mutateState((s) => {
          const a = s.awaiting[target.sid]
          if (a) {
            a.chats = a.chats.filter((c) => c !== chatId)
            if (a.cards) delete a.cards[String(chatId)]
            if (!a.chats.length) delete s.awaiting[target.sid]
          }
        })
        if (cardMid) await editMessage(chatId, cardMid, `⚠️ could not send: ${clip(String(e?.message ?? e), 300)}`).catch(() => {})
        else await tgSend(cfg, chatId, `⚠️ could not send: ${clip(String(e?.message ?? e), 300)}`).catch(() => {})
      }
    }

    async function runOpencodeCommand(cfg: any, chatId: number, sid: string, command: string, args: string): Promise<void> {
      try {
        const st2 = await loadState()
        const reg = st2.sessions[sid]
        if (!reg) throw new Error("session not found")
        const r: any = await submitAction(reg.key, "session.command", { sessionID: sid, command, arguments: args })
        const out = r?.parts ? msgText(r) : ""
        await tgSend(cfg, chatId, clip(`⌨️ /${command} in ${reg.title}\n\n${out || "(done)"}`, 3900))
      } catch (e: any) {
        await tgSend(cfg, chatId, `⚠️ command failed: ${clip(String(e?.message ?? e), 200)}`)
      }
      await showPanel(chatId, { name: "session", sid })
    }

    async function handlePendingInput(cfg: any, chatId: number, text: string): Promise<boolean> {
      const st = await loadState()
      const pending = st.chats[chatId]?.pending
      if (!pending) return false
      if (text.trim() === "/cancel") {
        await mutateState((s) => {
          if (s.chats[chatId]) delete s.chats[chatId].pending
        })
        await tgSend(cfg, chatId, `Cancelled.`)
        await showPanel(chatId, { name: "home" })
        return true
      }
      if (text.trim() === "/skip") {
        await mutateState((s) => {
          if (s.chats[chatId]) delete s.chats[chatId].pending
        })
        if (pending.kind === "newTitle") {
          await createSessionInDir(chatId, pending.dir, pending.key, "", pending.client)
          return true
        }
        if (pending.kind === "commandArg") {
          await runOpencodeCommand(cfg, chatId, pending.sid, pending.command, "")
          return true
        }
        await tgSend(cfg, chatId, `Skipped.`)
        await showPanel(chatId, { name: "home" })
        return true
      }
      if (pending.kind === "newTitle") {
        await mutateState((s) => {
          if (s.chats[chatId]) delete s.chats[chatId].pending
        })
        await createSessionInDir(chatId, pending.dir, pending.key, clip(text.trim(), 120), pending.client)
        return true
      }
      if (pending.kind === "commandArg") {
        await mutateState((s) => {
          if (s.chats[chatId]) delete s.chats[chatId].pending
        })
        await runOpencodeCommand(cfg, chatId, pending.sid, pending.command, text.trim())
        return true
      }
      if (pending.kind === "modelCustom") {
        const modelID = clip(text.trim().replace(/\s+/g, " "), 80)
        await mutateState((s) => {
          if (s.chats[chatId]) delete s.chats[chatId].pending
        })
        if (modelID) {
          const stP = await loadState()
          const isAgent = !!stP.chats[chatId]?.agent && stP.chats[chatId]!.agent!.sid === pending.sid
          await mutateState((s) => {
            const e = s.sessions[pending.sid]
            if (e) {
              e.model = { providerID: pending.providerID, modelID }
              e.modelPinned = true
            }
          })
          if (isAgent) await setAgentModel(chatId, { providerID: pending.providerID, modelID })
          await tgSend(cfg, chatId, `🧠 Model set: ${modelID}`)
        }
        await showPanel(chatId, { name: "session", sid: pending.sid })
        return true
      }
      return false
    }

    async function createSessionInDir(chatId: number, dir: Dir, key: InstanceKey, title: string, client?: "cl" | "cx"): Promise<void> {
      const cfg = await loadConfig()
      try {
        const sess: any = await submitAction(key, "session.create", { ...(title ? { title } : {}), ...(client ? { client } : {}), ...(dir ? { dir } : {}) })
        if (!sess?.id) throw new Error("session.create returned no id")
        const name = sess.title || title || shortId(sess.id)
        await mutateState((s) => {
          s.sessions[sess.id] = { key, dir: sess.directory ?? dir, title: name, updated: sess.time?.updated ?? Date.now(), parentID: sess.parentID }
          s.chats[chatId] = { ...(s.chats[chatId] ?? {}), active: { sid: sess.id, key, dir: sess.directory ?? dir, title: name } }
        })
        await showPanel(chatId, { name: "session", sid: sess.id })
      } catch (e: any) {
        await tgSend(cfg, chatId, `⚠️ could not create session: ${clip(String(e?.message ?? e), 200)}`)
        await showPanel(chatId, { name: "newProject" })
      }
    }

    async function syncBotCommands(cfg: any): Promise<void> {
      try {
        const staticCmds = [
          { command: "start", description: "Home" },
          { command: "sessions", description: "Browse sessions" },
          { command: "new", description: "New session" },
          { command: "agent", description: "Open an agent workspace" },
          { command: "inbox", description: "Approvals and questions" },
          { command: "settings", description: "Notifications and profile" },
          { command: "abort", description: "Stop the focused session" },
          { command: "skip", description: "Answer the pending question with none" },
        ]
        // Register the opencode commands of every live instance so typing
        // "/something" shows up in Telegram's autocomplete and is routed to
        // the focused session as a real opencode command.
        const names = new Map<string, string>()
        for (const k of await liveKeys()) {
          const cmds: any[] = await submitAction(k, "instance.commands", {}, 6_000).catch(() => [])
          for (const c of Array.isArray(cmds) ? cmds : []) {
            const n = String(c?.name ?? c?.id ?? "")
              .toLowerCase()
              .replace(/[^a-z0-9_]/g, "")
              .slice(0, 32)
            if (!n || names.has(n)) continue
            names.set(n, clip(String(c?.description ?? "opencode command"), 60))
          }
        }
        const merged = [...staticCmds]
        for (const [name, description] of names) {
          if (merged.length >= 100) break
          if (!merged.some((x) => x.command === name)) merged.push({ command: name, description })
        }
        await tgApi(cfg, "setMyCommands", { commands: merged })
      } catch (e: any) {
        log("debug", `setMyCommands: ${e?.message ?? e}`)
      }
    }

    async function syncBotProfile(cfg: any): Promise<void> {
      try {
        if (cfg.botName) await tgApi(cfg, "setMyName", { name: clip(cfg.botName, 64) })
      } catch (e: any) {
        log("debug", `setMyName: ${e?.message ?? e}`)
      }
      try {
        if (cfg.botDescription) await tgApi(cfg, "setMyDescription", { description: clip(cfg.botDescription, 512) })
      } catch (e: any) {
        log("debug", `setMyDescription: ${e?.message ?? e}`)
      }
      await syncBotCommands(cfg)
    }

    async function handleCallback(cfg: any, chatId: number, cq: any) {
      const data = String(cq.data ?? "")
      if (data === "noop") {
        await answerCallback(cq.id)
        return
      }
      if (data.startsWith("s:")) {
        const rest = data.slice(2)
        const seg = rest.split(":")
        const nav = seg[0]
        const arg1 = seg[1] ?? ""
        const arg2 = seg[2] ?? ""
        const go = async (screen: Screen) => {
          await answerCallback(cq.id)
          await showPanel(chatId, screen)
        }
        if (nav === "home") {
          await go({ name: "home" })
          return
        }
        if (nav === "sessions" || nav === "page") {
          const page = nav === "page" ? Number(arg1) || 0 : 0
          await go({ name: "sessions", page })
          return
        }
        if (nav === "session" && arg1) {
          await go({ name: "session", sid: arg1 })
          return
        }
        if (nav === "conv" && arg1) {
          await go({ name: "conv", sid: arg1, page: Number(arg2) || 0 })
          return
        }
        if (nav === "convpick") {
          const pick = lastPickLists.get(chatId)
          const i = Number(arg1)
          await answerCallback(cq.id)
          if (!pick || pick.kind !== "conv" || !pick.items[i]) {
            await showPanel(chatId, { name: "home" })
            return
          }
          const sid = (pick as any).sid as string
          const mid = cq.message?.message_id
          const view = await renderExchangeView(chatId, sid, pick.items[i].messageID, (pick as any).page ?? 0)
          if (!view) {
            await tgSend(cfg, chatId, `That prompt is no longer available.`)
            return
          }
          if (mid) await editMessage(chatId, mid, view.text, view.keyboard)
          else await tgSend(cfg, chatId, view.text, view.keyboard)
          return
        }
        if (nav === "convfile") {
          const pick = lastPickLists.get(chatId)
          const i = Number(arg1)
          await answerCallback(cq.id)
          if (!pick || pick.kind !== "conv" || !pick.items[i]) {
            await showPanel(chatId, { name: "home" })
            return
          }
          const sid = (pick as any).sid as string
          const messageID = pick.items[i].messageID
          const statusMid = await tgSend(cfg, chatId, `⏳ Building transcript… this takes a second.`).catch(() => null)
          const setStatus = async (t: string) => {
            if (statusMid) await editMessage(chatId, statusMid, t).catch(() => {})
            else await tgSend(cfg, chatId, t).catch(() => {})
          }
          const ex = await exchangeFor(sid, messageID)
          if (!ex) {
            await setStatus(`⚠️ Could not load that exchange.`)
            return
          }
          const st = await loadState()
          const reg = st.sessions[sid]
          const md = buildTranscript(ex.title, modelLabelOf(reg?.model), modeOf(reg?.agent), ex.userText, ex.assistantText)
          const fname = `session-${shortId(sid)}-${Date.now().toString(36)}.md`
          try {
            await tgSendDocument(cfg, chatId, fname, md, `📄 Transcript — "${clip(ex.userText.replace(/\s+/g, " "), 80)}"`)
            await setStatus(`📄 Transcript sent above as a file.`)
          } catch (e: any) {
            await setStatus(`⚠️ could not send file: ${clip(String(e?.message ?? e), 200)}`)
          }
          return
        }
        if (nav === "convrvert") {
          const pick = lastPickLists.get(chatId)
          const i = Number(arg1)
          await answerCallback(cq.id)
          if (!pick || pick.kind !== "conv" || !pick.items[i]) {
            await showPanel(chatId, { name: "home" })
            return
          }
          const sid = (pick as any).sid as string
          const page = (pick as any).page ?? 0
          const view = await renderConvConfirm(chatId, sid, pick.items[i].messageID, page)
          if (!view) {
            await tgSend(cfg, chatId, `Could not load that exchange.`)
            return
          }
          const mid = cq.message?.message_id
          if (mid) await editMessage(chatId, mid, view.text, view.keyboard)
          else await tgSend(cfg, chatId, view.text, view.keyboard)
          return
        }
        if (nav === "convdo") {
          const pick = lastPickLists.get(chatId)
          const i = Number(arg1)
          await answerCallback(cq.id)
          if (!pick || pick.kind !== "conv" || !pick.items[i]) {
            await showPanel(chatId, { name: "home" })
            return
          }
          const sid = (pick as any).sid as string
          const messageID = pick.items[i].messageID
          try {
            const st = await loadState()
            const reg = st.sessions[sid]
            if (!reg) throw new Error("session not found")
            await submitAction(reg.key, "session.revert", { sessionID: sid, messageID })
            await tgSend(cfg, chatId, `↩️ Reverted "${reg.title}" to the selected prompt.`)
          } catch (e: any) {
            await tgSend(cfg, chatId, `⚠️ revert failed: ${clip(String(e?.message ?? e), 200)}`)
          }
          await showPanel(chatId, { name: "session", sid })
          return
        }
        if ((nav === "tasks" || nav === "more") && arg1) {
          await go({ name: nav as "tasks" | "more", sid: arg1 })
          return
        }
        if (nav === "abort" && arg1) {
          const st = await loadState()
          const reg = st.sessions[arg1]
          if (!reg) {
            await answerCallback(cq.id, "unknown session", true)
            await showPanel(chatId, { name: "sessions", page: 0 })
            return
          }
          try {
            const freshKey = (await loadState()).sessions[arg1]?.key ?? reg.key
            await submitAction(freshKey, "session.abort", { sessionID: arg1 })
            await answerCallback(cq.id, "stopped")
          } catch (e: any) {
            await answerCallback(cq.id, `could not stop`, true)
          }
          await showPanel(chatId, { name: "session", sid: arg1 })
          return
        }
        if (nav === "model" && arg1) {
          await go({ name: "models", sid: arg1, page: Number(arg2) || 0 })
          return
        }
        if (nav === "mc" && arg1) {
          const st = await loadState()
          if (!st.sessions[arg1]) {
            await answerCallback(cq.id, "unknown session", true)
            return
          }
          const providerID = clientOf(arg1) === "cx" ? "openai" : "anthropic"
          await mutateState((sm) => {
            const ch = sm.chats[chatId] ?? (sm.chats[chatId] = {})
            ch.pending = { kind: "modelCustom", sid: arg1, providerID }
          })
          await answerCallback(cq.id)
          await tgSend(cfg, chatId, `⌨️ Type the exact model id for ${clientName(clientOf(arg1))} (or /cancel). If your setup uses a proxy, use the alias it accepts.`)
          return
        }
        if (nav === "newc" && (arg1 === "cl" || arg1 === "cx")) {
          const dk = await daemonKey()
          if (!dk) {
            await answerCallback(cq.id, "raven daemon is not running", true)
            return
          }
          const dirs = await getKnownDirs()
          await answerCallback(cq.id)
          await mutateState((sm) => {
            const ch = sm.chats[chatId] ?? (sm.chats[chatId] = {})
            ch.pending = { kind: "newTitle", dir: dirs[0]?.dir ?? "", key: dk, client: arg1 }
          })
          await tgSend(cfg, chatId, arg1 === "cl" ? `🧩 Name the new Claude Code session? (or /skip)` : `⬢ Name the new Codex thread? (or /skip)`)
          return
        }
        if (nav === "mpick") {
          const pick = lastPickLists.get(chatId)
          const i = Number(arg1)
          if (!pick || pick.kind !== "model" || !pick.items[i]) {
            await answerCallback(cq.id, "expired — open Model again", true)
            await showPanel(chatId, { name: "home" })
            return
          }
          const sid = (pick as any).sid as string
          const m = pick.items[i]
          let stored = false
          await mutateState((s) => {
            const e = s.sessions[sid]
            if (e) {
              e.model = { providerID: String(m.providerID), modelID: String(m.modelID) }
              e.modelPinned = true
              stored = true
            }
          })
          log("info", `model pick: ${sid.slice(-6)} -> ${m.providerID}/${m.modelID} (${stored ? "pinned" : "SESSION MISSING"})`)
          await answerCallback(cq.id, `model set: ${clip(String(m.name ?? m.modelID), 60)}`)
          await showPanel(chatId, { name: "session", sid })
          return
        }
        if (nav === "mode" && arg1) {
          const st = await loadState()
          const reg = st.sessions[arg1]
          if (st.chats[chatId]?.agent?.sid === arg1) {
            await answerCallback(cq.id, "agent workspaces are always build", true)
            return
          }
          if (clientOf(arg1) === "cx") {
            await answerCallback(cq.id, "Codex has no plan mode", true)
            return
          }
          if (!reg) {
            await answerCallback(cq.id, "unknown session", true)
            await showPanel(chatId, { name: "sessions", page: 0 })
            return
          }
          const detail = await submitAction(reg.key, "session.get", { sessionID: arg1 }, 6_000).catch(() => null)
          const cur = modeOf(reg.agent ?? detail?.agent)
          const next = cur === "plan" ? "build" : "plan"
          await mutateState((s) => {
            const e = s.sessions[arg1]
            if (e) {
              e.agent = next
              e.agentPinned = true
            }
          })
          log("info", `mode pick: ${arg1.slice(-6)} -> ${next} (pinned)`)
          await answerCallback(cq.id, `mode: ${next}`)
          await showPanel(chatId, { name: "session", sid: arg1 })
          return
        }
        if (nav === "mreset" && arg1) {
          const st = await loadState()
          const server = st.sessions[arg1]?.modelServer
          await mutateState((s) => {
            const e = s.sessions[arg1]
            if (e) {
              e.modelPinned = false
              e.agentPinned = false
              if (server) e.model = server
            }
          })
          await answerCallback(cq.id, server ? `following the app: ${server.modelID}` : "following the app now")
          await showPanel(chatId, { name: "session", sid: arg1 })
          return
        }
        if (nav === "cmds" && arg1) {
          await go({ name: "commands", sid: arg1, page: Number(arg2) || 0 })
          return
        }
        if (nav === "cmd") {
          const pick = lastPickLists.get(chatId)
          const i = Number(arg1)
          await answerCallback(cq.id)
          if (!pick || pick.kind !== "command" || !pick.items[i]) {
            await showPanel(chatId, { name: "home" })
            return
          }
          const sid = (pick as any).sid as string
          const c = pick.items[i]
          const command = String(c.name ?? c.id ?? "")
          await mutateState((s) => {
            const ch = s.chats[chatId] ?? (s.chats[chatId] = {})
            ch.pending = { kind: "commandArg", sid, command }
          })
          await tgSend(cfg, chatId, `⌨️ Arguments for /${command}? (type them, or /skip for none)`)
          return
        }
        if (nav === "ap" && (arg1 === "ok" || arg1 === "no") && arg2) {
          await answerCallback(cq.id, arg1 === "ok" ? "approved" : "denied")
          await handlePairDecision(cfg, chatId, Number(arg2), arg1 === "ok")
          return
        }
        if (nav === "new") {
          await go({ name: "newProject" })
          return
        }
        if (nav === "ag" && arg1 === "open") {
          await go({ name: "agentSettings" })
          return
        }
        if (nav === "ag" && (arg1 === "close" || arg1 === "off")) {
          await answerCallback(cq.id, "closed")
          await closeAgentWorkspace(chatId)
          return
        }
        if (nav === "agpick") {
          const pick = lastPickLists.get(chatId)
          const i = Number(arg1)
          await answerCallback(cq.id)
          if (!pick || pick.kind !== "agentcfg" || !pick.items[i]) {
            await showPanel(chatId, { name: "home" })
            return
          }
          const name = String(pick.items[i].name ?? pick.items[i].id ?? "")
          await openAgentWorkspace(chatId, name)
          return
        }
        if (nav === "am" && /^\d+$/.test(arg1)) {
          await go({ name: "agentModels", page: Number(arg1) })
          return
        }
        if (nav === "ampick") {
          const pick = lastPickLists.get(chatId)
          const i = Number(arg1)
          if (!pick || pick.kind !== "agentmodel" || !pick.items[i]) {
            await answerCallback(cq.id, "expired — reopen 🤖 Agent workspace", true)
            await showPanel(chatId, { name: "home" })
            return
          }
          const m = pick.items[i]
          await setAgentModel(chatId, { providerID: String(m.providerID), modelID: String(m.modelID) })
          await answerCallback(cq.id, `agent model set: ${clip(String(m.name ?? m.modelID), 60)}`)
          const stA = await loadState()
          const sidA = stA.chats[chatId]?.agent?.sid
          await showPanel(chatId, sidA ? { name: "session", sid: sidA } : { name: "agentSettings" })
          return
        }
        if (nav === "newdir") {
          const pick = lastPickLists.get(chatId)
          const i = Number(arg1)
          await answerCallback(cq.id)
          if (!pick || pick.kind !== "newdir" || !pick.items[i]) {
            await showPanel(chatId, { name: "home" })
            return
          }
          const d = pick.items[i]
          await mutateState((s) => {
            const c = s.chats[chatId] ?? (s.chats[chatId] = {})
            c.pending = { kind: "newTitle", dir: d.dir, key: d.key }
          })
          await tgSend(cfg, chatId, `➕ Name the new session in ${baseDir(d.dir)}? (type a title, or /skip)`)
          return
        }
        if (nav === "inbox") {
          await go({ name: "inbox" })
          return
        }
        if (nav === "req" && (arg1 === "p" || arg1 === "q") && arg2) {
          await go({ name: "inboxItem", kind: arg1, id: arg2 })
          return
        }
        if (nav === "settings") {
          await go({ name: "settings" })
          return
        }
        if (nav === "set") {
          const field = arg1
          if (["idle", "error", "permission", "question"].includes(field)) {
            const cur = await loadConfig()
            await patchConfig({ notify: { ...cur.notify, [field]: !(cur.notify as any)[field] } })
            await answerCallback(cq.id, "updated")
            await showPanel(chatId, { name: "settings" })
            return
          }
          if (field === "relay") {
            const cur = await loadConfig()
            await patchConfig({ relay: !cur.relay })
            await answerCallback(cq.id, "updated")
            await showPanel(chatId, { name: "settings" })
            return
          }
          await answerCallback(cq.id)
          await showPanel(chatId, { name: "settings" })
          return
        }
        await answerCallback(cq.id, "unknown action", true)
        return
      }
      if (data.startsWith("p:")) {
        const [, id, reply] = data.split(":")
        const rec = (await loadPrompts())[id]
        if (!rec || rec.kind !== "permission") {
          await answerCallback(cq.id, "expired — check the app", true)
          return
        }
        if (rec.handled) {
          await answerCallback(cq.id, "already answered")
          return
        }
        try {
          await submitAction(rec.key, "permission.reply", { requestID: id, reply })
          await mutatePrompts((pr) => {
            const r = pr[id]
            if (!r) return
            r.handled = true
            const label = reply === "once" ? "allowed once" : reply === "always" ? "always allowed" : "rejected"
            for (const m of r.msgs) void editMessage(m.chatId, m.messageId, `✅ ${label}`).catch(() => {})
          })
          await answerCallback(cq.id, reply === "reject" ? "rejected" : "approved")
          log("info", `permission reply ${id}: ${reply}`)
          await maybeRefreshPanels(rec.msgs.map((m) => m.chatId))
        } catch (e: any) {
          await answerCallback(cq.id, `failed: ${clip(String(e?.message ?? e), 100)}`, true)
        }
        return
      }
      if (data.startsWith("q")) {
        const parts = data.split(":")
        const op = parts[0]
        const id = parts[1]
        const prompts = await loadPrompts()
        const rec = prompts[id]
        if (!rec || rec.kind !== "question") {
          await answerCallback(cq.id, "expired — check the app", true)
          return
        }
        if (rec.handled) {
          await answerCallback(cq.id, "already answered")
          return
        }
        const questions = rec.questions ?? []

        if (op === "qa") {
          const qi = Number(parts[2])
          const oi = Number(parts[3])
          const label = questions[qi]?.options?.[oi]?.label
          if (label === undefined) return
          await answerCallback(cq.id, label)
          await answerQuestion(cfg, id, rec, questions.map((_q: any, i: number) => (i === qi ? [label] : [])))
          return
        }
        if (op === "qt") {
          const qi = Number(parts[2])
          const oi = Number(parts[3])
          const sel = rec.selections ?? questions.map(() => [])
          const arr = sel[qi] ?? []
          sel[qi] = arr.includes(oi) ? arr.filter((x) => x !== oi) : [...arr, oi]
          await mutatePrompts((pr) => {
            if (pr[id]) pr[id].selections = sel
          })
          const keyboard = buildQuestionKeyboard(id, questions, sel, false)
          const text = renderSelectionText(rec.baseText ?? "", questions, sel)
          for (const m of rec.msgs) await editMessage(m.chatId, m.messageId, text, keyboard)
          await answerCallback(cq.id, sel[qi]?.length ? "selected" : "cleared")
          return
        }
        if (op === "qs") {
          const sel = rec.selections ?? questions.map(() => [])
          const missing = questions.some((q: any, i: number) => !(sel[i] ?? []).length)
          if (missing) {
            await answerCallback(cq.id, "select an option for every question", true)
            return
          }
          await answerCallback(cq.id, "sent")
          const answers = questions.map((q: any, i: number) => (sel[i] ?? []).map((oi) => q.options?.[oi]?.label ?? ""))
          await answerQuestion(cfg, id, rec, answers)
          return
        }
        if (op === "qr") {
          await answerCallback(cq.id, "dismissed")
          await mutatePrompts((pr) => {
            const r = pr[id]
            if (r) r.handled = true
          })
          try {
            await submitAction(rec.key, "question.reject", { requestID: id })
          } catch (e: any) {
            log("warn", `question reject: ${e?.message ?? e}`)
          }
          for (const m of rec.msgs) await editMessage(m.chatId, m.messageId, `☑️ dismissed`)
          return
        }
      }
      await answerCallback(cq.id, "unknown action", true)
    }

    function renderSelectionText(base: string, questions: any[], sel: number[][]) {
      let out = base
      questions.forEach((q: any, i: number) => {
        const chosen = (sel[i] ?? []).map((oi) => q.options?.[oi]?.label).filter(Boolean)
        if (chosen.length) out += `\n✅ Q${i + 1}: ${chosen.join(", ")}`
      })
      return clip(out)
    }

    async function answerQuestion(cfg: any, id: string, rec: PromptRec, answers: string[][]) {
      try {
        await submitAction(rec.key, "question.reply", { requestID: id, answers })
        const flat = answers.flat().join(", ")
        await mutatePrompts((pr) => {
          const r = pr[id]
          if (!r) return
          r.handled = true
          for (const m of r.msgs) void editMessage(m.chatId, m.messageId, `✅ answered: ${clip(flat, 300)}`).catch(() => {})
        })
        log("info", `question reply ${id}`)
        await maybeRefreshPanels(rec.msgs.map((m) => m.chatId))
      } catch (e: any) {
        for (const m of rec.msgs) void editMessage(m.chatId, m.messageId, `⚠️ failed: ${clip(String(e?.message ?? e), 300)}`)
        log("warn", `question reply ${id}: ${e?.message ?? e}`)
      }
    }

    async function liveKeys(): Promise<InstanceKey[]> {
      const up = [...instances.entries()].filter(([, v]) => isInstanceUp(v)).map(([k]) => k)
      if (up.length) return up
      // Never black out completely: if every known instance looks down,
      // try them all anyway (e.g. right after our own restart).
      return [...instances.entries()].filter(([, v]) => Date.now() - v.lastSeen < 300_000).map(([k]) => k)
    }

    async function collectSessions(): Promise<
      { sid: string; key: InstanceKey; dir: Dir; title: string; updated: number; busy: boolean; preview?: string; children: number; parentID?: string }[]
    > {
      const keys = await liveKeys()
      const results = await Promise.all(keys.map((k) => submitAction(k, "session.list", {}, 7_000).catch(() => null)))
      const map = new Map<string, any>()
      results.forEach((res, i) => {
        if (!res) return
        const key = keys[i]
        for (const s of res.sessions ?? []) {
          if (!s?.id) continue
          const prev = map.get(s.id)
          const busy = res.statuses?.[s.id]?.type === "busy"
          const updated = s.time?.updated ?? 0
          if (!prev || updated > prev.updated) {
            map.set(s.id, {
              sid: s.id,
              key,
              dir: s.directory ?? instances.get(key)?.dir ?? MY_DIR,
              title: s.title || shortId(s.id),
              updated,
              busy,
              parentID: s.parentID,
              preview: res.previews?.[s.id],
              model: modelFromInfo(s.model),
              agent: s.agent ? modeOf(String(s.agent)) : undefined,
              client: s.client ?? clientOf(s.id),
              children: 0,
            })
          } else if (busy) prev.busy = true
        }
      })
      const childrenCount = new Map<string, number>()
      for (const s of map.values()) {
        if (s.parentID) childrenCount.set(s.parentID, (childrenCount.get(s.parentID) ?? 0) + 1)
      }
      const all = [...map.values()]
      for (const s of all) s.children = childrenCount.get(s.sid) ?? 0
      const list = all
        .filter((s) => !s.parentID)
        .sort((a, b) => b.updated - a.updated)
      await mutateState((s) => {
        for (const it of all) {
          const prev = s.sessions[it.sid]
          s.sessions[it.sid] = {
            key: it.key,
            dir: it.dir,
            title: it.title,
            updated: it.updated,
            parentID: it.parentID ?? prev?.parentID,
            preview: it.preview ?? prev?.preview,
            ...mergeServerModel(prev, it.model),
            ...mergeServerAgent(prev, it.agent),
            client: prev?.client ?? it.client,
          }
        }
      })
      return list
    }

    async function handleCommand(cfg: any, chatId: number, text: string) {
      const trimmed = text.trim()
      const mapped = BUTTON_MAP[trimmed]
      const isCmd = trimmed.startsWith("/") || !!mapped
      const st0 = await loadState()

      // While the bot is waiting for an answer (new title / command args /
      // custom model) everything typed belongs to that prompt — /skip and
      // /cancel included. Known bot
      // commands and menu buttons still navigate (and abandon the question).
      if (st0.chats[chatId]?.pending) {
        const cmdName = trimmed.startsWith("/") ? trimmed.split(/\s+/)[0].slice(1).toLowerCase() : ""
        const isSkipish = cmdName === "skip" || cmdName === "cancel"
        const escapes = !!mapped || (!!cmdName && BOT_COMMANDS.has(cmdName) && !isSkipish)
        if (escapes) {
          await mutateState((s) => {
            if (s.chats[chatId]) delete s.chats[chatId].pending
          })
        } else if (await handlePendingInput(cfg, chatId, trimmed)) return
      }
      if (!isCmd) {
        await sendPrompt(chatId, trimmed)
        return
      }

      const cmdSource = mapped ?? trimmed
      const [cmdRaw, ...rest] = cmdSource.split(/\s+/)
      const cmd = cmdRaw.startsWith("/") ? cmdRaw.slice(1).toLowerCase() : cmdRaw.toLowerCase()
      const arg = rest.join(" ").trim()

      switch (cmd) {
        case "start":
        case "help": {
          await showPanel(chatId, { name: "home" }, true)
          // Always re-send the reply keyboard on /start|/help: panel edits are
          // silent, and the keyboard is lost if the user deleted the chat.
          // This guarantees something visible always shows up.
          await tgSend(cfg, chatId, `🎛 Options below — tap a button to navigate.`, menuKeyboard()).catch(() => null)
          return
        }
        case "sessions":
          await showPanel(chatId, { name: "sessions", page: 0 }, true)
          return
        case "new": {
          if (arg) {
            const focus = await getFocus(chatId)
            const dirs = await getKnownDirs()
            const target = focus ? { dir: focus.dir, key: focus.key } : dirs[0]
            if (!target) {
              await tgSend(cfg, chatId, `No opencode project is open right now.`)
              return
            }
            await createSessionInDir(chatId, target.dir, target.key, arg)
            return
          }
          await showPanel(chatId, { name: "newProject" }, true)
          return
        }
        case "inbox":
          await showPanel(chatId, { name: "inbox" }, true)
          return
        case "settings":
          await showPanel(chatId, { name: "settings" }, true)
          return
        case "status":
          await showPanel(chatId, { name: "inbox" }, true)
          return
        case "agent": {
          const a = arg.trim().toLowerCase()
          if (!a) {
            await showPanel(chatId, { name: "agentSettings" }, true)
            return
          }
          if (a === "close" || a === "off" || a === "stop" || a === "leave") {
            await closeAgentWorkspace(chatId)
            return
          }
          await openAgentWorkspace(chatId, arg.trim())
          return
        }
        case "pair": {
          if (arg) {
            await tryPairCode(cfg, chatId, text)
            return
          }
          const stP = await loadState()
          const req = stP.pairing
          await tgSend(
            cfg,
            chatId,
            req
              ? `⏳ Pairing pending: "${req.name}" (chat ${req.chatId}) — code shown on the computer${cfg.ownerApprove ? ", owner approval required" : ""}.`
              : `This chat is already paired. To add another Telegram account: /start there, read the 6-character code printed on this computer, then send /pair CODE there.`,
          )
          return
        }
        case "unpair": {
          const target = arg ? Number(arg) : chatId
          if (!Number.isFinite(target) || target <= 0) {
            await tgSend(cfg, chatId, `Usage: /unpair [chatId] (defaults to this chat).`)
            return
          }
          if (target !== chatId && !(await loadConfig()).authorizedChatIds.includes(chatId)) {
            await tgSend(cfg, chatId, `Only paired chats can revoke others.`)
            return
          }
          await patchConfigRemoveChat(target)
          await tgSend(cfg, chatId, `⏹ Chat ${target} unpaired. /start again there to pair anew.`)
          return
        }
        case "approve":
        case "deny": {
          const target = Number(arg)
          if (!Number.isFinite(target)) {
            await tgSend(cfg, chatId, `Usage: /${cmd} <chatId> — pending pairing requests are listed with buttons too.`)
            return
          }
          await handlePairDecision(cfg, chatId, target, cmd === "approve")
          return
        }
        case "use":
        case "open": {
          const focus = await getFocus(chatId)
          if (!focus) {
            await showPanel(chatId, { name: "sessions", page: 0 }, true)
            return
          }
          await showPanel(chatId, { name: "session", sid: focus.sid }, true)
          return
        }
        case "abort": {
          const focus = await getFocus(chatId)
          if (!focus) {
            await showPanel(chatId, { name: "home" }, true)
            return
          }
          try {
            const freshKey = (await loadState()).sessions[focus.sid]?.key ?? focus.key
            await submitAction(freshKey, "session.abort", { sessionID: focus.sid })
          } catch (e: any) {
            log("warn", `abort: ${e?.message ?? e}`)
          }
          await showPanel(chatId, { name: "session", sid: focus.sid }, true)
          return
        }
        case "reload": {
          const fresh = await loadConfig()
          await tgSend(cfg, chatId, `config reloaded (enabled: ${fresh.enabled}, chats: ${fresh.authorizedChatIds.length})`)
          await showPanel(chatId, { name: "settings" }, true)
          return
        }
        default: {
          // "/whatever" that isn't a bot command: run it as an opencode
          // command — in the agent workspace when one is open, otherwise on
          // the focused session (arguments included).
          const focus = await getFocus(chatId)
          const st = await loadState()
          const targetSid = st.chats[chatId]?.agent?.sid ?? focus?.sid ?? ""
          const reg = targetSid ? st.sessions[targetSid] : null
          if (reg) {
            const cmds: any[] = await submitAction(reg.key, "instance.commands", {}, 6_000).catch(() => [])
            const hit = (Array.isArray(cmds) ? cmds : []).find((c: any) => String(c?.name ?? c?.id ?? "").toLowerCase() === cmd)
            if (hit) {
              await runOpencodeCommand(cfg, chatId, targetSid, String(hit.name ?? hit.id ?? cmd), arg)
              return
            }
          }
          await tgSend(cfg, chatId, `I didn't get that — here's Home.`)
          await showPanel(chatId, { name: "home" }, true)
          return
        }
      }
    }

    async function inboxTick() {
      if (disposed || inboxing) return
      inboxing = true
      try {
        await inboxTickInner()
      } finally {
        inboxing = false
      }
    }

    async function inboxTickInner() {
      if (disposed) return
      let names: string[] = []
      try {
        names = (await fsp.readdir(INBOX)).filter((n: string) => n.endsWith(".json")).sort()
      } catch {
        return
      }
      for (const name of names) {
        if (disposed) return
        const file = path.join(INBOX, name)
        const item = await readJSON<InboxItem | null>(file, null)
        if (!item || item.key !== KEY) continue
        const claim = `${file}.claim`
        try {
          await fsp.rename(file, claim)
        } catch {
          continue
        }
        try {
          const data = await executeAction(item.action, item.payload)
          await enqueue({ t: "ack", id: item.id, ok: true, data, ts: Date.now(), key: KEY })
          log("debug", `action ${item.action} ok`)
        } catch (e: any) {
          await enqueue({ t: "ack", id: item.id, ok: false, error: clip(String(e?.message ?? e), 400), ts: Date.now(), key: KEY })
          log("warn", `action ${item.action} failed: ${e?.message ?? e}`)
        } finally {
          await fsp.rm(claim, { force: true }).catch(() => {})
        }
      }
    }

    function macNotify(title: string, msg: string) {
      try {
        if (process.platform !== "darwin") return
        execFile("/usr/bin/osascript", ["-e", `display notification ${JSON.stringify(msg)} with title ${JSON.stringify(title)}`], () => {})
      } catch {}
    }

    function shortNetError(e: any): string {
      const msg = String(e?.message ?? e)
      if (/ECONNREFUSED|Unable to connect/.test(msg)) return "connection refused"
      if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(msg)) return "DNS lookup failed"
      if (/ETIMEDOUT|timed out|Timeout/i.test(msg)) return "connection timed out"
      if (/ECONNRESET|EPIPE|socket hang up|closed before/i.test(msg)) return "connection dropped"
      if (/certificate|CERT|TLS|SSL/i.test(msg)) return "TLS/certificate error"
      return clip(msg, 140)
    }

    async function setLinkOnline(detail: string) {
      await mutateState((s) => {
        s.link = { status: "online", since: Date.now(), lastError: "", fails: 0 }
      })
      log("info", `Telegram reconnected (${detail})`)
      macNotify("Raven", "Telegram reconnected ✅")
    }

    async function setLinkOffline(errText: string) {
      await mutateState((s) => {
        s.link = { status: "offline", since: Date.now(), lastError: errText, fails: (s.link?.fails ?? 0) + 1 }
      })
      log("error", `Telegram unreachable: ${errText} — check network/VPN/proxy ("proxy" in ${CFG_FILE}); retrying automatically`)
      macNotify("Raven", `Telegram unreachable: ${errText}`)
    }

    async function tgLoop() {
      if (tgRunning || disposed) return
      tgRunning = true
      let fails = 0
      let linkDown = false
      let probed = false
      let lastProxyNote: string | null = null
      const OFFLINE_AFTER = 3
      try {
        offset = Number((await fsp.readFile(OFFSET_FILE, "utf8").catch(() => "0"))) || 0
        try {
          const persisted = await loadState()
          linkDown = persisted.link?.status === "offline"
        } catch {}
        while (!disposed && (await isLeader())) {
          const cfg = await loadConfig()
          if (!cfg.enabled || !cfg.botToken) {
            await new Promise((r) => setTimeout(r, 5_000))
            continue
          }
          const proxyNote = cfg.proxy ? `proxy ${redactProxy(cfg.proxy)} [${cfg.proxySource}]` : "direct (no proxy configured)"
          if (proxyNote !== lastProxyNote) {
            lastProxyNote = proxyNote
            log("info", `Telegram transport: ${proxyNote}`)
          }
          if (!probed) {
            probed = true
            try {
              const me = await tgApi(cfg, "getMe", {}, 15_000)
              fails = 0
              void syncBotCommands(cfg)
              if (linkDown) {
                linkDown = false
                await setLinkOnline(`bot @${me?.username ?? "?"}`)
              } else {
                await mutateState((s) => {
                  s.link = { status: "online", since: s.link?.status === "online" ? (s.link?.since ?? Date.now()) : Date.now(), lastError: "", fails: 0 }
                })
                log("info", `Telegram link ok (bot @${me?.username ?? "?"})`)
              }
            } catch (e: any) {
              if (e?.telegram && (e.code === 401 || e.code === 404)) {
                log("error", `Telegram rejected the bot token (getMe: ${e.code}) — check botToken in ${CFG_FILE}, then restart OpenCode`)
              } else {
                const short = e?.telegram ? `Telegram error ${e.code ?? "?"}: ${clip(String(e.message).replace(/^getMe:\s*/, ""), 120)}` : shortNetError(e)
                fails = OFFLINE_AFTER
                if (!linkDown) {
                  linkDown = true
                  await setLinkOffline(short)
                }
              }
            }
          }
          let batch: any[] = []
          try {
            const res = await tgApi(
              cfg,
              "getUpdates",
              { offset, timeout: 50, limit: 100, allowed_updates: ["message", "callback_query"] },
              70_000,
            )
            batch = Array.isArray(res) ? res : []
            fails = 0
            if (linkDown) {
              linkDown = false
              await setLinkOnline("poll succeeded")
            }
          } catch (e: any) {
            if (e?.telegram && (e.code === 401 || e.code === 404)) {
              log("error", `telegram auth/method error — check botToken/apiBase in ${CFG_FILE}`)
              await new Promise((r) => setTimeout(r, 30_000))
            } else if (e?.telegram && e.code === 409) {
              // Another getUpdates poller with the same token (e.g. a manual
              // curl probe) temporarily knocked ours out. Back off briefly and
              // resume; do NOT treat as an auth/config error.
              log("warn", `getUpdates conflict (409): another poller is using this bot token — backing off 5s`)
              await new Promise((r) => setTimeout(r, 5_000))
            } else {
              fails++
              const short = e?.telegram
                ? `Telegram error ${e.code ?? "?"}: ${clip(String(e.message).replace(/^getUpdates:\s*/, ""), 120)}`
                : shortNetError(e)
              if (fails === 1) log("warn", `getUpdates failed (${short}) — retrying`)
              else if (fails % 10 === 0) log("warn", `Telegram still unreachable (${fails} failed polls): ${short}`)
              else log("debug", `getUpdates failed (${short}) [${fails} in a row]`)
              if (fails >= OFFLINE_AFTER && !linkDown) {
                linkDown = true
                await setLinkOffline(short)
              }
              await new Promise((r) => setTimeout(r, 3_000))
            }
            continue
          }
          if (!(await isLeader())) break
          for (const u of batch) {
            try {
              if (typeof u.update_id === "number") offset = Math.max(offset, u.update_id + 1)
              await handleUpdate(u)
            } catch (e: any) {
              log("warn", `update: ${e?.message ?? e}`)
            }
          }
          if (batch.length) await fsp.writeFile(OFFSET_FILE, String(offset), "utf8").catch(() => {})
        }
      } finally {
        tgRunning = false
        if (!disposed && (await isLeader())) {
          setTimeout(() => void tgLoop(), 1_500)
        }
      }
    }

    async function hello() {
      await enqueue({ t: "hello", key: KEY, dir: MY_DIR, serverUrl: SERVER_URL, client: CLIENT, ts: Date.now() })
    }

    try {
      await fsp.mkdir(OUTBOX, { recursive: true })
      await fsp.mkdir(INBOX, { recursive: true })
      const cfg = await loadConfig()
      if (!cfg.enabled) {
        log("info", "disabled via config")
      } else if (!cfg.botToken) {
        log("warn", `no botToken in ${CFG_FILE}`)
      } else if (!cfg.authorizedChatIds.length) {
        const hint = "no paired chats yet — send /start to the Telegram bot and pair with the shown code"
        log("info", hint)
        try {
          console.log(`[raven] ${hint}`)
        } catch {}
      }
      log("info", `init client=${CLIENT} dir=${MY_DIR || "-"} server=${SERVER_URL || "-"}`)
      await hello()
      timers.push(setInterval(() => void leaderTick(), 3_000))
      timers.push(setInterval(() => void inboxTick(), 1_000))
      timers.push(setInterval(() => void hello(), 60_000))
      // Wake immediately on new spool files instead of waiting for the next
      // tick: drainOutbox/inboxTick no-op cheaply when there is nothing to do.
      watchDir(OUTBOX, () => kickDrain())
      watchDir(INBOX, () => kickInbox())
      o.onReady?.()
      void leaderTick()
      void inboxTick()
    } catch (e: any) {
      log("error", `init failed: ${e?.message ?? e}`)
    }

    return {
      feedEvent: async (event) => {
        try {
          const cfg = await loadConfig()
          if (!cfg.enabled || !cfg.botToken) return
          await enqueue({
            t: "event",
            key: KEY,
            dir: MY_DIR,
            serverUrl: SERVER_URL,
            client: CLIENT,
            ts: Date.now(),
            event: { type: event.type, properties: event.properties ?? {} },
          })
        } catch (e: any) {
          log("warn", `feedEvent: ${e?.message ?? e}`)
        }
      },
      dispose: async () => {
        if (disposed) return
        disposed = true
        for (const t of timers) {
          try {
            clearInterval(t)
          } catch {}
        }
        for (const w of watchers.splice(0)) {
          try {
            w.close()
          } catch {}
        }
        try {
          const o = await readOwner()
          if (o?.key === KEY) await fsp.rm(LOCK, { recursive: true, force: true })
        } catch {}
        for (const [, w] of waiters) {
          clearTimeout(w.timer)
          w.reject(new Error("bridge disposing"))
        }
        waiters.clear()
        log("info", "disposed")
      },
    }
  }
}
