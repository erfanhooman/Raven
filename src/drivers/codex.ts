// Raven — Codex driver, via `codex app-server` (newline-delimited JSON-RPC
// over stdio). One app-server child process per daemon; threads map to
// sessions ("cx_<threadId>"), turns stream agentMessage deltas, and
// command/fileChange approval requests are relayed to Telegram and answered
// back over the same channel.
//
// The protocol is marked experimental upstream: field names are extracted
// defensively, and the driver is pinned-tested against the version documented
// in the README (0.160.x).

import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { findOnPath, spawnShellFor } from "../util.js"

export type Emit = (type: string, properties: any) => Promise<void>

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: any }

// Preferred binary directory inside the VS Code extension bundle, e.g.
// macos-aarch64 / linux-x64 / win32-x64. Falls back to scanning every
// bundled subdir, since upstream renames these across releases.
function vscodeBundledCodex(): string | null {
  const extRoot = path.join(os.homedir(), ".vscode", "extensions")
  let entries: string[] = []
  try {
    entries = fs.readdirSync(extRoot)
  } catch {
    return null
  }
  const exeNames = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"]
  const preferred =
    process.platform === "darwin"
      ? process.arch === "arm64"
        ? "macos-aarch64"
        : "macos-x86_64"
      : process.platform === "win32"
        ? process.arch === "arm64"
          ? "win32-arm64"
          : "win32-x64"
        : process.arch === "arm64"
          ? "linux-arm64"
          : "linux-x64"
  for (const e of entries) {
    if (!/openai\.chatgpt|codex/i.test(e)) continue
    const binDir = path.join(extRoot, e, "bin")
    let subs: string[] = []
    try {
      subs = fs.readdirSync(binDir)
    } catch {
      continue
    }
    const ordered = [...subs.filter((s) => s === preferred), ...subs.filter((s) => s !== preferred)]
    for (const sub of ordered) {
      for (const exe of exeNames) {
        const p = path.join(binDir, sub, exe)
        try {
          if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
        } catch {}
      }
    }
  }
  return null
}

export class CodexDriver {
  bin: string
  home: string
  dirOf: () => string
  emit: Emit
  private child: ChildProcess | null = null
  private buf = ""
  private rpcId = 1
  private rpcPending = new Map<number, Pending>()
  private approvals = new Map<string, { rpcId: number | string; threadId: string; summary: string; method: string }>()
  private busy = new Set<string>()
  private streamText = new Map<string, { full: string; at: number }>()
  private restarting: Promise<void> | null = null

  constructor(opts: { bin?: string; home: string; dirOf: () => string; emit: Emit }) {
    this.home = opts.home
    this.dirOf = opts.dirOf
    this.emit = opts.emit
    this.bin = opts.bin || process.env.RAVEN_CODEX_BIN || ""
  }

