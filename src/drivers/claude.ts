// Raven — Claude Code driver.
//
// Claude Code cannot be live-mirrored into an interactive TUI session from the
// outside, so this driver owns its own sessions by driving the installed
// `claude` CLI in non-interactive mode:
//
//   claude -p --output-format stream-json --include-partial-messages \
//          [--resume <uuid>] [--model <m>] [--permission-mode <m>] --settings <file>
//
// One child process per Telegram message; the transcript lives in
// ~/.claude/projects so `claude --resume <uuid>` in a terminal continues the
// same conversation. Tool approvals come back through an HTTP PreToolUse hook
// (written into the settings file) that the bridge holds open until the user
// answers on Telegram.

import { spawn } from "node:child_process"
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"
import fsp from "node:fs/promises"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { findOnPath, spawnShellFor } from "../util.js"

export type Emit = (type: string, properties: any) => Promise<void>

type Run = {
  sid: string
  child: any
  text: string
  partialAt: number
}

type Approval = {
  id: string
  sid: string
  tool: string
  summary: string
  respond: (decision: "allow" | "deny") => void
}

const ALIAS_MODELS = ["default", "sonnet", "opus", "haiku"]

export class ClaudeDriver {
  bin: string
  home: string
  dirOf: () => string
  emit: Emit
  private token = randomUUID().slice(0, 12)
  private server: Server | null = null
  private port = 0
  private settingsFile = ""
  private runs = new Map<string, Run>()
  private approvals = new Map<string, Approval>()
  private byHook = new Map<string, Approval>()

  constructor(opts: { bin?: string; home: string; dirOf: () => string; emit: Emit }) {
    this.home = opts.home
    this.dirOf = opts.dirOf
    this.emit = opts.emit
    this.bin = opts.bin || process.env.RAVEN_CLAUDE_BIN || ""
  }

