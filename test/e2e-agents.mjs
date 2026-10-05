import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const MOCK_PORT = 8078
const TOKEN = "MOCKTOKEN"
const CHAT = 999
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "raven-agents-"))
const RAVEN = path.join(ROOT, "raven")
const TGLOG = path.join(ROOT, "tglog.jsonl")
const PROJECTS = path.join(ROOT, "claude-projects")

const children = []
let failed = 0
let passed = 0
const say = (m) => console.log(m)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function cleanup() {
  for (const c of children) {
    try { process.kill(-c.pid, "SIGTERM") } catch { try { c.kill("SIGTERM") } catch {} }
  }
  setTimeout(() => {
    for (const c of children) { try { process.kill(-c.pid, "SIGKILL") } catch {} }
    process.exit(failed ? 1 : 0)
  }, 600)
}
process.on("SIGINT", () => cleanup())

async function waitUntil(fn, ms, label) {
  const end = Date.now() + ms
  let lastErr = null
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v } catch (e) { lastErr = e }
    await sleep(250)
  }
  throw new Error(`timeout: ${label}${lastErr ? ` (${lastErr.message})` : ""}`)
}
async function mockLog() { return (await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__log`)).json()).result }
async function inject(u) {
  const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/__inject`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ update: u }) })
  const j = await r.json()
  if (!j.ok) throw new Error("inject failed")
}
const sendText = (text, chat = CHAT) => inject({ message: { chat: { id: chat }, text, from: { id: chat } } })
const tap = (data, chat = CHAT) => inject({ callback_query: { id: String(Date.now()), from: { id: chat }, data, message: { message_id: 900001, chat: { id: chat }, text: "(panel)" } } })
async function expectLog(desc, pred, ms = 30000, since = 0) {
  const found = await waitUntil(async () => (await mockLog()).find((e) => e.ts >= since && pred(e)), ms, desc)
  say(`  ✔ ${desc}`); passed++
  return found
}
function readState() { return JSON.parse(fs.readFileSync(path.join(RAVEN, "state.json"), "utf8")) }
function readCfg() { return JSON.parse(fs.readFileSync(path.join(RAVEN, "raven.json"), "utf8")) }
function daemonLog() { try { return fs.readFileSync(path.join(RAVEN, "raven.log"), "utf8") } catch { return "" } }

