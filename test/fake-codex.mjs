#!/usr/bin/env node
// Fake `codex app-server` for raven e2e: newline-delimited JSON-RPC with the
// same method/notification/approval shapes the real 0.160 server emits.
import readline from "node:readline"

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n")
const threads = new Map()
let counter = 0

const rl = readline.createInterface({ input: process.stdin })
rl.on("line", (line) => {
  if (!line.trim().startsWith("{")) return
  let j
  try {
    j = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = j
  if (!method) return
  if (method === "initialize") return send({ id, result: { userAgent: "fake-codex" } })
  if (method === "thread/start") {
    const tid = "thr-" + ++counter
    threads.set(tid, { cwd: params?.cwd || "", turns: [] })
    return send({ id, result: { thread: { id: tid, name: "fake thread " + counter, cwd: params?.cwd || "", updatedAt: Date.now() } } })
  }
  if (method === "thread/list") {
    const items = [...threads.entries()].map(([tid, t]) => ({ id: tid, name: t.name, cwd: t.cwd, updatedAt: Date.now() }))
    return send({ id, result: { threads: items } })
  }
  if (method === "thread/read") {
    const t = threads.get(params?.threadId)
    return send({ id, result: { thread: { id: params?.threadId, cwd: t?.cwd, updatedAt: Date.now(), turns: t?.turns ?? [] } } })
  }
  if (method === "turn/interrupt") return send({ id, result: {} })
  if (method === "turn/start") {
    const tid = params?.threadId
    const text = String(params?.input?.[0]?.text ?? "")
    const t = threads.get(tid)
    send({ method: "turn/started", params: { threadId: tid, turn: { id: "turn-" + ++counter } } })
    const finish = () => {
      const reply = /RUN/.test(text) ? "" : `PONGCX ${params?.model ?? "default"} ok`
      if (reply) {
        send({ method: "item/agentMessage/delta", params: { threadId: tid, itemId: "it1", delta: reply.slice(0, 4) } })
        send({ method: "item/agentMessage/delta", params: { threadId: tid, itemId: "it1", delta: reply.slice(4) } })
        send({ method: "item/completed", params: { threadId: tid, item: { type: "agentMessage", text: reply } } })
        if (t) t.turns.push({ startedAt: Date.now(), items: [{ type: "userMessage", text }, { type: "agentMessage", text: reply }] })
      }
      send({ method: "turn/completed", params: { threadId: tid, turn: { status: "completed" } } })
    }
    if (/RUN/.test(text)) {
      const reqId = "srv-" + ++counter
      send({
        id: reqId,
        method: "item/commandExecution/requestApproval",
        params: { threadId: tid, itemId: "it-cmd", command: ["bash", "-c", "echo " + (text.match(/echo\s+(\S+)/)?.[1] ?? "ran")] },
      })
      const waitRes = (line2) => {
        let k
        try {
          k = JSON.parse(line2)
        } catch {
          return
        }
        if (k.id !== reqId) return
        rl.off("line", waitRes)
        const dec = String(k.result?.decision ?? "decline")
        const reply = dec === "accept" || dec === "acceptForSession" ? "PONGCX approved" : "PONGCX denied"
        send({ method: "item/completed", params: { threadId: tid, item: { type: "agentMessage", text: reply } } })
        if (t) t.turns.push({ startedAt: Date.now(), items: [{ type: "userMessage", text }, { type: "agentMessage", text: reply }] })
        send({ method: "turn/completed", params: { threadId: tid, turn: { status: "completed" } } })
      }
      rl.on("line", waitRes)
      return
    }
    setTimeout(finish, 400)
    return send({ id, result: {} })
  }
  send({ id, error: { code: -32601, message: "fake: unhandled " + method } })
})
