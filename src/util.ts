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
