// Raven daemon: hosts the Claude Code and Codex drivers and joins the same
// spool/leader protocol the opencode plugin uses. When no opencode instance is
// running, the daemon itself is the Telegram leader; otherwise it acts purely
// as a session provider that the plugin's UI talks to via the inbox.

import { execFile } from "node:child_process"
import fsp from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { startBridge } from "./core.js"
import { ravenHome } from "./util.js"
import { ClaudeDriver } from "./drivers/claude.js"
import { CodexDriver } from "./drivers/codex.js"

type Emit = (type: string, properties: any) => Promise<void>

async function gitState(dir: string) {
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

async function loadRavenConfig(home: string): Promise<any> {
  try {
    return JSON.parse(await fsp.readFile(path.join(home, "raven.json"), "utf8"))
  } catch {
    return {}
  }
}

export async function runDaemon(): Promise<{ dispose: () => Promise<void> }> {
  const home = ravenHome()
  await fsp.mkdir(home, { recursive: true })
  const cfg = await loadRavenConfig(home)
  const workdir = String(cfg?.clients?.claude?.workspace || process.env.RAVEN_WORKDIR || process.cwd())

  let feed: ((t: string, p: any) => Promise<void>) | null = null
  const emit: Emit = async (type, properties) => {
    if (!feed) return
    await feed(type, properties)
  }

  const claude = new ClaudeDriver({ bin: cfg?.clients?.claude?.bin, home, dirOf: () => workdir, emit })
  const codex = new CodexDriver({ bin: cfg?.clients?.codex?.bin, home, dirOf: () => workdir, emit })
  const claudeOn = cfg?.clients?.claude?.enabled !== false && claude.available()
  const codexOn = cfg?.clients?.codex?.enabled !== false && codex.available()
  if (claudeOn) await claude.start().catch(() => {})
  // codex starts lazily on first use (spawns the app-server child)

  const bySid = (sid: string) => (String(sid).startsWith("cl_") ? claude : String(sid).startsWith("cx_") ? codex : null)
  const anyDriver = () => (claudeOn ? claude : codexOn ? codex : null)

  async function runAction(action: string, payload: any): Promise<any> {
    const sid = String(payload?.sessionID ?? payload?.sid ?? "")
    const d = bySid(sid) || (action === "session.create" ? (payload?.client === "cx" ? codex : claude) : null)
    switch (action) {
      case "session.list": {
        const sessions: any[] = []
        const statuses: Record<string, any> = {}
        const previews: Record<string, string> = {}
        const parts = await Promise.allSettled([claudeOn ? claude.list() : null, codexOn ? codex.list() : null])
        for (const r of parts) {
          if (r.status !== "fulfilled" || !r.value) continue
          sessions.push(...r.value.sessions)
          Object.assign(statuses, r.value.statuses)
          Object.assign(previews, r.value.previews)
        }
        return { sessions, statuses, previews }
      }
      case "session.detail":
        if (!d) throw new Error("unknown session " + sid)
        return d.detail(sid)
      case "session.messages":
        if (!d) throw new Error("unknown session " + sid)
        return (d as any).transcriptMessages ? (d as any).transcriptMessages(sid, payload?.limit ?? 8) : (await d.detail(sid)).messages
      case "session.history":
        if (!d) throw new Error("unknown session " + sid)
        if (d === claude) return (claude as any).transcriptMessages(sid, payload?.limit ?? 30)
        return (await codex.detail(sid)).messages
      case "session.get":
        if (!d) throw new Error("unknown session " + sid)
        return (await d.detail(sid)).info
      case "session.create": {
        const target = payload?.client === "cx" ? codex : claude
        return target.createSession(String(payload?.title ?? ""), String(payload?.dir ?? ""))
      }
      case "session.prompt":
        if (!d) throw new Error("unknown session " + sid)
        return d.prompt(sid, String(payload?.text ?? ""), payload?.model, payload?.agent)
      case "session.abort":
        if (!d) throw new Error("unknown session " + sid)
        return { aborted: await d.abort(sid) }
      case "provider.list":
        if (d === claude || (claudeOn && !sid)) return claude.providerList()
        if (d === codex || codexOn) return codex.providerList()
        return { all: [], connected: [], default: {} }
      case "permission.list": {
        const out: any[] = []
        if (claudeOn) out.push(...(claude.pending() as any))
        if (codexOn) out.push(...(codex.pending() as any))
        return out
      }
      case "permission.reply": {
        const rid = String(payload?.requestID ?? "")
        if (rid.startsWith("per_cl_")) return claude.reply(rid, String(payload?.reply ?? "reject"))
        if (rid.startsWith("per_cx_")) return codex.reply(rid, String(payload?.reply ?? "reject"))
        throw new Error("approval not owned by daemon")
      }
      case "question.list":
        return []
      case "pending": {
        const permissions: any[] = []
        const statuses: Record<string, any> = {}
        if (claudeOn) permissions.push(...(claude.pending() as any))
        if (codexOn) permissions.push(...(codex.pending() as any))
        const list = await runAction("session.list", {}).catch(() => null)
        return { permissions, questions: [], statuses: list?.statuses ?? {} }
      }
      case "instance.commands":
      case "instance.agents":
        return []
      case "git.state": {
        const dir = String(payload?.dir ?? "") || workdir
        if (!dir) return { branch: "", branches: [] }
        try {
          return await gitState(dir)
        } catch {
          return { branch: "", branches: [] }
        }
      }
      case "session.rename": {
        const reg = null
        void reg
        void anyDriver
        throw new Error("renaming is only supported for opencode sessions")
      }
      default:
        throw new Error(`raven daemon: unknown action ${action}`)
    }
  }

  const handle = await startBridge({
    home,
    key: randomUUID(),
    dir: "",
    serverUrl: "",
    client: "daemon",
    runAction,
  })
  feed = (t, p) => handle.feedEvent({ type: t, properties: p })

  return {
    dispose: async () => {
      await handle.dispose()
      await claude.stop().catch(() => {})
      await codex.stop().catch(() => {})
    },
  }
}
