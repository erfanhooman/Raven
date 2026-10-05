// raven — the CLI bin: setup, run (daemon), service (launchd), pair, status,
// logs, uninstall.

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createInterface } from "node:readline"
import { execFileSync, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { ravenHome } from "./util.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))

function cfgPath() {
  return path.join(ravenHome(), "raven.json")
}

function opencodePluginsDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR) return path.join(process.env.OPENCODE_CONFIG_DIR, "plugins")
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(xdg, "opencode", "plugins")
}

function legacyPluginPaths(): string[] {
  const dir = opencodePluginsDir()
  return [path.join(dir, "telegram-bridge.ts"), path.join(dir, "telegram-bridge.js")]
}

function pluginPath(): string {
  return path.join(opencodePluginsDir(), "raven.js")
}

function readCfg(): any {
  try {
    return JSON.parse(fs.readFileSync(cfgPath(), "utf8"))
  } catch {
    return {}
  }
}

async function ask(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  if (!hidden) {
    const a = await new Promise<string>((res) => rl.question(question, res))
    rl.close()
    return a.trim()
  }
  process.stdout.write(question)
  try {
    process.stdin.setRawMode(true)
  } catch {}
  const a = await new Promise<string>((res) => {
    let buf = ""
    const onData = (b: Buffer) => {
      const s = b.toString("utf8")
      for (const ch of s) {
        if (ch === "\n" || ch === "\r") {
          process.stdin.off("data", onData)
          try {
            process.stdin.setRawMode(false)
          } catch {}
          process.stdout.write("\n")
          rl.close()
          res(buf.trim())
          return
        }
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1)
        else {
          buf += ch
          process.stdout.write("*")
        }
      }
    }
    process.stdin.on("data", onData)
  })
  return a
}

function guessOpencode(): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", ["opencode"], { stdio: "ignore" })
    return true
  } catch {
    return process.platform === "darwin" && fs.existsSync("/Applications/OpenCode.app")
  }
}

async function checkToken(token: string, proxy: string): Promise<string> {
  const envProxy = proxy ? { proxy } : null
  void envProxy
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(15_000) })
  const j: any = await res.json().catch(() => ({}))
  if (!j?.ok) throw new Error(j?.description || `http ${res.status}`)
  return String(j.result?.username ?? "bot")
}

async function cmdSetup(args: string[]) {
  const yes = args.includes("-y") || args.includes("--yes")
  const noService = args.includes("--no-service")
  const tokenFlag = args.includes("--token") ? args[args.indexOf("--token") + 1] : ""
  const proxyFlag = args.includes("--proxy") ? args[args.indexOf("--proxy") + 1] : ""
  let token = tokenFlag
  if (!token) token = await ask("Telegram bot token (from @BotFather): ", true)
  if (!token) {
    console.error("no token provided")
    process.exit(1)
  }
  // proxy must apply to this process too for getMe
  if (proxyFlag) {
    process.env.HTTPS_PROXY = proxyFlag
    process.env.https_proxy = proxyFlag
  }
  try {
    const bot = await checkToken(token, proxyFlag)
    console.log(`✅ token ok — bot @${bot}`)
  } catch (e: any) {
    console.error(`❌ token rejected: ${e?.message ?? e}`)
    process.exit(1)
  }

  const home = ravenHome()
  await fsp.mkdir(home, { recursive: true })
  const prev = readCfg()
  const legacy = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(ravenHomeLegacyFile(), "telegram-bridge.json"), "utf8"))
    } catch {
      return null
    }
  })()
  const cfg = {
    ...prev,
    enabled: true,
    botToken: token,
    authorizedChatIds: prev.authorizedChatIds ?? legacy?.chatIds ?? [],
    proxy: proxyFlag || prev.proxy || legacy?.proxy || "",
    botName: prev.botName || legacy?.botName || "Raven",
    notify: prev.notify ?? legacy?.notify ?? { idle: true, error: true, permission: true, question: true, session: false },
    relay: prev.relay ?? true,
    pairing: { ownerApprove: prev?.pairing?.ownerApprove === true },
    clients: {
      claude: { enabled: true, bin: prev?.clients?.claude?.bin || "" },
      codex: { enabled: true, bin: prev?.clients?.codex?.bin || "" },
    },
  }
  await fsp.writeFile(cfgPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 })
  console.log(`config → ${cfgPath()}`)

  // opencode plugin
  const pdir = opencodePluginsDir()
  await fsp.mkdir(pdir, { recursive: true })
  const bundled = path.join(HERE, "raven-plugin.js")
  if (fs.existsSync(bundled)) {
    await fsp.copyFile(bundled, pluginPath())
    console.log(`opencode plugin → ${pluginPath()}`)
  } else {
    console.log(`⚠ plugin bundle not found next to the CLI (${bundled}) — opencode steps skipped`)
  }
  for (const l of legacyPluginPaths()) {
    try {
      await fsp.rm(l, { force: true })
      console.log(`removed legacy ${l}`)
    } catch {}
  }

  // Background service (auto-start the daemon with the machine).
  // macOS uses launchd; other platforms should run `raven run` under a
  // supervisor instead (systemd unit, Task Scheduler, pm2, …).
  if (!noService) {
    if (process.platform !== "darwin") {
      console.log("background service is macOS (launchd) only — skipped.")
      console.log("run `raven run` under your supervisor to keep the daemon alive (see README).")
    } else {
      try {
        await installService()
      } catch (e: any) {
        console.log(`service install skipped: ${e?.message ?? e}`)
      }
    }
  }

  console.log("")
  console.log("Next steps:")
  console.log("  1. Restart OpenCode Desktop (or run `raven run` to start the daemon now).")
  console.log("  2. Open your bot in Telegram and send /start.")
  console.log("  3. Raven prints a 6-character pairing code in the terminal (plus a desktop notification on macOS).")
  console.log(`  4. Reply to the bot with: /pair THECODE — that links this chat. Anyone unpaired can never read your sessions.`)
  if (yes) console.log("(non-interactive: done)")
}

