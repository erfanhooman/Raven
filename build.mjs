import { build } from "esbuild"

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  legalComments: "none",
  logLevel: "warning",
}

// opencode plugin: self-contained ESM file dropped into ~/.config/opencode/plugins/
await build({
  ...common,
  entryPoints: ["src/plugin.ts"],
  outfile: "dist/raven-plugin.js",
})

// daemon + CLI bin: one bundle; dispatch on argv
await build({
  ...common,
  entryPoints: ["src/cli.ts"],
  outfile: "dist/raven-cli.js",
  banner: { js: "#!/usr/bin/env node" },
})

console.log("built: dist/raven-plugin.js dist/raven-cli.js")
