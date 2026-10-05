import http from "node:http"
import fs from "node:fs"

const PORT = Number(process.env.TG_MOCK_PORT || 8077)
const TOKEN = process.env.TG_MOCK_TOKEN || "MOCKTOKEN"
const LOG = process.env.TG_MOCK_LOG || "/tmp/tg-mock-log.jsonl"

let nextMsgId = 1000
let nextUpdateId = 1
const queue = []
const waiters = []
const log = []
let failEdits = false
let failSends = false
let conflictUpdates = false

try { fs.writeFileSync(LOG, "") } catch {}

function record(method, params, extra = {}) {
  const entry = { ts: Date.now(), method, params, ...extra }
  log.push(entry)
  try { fs.appendFileSync(LOG, JSON.stringify(entry) + "\n") } catch {}
  return entry
}

function pushUpdate(u) {
  if (!u.update_id) u.update_id = nextUpdateId++
  queue.push(u)
  flushWaiters()
}

function flushWaiters() {
  while (waiters.length && queue.length) {
    const w = waiters.shift()
    clearTimeout(w.timer)
    w.res.end(JSON.stringify({ ok: true, result: [queue.shift()] }))
  }
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" })
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ""
    req.on("data", (c) => (data += c))
    req.on("end", () => resolve(data))
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const p = url.pathname

  if (req.method === "POST" && p === "/__inject") {
    const body = await readBody(req)
    try {
      pushUpdate(JSON.parse(body).update ?? JSON.parse(body))
      json(res, 200, { ok: true })
    } catch (e) {
      json(res, 400, { ok: false, error: String(e) })
    }
    return
  }
  if (req.method === "GET" && p === "/__log") {
    json(res, 200, { ok: true, result: log })
    return
  }
  if (req.method === "POST" && p === "/__reset") {
    log.length = 0
    queue.length = 0
    try { fs.writeFileSync(LOG, "") } catch {}
    json(res, 200, { ok: true })
    return
  }
  if (req.method === "POST" && p === "/__failEdits") {
    const body = await readBody(req)
    let on = true
    try { on = JSON.parse(body).on !== false } catch {}
    failEdits = on
    json(res, 200, { ok: true, failEdits })
    return
  }
  if (req.method === "POST" && p === "/__failSends") {
    const body = await readBody(req)
    let on = true
    try { on = JSON.parse(body).on !== false } catch {}
    failSends = on
    json(res, 200, { ok: true, failSends })
    return
  }
  if (req.method === "POST" && p === "/__conflictUpdates") {
    const body = await readBody(req)
    let on = true
    try { on = JSON.parse(body).on !== false } catch {}
    conflictUpdates = on
    json(res, 200, { ok: true, conflictUpdates })
    return
  }

  if (!p.startsWith(`/bot${TOKEN}/`)) {
    json(res, 401, { ok: false, error_code: 401, description: "Unauthorized" })
    return
  }
  const method = p.slice(`/bot${TOKEN}/`.length)
  const raw = await readBody(req)
  let params = {}
  try { params = raw ? JSON.parse(raw) : {} } catch {}

  if (method === "getUpdates") {
    if (conflictUpdates) {
      record(method, params, { error: "simulated 409 conflict" })
      json(res, 409, { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running" })
      return
    }
    record(method, { offset: params.offset })
    if (queue.length) {
      json(res, 200, { ok: true, result: [queue.shift()] })
      return
    }
    const w = { res, timer: null }
    w.timer = setTimeout(() => {
      const i = waiters.indexOf(w)
      if (i >= 0) waiters.splice(i, 1)
      if (!res.writableEnded) json(res, 200, { ok: true, result: [] })
    }, 1500)
    waiters.push(w)
    req.on("close", () => {
      clearTimeout(w.timer)
      const i = waiters.indexOf(w)
      if (i >= 0) waiters.splice(i, 1)
    })
    return
  }

  if (method === "sendMessage" || method === "editMessageText") {
    const rm = params.reply_markup
    if (rm !== undefined) {
      const valid =
        rm !== null &&
        typeof rm === "object" &&
        !Array.isArray(rm) &&
        (Array.isArray(rm.inline_keyboard) || Array.isArray(rm.keyboard) || Array.isArray(rm.remove_keyboard))
      if (!valid) {
        record(method, params, { error: "Bad Request: object expected as reply markup" })
        json(res, 400, { ok: false, error_code: 400, description: "Bad Request: object expected as reply markup" })
        return
      }
      if (Array.isArray(rm.inline_keyboard)) {
        for (const row of rm.inline_keyboard) {
          if (!Array.isArray(row)) {
            json(res, 400, { ok: false, error_code: 400, description: "Bad Request: inline keyboard rows must be arrays" })
            return
          }
          for (const btn of row) {
            const data = btn?.callback_data
            if (data !== undefined && (typeof data !== "string" || Buffer.byteLength(data, "utf8") > 64)) {
              json(res, 400, { ok: false, error_code: 400, description: "Bad Request: callback_data is 1-64 bytes" })
              return
            }
          }
        }
      }
    }
  }

  if (method === "editMessageText") {
    if (failEdits) {
      record(method, params, { error: "simulated edit failure" })
      json(res, 429, { ok: false, error_code: 429, description: "Too Many Requests: retry after 3" })
      return
    }
    const text = String(params.text ?? "")
    if (!text || text.length > 4096) {
      json(res, 400, { ok: false, error_code: 400, description: "Bad Request: message text must be 1-4096 characters" })
      return
    }
    record(method, params)
    json(res, 200, { ok: true, result: { message_id: params.message_id, chat: { id: params.chat_id }, text: params.text } })
    return
  }

  if (method === "sendMessage") {
    if (failSends) {
      record(method, params, { error: "simulated send failure" })
      json(res, 500, { ok: false, error_code: 500, description: "Internal Server Error" })
      return
    }
    const text = String(params.text ?? "")
    if (!text || text.length > 4096) {
      json(res, 400, { ok: false, error_code: 400, description: "Bad Request: message text must be 1-4096 characters" })
      return
    }
    const r = { message_id: nextMsgId++, date: Math.floor(Date.now() / 1000), chat: { id: params.chat_id }, text: params.text, ...(params.reply_markup ? { reply_markup: params.reply_markup } : {}) }
    record(method, params, { result_message_id: r.message_id })
    json(res, 200, { ok: true, result: r })
    return
  }

  if (method === "sendDocument") {
    const ctype = String(req.headers["content-type"] ?? "")
    const bodyText = raw.toString("utf8")
    const fn = (bodyText.match(/filename="([^"]+)"/) || [])[1] ?? ""
    const hasDoc = bodyText.includes('name="document"')
    if (!ctype.includes("multipart/form-data") || !hasDoc || !fn) {
      record(method, { error: "bad multipart document upload" })
      json(res, 400, { ok: false, error_code: 400, description: "Bad Request: document file missing" })
      return
    }
    const r = { message_id: nextMsgId++, date: Math.floor(Date.now() / 1000), chat: {}, document: { file_name: fn, mime_type: "text/markdown" } }
    record(method, { filename: fn, bytes: Buffer.byteLength(bodyText) })
    json(res, 200, { ok: true, result: r })
    return
  }

  if (method === "getMe") {
    record(method, params)
    json(res, 200, { ok: true, result: { id: 42, is_bot: true, first_name: "MockBot", username: "mock_opencode_bot" } })
    return
  }

  record(method, params)
  json(res, 200, { ok: true, result: true })
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock telegram on 127.0.0.1:${PORT} token=${TOKEN} log=${LOG}`)
})