function ravenHomeLegacyFile(): string {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(xdg, "opencode")
}

function plistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", "dev.raven.daemon.plist")
}

function binPath(): string {
  const p = process.env.RAVEN_BIN || process.execPath
  const script = process.env.RAVEN_CLI_ENTRY || path.join(HERE, "raven-cli.js")
  return `${p} ${script} run`
}

async function installService(): Promise<void> {
  const [head, ...tail] = [process.env.RAVEN_BIN || process.execPath, process.env.RAVEN_CLI_ENTRY || path.join(HERE, "raven-cli.js"), "run"]
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.raven.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${head}</string>
${tail.map((t) => `    <string>${t}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${ravenHome()}/daemon.out</string>
  <key>StandardErrorPath</key><string>${ravenHome()}/daemon.err</string>
  <key>WorkingDirectory</key><string>${os.homedir()}</string>
</dict>
</plist>
`
  await fsp.mkdir(path.dirname(plistPath()), { recursive: true })
  await fsp.writeFile(plistPath(), plist)
  const domain = `gui/${process.getuid?.() ?? 501}`;
  const label = "dev.raven.daemon";
  let loaded = false;
  try {
    execFileSync("launchctl", ["print", domain + "/" + label], { stdio: "ignore" });
    loaded = true;
  } catch {}
  if (loaded) {
    execFileSync("launchctl", ["kickstart", "-k", domain + "/" + label], { stdio: "inherit" });
  } else {
    execFileSync("launchctl", ["bootstrap", domain, plistPath()], { stdio: "inherit" });
  }
  console.log(`launchd service installed → ${plistPath()}`)
}

async function cmdRun(): Promise<void> {
  const { runDaemon } = await import("./daemon.js")
  const d = await runDaemon()
  const bye = async () => {
    await d.dispose()
    process.exit(0)
  }
  process.on("SIGINT", () => void bye())
  process.on("SIGTERM", () => void bye())
  console.log(`[raven] daemon running (home: ${ravenHome()}) — Ctrl-C to stop`)
}

async function cmdStatus(): Promise<void> {
  const cfg = readCfg()
  const home = ravenHome()
  const owner = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(home, "leader.lock", "owner.json"), "utf8"))
    } catch {
      return null
    }
  })()
  const state = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8"))
    } catch {
      return null
    }
  })()
  console.log("config     :", cfgPath(), cfg.botToken ? `(token ${String(cfg.botToken).slice(0, 6)}…)` : "(missing!)")
  console.log("paired     :", (cfg.authorizedChatIds ?? []).join(", ") || "none — send /start to the bot to pair")
  console.log("leader     :", owner ? `${String(owner.key).slice(0, 8)} (pid ${owner.pid})` : "none")
  console.log("link       :", state?.link?.status ?? "?", state?.link?.lastError ? `(${state.link.lastError.slice(0, 60)})` : "")
  console.log("opencode   :", guessOpencode() ? "found" : "not found")
  const { ClaudeDriver } = await import("./drivers/claude.js")
  const { CodexDriver } = await import("./drivers/codex.js")
  console.log("claude bin :", new ClaudeDriver({ home, dirOf: () => process.cwd(), emit: async () => {} }).resolveBin() ?? "not found")
  console.log("codex bin  :", new CodexDriver({ home, dirOf: () => process.cwd(), emit: async () => {} }).resolveBin() ?? "not found")
  console.log("logs       :", path.join(home, "raven.log"))
}

