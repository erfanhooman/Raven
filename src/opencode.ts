import path from "node:path"
import os from "node:os"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { ClientKind, BridgeHandle } from "./core.js"
import { startBridge } from "./core.js"
import { ravenHome } from "./util.js"

type Dir = string
type ModelRef = { providerID: string; modelID: string }

function modelFromInfo(m: any): ModelRef | undefined {
  const providerID = String(m?.providerID ?? "")
  const modelID = String(m?.modelID ?? m?.id ?? "")
  if (!providerID || !modelID) return undefined
  return { providerID, modelID }
}

export function createOpencodeDriver(input: { directory?: string; serverUrl?: string }): {
  dir: Dir
  serverUrl: string
  runAction: (action: string, payload: any) => Promise<any>
} {
  const MY_DIR: Dir = String(input.directory ?? process.cwd())
  const SERVER_URL: string = String(input.serverUrl ?? "http://127.0.0.1:4096").replace(/\/+$/, "")

  function authHeaders(): Record<string, string> {
    const pw = process.env.OPENCODE_SERVER_PASSWORD
    if (!pw) return {}
    const user = process.env.OPENCODE_SERVER_USERNAME || "opencode"
    return { Authorization: "Basic " + Buffer.from(`${user}:${pw}`).toString("base64") }
  }

  async function oc(method: string, p: string, opts: { qs?: Record<string, string>; body?: any } = {}) {
    const qs = new URLSearchParams({ ...(opts.qs ?? {}), directory: MY_DIR })
    const url = `${SERVER_URL}${p}?${qs.toString()}`
    const res = await fetch(url, {
      method,
      headers: {
        ...authHeaders(),
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => "")
      throw new Error(`${method} ${p} -> ${res.status} ${txt.slice(0, 300)}`)
    }
    if (res.status === 204) return null
    return res.json().catch(() => null)
  }

  async function executeAction(action: string, payload: any): Promise<any> {
    switch (action) {
      case "session.list": {
        const [sessions, statuses] = await Promise.all([
          oc("GET", "/session", { qs: { limit: "25" } }),
          oc("GET", "/session/status").catch(() => ({})),
        ])
        const list: any[] = Array.isArray(sessions) ? sessions : []
        const previews: Record<string, string> = {}
        await Promise.all(
          list.slice(0, 12).map(async (s: any) => {
            try {
              const msgs = await oc("GET", `/session/${encodeURIComponent(s.id)}/message`, { qs: { limit: "1" } })
              const last = Array.isArray(msgs) && msgs.length ? msgs[0] : null
              const t = last ? msgText(last) : ""
              if (t) previews[s.id] = t.replace(/\s+/g, " ")
            } catch {}
          }),
        )
        return { sessions: list, statuses: statuses ?? {}, previews }
      }
      case "session.detail": {
        const sid = payload.sessionID
        const [info, statuses, messages, children] = await Promise.all([
          oc("GET", `/session/${encodeURIComponent(sid)}`),
          oc("GET", "/session/status").catch(() => ({})),
          oc("GET", `/session/${encodeURIComponent(sid)}/message`, { qs: { limit: "8" } }).catch(() => []),
          oc("GET", `/session/${encodeURIComponent(sid)}/children`).catch(() => []),
        ])
        return {
          info,
          status: (statuses ?? {})[sid] ?? { type: "idle" },
          messages: Array.isArray(messages) ? messages : [],
          children: Array.isArray(children) ? children : [],
        }
      }
      case "session.history": {
        const qs: Record<string, string> = { limit: String(payload.limit ?? 30) }
        if (payload.before) qs.before = payload.before
        const msgs = await oc("GET", `/session/${encodeURIComponent(payload.sessionID)}/message`, { qs })
        return Array.isArray(msgs) ? msgs : []
      }
      case "session.get":
        return oc("GET", `/session/${encodeURIComponent(payload.sessionID)}`)
      case "session.messages":
        return oc("GET", `/session/${encodeURIComponent(payload.sessionID)}/message`, {
          qs: { limit: String(payload.limit ?? 8) },
        })
      case "session.create":
        return oc("POST", "/session", { body: payload?.title ? { title: payload.title } : {} })
      case "session.prompt": {
        const body: any = { parts: [{ type: "text", text: payload.text }] }
        if (payload.model) body.model = payload.model
        if (payload.agent) body.agent = payload.agent
        return oc("POST", `/session/${encodeURIComponent(payload.sessionID)}/prompt_async`, { body })
      }
      case "session.abort":
        return oc("POST", `/session/${encodeURIComponent(payload.sessionID)}/abort`)
      case "session.command":
        return oc("POST", `/session/${encodeURIComponent(payload.sessionID)}/command`, {
          body: { command: payload.command, arguments: payload.arguments ?? "" },
        })
      case "session.revert":
        return oc("POST", `/session/${encodeURIComponent(payload.sessionID)}/revert`, {
          body: payload?.messageID ? { messageID: payload.messageID } : {},
        })
      case "session.changes":
        return oc("GET", `/session/${encodeURIComponent(payload.sessionID)}/diff`).catch(() => [])
      case "session.tasks":
        return oc("GET", `/session/${encodeURIComponent(payload.sessionID)}/todo`).catch(() => [])
      case "instance.agents":
        return oc("GET", `/agent`).catch(() => [])
      case "instance.commands":
        return oc("GET", `/command`).catch(() => [])
      case "provider.list":
        return oc("GET", `/provider`).catch(() => null)
      case "permission.list":
        return oc("GET", "/permission")
      case "permission.reply":
        return oc("POST", `/permission/${encodeURIComponent(payload.requestID)}/reply`, {
          body: { reply: payload.reply, ...(payload.message ? { message: payload.message } : {}) },
        })
      case "question.list":
        return oc("GET", "/question")
      case "question.reply":
        return oc("POST", `/question/${encodeURIComponent(payload.requestID)}/reply`, {
          body: { answers: payload.answers },
        })
      case "question.reject":
        return oc("POST", `/question/${encodeURIComponent(payload.requestID)}/reject`)
      case "pending": {
        const [permissions, questions, statuses] = await Promise.all([
          oc("GET", "/permission").catch(() => []),
          oc("GET", "/question").catch(() => []),
          oc("GET", "/session/status").catch(() => ({})),
        ])
        return { permissions: permissions ?? [], questions: questions ?? [], statuses: statuses ?? {} }
      }
      case "git.state": {
        const dir = String(payload?.dir || MY_DIR)
        const run = (args: string[]) =>
          new Promise<string>((res) => {
            execFile("git", ["-C", dir, ...args], { timeout: 4_000 }, (e: any, out: string) => res(e ? "" : String(out ?? "").trim()))
          })
        const branch = await run(["rev-parse", "--abbrev-ref", "HEAD"])
        const branches = (await run(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads/"]))
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, 8)
        return { branch, branches }
      }
      default:
        throw new Error(`unknown action ${action}`)
    }
  }

  return { dir: MY_DIR, serverUrl: SERVER_URL, runAction: executeAction }
}

function msgText(withParts: any): string {
  const parts = withParts?.parts ?? []
  const texts = parts
    .filter((p: any) => p?.type === "text" && typeof p.text === "string" && p.text.trim())
    .map((p: any) => String(p.text).trim())
  const tools = parts
    .filter((p: any) => p?.type === "tool" && p?.tool)
    .map((p: any) => {
      const cmd = typeof p.state?.input?.command === "string" ? `: ${String(p.state.input.command).slice(0, 60)}` : ""
      const out = typeof p.state?.output === "string" && p.state.output.trim() ? ` → ${String(p.state.output.trim()).slice(0, 80)}` : ""
      return `🔧 ${p.tool}${cmd}${out}`
    })
  return [...texts, ...tools].join("\n").trim()
}

const INTERESTING = new Set([
  "permission.asked",
  "permission.replied",
  "permission.v2.asked",
  "permission.v2.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "question.v2.asked",
  "question.v2.replied",
  "question.v2.rejected",
  "session.status",
  "session.idle",
  "session.error",
  "message.part.updated",
  "session.created",
  "session.updated",
  "session.deleted",
])

export async function startOpencodePlugin(input: any): Promise<BridgeHandle> {
  const driver = createOpencodeDriver(input)
  return startBridge({
    home: ravenHome(),
    key: randomUUID(),
    dir: driver.dir,
    serverUrl: driver.serverUrl,
    client: "oc" as ClientKind,
    runAction: driver.runAction,
  })
}