async function main() {
  const REAL = process.argv.includes("--real")
  say(`workspace: ${ROOT}  mode: ${REAL ? "REAL claude+codex smoke" : "fake-driver e2e"}`)
  fs.mkdirSync(RAVEN, { recursive: true })
  fs.mkdirSync(PROJECTS, { recursive: true })

  const claudeBin = REAL ? path.join(os.homedir(), ".local", "bin", "claude") : path.join(REPO, "test", "fake-claude.mjs")
  const codexBin = REAL ? REAL_CODEX() : path.join(REPO, "test", "fake-codex.mjs")
  if (!fs.existsSync(claudeBin)) throw new Error("claude bin missing: " + claudeBin)
  if (!fs.existsSync(codexBin)) throw new Error("codex bin missing: " + codexBin)
  if (!REAL) fs.chmodSync(claudeBin, 0o755)
  if (!REAL) fs.chmodSync(codexBin, 0o755)

  fs.writeFileSync(path.join(RAVEN, "raven.json"), JSON.stringify({
    enabled: true,
    botToken: TOKEN,
    authorizedChatIds: [],
    apiBase: `http://127.0.0.1:${MOCK_PORT}`,
    botName: "Raven",
    pairing: { ownerApprove: false },
    notify: { idle: true, error: true, permission: true, question: true, session: false },
    relay: true,
    logLevel: "debug",
    clients: { claude: { bin: claudeBin }, codex: { bin: codexBin } },
  }, null, 2), { mode: 0o600 })

  const mock = spawn("node", [path.join(REPO, "test", "mock-telegram.mjs")], {
    env: { ...process.env, TG_MOCK_PORT: String(MOCK_PORT), TG_MOCK_TOKEN: TOKEN, TG_MOCK_LOG: TGLOG },
    stdio: ["ignore", "pipe", "pipe"], detached: true,
  })
  children.push(mock)
  await waitUntil(async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/__log`).then((r) => r.ok).catch(() => false)), 10000, "mock up")

  const daemon = spawn("node", [path.join(REPO, "dist", "raven-cli.js"), "run"], {
    cwd: ROOT,
    env: { ...process.env, RAVEN_HOME: RAVEN, CLAUDE_PROJECTS_DIR: PROJECTS, RAVEN_WORKDIR: ROOT },
    stdio: ["ignore", "pipe", "pipe"], detached: true,
  })
  children.push(daemon)
  daemon.stdout.on("data", (d) => process.stdout.write(`  [daemon] ${d}`.slice(0, 200) + ""))
  daemon.stderr.on("data", (d) => process.stderr.write(`  [daemon:err] ${d}`))
  await waitUntil(() => daemonLog().includes("acquired leadership"), 30000, "daemon leader")
  say("  ✔ daemon is leader + polling")
  passed++

  // ── pairing ──
  const tp = Date.now() - 500
  await sendText("/start")
  await expectLog("unpaired /start answers with pairing help", (e) => e.method === "sendMessage" && String(e.params.text).includes("isn't paired"), 20000, tp)
  const pairing = await waitUntil(async () => readState().pairing, 10000, "pairing code")
  await sendText(`/pair ${pairing.code}`)
  await expectLog("pairing completes and whitelist persists", (e) => e.method === "sendMessage" && String(e.params.text).includes("Paired!"), 20000, tp)
  if (readCfg().authorizedChatIds.includes(CHAT)) { passed++; say("  ✔ chat whitelisted") } else { failed++; say("  ✘ not whitelisted") }

  let claudeLive = true
  if (REAL) {
    try {
      const stg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf8"))
      const base = stg?.env?.ANTHROPIC_BASE_URL
      if (base) {
        const r = await fetch(base + "/v1/models", { headers: { authorization: "Bearer " + (stg.env.ANTHROPIC_AUTH_TOKEN ?? "") }, signal: AbortSignal.timeout(4000) }).catch(() => null)
        claudeLive = !!r?.ok
      }
    } catch {}
    say(`  · claude backend reachable: ${claudeLive}`)
  }

  // ── NEW Claude session + chat ──
  const tn = Date.now() - 500
  await sendText("➕ New")
  const np = await expectLog("new-project panel offers Claude + Codex", (e) => e.method === "sendMessage" && JSON.stringify(e.params.reply_markup ?? "").includes("s:newc:cl") && JSON.stringify(e.params.reply_markup ?? "").includes("s:newc:cx"), 20000, tn)
  const newCl = JSON.stringify(np.params.reply_markup).includes("s:newc:cl")
  if (!newCl) { failed++; say("  ✘ no claude button") } else { passed++ }
  await tap("s:newc:cl")
  await expectLog("claude new session asks for a name", (e) => e.method === "sendMessage" && String(e.params.text).includes("Name the new Claude"), 20000, tn)
  await sendText("claude smoke")
  const wsPanel = await expectLog("claude workspace opens", (e) => e.method === "editMessageText" && String(e.params.text).includes("💬"), 30000, tn)
  const kb0 = JSON.stringify(wsPanel.params.reply_markup ?? {})
  if (kb0.includes("s:mode:")) { passed++; say("  ✔ claude offers mode toggle") } else { failed++; say("  ✘ claude mode toggle missing") }
  const clPanelSid = kb0.match(/s:model:cl_[A-Za-z0-9-]+/)?.[0]?.replace(/^s:model:/, "") ?? readState().chats[String(CHAT)]?.active?.sid

  const t1 = Date.now() - 500
  if (claudeLive) await sendText(REAL ? "Reply with exactly the word PONGCL and nothing else." : "hello PONGCL")
  const card = claudeLive ? await expectLog("claude turn card created", (e) => e.method === "sendMessage" && String(e.params.text).includes("You:"), 30000, t1) : null
  const cardId = card?.result_message_id ?? card?.params?.message_id
  if (!claudeLive) { say("  · SKIP claude turns (model backend unreachable)"); }
  else {
    if (JSON.stringify(card.params.reply_markup ?? {}).includes("s:abort:")) { passed++; say("  ✔ stop button on running claude card") } else { failed++ }
    const relay1 = await expectLog("claude answers (relay on card)", (e) => e.method === "editMessageText" && e.params.message_id === cardId && (REAL ? String(e.params.text).includes("PONGCL") : /PONGCL/.test(String(e.params.text))), REAL ? 240000 : 60000, t1)
    say(`      ↳ relay: ${String(relay1.params.text).replace(/\n/g, " ⏎ ").slice(0, 110)}`)
  }

  // ── claude model + mode pick → applied ──
  const t2 = Date.now() - 500
  await tap(`s:model:${clPanelSid}`)
  await expectLog("claude model picker shows families", (e) => e.method === "editMessageText" && /Pick the model/i.test(String(e.params.text)) && JSON.stringify(e.params.reply_markup ?? "").includes("s:mpick:"), 20000, t2)
  const pickSonnet = await expectLog("picker lists sonnet/opus/haiku or custom", (e) => e.method === "editMessageText" && /sonnet|Other/i.test(String(e.params.text)), 5000, t2)
  const sonnetRow = (pickSonnet.params.reply_markup?.inline_keyboard ?? []).find((r) => /sonnet/i.test(String(r[0]?.text ?? "")))
  if (sonnetRow) await tap(sonnetRow[0].callback_data)
  else await tap("s:mpick:0")
  await expectLog("claude model set toast", (e) => e.method === "answerCallbackQuery" && String(e.params.text ?? "").includes("model set"), 20000, t2)
  const t3 = Date.now() - 500
  if (claudeLive) {
    await sendText(REAL ? "Say exactly: MODEDONE" : "ping")
    await expectLog(REAL ? "real claude answers after model change" : "second claude turn applies model flag in reply", (e) => e.method === "editMessageText" && /PONGCL|MODEDONE|finished/i.test(String(e.params.text)), REAL ? 240000 : 60000, t3)
  }

  // ── claude permission via real PreToolUse HTTP hook ──
  if (!REAL) {
    await sleep(4000)
    const t4 = Date.now() - 500
    await sendText("SHELL echo hunter2")
    await expectLog("claude approval card appears", (e) => e.method === "sendMessage" && String(e.params.text).includes("Permission needed") && JSON.stringify(e.params.reply_markup ?? "").includes("p:per_cl_"), 30000, t4)
    const cardMsg = (await mockLog()).filter((e) => e.method === "sendMessage" && String(e.params.text).includes("Permission needed") && e.ts >= t4).pop()
    const allowData = JSON.stringify(cardMsg.params.reply_markup).match(/p:per_cl_[^"\\]+:once/)?.[0]
    await tap(allowData)
    await expectLog("claude approval answered", (e) => e.method === "editMessageText" && String(e.params.text).includes("allowed once"), 20000, t4)
    const fin = await expectLog("claude turn finishes after approval", (e) => e.method === "editMessageText" && String(e.params.text).includes("finished"), 60000, t4)
    if (!String(fin.params.text).includes("BLOCKED")) { passed++; say("  ✔ hook received allow decision") } else { failed++; say("  ✘ hook got BLOCKED") }
  }

  // ── sessions list spans clients ──
  const t5 = Date.now() - 500
  await sendText("📚 Sessions")
  if (claudeLive) await expectLog("sessions list includes claude session", (e) => e.method === "sendMessage" && String(e.params.text).includes("Claude Code") && /hello PONGCL|PONGCL|claude|ping/i.test(String(e.params.text)), 30000, t5)

  // ── codex thread ──
  const t6 = Date.now() - 500
  await sendText("➕ New")
  await tap("s:newc:cx")
  await expectLog("codex new thread asks for a name", (e) => e.method === "sendMessage" && String(e.params.text).includes("Name the new Codex"), 20000, t6)
  await sendText("codex smoke")
  const cxPanel = await expectLog("codex workspace opens", (e) => e.method === "editMessageText" && String(e.params.text).includes("💬") && JSON.stringify(e.params.reply_markup ?? "").includes("s:model:cx_"), 30000, t6)
  const cxKb = JSON.stringify(cxPanel.params.reply_markup ?? {})
  if (!cxKb.includes("s:mode:")) { passed++; say("  ✔ codex hides plan/build toggle") } else { failed++; say("  ✘ codex shows mode toggle") }
  const cxSid = cxKb.match(/s:model:cx_[A-Za-z0-9-]+/)?.[0]?.replace(/^s:model:/, "") ?? ""
  const t7 = Date.now() - 500
  await sendText(REAL ? "Reply with exactly the word PONGCX and nothing else." : "hey PONGCX")
  const cxCard = await expectLog("codex turn card created", (e) => e.method === "sendMessage" && String(e.params.text).includes("You:"), 30000, t7)
  const cxCardId = cxCard.result_message_id ?? cxCard.params.message_id
  if (!REAL) await expectLog("codex streams text tail onto its card", (e) => e.method === "editMessageText" && e.params.message_id === cxCardId && String(e.params.text).includes("🤖"), 30000, t7)
  const cxRelay = await expectLog("codex answers in its workspace card", (e) => e.method === "editMessageText" && e.params.message_id === cxCardId && String(e.params.text).includes(REAL ? "PONGCX" : "PONGCX"), REAL ? 180000 : 60000, t7)
  say(`      ↳ relay: ${String(cxRelay.params.text).replace(/\n/g, " ⏎ ").slice(0, 110)}`)

  // ── codex approval round-trip ──
  if (!REAL) {
    const t8 = Date.now() - 500
    await sendText("RUN echo secret")
    const apCard = await expectLog("codex approval card appears", (e) => e.method === "sendMessage" && String(e.params.text).includes("Permission needed") && JSON.stringify(e.params.reply_markup ?? "").includes("p:per_cx_"), 30000, t8)
    const apData = JSON.stringify(apCard.params.reply_markup).match(/p:per_cx_[^"\\]+:once/)?.[0]
    await tap(apData)
    await expectLog("codex turn completes with approval", (e) => e.method === "editMessageText" && String(e.params.text).includes("PONGCX approved"), 60000, t8)
  }

  // ── codex model picker ──
  if (!REAL) {
    const t9 = Date.now() - 500
    await tap(`s:model:${cxSid}`)
    await expectLog("codex model picker shows gpt-5.5", (e) => e.method === "editMessageText" && /gpt-5\.5/i.test(String(e.params.text)) && JSON.stringify(e.params.reply_markup ?? "").includes("s:mpick:"), 20000, t9)
    await tap("s:mpick:0")
    const t10 = Date.now() - 500
    await sendText("again PONGCX")
    await expectLog("codex answers with the chosen model", (e) => e.method === "editMessageText" && String(e.params.text).includes("PONGCX codex-auto-review ok"), 60000, t10)
  }

  // ── daemon survives; nothing leaked; pairing persists across state rewrites ──
  if (readCfg().authorizedChatIds.includes(CHAT)) { passed++; say("  ✔ pairing persisted through all traffic") } else { failed++ }

  say("")
  say(`RESULT: ${passed} passed, ${failed} failed`)
  say(`logs: ${ROOT}`)
  cleanup()
}

function REAL_CODEX() {
  const guesses = ["/opt/homebrew/bin/codex", "/usr/local/bin/codex", path.join(os.homedir(), ".local", "bin", "codex")]
  try {
    for (const e of fs.readdirSync(path.join(os.homedir(), ".vscode", "extensions"))) {
      if (/openai\.chatgpt|codex/i.test(e)) guesses.push(path.join(os.homedir(), ".vscode", "extensions", e, "bin", "macos-aarch64", "codex"))
    }
  } catch {}
  for (const g of guesses) if (fs.existsSync(g)) return g
  throw new Error("codex not found for --real")
}

main().catch((e) => {
  failed++
  say(`FATAL: ${e.message}`)
  say(`daemon log tail:\n${daemonLog().split("\n").slice(-25).join("\n")}`)
  cleanup()
  setTimeout(() => process.exit(1), 1200)
})
