import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const MOCK_PORT = 8077
const OC_PORT = 4173
const PROXY_PORT = 18099
const TOKEN = "MOCKTOKEN"
const CHAT = 999
const STRANGER = 12345
const PASS = "testpw"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "oc-tg-e2e-"))
const CFG = path.join(ROOT, "cfg")
const RAVEN = path.join(ROOT, "raven")
const PROJ = path.join(ROOT, "proj")
const TGLOG = path.join(ROOT, "tglog.jsonl")
const OCLOG = path.join(ROOT, "oc-serve.log")

const children = []
let failed = 0
let passed = 0

function git(args) {
  const r = spawnSync("git", ["-C", PROJ, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`)
  return r.stdout
}

function say(msg) {
  console.log(msg)
}

function cleanup() {
  try {
    proxyServer?.close()
  } catch {}
  for (const c of children) {
    try {
      process.kill(-c.pid, "SIGTERM")
    } catch {
      try {
        c.kill("SIGTERM")
      } catch {}
    }
  }
  setTimeout(() => {
    for (const c of children) {
      try {
        process.kill(-c.pid, "SIGKILL")
      } catch {}
    }
    process.exit(failed ? 1 : 0)
  }, 800)
}

process.on("SIGINT", () => cleanup())
process.on("exit", () => {
  for (const c of children) {
    try {
      c.kill("SIGKILL")
    } catch {}
  }
})

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      lastErr = e
    }
    await sleep(300)
  }
  throw new Error(`timeout waiting for: ${label}${lastErr ? ` (last error: ${lastErr.message})` : ""}`)
}

async function mockLog() {
  const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/__log`)
  return (await r.json()).result
}

async function inject(update) {
  const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/__inject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ update }),
  })
  const j = await r.json()
  if (!j.ok) throw new Error("inject failed: " + JSON.stringify(j))
}

function sendText(text, chat = CHAT) {
  return inject({ message: { chat: { id: chat }, text, from: { id: chat } } })
}

function tap(data, chat = CHAT) {
  return inject({
    callback_query: {
      id: String(Date.now()),
      from: { id: chat },
      data,
      message: { message_id: 900001, chat: { id: chat }, text: "(settings)" },
    },
  })
}

const sleepBrief = (ms) => new Promise((r) => setTimeout(r, ms))

async function expectLog(desc, predicate, timeoutMs = 30000, since = 0) {
  const found = await waitUntil(async () => {
    const log = await mockLog()
    return log.find((e) => e.ts >= since && predicate(e))
  }, timeoutMs, desc)
  say(`  ✔ ${desc}`)
  passed++
  return found
}

async function expectNone(desc, predicate, settleMs = 4000) {
  await sleepBrief(settleMs)
  const log = await mockLog()
  const hit = log.find(predicate)
  if (hit) {
    failed++
    say(`  ✘ ${desc} — FOUND UNEXPECTED: ${JSON.stringify(hit.params).slice(0, 300)}`)
    throw new Error(desc)
  }
  say(`  ✔ ${desc}`)
  passed++
}

function ocAuthHeaders() {
  return { authorization: "Basic " + Buffer.from(`opencode:${PASS}`).toString("base64") }
}

async function ocGet(p) {
  const r = await fetch(`http://127.0.0.1:${OC_PORT}${p}`, { headers: ocAuthHeaders() })
  if (!r.ok) throw new Error(`ocGet ${p} -> ${r.status}`)
  return r.json().catch(() => null)
}

async function ocPost(p, body) {
  const r = await fetch(`http://127.0.0.1:${OC_PORT}${p}`, {
    method: "POST",
    headers: { ...ocAuthHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  })
  if (!r.ok) throw new Error(`ocPost ${p} -> ${r.status}: ${await r.text().catch(() => "")}`)
  return r.status === 204 ? null : r.json().catch(() => null)
}

function readBridgeConfig() {
  return JSON.parse(fs.readFileSync(path.join(RAVEN, "raven.json"), "utf8"))
}

function writeBridgeConfig(patch) {
  const cur = readBridgeConfig()
  fs.writeFileSync(path.join(RAVEN, "raven.json"), JSON.stringify({ ...cur, ...patch }, null, 2))
}

function bridgeLog() {
  try {
    return fs.readFileSync(path.join(RAVEN, "raven.log"), "utf8")
  } catch {
    return ""
  }
}

function readBridgeState() {
  return JSON.parse(fs.readFileSync(path.join(RAVEN, "state.json"), "utf8"))
}

function bridgeOwnerKey() {
  return JSON.parse(fs.readFileSync(path.join(RAVEN, "leader.lock", "owner.json"), "utf8")).key
}

function injectEvent(ev, key, dir) {
  const name = `${String(Date.now()).padStart(15, "0")}-${Math.random().toString(36).slice(2, 8)}.json`
  fs.writeFileSync(
    path.join(RAVEN, "outbox", name),
    JSON.stringify({ t: "event", key, dir, serverUrl: `http://127.0.0.1:${OC_PORT}`, ts: Date.now(), event: ev }),
  )
}

const PROXY_LOG = path.join(ROOT, "proxylog.jsonl")
let proxyServer = null
function startProxy() {
  return new Promise((resolve) => {
    proxyServer = net.createServer((client) => {
      let buf = Buffer.alloc(0)
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk])
        const idx = buf.indexOf("\r\n\r\n")
        if (idx < 0) return
        client.off("data", onData)
        const head = buf.slice(0, idx).toString()
        const rest = buf.slice(idx + 4)
        const m = head.match(/^CONNECT\s+(\S+)\s+HTTP\/\d/i)
        if (!m) {
          try { client.destroy() } catch {}
          return
        }
        const [host, port] = m[1].split(":")
        try {
          fs.appendFileSync(PROXY_LOG, JSON.stringify({ ts: Date.now(), target: `${host}:${port}` }) + "\n")
        } catch {}
        const up = net.connect({ host, port: Number(port) }, () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
          if (rest.length) up.write(rest)
          client.pipe(up)
          up.pipe(client)
        })
        up.on("error", () => {
          try { client.destroy() } catch {}
        })
      }
      client.on("data", onData)
      client.on("error", () => {})
    })
    proxyServer.listen(PROXY_PORT, "127.0.0.1", resolve)
  })
}

function proxyLog() {
  try {
    return fs
      .readFileSync(PROXY_LOG, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

async function setFailEdits(on) {
  const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/__failEdits`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ on }),
  })
  if (!r.ok) throw new Error("setFailEdits failed")
}

async function setFailSends(on) {
  const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/__failSends`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ on }),
  })
  if (!r.ok) throw new Error("setFailSends failed")
}

async function setConflictUpdates(on) {
  const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/__conflictUpdates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ on }),
  })
  if (!r.ok) throw new Error("setConflictUpdates failed")
}