async function cmdLogs(follow: boolean): Promise<void> {
  const file = path.join(ravenHome(), "raven.log")
  // Pure-Node tail: the `tail(1)` binary does not exist on Windows.
  const printTail = (n: number) => {
    try {
      const raw = fs.readFileSync(file, "utf8").split("\n")
      const lines = raw[raw.length - 1] === "" ? raw.slice(0, -1) : raw
      for (const l of lines.slice(-n)) console.log(l)
    } catch {
      console.log(`no log file yet at ${file} (is the daemon running?)`)
    }
  }
  if (!follow) {
    printTail(80)
    return
  }
  printTail(20)
  let pos = 0
  try {
    pos = fs.statSync(file).size
  } catch {
    return
  }
  const timer = setInterval(() => {
    try {
      const size = fs.statSync(file).size
      if (size < pos) pos = 0 // truncated/rotated
      if (size > pos) {
        const fd = fs.openSync(file, "r")
        const buf = Buffer.alloc(size - pos)
        fs.readSync(fd, buf, 0, buf.length, pos)
        fs.closeSync(fd)
        pos = size
        process.stdout.write(buf.toString("utf8"))
      }
    } catch {}
  }, 500)
  const stop = () => {
    clearInterval(timer)
    process.exit(0)
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}

function launchdGuard(): boolean {
  if (process.platform === "darwin") return true
  console.log("the background service is macOS (launchd) only — run `raven run` under your supervisor instead.")
  return false
}

async function cmdUninstall(purge: boolean): Promise<void> {
  if (process.platform === "darwin") {
    try {
      execFileSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/dev.raven.daemon`], { stdio: "ignore" })
    } catch {}
    try {
      await fsp.rm(plistPath(), { force: true })
    } catch {}
    console.log("removed service")
  }
  await fsp.rm(pluginPath(), { force: true })
  for (const l of legacyPluginPaths()) await fsp.rm(l, { force: true })
  console.log("removed plugin")
  if (purge) {
    await fsp.rm(ravenHome(), { recursive: true, force: true })
    console.log("removed", ravenHome())
  } else {
    console.log(`kept config/logs in ${ravenHome()} (use --purge to remove)`)
  }
}

async function main() {
  const [, , cmd = "help", ...rest] = process.argv
  switch (cmd) {
    case "setup":
      await cmdSetup(rest)
      break
    case "run":
      await cmdRun()
      break
    case "service":
      if (!launchdGuard()) break
      if (rest[0] === "remove") {
        try {
          execFileSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/dev.raven.daemon`], { stdio: "ignore" })
          await fsp.rm(plistPath(), { force: true })
          console.log("service removed")
        } catch (e: any) {
          console.error("remove failed:", e?.message ?? e)
        }
      } else if (rest[0] === "status") {
        try {
          console.log(execFileSync("launchctl", ["print", `gui/${process.getuid?.() ?? 501}/dev.raven.daemon`], { encoding: "utf8" }))
        } catch {
          console.log("service not installed")
        }
      } else {
        await installService()
      }
      break
    case "pair": {
      try {
        const stt = JSON.parse(fs.readFileSync(path.join(ravenHome(), "state.json"), "utf8"))
        const pr = stt.pairing
        if (pr && Date.now() - pr.createdAt < 10 * 60_000) {
          console.log(`Pairing request from "${pr.name}" (chat ${pr.chatId}) — code: ${pr.code}`)
          console.log(`They should send:  /pair ${pr.code}`)
        } else {
          console.log("No pending pairing request. From the new Telegram chat send /start to the bot first, then run 'raven pair' again to read its code.")
        }
      } catch {
        console.log("No pairing request found (is the daemon or OpenCode running?). Start it with 'raven run' or open OpenCode.")
      }
      break
    }
    case "status":
      await cmdStatus()
      break
    case "logs":
      await cmdLogs(rest.includes("-f") || rest.includes("--follow"))
      break
    case "uninstall":
      await cmdUninstall(rest.includes("--purge"))
      break
    default:
      console.log(
        [
          "raven — Telegram bridge for opencode · Claude Code · Codex",
          "",
          "usage:",
          "  raven setup            wizard: token, config, plugin, background service (macOS)",
          "  raven run              run the daemon in the foreground",
          "  raven service install|remove|status   (macOS launchd only)",
          "  raven pair             show the pending pairing code (send /start in the new chat first)",
          "  raven status           what's paired, who's leader, where logs live",
          "  raven logs [-f]        tail the bridge log",
          "  raven uninstall [--purge]",
        ].join("\n"),
      )
  }
}

main().catch((e) => {
  console.error("raven:", e?.message ?? e)
  process.exit(1)
})