  resolveBin(): string | null {
    if (this.bin && fs.existsSync(this.bin)) return this.bin
    const viaPath = findOnPath(["codex"])
    if (viaPath) return viaPath
    const guesses =
      process.platform === "win32"
        ? [
            path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "npm", "codex.cmd"),
            path.join(os.homedir(), ".local", "bin", "codex.exe"),
          ]
        : [
            "/opt/homebrew/bin/codex",
            "/usr/local/bin/codex",
            path.join(os.homedir(), ".local", "bin", "codex"),
          ]
    for (const g of guesses) if (g && fs.existsSync(g)) return g
    return vscodeBundledCodex()
  }

  available(): boolean {
    return !!this.resolveBin()
  }

  async ensure(): Promise<void> {
    if (this.child && !this.child.killed && this.child.exitCode === null) return
    if (this.restarting) return this.restarting
    this.restarting = this.start().finally(() => (this.restarting = null))
    return this.restarting
  }

  private async start(): Promise<void> {
    const bin = this.resolveBin()
    if (!bin) throw new Error("codex binary not found (install @openai/codex or set RAVEN_CODEX_BIN)")
    const child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], cwd: this.dirOf(), env: process.env, shell: spawnShellFor(bin) })
    this.child = child
    child.stdout.on("data", (c: Buffer) => void this.onData(c.toString("utf8")))
    child.stderr.on("data", () => {})
    child.on("exit", () => {
      if (this.child === child) this.child = null
      for (const p of this.rpcPending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error("codex app-server exited"))
      }
      this.rpcPending.clear()
    })
    await this.rpc("initialize", { clientInfo: { name: "raven", title: "Raven", version: "1" }, capabilities: { experimentalApi: true } }, 20_000)
    this.notify("initialized", {})
  }

  async stop(): Promise<void> {
    try {
      this.child?.kill("SIGTERM")
    } catch {}
    this.child = null
  }

  private onData(chunk: string): void {
    this.buf += chunk
    let idx: number
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      if (!line.startsWith("{")) continue
      let j: any
      try {
        j = JSON.parse(line)
      } catch {
        continue
      }
      void this.onMsg(j)
    }
  }

  private async onMsg(j: any): Promise<void> {
    if (j.method && j.id !== undefined) {
      // server -> client request (approvals)
      const handled = await this.onServerRequest(j)
      if (!handled) this.write({ id: j.id, result: {} })
      return
    }
    if (j.id !== undefined && (j.result !== undefined || j.error !== undefined)) {
      const p = this.rpcPending.get(Number(j.id))
      if (p) {
        this.rpcPending.delete(Number(j.id))
        clearTimeout(p.timer)
        if (j.error) p.reject(new Error(String(j.error?.message ?? "codex rpc error")))
        else p.resolve(j.result)
      }
      return
    }
    if (j.method) await this.onNotification(j)
  }

  private threadOf(props: any): string {
    const t = props?.threadId || props?.thread_id || props?.thread?.id || ""
    return t ? `cx_${t}` : ""
  }

  private async onNotification(j: any): Promise<void> {
    const m = String(j.method || "")
    const p = j.params || {}
    const sid = this.threadOf(p)
    if (m === "turn/started" && sid) {
      this.busy.add(sid)
      this.streamText.set(sid, { full: "", at: 0 })
      await this.emit("session.status", { sessionID: sid, status: { type: "busy" } })
      return
    }
    if (m === "item/agentMessage/delta" && sid) {
      const st = this.streamText.get(sid) ?? { full: "", at: 0 }
      st.full += String(p.delta ?? "")
      const now = Date.now()
      if (now - st.at > 1200) {
        st.at = now
        await this.emit("message.part.updated", { sessionID: sid, part: { type: "text", text: st.full } })
      }
      return
    }
    if (m === "item/completed" && sid) {
      const item = p.item || {}
      if (String(item.type || "").toLowerCase().includes("agentmessage")) {
        const text = String(item.text ?? "")
        if (text) {
          const st = this.streamText.get(sid)
          if (st) st.full = text
          await this.emit("message.part.updated", { sessionID: sid, part: { type: "text", text } })
        }
      }
      return
    }
    if (m === "turn/completed" && sid) {
      this.busy.delete(sid)
      const status = String(p.turn?.status ?? "completed")
      if (status === "failed") await this.emit("session.error", { sessionID: sid, error: { name: "CodexTurnFailed", data: { message: String(p.turn?.error?.message ?? "turn failed") } } })
      await this.emit("session.status", { sessionID: sid, status: { type: "idle" } })
      await this.emit("session.updated", { info: { id: sid, time: { updated: Date.now() } } })
      return
    }
    if (m === "thread/status/changed" && sid) {
      const s = String(p.status?.type ?? p.status ?? "").toLowerCase()
      await this.emit("session.status", { sessionID: sid, status: { type: s.includes("active") || s.includes("busy") ? "busy" : "idle" } })
    }
  }

  private async onServerRequest(j: any): Promise<boolean> {
    const m = String(j.method || "")
    const p = j.params || {}
    if (!/requestApproval/.test(m)) return false
    const sid = this.threadOf(p)
    const rawCmd = p.command ?? p.reason ?? p.patch ?? ""
    const summary = Array.isArray(rawCmd) ? rawCmd.join(" ") : String(rawCmd).replace(/\s+/g, " ").slice(0, 200)
    const id = `per_cx_${randomUUID().slice(0, 10)}`
    this.approvals.set(id, { rpcId: j.id, threadId: sid, summary, method: m })
    await this.emit("permission.asked", {
      id,
      sessionID: sid,
      permission: m.includes("fileChange") ? "patch" : "exec",
      patterns: [summary || m],
      metadata: {},
      always: [],
    })
    return true
  }

  reply(requestID: string, decision: string): void {
    const a = this.approvals.get(requestID)
    if (!a) throw new Error("Codex approval not found (answered already?)")
    this.approvals.delete(requestID)
    const value =
      decision === "reject"
        ? { decision: "decline" }
        : decision === "always"
          ? { decision: "acceptForSession" }
          : { decision: "accept" }
    this.write({ id: a.rpcId, result: value })
    void this.emit("permission.replied", { sessionID: a.threadId, requestID: requestID, reply: decision })
  }

  pending() {
    return [...this.approvals.entries()].map(([id, a]) => ({ id, sessionID: a.threadId, permission: a.method.includes("fileChange") ? "patch" : "exec", patterns: [a.summary] }))
  }

  private write(msg: any): void {
    try {
      this.child?.stdin?.write(JSON.stringify(msg) + "\n")
    } catch {}
  }

  private rpc(method: string, params: any, timeoutMs = 20_000): Promise<any> {
    const id = this.rpcId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rpcPending.delete(id)
        reject(new Error(`codex ${method}: timeout`))
      }, timeoutMs)
      this.rpcPending.set(id, { resolve, reject, timer })
      this.write({ id, method, params })
    })
  }

  private notify(method: string, params: any): void {
    this.write({ method, params })
  }

  async list(): Promise<{ sessions: any[]; statuses: Record<string, any>; previews: Record<string, string> }> {
    await this.ensure()
    let res: any = null
    try {
      res = await this.rpc("thread/list", { limit: 40, sortKey: "updated" })
    } catch (e: any) {
      throw e
    }
    const arr: any[] = res?.threads ?? res?.data ?? res?.items ?? (Array.isArray(res) ? res : [])
    const sessions = arr.map((t: any) => ({
      id: `cx_${t.id ?? t.threadId}`,
      title: String(t.name || t.title || (Array.isArray(t.preview) ? t.preview.join(" ") : t.preview) || t.firstUserMessage || `${t.id ?? ""}`.slice(0, 8)).slice(0, 80),
      directory: String(t.cwd ?? t.directory ?? ""),
      time: { updated: Number(t.updatedAt ?? t.updated_at ?? t.time?.updated ?? Date.now()) },
      model: t.model ? { providerID: "openai", modelID: String(t.model) } : undefined,
    }))
    const statuses: Record<string, any> = {}
    for (const s of sessions) if (this.busy.has(s.id)) statuses[s.id] = { type: "busy" }
    return { sessions, statuses, previews: {} }
  }

  async detail(sid: string): Promise<any> {
    await this.ensure()
    const threadId = sid.replace(/^cx_/, "")
    let turns: any[] = []
    try {
      const r = await this.rpc("thread/read", { threadId, includeTurns: true })
      const t = r?.thread ?? r
      turns = t?.turns ?? []
      return {
        info: {
          id: sid,
          title: String(t?.name || t?.firstUserMessage || threadId.slice(0, 8)).slice(0, 80),
          directory: String(t?.cwd ?? ""),
          time: { updated: Number(t?.updatedAt ?? Date.now()) },
          model: t?.model ? { providerID: "openai", modelID: String(t.model) } : undefined,
          agent: "build",
        },
        status: this.busy.has(sid) ? { type: "busy" } : { type: "idle" },
        messages: turnsToMessages(turns).slice(-8),
        children: [],
      }
    } catch {
      return {
        info: { id: sid, title: threadId.slice(0, 8), directory: "", time: { updated: Date.now() }, agent: "build" },
        status: this.busy.has(sid) ? { type: "busy" } : { type: "idle" },
        messages: [],
        children: [],
      }
    }
  }

  history(sid: string, limit = 30): any[] {
    // best effort via detail(); returns full list (caller slices/paginates by id)
    const threadId = sid.replace(/^cx_/, "")
    const out: any[] = []
    // synchronous cache-less fetch is not possible over RPC; return [] and let
    // the conversation screen show what list/detail expose.
    void threadId
    void limit
    return out
  }

  async createSession(title: string, dir: string, model?: string): Promise<any> {
    await this.ensure()
    const r = await this.rpc("thread/start", { cwd: dir || this.dirOf(), ...(model && model !== "default" ? { model } : {}) })
    const t = r?.thread ?? r
    const id = String(t?.id ?? "")
    if (!id) throw new Error("codex thread/start returned no id")
    const sid = `cx_${id}`
    await this.emit("session.created", { info: { id: sid, title: title || id.slice(0, 8), directory: dir || this.dirOf(), time: { updated: Date.now() } } })
    return { id: sid, title: title || id.slice(0, 8), directory: dir || "", time: { updated: Date.now() } }
  }

  async prompt(sid: string, text: string, model?: { modelID?: string }): Promise<void> {
    await this.ensure()
    const threadId = sid.replace(/^cx_/, "")
    this.busy.add(sid)
    await this.emit("session.status", { sessionID: sid, status: { type: "busy" } }).catch(() => {})
    try {
      await this.rpc(
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text }],
          ...(model?.modelID && model.modelID !== "default" ? { model: model.modelID } : {}),
        },
        10_000,
      )
      // notifications carry the real progress; nothing else to await here
    } catch (e: any) {
      this.busy.delete(sid)
      await this.emit("session.status", { sessionID: sid, status: { type: "idle" } }).catch(() => {})
      throw e
    }
  }

  async abort(sid: string): Promise<boolean> {
    try {
      await this.rpc("turn/interrupt", { threadId: sid.replace(/^cx_/, "") }, 8_000)
      return true
    } catch {
      return false
    }
  }

  providerList(): any {
    const models: Record<string, any> = { default: { id: "default", name: "default (config.toml)" } }
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".codex", "models_cache.json"), "utf8"))
      const arr: any[] = Array.isArray(raw) ? raw : raw?.models ?? raw?.data ?? []
      for (const m of arr) {
        const id = String(m?.slug ?? m?.model ?? m?.id ?? "")
        if (id) models[id] = { id, name: String(m?.display_name ?? m?.name ?? id) }
      }
    } catch {}
    try {
      const cfg = fs.readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8")
      const m = /^model\s*=\s*"([^"]+)"/m.exec(cfg)
      if (m && !models[m[1]]) models[m[1]] = { id: m[1], name: `${m[1]} (config)` }
    } catch {}
    const known = ["gpt-5.5", "gpt-5.1-codex-max", "gpt-5-codex"]
    for (const k of known) if (!models[k]) models[k] = { id: k, name: k }
    return { all: [{ id: "openai", name: "OpenAI", models }], connected: ["openai"], default: {} }
  }
}

function turnsToMessages(turns: any[]): any[] {
  const out: any[] = []
  for (const t of turns) {
    const items: any[] = t?.items ?? t?._items ?? (Array.isArray(t) ? t : [])
    let userText = ""
    let assistantText = ""
    for (const it of items) {
      const type = String(it?.type ?? "").toLowerCase()
      if (type === "usermessage" || type === "user_message") userText += (userText ? "\n" : "") + String(it?.text ?? it?.content ?? "")
      if (type === "agentmessage" || type === "agent_message") assistantText += (assistantText ? "\n" : "") + String(it?.text ?? "")
    }
    const when = Number(t?.startedAt ?? t?.time?.created ?? 0)
    if (userText) out.push({ info: { id: `t${when}u`, role: "user", time: { created: when } }, parts: [{ type: "text", text: userText }] })
    if (assistantText) out.push({ info: { id: `t${when}a`, role: "assistant", time: { created: when } }, parts: [{ type: "text", text: assistantText }] })
  }
  return out
}