async function main() {
  say(`workspace: ${ROOT}`)
  fs.mkdirSync(path.join(CFG, "plugins"), { recursive: true })
  fs.mkdirSync(RAVEN, { recursive: true })
  fs.mkdirSync(PROJ, { recursive: true })
  fs.copyFileSync(path.join(REPO, "dist", "raven-plugin.js"), path.join(CFG, "plugins", "raven.js"))
  fs.writeFileSync(
    path.join(RAVEN, "raven.json"),
    JSON.stringify(
      {
        enabled: true,
        botToken: TOKEN,
        authorizedChatIds: [],
        apiBase: `http://127.0.0.1:${MOCK_PORT}`,
        botName: "Raven",
        proxy: "",
        pairing: { ownerApprove: false },
        notify: { idle: true, error: true, permission: true, question: true, session: false },
        relay: true,
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(
    path.join(PROJ, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", permission: { bash: "ask" } }, null, 2),
  )
  fs.mkdirSync(path.join(PROJ, ".opencode", "command"), { recursive: true })
  fs.writeFileSync(path.join(PROJ, ".opencode", "command", "skipme.md"), "Reply with exactly the word SKIPME_RAN and nothing else.\n")
  git(["init", "-q", "-b", "main"])
  git(["config", "user.email", "e2e@test.local"])
  git(["config", "user.name", "e2e"])
  fs.writeFileSync(path.join(PROJ, "README.md"), "e2e workspace\n")
  git(["add", "-A"])
  git(["commit", "-qm", "init"])
  git(["branch", "dev"])

  say("starting mock telegram...")
  const mock = spawn("node", [path.join(REPO, "test", "mock-telegram.mjs")], {
    env: { ...process.env, TG_MOCK_PORT: String(MOCK_PORT), TG_MOCK_TOKEN: TOKEN, TG_MOCK_LOG: TGLOG },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })
  children.push(mock)
  mock.stdout.on("data", (d) => process.stdout.write(`  [mock] ${d}`))
  mock.stderr.on("data", (d) => process.stderr.write(`  [mock:err] ${d}`))

  await waitUntil(async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/__log`).then((r) => r.ok).catch(() => false)), 10000, "mock telegram up")

  say("starting opencode serve...")
  const oc = spawn("opencode", ["serve", "--port", String(OC_PORT)], {
    cwd: PROJ,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(ROOT, "xdg"),
      OPENCODE_CONFIG_DIR: CFG,
      RAVEN_HOME: RAVEN,
      OPENCODE_DB: path.join(ROOT, "oc.db"),
      OPENCODE_SERVER_PASSWORD: PASS,
      OPENCODE_CLIENT: "cli",
      OPENCODE_LOG_LEVEL: "DEBUG",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })
  children.push(oc)
  oc.stdout.on("data", (d) => fs.appendFileSync(OCLOG, d))
  oc.stderr.on("data", (d) => fs.appendFileSync(OCLOG, d))

  say("waiting for opencode server...")
  await waitUntil(
    async () => {
      const r = await fetch(`http://127.0.0.1:${OC_PORT}/global/health`, { headers: ocAuthHeaders() })
      return r.ok
    },
    60000,
    "opencode /global/health",
  )
  say("  ✔ server healthy")

  await ocGet(`/session?directory=${encodeURIComponent(PROJ)}`).catch(() => null)

  say("waiting for bridge plugin init + leadership...")
  await waitUntil(async () => bridgeLog().includes("acquired leadership"), 30000, "bridge leadership")
  say("  ✔ bridge is leader")

  const bInit = bridgeLog().split("\n").find((l) => l.includes("init ")) || ""
  say(`  ${bInit.trim()}`)

  const mark = "═══"

  say(`${mark} TEST 1: pairing — unpaired chats are refused; code pairs`)
  const t1 = Date.now() - 500
  await sendText("/start")
  const helpMsg = await expectLog(
    "unpaired /start gets pairing instructions",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("isn't paired") && String(e.params.text).includes("/pair"),
    20000,
    t1,
  )
  const pairReq1 = await waitUntil(async () => readBridgeState().pairing, 10000, "pairing request in state")
  if (pairReq1 && /^[A-HJ-KM-NP-Z2-9]{6}$/i.test(pairReq1.code)) {
    passed++
    say("  ✔ 6-character pairing code generated")
  } else {
    failed++
    say(`  ✘ bad pairing code: ${JSON.stringify(pairReq1)}`)
  }
  if (pairReq1 && !String(helpMsg.params.text).includes(pairReq1.code)) {
    passed++
    say("  ✔ pairing code never sent over Telegram (computer-only)")
  } else {
    failed++
    say("  ✘ pairing code leaked into the Telegram pairing message")
    throw new Error("pairing code leak")
  }
  const t1w = Date.now() - 500
  await sendText("/pair XXXXXX")
  await expectLog(
    "wrong code rejected",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("Wrong code"),
    20000,
    t1w,
  )
  const t1p = Date.now() - 500
  await sendText(`/pair ${pairReq1.code}`)
  await expectLog(
    "correct code pairs the chat",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("Paired!"),
    20000,
    t1p,
  )
  await expectLog(
    "setMyName called on real Telegram profile",
    (e) => e.method === "setMyName" && String(e.params.name ?? "").includes("Raven"),
    20000,
    t1p,
  )
  await expectLog(
    "home panel sent after pairing",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("🏠") && String(e.params.text).includes("No session focused"),
    20000,
    t1p,
  )
  const cfgAfter = readBridgeConfig()
  if (Array.isArray(cfgAfter.authorizedChatIds) && cfgAfter.authorizedChatIds.includes(CHAT)) {
    passed++
    say("  ✔ chat id whitelisted in config")
  } else {
    failed++
    say(`  ✘ config not updated: ${JSON.stringify(cfgAfter.authorizedChatIds)}`)
  }
  if (!readBridgeState().pairing) {
    passed++
    say("  ✔ pairing request cleared after success")
  } else {
    failed++
    say("  ✘ pairing request left dangling")
  }


  say(`${mark} TEST 2: home panel + persistent menu keyboard`)
  const t2 = Date.now() - 500
  await sendText("/start")
  const home2 = await expectLog(
    "home panel sent fresh with navigation buttons (visible reply)",
    (e) =>
      e.method === "sendMessage" &&
      String(e.params.text).includes("🏠") &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("s:sessions"),
    20000,
    t2,
  )
  if (
    String(home2.params.text).includes("History") ||
    String(home2.params.text).includes("📜") ||
    JSON.stringify(home2.params.reply_markup ?? {}).includes("s:hist")
  ) {
    failed++
    say("  ✘ Home still exposes the removed History concept")
  } else {
    passed++
    say("  ✔ Home has no History")
  }
  await expectLog(
    "menu keyboard attached once",
    (e) => e.method === "sendMessage" && Array.isArray(e.params.reply_markup?.keyboard),
    30000,
    0,
  )
  await expectLog(
    "/start always re-sends a visible menu message",
    (e) =>
      e.method === "sendMessage" &&
      String(e.params.text).includes("🎛 Options below") &&
      Array.isArray(e.params.reply_markup?.keyboard),
    20000,
    t2,
  )

  say(`${mark} TEST 3: new session via project picker`)
  const t3 = Date.now() - 500
  await sendText("➕ New")
  const pickerMsg = await expectLog(
    "project picker shown",
    (e) =>
      e.method === "sendMessage" &&
      String(e.params.text).includes("pick a project") &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("s:newdir:"),
    20000,
    t3,
  )
  const newdirData = JSON.stringify(pickerMsg.params.reply_markup.inline_keyboard).match(/s:newdir:\d+/)?.[0]
  if (!newdirData) {
    failed++
    say("  ✘ no project button in picker")
    throw new Error("no newdir button")
  }
  passed++
  say(`  ✔ project button: ${newdirData}`)
  const t3b = Date.now() - 500
  await tap(newdirData)
  await expectLog(
    "title prompt",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("Name the new session"),
    20000,
    t3b,
  )
  const t3c = Date.now() - 500
  await sendText("e2e")
  await expectLog(
    "session workspace panel with focus",
    (e) =>
      e.method === "editMessageText" &&
      String(e.params.text).includes("💬 e2e") &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("s:more:"),
    30000,
    t3c,
  )
  const t3d = Date.now() - 500
  await sendText("🏠 Home")
  await expectLog(
    "home shows focused session",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("🏠 e2e"),
    20000,
    t3d,
  )

  say(`${mark} TEST 4: prompt -> one live card -> relay edit`)
  const t4 = Date.now() - 500
  await sendText("Reply with exactly the word PONG and nothing else.")
  const cardMsg = await expectLog(
    "turn card created",
    (e) =>
      e.method === "sendMessage" &&
      e.params.chat_id === CHAT &&
      String(e.params.text).includes("💬 e2e") &&
      (String(e.params.text).includes("working") || String(e.params.text).includes("sending")),
    20000,
    t4,
  )
  const cardId = cardMsg.result_message_id ?? cardMsg.params.message_id
  if (JSON.stringify(cardMsg.params.reply_markup ?? {}).includes("s:abort:")) {
    passed++
    say("  ✔ live card carries a Stop button while running")
  } else {
    failed++
    say("  ✘ live card missing Stop button")
  }
  await expectLog(
    "card streams the assistant's answer tail (🤖 text only)",
    (e) => e.method === "editMessageText" && e.params.message_id === cardId && String(e.params.text).includes("🤖"),
    120000,
    t4,
  )
  await expectLog(
    "relay edits the same card on idle",
    (e) => e.method === "editMessageText" && e.params.message_id === cardId && /✅.*finished/s.test(String(e.params.text)) && String(e.params.text).includes("PONG"),
    120000,
    t4,
  )

  say(`${mark} TEST 5: permission -> inbox -> approve from inbox card`)
  const t5 = Date.now() - 500
  await sendText("Use the bash tool to run exactly: echo HELLOBASH")
  const permMsg = await expectLog(
    "permission.asked notification with buttons",
    (e) =>
      e.method === "sendMessage" &&
      e.params.chat_id === CHAT &&
      String(e.params.text).includes("Permission needed") &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("p:per_"),
    60000,
    t5,
  )
  const t5b = Date.now() - 500
  await sendText("📥 Inbox")
  const inboxMsg = await expectLog(
    "inbox lists the pending approval",
    (e) =>
      e.method === "sendMessage" &&
      String(e.params.text).includes("📥 Inbox") &&
      String(e.params.text).includes("🔐") &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("s:req:p:"),
    20000,
    t5b,
  )
  const reqData = JSON.stringify(inboxMsg.params.reply_markup.inline_keyboard).match(/s:req:p:[^"\\]+/)?.[0]
  if (!reqData) {
    failed++
    say("  ✘ no request button in inbox")
    throw new Error("no inbox req button")
  }
  passed++
  say(`  ✔ inbox request button: ${reqData.slice(0, 24)}…`)
  const t5c = Date.now() - 500
  await tap(reqData)
  const itemMsg = await expectLog(
    "inbox item shows the approval card",
    (e) =>
      e.method === "editMessageText" &&
      String(e.params.text).includes("Permission needed") &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("p:per_"),
    20000,
    t5c,
  )
  const permData = JSON.stringify(itemMsg.params.reply_markup).match(/p:per_[^"\\]+:once/)?.[0]
  if (!permData) {
    failed++
    say("  ✘ could not extract callback data")
    throw new Error("no callback data")
  }
  passed++
  say(`  ✔ callback data: ${permData}`)
  const t5d = Date.now() - 500
  await tap(permData)
  await expectLog(
    "approval edit",
    (e) => e.method === "editMessageText" && String(e.params.text).includes("allowed once"),
    20000,
    t5d,
  )
  await expectLog(
    "callback acknowledged",
    (e) => e.method === "answerCallbackQuery",
    20000,
    t5d,
  )
  await expectLog(
    "bash output relayed after approval",
    (e) =>
      e.method === "editMessageText" &&
      String(e.params.text).includes("finished") &&
      String(e.params.text).includes("HELLOBASH"),
    120000,
    t5d,
  )

  say(`${mark} TEST 6: question prompt -> answer from telegram`)
  await sendText(
    "Use the question tool to ask exactly one question. Question text: favorite color? Header: Color. Options: Red and Blue. Do not ask anything else. After you get the answer, reply with exactly QUESTION_DONE.",
  )
  const qMsg = await expectLog(
    "question.asked notification with buttons",
    (e) =>
      e.method === "sendMessage" &&
      e.params.chat_id === CHAT &&
      String(e.params.text).includes("❓") &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("qa:que_"),
    90000,
  )
  const qData = JSON.stringify(qMsg.params.reply_markup).match(/qa:que_[^"\\]+:\d+:\d+/)?.[0]
  if (!qData) {
    failed++
    say("  ✘ could not extract question callback data")
    throw new Error("no question callback data")
  }
  passed++
  say(`  ✔ callback data: ${qData}`)
  const t6 = Date.now() - 500
  await tap(qData)
  await expectLog(
    "question answered edit",
    (e) => e.method === "editMessageText" && String(e.params.text).includes("answered"),
    20000,
    t6,
  )
  await expectLog(
    "QUESTION_DONE relay edits the turn card",
    (e) =>
      e.method === "editMessageText" &&
      String(e.params.text).includes("finished") &&
      String(e.params.text).includes("QUESTION_DONE"),
    120000,
    t6,
  )

  say(`${mark} TEST 7: unpaired chats get pairing help, nothing else`)
  const t7 = Date.now() - 500
  await inject({ message: { chat: { id: STRANGER }, text: "/start", from: { id: STRANGER } } })
  await expectLog(
    "unpaired /start gets a code, not the app",
    (e) => e.method === "sendMessage" && e.params.chat_id === STRANGER && String(e.params.text).includes("isn't paired"),
    20000,
    t7,
  )
  await sleepBrief(1200)
  const t7b = Date.now()
  await inject({ message: { chat: { id: STRANGER }, text: "what sessions do I have?", from: { id: STRANGER } } })
  await expectNone(
    "no data leak to unpaired chat",
    (e) => e.ts >= t7b && (e.method === "sendMessage" || e.method === "editMessageText") && e.params.chat_id === STRANGER,
    4000,
  )

  say(`${mark} TEST 8: sessions screen grouped by project`)
  const t8 = Date.now() - 500
  await sendText("📚 Sessions")
  await expectLog(
    "project-grouped sessions panel",
    (e) =>
      e.method === "sendMessage" &&
      String(e.params.text).includes("📚 Sessions") &&
      String(e.params.text).includes("e2e") &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("s:session:"),
    30000,
    t8,
  )

  say(`${mark} TEST 9: tap session -> workspace + focus, then Home`)
  const t9 = Date.now() - 500
  await sendText("📚 Sessions")
  const listMsg9 = await expectLog(
    "sessions panel for tapping",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("📚 Sessions"),
    30000,
    t9,
  )
  const openData = JSON.stringify(listMsg9.params.reply_markup.inline_keyboard).match(/s:session:ses_[A-Za-z0-9]+/)?.[0]
  if (!openData) {
    failed++
    say("  ✘ no session button in sessions panel")
    throw new Error("no session button")
  }
  passed++
  say(`  ✔ session button: ${openData.slice(0, 24)}…`)
  const t9b = Date.now() - 500
  await tap(openData)
  await expectLog(
    "workspace panel sets focus",
    (e) =>
      e.method === "editMessageText" &&
      String(e.params.text).includes("💬 e2e") &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("s:more:"),
    20000,
    t9b,
  )
  const t9c = Date.now() - 500
  await sendText("🏠 Home")
  await expectLog(
    "home shows focused session",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("🏠 e2e"),
    20000,
    t9c,
  )

  say(`${mark} TEST 10: detail new format + tasks screen`)
  const t10a = Date.now() - 500
  await sendText("📚 Sessions")
  const listMsg10 = await expectLog(
    "sessions panel again",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("📚 Sessions"),
    30000,
    t10a,
  )
  const openData10 = JSON.stringify(listMsg10.params.reply_markup.inline_keyboard).match(/s:session:ses_[A-Za-z0-9]+/)?.[0]
  const t10b = Date.now() - 500
  await tap(openData10)
  const wsMsg = await expectLog(
    "workspace new format",
    (e) =>
      e.method === "editMessageText" &&
      String(e.params.text).includes("💬 e2e") &&
      String(e.params.text).includes("🛠 build") &&
      String(e.params.text).includes("🌿 main"),
    20000,
    t10b,
  )
  if (String(wsMsg.params.text).includes("🤖 agent:") || String(wsMsg.params.text).includes("🧠 opencode")) {
    failed++
    say("  ✘ workspace still shows old agent/appName lines")
    throw new Error("workspace old format")
  }
  passed++
  say("  ✔ workspace shows model + build/plan + git branch instead of app name")
  const kb10 = JSON.stringify(wsMsg.params.reply_markup.inline_keyboard)
  const convData = kb10.match(/s:conv:ses_[A-Za-z0-9]+:0/)?.[0]
  const modelData = kb10.match(/s:model:ses_[A-Za-z0-9]+/)?.[0]
  const modeData = kb10.match(/s:mode:ses_[A-Za-z0-9]+/)?.[0]
  const tasksData = kb10.match(/s:tasks:ses_[A-Za-z0-9]+/)?.[0]
  const cmdData = kb10.match(/s:cmds:ses_[A-Za-z0-9]+/)?.[0]
  const moreData = kb10.match(/s:more:ses_[A-Za-z0-9]+/)?.[0]
  if (!convData || !modelData || !modeData || !tasksData || !cmdData || !moreData) {
    failed++
    say("  ✘ workspace missing new action buttons")
    throw new Error("workspace buttons missing")
  }
  passed++
  say("  ✔ workspace has Conversation/Model/Mode/Tasks/Command/More")
  const t10e = Date.now() - 500
  await tap(tasksData)
  await expectLog(
    "tasks screen",
    (e) => e.method === "editMessageText" && String(e.params.text).includes("Tasks"),
    20000,
    t10e,
  )

  say(`${mark} TEST 11: more + model picker + mode toggle + commands (incl. /skip + typed slash)`)
  const t11m = Date.now() - 500
  await tap(moreData)
  await expectLog(
    "more shows empty subagents state",
    (e) =>
      e.method === "editMessageText" &&
      String(e.params.text).includes("No subagents") &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("s:session:"),
    20000,
    t11m,
  )
  const t11d = Date.now() - 500
  await tap(openData10)
  const wsMsg11 = await expectLog(
    "workspace again for pickers",
    (e) => e.method === "editMessageText" && String(e.params.text).includes("💬 e2e"),
    20000,
    t11d,
  )
  const kb11 = JSON.stringify(wsMsg11.params.reply_markup.inline_keyboard)
  const mdlData = kb11.match(/s:model:ses_[A-Za-z0-9]+/)?.[0]
  const modeBtnData = kb11.match(/s:mode:ses_[A-Za-z0-9]+/)?.[0]
  const cmData = kb11.match(/s:cmds:ses_[A-Za-z0-9]+/)?.[0]
  if (!mdlData || !modeBtnData || !cmData) {
    failed++
    say("  ✘ detail missing picker buttons")
    throw new Error("picker buttons missing")
  }
  passed++
  say("  ✔ detail has Model/Mode/Command buttons")
  const t11pl = Date.now() - 500
  await tap(modeBtnData)
  await expectLog(
    "mode toggles build -> plan",
    (e) => e.method === "editMessageText" && String(e.params.text).includes("💬 e2e") && String(e.params.text).includes("📋 plan"),
    20000,
    t11pl,
  )
  injectEvent(
    {
      type: "session.updated",
      properties: { info: { id: openData10.replace(/^s:session:/, ""), title: "e2e", directory: PROJ, agent: "build", time: { updated: Date.now() } } },
    },
    bridgeOwnerKey(),
    PROJ,
  )
  await sleepBrief(1500)
  const stPin11 = readBridgeState().sessions[openData10.replace(/^s:session:/, "")]
  if (stPin11?.agent === "plan" && stPin11?.agentPinned === true) {
    passed++
    say("  ✔ plan pin survives desktop session.updated clobber")
  } else {
    failed++
    say(`  ✘ plan pin was clobbered: ${JSON.stringify({ agent: stPin11?.agent, pinned: stPin11?.agentPinned })}`)
  }
  const t11pb = Date.now() - 500
  await tap(modeBtnData)
  await expectLog(
    "mode toggles plan -> build",
    (e) => e.method === "editMessageText" && String(e.params.text).includes("💬 e2e") && String(e.params.text).includes("🛠 build"),
    20000,
    t11pb,
  )
  const t11mo = Date.now() - 500
  await tap(mdlData)
  await expectLog(
    "model picker lists real models grouped by provider",
    (e) =>
      e.method === "editMessageText" &&
      /Pick the model/i.test(String(e.params.text)) &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("s:mpick:"),
    20000,
    t11mo,
  )
  const t11back = Date.now() - 500
  await tap(`s:session:${openData10.replace(/^s:session:/, "")}`)
  await expectLog(
    "back to workspace from model picker",
    (e) => e.method === "editMessageText" && String(e.params.text).includes("💬 e2e"),
    20000,
    t11back,
  )
  const t11cm = Date.now() - 500
  await tap(cmData)
  const cmdsMsg = await expectLog(
    "commands picker renders opencode commands",
    (e) =>
      e.method === "editMessageText" &&
      /command/i.test(String(e.params.text)) &&
      String(e.params.text).includes("skipme"),
    20000,
    t11cm,
  )
  const skipmeRow = (cmdsMsg.params.reply_markup?.inline_keyboard ?? []).find(
    (r) => Array.isArray(r) && String(r[0]?.text ?? "").includes("skipme"),
  )
  const cmdBtn = skipmeRow?.[0]?.callback_data ?? ""
  if (!cmdBtn.startsWith("s:cmd:")) {
    failed++
    say("  ✘ skipme command button not found in picker")
    throw new Error("no skipme command button")
  }
  passed++
  say(`  ✔ skipme command button: ${cmdBtn}`)
  const t11args = Date.now() - 500
  await tap(cmdBtn)
  await expectLog(
    "asks for command arguments",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("Arguments for /skipme") && String(e.params.text).includes("/skip"),
    20000,
    t11args,
  )
  const t11skip = Date.now() - 500
  await sendText("/skip")
  await expectLog(
    "/skip runs the command with no arguments",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("/skipme") && String(e.params.text).includes("SKIPME_RAN"),
    60000,
    t11skip,
  )
  const t11typed = Date.now() - 500
  await sendText("/skipme typed arguments here")
  await expectLog(
    "typing /command runs it directly on the focused session",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("/skipme") && String(e.params.text).includes("SKIPME_RAN"),
    60000,
    t11typed,
  )

  say(`${mark} TEST 10b: second turn -> permission -> relay edits card`)
  await sleepBrief(5000)
  const t10z = Date.now() - 1000
  await sendText("Run exactly: echo SECONDASH")
  const permCard12 = await expectLog(
    "second permission asked",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("Permission needed"),
    60000,
    t10z,
  )
  const perm2 = permCard12
  const perm2Data = JSON.stringify(perm2.params.reply_markup).match(/p:per_[^"\\]+:once/)?.[0]
  await tap(perm2Data)
  await expectLog(
    "second approval",
    (e) => e.method === "editMessageText" && String(e.params.text).includes("allowed once"),
    20000,
    t10z,
  )
  await expectLog(
    "second idle relay edits card",
    (e) => e.method === "editMessageText" && String(e.params.text).includes("SECONDASH") && String(e.params.text).includes("finished"),
    120000,
    t10z,
  )
  passed++
  say("  ✔ finished notification counted")

  say(`${mark} TEST 11: dual instance — single poller + cross-instance events`)
  const PROJ2 = path.join(ROOT, "proj2")
  fs.mkdirSync(PROJ2, { recursive: true })
  fs.writeFileSync(
    path.join(PROJ2, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2),
  )
  const oc2log = path.join(ROOT, "oc-serve2.log")
  const oc2 = spawn("opencode", ["serve", "--port", "4174"], {
    cwd: PROJ2,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(ROOT, "xdg"),
      OPENCODE_CONFIG_DIR: CFG,
      RAVEN_HOME: RAVEN,
      OPENCODE_DB: path.join(ROOT, "oc2.db"),
      OPENCODE_SERVER_PASSWORD: PASS,
      OPENCODE_CLIENT: "cli",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })
  children.push(oc2)
  oc2.stdout.on("data", (d) => fs.appendFileSync(oc2log, d))
  oc2.stderr.on("data", (d) => fs.appendFileSync(oc2log, d))

  await waitUntil(
    async () => {
      const r = await fetch(`http://127.0.0.1:4174/global/health`, { headers: ocAuthHeaders() })
      return r.ok
    },
    60000,
    "second opencode server healthy",
  )
  say("  ✔ second server healthy")
  await fetch(`http://127.0.0.1:4174/session?directory=${encodeURIComponent(PROJ2)}`, { headers: ocAuthHeaders() }).catch(() => null)
  await waitUntil(async () => bridgeLog().split("\n").filter((l) => l.includes(" init ")).length >= 2, 30000, "second bridge instance init")
  say("  ✔ second bridge instance init")
  await sleepBrief(3000)

  const t11 = Date.now() - 500
  await sendText("🏠 Home")
  await expectLog(
    "home panel sent fresh (no duplicate poller)",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("🏠"),
    20000,
    t11,
  )
  await sleepBrief(6000)
  const homes = (await mockLog()).filter((e) => e.ts >= t11 && e.method === "sendMessage" && String(e.params.text).includes("🏠"))
  if (homes.length === 1) {
    passed++
    say("  ✔ exactly one poller (1 home panel message)")
  } else {
    failed++
    say(`  ✘ expected 1 home panel message, got ${homes.length}`)
  }

  const t11b = Date.now() - 500
  const sess2 = await fetch(`http://127.0.0.1:4174/session?directory=${encodeURIComponent(PROJ2)}`, {
    method: "POST",
    headers: { ...ocAuthHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ title: "cross" }),
  }).then((r) => r.json())
  if (!sess2?.id) {
    failed++
    say("  ✘ could not create session on second instance")
    throw new Error("session create on instance 2 failed")
  }
  passed++
  say(`  ✔ session created on instance 2: ${sess2.id}`)
  await fetch(`http://127.0.0.1:4174/session/${sess2.id}/prompt_async?directory=${encodeURIComponent(PROJ2)}`, {
    method: "POST",
    headers: { ...ocAuthHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: "Reply with exactly the word CROSSOK and nothing else." }] }),
  })
  await expectLog(
    "cross-instance idle notification",
    (e) =>
      e.method === "sendMessage" &&
      e.params.chat_id === CHAT &&
      String(e.params.text).includes("finished") &&
      String(e.params.text).includes("cross"),
    120000,
    t11b,
  )

  if (!bridgeLog().includes("did not respond")) {
    passed++
    say("  ✔ reconcile round-trips succeeded (no deadlock)")
  } else {
    failed++
    say("  ✘ reconcile timed out — drain/ack deadlock present")
  }

  const t11c = Date.now() - 500
  await sendText("📚 Sessions")
  const listMsg11 = await expectLog(
    "sessions panel includes cross-project session",
    (e) =>
      e.method === "sendMessage" &&
      String(e.params.text).includes("📚 Sessions") &&
      String(e.params.text).includes("cross"),
    30000,
    t11c,
  )
  const crossRow = (listMsg11.params.reply_markup?.inline_keyboard ?? []).find(
    (r) => Array.isArray(r) && String(r[0]?.text ?? "").includes("cross"),
  )
  if (!crossRow) {
    failed++
    say("  ✘ no session button for cross session")
    throw new Error("no cross session button")
  }
  passed++
  say(`  ✔ cross session button: ${crossRow[0].callback_data.slice(0, 24)}…`)
  const t11x = Date.now() - 500
  await tap(crossRow[0].callback_data)
  await expectLog(
    "tapping focuses cross session workspace",
    (e) => e.method === "editMessageText" && String(e.params.text).includes("💬 cross"),
    20000,
    t11x,
  )
  const t11e = Date.now() - 500
  await sendText("Reply with exactly the word CROSSOK and nothing else.")
  await expectLog(
    "turn card created for cross session",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("💬 cross"),
    20000,
    t11e,
  )
  await expectLog(
    "cross-instance relay edits the card",
    (e) =>
      e.method === "editMessageText" &&
      String(e.params.text).includes("finished") &&
      String(e.params.text).includes("CROSSOK"),
    120000,
    t11e,
  )

  try {
    process.kill(-oc2.pid, "SIGTERM")
  } catch {
    try {
      oc2.kill("SIGTERM")
    } catch {}
  }
  await sleepBrief(1000)

  say(`${mark} TEST 12: settings screen + notify toggles, no name/desc`)
  const t12 = Date.now() - 500
  await sendText("⚙️ Settings")
  const settingsMsg = await expectLog(
    "settings panel with toggles",
    (e) =>
      e.method === "sendMessage" &&
      String(e.params.text).includes("⚙️ Settings") &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("s:set:idle"),
    20000,
    t12,
  )
  const toggleData = JSON.stringify(settingsMsg.params.reply_markup.inline_keyboard).match(/s:set:idle/)?.[0]
  if (!toggleData) {
    failed++
    say("  ✘ no toggle button in settings")
    throw new Error("no settings toggle")
  }
  passed++
  say("  ✔ notify toggle present")
  const t12b = Date.now() - 500
  await tap(toggleData)
  await expectLog(
    "toggle flips Finished off",
    (e) =>
      e.method === "editMessageText" &&
      String(e.params.text).includes("Settings") &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("⬜ Finished"),
    20000,
    t12b,
  )
  if (readBridgeConfig().notify?.idle !== false) {
    failed++
    say("  ✘ toggle did not persist to config")
  } else {
    passed++
    say("  ✔ toggle persisted to config")
  }
  const t12c = Date.now() - 500
  await tap(toggleData)
  await expectLog(
    "toggle flips Finished back on",
    (e) =>
      e.method === "editMessageText" &&
      String(e.params.text).includes("Settings") &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("✅ Finished"),
    20000,
    t12c,
  )
  const settingsKb = JSON.stringify(settingsMsg.params.reply_markup ?? {})
  if (settingsKb.includes("cfg:name") || settingsKb.includes("cfg:desc")) {
    failed++
    say("  ✘ settings still exposes name/description editing")
  } else {
    passed++
    say("  ✔ settings has no name/description editing")
  }
  if (String(settingsMsg.params.text).includes("Bot:")) {
    failed++
    say("  ✘ settings still shows bot name/description")
  } else {
    passed++
    say("  ✔ settings shows no bot name/description")
  }

  say(`${mark} TEST 13: subagent sessions nest under parent`)
  const parentS = await ocPost(`/session?directory=${encodeURIComponent(PROJ)}`, { title: "parent-cls" })
  const childS = await ocPost(`/session?directory=${encodeURIComponent(PROJ)}`, {
    title: "child-sub",
    parentID: parentS.id,
  })
  if (parentS?.id && childS?.id) {
    passed++
    say(`  ✔ parent + subagent sessions created`)
  } else {
    failed++
    say("  ✘ could not create parent/child sessions")
    throw new Error("parent/child create failed")
  }
  const t13 = Date.now() - 500
  await sendText("📚 Sessions")
  const listMsg13 = await expectLog(
    "list shows parent session",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("parent-cls"),
    30000,
    t13,
  )
  const listText13 = String(listMsg13.params.text)
  if (listText13.includes("child-sub")) {
    failed++
    say("  ✘ subagent leaked into the top-level list")
  } else {
    passed++
    say("  ✔ subagent hidden from top-level list")
  }
  if (listText13.includes("↳1")) {
    passed++
    say("  ✔ parent shows ↳1 sub count")
  } else {
    failed++
    say(`  ✘ missing subagent count — got: ${listText13.slice(0, 240)}`)
  }

  say(`${mark} TEST 14: detail format + conversation + transcript + per-prompt revert + readonly subagents`)
  const t14 = Date.now() - 500
  await sendText("📚 Sessions")
  const listMsg14 = await expectLog(
    "panel sessions list with session buttons",
    (e) =>
      e.method === "sendMessage" &&
      String(e.params.text).includes("📚 Sessions") &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("s:session:"),
    30000,
    t14,
  )
  const rows14 = listMsg14.params.reply_markup?.inline_keyboard ?? []
  const e2eRow = rows14.find((r) => Array.isArray(r) && String(r[0]?.text ?? "").includes("e2e"))
  const parentRow = rows14.find((r) => Array.isArray(r) && String(r[0]?.text ?? "").includes("parent-cls"))
  if (!e2eRow || !parentRow) {
    failed++
    say("  ✘ missing session buttons for e2e/parent sessions")
    throw new Error("no session buttons")
  }
  passed++
  say(`  ✔ session buttons found`)
  const t14b = Date.now() - 500
  await tap(e2eRow[0].callback_data)
  const detailMsg = await expectLog(
    "detail new format with 6 buttons",
    (e) =>
      e.method === "editMessageText" &&
      String(e.params.text).includes("💬 e2e") &&
      String(e.params.text).includes("🛠 build") &&
      String(e.params.text).includes("🌿 main") &&
      String(e.params.text).includes("Type here to continue this session.") &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("s:conv:"),
    20000,
    t14b,
  )
  const kb14 = JSON.stringify(detailMsg.params.reply_markup.inline_keyboard)
  for (const needle of ["s:conv:", "s:model:", "s:mode:", "s:tasks:", "s:cmds:", "s:more:"]) {
    if (!kb14.includes(needle)) {
      failed++
      say(`  ✘ detail missing button ${needle}`)
      throw new Error("detail buttons missing")
    }
  }
  passed++
  say("  ✔ detail has Conversation/Model/Mode/Tasks/Command/More")
  const convData14 = kb14.match(/s:conv:ses_[A-Za-z0-9]+:0/)?.[0]
  const t14c = Date.now() - 500
  await tap(convData14)
  await expectLog(
    "conversation lists user prompts",
    (e) =>
      e.method === "editMessageText" &&
      String(e.params.text).includes("Conversation — e2e") &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("s:convpick:"),
    20000,
    t14c,
  )
  const t14d = Date.now() - 500
  await tap("s:convpick:0")
  const exchMsg = await expectLog(
    "exchange view with transcript + revert buttons",
    (e) =>
      e.method === "editMessageText" &&
      String(e.params.text).includes("👤 You:") &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("s:convfile:0") &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("s:convrvert:0"),
    20000,
    t14d,
  )
  void exchMsg
  const t14e = Date.now() - 500
  await tap("s:convfile:0")
  const loadMsg = await expectLog(
    "transcript shows a building status first",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("Building transcript"),
    20000,
    t14e,
  )
  await expectLog(
    "transcript sent as markdown file",
    (e) => e.method === "sendDocument" && String(e.params.filename ?? "").endsWith(".md"),
    20000,
    t14e,
  )
  await expectLog(
    "building status message updates once the file lands",
    (e) => e.method === "editMessageText" && e.params.message_id === loadMsg.result_message_id && String(e.params.text).includes("Transcript sent"),
    20000,
    t14e,
  )
  const t14f = Date.now() - 500
  await tap("s:convrvert:0")
  await expectLog(
    "revert asks for confirmation",
    (e) =>
      e.method === "editMessageText" &&
      String(e.params.text).includes("Revert") &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("s:convdo:0"),
    20000,
    t14f,
  )
  const t14g = Date.now() - 500
  await tap("s:convdo:0")
  await expectLog(
    "revert executes",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("↩️ Reverted"),
    30000,
    t14g,
  )
  const t14h = Date.now() - 500
  await tap(parentRow[0].callback_data)
  await expectLog(
    "parent detail for More screen",
    (e) => e.method === "editMessageText" && String(e.params.text).includes("💬 parent-cls"),
    20000,
    t14h,
  )
  const t14i = Date.now() - 500
  const parentSid = parentRow[0].callback_data.replace(/^s:session:/, "")
  await tap(`s:more:${parentSid}`)
  const moreMsg = await expectLog(
    "more shows readonly subagents",
    (e) =>
      e.method === "editMessageText" &&
      String(e.params.text).includes("Subagents of parent-cls") &&
      String(e.params.text).includes("child-sub"),
    20000,
    t14i,
  )
  if (JSON.stringify(moreMsg.params.reply_markup ?? {}).includes("Open child-sub")) {
    failed++
    say("  ✘ subagent has an open button (must be readonly)")
  } else {
    passed++
    say("  ✔ subagents readonly, no open buttons")
  }
  const t14mp = Date.now() - 500
  await tap(`s:model:${parentSid}`)
  await expectLog(
    "parent model picker renders",
    (e) => e.method === "editMessageText" && /Pick the model|No models available/i.test(String(e.params.text)),
    20000,
    t14mp,
  )
  const t14pk = Date.now() - 500
  await tap("s:mpick:0")
  await expectLog(
    "model pick acknowledged",
    (e) => e.method === "answerCallbackQuery" && String(e.params.text ?? "").includes("model set"),
    20000,
    t14pk,
  )
  const stModelPick = readBridgeState().sessions[parentSid]?.model
  if (stModelPick?.providerID && stModelPick?.modelID) {
    passed++
    say(`  ✔ picked model persisted: ${stModelPick.providerID}/${stModelPick.modelID}`)
  } else {
    failed++
    say("  ✘ picked model was not persisted to state")
    throw new Error("no picked model")
  }
  // Regression: continuous desktop-side syncing (session.updated / session.list)
  // used to clobber the Telegram pick back to the server's stale value, making
  // the model picker and build/plan switch "do nothing".
  injectEvent(
    {
      type: "session.updated",
      properties: {
        info: {
          id: parentSid,
          title: "parent-cls",
          directory: PROJ,
          model: { id: "gpt-5.6-luna", providerID: "opencode-go" },
          agent: "build",
          time: { updated: Date.now() },
        },
      },
    },
    bridgeOwnerKey(),
    PROJ,
  )
  await sleepBrief(1500)
  const stAfterClob = readBridgeState().sessions[parentSid]
  if (stAfterClob?.model?.modelID === stModelPick.modelID && stAfterClob?.modelPinned === true) {
    passed++
    say("  ✔ picked model survives desktop session.updated clobber")
  } else {
    failed++
    say(`  ✘ pick was clobbered: ${JSON.stringify({ model: stAfterClob?.model, pinned: stAfterClob?.modelPinned })}`)
  }
  const t14pin = Date.now() - 500
  await tap(`s:model:${parentSid}`)
  await expectLog(
    "model picker shows pin marker + follow-app button",
    (e) =>
      e.method === "editMessageText" &&
      String(e.params.text).includes("📌") &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("s:mreset:"),
    20000,
    t14pin,
  )
  const t14pr = Date.now() - 500
  await sendText("Reply with exactly the word FOLLOWPIN and nothing else.")
  await expectLog(
    "prompt after pick completes",
    (e) => e.method === "editMessageText" && String(e.params.text).includes("FOLLOWPIN") && String(e.params.text).includes("finished"),
    120000,
    t14pr,
  )
  const assistantInfo14 = await waitUntil(async () => {
    const arr = await ocGet(`/session/${parentSid}/message?limit=6&directory=${encodeURIComponent(PROJ)}`)
    const assistants = (Array.isArray(arr) ? arr : [])
      .filter((m) => m?.info?.role === "assistant")
      .sort((a, b) => (a?.info?.time?.created ?? 0) - (b?.info?.time?.created ?? 0))
    const last = assistants[assistants.length - 1]
    return last?.info?.modelID ? last.info : null
  }, 30000, "assistant message reporting its model")
  if (assistantInfo14.modelID === stModelPick.modelID && assistantInfo14.providerID === stModelPick.providerID) {
    passed++
    say(`  ✔ opencode actually answered with the picked model (${assistantInfo14.modelID})`)
  } else {
    failed++
    say(`  ✘ opencode answered with ${assistantInfo14.providerID}/${assistantInfo14.modelID}, not ${stModelPick.providerID}/${stModelPick.modelID}`)
  }
  const t14rs = Date.now() - 500
  await tap(`s:mreset:${parentSid}`)
  await expectLog(
    "follow-the-app reset acknowledged",
    (e) => e.method === "answerCallbackQuery" && String(e.params.text ?? "").includes("following the app"),
    20000,
    t14rs,
  )

  say(`${mark} TEST 15: pairing security — strangers, wrong codes, unpair, second device`)
  await sleepBrief(1200)
  const t15a = Date.now()
  await inject({ message: { chat: { id: STRANGER }, text: "hello there", from: { id: STRANGER } } })
  await expectNone(
    "stranger chat gets no reply to plain text",
    (e) => e.ts >= t15a && (e.method === "sendMessage" || e.method === "editMessageText") && e.params.chat_id === STRANGER,
    4000,
  )
  const t15b = Date.now() - 500
  await inject({ message: { chat: { id: STRANGER }, text: "/start", from: { id: STRANGER } } })
  await expectLog(
    "stranger /start receives pairing help",
    (e) => e.method === "sendMessage" && e.params.chat_id === STRANGER && String(e.params.text).includes("isn't paired"),
    20000,
    t15b,
  )
  const pr = readBridgeState().pairing
  if (pr && pr.chatId === STRANGER) {
    passed++
    say("  ✔ pairing request bound to requester chat")
  } else {
    failed++
    say(`  ✘ pairing not bound: ${JSON.stringify(pr)}`)
    throw new Error("pairing not bound")
  }
  const t15c = Date.now() - 500
  await inject({ message: { chat: { id: CHAT }, text: `/pair ${pr.code}`, from: { id: CHAT } } })
  await expectLog(
    "code only works from the chat it was issued for",
    (e) => e.method === "sendMessage" && e.params.chat_id === CHAT && /Wrong code|pairing code/i.test(String(e.params.text)),
    20000,
    t15c,
  )
  const t15d = Date.now() - 500
  await inject({ message: { chat: { id: STRANGER }, text: `/pair ${pr.code}`, from: { id: STRANGER } } })
  await expectLog(
    "stranger completes pairing",
    (e) => e.method === "sendMessage" && e.params.chat_id === STRANGER && String(e.params.text).includes("Paired!"),
    20000,
    t15d,
  )
  await expectLog(
    "owner notified about new pairing",
    (e) => e.method === "sendMessage" && e.params.chat_id === CHAT && String(e.params.text).includes("is now paired"),
    20000,
    t15d,
  )
  const t15e = Date.now() - 500
  await inject({ message: { chat: { id: CHAT }, text: `/unpair ${STRANGER}`, from: { id: CHAT } } })
  await expectLog(
    "owner can revoke other chats",
    (e) => e.method === "sendMessage" && e.params.chat_id === CHAT && String(e.params.text).includes("unpaired"),
    20000,
    t15e,
  )
  if (!readBridgeConfig().authorizedChatIds.includes(STRANGER)) {
    passed++
    say("  ✔ revoked chat removed from config")
  } else {
    failed++
    say("  ✘ revoked chat still authorized")
  }
  const t15f = Date.now() - 500
  await inject({ message: { chat: { id: STRANGER }, text: "/start", from: { id: STRANGER } } })
  await expectLog(
    "revoked chat must pair again",
    (e) => e.method === "sendMessage" && e.params.chat_id === STRANGER && String(e.params.text).includes("isn't paired"),
    20000,
    t15f,
  )


  say(`${mark} TEST 16: HTTP proxy routing for Telegram traffic`)
  await startProxy()
  say("  ✔ test CONNECT proxy listening")
  passed++
  const t16 = Date.now() - 500
  writeBridgeConfig({ proxy: `http://127.0.0.1:${PROXY_PORT}` })
  await waitUntil(() => bridgeLog().includes(`Telegram transport: proxy http://127.0.0.1:${PROXY_PORT} [config]`), 30000, "bridge logs proxy use")
  say("  ✔ bridge logs proxy use")
  passed++
  await sendText("🏠 Home")
  await expectLog(
    "home panel works through proxy",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("🏠"),
    30000,
    t16,
  )
  await waitUntil(() => proxyLog().some((e) => e.target === `127.0.0.1:${MOCK_PORT}`), 30000, "proxy saw CONNECT to Telegram mock")
  say("  ✔ Telegram traffic routed via proxy")
  passed++
  writeBridgeConfig({ proxy: "" })
  await waitUntil(() => bridgeLog().includes("Telegram transport: direct"), 30000, "bridge back to direct")
  say("  ✔ bridge back to direct")
  passed++

  say(`${mark} TEST 17: panel edit failure falls back to fresh message`)
  await setFailEdits(true)
  const t17 = Date.now() - 500
  await sendText("🏠 Home")
  await expectLog(
    "fresh panel sent when edit fails",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("🏠"),
    20000,
    t17,
  )
  await setFailEdits(false)
  say("  ✔ edit-failure fallback works (mock fail mode off again)")

  say(`${mark} TEST 18: offline detection, recovery, Home status line`)
  const t18 = Date.now() - 500
  writeBridgeConfig({ apiBase: "http://127.0.0.1:9" })
  await waitUntil(() => bridgeLog().includes("Telegram unreachable:"), 90000, "offline transition logged")
  say("  ✔ offline transition logged with clear reason")
  passed++
  const linkOff = readBridgeState().link
  if (linkOff?.status === "offline") {
    passed++
    say(`  ✔ link state offline in state.json (${linkOff.lastError || "no detail"})`)
  } else {
    failed++
    say(`  ✘ link state not offline: ${JSON.stringify(linkOff)}`)
  }
  writeBridgeConfig({ apiBase: `http://127.0.0.1:${MOCK_PORT}` })
  await waitUntil(() => bridgeLog().includes("Telegram reconnected"), 90000, "reconnect logged")
  say("  ✔ reconnect logged")
  passed++
  const linkOn = readBridgeState().link
  if (linkOn?.status === "online") {
    passed++
    say("  ✔ link state back online")
  } else {
    failed++
    say(`  ✘ link state not online: ${JSON.stringify(linkOn)}`)
  }
  const t18b = Date.now() - 500
  await sendText("🏠 Home")
  await expectLog(
    "home shows connected status line",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("📡 Telegram: ✅ connected"),
    30000,
    t18b,
  )

  say(`${mark} TEST 19: send failures are logged and mark link offline, then recover`)
  await setFailSends(true)
  const t19 = Date.now() - 500
  await sendText("/nope1")
  await sendText("/nope2")
  await sendText("/nope3")
  await waitUntil(
    () => bridgeLog().split("\n").some((l) => l.includes("sendMessage failed") && Date.parse(l.slice(0, 24)) >= t19 - 1000),
    60000,
    "sendMessage failure warn logged",
  )
  say("  ✔ send failure logged loudly (not swallowed)")
  passed++
  await waitUntil(() => readBridgeState().link?.status === "offline", 60000, "link offline after repeated send failures")
  say(`  ✔ link marked offline after repeated send failures (${readBridgeState().link?.lastError || "no detail"})`)
  passed++
  await setFailSends(false)
  const t19b = Date.now() - 500
  await sendText("/nope4")
  await expectLog(
    "send recovers after failure mode off",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("I didn't get that"),
    30000,
    t19b,
  )
  await waitUntil(() => readBridgeState().link?.status === "online", 60000, "link back online after successful send")
  say("  ✔ link back online after successful send")
  passed++

  say(`${mark} TEST 20: 409 poll conflict is transient, not an auth error`)
  const logBefore = bridgeLog().length
  await setConflictUpdates(true)
  await waitUntil(() => bridgeLog().slice(logBefore).includes("getUpdates conflict (409)"), 60000, "409 transient warn logged")
  say("  ✔ 409 conflict logged as transient")
  passed++
  await sleepBrief(6000)
  const slice20 = bridgeLog().slice(logBefore)
  if (slice20.includes("check botToken/apiBase")) {
    failed++
    say("  ✘ 409 wrongly reported as auth/config error")
  } else {
    passed++
    say("  ✔ 409 not reported as auth/config error")
  }
  await setConflictUpdates(false)
  const t20 = Date.now() - 500
  await sendText("/stillhere")
  await expectLog(
    "poll loop resumes after 409 clears",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("I didn't get that"),
    60000,
    t20,
  )

  say(`${mark} TEST 21: live tail, auto-retry reflection, error surfacing, stop`)
  const t21f = Date.now() - 500
  await sendText("📚 Sessions")
  const listMsg21 = await expectLog(
    "sessions list for refocus",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("📚 Sessions"),
    30000,
    t21f,
  )
  const rows21 = listMsg21.params.reply_markup?.inline_keyboard ?? []
  const e2eRow21 = rows21.find((r) => Array.isArray(r) && String(r[0]?.text ?? "").includes("e2e"))
  if (!e2eRow21) {
    failed++
    say("  ✘ e2e session not in sessions list")
    throw new Error("no e2e row")
  }
  passed++
  await tap(e2eRow21[0].callback_data)
  await sleepBrief(1500)
  const st21a = readBridgeState()
  const e2eSid21 = st21a.chats[String(CHAT)]?.active?.sid ?? ""
  const reg21 = st21a.sessions[e2eSid21]
  if (!e2eSid21 || !reg21?.key) {
    failed++
    say("  ✘ no focused session for TEST 21")
    throw new Error("TEST 21 focus missing")
  }
  passed++
  say(`  ✔ focused session for injection: ${e2eSid21.slice(-6)}`)
  const title21 = reg21.title || "e2e"
  const owner21 = JSON.parse(fs.readFileSync(path.join(RAVEN, "leader.lock", "owner.json"), "utf8"))
  let injN = 0
  function injectBridgeEvent(ev) {
    const item = { t: "event", key: owner21.key, dir: reg21.dir, serverUrl: `http://127.0.0.1:${OC_PORT}`, ts: Date.now(), event: ev }
    const name = `${String(Date.now()).padStart(15, "0")}-inj${injN++}.json`
    fs.writeFileSync(path.join(RAVEN, "outbox", name), JSON.stringify(item))
  }
  const t21 = Date.now() - 500
  await sendText("Count from 1 to 40 separated by commas. Reply with the numbers only. Do not use any tools.")
  const card21 = await expectLog(
    "turn card created for tail test",
    (e) =>
      e.method === "sendMessage" &&
      e.params.chat_id === CHAT &&
      String(e.params.text).includes(`💬 ${title21}`) &&
      (String(e.params.text).includes("sending") || String(e.params.text).includes("working")),
    30000,
    t21,
  )
  const card21Id = card21.result_message_id ?? card21.params.message_id
  injectBridgeEvent({ type: "session.status", properties: { sessionID: e2eSid21, status: { type: "retry", attempt: 2, message: "e2e rate limited" } } })
  await expectLog(
    "auto-retry state reflected on the live card",
    (e) => e.method === "editMessageText" && e.params.message_id === card21Id && String(e.params.text).includes("e2e rate limited") && String(e.params.text).includes("auto-retrying"),
    30000,
    t21,
  )
  injectBridgeEvent({ type: "session.error", properties: { sessionID: e2eSid21, error: { name: "UnknownError", data: { message: "e2e-boom-error" } } } })
  await expectLog(
    "opencode error surfaced on the live card",
    (e) => e.method === "editMessageText" && e.params.message_id === card21Id && String(e.params.text).includes("e2e-boom-error"),
    30000,
    t21,
  )
  await expectLog(
    "error also announced in Home notification",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("failed: e2e-boom-error"),
    30000,
    t21,
  )
  await expectLog(
    "final card keeps the error context and invites a new instruction",
    (e) =>
      e.method === "editMessageText" &&
      e.params.message_id === card21Id &&
      String(e.params.text).includes("e2e-boom-error") &&
      String(e.params.text).includes("You can send a new instruction"),
    180000,
    t21,
  )
  const t21b = Date.now() - 500
  await tap(`s:abort:${e2eSid21}`)
  await expectLog(
    "stop tap acknowledged",
    (e) => e.method === "answerCallbackQuery" && String(e.params.text ?? "").includes("stopped"),
    30000,
    t21b,
  )

  say(`${mark} TEST 22: /agent — dedicated agent workspace, always build, model config`)
  const t22a = Date.now() - 500
  await sendText("/agent")
  const agentList = await expectLog(
    "agent list panel",
    (e) =>
      e.method === "sendMessage" &&
      String(e.params.text).includes("🤖 Agent workspace") &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("s:agpick:"),
    20000,
    t22a,
  )
  if (JSON.stringify(agentList.params.reply_markup).includes("s:ag:close")) {
    failed++
    say("  ✘ close button shown while no workspace is open")
  } else {
    passed++
    say("  ✔ no close button when workspace is closed")
  }
  const t22u = Date.now() - 500
  await sendText("/agent nosuchagent")
  await expectLog(
    "unknown agent rejected with list",
    (e) => e.method === "sendMessage" && String(e.params.text).includes('Unknown agent "nosuchagent"'),
    20000,
    t22u,
  )
  const buildRow = (agentList.params.reply_markup?.inline_keyboard ?? []).find(
    (r) => Array.isArray(r) && String(r[0]?.text ?? "").trim() === "build",
  )
  if (!buildRow) {
    failed++
    say("  ✘ no build agent button")
    throw new Error("no build agent")
  }
  passed++
  const t22b = Date.now() - 500
  await sendText("/agent build")
  const wsPanel = await expectLog(
    "agent workspace panel opens (always build)",
    (e) =>
      e.method === "editMessageText" &&
      String(e.params.text).includes("🤖 @build agent workspace") &&
      String(e.params.text).includes("🛠 build (always)") &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("s:ag:close") &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("s:am:0"),
    30000,
    t22b,
  )
  void wsPanel
  const st22 = readBridgeState()
  const ws22 = st22.chats[String(CHAT)]?.agent
  if (ws22?.agent === "build" && ws22?.sid) {
    passed++
    say(`  ✔ agent workspace bound to session ${String(ws22.sid).slice(-6)}`)
  } else {
    failed++
    say(`  ✘ agent binding missing: ${JSON.stringify(ws22)}`)
    throw new Error("agent bind failed")
  }
  const wsSid22 = ws22.sid
  const wsTitle22 = st22.sessions[wsSid22]?.title || "🤖 build"
  // move focus to the project session: typing must STILL go to the agent
  const t22f = Date.now() - 500
  await sendText("📚 Sessions")
  const listMsg22 = await expectLog(
    "sessions list for agent refocus",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("📚 Sessions"),
    30000,
    t22f,
  )
  const e2eRow22 = (listMsg22.params.reply_markup?.inline_keyboard ?? []).find(
    (r) => Array.isArray(r) && String(r[0]?.text ?? "").includes("e2e") && !String(r[0]?.text ?? "").includes("🤖"),
  )
  if (!e2eRow22) {
    failed++
    say("  ✘ e2e row missing for agent refocus")
    throw new Error("no e2e row 22")
  }
  passed++
  await tap(e2eRow22[0].callback_data)
  await sleepBrief(1500)
  const t22c = Date.now() - 500
  await sendText("Reply with exactly the word AGENT_OK and nothing else.")
  const agentCard = await expectLog(
    "typing goes to the agent even after focusing another session",
    (e) =>
      e.method === "sendMessage" &&
      e.params.chat_id === CHAT &&
      String(e.params.text).includes(`💬 ${wsTitle22}`) &&
      (String(e.params.text).includes("sending") || String(e.params.text).includes("working")),
    30000,
    t22c,
  )
  const agentCardId = agentCard.result_message_id ?? agentCard.params.message_id
  await expectLog(
    "agent answers in its dedicated workspace card",
    (e) => e.method === "editMessageText" && e.params.message_id === agentCardId && String(e.params.text).includes("AGENT_OK") && String(e.params.text).includes("finished"),
    120000,
    t22c,
  )
  const t22m = Date.now() - 500
  await tap(`s:mode:${wsSid22}`)
  await expectLog(
    "build/plan toggle refused in agent workspace",
    (e) => e.method === "answerCallbackQuery" && String(e.params.text ?? "").includes("always build"),
    20000,
    t22m,
  )
  const t22s = Date.now() - 500
  await sendText("⚙️ Settings")
  await expectLog(
    "settings shows open agent workspace + always build",
    (e) =>
      e.method === "sendMessage" &&
      String(e.params.text).includes("🤖 @build — OPEN") &&
      String(e.params.text).includes("🛠 build (always)") &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("s:ag:open"),
    20000,
    t22s,
  )
  const t22ag = Date.now() - 500
  await tap("s:ag:open")
  await expectLog(
    "agent settings screen shows current model + model button",
    (e) =>
      e.method === "editMessageText" &&
      String(e.params.text).includes("Mode: 🛠 build (always)") &&
      JSON.stringify(e.params.reply_markup ?? {}).includes("s:am:0"),
    20000,
    t22ag,
  )
  const t22p = Date.now() - 500
  await tap("s:am:0")
  await expectLog(
    "agent model picker renders",
    (e) => e.method === "editMessageText" && String(e.params.text).includes("Model for @build"),
    20000,
    t22p,
  )
  const t22pk = Date.now() - 500
  await tap("s:ampick:0")
  await expectLog(
    "agent model pick acknowledged",
    (e) => e.method === "answerCallbackQuery" && String(e.params.text ?? "").includes("agent model set"),
    20000,
    t22pk,
  )
  await expectLog(
    "agent workspace panel shows the picked model",
    (e) =>
      e.method === "editMessageText" &&
      String(e.params.text).includes("🤖 @build agent workspace") &&
      !!readBridgeState().chats[String(CHAT)]?.agent?.model?.modelID,
    20000,
    t22pk,
  )
  const st22b = readBridgeState()
  const agentModel22 = st22b.chats[String(CHAT)]?.agent?.model
  if (agentModel22?.providerID && agentModel22?.modelID) {
    passed++
    say(`  ✔ agent model configured: ${agentModel22.providerID}/${agentModel22.modelID}`)
  } else {
    failed++
    say("  ✘ agent model not persisted")
  }
  const t22cl = Date.now() - 500
  await sendText("/agent close")
  await expectLog(
    "workspace closed message + home",
    (e) => e.method === "sendMessage" && String(e.params.text).includes("Closed the @build workspace"),
    20000,
    t22cl,
  )
  if (readBridgeState().chats[String(CHAT)]?.agent) {
    failed++
    say("  ✘ agent binding survived close")
  } else {
    passed++
    say("  ✔ agent binding cleared")
  }
  const t22back = Date.now() - 500
  await sendText("Reply with exactly the word AGENT_OFF and nothing else.")
  await expectLog(
    "typing goes back to the focused project session",
    (e) =>
      e.method === "sendMessage" &&
      String(e.params.text).includes("💬 e2e") &&
      (String(e.params.text).includes("sending") || String(e.params.text).includes("working")),
    30000,
    t22back,
  )

  say("")
  say("══════════════════════════════")
  say(`RESULT: ${passed} passed, ${failed} failed`)
  say(`logs: ${ROOT}`)
  say("══════════════════════════════")
  cleanup()
  setTimeout(() => process.exit(failed ? 1 : 0), 1500)
}

main().catch((e) => {
  failed++
  say("")
  say(`FATAL: ${e.message}`)
  say(`bridge log tail:\n${bridgeLog().split("\n").slice(-25).join("\n")}`)
  try {
    say(`opencode serve log tail:\n${fs.readFileSync(OCLOG, "utf8").split("\n").slice(-30).join("\n")}`)
  } catch {}
  cleanup()
  setTimeout(() => process.exit(1), 1500)
})
