import fs from "node:fs"
import path from "node:path"
import os from "node:os"

export function ravenHome(): string {
  if (process.env.RAVEN_HOME) return process.env.RAVEN_HOME
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
    return path.join(appData, "raven")
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(xdg, "raven")
}

export function redact(s: string): string {
  return s ? `${s.slice(0, 6)}…${s.slice(-4)}` : s
}

// Cross-platform executable lookup: searches PATH (honoring PATHEXT on
// Windows, where `claude` usually means `claude.cmd` in %APPDATA%\npm).
export function findOnPath(names: string[]): string | null {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean)
  const exts =
    process.platform === "win32"
      ? [...new Set([...(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim()).filter(Boolean), ""])]
      : ["", ".exe", ".cmd"]
  for (const dir of dirs) {
    for (const name of names) {
      for (const ext of exts) {
        const p = path.join(dir, `${name}${ext}`)
        try {
          if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
        } catch {}
      }
    }
  }
  return null
}

// `.cmd`/`.bat` shims (npm global installs on Windows) cannot be spawned
// directly — they need a shell.
export function spawnShellFor(bin: string): boolean {
  if (process.platform !== "win32") return false
  const b = bin.toLowerCase()
  return b.endsWith(".cmd") || b.endsWith(".bat")
}

// The pairing-code banner. Printed by the daemon to the terminal when a chat
// sends /start, and by `raven pair`. The code never goes to Telegram — this
// banner (and the desktop notification) are its only displays.
export function pairingBanner(code: string, who?: string, ttlMin = 10): string {
  const line = "═".repeat(58)
  return [
    "",
    line,
    `  🔑  RAVEN PAIRING CODE:  ${code}`,
    "",
    `  In Telegram send:  /pair ${code}`,
    who ? `  From ${who} — expires in ${ttlMin} min` : `  Expires in ${ttlMin} min`,
    "  Re-read anytime:  raven pair",
    line,
    "",
  ].join("\n")
}

// One line of the paired-chats list: `123456 — "Name"`.
export function pairedChatLine(id: number, name?: string): string {
  return name ? `  • ${id} — "${name}"` : `  • ${id}`
}

// ── cross-platform background-service building blocks ──

// PowerShell single-quoted literal (doubled inner quotes).
export function psQuote(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}

// HKCU\...\Run value data: starts the daemon hidden at Windows logon.
export function winRunValue(node: string, script: string): string {
  return `powershell.exe -NoProfile -WindowStyle Hidden -Command "& ${psQuote(node)} ${psQuote(script)} run"`
}

// systemd user unit content for the daemon.
export function systemdUnit(node: string, script: string, ravenHomeEnv?: string): string {
  const env = ravenHomeEnv ? `Environment=${psQuote(`RAVEN_HOME=${ravenHomeEnv}`)}\n` : ""
  return [
    "[Unit]",
    "Description=Raven Telegram bridge daemon",
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=${psQuote(node)} ${psQuote(script)} run`,
    `${env}Restart=on-failure`,
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n")
}