  projectsRoot(): string {
    return process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), ".claude", "projects")
  }

  available(): boolean {
    return !!this.resolveBin()
  }

  resolveBin(): string | null {
    if (this.bin && fs.existsSync(this.bin)) return this.bin
    const viaPath = findOnPath(["claude"])
    if (viaPath) return viaPath
    const guesses =
      process.platform === "win32"
        ? [
            path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "npm", "claude.cmd"),
            path.join(os.homedir(), ".local", "bin", "claude.exe"),
          ]
        : [path.join(os.homedir(), ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]
    for (const g of guesses) if (g && fs.existsSync(g)) return g
    return null
  }

  async start(): Promise<void> {
    this.loadIdMap()
    await new Promise<void>((resolve) => {
      this.server = createServer((req, res) => void this.handleHttp(req, res))
      this.server!.listen(0, "127.0.0.1", () => {
        this.port = (this.server!.address() as any).port
        resolve()
      })
    })
    this.settingsFile = path.join(this.home, "claude-settings.json")
    const hookUrl = `http://127.0.0.1:${this.port}/hook/${this.token}`
    const settings = {
      hooks: {
        PreToolUse: [{ matcher: "", hooks: [{ type: "http", url: hookUrl, timeout: 600 }] }],
      },
    }
    await fsp.writeFile(this.settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 })
  }

  async stop(): Promise<void> {
    for (const [, r] of this.runs) {
      try {
        r.child.kill("SIGTERM")
      } catch {}
    }
    for (const [, a] of this.approvals) a.respond("deny")
    try {
      this.server?.close()
    } catch {}
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const want = `/hook/${this.token}`
    if (!String(req.url || "").startsWith(want)) {
      res.writeHead(404).end()
      return
    }
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("error", () => {})
    await new Promise<void>((done) => req.on("end", () => done()))
    let payload: any = {}
    try {
      payload = JSON.parse(body)
    } catch {}
    const sid = `cl_${payload.session_id || "unknown"}`
    const tool = String(payload.tool_name ?? "tool")
    const input = payload.tool_input ?? {}
    const summary = describeTool(tool, input)
    const id = `per_cl_${randomUUID().slice(0, 10)}`
    const approval: Approval = {
      id,
      sid,
      tool,
      summary,
      respond: (decision) => {
        try {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: decision,
                permissionDecisionReason: decision === "allow" ? "approved from Telegram" : "rejected from Telegram",
              },
            }),
          )
        } catch {}
        this.approvals.delete(id)
        void this.emit("permission.replied", { sessionID: sid, requestID: id, reply: decision === "allow" ? "once" : "reject" })
      },
    }
    this.approvals.set(id, approval)
    this.byHook.set(sid + payload.tool_use_id, approval)
    await this.emit("permission.asked", {
      id,
      sessionID: sid,
      permission: tool,
      patterns: [summary],
      metadata: {},
      always: [],
    })
    // Auto-release if claude's own hook timeout kills the request: drop our entry.
    req.on("close", () => {
      if (this.approvals.has(id) && (this.byHook.get(sid + payload.tool_use_id) === approval)) {
        this.approvals.delete(id)
        void this.emit("permission.replied", { sessionID: sid, requestID: id, reply: "reject" })
      }
    })
  }

  listSessions(): any[] {
    const rev = new Map<string, string>()
    for (const [ours, rid] of this.claudeId) rev.set(rid, ours)
    const out: any[] = []
    let dirs: string[] = []
    try {
      dirs = fs.readdirSync(this.projectsRoot())
    } catch {
      return out
    }
    for (const d of dirs) {
      const full = path.join(this.projectsRoot(), d)
      let files: string[] = []
      try {
        files = fs.readdirSync(full).filter((f) => f.endsWith(".jsonl"))
      } catch {
        continue
      }
      for (const f of files) {
        const fp = path.join(full, f)
        try {
          const st = fs.statSync(fp)
          const meta = this.transcriptMeta(fp)
          const uuid = f.replace(/\.jsonl$/, "")
          out.push({
            id: `cl_${rev.get(uuid) || uuid}`,
            title: meta.title || uuid.slice(0, 8),
            directory: meta.cwd || "",
            time: { updated: st.mtimeMs },
            model: meta.model ? { providerID: "anthropic", modelID: meta.model } : undefined,
            agent: meta.mode === "plan" ? "plan" : "build",
          })
        } catch {}
      }
    }
    out.sort((a, b) => b.time.updated - a.time.updated)
    return out.slice(0, 40)
  }

  private transcriptMeta(fp: string): { title: string; cwd: string; model: string; mode: string } {
    const res = { title: "", cwd: "", model: "", mode: "" }
    try {
      const fd = fs.openSync(fp, "r")
      const buf = Buffer.alloc(65536)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      fs.closeSync(fd)
      for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
        if (!line.trim().startsWith("{")) continue
        let j: any
        try {
          j = JSON.parse(line)
        } catch {
          continue
        }
        if (j.cwd && !res.cwd) res.cwd = String(j.cwd)
        if (j.type === "assistant" && j.message?.model && !res.model) res.model = String(j.message.model)
        const mode = j.message?.mode || j.mode
        if (mode && !res.mode) res.mode = String(mode)
        if (!res.title && j.type === "user") {
          const t = firstText(j.message?.content)
          if (t) res.title = t.replace(/\s+/g, " ").slice(0, 60)
        }
        if (res.cwd && res.title && res.model) break
      }
    } catch {}
    return res
  }

  transcriptMessages(sid: string, limit = 8, before = ""): any[] {
    const uuid = this.realIdOf(sid)
    const fp = this.findTranscript(uuid)
    if (!fp) return []
    let raw = ""
    try {
      raw = fs.readFileSync(fp, "utf8")
    } catch {
      return []
    }
    const msgs: any[] = []
    for (const line of raw.split("\n")) {
      if (!line.trim().startsWith("{")) continue
      let j: any
      try {
        j = JSON.parse(line)
      } catch {
        continue
      }
      if (j.type !== "user" && j.type !== "assistant") continue
      const text = firstText(j.message?.content)
      if (!text) continue
      msgs.push({
        info: {
          id: String(j.uuid || `${j.timestamp ?? ""}`),
          role: j.type,
          time: { created: Number(j.timestamp) || 0 },
          modelID: j.message?.model,
          agent: j.message?.mode,
        },
        parts: [{ type: "text", text }],
      })
    }
    let out = msgs
    if (before) {
      const idx = out.findIndex((m) => m.info.id === before)
      if (idx >= 0) out = out.slice(0, idx)
    }
    return out.slice(-limit)
  }

  private findTranscript(uuid: string): string | null {
    let dirs: string[] = []
    try {
      dirs = fs.readdirSync(this.projectsRoot())
    } catch {
      return null
    }
    for (const d of dirs) {
      const fp = path.join(this.projectsRoot(), d, `${uuid}.jsonl`)
      if (fs.existsSync(fp)) return fp
    }
    return null
  }

  async list(): Promise<{ sessions: any[]; statuses: Record<string, any>; previews: Record<string, string> }> {
    const sessions = this.listSessions()
    const statuses: Record<string, any> = {}
    const previews: Record<string, string> = {}
    for (const s of sessions) {
      if (this.runs.has(s.id)) statuses[s.id] = { type: "busy" }
      const last = this.transcriptMessages(s.id, 1)[0]
      if (last) previews[s.id] = String(msgOf(last).slice(0, 200))
    }
    return { sessions, statuses, previews }
  }

  async detail(sid: string): Promise<any> {
    const uuid = this.realIdOf(sid)
    const s = this.listSessions().find((x) => x.id === sid)
    const meta = s ? { cwd: s.directory, model: s.model?.modelID || "", mode: s.agent || "build" } : this.transcriptMeta(this.findTranscript(uuid) || "")
    const info = {
      id: sid,
      title: s?.title || uuid.slice(0, 8),
      directory: meta.cwd || "",
      time: { updated: s?.time?.updated || Date.now(), created: s?.time?.updated || Date.now() },
      model: meta.model ? { providerID: "anthropic", modelID: meta.model } : undefined,
      agent: meta.mode,
    }
    return {
      info,
      status: this.runs.has(sid) ? { type: "busy" } : { type: "idle" },
      messages: this.transcriptMessages(sid, 8),
      children: [],
    }
  }

  async createSession(title: string, dir: string): Promise<any> {
    // Claude allocates the real session id on first run; the entry registers
    // on the first prompt's init event.
    const uuid = randomUUID()
    const sid = `cl_${uuid}`
    this.pendingCreate.set(sid, { title: title || "Claude chat", dir: dir || this.dirOf() })
    return { id: sid, title: title || "Claude chat", directory: dir || "", time: { updated: Date.now() } }
  }

  private pendingCreate = new Map<string, { title: string; dir: string }>()
  // our sid -> real claude session id (assigned on first run of a new session)
  private claudeId = new Map<string, string>()

  private mapFile(): string {
    return path.join(this.home, "claude-map.json")
  }

  loadIdMap(): void {
    try {
      const j = JSON.parse(fs.readFileSync(this.mapFile(), "utf8"))
      for (const [k, v] of Object.entries(j)) if (typeof v === "string") this.claudeId.set(k, v)
    } catch {}
  }

  private saveIdMap(): void {
    try {
      fs.writeFileSync(this.mapFile(), JSON.stringify(Object.fromEntries(this.claudeId)))
    } catch {}
  }

  private realIdOf(sid: string): string {
    return this.claudeId.get(sid) || sid.replace(/^cl_/, "")
  }

  async prompt(sid: string, text: string, model?: { modelID?: string }, agent?: string): Promise<void> {
    if (this.runs.has(sid)) throw new Error("Claude is already answering in this session — wait or tap ⏹ Stop")
    const bin = this.resolveBin()
    if (!bin) throw new Error(`claude binary not found (set RAVEN_CLAUDE_BIN or install Claude Code)`)
    const pc = this.pendingCreate.get(sid)
    const realId = this.realIdOf(sid)
    const hasTranscript = !!this.findTranscript(realId)
    const known = this.listSessions().find((s) => s.id === sid)
    const cwd =
      (known?.directory && fs.existsSync(known.directory) ? known.directory : "") ||
      (pc?.dir && fs.existsSync(pc.dir) ? pc.dir : "") ||
      this.dirOf()
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--settings", this.settingsFile]
    if (hasTranscript) args.push("--resume", realId)
    if (model?.modelID && model.modelID !== "default") args.push("--model", model.modelID)
    args.push("--permission-mode", agent === "plan" ? "plan" : "acceptEdits")
    const child = spawn(bin, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"], shell: spawnShellFor(bin) })
    const run: Run = { sid, child, text: "", partialAt: 0 }
    this.runs.set(sid, run)
    await this.emit("session.status", { sessionID: sid, status: { type: "busy" } })
    if (!hasTranscript) {
      await this.emit("session.created", { info: { id: sid, title: pc?.title || text.slice(0, 60), directory: cwd, time: { updated: Date.now() } } })
      this.pendingCreate.delete(sid)
    }
    let buf = ""
    let finalText = ""
    let sawInit = false
    let lastStderr = ""
    child.stdout.on("data", async (c: Buffer) => {
      buf += c.toString("utf8")
      let idx: number
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line.startsWith("{")) continue
        let j: any
        try {
          j = JSON.parse(line)
        } catch {
          continue
        }
        if (j.type === "system" && j.subtype === "init") {
          sawInit = true
          if (!hasTranscript && j.session_id && String(j.session_id) !== sid.replace(/^cl_/, "")) {
            this.claudeId.set(sid, String(j.session_id))
            this.saveIdMap()
          }
        }
        if (j.type === "stream_event") {
          const d = j.event?.delta
          if (d?.type === "text_delta" && typeof d.text === "string") {
            run.text += d.text
            const now = Date.now()
            if (now - run.partialAt > 1200) {
              run.partialAt = now
              await this.emit("message.part.updated", { sessionID: sid, part: { type: "text", text: run.text } })
            }
          }
        }
        if (j.type === "assistant" && !sawInit) {
          const t = firstText(j.message?.content)
          if (t && t.length > run.text.length) {
            run.text = t
            await this.emit("message.part.updated", { sessionID: sid, part: { type: "text", text: run.text } })
          }
        }
        if (j.type === "system" && j.subtype === "api_retry") {
          const hint = lastStderr ? `: ${lastStderr.slice(0, 120)}` : ""
          await this.emit("session.status", { sessionID: sid, status: { type: "retry", attempt: j.attempt, message: (`claude API retrying${hint}`).slice(0, 200) } })
        }
        if (j.type === "result") {
          finalText = String(j.result ?? run.text ?? "")
          if (j.is_error) {
            await this.emit("session.error", { sessionID: sid, error: { name: "ClaudeError", data: { message: finalText || lastStderr || "claude returned an error" } } })
          }
        }
      }
    })
    child.on("close", async (code: number) => {
      this.runs.delete(sid)
      const text = finalText || run.text
      if (text) await this.emit("message.part.updated", { sessionID: sid, part: { type: "text", text } })
      if (!text && code !== 0 && lastStderr) await this.emit("session.error", { sessionID: sid, error: { name: "ClaudeExit", data: { message: lastStderr.slice(0, 300) } } })
      await this.emit("session.status", { sessionID: sid, status: { type: "idle" } })
      await this.emit("session.updated", { info: { id: sid, time: { updated: Date.now() } } })
    })
    child.stderr.on("data", (c: Buffer) => { lastStderr = String(c).trim().slice(0, 300) || lastStderr })
    try {
      child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n")
      child.stdin.end()
    } catch {}
  }

  async abort(sid: string): Promise<boolean> {
    const r = this.runs.get(sid)
    if (!r) return false
    try {
      r.child.kill("SIGTERM")
      return true
    } catch {
      return false
    }
  }

  pending(): { id: string; sessionID: string; permission: string; patterns: string[] }[] {
    return [...this.approvals.values()].map((a) => ({ id: a.id, sessionID: a.sid, permission: a.tool, patterns: [a.summary] }))
  }

  reply(requestID: string, reply: string): void {
    const a = this.approvals.get(requestID)
    if (!a) throw new Error("Claude approval not found (answered already?)")
    a.respond(reply === "reject" ? "deny" : "allow")
  }

  providerList(): any {
    const models: Record<string, any> = {}
    for (const m of ALIAS_MODELS) models[m] = { id: m, name: m === "default" ? "default (CLI configured model)" : m }
    return { all: [{ id: "anthropic", name: "Claude", models }], connected: ["anthropic"], default: {} }
  }
}

function firstText(content: any): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n")
    .trim()
}

function msgOf(withParts: any): string {
  return (withParts?.parts ?? []).map((p: any) => p?.text ?? "").join(" ").trim()
}

function describeTool(tool: string, input: any): string {
  try {
    if (tool === "Bash" && typeof input?.command === "string") return `run: ${input.command.slice(0, 160)}`
    if ((tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit") && input?.file_path) return `modify ${String(input.file_path).slice(0, 160)}`
    if (tool === "Read" && input?.file_path) return `read ${String(input.file_path).slice(0, 160)}`
    return JSON.stringify(input).slice(0, 160)
  } catch {
    return tool
  }
}
