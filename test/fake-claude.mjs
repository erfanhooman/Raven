#!/usr/bin/env node
// Fake `claude` CLI for raven e2e: speaks stream-json, writes transcripts, and
// exercises the PreToolUse HTTP hook exactly like the real CLI does.
import fs from "node:fs"
import path from "node:path"

const args = process.argv.slice(2)
const get = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : ""
}
const isResume = args.includes("--resume")
const settingsFile = get("--settings")
const modelFlag = get("--model")
const permMode = get("--permission-mode")
const projectsRoot = process.env.CLAUDE_PROJECTS_DIR || path.join(process.env.HOME || "/tmp", ".claude", "projects")
const projDir = path.join(projectsRoot, "-raven-e2e")
fs.mkdirSync(projDir, { recursive: true })

let prompt = ""
const stdin = fs.readFileSync(0, "utf8")
for (const line of stdin.split("\n")) {
  try {
    const j = JSON.parse(line)
    if (j.type === "user" || j.type === undefined && j.message) prompt += String(j.message?.content ?? j.text ?? "")
  } catch {}
}
prompt = prompt.trim() || String(args[args.length - 1] ?? "")

const sid = isResume ? get("--resume") : "fake-" + Math.random().toString(16).slice(2, 10)
const fp = path.join(projDir, `${sid}.jsonl`)
const now = Date.now()
const enc = (o) => JSON.stringify(o) + "\n"
fs.appendFileSync(fp, enc({ type: "user", cwd: "/raven-e2e", timestamp: now, uuid: "u" + now, message: { role: "user", content: prompt } }))

const out = (o) => process.stdout.write(enc(o))
out({ type: "system", subtype: "init", session_id: sid })

let decision = "allow"
if (/SHELL/.test(prompt) && settingsFile) {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"))
    const url = settings?.hooks?.PreToolUse?.[0]?.hooks?.[0]?.url
    if (url) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: sid,
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "echo " + (prompt.match(/echo\s+(\S+)/)?.[1] ?? "ran") },
          tool_use_id: "tu_" + now,
          cwd: "/raven-e2e",
        }),
        signal: AbortSignal.timeout(60_000),
      })
      const j = await res.json().catch(() => ({}))
      decision = j?.hookSpecificOutput?.permissionDecision ?? "allow"
    }
  } catch (e) {
    decision = "hook-error:" + String(e?.message ?? e).slice(0, 40)
  }
}

const reply = decision === "allow" ? `PONGCL ${modelFlag || "default"} ${permMode || "default"} ran` : `BLOCKED(${decision})`
const t2 = Date.now()
fs.appendFileSync(fp, enc({ type: "assistant", cwd: "/raven-e2e", timestamp: t2, uuid: "a" + t2, message: { role: "assistant", model: modelFlag || "fake-claude", mode: permMode, content: [{ type: "text", text: reply }] } }))

out({ type: "assistant", message: { role: "assistant", model: modelFlag || "fake-claude", content: [{ type: "text", text: reply }] } })
out({ type: "result", subtype: "success", result: reply, session_id: sid, is_error: false })
