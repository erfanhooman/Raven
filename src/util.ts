import path from "node:path"
import os from "node:os"

export function ravenHome(): string {
  if (process.env.RAVEN_HOME) return process.env.RAVEN_HOME
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(xdg, "raven")
}

export function redact(s: string): string {
  return s ? `${s.slice(0, 6)}…${s.slice(-4)}` : s
}
