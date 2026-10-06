// Asserts the Windows/Linux background-service command construction without
// touching the real OS (no registry, no systemd): builds src/util.ts with
// esbuild, imports it, and checks the generated strings.
import { build } from "esbuild"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const out = mkdtempSync(path.join(tmpdir(), "raven-platform-")) + "/util.mjs"

await build({
  entryPoints: [path.join(REPO, "src", "util.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
})
const { winRunValue, systemdUnit, psQuote } = await import(pathToFileURL(out).href)

let failed = 0
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra}`)
  if (!cond) failed++
}

// Windows: hidden powershell wrapper, both paths quoted, `run` arg present.
const node = "C:\\Program Files\\nodejs\\node.exe"
const script = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@erfanhooman\\raven\\dist\\raven-cli.js"
const win = winRunValue(node, script)
check("win: powershell hidden", win.includes("powershell.exe") && win.includes("-WindowStyle Hidden"))
check("win: node path quoted", win.includes(`'${node}'`))
check("win: script path quoted", win.includes(`'${script}'`))
check("win: starts with run", win.endsWith(' run"'))
check("psQuote escapes single quotes", psQuote("it's") === "'it''s'")

// Linux: systemd unit with ExecStart, restart policy, and logon target.
const unit = systemdUnit("/usr/bin/node", "/opt/raven/raven-cli.js")
check("linux: ExecStart quoted", unit.includes('ExecStart=\'/usr/bin/node\' \'/opt/raven/raven-cli.js\' run'))
check("linux: restart policy", unit.includes("Restart=on-failure"))
check("linux: wanted by default.target", unit.includes("WantedBy=default.target"))
check("linux: no env line by default", !unit.includes("Environment="))
const unitEnv = systemdUnit("/usr/bin/node", "/x.js", "/home/me/ra ven")
check("linux: RAVEN_HOME env quoted", unitEnv.includes("Environment='RAVEN_HOME=/home/me/ra ven'"))

rmSync(path.dirname(out), { recursive: true, force: true })
if (failed) {
  console.log(`FAILED: ${failed}`)
  process.exit(1)
}
console.log("platform service builders: all green")
