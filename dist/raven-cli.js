#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/util.ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
function ravenHome() {
  if (process.env.RAVEN_HOME) return process.env.RAVEN_HOME;
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "raven");
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "raven");
}
function findOnPath(names) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? [.../* @__PURE__ */ new Set([...(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim()).filter(Boolean), ""])] : ["", ".exe", ".cmd"];
  for (const dir of dirs) {
    for (const name of names) {
      for (const ext of exts) {
        const p = path.join(dir, `${name}${ext}`);
        try {
          if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
        } catch {
        }
      }
    }
  }
  return null;
}
function spawnShellFor(bin) {
  if (process.platform !== "win32") return false;
  const b = bin.toLowerCase();
  return b.endsWith(".cmd") || b.endsWith(".bat");
}
var init_util = __esm({
  "src/util.ts"() {
    "use strict";
  }
});

// src/core.ts
import fsp from "node:fs/promises";
import { watch } from "node:fs";
import path2 from "node:path";
import os2 from "node:os";
import net from "node:net";
import tls from "node:tls";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
function menuKeyboard() {
  return {
    resize_keyboard: true,
    keyboard: [[{ text: "\u{1F3E0} Home" }, { text: "\u{1F4DA} Sessions" }], [{ text: "\u2795 New" }, { text: "\u2699\uFE0F Settings" }]]
  };
}
function ravenHomeLegacy() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME || path2.join(os2.homedir(), ".config");
  return path2.join(xdg, "opencode");
}
function clip(s, n = 3800) {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n - 1) + "\u2026" : str;
}
function shortId(id) {
  return id.length <= 8 ? id : id.slice(-6);
}
function timeAgo(ms) {
  if (!ms) return "";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1e3));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function baseDir(dir) {
  const parts = String(dir ?? "").split("/").filter(Boolean);
  return parts[parts.length - 1] || dir || "";
}
function msgText(withParts) {
  const parts = withParts?.parts ?? [];
  const texts = parts.filter((p) => p?.type === "text" && typeof p.text === "string" && p.text.trim()).map((p) => String(p.text).trim());
  const tools = parts.filter((p) => p?.type === "tool" && p?.tool).map((p) => {
    const cmd = typeof p.state?.input?.command === "string" ? `: ${clip(p.state.input.command, 60)}` : "";
    const out = typeof p.state?.output === "string" && p.state.output.trim() ? ` \u2192 ${clip(p.state.output.trim(), 80)}` : "";
    return `\u{1F527} ${p.tool}${cmd}${out}`;
  });
  return [...texts, ...tools].join("\n").trim();
}
function modelFromInfo(m) {
  const providerID = String(m?.providerID ?? "");
  const modelID = String(m?.modelID ?? m?.id ?? "");
  if (!providerID || !modelID) return void 0;
  return { providerID, modelID };
}
function modelLabelOf(m) {
  return m?.modelID || "default";
}
function modeOf(agent) {
  const a = String(agent ?? "build").toLowerCase();
  return a === "plan" ? "plan" : a === "build" ? "build" : a;
}
function modeButtonLabel(mode) {
  return mode === "plan" ? "\u{1F4CB} plan" : mode === "build" ? "\u{1F6E0} build" : `\u{1F916} ${clip(mode, 24)}`;
}
function tailClip(s, n = 1500) {
  const t = String(s ?? "").trim();
  return t.length > n ? "\u2026" + t.slice(-n) : t;
}
function stopKeyboard(sid) {
  return { inline_keyboard: [[{ text: "\u23F9 Stop turn", callback_data: `s:abort:${sid}` }]] };
}
function sameModel(a, b) {
  return !!a && !!b && a.providerID === b.providerID && a.modelID === b.modelID;
}
function mergeServerModel(prev, server) {
  if (prev?.modelPinned) {
    if (server && sameModel(server, prev.model)) return { model: server, modelPinned: false, modelServer: server };
    return { model: prev.model, modelPinned: true, modelServer: server ?? prev.modelServer };
  }
  return { model: server ?? prev?.model, modelPinned: false, modelServer: server ?? prev?.modelServer };
}
function mergeServerAgent(prev, server) {
  if (prev?.agentPinned) {
    if (server && server === prev.agent) return { agent: server, agentPinned: false, agentServer: server };
    return { agent: prev.agent, agentPinned: true, agentServer: server ?? prev.agentServer };
  }
  return { agent: server ?? prev?.agent, agentPinned: false, agentServer: server ?? prev?.agentServer };
}
async function startBridge(o) {
  {
    let clientOf2 = function(sid) {
      if (sid.startsWith("cl_")) return "cl";
      if (sid.startsWith("cx_")) return "cx";
      return "oc";
    }, clientName2 = function(c) {
      return c === "cl" ? "Claude Code" : c === "cx" ? "Codex" : c === "daemon" ? "raven" : "opencode";
    }, clientIcon2 = function(c) {
      return c === "cl" ? "\u{1F9E9}" : c === "cx" ? "\u2B22" : "\u{1F5A5}";
    }, noteInstanceResult2 = function(key, ok) {
      const v = instances.get(key);
      if (!v) return;
      if (ok) {
        if (v.fails || v.downUntil) instances.set(key, { ...v, fails: 0, downUntil: 0 });
        return;
      }
      const fails = (v.fails ?? 0) + 1;
      const wasDown = (v.downUntil ?? 0) > Date.now();
      const downUntil = fails >= 2 ? Date.now() + 45e3 : v.downUntil ?? 0;
      instances.set(key, { ...v, fails, downUntil });
      if (fails >= 2 && !wasDown) log("info", `instance ${key.slice(0, 8)} not responding \u2014 skipping it for 45s (${v.dir})`);
    }, isInstanceUp2 = function(v) {
      if (Date.now() - v.lastSeen > 3e5) return false;
      if ((v.downUntil ?? 0) > Date.now()) return false;
      return true;
    }, scheduleWork2 = function(label, fn) {
      workChain.p = workChain.p.then(fn).catch((e) => log("warn", `${label}: ${e?.message ?? e}`));
      return workChain.p;
    }, atomicWrite2 = function(file, data, mode) {
      const prev = writeChains.get(file) ?? Promise.resolve();
      const next = prev.then(async () => {
        const tmp = `${file}.${randomUUID().slice(0, 6)}.tmp`;
        await fsp.writeFile(tmp, data, { encoding: "utf8", ...mode ? { mode } : {} });
        await fsp.rename(tmp, file);
      }).catch((e) => log("warn", `write failed ${path2.basename(file)}: ${e?.message ?? e}`));
      writeChains.set(file, next);
      return next;
    }, saveState2 = function(s) {
      const now = Date.now();
      for (const k of Object.keys(s.dedupe)) if (now - (s.dedupe[k] ?? 0) > 864e5) delete s.dedupe[k];
      const sids = Object.keys(s.sessions);
      if (sids.length > 200) {
        sids.sort((a, b) => (s.sessions[a]?.updated ?? 0) - (s.sessions[b]?.updated ?? 0)).slice(0, sids.length - 200).forEach((sid) => delete s.sessions[sid]);
      }
      return atomicWrite2(STATE_FILE, JSON.stringify(s));
    }, mutateState2 = function(fn) {
      const run = stateChain.p.then(async () => {
        const s = await loadState();
        const r = await fn(s);
        await saveState2(s);
        return r;
      });
      stateChain.p = run.catch(() => {
      });
      return run;
    }, kickDrain2 = function() {
      if (kickTimer || disposed) return;
      kickTimer = setTimeout(() => {
        kickTimer = null;
        void drainOutbox();
      }, 60);
    }, kickInbox2 = function() {
      if (inboxKickTimer || disposed) return;
      inboxKickTimer = setTimeout(() => {
        inboxKickTimer = null;
        void inboxTick();
      }, 120);
    }, watchDir2 = function(dir, onChange) {
      try {
        const w = watch(dir, { persistent: false }, () => {
          if (!disposed) onChange();
        });
        w.on("error", () => {
        });
        watchers.push(w);
      } catch {
      }
    }, turnCardText2 = function(title, prompt, state) {
      return clip([`\u{1F4AC} ${title}`, `You: ${clip(prompt, 500)}`, state].join("\n\n"), 3900);
    }, buildQuestionKeyboard2 = function(id, questions, selections, single) {
      const rows = [];
      questions.forEach((q, qi) => {
        const opts = q.options ?? [];
        opts.forEach((o2, oi) => {
          const marked = selections[qi]?.includes(oi);
          if (single) rows.push([{ text: `${marked ? "\u2705 " : ""}${clip(o2.label, 40)}`, callback_data: `qa:${id}:${qi}:${oi}` }]);
          else
            rows.push([{ text: `${marked ? "\u2705 " : ""}${clip(o2.label, 40)}`, callback_data: `qt:${id}:${qi}:${oi}` }]);
        });
        if (questions.length > 1) rows.push([{ text: `\u2014 Q${qi + 1} \u2014`, callback_data: "noop" }]);
      });
      if (!single)
        rows.push([
          { text: "Submit", callback_data: `qs:${id}` },
          { text: "Dismiss", callback_data: `qr:${id}` }
        ]);
      return { inline_keyboard: rows };
    }, redactProxy2 = function(proxyUrl) {
      try {
        const u = new URL(proxyUrl);
        return `${u.protocol}//${u.username ? "***@" : ""}${u.hostname}${u.port ? `:${u.port}` : ""}`;
      } catch {
        return "(invalid proxy URL)";
      }
    }, readSock2 = function(sock, want, timeoutMs) {
      return new Promise((resolve, reject) => {
        let buf = Buffer.alloc(0);
        const timer = setTimeout(() => {
          cleanup();
          try {
            sock.destroy();
          } catch {
          }
          reject(new Error("timed out waiting for proxy response"));
        }, timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          sock.off("data", onData);
          sock.off("error", onError);
          sock.off("close", onClose);
        };
        const onData = (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          const need = want(buf);
          if (need === null) {
            cleanup();
            resolve(buf);
          }
        };
        const onError = (e) => {
          cleanup();
          reject(e);
        };
        const onClose = () => {
          cleanup();
          reject(new Error("proxy connection closed early"));
        };
        sock.on("data", onData);
        sock.once("error", onError);
        sock.once("close", onClose);
      });
    }, buildMultipart2 = function(fields, file) {
      const boundary = `----ocbridge${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
      const chunks = [];
      for (const [k, v] of Object.entries(fields)) {
        chunks.push(Buffer.from(`--${boundary}\r
Content-Disposition: form-data; name="${k}"\r
\r
${v}\r
`, "utf8"));
      }
      const safeName = file.filename.replace(/["\r\n]/g, "_");
      chunks.push(Buffer.from(`--${boundary}\r
Content-Disposition: form-data; name="${file.field}"; filename="${safeName}"\r
Content-Type: ${file.contentType}\r
\r
`, "utf8"));
      chunks.push(file.content);
      chunks.push(Buffer.from(`\r
--${boundary}--\r
`, "utf8"));
      return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
    }, makePairCode2 = function() {
      let out = "";
      for (let i = 0; i < 6; i++) out += PAIR_ALPHABET[Math.floor(Math.random() * PAIR_ALPHABET.length)];
      return out;
    }, pairingHelp2 = function(code) {
      return [
        `\u{1F510} Raven isn't paired with this Telegram account yet.`,
        ``,
        `On your computer, Raven shows this code:  ${code}`,
        `Send it back here with:  /pair ${code}`,
        `(expires in 10 minutes)`
      ].join("\n");
    }, formatStatus2 = function(busy) {
      return busy ? "\u23F3 busy" : "\u2705 idle";
    }, renderModelPage2 = function(items, page, perPage, mkNav, mkPick, current, header = `\u{1F9E0} Pick the model for future prompts in this session`) {
      const pages = Math.max(1, Math.ceil(items.length / perPage));
      const pg = Math.min(Math.max(0, page), pages - 1);
      const shown = items.slice(pg * perPage, pg * perPage + perPage);
      const lines = [`${header} (page ${pg + 1}/${pages}):`, ``];
      const rows = [];
      let lastProvider = "";
      shown.forEach((m, i) => {
        if (m.providerName !== lastProvider) {
          lastProvider = m.providerName;
          lines.push(`\u{1F4C2} ${m.providerName}`);
        }
        const isCurrent = current?.providerID === m.providerID && current?.modelID === m.modelID;
        lines.push(`  ${isCurrent ? "\u2705" : "\u2022"} ${m.name}`);
        rows.push([{ text: clip(`${isCurrent ? "\u2705 " : ""}${m.name}`, 40), callback_data: mkPick(pg * perPage + i) }]);
      });
      const nav = [];
      if (pg > 0) nav.push({ text: "\u25C0", callback_data: mkNav(pg - 1) });
      if (pg < pages - 1) nav.push({ text: "\u25B6", callback_data: mkNav(pg + 1) });
      if (nav.length) rows.push(nav);
      return { text: clip(lines.join("\n"), 3900), rows };
    }, permCardText2 = function(t, p) {
      const perm = p.permission ?? p.action ?? "permission";
      const lines = (p.patterns ?? p.resources ?? []).slice(0, 6);
      return clip(
        [`\u{1F510} Permission needed`, `Session: ${t.title}`, `Needs: ${perm}`, ...lines.length ? ["", ...lines.map((l) => `  \u2022 ${clip(String(l), 200)}`)] : []].join("\n")
      );
    }, permCardKeyboard2 = function(id) {
      return {
        inline_keyboard: [
          [
            { text: "\u2705 Allow once", callback_data: `p:${id}:once` },
            { text: "\u267E Allow always", callback_data: `p:${id}:always` }
          ],
          [{ text: "\u274C Reject", callback_data: `p:${id}:reject` }]
        ]
      };
    }, questionCardText2 = function(t, questions) {
      const single = questions.length === 1 && !questions[0].multiple;
      let text = `\u2753 ${t.title}

`;
      questions.forEach((q, qi) => {
        const opts = (q.options ?? []).map((o2, oi) => `${single ? "" : `${oi + 1}. `}${o2.label}${o2.description ? ` \u2014 ${o2.description}` : ""}`);
        text += `${questions.length > 1 ? `Q${qi + 1}. ` : ""}${q.question ?? q.header ?? "?"}
${opts.join("\n")}

`;
        if (q.custom) text += "(custom text answers: answer in the app)\n";
      });
      return clip(text.trim());
    }, textPartsOf2 = function(m) {
      return (m?.parts ?? []).filter((p) => p?.type === "text" && typeof p.text === "string" && p.text.trim()).map((p) => String(p.text).trim()).join("\n").trim();
    }, buildTranscript2 = function(title, modelLabel, agentLabel, userText, assistantText) {
      return [
        `# ${title}`,
        ``,
        `Session transcript exported from Telegram.`,
        ...modelLabel && modelLabel !== "default" ? [`Model: ${modelLabel}`] : [],
        ...agentLabel ? [`Agent: ${agentLabel}`] : [],
        ``,
        `## \u{1F464} User`,
        ``,
        userText || "(empty prompt)",
        ``,
        `## \u{1F916} Assistant`,
        ``,
        assistantText || "(no text reply)",
        ``
      ].join("\n");
    }, renderSelectionText2 = function(base, questions, sel) {
      let out = base;
      questions.forEach((q, i) => {
        const chosen = (sel[i] ?? []).map((oi) => q.options?.[oi]?.label).filter(Boolean);
        if (chosen.length) out += `
\u2705 Q${i + 1}: ${chosen.join(", ")}`;
      });
      return clip(out);
    }, macNotify2 = function(title, msg) {
      try {
        if (process.platform !== "darwin") return;
        execFile("/usr/bin/osascript", ["-e", `display notification ${JSON.stringify(msg)} with title ${JSON.stringify(title)}`], () => {
        });
      } catch {
      }
    }, shortNetError2 = function(e) {
      const msg = String(e?.message ?? e);
      if (/ECONNREFUSED|Unable to connect/.test(msg)) return "connection refused";
      if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(msg)) return "DNS lookup failed";
      if (/ETIMEDOUT|timed out|Timeout/i.test(msg)) return "connection timed out";
      if (/ECONNRESET|EPIPE|socket hang up|closed before/i.test(msg)) return "connection dropped";
      if (/certificate|CERT|TLS|SSL/i.test(msg)) return "TLS/certificate error";
      return clip(msg, 140);
    };
    var clientOf = clientOf2, clientName = clientName2, clientIcon = clientIcon2, noteInstanceResult = noteInstanceResult2, isInstanceUp = isInstanceUp2, scheduleWork = scheduleWork2, atomicWrite = atomicWrite2, saveState = saveState2, mutateState = mutateState2, kickDrain = kickDrain2, kickInbox = kickInbox2, watchDir = watchDir2, turnCardText = turnCardText2, buildQuestionKeyboard = buildQuestionKeyboard2, redactProxy = redactProxy2, readSock = readSock2, buildMultipart = buildMultipart2, makePairCode = makePairCode2, pairingHelp = pairingHelp2, formatStatus = formatStatus2, renderModelPage = renderModelPage2, permCardText = permCardText2, permCardKeyboard = permCardKeyboard2, questionCardText = questionCardText2, textPartsOf = textPartsOf2, buildTranscript = buildTranscript2, renderSelectionText = renderSelectionText2, macNotify = macNotify2, shortNetError = shortNetError2;
    const CFG_ROOT = o.home;
    const CFG_FILE = path2.join(CFG_ROOT, "raven.json");
    const BR = CFG_ROOT;
    const OUTBOX = path2.join(BR, "outbox");
    const INBOX = path2.join(BR, "inbox");
    const LOCK = path2.join(BR, "leader.lock");
    const OWNER = path2.join(LOCK, "owner.json");
    const STATE_FILE = path2.join(BR, "state.json");
    const PROMPTS_FILE = path2.join(BR, "prompts.json");
    const OFFSET_FILE = path2.join(BR, "telegram-offset");
    const LOG_FILE = path2.join(BR, "raven.log");
    const KEY = o.key;
    const MY_DIR = o.dir;
    const CLIENT = o.client;
    const SERVER_URL = o.serverUrl.replace(/\/+$/, "");
    let disposed = false;
    const timers = [];
    let tgRunning = false;
    let draining = false;
    let kickTimer = null;
    let inboxKickTimer = null;
    let inboxing = false;
    let warnedMultiServer = false;
    const watchers = [];
    let offset = 0;
    const instances = /* @__PURE__ */ new Map();
    const waiters = /* @__PURE__ */ new Map();
    const lastLists = /* @__PURE__ */ new Map();
    const lastPickLists = /* @__PURE__ */ new Map();
    const lastCardEdit = /* @__PURE__ */ new Map();
    const streamEdits = /* @__PURE__ */ new Map();
    const reconciled = /* @__PURE__ */ new Map();
    let firstLockSeen = 0;
    const writeChains = /* @__PURE__ */ new Map();
    const stateChain = { p: Promise.resolve() };
    const workChain = { p: Promise.resolve() };
    let logLevel = "info";
    const log = (level, msg) => {
      if (level === "debug" && logLevel !== "debug") return;
      const line = `${(/* @__PURE__ */ new Date()).toISOString()} ${level.toUpperCase()} [${KEY.slice(0, 8)}] ${msg}
`;
      fsp.appendFile(LOG_FILE, line).then(() => fsp.stat(LOG_FILE)).then((st) => {
        if (st.size > 1e6) return fsp.truncate(LOG_FILE, Math.floor(st.size / 2));
      }).catch(() => {
      });
    };
    async function readJSON(file, fallback) {
      try {
        const raw = await fsp.readFile(file, "utf8");
        return JSON.parse(raw);
      } catch {
        return fallback;
      }
    }
    async function loadConfig() {
      let raw = await readJSON(CFG_FILE, {});
      try {
        logLevel = String(raw?.logLevel || "info");
      } catch {
      }
      if (!raw || typeof raw !== "object") raw = {};
      if (!raw.botToken && o.home === ravenHome()) {
        const legacy = await readJSON(path2.join(ravenHomeLegacy(), "telegram-bridge.json"), {});
        if (legacy?.botToken) raw = { ...legacy, botName: legacy.botName || "Raven", setupDone: true };
      }
      const notify = raw?.notify ?? {};
      const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy || "";
      const cfgProxy = String(raw?.proxy ?? "").trim();
      const ids = /* @__PURE__ */ new Set();
      for (const x of Array.isArray(raw?.authorizedChatIds) ? raw.authorizedChatIds : []) ids.add(Number(x));
      for (const x of Array.isArray(raw?.chatIds) ? raw.chatIds : []) ids.add(Number(x));
      ids.delete(NaN);
      return {
        enabled: raw?.enabled !== false,
        botToken: String(raw?.botToken ?? ""),
        authorizedChatIds: [...ids].filter((n) => Number.isFinite(n)),
        apiBase: String(raw?.apiBase ?? "https://api.telegram.org").replace(/\/+$/, ""),
        proxy: cfgProxy || envProxy,
        proxySource: cfgProxy ? "config" : envProxy ? "env" : "",
        botName: String(raw?.botName || "Raven"),
        botDescription: String(raw?.botDescription ?? ""),
        ownerApprove: raw?.pairing?.ownerApprove === true,
        logLevel: String(raw?.logLevel || "info"),
        notify: {
          idle: notify.idle !== false,
          error: notify.error !== false,
          permission: notify.permission !== false,
          question: notify.question !== false,
          session: notify.session === true
        },
        relay: raw?.relay !== false
      };
    }
    async function patchConfig(patch) {
      const cur = await readJSON(CFG_FILE, {});
      const next = { ...cur, ...patch };
      await atomicWrite2(CFG_FILE, JSON.stringify(next, null, 2), 384);
      log("info", `config updated: ${Object.keys(patch).join(", ")}`);
    }
    async function loadState() {
      const s = await readJSON(STATE_FILE, {});
      return {
        chats: s.chats ?? {},
        sessions: s.sessions ?? {},
        awaiting: s.awaiting ?? {},
        lastIdle: s.lastIdle ?? {},
        lastBusy: s.lastBusy ?? {},
        dedupe: s.dedupe ?? {},
        link: s.link ?? { status: "starting", since: Date.now(), lastError: "", fails: 0 },
        pairing: s.pairing ?? void 0
      };
    }
    async function loadPrompts() {
      const p = await readJSON(PROMPTS_FILE, {});
      const now = Date.now();
      let dirty = false;
      for (const k of Object.keys(p)) {
        if (now - (p[k]?.sentAt ?? 0) > 7 * 864e5) {
          delete p[k];
          dirty = true;
        }
      }
      if (dirty) await atomicWrite2(PROMPTS_FILE, JSON.stringify(p));
      return p;
    }
    async function mutatePrompts(fn) {
      const run = stateChain.p.then(async () => {
        const p = await loadPrompts();
        const r = await fn(p);
        await atomicWrite2(PROMPTS_FILE, JSON.stringify(p));
        return r;
      });
      stateChain.p = run.catch(() => {
      });
      return run;
    }
    const executeAction = (action, payload) => o.runAction(action, payload);
    async function submitAction(targetKey, action, payload, timeout = 12e3) {
      if (targetKey === KEY) return executeAction(action, payload);
      const id = randomUUID();
      const item = { id, key: targetKey, action, payload, ts: Date.now() };
      await fsp.mkdir(INBOX, { recursive: true });
      await atomicWrite2(path2.join(INBOX, `${Date.now()}-${id.slice(0, 6)}.json`), JSON.stringify(item));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          noteInstanceResult2(targetKey, false);
          reject(new Error(`${action}: instance did not respond (is that project open?)`));
        }, timeout);
        waiters.set(id, { resolve, reject, timer });
        log("debug", `wait ${action} id=${id.slice(0, 8)} target=${targetKey.slice(0, 8)} waiters=${waiters.size}`);
      });
    }
    let enqueueSeq = 0;
    async function enqueue(item) {
      try {
        await fsp.mkdir(OUTBOX, { recursive: true });
        const name = `${String(Date.now()).padStart(15, "0")}-${String(++enqueueSeq % 1e6).padStart(6, "0")}-${randomUUID().slice(0, 4)}.json`;
        await atomicWrite2(path2.join(OUTBOX, name), JSON.stringify(item));
        kickDrain2();
      } catch (e) {
        log("warn", `enqueue failed: ${e?.message ?? e}`);
      }
    }
    async function readOwner() {
      return readJSON(OWNER, null);
    }
    async function isLeader() {
      const o2 = await readOwner();
      return !!o2 && o2.key === KEY;
    }
    async function tryAcquire() {
      try {
        await fsp.mkdir(BR, { recursive: true });
        await fsp.mkdir(LOCK);
        await fsp.writeFile(OWNER, JSON.stringify({ key: KEY, pid: process.pid, hb: Date.now() }), "utf8");
        log("info", "acquired leadership");
        return true;
      } catch {
        return false;
      }
    }
    async function leaderTick() {
      if (disposed) return;
      try {
        const o2 = await readOwner();
        const now = Date.now();
        if (o2?.key === KEY) {
          firstLockSeen = 0;
          await atomicWrite2(OWNER, JSON.stringify({ key: KEY, pid: process.pid, hb: now }));
          await drainOutbox();
          if (!tgRunning) void tgLoop();
          const servers = /* @__PURE__ */ new Set();
          for (const [, v] of instances.entries()) {
            if (Date.now() - v.lastSeen < 12e4 && v.serverUrl) servers.add(v.serverUrl);
          }
          if (servers.size > 1 && !warnedMultiServer) {
            warnedMultiServer = true;
            log("warn", `multiple opencode servers detected (${[...servers].join(", ")}) \u2014 is OpenCode open twice? Every project should live in one app instance.`);
          } else if (servers.size <= 1 && warnedMultiServer) {
            warnedMultiServer = false;
          }
          return;
        }
        const stale = !o2 || now - (o2.hb ?? 0) > 12e3;
        const ownerless = !o2;
        if (ownerless) {
          try {
            const st = await fsp.stat(LOCK);
            if (!firstLockSeen) firstLockSeen = st.mtimeMs;
            if (now - firstLockSeen < 5e3) return;
          } catch {
            firstLockSeen = 0;
          }
        }
        if (stale) {
          try {
            await fsp.rm(LOCK, { recursive: true, force: true });
          } catch {
          }
          firstLockSeen = 0;
          await tryAcquire();
        }
      } catch (e) {
        log("warn", `leaderTick: ${e?.message ?? e}`);
      }
    }
    async function drainOutbox() {
      if (draining || disposed) return;
      if (!await isLeader()) return;
      draining = true;
      try {
        let names = [];
        try {
          names = (await fsp.readdir(OUTBOX)).filter((n) => n.endsWith(".json")).sort();
        } catch {
          names = [];
        }
        if (names.length) log("debug", `drain sees ${names.length} file(s)`);
        for (const name of names) {
          if (disposed || !await isLeader()) break;
          const file = path2.join(OUTBOX, name);
          const ts = Number(name.slice(0, 15)) || 0;
          if (Date.now() - ts > 9e5) {
            await fsp.rm(file, { force: true }).catch(() => {
            });
            continue;
          }
          const item = await readJSON(file, null);
          await fsp.rm(file, { force: true }).catch(() => {
          });
          if (!item) continue;
          if (item.t === "event" && Date.now() - item.ts > 12e4) {
            log("debug", `dropped stale event ${item.event.type} (age ${Math.round((Date.now() - item.ts) / 1e3)}s)`);
            continue;
          }
          try {
            await handleOut(item);
          } catch (e) {
            log("warn", `outbox ${item.t}: ${e?.message ?? e}`);
          }
        }
        if (await isLeader()) await gcInbox();
      } finally {
        draining = false;
      }
    }
    async function gcInbox() {
      try {
        const names = await fsp.readdir(INBOX);
        const now = Date.now();
        for (const name of names) {
          const ts = Number(name.slice(0, 15)) || 0;
          if (ts && now - ts > 6e4) await fsp.rm(path2.join(INBOX, name), { force: true }).catch(() => {
          });
        }
      } catch {
      }
    }
    async function handleOut(item) {
      if (item.t === "hello") {
        instances.set(item.key, { dir: item.dir, serverUrl: item.serverUrl, client: item.client ?? "oc", lastSeen: Date.now(), fails: 0, downUntil: 0 });
        scheduleWork2(`reconcile ${item.key.slice(0, 8)}`, () => reconcile(item.key));
        return;
      }
      if (item.t === "ack") {
        const w = waiters.get(item.id);
        log("debug", `ack ${w ? "hit" : "MISS"} id=${String(item.id).slice(0, 8)} waiters=${waiters.size}`);
        noteInstanceResult2(item.key, true);
        if (w) {
          waiters.delete(item.id);
          clearTimeout(w.timer);
          if (item.ok) w.resolve(item.data);
          else w.reject(new Error(item.error || "action failed"));
        }
        return;
      }
      if (item.t === "event") {
        instances.set(item.key, { dir: item.dir, serverUrl: item.serverUrl, client: item.client ?? "oc", lastSeen: Date.now(), fails: 0, downUntil: 0 });
        scheduleWork2(`event ${item.event.type}`, () => processEvent(item.key, item.dir, item.event));
      }
    }
    async function reconcile(key) {
      const last = reconciled.get(key) ?? 0;
      if (Date.now() - last < 6e4) return;
      reconciled.set(key, Date.now());
      try {
        const res = await submitAction(key, "session.list", {}, 8e3);
        log("debug", `reconcile ${key.slice(0, 8)} session.list ok (${(res?.sessions ?? []).length} sessions)`);
        await ingestSessions(key, res?.sessions ?? [], res?.previews);
        const pend = await submitAction(key, "pending", {}, 8e3);
        const cfg = await loadConfig();
        for (const p of pend?.permissions ?? []) await notifyPermission(cfg, key, p);
        for (const q of pend?.questions ?? []) await notifyQuestion(cfg, key, q);
      } catch (e) {
        log("debug", `reconcile ${key.slice(0, 8)}: ${e?.message ?? e}`);
        const inst = instances.get(key);
        if (inst) instances.set(key, { ...inst, lastSeen: Date.now() - 6e5 });
      }
    }
    async function ingestSessions(key, sessions, previews) {
      if (!Array.isArray(sessions)) return;
      await mutateState2((s) => {
        for (const sess of sessions) {
          if (!sess?.id) continue;
          const prev = s.sessions[sess.id];
          s.sessions[sess.id] = {
            key,
            dir: sess.directory ?? prev?.dir ?? MY_DIR,
            title: sess.title || prev?.title || shortId(sess.id),
            updated: sess.time?.updated ?? prev?.updated ?? Date.now(),
            parentID: sess.parentID ?? prev?.parentID,
            preview: previews?.[sess.id] ?? prev?.preview,
            ...mergeServerModel(prev, modelFromInfo(sess.model)),
            ...mergeServerAgent(prev, sess.agent ? modeOf(String(sess.agent)) : void 0),
            client: prev?.client ?? (sess.client ?? clientOf2(sess.id))
          };
        }
      });
    }
    async function sessionTitle(sid, fallbackKey) {
      const s = await loadState();
      const hit = s.sessions[sid];
      if (hit) return { title: hit.title, key: hit.key, dir: hit.dir };
      const instDir = fallbackKey ? instances.get(fallbackKey)?.dir : void 0;
      if (fallbackKey) {
        const inst = instances.get(fallbackKey);
        try {
          const info = await submitAction(fallbackKey, "session.get", { sessionID: sid }, 6e3);
          if (info?.id) {
            await mutateState2((st) => {
              const prev = st.sessions[sid];
              st.sessions[sid] = {
                key: fallbackKey,
                dir: info.directory ?? inst?.dir ?? MY_DIR,
                title: info.title || shortId(sid),
                updated: info.time?.updated ?? Date.now(),
                parentID: info.parentID,
                preview: prev?.preview,
                client: prev?.client ?? clientOf2(sid),
                ...mergeServerModel(prev, modelFromInfo(info.model)),
                ...mergeServerAgent(prev, info.agent ? modeOf(String(info.agent)) : void 0)
              };
            });
            return { title: info.title || shortId(sid), key: fallbackKey, dir: info.directory ?? inst?.dir ?? MY_DIR };
          }
        } catch {
        }
      }
      return { title: shortId(sid), key: fallbackKey ?? KEY, dir: instDir ?? MY_DIR };
    }
    async function displayTitle(sid, fallbackKey) {
      const base = await sessionTitle(sid, fallbackKey);
      const s = await loadState();
      const parentID = s.sessions[sid]?.parentID;
      if (!parentID) return { ...base, isSub: false };
      const parent = s.sessions[parentID];
      const parentTitle = parent?.title || shortId(parentID);
      return { title: `${parentTitle} \xB7 subagent`, key: base.key, dir: base.dir, isSub: true };
    }
    async function processEvent(key, dir, ev) {
      const type = ev.type;
      const p = ev.properties ?? {};
      const cfg = await loadConfig();
      if (!cfg.enabled || !cfg.botToken) return;
      if (type === "session.created" || type === "session.updated") {
        const info = p.info;
        if (info?.id) {
          await mutateState2((s) => {
            const prev = s.sessions[info.id];
            s.sessions[info.id] = {
              key,
              dir: info.directory ?? dir,
              title: info.title || prev?.title || shortId(info.id),
              updated: info.time?.updated ?? Date.now(),
              parentID: info.parentID ?? prev?.parentID,
              preview: prev?.preview,
              ...mergeServerModel(prev, modelFromInfo(info.model)),
              ...mergeServerAgent(prev, info.agent ? modeOf(String(info.agent)) : void 0),
              client: prev?.client ?? (info.client ?? clientOf2(info.id))
            };
          });
          if (type === "session.created" && cfg.notify.session) {
            const dk = `sc:${info.id}`;
            const sent = await mutateState2((s) => {
              if (s.dedupe[dk]) return false;
              s.dedupe[dk] = Date.now();
              return true;
            });
            if (sent) await broadcast(cfg, `\u{1F195} session: ${info.title || shortId(info.id)}`);
          }
        }
        return;
      }
      if (type === "session.deleted") {
        const sid = p.sessionID;
        if (sid)
          await mutateState2((s) => {
            delete s.sessions[sid];
            delete s.awaiting[sid];
            for (const c of Object.values(s.chats)) {
              if (c.active?.sid === sid) delete c.active;
              if (c.agent?.sid === sid) delete c.agent;
            }
          });
        return;
      }
      if (type === "permission.asked" || type === "permission.v2.asked") {
        await notifyPermission(cfg, key, p);
        return;
      }
      if (type === "permission.replied" || type === "permission.v2.replied") {
        await onPermissionReplied(p);
        return;
      }
      if (type === "question.asked" || type === "question.v2.asked") {
        await notifyQuestion(cfg, key, p);
        return;
      }
      if (type === "question.replied" || type === "question.v2.replied") {
        await onQuestionReplied(p);
        return;
      }
      if (type === "question.rejected" || type === "question.v2.rejected") {
        await onQuestionRejected(p);
        return;
      }
      if (type === "session.error") {
        const sid = p.sessionID;
        const err = p.error;
        const msg = String(err?.data?.message ?? err?.message ?? (typeof err === "string" ? err : "unknown error"));
        if (sid) await onSessionError(cfg, sid, msg);
        if (cfg.notify.error) {
          const t = sid ? await displayTitle(sid, key) : null;
          await broadcast(cfg, `\u274C ${t ? t.title + " " : ""}failed: ${clip(msg, 800)}`);
        }
        return;
      }
      if (type === "message.part.updated") {
        const part = p.part ?? {};
        if (part?.type === "text" && p.sessionID && typeof part.text === "string") await onStreamText(cfg, p.sessionID, part.text);
        return;
      }
      if (type === "session.status" || type === "session.idle") {
        const sid = p.sessionID;
        const status = type === "session.status" ? p.status : { type: "idle" };
        if (!sid || !status) return;
        if (status.type === "busy") {
          await mutateState2((s) => void (s.lastBusy[sid] = Date.now()));
          await onBusyCard(cfg, sid);
          return;
        }
        if (status.type === "retry") {
          await onRetryCard(cfg, sid, status);
          return;
        }
        if (status.type !== "idle") return;
        await onIdle(cfg, key, sid);
      }
    }
    async function refreshTurnCards(sid, makeState, force = false) {
      const now = Date.now();
      const info = await mutateState2((s) => {
        const a = s.awaiting[sid];
        if (!a) return null;
        if (!force && now - (a.lastCardEdit ?? 0) < 2e4) return null;
        a.lastCardEdit = now;
        return { chats: [...a.chats], prompt: a.prompt ?? "", cards: { ...a.cards ?? {} } };
      });
      if (!info) return;
      const t = await displayTitle(sid).catch(() => null);
      const stateText = makeState(t?.title ?? shortId(sid), info.prompt);
      if (!stateText) return;
      for (const chatId of info.chats) {
        const mid = info.cards[String(chatId)];
        if (mid) await editMessage(chatId, mid, stateText, stopKeyboard(sid)).catch(() => {
        });
      }
    }
    async function onBusyCard(cfg, sid) {
      await refreshTurnCards(sid, (title, prompt) => turnCardText2(title, prompt, `\u23F3 working\u2026`));
    }
    async function onStreamText(_cfg, sid, text) {
      const trimmed = String(text ?? "").trim();
      if (!trimmed) return;
      const now = Date.now();
      const info = await mutateState2((s) => {
        const a = s.awaiting[sid];
        if (!a) return null;
        a.stream = tailClip(trimmed, 1500);
        const force = !a.streamShown;
        a.streamShown = true;
        if (!force && now - (a.lastStreamEdit ?? 0) < 2500) return null;
        a.lastStreamEdit = now;
        return { chats: [...a.chats], cards: { ...a.cards ?? {} }, prompt: a.prompt ?? "", stream: a.stream };
      });
      if (!info) return;
      const t = await displayTitle(sid).catch(() => null);
      const title = t?.title ?? shortId(sid);
      const body = turnCardText2(title, info.prompt, `\u{1F916} ${info.stream}`);
      for (const chatId of info.chats) {
        const mid = info.cards[String(chatId)];
        if (mid) await editMessage(chatId, mid, body, stopKeyboard(sid)).catch(() => {
        });
      }
      await refreshStreamPanels(sid);
    }
    async function refreshStreamPanels(sid) {
      const now = Date.now();
      const st = await loadState();
      for (const ck of Object.keys(st.chats)) {
        const c = st.chats[ck];
        const ui = c?.ui;
        if (ui?.panelId && ui.screen?.name === "session" && ui.screen.sid === sid) {
          const chatId = Number(ck);
          const k = `${chatId}:${sid}`;
          if (now - (streamEdits.get(k) ?? 0) < 4e3) continue;
          streamEdits.set(k, now);
          await showPanel(chatId).catch(() => {
          });
        }
      }
    }
    async function onRetryCard(_cfg, sid, status) {
      await refreshTurnCards(
        sid,
        (title, prompt) => turnCardText2(
          title,
          prompt,
          `\u26A0\uFE0F ${clip(String(status?.message ?? "model error"), 200)}
\u{1F501} auto-retrying${status?.attempt ? ` (attempt ${status.attempt})` : ""}\u2026`
        ),
        true
      );
    }
    async function onSessionError(_cfg, sid, msg) {
      const a = await mutateState2((s) => {
        const cur = s.awaiting[sid];
        if (!cur) return null;
        cur.error = clip(msg, 400);
        cur.lastCardEdit = 0;
        return { chats: [...cur.chats], cards: { ...cur.cards ?? {} }, prompt: cur.prompt ?? "" };
      });
      if (!a) return;
      const t = await displayTitle(sid).catch(() => null);
      const body = turnCardText2(
        t?.title ?? shortId(sid),
        a.prompt,
        `\u274C ${clip(msg, 300)}

opencode auto-retries on its own. Tap \u23F9 Stop to interrupt it and send something else instead.`
      );
      for (const chatId of a.chats) {
        const mid = a.cards[String(chatId)];
        if (mid) await editMessage(chatId, mid, body, stopKeyboard(sid)).catch(() => {
        });
      }
    }
    async function onIdle(cfg, key, sid) {
      const now = Date.now();
      const doNotify = await mutateState2((s) => {
        const li = s.lastIdle[sid] ?? 0;
        if (now - li < 1500 && (s.lastBusy[sid] ?? 0) < li) return false;
        s.lastIdle[sid] = now;
        return true;
      });
      if (!doNotify) return;
      const awaiting = await mutateState2((s) => {
        const a = s.awaiting[sid];
        if (a) delete s.awaiting[sid];
        return a ?? null;
      });
      const t = await displayTitle(sid, key);
      const title = t.title;
      if (awaiting && cfg.relay) {
        let excerpt = "";
        try {
          const regKey = (await loadState()).sessions[sid]?.key ?? awaiting.key;
          const msgs = await submitAction(regKey, "session.messages", { sessionID: sid, limit: 20 }, 8e3);
          const arr = Array.isArray(msgs) ? msgs : [];
          const cutoff = awaiting.at - 15e3;
          let startIdx = 0;
          for (let i = arr.length - 1; i >= 0; i--) {
            const m = arr[i];
            if (m?.info?.role === "user" && (m?.info?.time?.created ?? 0) >= cutoff) {
              startIdx = i + 1;
              break;
            }
          }
          const win = arr.slice(startIdx);
          for (let i = win.length - 1; i >= 0 && !excerpt; i--) {
            const m = win[i];
            if (m?.info?.role !== "assistant") continue;
            const t2 = (m.parts ?? []).filter((pt) => pt?.type === "text" && typeof pt.text === "string" && pt.text.trim()).map((pt) => pt.text).join("\n").trim();
            if (t2) excerpt = t2;
          }
          if (!excerpt) {
            for (let i = win.length - 1; i >= 0 && !excerpt; i--) {
              const m = win[i];
              for (const pt of m?.parts ?? []) {
                if (pt?.type !== "tool") continue;
                const out = typeof pt.state?.output === "string" ? pt.state.output.trim() : "";
                const cmd = typeof pt.state?.input?.command === "string" ? pt.state.input.command : "";
                if (out) {
                  excerpt = `\u{1F527} ${pt.tool}: ${clip(out, 700)}`;
                  break;
                }
                if (cmd) {
                  excerpt = `\u{1F527} ${pt.tool}: ${clip(cmd, 300)}`;
                  break;
                }
              }
            }
          }
        } catch (e) {
          log("debug", `relay fetch: ${e?.message ?? e}`);
        }
        for (const chatId of awaiting.chats) {
          if (!cfg.authorizedChatIds.includes(chatId)) continue;
          const body = awaiting.error ? `\u26A0\uFE0F ${title}: ${clip(awaiting.error, 400)}${excerpt ? `

last reply:
${clip(excerpt, 2700)}` : ""}

You can send a new instruction now.` : excerpt ? `\u2705 ${title} finished

${clip(excerpt, 3400)}` : `\u2705 ${title} finished

(no text reply \u2014 check the app)`;
          const mid = awaiting.cards?.[String(chatId)];
          if (mid) await editMessage(chatId, mid, body).catch(() => false);
          await tgSend(cfg, chatId, body).catch((e) => log("warn", `finish send ${chatId}: ${e?.message ?? e}`));
        }
        await maybeRefreshPanels(awaiting.chats);
        return;
      }
      if (t.isSub) {
        log("debug", `subagent idle ${sid} folded into parent (no separate notification)`);
        return;
      }
      if (cfg.notify.idle) await broadcast(cfg, `\u2705 ${title} finished`);
    }
    async function notifyPermission(cfg, key, p) {
      if (!cfg.notify.permission) return;
      const id = p?.id;
      if (!id) return;
      const prompts = await loadPrompts();
      if (prompts[id]) return;
      const t = await displayTitle(p.sessionID, key);
      const text = permCardText2(t, p);
      const keyboard = permCardKeyboard2(id);
      const rec = {
        kind: "permission",
        key,
        dir: t.dir,
        sessionID: p.sessionID,
        sentAt: Date.now(),
        msgs: [],
        permission: p
      };
      for (const chatId of cfg.authorizedChatIds) {
        try {
          const mid = await tgSend(cfg, chatId, text, keyboard);
          if (mid) rec.msgs.push({ chatId, messageId: mid });
        } catch (e) {
          log("warn", `permission notify ${chatId}: ${e?.message ?? e}`);
        }
      }
      if (rec.msgs.length) await mutatePrompts((pr) => void (pr[id] = rec));
      log("info", `permission.asked ${id} session=${p.sessionID} notified=${rec.msgs.length}`);
      await maybeRefreshPanels(cfg.authorizedChatIds);
    }
    async function notifyQuestion(cfg, key, p) {
      if (!cfg.notify.question) return;
      const id = p?.id;
      if (!id) return;
      const prompts = await loadPrompts();
      if (prompts[id]) return;
      const t = await displayTitle(p.sessionID, key);
      const questions = Array.isArray(p.questions) ? p.questions : [];
      if (!questions.length) return;
      const single = questions.length === 1 && !questions[0].multiple;
      const text = questionCardText2(t, questions);
      const selections = questions.map(() => []);
      const keyboard = buildQuestionKeyboard2(id, questions, selections, single);
      const rec = {
        kind: "question",
        key,
        dir: t.dir,
        sessionID: p.sessionID,
        sentAt: Date.now(),
        msgs: [],
        questions,
        selections,
        baseText: text
      };
      for (const chatId of cfg.authorizedChatIds) {
        try {
          const mid = await tgSend(cfg, chatId, text, keyboard);
          if (mid) rec.msgs.push({ chatId, messageId: mid });
        } catch (e) {
          log("warn", `question notify ${chatId}: ${e?.message ?? e}`);
        }
      }
      if (rec.msgs.length) await mutatePrompts((pr) => void (pr[id] = rec));
      log("info", `question.asked ${id} session=${p.sessionID}`);
      await maybeRefreshPanels(cfg.authorizedChatIds);
    }
    async function onPermissionReplied(p) {
      const id = p.requestID;
      if (!id) return;
      await mutatePrompts((pr) => {
        const rec = pr[id];
        if (!rec || rec.handled) return;
        rec.handled = true;
        for (const m of rec.msgs)
          void editMessage(m.chatId, m.messageId, `\u2611\uFE0F answered in app: ${p.reply ?? ""}`).catch(() => {
          });
      });
    }
    async function onQuestionReplied(p) {
      const id = p.requestID;
      if (!id) return;
      const answers = (p.answers ?? []).flat().join(", ");
      await mutatePrompts((pr) => {
        const rec = pr[id];
        if (!rec || rec.handled) return;
        rec.handled = true;
        for (const m of rec.msgs) void editMessage(m.chatId, m.messageId, `\u2611\uFE0F answered in app: ${clip(answers, 300)}`).catch(() => {
        });
      });
    }
    async function onQuestionRejected(p) {
      const id = p.requestID;
      if (!id) return;
      await mutatePrompts((pr) => {
        const rec = pr[id];
        if (!rec || rec.handled) return;
        rec.handled = true;
        for (const m of rec.msgs) void editMessage(m.chatId, m.messageId, `\u2611\uFE0F dismissed in app`).catch(() => {
        });
      });
    }
    async function broadcast(cfg, text) {
      for (const chatId of cfg.authorizedChatIds) {
        await tgSend(cfg, chatId, text).catch((e) => log("warn", `broadcast ${chatId}: ${e?.message ?? e}`));
      }
    }
    async function httpConnectTunnel(proxy, host, port, timeoutMs) {
      const sock = net.connect({ host: proxy.hostname || "127.0.0.1", port: Number(proxy.port || 8080) });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          try {
            sock.destroy();
          } catch {
          }
          reject(new Error(`timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        sock.once("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        sock.once("connect", () => {
          let auth = "";
          if (proxy.username) {
            auth = `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r
`;
          }
          sock.write(`CONNECT ${host}:${port} HTTP/1.1\r
Host: ${host}:${port}\r
${auth}\r
`, (err) => {
            clearTimeout(timer);
            if (err) reject(err);
            else resolve();
          });
        });
      }).catch((e) => {
        try {
          sock.destroy();
        } catch {
        }
        throw e;
      });
      const head = await readSock2(sock, (b) => b.indexOf("\r\n\r\n") >= 0 ? null : 1, timeoutMs);
      const statusLine = head.slice(0, head.indexOf("\r\n")).toString().trim();
      const m = statusLine.match(/^HTTP\/\S+\s+(\d+)/);
      if (!m || Number(m[1]) !== 200) {
        try {
          sock.destroy();
        } catch {
        }
        throw new Error(`proxy refused CONNECT (${statusLine || "no status line"})`);
      }
      return sock;
    }
    async function socksConnectTunnel(proxy, host, port, timeoutMs) {
      const sock = net.connect({ host: proxy.hostname || "127.0.0.1", port: Number(proxy.port || 1080) });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          try {
            sock.destroy();
          } catch {
          }
          reject(new Error(`timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        sock.once("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        sock.once("connect", () => {
          clearTimeout(timer);
          resolve();
        });
      }).catch((e) => {
        try {
          sock.destroy();
        } catch {
        }
        throw e;
      });
      const write = (b) => new Promise((resolve, reject) => {
        sock.write(b, (err) => err ? reject(err) : resolve());
      });
      const hasAuth = !!proxy.username;
      await write(Buffer.from(hasAuth ? [5, 2, 0, 2] : [5, 1, 0]));
      const methodPick = await readSock2(sock, (b) => b.length >= 2 ? null : 2, timeoutMs);
      if (methodPick[0] !== 5) {
        try {
          sock.destroy();
        } catch {
        }
        throw new Error("proxy is not SOCKS5");
      }
      if (methodPick[1] === 2) {
        if (!hasAuth) {
          try {
            sock.destroy();
          } catch {
          }
          throw new Error("proxy requires username/password authentication");
        }
        const user = Buffer.from(decodeURIComponent(proxy.username), "utf8");
        const pass = Buffer.from(decodeURIComponent(proxy.password), "utf8");
        if (user.length > 255 || pass.length > 255) {
          try {
            sock.destroy();
          } catch {
          }
          throw new Error("proxy username/password too long (max 255 bytes)");
        }
        await write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
        const authRes = await readSock2(sock, (b) => b.length >= 2 ? null : 2, timeoutMs);
        if (authRes[0] !== 1 || authRes[1] !== 0) {
          try {
            sock.destroy();
          } catch {
          }
          throw new Error("proxy authentication failed (bad username/password?)");
        }
      } else if (methodPick[1] !== 0) {
        try {
          sock.destroy();
        } catch {
        }
        throw new Error("proxy offered no usable auth method");
      }
      let atyp;
      let addr;
      if (net.isIP(host) === 4) {
        atyp = 1;
        addr = Buffer.from(host.split(".").map((x) => Number(x)));
      } else if (net.isIP(host) === 6) {
        try {
          sock.destroy();
        } catch {
        }
        throw new Error("IPv6 targets are not supported through SOCKS in this build");
      } else {
        const name = Buffer.from(host, "utf8");
        if (name.length > 255) {
          try {
            sock.destroy();
          } catch {
          }
          throw new Error("hostname too long for SOCKS");
        }
        atyp = 3;
        addr = Buffer.concat([Buffer.from([name.length]), name]);
      }
      const req = Buffer.alloc(4 + addr.length + 2);
      req[0] = 5;
      req[1] = 1;
      req[2] = 0;
      req[3] = atyp;
      addr.copy(req, 4);
      req.writeUInt16BE(port, 4 + addr.length);
      await write(req);
      const head = await readSock2(sock, (b) => {
        if (b.length < 4) return 4;
        const ra = b[3];
        if (ra === 1) return b.length >= 10 ? null : 10;
        if (ra === 4) return b.length >= 22 ? null : 22;
        if (ra === 3) {
          if (b.length < 5) return 5;
          return b.length >= 5 + b[4] + 2 ? null : 5 + b[4] + 2;
        }
        return null;
      }, timeoutMs);
      if (head[0] !== 5 || head[1] !== 0) {
        const reasons = { 1: "general failure", 2: "not allowed by ruleset", 3: "network unreachable", 4: "host unreachable", 5: "connection refused", 6: "TTL expired", 7: "command not supported", 8: "address type not supported" };
        try {
          sock.destroy();
        } catch {
        }
        throw new Error(`proxy refused the connection (SOCKS error ${head[1]}: ${reasons[head[1]] ?? "unknown"})`);
      }
      return sock;
    }
    async function tgPostViaProxy(proxyUrl, url, body, contentType, timeoutMs) {
      let proxy;
      try {
        proxy = new URL(proxyUrl);
      } catch {
        throw new Error(`bad proxy URL ${redactProxy2(proxyUrl)} \u2014 use http://host:port or socks5://host:port`);
      }
      const scheme = proxy.protocol.replace(/:$/, "");
      if (scheme !== "http" && scheme !== "socks5" && scheme !== "socks5h") {
        throw new Error(`unsupported proxy scheme "${proxy.protocol}" (${redactProxy2(proxyUrl)}) \u2014 use http:// or socks5:// (MTProto proxies cannot carry Bot API traffic)`);
      }
      if (!proxy.hostname) throw new Error(`proxy URL has no host: ${redactProxy2(proxyUrl)}`);
      const label = redactProxy2(proxyUrl);
      const target = new URL(url);
      const targetPort = Number(target.port || (target.protocol === "https:" ? 443 : 80));
      let sock;
      try {
        sock = scheme === "http" ? await httpConnectTunnel(proxy, target.hostname, targetPort, Math.min(timeoutMs, 2e4)) : await socksConnectTunnel(proxy, target.hostname, targetPort, Math.min(timeoutMs, 2e4));
      } catch (e) {
        throw new Error(`proxy ${label} unreachable: ${e?.message ?? e} \u2014 is your proxy running?`);
      }
      return await new Promise((resolve, reject) => {
        let settled = false;
        let stream = sock;
        const timer = setTimeout(() => {
          fail(new Error(`Telegram request via ${label} timed out after ${timeoutMs}ms \u2014 Telegram may be filtered on this network`));
        }, timeoutMs);
        const fail = (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            stream.destroy();
          } catch {
          }
          const msg = String(e?.message ?? e);
          reject(new Error(`Telegram via proxy ${label} failed: ${msg}`));
        };
        const chunks = [];
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            stream.destroy();
          } catch {
          }
          const raw = Buffer.concat(chunks).toString("utf8");
          const idx = raw.indexOf("\r\n\r\n");
          const payload = idx >= 0 ? raw.slice(idx + 4) : raw;
          try {
            resolve(JSON.parse(payload));
          } catch {
            reject(new Error(`proxy ${label} returned non-JSON from Telegram (first bytes: ${clip(payload.slice(0, 80), 80)})`));
          }
        };
        const headerText = `POST ${target.pathname}${target.search} HTTP/1.1\r
Host: ${target.hostname}\r
Content-Type: ${contentType}\r
Content-Length: ${body.length}\r
Connection: close\r
\r
`;
        const startIO = () => {
          stream.on("data", (c) => chunks.push(c));
          stream.once("error", fail);
          stream.once("end", finish);
          stream.once("close", () => {
            if (!settled) {
              if (chunks.length) finish();
              else fail(new Error("connection closed before any response"));
            }
          });
          stream.write(headerText, (err) => {
            if (err) {
              fail(err);
              return;
            }
            stream.write(body, (err2) => {
              if (err2) fail(err2);
            });
          });
        };
        if (target.protocol === "https:") {
          try {
            const tlsSock = tls.connect({ socket: sock, servername: target.hostname, timeout: timeoutMs });
            stream = tlsSock;
            tlsSock.once("secureConnect", startIO);
            tlsSock.once("error", fail);
          } catch (e) {
            fail(e);
          }
        } else {
          startIO();
        }
      });
    }
    async function tgApi(cfg, method, params, timeoutMs = 35e3, raw) {
      let j;
      if (raw) {
        if (cfg.proxy) {
          j = await tgPostViaProxy(cfg.proxy, `${cfg.apiBase}/bot${cfg.botToken}/${method}`, raw.body, raw.contentType, timeoutMs);
        } else {
          const res = await fetch(`${cfg.apiBase}/bot${cfg.botToken}/${method}`, {
            method: "POST",
            headers: { "content-type": raw.contentType },
            body: raw.body,
            signal: AbortSignal.timeout(timeoutMs)
          });
          j = await res.json().catch(() => ({ ok: false, description: `http ${res.status}` }));
        }
      } else if (cfg.proxy) {
        j = await tgPostViaProxy(cfg.proxy, `${cfg.apiBase}/bot${cfg.botToken}/${method}`, Buffer.from(JSON.stringify(params), "utf8"), "application/json", timeoutMs);
      } else {
        const res = await fetch(`${cfg.apiBase}/bot${cfg.botToken}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(timeoutMs)
        });
        j = await res.json().catch(() => ({ ok: false, description: `http ${res.status}` }));
      }
      if (!j.ok) {
        const err = new Error(`${method}: ${j.description ?? "failed"}`);
        err.telegram = true;
        err.code = j.error_code;
        throw err;
      }
      return j.result;
    }
    async function tgSendDocument(cfg, chatId, filename, content, caption) {
      const raw = buildMultipart2(
        { chat_id: String(chatId), ...caption ? { caption: clip(caption, 1024) } : {} },
        { field: "document", filename, contentType: "text/markdown", content: Buffer.from(content, "utf8") }
      );
      try {
        const r = await tgApi(cfg, "sendDocument", {}, 6e4, raw);
        void noteSendOk();
        return r?.message_id ?? null;
      } catch (e) {
        if (e?.telegram && e.code && e.code < 500) throw e;
        await new Promise((r) => setTimeout(r, 1200));
        try {
          const r = await tgApi(cfg, "sendDocument", {}, 6e4, raw);
          void noteSendOk();
          return r?.message_id ?? null;
        } catch (e2) {
          if (e2?.telegram && e2.code && e2.code < 500) throw e2;
          void noteSendFail(e2);
          throw e2;
        }
      }
    }
    let sendFails = 0;
    async function noteSendOk() {
      sendFails = 0;
      try {
        const s = await loadState();
        if (s.link?.status === "offline") await setLinkOnline("send succeeded");
      } catch {
      }
    }
    async function noteSendFail(e) {
      sendFails++;
      const short = e?.telegram ? `Telegram error ${e.code ?? "?"}: ${clip(String(e.message).replace(/^sendMessage:\s*/, ""), 120)}` : shortNetError2(e);
      if (sendFails === 1) log("warn", `sendMessage failed (${short}) \u2014 retrying automatically`);
      else log("debug", `sendMessage failed (${short}) [${sendFails} in a row]`);
      if (sendFails >= 3) {
        try {
          const s = await loadState();
          if (s.link?.status !== "offline") await setLinkOffline(short);
        } catch {
        }
      }
    }
    async function tgSend(cfg, chatId, text, keyboard) {
      const params = { chat_id: chatId, text: clip(text) };
      if (keyboard) params.reply_markup = keyboard;
      try {
        const r = await tgApi(cfg, "sendMessage", params);
        void noteSendOk();
        return r?.message_id ?? null;
      } catch (e) {
        if (e?.telegram && e.code && e.code < 500) throw e;
        await new Promise((r) => setTimeout(r, 1200));
        try {
          const r = await tgApi(cfg, "sendMessage", params);
          void noteSendOk();
          return r?.message_id ?? null;
        } catch (e2) {
          if (e2?.telegram && e2.code && e2.code < 500) throw e2;
          void noteSendFail(e2);
          throw e2;
        }
      }
    }
    async function editMessage(chatId, messageId, text, keyboard) {
      const cfg = await loadConfig();
      const params = { chat_id: chatId, message_id: messageId, text: clip(text) };
      if (keyboard) params.reply_markup = keyboard;
      else params.reply_markup = { inline_keyboard: [] };
      try {
        await tgApi(cfg, "editMessageText", params);
        return true;
      } catch (e) {
        const d = String(e?.message ?? "");
        if (d.includes("message is not modified") || d.includes("message to edit not found")) return true;
        log("warn", `editMessage ${messageId} failed: ${d}`);
        return false;
      }
    }
    async function answerCallback(id, text, alert = false) {
      try {
        const cfg = await loadConfig();
        await tgApi(cfg, "answerCallbackQuery", {
          callback_query_id: id,
          ...text ? { text: clip(text, 200) } : {},
          show_alert: alert
        });
      } catch (e) {
        log("debug", `answerCallback: ${e?.message ?? e}`);
      }
    }
    async function announcePairing(req) {
      const msg = `\u{1F510} Pairing request from "${req.name}" (chat ${req.chatId}) \u2014 code ${req.code} (10 min)`;
      try {
        console.log(`[raven] ${msg}`);
      } catch {
      }
      macNotify2("Raven \u2014 pairing", `Code ${req.code} \u2014 send /pair ${req.code} to the bot`);
      log("info", msg);
    }
    async function askOwnersToApprove(cfg, req) {
      const text = `\u{1F510} Pairing request: "${req.name}" (chat ${req.chatId})
Their code: ${req.code}
Approve this account?`;
      const kb = {
        inline_keyboard: [
          [{ text: "\u2705 Approve", callback_data: `s:ap:ok:${req.chatId}` }, { text: "\u274C Deny", callback_data: `s:ap:no:${req.chatId}` }]
        ]
      };
      for (const chatId of cfg.authorizedChatIds) {
        if (chatId === req.chatId) continue;
        await tgSend(cfg, chatId, text, kb).catch(() => {
        });
      }
    }
    async function patchConfigAddChat(chatId) {
      const cur = await readJSON(CFG_FILE, {});
      const ids = /* @__PURE__ */ new Set();
      for (const x of Array.isArray(cur?.authorizedChatIds) ? cur.authorizedChatIds : []) ids.add(Number(x));
      for (const x of Array.isArray(cur?.chatIds) ? cur.chatIds : []) ids.add(Number(x));
      ids.add(chatId);
      const next = { ...cur, authorizedChatIds: [...ids] };
      delete next.chatIds;
      await atomicWrite2(CFG_FILE, JSON.stringify(next, null, 2), 384);
      log("info", `paired chat ${chatId}`);
    }
    async function patchConfigRemoveChat(chatId) {
      const cur = await readJSON(CFG_FILE, {});
      const ids = /* @__PURE__ */ new Set();
      for (const x of Array.isArray(cur?.authorizedChatIds) ? cur.authorizedChatIds : []) ids.add(Number(x));
      for (const x of Array.isArray(cur?.chatIds) ? cur.chatIds : []) ids.add(Number(x));
      ids.delete(chatId);
      const next = { ...cur, authorizedChatIds: [...ids] };
      delete next.chatIds;
      await atomicWrite2(CFG_FILE, JSON.stringify(next, null, 2), 384);
      log("info", `unpaired chat ${chatId}`);
    }
    async function completePairing(cfg, req) {
      await patchConfigAddChat(req.chatId);
      await mutateState2((s) => {
        if (s.pairing && s.pairing.chatId === req.chatId) s.pairing = null;
      });
      const fresh = await loadConfig();
      const hello2 = [`\u2705 Paired! ${fresh.botName} is connected to your coding agents.`, ``, "Type any message to talk, or use the buttons below."];
      if (fresh.botName) {
        try {
          await tgApi(fresh, "setMyName", { name: clip(fresh.botName, 64) });
        } catch {
        }
      }
      await tgSend(fresh, req.chatId, hello2.join("\n"), menuKeyboard()).catch(() => {
      });
      await showPanel(req.chatId, { name: "home" }, true);
      for (const chatId of fresh.authorizedChatIds) {
        if (chatId === req.chatId) continue;
        await tgSend(fresh, chatId, `\u2705 "${req.name}" (chat ${req.chatId}) is now paired. Revoke with /unpair ${req.chatId}.`).catch(() => {
        });
      }
    }
    async function pairRequest(cfg, chatId, name) {
      const prev = (await loadState()).pairing;
      if (prev && prev.chatId === chatId && Date.now() - prev.createdAt < PAIR_TTL_MS && prev.attempts < PAIR_MAX_ATTEMPTS) {
        await tgSend(cfg, chatId, pairingHelp2(prev.code));
        return;
      }
      const req = { code: makePairCode2(), chatId, name, createdAt: Date.now(), attempts: 0, ownerApproved: false };
      await mutateState2((s) => void (s.pairing = req));
      await announcePairing(req);
      if (cfg.ownerApprove) await askOwnersToApprove(cfg, req);
      await tgSend(cfg, chatId, pairingHelp2(req.code));
    }
    async function tryPairCode(cfg, chatId, text) {
      const t = text.trim();
      const explicit = /^\/pair(?:ing)?\s+(\S+)$/i.exec(t);
      const bare = /^[A-HJ-KM-NP-Z2-9]{6}$/i.test(t) ? t : "";
      const code = String(explicit?.[1] ?? bare).toUpperCase().replace(/O/g, "0").replace(/I|L/g, "1");
      if (!code) return false;
      const st = await loadState();
      const req = st.pairing;
      if (!req || Date.now() - req.createdAt > PAIR_TTL_MS) {
        await tgSend(cfg, chatId, `No active pairing code here. Send /start to request one.`);
        return true;
      }
      if (req.chatId !== chatId || req.code !== code) {
        const attempts = (req.attempts ?? 0) + 1;
        const over = attempts >= PAIR_MAX_ATTEMPTS;
        await mutateState2((s) => {
          if (!s.pairing) return;
          if (over) s.pairing = null;
          else s.pairing.attempts = attempts;
        });
        await tgSend(cfg, chatId, over ? `Wrong code too many times \u2014 pairing revoked. /start for a fresh code.` : `Wrong code \u2014 ${PAIR_MAX_ATTEMPTS - attempts} tries left.`);
        return true;
      }
      if (cfg.ownerApprove && !req.ownerApproved) {
        await mutateState2((s) => {
          if (s.pairing && s.pairing.chatId === chatId) s.pairing.codeConfirmed = true;
        });
        await tgSend(cfg, chatId, `\u2705 Code confirmed! Waiting for an owner on another paired device to approve.`);
        return true;
      }
      await completePairing(cfg, req);
      return true;
    }
    async function handlePairDecision(cfg, fromChat, targetChat, ok) {
      const st = await loadState();
      const req = st.pairing;
      if (!req || req.chatId !== targetChat) {
        await tgSend(cfg, fromChat, `No pending pairing request for chat ${targetChat}.`);
        return;
      }
      if (!ok) {
        await mutateState2((s) => {
          if (s.pairing && s.pairing.chatId === targetChat) s.pairing = null;
        });
        await tgSend(cfg, fromChat, `\u274C Pairing for "${req.name}" (chat ${targetChat}) denied.`);
        await tgSend(cfg, targetChat, `\u274C Your pairing request was denied.`).catch(() => {
        });
        return;
      }
      if (req.codeConfirmed) {
        await completePairing(cfg, req);
        await tgSend(cfg, fromChat, `\u2705 "${req.name}" (chat ${targetChat}) paired.`).catch(() => {
        });
        return;
      }
      await mutateState2((s) => {
        if (s.pairing && s.pairing.chatId === targetChat) s.pairing.ownerApproved = true;
      });
      await tgSend(cfg, fromChat, `\u2705 Approved. Ask them to send /pair ${req.code} now.`);
      await tgSend(cfg, targetChat, `\u2705 Approved by the owner! Send /pair ${req.code} to finish.`).catch(() => {
      });
    }
    async function handleUpdate(u) {
      const cfg = await loadConfig();
      if (!cfg.enabled || !cfg.botToken) return;
      if (u.callback_query) {
        const cq = u.callback_query;
        const chatId = Number(cq.from?.id);
        if (!cfg.authorizedChatIds.includes(chatId)) {
          log("warn", `rejected callback from unpaired chat ${chatId}`);
          return;
        }
        await handleCallback(cfg, chatId, cq).catch((e) => {
          log("warn", `callback: ${e?.message ?? e}`);
          void answerCallback(cq.id).catch(() => {
          });
        });
        return;
      }
      if (u.message) {
        const m = u.message;
        const chatId = Number(m.chat?.id);
        const text = typeof m.text === "string" ? m.text : "";
        if (!cfg.authorizedChatIds.includes(chatId)) {
          const t = text.trim().toLowerCase();
          if (t === "/start" || t === "/help" || t === "/ping" || t === "/pair") {
            const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") || String(m.from?.username ?? "user");
            await pairRequest(cfg, chatId, name);
            return;
          }
          if (await tryPairCode(cfg, chatId, text)) return;
          log("info", `ignored message from unpaired chat ${chatId}`);
          return;
        }
        if (text.length) {
          log("info", `command from ${chatId}: ${text.split(/\s+/)[0].slice(0, 30)}`);
          await handleCommand(cfg, chatId, text).catch((e) => {
            log("warn", `command: ${e?.message ?? e}`);
            void tgSend(cfg, chatId, `\u26A0\uFE0F ${clip(String(e?.message ?? e), 500)}`).catch(() => {
            });
          });
        }
      }
    }
    async function tryEditMessage(chatId, messageId, text, keyboard) {
      const cfg = await loadConfig();
      const params = { chat_id: chatId, message_id: messageId, text: clip(text) };
      if (keyboard) params.reply_markup = keyboard;
      else params.reply_markup = { inline_keyboard: [] };
      try {
        await tgApi(cfg, "editMessageText", params);
        return "ok";
      } catch (e) {
        const d = String(e?.message ?? "");
        if (d.includes("message is not modified")) return "ok";
        if (d.includes("message to edit not found") || d.includes("message can't be edited") || d.includes("MESSAGE_ID_INVALID")) return "gone";
        log("debug", `editMessage: ${d}`);
        return "error";
      }
    }
    async function getUI(chatId) {
      const st = await loadState();
      return st.chats[chatId]?.ui ?? { screen: { name: "home" } };
    }
    async function setScreen(chatId, screen, panelId) {
      await mutateState2((s) => {
        const c = s.chats[chatId] ?? (s.chats[chatId] = {});
        c.ui = { screen, ...panelId !== void 0 ? { panelId } : c.ui?.panelId !== void 0 ? { panelId: c.ui.panelId } : {} };
      });
    }
    async function showPanel(chatId, screen, fresh = false) {
      const cfg = await loadConfig();
      const ui = await getUI(chatId);
      const target = screen ?? ui.screen;
      const view = await renderScreen(chatId, target);
      if (!view) {
        return;
      }
      if (!fresh && ui.panelId) {
        const res = await tryEditMessage(chatId, ui.panelId, view.text, view.keyboard);
        if (res === "ok") {
          if (screen) await setScreen(chatId, screen);
          return;
        }
        if (res === "error") log("warn", `panel edit failed, sending a fresh message instead (see debug log for reason)`);
      }
      const uiNow = await getUI(chatId);
      if (!uiNow.menuSent) {
        await tgSend(cfg, chatId, `\u{1F39B} Use the buttons below to navigate.`, menuKeyboard()).catch(() => null);
        await mutateState2((s) => {
          const c = s.chats[chatId] ?? (s.chats[chatId] = {});
          c.ui = { ...c.ui ?? { screen: target }, menuSent: true };
        });
      }
      let mid = null;
      try {
        mid = await tgSend(cfg, chatId, view.text, view.keyboard);
      } catch (e) {
        mid = null;
      }
      await setScreen(chatId, target, mid ?? void 0);
    }
    async function setFocus(chatId, ref) {
      await mutateState2((s) => {
        s.chats[chatId] = { ...s.chats[chatId] ?? {}, active: { ...ref } };
      });
    }
    async function getFocus(chatId) {
      const st = await loadState();
      return st.chats[chatId]?.active ?? null;
    }
    async function maybeRefreshPanels(chatIds) {
      for (const chatId of chatIds) {
        try {
          const ui = await getUI(chatId);
          if (ui.screen.name === "home" || ui.screen.name === "inbox" || ui.screen.name === "session") {
            if (ui.panelId) await showPanel(chatId);
          }
        } catch {
        }
      }
    }
    async function collectPending() {
      const keys = await liveKeys();
      const results = await Promise.all(keys.map((k) => submitAction(k, "pending", {}, 7e3).catch(() => null)));
      let perms = [];
      let questions = [];
      for (const r of results) {
        if (!r) continue;
        perms = perms.concat(r.permissions ?? []);
        questions = questions.concat(r.questions ?? []);
      }
      return { perms, questions };
    }
    async function getKnownDirs() {
      const out = [];
      const seen = /* @__PURE__ */ new Set();
      const push = (upOnly) => {
        for (const [key, v] of instances.entries()) {
          if (upOnly ? !isInstanceUp2(v) : Date.now() - v.lastSeen > 3e5) continue;
          if (!v.dir || seen.has(v.dir)) continue;
          seen.add(v.dir);
          out.push({ dir: v.dir, key });
        }
      };
      push(true);
      if (!out.length) push(false);
      return out;
    }
    async function renderHome(chatId) {
      const cfg = await loadConfig();
      const focus = await getFocus(chatId);
      const focusKey = focus ? (await loadState()).sessions[focus.sid]?.key ?? focus.key : null;
      const [pendingRes, detailRes, gitRes] = await Promise.all([
        collectPending(),
        focus && focusKey ? submitAction(focusKey, "session.detail", { sessionID: focus.sid }, 8e3).catch(() => null) : Promise.resolve(null),
        focus && focusKey ? submitAction(focusKey, "git.state", { dir: focus.dir }, 5e3).catch(() => null) : Promise.resolve(null)
      ]);
      const { perms, questions } = pendingRes;
      const detail = detailRes;
      const pendingLine = perms.length || questions.length ? `\u{1F4E5} ${perms.length + questions.length} waiting on you \u2014 send /inbox to review` : `\u{1F4E5} Inbox clear`;
      const link = (await loadState()).link;
      const linkLine = link?.status === "offline" ? `\u{1F4E1} Telegram: \u274C unreachable${link.since ? ` since ${new Date(link.since).toLocaleTimeString()}` : ""}${link.lastError ? ` \u2014 ${link.lastError}` : ""}
Check proxy/VPN on the Mac; the bridge reconnects automatically.` : link?.status === "starting" ? `\u{1F4E1} Telegram: \u2026connecting` : `\u{1F4E1} Telegram: \u2705 connected${cfg.proxy ? ` via ${redactProxy2(cfg.proxy)}` : ""}`;
      if (!focus) {
        return {
          text: clip(
            [`\u{1F3E0} ${cfg.botName}`, ...cfg.botDescription ? [cfg.botDescription] : [], "", "No session focused yet.", pendingLine, linkLine, "", "Browse your sessions or start a new one."].join("\n"),
            3900
          ),
          keyboard: { inline_keyboard: [[{ text: "\u{1F4DA} Browse sessions", callback_data: "s:sessions" }], [{ text: "\u2795 New session", callback_data: "s:new" }]] }
        };
      }
      const busy = detail?.status?.type === "busy";
      const lastUserHome = [...detail?.messages ?? []].reverse().find((m) => m?.info?.role === "user");
      const lastUserHomeText = lastUserHome ? (lastUserHome.parts ?? []).filter((p) => p?.type === "text" && typeof p.text === "string" && p.text.trim()).map((p) => String(p.text).trim()).join("\n").trim() : "";
      const kids = detail?.children ?? [];
      const info = detail?.info;
      const stH = await loadState();
      const regH = stH.sessions[focus.sid];
      const agentH = stH.chats[chatId]?.agent;
      const modelH = agentH?.model ?? regH?.model ?? modelFromInfo(info?.model);
      const modeH = agentH ? "build" : modeOf(regH?.agent ?? info?.agent);
      const clientH = regH?.client ?? clientOf2(focus.sid);
      const branchH = gitRes?.branch ? ` \xB7 \u{1F33F} ${gitRes.branch}` : "";
      const text = clip(
        [
          `\u{1F3E0} ${info?.title || focus.title}`,
          `${formatStatus2(!!busy)} \xB7 ${baseDir(info?.directory ?? focus.dir)}${branchH} \xB7 updated ${timeAgo(info?.time?.updated ?? 0)}`,
          `\u{1F9E0} ${modelLabelOf(modelH)} \xB7 ${modeH === "build" && agentH ? "\u{1F6E0} build" : modeButtonLabel(modeH)}${clientH && clientH !== "oc" ? ` \xB7 ${clientIcon2(clientH)} ${clientName2(clientH)}` : ""}`,
          ...agentH ? [`\u{1F916} @${agentH.agent} workspace is OPEN \u2014 everything you type goes to it`] : [],
          ...kids.length ? [`\u21B3 ${kids.length} subagent${kids.length > 1 ? "s" : ""} active`] : [],
          ``,
          ...lastUserHomeText ? ["Latest:", `\u{1F464} ${clip(lastUserHomeText.replace(/\s+/g, " "), 300)}`, ``] : [],
          pendingLine,
          linkLine,
          ``,
          agentH ? `Type to talk to @${agentH.agent} \xB7 /agent close to leave` : `Type to talk here \xB7 Sessions to switch`
        ].join("\n"),
        3900
      );
      return {
        text,
        keyboard: {
          inline_keyboard: [
            [{ text: "\u{1F4AC} Open workspace", callback_data: `s:session:${focus.sid}` }],
            ...agentH ? [[{ text: `\u{1F916} @${agentH.agent} workspace`, callback_data: `s:session:${agentH.sid}` }, { text: "\u23F9 Close agent", callback_data: "s:ag:close" }]] : [],
            ...busy ? [[{ text: "\u23F9 Stop turn", callback_data: `s:abort:${focus.sid}` }]] : []
          ]
        }
      };
    }
    async function renderSessionsPage(chatId, page) {
      const list = await collectSessions();
      lastLists.set(chatId, list);
      const perPage = 8;
      const pages = Math.max(1, Math.ceil(list.length / perPage));
      const pg = Math.min(Math.max(0, page), pages - 1);
      const shown = list.slice(pg * perPage, pg * perPage + perPage);
      const st = await loadState();
      const focusSid = st.chats[chatId]?.active?.sid;
      const lines = [];
      const rows = [];
      const groups = /* @__PURE__ */ new Map();
      for (const s of shown) {
        const g = `${baseDir(s.dir) || s.dir}|${s.client ?? "oc"}`;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(s);
      }
      for (const [g, items] of groups) {
        const [gdir, gclient] = g.split("|");
        lines.push(gclient && gclient !== "oc" ? `\u{1F4C2} ${gdir} \xB7 ${clientIcon2(gclient)} ${clientName2(gclient)}` : `\u{1F4C2} ${gdir}`, ``);
        for (const s of items) {
          const mark = s.sid === focusSid ? " \u2733" : "";
          const kids = s.children ? ` \xB7 \u21B3${s.children}` : "";
          lines.push(`${s.busy ? "\u23F3" : "\u26AA"} ${clip(s.title, 50)}${mark} \xB7 ${timeAgo(s.updated)}${kids}`);
          rows.push([{ text: `${s.busy ? "\u23F3" : ""}${clip(s.title, 30)}${s.sid === focusSid ? " \u2733" : ""}`.trim(), callback_data: `s:session:${s.sid}` }]);
        }
        lines.push(``);
      }
      const nav = [];
      if (pg > 0) nav.push({ text: "\u25C0", callback_data: `s:page:${pg - 1}` });
      if (pg < pages - 1) nav.push({ text: "\u25B6", callback_data: `s:page:${pg + 1}` });
      if (nav.length) rows.push(nav);
      rows.push([{ text: "\u{1F3E0} Home", callback_data: "s:home" }]);
      const head = list.length ? `\u{1F4DA} Sessions (${list.length}) \u2014 page ${pg + 1}/${pages}` : `\u{1F4DA} No sessions yet`;
      return { text: clip([head, "", ...lines, "", "Tap a session to open and focus it."].join("\n"), 3900), keyboard: { inline_keyboard: rows } };
    }
    async function fetchSessionDetail(sid) {
      const st = await loadState();
      const reg = st.sessions[sid];
      const key = reg?.key ?? (await liveKeys())[0];
      if (!key) return null;
      try {
        const detail = await submitAction(key, "session.detail", { sessionID: sid }, 1e4);
        if (!detail?.info) return null;
        return { key, detail };
      } catch {
        return null;
      }
    }
    async function renderTasksView(sid) {
      const st = await loadState();
      const reg = st.sessions[sid];
      const key = reg?.key ?? (await liveKeys())[0];
      if (!key) return null;
      let todos = [];
      try {
        const r = await submitAction(key, "session.tasks", { sessionID: sid }, 1e4);
        if (Array.isArray(r)) todos = r;
      } catch {
        return null;
      }
      const title = reg?.title || shortId(sid);
      const rows = [[{ text: "\u{1F4AC} Back to session", callback_data: `s:session:${sid}` }]];
      if (!todos.length) {
        return { text: `\u2611\uFE0F Tasks in ${title}

No todos in this session.`, keyboard: { inline_keyboard: rows } };
      }
      const icon = (s) => s === "completed" ? "\u2705" : s === "in_progress" ? "\u23F3" : s === "cancelled" ? "\u2796" : "\u2B1C";
      const lines = [`\u2611\uFE0F Tasks in ${title}`, ``];
      for (const t of todos.slice(0, 20)) {
        const prio = t.priority && t.priority !== "medium" ? ` [${t.priority}]` : "";
        lines.push(`${icon(String(t.status ?? ""))} ${clip(String(t.content ?? ""), 80)}${prio}`);
      }
      if (todos.length > 20) lines.push(`\u2026 +${todos.length - 20} more`);
      return { text: clip(lines.join("\n"), 3900), keyboard: { inline_keyboard: rows } };
    }
    async function renderMoreView(sid) {
      const got = await fetchSessionDetail(sid);
      if (!got) return null;
      const parent = got.detail.info;
      const kids = got.detail.children ?? [];
      const title = parent?.title || shortId(sid);
      const rows = [[{ text: "\u{1F4AC} Back to session", callback_data: `s:session:${sid}` }]];
      if (!kids.length) {
        return { text: `\u2795 More \u2014 ${title}

No subagents in this session.
Subagents appear here read-only when the agent spawns them.`, keyboard: { inline_keyboard: rows } };
      }
      const lines = [`\u2795 Subagents of ${title} (readonly)`, ``];
      for (const c of kids.slice(0, 10)) {
        const status = c.status?.type === "busy" ? "\u23F3" : "\u26AA";
        const agent = c.agent ? ` (@${c.agent})` : "";
        let preview = "";
        try {
          const msgs = await submitAction(got.key, "session.messages", { sessionID: c.id, limit: 1 }, 8e3);
          const last = Array.isArray(msgs) && msgs.length ? msgs[0] : null;
          if (last) preview = msgText(last).replace(/\s+/g, " ");
        } catch {
        }
        lines.push(`${status} ${clip(c.title || shortId(c.id), 50)}${agent}`);
        if (preview) lines.push(`   \u{1F4AC} ${clip(preview, 100)}`);
      }
      if (kids.length > 10) lines.push(`\u2026 +${kids.length - 10} more`);
      return { text: clip(lines.join("\n"), 3900), keyboard: { inline_keyboard: rows } };
    }
    async function collectModelItems(pickKey, sessionID = "") {
      let prov = null;
      try {
        prov = await submitAction(pickKey, "provider.list", { sessionID }, 1e4);
      } catch {
        return null;
      }
      const all = Array.isArray(prov?.all) ? prov.all : Array.isArray(prov) ? prov : [];
      const connected = Array.isArray(prov?.connected) ? prov.connected.map((x) => String(x)) : [];
      const items = [];
      for (const p of all) {
        const pid = String(p?.id ?? p?.providerID ?? "");
        if (!pid) continue;
        if (connected.length && !connected.includes(pid)) continue;
        const models = p?.models;
        const list = Array.isArray(models) ? models : Object.values(models ?? {});
        for (const m of list) {
          const modelID = String(m?.id ?? "");
          if (!modelID || m?.status === "deprecated") continue;
          items.push({ providerID: pid, providerName: String(p?.name ?? pid), modelID, name: String(m?.name ?? modelID) });
        }
      }
      items.sort((a, b) => a.providerName === b.providerName ? a.name.localeCompare(b.name) : a.providerName.localeCompare(b.providerName));
      return items;
    }
    async function renderModelPicker(chatId, sid, page = 0) {
      const st = await loadState();
      const reg = st.sessions[sid];
      const current = reg?.model;
      const keys = await liveKeys();
      if (!keys.length) return null;
      const pickKey = reg?.key && keys.includes(reg.key) ? reg.key : keys[0];
      const items = await collectModelItems(pickKey, sid);
      if (!items) return null;
      if (!items.length) return { text: "No models available from connected providers.", keyboard: { inline_keyboard: [[{ text: "\u{1F4AC} Back to session", callback_data: `s:session:${sid}` }]] } };
      lastPickLists.set(chatId, { kind: "model", sid, items });
      const { text, rows } = renderModelPage2(
        items,
        page,
        10,
        (p) => `s:model:${sid}:${p}`,
        (i) => `s:mpick:${i}`,
        current,
        `\u{1F9E0} Pick the model for future prompts in this session \u2014 current: ${current ? `${current.providerID}/${current.modelID}` : "unknown"}`
      );
      if (clientOf2(sid) !== "oc") rows.push([{ text: "\u2795 Other: type a model id\u2026", callback_data: `s:mc:${sid}` }]);
      if (reg?.modelPinned) {
        rows.push([{ text: "\u21A9\uFE0F Follow the app's model", callback_data: `s:mreset:${sid}` }]);
      }
      rows.push([{ text: "\u{1F4AC} Back to session", callback_data: `s:session:${sid}` }]);
      return {
        text: clip(reg?.modelPinned ? `${text}

\u{1F4CC} ${modelLabelOf(current)} is pinned from Telegram \u2014 it applies to your next message here. Use \u21A9\uFE0F above to follow the app again.` : text, 3900),
        keyboard: { inline_keyboard: rows }
      };
    }
    async function renderAgentSettings(chatId) {
      const st = await loadState();
      const ws = st.chats[chatId]?.agent;
      const cand = await agentCandidates(chatId);
      const model = ws?.model ?? (ws ? st.sessions[ws.sid]?.model : void 0);
      const modelLabel = modelLabelOf(model);
      const lines = [
        `\u{1F916} Agent workspace`,
        ``,
        ws ? `Active: @${ws.agent} \u2014 every message you type goes to it.
Model: ${modelLabel} \xB7 Mode: \u{1F6E0} build (always)` : `Not open. Pick an agent below: it gets its own session, you talk to the
agent instead of a project, and it answers in its dedicated workspace.
Always runs in build mode; set its model under \u{1F9E0} below.`
      ];
      const rows = [];
      const agents = cand?.agents ?? [];
      if (!agents.length) lines.push(``, `(no agents found \u2014 is opencode running?)`);
      if (cand?.fallback) lines.push(``, `(agent list unreachable \u2014 showing default; opening it will retry the connection)`);
      agents.slice(0, 12).forEach((a, i) => {
        const name = String(a?.name ?? a?.id ?? `agent ${i + 1}`);
        rows.push([{ text: `${ws?.agent === name ? "\u2705 " : ""}${clip(name, 30)}`, callback_data: `s:agpick:${i}` }]);
      });
      if (agents.length) lastPickLists.set(chatId, { kind: "agentcfg", sid: ws?.sid ?? "", items: agents.slice(0, 12) });
      if (rows.length) rows.push([{ text: "\u2796 tap an agent to open/switch \u2796", callback_data: "noop" }]);
      if (ws) {
        rows.push([
          { text: `\u{1F9E0} Agent model: ${clip(modelLabel, 24)}`, callback_data: "s:am:0" },
          { text: "\u23F9 Close workspace", callback_data: "s:ag:close" }
        ]);
      }
      rows.push([{ text: "\u2699\uFE0F Back to Settings", callback_data: "s:settings" }]);
      rows.push([{ text: "\u{1F3E0} Home", callback_data: "s:home" }]);
      return { text: clip(lines.join("\n"), 3900), keyboard: { inline_keyboard: rows } };
    }
    async function renderAgentModelPicker(chatId, page = 0) {
      const st = await loadState();
      const ws = st.chats[chatId]?.agent;
      if (!ws) return { text: `No agent workspace is open \u2014 pick an agent first.`, keyboard: { inline_keyboard: [[{ text: "\u{1F916} Agent workspace", callback_data: "s:ag:open" }], [{ text: "\u2699\uFE0F Settings", callback_data: "s:settings" }]] } };
      const keys = await liveKeys();
      const pickKey = keys.includes(ws.key) ? ws.key : keys[0];
      if (!pickKey) return null;
      const items = await collectModelItems(pickKey);
      if (!items) return null;
      if (!items.length) return { text: "No models available from connected providers.", keyboard: { inline_keyboard: [[{ text: "\u{1F916} Agent workspace", callback_data: "s:ag:open" }]] } };
      lastPickLists.set(chatId, { kind: "agentmodel", sid: ws.sid, items });
      const current = ws.model ?? st.sessions[ws.sid]?.model;
      const { text, rows } = renderModelPage2(items, page, 10, (p) => `s:am:${p}`, (i) => `s:ampick:${i}`, current, `\u{1F9E0} Model for @${ws.agent} (always build mode)`);
      rows.push([{ text: "\u{1F916} Back to agent workspace", callback_data: "s:ag:open" }]);
      return { text, keyboard: { inline_keyboard: rows } };
    }
    async function renderCommandPicker(chatId, sid, page = 0) {
      const st = await loadState();
      const reg = st.sessions[sid];
      if (!reg) return null;
      let cmds = [];
      try {
        const r = await submitAction(reg.key, "instance.commands", {}, 8e3);
        if (Array.isArray(r)) cmds = r;
      } catch {
        return null;
      }
      if (!cmds.length) return { text: "No commands available.", keyboard: { inline_keyboard: [[{ text: "\u{1F4AC} Back to session", callback_data: `s:session:${sid}` }]] } };
      const perPage = 8;
      const pages = Math.max(1, Math.ceil(cmds.length / perPage));
      const pg = Math.min(Math.max(0, page), pages - 1);
      const shown = cmds.slice(pg * perPage, pg * perPage + perPage);
      lastPickLists.set(chatId, { kind: "command", sid, items: shown });
      const rows = shown.map((c, i) => [{ text: clip(String(c.name ?? c.id ?? `command ${i + 1}`), 40), callback_data: `s:cmd:${i}` }]);
      const nav = [];
      if (pg > 0) nav.push({ text: "\u25C0", callback_data: `s:cmds:${sid}:${pg - 1}` });
      if (pg < pages - 1) nav.push({ text: "\u25B6", callback_data: `s:cmds:${sid}:${pg + 1}` });
      if (nav.length) rows.push(nav);
      rows.push([{ text: "\u{1F4AC} Back to session", callback_data: `s:session:${sid}` }]);
      const lines = [`\u2328\uFE0F Pick a command to run in this session (page ${pg + 1}/${pages}):`, ``];
      shown.forEach((c, i) => {
        const name = String(c.name ?? c.id ?? `command ${i + 1}`);
        const desc = c.description ? ` \u2014 ${clip(String(c.description).replace(/\s+/g, " "), 80)}` : "";
        lines.push(`${i + 1}. /${name}${desc}`);
      });
      return { text: clip(lines.join("\n"), 3900), keyboard: { inline_keyboard: rows } };
    }
    async function daemonKey() {
      for (const [k, v] of instances.entries()) if (v.client === "daemon" && isInstanceUp2(v)) return k;
      return null;
    }
    async function renderNewProject(chatId) {
      const dirs = await getKnownDirs();
      const dk = await daemonKey();
      if (!dirs.length && !dk) return { text: `\u2795 No opencode project is open right now.

Open a project in OpenCode first, then come back.`, keyboard: { inline_keyboard: [[{ text: "\u{1F3E0} Home", callback_data: "s:home" }]] } };
      lastPickLists.set(chatId, { kind: "newdir", sid: "", items: dirs });
      const rows = dirs.slice(0, 10).map((d, i) => [{ text: clip(baseDir(d.dir) || d.dir, 40), callback_data: `s:newdir:${i}` }]);
      if (dk) rows.push([{ text: "\u{1F9E9} New Claude Code session", callback_data: "s:newc:cl" }, { text: "\u2B22 New Codex thread", callback_data: "s:newc:cx" }]);
      rows.push([{ text: "\u{1F3E0} Home", callback_data: "s:home" }]);
      return { text: dirs.length ? `\u2795 New session \u2014 pick a project:` : `\u2795 New session:`, keyboard: { inline_keyboard: rows } };
    }
    async function renderInbox(chatId) {
      const { perms, questions } = await collectPending();
      const rows = [];
      const lines = [];
      if (!perms.length && !questions.length) {
        return { text: `\u{1F4E5} Inbox

All clear \u2014 nothing is waiting on you.`, keyboard: { inline_keyboard: [[{ text: "\u{1F3E0} Home", callback_data: "s:home" }]] } };
      }
      lines.push(`\u{1F4E5} Inbox \u2014 ${perms.length} approval${perms.length === 1 ? "" : "s"}, ${questions.length} question${questions.length === 1 ? "" : "s"}`);
      const st = await loadState();
      let n = 0;
      for (const p of perms.slice(0, 8)) {
        n++;
        const title = st.sessions[p.sessionID]?.title || shortId(p.sessionID ?? "");
        const what = clip(String(p.permission ?? p.action ?? "permission"), 40);
        lines.push(`\u{1F510} ${what} \u2014 ${clip(title, 30)}`);
        rows.push([{ text: `\u{1F510} ${n}. ${clip(what, 24)}`, callback_data: `s:req:p:${p.id}` }]);
      }
      for (const q of questions.slice(0, 8)) {
        n++;
        const title = st.sessions[q.sessionID]?.title || shortId(q.sessionID ?? "");
        const what = clip(String(q.questions?.[0]?.question ?? q.questions?.[0]?.header ?? "question"), 40);
        lines.push(`\u2753 ${what} \u2014 ${clip(title, 30)}`);
        rows.push([{ text: `\u2753 ${n}. ${clip(what, 24)}`, callback_data: `s:req:q:${q.id}` }]);
      }
      rows.push([{ text: "\u{1F3E0} Home", callback_data: "s:home" }]);
      return { text: clip(lines.join("\n"), 3900), keyboard: { inline_keyboard: rows } };
    }
    async function renderInboxItem(kind, id) {
      const prompts = await loadPrompts();
      const rec = prompts[id];
      if (!rec) return null;
      if (kind === "p" && rec.kind === "permission") {
        const t = await displayTitle(rec.sessionID).catch(() => null);
        const title = t?.title ?? shortId(rec.sessionID);
        return { text: permCardText2({ title }, rec.permission ?? {}), keyboard: permCardKeyboard2(id) };
      }
      if (kind === "q" && rec.kind === "question") {
        const t = await displayTitle(rec.sessionID).catch(() => null);
        const title = t?.title ?? shortId(rec.sessionID);
        const questions = rec.questions ?? [];
        const selections = rec.selections ?? questions.map(() => []);
        const single = questions.length === 1 && !questions[0].multiple;
        return { text: questionCardText2({ title }, questions), keyboard: buildQuestionKeyboard2(id, questions, selections, single) };
      }
      return null;
    }
    async function renderSettings(chatId) {
      const cfg = await loadConfig();
      const st = await loadState();
      const ws = st.chats[chatId]?.agent;
      const modelLabel = modelLabelOf(ws?.model ?? (ws ? st.sessions[ws.sid]?.model : void 0));
      const tgl = (label, on, field) => ({ text: `${on ? "\u2705" : "\u2B1C"} ${label}`, callback_data: `s:set:${field}` });
      const agentLine = ws ? `Agent workspace: \u{1F916} @${ws.agent} \u2014 OPEN
model: ${modelLabel} \xB7 mode: \u{1F6E0} build (always)` : `Agent workspace: closed \u2014 /agent to open one
(any agent you pick runs in its own session, always in build mode)`;
      const text = clip([`\u2699\uFE0F Settings`, ``, "Notifications:", ``, "Tap to toggle:", ``, agentLine].join("\n"), 3900);
      const rows = [
        [tgl("Finished", cfg.notify.idle, "idle"), tgl("Errors", cfg.notify.error, "error")],
        [tgl("Approvals", cfg.notify.permission, "permission"), tgl("Questions", cfg.notify.question, "question")],
        [tgl("Assistant replies", cfg.relay, "relay")],
        [
          { text: "\u{1F916} Agent workspace", callback_data: "s:ag:open" },
          ...ws ? [{ text: "\u23F9 Close", callback_data: "s:ag:close" }] : []
        ],
        [{ text: "\u{1F3E0} Home", callback_data: "s:home" }]
      ];
      return { text, keyboard: { inline_keyboard: rows } };
    }
    async function renderScreen(chatId, screen) {
      switch (screen.name) {
        case "home":
          return renderHome(chatId);
        case "sessions":
          return renderSessionsPage(chatId, screen.page);
        case "session": {
          const st = await loadState();
          const reg = st.sessions[screen.sid];
          if (!reg) return { text: `Session ${shortId(screen.sid)} is not reachable.`, keyboard: { inline_keyboard: [[{ text: "\u{1F4DA} Sessions", callback_data: "s:sessions" }]] } };
          await setFocus(chatId, { sid: screen.sid, key: reg.key, dir: reg.dir, title: reg.title });
          return renderSessionScreen(chatId, screen.sid);
        }
        case "tasks":
          return renderTasksView(screen.sid);
        case "more":
          return renderMoreView(screen.sid);
        case "conv":
          return renderConversationPage(chatId, screen.sid, screen.page);
        case "models":
          return renderModelPicker(chatId, screen.sid, screen.page ?? 0);
        case "commands":
          return renderCommandPicker(chatId, screen.sid, screen.page ?? 0);
        case "newProject":
          return renderNewProject(chatId);
        case "inbox":
          return renderInbox(chatId);
        case "agentSettings":
          return renderAgentSettings(chatId);
        case "agentModels":
          return renderAgentModelPicker(chatId, screen.page ?? 0);
        case "inboxItem": {
          const view = await renderInboxItem(screen.kind, screen.id);
          if (!view) return { text: `That request was already handled.`, keyboard: { inline_keyboard: [[{ text: "\u{1F4E5} Inbox", callback_data: "s:inbox" }]] } };
          return view;
        }
        case "settings":
          return renderSettings(chatId);
      }
    }
    async function renderSessionScreen(chatId, sid) {
      const got = await fetchSessionDetail(sid);
      if (!got) return null;
      const { detail, key } = got;
      const info = detail.info;
      const busy = detail.status?.type === "busy";
      const msgs = detail.messages ?? [];
      const st = await loadState();
      const reg = st.sessions[sid];
      const awaiting = st.awaiting[sid];
      const ws = st.chats[chatId]?.agent;
      const isAgentWs = !!ws && ws.sid === sid;
      const client = reg?.client ?? clientOf2(sid);
      const git = await submitAction(key, "git.state", { dir: reg?.dir }, 5e3).catch(() => null);
      const model = ws?.model ?? reg?.model ?? modelFromInfo(info.model);
      const modelLabel = modelLabelOf(model) + (reg?.modelPinned && !isAgentWs ? " \u{1F4CC}" : "");
      const mode = isAgentWs ? "build" : modeOf(reg?.agent ?? info.agent);
      const lastUser = [...msgs].reverse().find((m) => m?.info?.role === "user");
      const lastUserText = lastUser ? textPartsOf2(lastUser) : "";
      const lastAssistant = [...msgs].reverse().find((m) => m?.info?.role === "assistant" && textPartsOf2(m));
      const answerTail = tailClip(awaiting?.stream ?? (lastAssistant ? textPartsOf2(lastAssistant) : ""), 900);
      const branchLine = git?.branch ? `\u{1F33F} ${git.branch}${(git.branches ?? []).filter((b) => b !== git.branch).slice(0, 3).map((b) => ` \xB7 ${b}`).join("")}${(git.branches ?? []).length > 4 ? ` \xB7 +${(git.branches ?? []).length - 4} more` : ""}` : "";
      const text = clip(
        [
          ...isAgentWs ? [`\u{1F916} @${ws.agent} agent workspace`, `Everything you type goes to this agent \u2014 \u{1F6E0} build (always).`] : [],
          `\u{1F4AC} ${info.title || shortId(sid)}`,
          `${formatStatus2(!!busy)} \xB7 ${client !== "oc" ? `${clientIcon2(client)} ${clientName2(client)} \xB7 ` : ""}${modelLabel} \xB7 ${isAgentWs || client === "cx" ? "\u{1F6E0} build" : modeButtonLabel(mode)} \xB7 updated ${timeAgo(info.time?.updated ?? reg?.updated ?? 0)}`,
          ...branchLine ? [branchLine] : [],
          ...lastUserText ? [``, `\u{1F464} ${clip(lastUserText.replace(/\s+/g, " "), 500)}`] : [],
          ...answerTail ? [``, `\u{1F916} ${answerTail}`] : [],
          ``,
          isAgentWs ? `Type to talk to @${ws.agent}.` : client === "cx" ? `Type here to continue this thread.` : `Type here to continue this session.`
        ].join("\n"),
        3900
      );
      const rows = isAgentWs ? [
        [{ text: "\u{1F9E0} Agent model", callback_data: "s:am:0" }, { text: "\u{1F916} Change agent", callback_data: "s:ag:open" }],
        [{ text: "\u23F9 Close workspace", callback_data: "s:ag:close" }, { text: "\u2611\uFE0F Tasks", callback_data: `s:tasks:${sid}` }],
        [{ text: "\u2328\uFE0F Command", callback_data: `s:cmds:${sid}` }, { text: "\u{1F3E0} Home", callback_data: "s:home" }]
      ] : (() => {
        const r = [];
        if (client === "oc") {
          r.push(
            [
              { text: "\u{1F4AC} Conversation", callback_data: `s:conv:${sid}:0` },
              { text: "\u{1F9E0} Model", callback_data: `s:model:${sid}` }
            ],
            [
              { text: `${modeButtonLabel(mode)} \xB7 switch`, callback_data: `s:mode:${sid}` },
              { text: "\u2611\uFE0F Tasks", callback_data: `s:tasks:${sid}` }
            ],
            [
              { text: "\u2328\uFE0F Command", callback_data: `s:cmds:${sid}` },
              { text: "\u2795 More", callback_data: `s:more:${sid}` }
            ]
          );
        } else {
          if (client === "cx") {
            r.push([{ text: "\u{1F9E0} Model", callback_data: `s:model:${sid}` }]);
          } else {
            r.push([
              { text: "\u{1F4AC} Conversation", callback_data: `s:conv:${sid}:0` },
              { text: "\u{1F9E0} Model", callback_data: `s:model:${sid}` }
            ]);
            if (client === "cl") r.push([{ text: `${modeButtonLabel(mode)} \xB7 switch`, callback_data: `s:mode:${sid}` }]);
          }
        }
        r.push([{ text: "\u{1F3E0} Home", callback_data: "s:home" }]);
        return r;
      })();
      if (busy) rows.splice(isAgentWs ? 2 : rows.length - 1, 0, [{ text: "\u23F9 Stop turn", callback_data: `s:abort:${sid}` }]);
      return { text, keyboard: { inline_keyboard: rows } };
    }
    async function fetchUserPrompts(sid) {
      const st = await loadState();
      const reg = st.sessions[sid];
      const key = reg?.key ?? (await liveKeys())[0];
      if (!key) return null;
      let arr = [];
      try {
        const r = await submitAction(key, "session.history", { sessionID: sid, limit: 30 }, 1e4);
        if (Array.isArray(r)) arr = r;
      } catch {
        return null;
      }
      return arr.filter((m) => m?.info?.role === "user" && m?.info?.id).reverse().map((m) => ({ messageID: String(m.info.id), prompt: textPartsOf2(m) })).filter((u) => u.prompt);
    }
    async function renderConversationPage(chatId, sid, page) {
      const st = await loadState();
      const reg = st.sessions[sid];
      const title = reg?.title || shortId(sid);
      const prompts = await fetchUserPrompts(sid);
      if (prompts === null) return null;
      const perPage = 5;
      const pages = Math.max(1, Math.ceil(prompts.length / perPage));
      const pg = Math.min(Math.max(0, page), pages - 1);
      const shown = prompts.slice(pg * perPage, pg * perPage + perPage);
      lastPickLists.set(chatId, { kind: "conv", sid, items: shown });
      const rows = shown.map((u, i) => [{ text: `${pg * perPage + i + 1}. ${clip(u.prompt.replace(/\s+/g, " "), 40)}`, callback_data: `s:convpick:${i}` }]);
      const nav = [];
      if (pg > 0) nav.push({ text: "\u25C0 Newer", callback_data: `s:conv:${sid}:${pg - 1}` });
      if (pg < pages - 1) nav.push({ text: "Older \u25B6", callback_data: `s:conv:${sid}:${pg + 1}` });
      if (nav.length) rows.push(nav);
      rows.push([{ text: "\u{1F4AC} Back to session", callback_data: `s:session:${sid}` }]);
      const lines = [`\u{1F4AC} Conversation \u2014 ${title} (page ${pg + 1}/${pages})`, ``];
      if (!shown.length) lines.push("(no prompts yet \u2014 type to start)");
      else shown.forEach((u, i) => lines.push(`${pg * perPage + i + 1}. ${clip(u.prompt.replace(/\s+/g, " "), 120)}`));
      return { text: clip(lines.join("\n"), 3900), keyboard: { inline_keyboard: rows } };
    }
    async function exchangeFor(sid, messageID) {
      const st = await loadState();
      const reg = st.sessions[sid];
      const key = reg?.key ?? (await liveKeys())[0];
      if (!key) return null;
      let arr = [];
      try {
        const r = await submitAction(key, "session.history", { sessionID: sid, limit: 30 }, 1e4);
        if (Array.isArray(r)) arr = r;
      } catch {
        return null;
      }
      const idx = arr.findIndex((m) => m?.info?.id === messageID && m?.info?.role === "user");
      if (idx < 0) return null;
      const userText = textPartsOf2(arr[idx]);
      const following = [];
      for (let i = idx + 1; i < arr.length; i++) {
        const m = arr[i];
        if (m?.info?.role === "user") break;
        if (m?.info?.role === "assistant") {
          const t = textPartsOf2(m);
          if (t) following.push(t);
        }
      }
      return { userText, assistantText: following.join("\n\n").trim(), title: reg?.title || shortId(sid) };
    }
    async function renderExchangeView(chatId, sid, messageID, page) {
      const ex = await exchangeFor(sid, messageID);
      if (!ex) return null;
      lastPickLists.set(chatId, { kind: "conv", sid, page, items: [{ messageID }] });
      const text = clip([`\u{1F4AC} ${ex.title}`, ``, `\u{1F464} You:`, clip(ex.userText.replace(/\s+/g, " "), 600), ``, `\u{1F916}:`, clip(ex.assistantText.replace(/\s+/g, " ") || "(no text reply)", 600)].join("\n"), 3900);
      const rows = clientOf2(sid) === "oc" ? [
        [
          { text: "\u{1F4C4} Full transcript", callback_data: `s:convfile:0` },
          { text: "\u21A9\uFE0F Revert to here", callback_data: `s:convrvert:0` }
        ],
        [{ text: "\u{1F519} Conversation", callback_data: `s:conv:${sid}:${page}` }]
      ] : [
        [{ text: "\u{1F4C4} Full transcript", callback_data: `s:convfile:0` }],
        [{ text: "\u{1F519} Conversation", callback_data: `s:conv:${sid}:${page}` }]
      ];
      return { text, keyboard: { inline_keyboard: rows } };
    }
    async function renderConvConfirm(chatId, sid, messageID, page) {
      const ex = await exchangeFor(sid, messageID);
      if (!ex) return null;
      lastPickLists.set(chatId, { kind: "conv", sid, page, items: [{ messageID }] });
      const text = clip([`\u26A0\uFE0F Revert "${ex.title}" to this prompt?`, ``, `\u{1F464} ${clip(ex.userText.replace(/\s+/g, " "), 200)}`, ``, `Agent work after this point will be undone.`].join("\n"), 3900);
      const rows = [[{ text: "\u2705 Yes, revert", callback_data: `s:convdo:0` }, { text: "Cancel", callback_data: `s:conv:${sid}:${page}` }]];
      return { text, keyboard: { inline_keyboard: rows } };
    }
    async function agentCandidates(chatId) {
      const keys = await liveKeys();
      if (!keys.length) return null;
      const pick = await getFocus(chatId);
      const st = await loadState();
      const focusKey = pick ? st.sessions[pick.sid]?.key ?? pick.key : null;
      const key = focusKey && keys.includes(focusKey) ? focusKey : keys[0];
      let r = null;
      let failed = false;
      try {
        r = await submitAction(key, "instance.agents", {}, 8e3);
      } catch (e) {
        failed = true;
        log("warn", `instance.agents unreachable (${key.slice(0, 8)}): ${e?.message ?? e}`);
      }
      const list = Array.isArray(r) ? r : [];
      const agents = list.filter((a) => {
        const mode = String(a?.mode ?? "primary").toLowerCase();
        const name = String(a?.name ?? a?.id ?? "").toLowerCase();
        return mode !== "subagent" && a?.hidden !== true && name !== "plan";
      });
      if (failed && !agents.length) {
        return { key, agents: [{ name: "build", mode: "primary" }], fallback: true };
      }
      return { key, agents };
    }
    async function openAgentWorkspace(chatId, nameRaw) {
      const cfg = await loadConfig();
      const cand = await agentCandidates(chatId);
      if (!cand) {
        await tgSend(cfg, chatId, `\u26A0\uFE0F No opencode instance is live right now \u2014 open a project first.`);
        return { ok: false };
      }
      const wanted = String(nameRaw ?? "").trim().toLowerCase().replace(/^@/, "");
      const hit = cand.agents.find((a) => String(a?.name ?? a?.id ?? "").toLowerCase() === wanted);
      if (!hit) {
        const names = cand.agents.map((a) => `/${String(a?.name ?? a?.id ?? "")}`).slice(0, 12);
        await tgSend(cfg, chatId, `\u{1F916} Unknown agent "${nameRaw}". Available:
${names.join(" \xB7 ") || "(none)"}`);
        return { ok: false };
      }
      const name = String(hit.name ?? hit.id);
      const st = await loadState();
      const existing = st.chats[chatId]?.agent;
      let ws;
      if (existing?.agent === name && st.sessions[existing.sid]) {
        ws = existing;
      } else {
        let sid = "";
        let title = `\u{1F916} ${name}`;
        let dir = cand.key === KEY ? MY_DIR : instances.get(cand.key)?.dir ?? MY_DIR;
        try {
          const sess = await submitAction(cand.key, "session.create", { title });
          if (!sess?.id) throw new Error("no id");
          sid = String(sess.id);
          title = sess.title || title;
          dir = sess.directory ?? dir;
        } catch (e) {
          await tgSend(cfg, chatId, `\u26A0\uFE0F could not create the agent session: ${clip(String(e?.message ?? e), 200)}`);
          return { ok: false };
        }
        await mutateState2((s) => {
          s.sessions[sid] = {
            key: cand.key,
            dir,
            title,
            updated: Date.now(),
            model: existing?.model ?? void 0,
            modelPinned: !!existing?.model,
            agent: name,
            agentPinned: true
          };
        });
        ws = { sid, agent: name, key: cand.key, dir, model: existing?.model, openedAt: Date.now() };
      }
      await mutateState2((s) => {
        const c = s.chats[chatId] ?? (s.chats[chatId] = {});
        const withPrev = { ...ws, prev: existing?.prev ?? c.active ?? void 0 };
        c.agent = withPrev;
        c.active = { sid: ws.sid, key: ws.key, dir: ws.dir, title: s.sessions[ws.sid]?.title ?? `\u{1F916} ${ws.agent}` };
      });
      await showPanel(chatId, { name: "session", sid: ws.sid });
      return { ok: true };
    }
    async function closeAgentWorkspace(chatId) {
      const cfg = await loadConfig();
      const st = await loadState();
      const ws = st.chats[chatId]?.agent;
      await mutateState2((s) => {
        const c = s.chats[chatId];
        if (c) delete c.agent;
        if (ws?.prev && c?.active?.sid === ws.sid) c.active = ws.prev;
      });
      if (!ws) {
        await tgSend(cfg, chatId, `No agent workspace is open.`);
        return;
      }
      await tgSend(cfg, chatId, `\u23F9 Closed the @${ws.agent} workspace. The session stays in \u{1F4DA} Sessions; typing goes to your focused session again.`);
      await showPanel(chatId, { name: "home" }, true);
    }
    async function setAgentModel(chatId, model) {
      const st = await loadState();
      const ws = st.chats[chatId]?.agent;
      if (!ws) return;
      await mutateState2((s) => {
        const c = s.chats[chatId];
        if (c?.agent) c.agent.model = model;
        const sess = s.sessions[ws.sid];
        if (sess) {
          sess.model = model;
          sess.modelPinned = !!model;
        }
      });
    }
    async function sendPrompt(chatId, text) {
      const cfg = await loadConfig();
      const st = await loadState();
      const ws = st.chats[chatId]?.agent;
      const focus = ws ? null : st.chats[chatId]?.active ?? null;
      const target = ws ? { sid: ws.sid, key: ws.key, dir: ws.dir, title: st.sessions[ws.sid]?.title ?? `\u{1F916} ${ws.agent}` } : focus;
      if (!target) {
        await showPanel(chatId, { name: "sessions", page: 0 });
        await tgSend(cfg, chatId, `Pick a session first \u2014 then type to talk to it.`);
        return;
      }
      const reg = st.sessions[target.sid];
      const key = ws?.key ?? reg?.key ?? target.key;
      const model = ws ? ws.model ?? reg?.model : reg?.model;
      const agent = ws ? ws.agent : reg?.agent;
      log(
        "info",
        `prompt: session=${target.sid.slice(-6)} model=${model ? `${model.providerID}/${model.modelID}` : "(server default)"} agent=${agent || "(server default)"} ws=${!!ws}`
      );
      const cardMid = await tgSend(cfg, chatId, turnCardText2(target.title, text, `\u23F3 sending\u2026`), stopKeyboard(target.sid)).catch(() => null);
      await mutateState2((s) => {
        const a = s.awaiting[target.sid] ?? { chats: [], key, at: Date.now() };
        if (!a.chats.includes(chatId)) a.chats.push(chatId);
        a.key = key;
        a.at = Date.now();
        a.prompt = text;
        a.stream = void 0;
        a.streamShown = false;
        a.lastStreamEdit = 0;
        a.error = void 0;
        a.cards = { ...a.cards ?? {}, ...cardMid ? { [String(chatId)]: cardMid } : {} };
        s.awaiting[target.sid] = a;
      });
      try {
        await submitAction(key, "session.prompt", { sessionID: target.sid, text, ...model ? { model } : {}, ...agent ? { agent } : {} });
      } catch (e) {
        await mutateState2((s) => {
          const a = s.awaiting[target.sid];
          if (a) {
            a.chats = a.chats.filter((c) => c !== chatId);
            if (a.cards) delete a.cards[String(chatId)];
            if (!a.chats.length) delete s.awaiting[target.sid];
          }
        });
        if (cardMid) await editMessage(chatId, cardMid, `\u26A0\uFE0F could not send: ${clip(String(e?.message ?? e), 300)}`).catch(() => {
        });
        else await tgSend(cfg, chatId, `\u26A0\uFE0F could not send: ${clip(String(e?.message ?? e), 300)}`).catch(() => {
        });
      }
    }
    async function runOpencodeCommand(cfg, chatId, sid, command, args) {
      try {
        const st2 = await loadState();
        const reg = st2.sessions[sid];
        if (!reg) throw new Error("session not found");
        const r = await submitAction(reg.key, "session.command", { sessionID: sid, command, arguments: args });
        const out = r?.parts ? msgText(r) : "";
        await tgSend(cfg, chatId, clip(`\u2328\uFE0F /${command} in ${reg.title}

${out || "(done)"}`, 3900));
      } catch (e) {
        await tgSend(cfg, chatId, `\u26A0\uFE0F command failed: ${clip(String(e?.message ?? e), 200)}`);
      }
      await showPanel(chatId, { name: "session", sid });
    }
    async function handlePendingInput(cfg, chatId, text) {
      const st = await loadState();
      const pending = st.chats[chatId]?.pending;
      if (!pending) return false;
      if (text.trim() === "/cancel") {
        await mutateState2((s) => {
          if (s.chats[chatId]) delete s.chats[chatId].pending;
        });
        await tgSend(cfg, chatId, `Cancelled.`);
        await showPanel(chatId, { name: "home" });
        return true;
      }
      if (text.trim() === "/skip") {
        await mutateState2((s) => {
          if (s.chats[chatId]) delete s.chats[chatId].pending;
        });
        if (pending.kind === "newTitle") {
          await createSessionInDir(chatId, pending.dir, pending.key, "", pending.client);
          return true;
        }
        if (pending.kind === "commandArg") {
          await runOpencodeCommand(cfg, chatId, pending.sid, pending.command, "");
          return true;
        }
        await tgSend(cfg, chatId, `Skipped.`);
        await showPanel(chatId, { name: "home" });
        return true;
      }
      if (pending.kind === "newTitle") {
        await mutateState2((s) => {
          if (s.chats[chatId]) delete s.chats[chatId].pending;
        });
        await createSessionInDir(chatId, pending.dir, pending.key, clip(text.trim(), 120), pending.client);
        return true;
      }
      if (pending.kind === "commandArg") {
        await mutateState2((s) => {
          if (s.chats[chatId]) delete s.chats[chatId].pending;
        });
        await runOpencodeCommand(cfg, chatId, pending.sid, pending.command, text.trim());
        return true;
      }
      if (pending.kind === "modelCustom") {
        const modelID = clip(text.trim().replace(/\s+/g, " "), 80);
        await mutateState2((s) => {
          if (s.chats[chatId]) delete s.chats[chatId].pending;
        });
        if (modelID) {
          const stP = await loadState();
          const isAgent = !!stP.chats[chatId]?.agent && stP.chats[chatId].agent.sid === pending.sid;
          await mutateState2((s) => {
            const e = s.sessions[pending.sid];
            if (e) {
              e.model = { providerID: pending.providerID, modelID };
              e.modelPinned = true;
            }
          });
          if (isAgent) await setAgentModel(chatId, { providerID: pending.providerID, modelID });
          await tgSend(cfg, chatId, `\u{1F9E0} Model set: ${modelID}`);
        }
        await showPanel(chatId, { name: "session", sid: pending.sid });
        return true;
      }
      return false;
    }
    async function createSessionInDir(chatId, dir, key, title, client) {
      const cfg = await loadConfig();
      try {
        const sess = await submitAction(key, "session.create", { ...title ? { title } : {}, ...client ? { client } : {}, ...dir ? { dir } : {} });
        if (!sess?.id) throw new Error("session.create returned no id");
        const name = sess.title || title || shortId(sess.id);
        await mutateState2((s) => {
          s.sessions[sess.id] = { key, dir: sess.directory ?? dir, title: name, updated: sess.time?.updated ?? Date.now(), parentID: sess.parentID };
          s.chats[chatId] = { ...s.chats[chatId] ?? {}, active: { sid: sess.id, key, dir: sess.directory ?? dir, title: name } };
        });
        await showPanel(chatId, { name: "session", sid: sess.id });
      } catch (e) {
        await tgSend(cfg, chatId, `\u26A0\uFE0F could not create session: ${clip(String(e?.message ?? e), 200)}`);
        await showPanel(chatId, { name: "newProject" });
      }
    }
    async function syncBotCommands(cfg) {
      try {
        const staticCmds = [
          { command: "start", description: "Home" },
          { command: "sessions", description: "Browse sessions" },
          { command: "new", description: "New session" },
          { command: "agent", description: "Open an agent workspace" },
          { command: "inbox", description: "Approvals and questions" },
          { command: "settings", description: "Notifications and profile" },
          { command: "abort", description: "Stop the focused session" },
          { command: "skip", description: "Answer the pending question with none" }
        ];
        const names = /* @__PURE__ */ new Map();
        for (const k of await liveKeys()) {
          const cmds = await submitAction(k, "instance.commands", {}, 6e3).catch(() => []);
          for (const c of Array.isArray(cmds) ? cmds : []) {
            const n = String(c?.name ?? c?.id ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 32);
            if (!n || names.has(n)) continue;
            names.set(n, clip(String(c?.description ?? "opencode command"), 60));
          }
        }
        const merged = [...staticCmds];
        for (const [name, description] of names) {
          if (merged.length >= 100) break;
          if (!merged.some((x) => x.command === name)) merged.push({ command: name, description });
        }
        await tgApi(cfg, "setMyCommands", { commands: merged });
      } catch (e) {
        log("debug", `setMyCommands: ${e?.message ?? e}`);
      }
    }
    async function syncBotProfile(cfg) {
      try {
        if (cfg.botName) await tgApi(cfg, "setMyName", { name: clip(cfg.botName, 64) });
      } catch (e) {
        log("debug", `setMyName: ${e?.message ?? e}`);
      }
      try {
        if (cfg.botDescription) await tgApi(cfg, "setMyDescription", { description: clip(cfg.botDescription, 512) });
      } catch (e) {
        log("debug", `setMyDescription: ${e?.message ?? e}`);
      }
      await syncBotCommands(cfg);
    }
    async function handleCallback(cfg, chatId, cq) {
      const data = String(cq.data ?? "");
      if (data === "noop") {
        await answerCallback(cq.id);
        return;
      }
      if (data.startsWith("s:")) {
        const rest = data.slice(2);
        const seg = rest.split(":");
        const nav = seg[0];
        const arg1 = seg[1] ?? "";
        const arg2 = seg[2] ?? "";
        const go = async (screen) => {
          await answerCallback(cq.id);
          await showPanel(chatId, screen);
        };
        if (nav === "home") {
          await go({ name: "home" });
          return;
        }
        if (nav === "sessions" || nav === "page") {
          const page = nav === "page" ? Number(arg1) || 0 : 0;
          await go({ name: "sessions", page });
          return;
        }
        if (nav === "session" && arg1) {
          await go({ name: "session", sid: arg1 });
          return;
        }
        if (nav === "conv" && arg1) {
          await go({ name: "conv", sid: arg1, page: Number(arg2) || 0 });
          return;
        }
        if (nav === "convpick") {
          const pick = lastPickLists.get(chatId);
          const i = Number(arg1);
          await answerCallback(cq.id);
          if (!pick || pick.kind !== "conv" || !pick.items[i]) {
            await showPanel(chatId, { name: "home" });
            return;
          }
          const sid = pick.sid;
          const mid = cq.message?.message_id;
          const view = await renderExchangeView(chatId, sid, pick.items[i].messageID, pick.page ?? 0);
          if (!view) {
            await tgSend(cfg, chatId, `That prompt is no longer available.`);
            return;
          }
          if (mid) await editMessage(chatId, mid, view.text, view.keyboard);
          else await tgSend(cfg, chatId, view.text, view.keyboard);
          return;
        }
        if (nav === "convfile") {
          const pick = lastPickLists.get(chatId);
          const i = Number(arg1);
          await answerCallback(cq.id);
          if (!pick || pick.kind !== "conv" || !pick.items[i]) {
            await showPanel(chatId, { name: "home" });
            return;
          }
          const sid = pick.sid;
          const messageID = pick.items[i].messageID;
          const statusMid = await tgSend(cfg, chatId, `\u23F3 Building transcript\u2026 this takes a second.`).catch(() => null);
          const setStatus = async (t) => {
            if (statusMid) await editMessage(chatId, statusMid, t).catch(() => {
            });
            else await tgSend(cfg, chatId, t).catch(() => {
            });
          };
          const ex = await exchangeFor(sid, messageID);
          if (!ex) {
            await setStatus(`\u26A0\uFE0F Could not load that exchange.`);
            return;
          }
          const st = await loadState();
          const reg = st.sessions[sid];
          const md = buildTranscript2(ex.title, modelLabelOf(reg?.model), modeOf(reg?.agent), ex.userText, ex.assistantText);
          const fname = `session-${shortId(sid)}-${Date.now().toString(36)}.md`;
          try {
            await tgSendDocument(cfg, chatId, fname, md, `\u{1F4C4} Transcript \u2014 "${clip(ex.userText.replace(/\s+/g, " "), 80)}"`);
            await setStatus(`\u{1F4C4} Transcript sent above as a file.`);
          } catch (e) {
            await setStatus(`\u26A0\uFE0F could not send file: ${clip(String(e?.message ?? e), 200)}`);
          }
          return;
        }
        if (nav === "convrvert") {
          const pick = lastPickLists.get(chatId);
          const i = Number(arg1);
          await answerCallback(cq.id);
          if (!pick || pick.kind !== "conv" || !pick.items[i]) {
            await showPanel(chatId, { name: "home" });
            return;
          }
          const sid = pick.sid;
          const page = pick.page ?? 0;
          const view = await renderConvConfirm(chatId, sid, pick.items[i].messageID, page);
          if (!view) {
            await tgSend(cfg, chatId, `Could not load that exchange.`);
            return;
          }
          const mid = cq.message?.message_id;
          if (mid) await editMessage(chatId, mid, view.text, view.keyboard);
          else await tgSend(cfg, chatId, view.text, view.keyboard);
          return;
        }
        if (nav === "convdo") {
          const pick = lastPickLists.get(chatId);
          const i = Number(arg1);
          await answerCallback(cq.id);
          if (!pick || pick.kind !== "conv" || !pick.items[i]) {
            await showPanel(chatId, { name: "home" });
            return;
          }
          const sid = pick.sid;
          const messageID = pick.items[i].messageID;
          try {
            const st = await loadState();
            const reg = st.sessions[sid];
            if (!reg) throw new Error("session not found");
            await submitAction(reg.key, "session.revert", { sessionID: sid, messageID });
            await tgSend(cfg, chatId, `\u21A9\uFE0F Reverted "${reg.title}" to the selected prompt.`);
          } catch (e) {
            await tgSend(cfg, chatId, `\u26A0\uFE0F revert failed: ${clip(String(e?.message ?? e), 200)}`);
          }
          await showPanel(chatId, { name: "session", sid });
          return;
        }
        if ((nav === "tasks" || nav === "more") && arg1) {
          await go({ name: nav, sid: arg1 });
          return;
        }
        if (nav === "abort" && arg1) {
          const st = await loadState();
          const reg = st.sessions[arg1];
          if (!reg) {
            await answerCallback(cq.id, "unknown session", true);
            await showPanel(chatId, { name: "sessions", page: 0 });
            return;
          }
          try {
            const freshKey = (await loadState()).sessions[arg1]?.key ?? reg.key;
            await submitAction(freshKey, "session.abort", { sessionID: arg1 });
            await answerCallback(cq.id, "stopped");
          } catch (e) {
            await answerCallback(cq.id, `could not stop`, true);
          }
          await showPanel(chatId, { name: "session", sid: arg1 });
          return;
        }
        if (nav === "model" && arg1) {
          await go({ name: "models", sid: arg1, page: Number(arg2) || 0 });
          return;
        }
        if (nav === "mc" && arg1) {
          const st = await loadState();
          if (!st.sessions[arg1]) {
            await answerCallback(cq.id, "unknown session", true);
            return;
          }
          const providerID = clientOf2(arg1) === "cx" ? "openai" : "anthropic";
          await mutateState2((sm) => {
            const ch = sm.chats[chatId] ?? (sm.chats[chatId] = {});
            ch.pending = { kind: "modelCustom", sid: arg1, providerID };
          });
          await answerCallback(cq.id);
          await tgSend(cfg, chatId, `\u2328\uFE0F Type the exact model id for ${clientName2(clientOf2(arg1))} (or /cancel). If your setup uses a proxy, use the alias it accepts.`);
          return;
        }
        if (nav === "newc" && (arg1 === "cl" || arg1 === "cx")) {
          const dk = await daemonKey();
          if (!dk) {
            await answerCallback(cq.id, "raven daemon is not running", true);
            return;
          }
          const dirs = await getKnownDirs();
          await answerCallback(cq.id);
          await mutateState2((sm) => {
            const ch = sm.chats[chatId] ?? (sm.chats[chatId] = {});
            ch.pending = { kind: "newTitle", dir: dirs[0]?.dir ?? "", key: dk, client: arg1 };
          });
          await tgSend(cfg, chatId, arg1 === "cl" ? `\u{1F9E9} Name the new Claude Code session? (or /skip)` : `\u2B22 Name the new Codex thread? (or /skip)`);
          return;
        }
        if (nav === "mpick") {
          const pick = lastPickLists.get(chatId);
          const i = Number(arg1);
          if (!pick || pick.kind !== "model" || !pick.items[i]) {
            await answerCallback(cq.id, "expired \u2014 open Model again", true);
            await showPanel(chatId, { name: "home" });
            return;
          }
          const sid = pick.sid;
          const m = pick.items[i];
          let stored = false;
          await mutateState2((s) => {
            const e = s.sessions[sid];
            if (e) {
              e.model = { providerID: String(m.providerID), modelID: String(m.modelID) };
              e.modelPinned = true;
              stored = true;
            }
          });
          log("info", `model pick: ${sid.slice(-6)} -> ${m.providerID}/${m.modelID} (${stored ? "pinned" : "SESSION MISSING"})`);
          await answerCallback(cq.id, `model set: ${clip(String(m.name ?? m.modelID), 60)}`);
          await showPanel(chatId, { name: "session", sid });
          return;
        }
        if (nav === "mode" && arg1) {
          const st = await loadState();
          const reg = st.sessions[arg1];
          if (st.chats[chatId]?.agent?.sid === arg1) {
            await answerCallback(cq.id, "agent workspaces are always build", true);
            return;
          }
          if (clientOf2(arg1) === "cx") {
            await answerCallback(cq.id, "Codex has no plan mode", true);
            return;
          }
          if (!reg) {
            await answerCallback(cq.id, "unknown session", true);
            await showPanel(chatId, { name: "sessions", page: 0 });
            return;
          }
          const detail = await submitAction(reg.key, "session.get", { sessionID: arg1 }, 6e3).catch(() => null);
          const cur = modeOf(reg.agent ?? detail?.agent);
          const next = cur === "plan" ? "build" : "plan";
          await mutateState2((s) => {
            const e = s.sessions[arg1];
            if (e) {
              e.agent = next;
              e.agentPinned = true;
            }
          });
          log("info", `mode pick: ${arg1.slice(-6)} -> ${next} (pinned)`);
          await answerCallback(cq.id, `mode: ${next}`);
          await showPanel(chatId, { name: "session", sid: arg1 });
          return;
        }
        if (nav === "mreset" && arg1) {
          const st = await loadState();
          const server = st.sessions[arg1]?.modelServer;
          await mutateState2((s) => {
            const e = s.sessions[arg1];
            if (e) {
              e.modelPinned = false;
              e.agentPinned = false;
              if (server) e.model = server;
            }
          });
          await answerCallback(cq.id, server ? `following the app: ${server.modelID}` : "following the app now");
          await showPanel(chatId, { name: "session", sid: arg1 });
          return;
        }
        if (nav === "cmds" && arg1) {
          await go({ name: "commands", sid: arg1, page: Number(arg2) || 0 });
          return;
        }
        if (nav === "cmd") {
          const pick = lastPickLists.get(chatId);
          const i = Number(arg1);
          await answerCallback(cq.id);
          if (!pick || pick.kind !== "command" || !pick.items[i]) {
            await showPanel(chatId, { name: "home" });
            return;
          }
          const sid = pick.sid;
          const c = pick.items[i];
          const command = String(c.name ?? c.id ?? "");
          await mutateState2((s) => {
            const ch = s.chats[chatId] ?? (s.chats[chatId] = {});
            ch.pending = { kind: "commandArg", sid, command };
          });
          await tgSend(cfg, chatId, `\u2328\uFE0F Arguments for /${command}? (type them, or /skip for none)`);
          return;
        }
        if (nav === "ap" && (arg1 === "ok" || arg1 === "no") && arg2) {
          await answerCallback(cq.id, arg1 === "ok" ? "approved" : "denied");
          await handlePairDecision(cfg, chatId, Number(arg2), arg1 === "ok");
          return;
        }
        if (nav === "new") {
          await go({ name: "newProject" });
          return;
        }
        if (nav === "ag" && arg1 === "open") {
          await go({ name: "agentSettings" });
          return;
        }
        if (nav === "ag" && (arg1 === "close" || arg1 === "off")) {
          await answerCallback(cq.id, "closed");
          await closeAgentWorkspace(chatId);
          return;
        }
        if (nav === "agpick") {
          const pick = lastPickLists.get(chatId);
          const i = Number(arg1);
          await answerCallback(cq.id);
          if (!pick || pick.kind !== "agentcfg" || !pick.items[i]) {
            await showPanel(chatId, { name: "home" });
            return;
          }
          const name = String(pick.items[i].name ?? pick.items[i].id ?? "");
          await openAgentWorkspace(chatId, name);
          return;
        }
        if (nav === "am" && /^\d+$/.test(arg1)) {
          await go({ name: "agentModels", page: Number(arg1) });
          return;
        }
        if (nav === "ampick") {
          const pick = lastPickLists.get(chatId);
          const i = Number(arg1);
          if (!pick || pick.kind !== "agentmodel" || !pick.items[i]) {
            await answerCallback(cq.id, "expired \u2014 reopen \u{1F916} Agent workspace", true);
            await showPanel(chatId, { name: "home" });
            return;
          }
          const m = pick.items[i];
          await setAgentModel(chatId, { providerID: String(m.providerID), modelID: String(m.modelID) });
          await answerCallback(cq.id, `agent model set: ${clip(String(m.name ?? m.modelID), 60)}`);
          const stA = await loadState();
          const sidA = stA.chats[chatId]?.agent?.sid;
          await showPanel(chatId, sidA ? { name: "session", sid: sidA } : { name: "agentSettings" });
          return;
        }
        if (nav === "newdir") {
          const pick = lastPickLists.get(chatId);
          const i = Number(arg1);
          await answerCallback(cq.id);
          if (!pick || pick.kind !== "newdir" || !pick.items[i]) {
            await showPanel(chatId, { name: "home" });
            return;
          }
          const d = pick.items[i];
          await mutateState2((s) => {
            const c = s.chats[chatId] ?? (s.chats[chatId] = {});
            c.pending = { kind: "newTitle", dir: d.dir, key: d.key };
          });
          await tgSend(cfg, chatId, `\u2795 Name the new session in ${baseDir(d.dir)}? (type a title, or /skip)`);
          return;
        }
        if (nav === "inbox") {
          await go({ name: "inbox" });
          return;
        }
        if (nav === "req" && (arg1 === "p" || arg1 === "q") && arg2) {
          await go({ name: "inboxItem", kind: arg1, id: arg2 });
          return;
        }
        if (nav === "settings") {
          await go({ name: "settings" });
          return;
        }
        if (nav === "set") {
          const field = arg1;
          if (["idle", "error", "permission", "question"].includes(field)) {
            const cur = await loadConfig();
            await patchConfig({ notify: { ...cur.notify, [field]: !cur.notify[field] } });
            await answerCallback(cq.id, "updated");
            await showPanel(chatId, { name: "settings" });
            return;
          }
          if (field === "relay") {
            const cur = await loadConfig();
            await patchConfig({ relay: !cur.relay });
            await answerCallback(cq.id, "updated");
            await showPanel(chatId, { name: "settings" });
            return;
          }
          await answerCallback(cq.id);
          await showPanel(chatId, { name: "settings" });
          return;
        }
        await answerCallback(cq.id, "unknown action", true);
        return;
      }
      if (data.startsWith("p:")) {
        const [, id, reply] = data.split(":");
        const rec = (await loadPrompts())[id];
        if (!rec || rec.kind !== "permission") {
          await answerCallback(cq.id, "expired \u2014 check the app", true);
          return;
        }
        if (rec.handled) {
          await answerCallback(cq.id, "already answered");
          return;
        }
        try {
          await submitAction(rec.key, "permission.reply", { requestID: id, reply });
          await mutatePrompts((pr) => {
            const r = pr[id];
            if (!r) return;
            r.handled = true;
            const label = reply === "once" ? "allowed once" : reply === "always" ? "always allowed" : "rejected";
            for (const m of r.msgs) void editMessage(m.chatId, m.messageId, `\u2705 ${label}`).catch(() => {
            });
          });
          await answerCallback(cq.id, reply === "reject" ? "rejected" : "approved");
          log("info", `permission reply ${id}: ${reply}`);
          await maybeRefreshPanels(rec.msgs.map((m) => m.chatId));
        } catch (e) {
          await answerCallback(cq.id, `failed: ${clip(String(e?.message ?? e), 100)}`, true);
        }
        return;
      }
      if (data.startsWith("q")) {
        const parts = data.split(":");
        const op = parts[0];
        const id = parts[1];
        const prompts = await loadPrompts();
        const rec = prompts[id];
        if (!rec || rec.kind !== "question") {
          await answerCallback(cq.id, "expired \u2014 check the app", true);
          return;
        }
        if (rec.handled) {
          await answerCallback(cq.id, "already answered");
          return;
        }
        const questions = rec.questions ?? [];
        if (op === "qa") {
          const qi = Number(parts[2]);
          const oi = Number(parts[3]);
          const label = questions[qi]?.options?.[oi]?.label;
          if (label === void 0) return;
          await answerCallback(cq.id, label);
          await answerQuestion(cfg, id, rec, questions.map((_q, i) => i === qi ? [label] : []));
          return;
        }
        if (op === "qt") {
          const qi = Number(parts[2]);
          const oi = Number(parts[3]);
          const sel = rec.selections ?? questions.map(() => []);
          const arr = sel[qi] ?? [];
          sel[qi] = arr.includes(oi) ? arr.filter((x) => x !== oi) : [...arr, oi];
          await mutatePrompts((pr) => {
            if (pr[id]) pr[id].selections = sel;
          });
          const keyboard = buildQuestionKeyboard2(id, questions, sel, false);
          const text = renderSelectionText2(rec.baseText ?? "", questions, sel);
          for (const m of rec.msgs) await editMessage(m.chatId, m.messageId, text, keyboard);
          await answerCallback(cq.id, sel[qi]?.length ? "selected" : "cleared");
          return;
        }
        if (op === "qs") {
          const sel = rec.selections ?? questions.map(() => []);
          const missing = questions.some((q, i) => !(sel[i] ?? []).length);
          if (missing) {
            await answerCallback(cq.id, "select an option for every question", true);
            return;
          }
          await answerCallback(cq.id, "sent");
          const answers = questions.map((q, i) => (sel[i] ?? []).map((oi) => q.options?.[oi]?.label ?? ""));
          await answerQuestion(cfg, id, rec, answers);
          return;
        }
        if (op === "qr") {
          await answerCallback(cq.id, "dismissed");
          await mutatePrompts((pr) => {
            const r = pr[id];
            if (r) r.handled = true;
          });
          try {
            await submitAction(rec.key, "question.reject", { requestID: id });
          } catch (e) {
            log("warn", `question reject: ${e?.message ?? e}`);
          }
          for (const m of rec.msgs) await editMessage(m.chatId, m.messageId, `\u2611\uFE0F dismissed`);
          return;
        }
      }
      await answerCallback(cq.id, "unknown action", true);
    }
    async function answerQuestion(cfg, id, rec, answers) {
      try {
        await submitAction(rec.key, "question.reply", { requestID: id, answers });
        const flat = answers.flat().join(", ");
        await mutatePrompts((pr) => {
          const r = pr[id];
          if (!r) return;
          r.handled = true;
          for (const m of r.msgs) void editMessage(m.chatId, m.messageId, `\u2705 answered: ${clip(flat, 300)}`).catch(() => {
          });
        });
        log("info", `question reply ${id}`);
        await maybeRefreshPanels(rec.msgs.map((m) => m.chatId));
      } catch (e) {
        for (const m of rec.msgs) void editMessage(m.chatId, m.messageId, `\u26A0\uFE0F failed: ${clip(String(e?.message ?? e), 300)}`);
        log("warn", `question reply ${id}: ${e?.message ?? e}`);
      }
    }
    async function liveKeys() {
      const up = [...instances.entries()].filter(([, v]) => isInstanceUp2(v)).map(([k]) => k);
      if (up.length) return up;
      return [...instances.entries()].filter(([, v]) => Date.now() - v.lastSeen < 3e5).map(([k]) => k);
    }
    async function collectSessions() {
      const keys = await liveKeys();
      const results = await Promise.all(keys.map((k) => submitAction(k, "session.list", {}, 7e3).catch(() => null)));
      const map = /* @__PURE__ */ new Map();
      results.forEach((res, i) => {
        if (!res) return;
        const key = keys[i];
        for (const s of res.sessions ?? []) {
          if (!s?.id) continue;
          const prev = map.get(s.id);
          const busy = res.statuses?.[s.id]?.type === "busy";
          const updated = s.time?.updated ?? 0;
          if (!prev || updated > prev.updated) {
            map.set(s.id, {
              sid: s.id,
              key,
              dir: s.directory ?? instances.get(key)?.dir ?? MY_DIR,
              title: s.title || shortId(s.id),
              updated,
              busy,
              parentID: s.parentID,
              preview: res.previews?.[s.id],
              model: modelFromInfo(s.model),
              agent: s.agent ? modeOf(String(s.agent)) : void 0,
              client: s.client ?? clientOf2(s.id),
              children: 0
            });
          } else if (busy) prev.busy = true;
        }
      });
      const childrenCount = /* @__PURE__ */ new Map();
      for (const s of map.values()) {
        if (s.parentID) childrenCount.set(s.parentID, (childrenCount.get(s.parentID) ?? 0) + 1);
      }
      const all = [...map.values()];
      for (const s of all) s.children = childrenCount.get(s.sid) ?? 0;
      const list = all.filter((s) => !s.parentID).sort((a, b) => b.updated - a.updated);
      await mutateState2((s) => {
        for (const it of all) {
          const prev = s.sessions[it.sid];
          s.sessions[it.sid] = {
            key: it.key,
            dir: it.dir,
            title: it.title,
            updated: it.updated,
            parentID: it.parentID ?? prev?.parentID,
            preview: it.preview ?? prev?.preview,
            ...mergeServerModel(prev, it.model),
            ...mergeServerAgent(prev, it.agent),
            client: prev?.client ?? it.client
          };
        }
      });
      return list;
    }
    async function handleCommand(cfg, chatId, text) {
      const trimmed = text.trim();
      const mapped = BUTTON_MAP[trimmed];
      const isCmd = trimmed.startsWith("/") || !!mapped;
      const st0 = await loadState();
      if (st0.chats[chatId]?.pending) {
        const cmdName = trimmed.startsWith("/") ? trimmed.split(/\s+/)[0].slice(1).toLowerCase() : "";
        const isSkipish = cmdName === "skip" || cmdName === "cancel";
        const escapes = !!mapped || !!cmdName && BOT_COMMANDS.has(cmdName) && !isSkipish;
        if (escapes) {
          await mutateState2((s) => {
            if (s.chats[chatId]) delete s.chats[chatId].pending;
          });
        } else if (await handlePendingInput(cfg, chatId, trimmed)) return;
      }
      if (!isCmd) {
        await sendPrompt(chatId, trimmed);
        return;
      }
      const cmdSource = mapped ?? trimmed;
      const [cmdRaw, ...rest] = cmdSource.split(/\s+/);
      const cmd = cmdRaw.startsWith("/") ? cmdRaw.slice(1).toLowerCase() : cmdRaw.toLowerCase();
      const arg = rest.join(" ").trim();
      switch (cmd) {
        case "start":
        case "help": {
          await showPanel(chatId, { name: "home" }, true);
          await tgSend(cfg, chatId, `\u{1F39B} Options below \u2014 tap a button to navigate.`, menuKeyboard()).catch(() => null);
          return;
        }
        case "sessions":
          await showPanel(chatId, { name: "sessions", page: 0 }, true);
          return;
        case "new": {
          if (arg) {
            const focus = await getFocus(chatId);
            const dirs = await getKnownDirs();
            const target = focus ? { dir: focus.dir, key: focus.key } : dirs[0];
            if (!target) {
              await tgSend(cfg, chatId, `No opencode project is open right now.`);
              return;
            }
            await createSessionInDir(chatId, target.dir, target.key, arg);
            return;
          }
          await showPanel(chatId, { name: "newProject" }, true);
          return;
        }
        case "inbox":
          await showPanel(chatId, { name: "inbox" }, true);
          return;
        case "settings":
          await showPanel(chatId, { name: "settings" }, true);
          return;
        case "status":
          await showPanel(chatId, { name: "inbox" }, true);
          return;
        case "agent": {
          const a = arg.trim().toLowerCase();
          if (!a) {
            await showPanel(chatId, { name: "agentSettings" }, true);
            return;
          }
          if (a === "close" || a === "off" || a === "stop" || a === "leave") {
            await closeAgentWorkspace(chatId);
            return;
          }
          await openAgentWorkspace(chatId, arg.trim());
          return;
        }
        case "pair": {
          if (arg) {
            await tryPairCode(cfg, chatId, text);
            return;
          }
          const stP = await loadState();
          const req = stP.pairing;
          await tgSend(
            cfg,
            chatId,
            req ? `\u23F3 Pairing pending: "${req.name}" (chat ${req.chatId}) \u2014 code shown on the computer${cfg.ownerApprove ? ", owner approval required" : ""}.` : `This chat is already paired. To add another Telegram account: /start there, read the 6-character code printed on this computer, then send /pair CODE there.`
          );
          return;
        }
        case "unpair": {
          const target = arg ? Number(arg) : chatId;
          if (!Number.isFinite(target) || target <= 0) {
            await tgSend(cfg, chatId, `Usage: /unpair [chatId] (defaults to this chat).`);
            return;
          }
          if (target !== chatId && !(await loadConfig()).authorizedChatIds.includes(chatId)) {
            await tgSend(cfg, chatId, `Only paired chats can revoke others.`);
            return;
          }
          await patchConfigRemoveChat(target);
          await tgSend(cfg, chatId, `\u23F9 Chat ${target} unpaired. /start again there to pair anew.`);
          return;
        }
        case "approve":
        case "deny": {
          const target = Number(arg);
          if (!Number.isFinite(target)) {
            await tgSend(cfg, chatId, `Usage: /${cmd} <chatId> \u2014 pending pairing requests are listed with buttons too.`);
            return;
          }
          await handlePairDecision(cfg, chatId, target, cmd === "approve");
          return;
        }
        case "use":
        case "open": {
          const focus = await getFocus(chatId);
          if (!focus) {
            await showPanel(chatId, { name: "sessions", page: 0 }, true);
            return;
          }
          await showPanel(chatId, { name: "session", sid: focus.sid }, true);
          return;
        }
        case "abort": {
          const focus = await getFocus(chatId);
          if (!focus) {
            await showPanel(chatId, { name: "home" }, true);
            return;
          }
          try {
            const freshKey = (await loadState()).sessions[focus.sid]?.key ?? focus.key;
            await submitAction(freshKey, "session.abort", { sessionID: focus.sid });
          } catch (e) {
            log("warn", `abort: ${e?.message ?? e}`);
          }
          await showPanel(chatId, { name: "session", sid: focus.sid }, true);
          return;
        }
        case "reload": {
          const fresh = await loadConfig();
          await tgSend(cfg, chatId, `config reloaded (enabled: ${fresh.enabled}, chats: ${fresh.authorizedChatIds.length})`);
          await showPanel(chatId, { name: "settings" }, true);
          return;
        }
        default: {
          const focus = await getFocus(chatId);
          const st = await loadState();
          const targetSid = st.chats[chatId]?.agent?.sid ?? focus?.sid ?? "";
          const reg = targetSid ? st.sessions[targetSid] : null;
          if (reg) {
            const cmds = await submitAction(reg.key, "instance.commands", {}, 6e3).catch(() => []);
            const hit = (Array.isArray(cmds) ? cmds : []).find((c) => String(c?.name ?? c?.id ?? "").toLowerCase() === cmd);
            if (hit) {
              await runOpencodeCommand(cfg, chatId, targetSid, String(hit.name ?? hit.id ?? cmd), arg);
              return;
            }
          }
          await tgSend(cfg, chatId, `I didn't get that \u2014 here's Home.`);
          await showPanel(chatId, { name: "home" }, true);
          return;
        }
      }
    }
    async function inboxTick() {
      if (disposed || inboxing) return;
      inboxing = true;
      try {
        await inboxTickInner();
      } finally {
        inboxing = false;
      }
    }
    async function inboxTickInner() {
      if (disposed) return;
      let names = [];
      try {
        names = (await fsp.readdir(INBOX)).filter((n) => n.endsWith(".json")).sort();
      } catch {
        return;
      }
      for (const name of names) {
        if (disposed) return;
        const file = path2.join(INBOX, name);
        const item = await readJSON(file, null);
        if (!item || item.key !== KEY) continue;
        const claim = `${file}.claim`;
        try {
          await fsp.rename(file, claim);
        } catch {
          continue;
        }
        try {
          const data = await executeAction(item.action, item.payload);
          await enqueue({ t: "ack", id: item.id, ok: true, data, ts: Date.now(), key: KEY });
          log("debug", `action ${item.action} ok`);
        } catch (e) {
          await enqueue({ t: "ack", id: item.id, ok: false, error: clip(String(e?.message ?? e), 400), ts: Date.now(), key: KEY });
          log("warn", `action ${item.action} failed: ${e?.message ?? e}`);
        } finally {
          await fsp.rm(claim, { force: true }).catch(() => {
          });
        }
      }
    }
    async function setLinkOnline(detail) {
      await mutateState2((s) => {
        s.link = { status: "online", since: Date.now(), lastError: "", fails: 0 };
      });
      log("info", `Telegram reconnected (${detail})`);
      macNotify2("Raven", "Telegram reconnected \u2705");
    }
    async function setLinkOffline(errText) {
      await mutateState2((s) => {
        s.link = { status: "offline", since: Date.now(), lastError: errText, fails: (s.link?.fails ?? 0) + 1 };
      });
      log("error", `Telegram unreachable: ${errText} \u2014 check network/VPN/proxy ("proxy" in ${CFG_FILE}); retrying automatically`);
      macNotify2("Raven", `Telegram unreachable: ${errText}`);
    }
    async function tgLoop() {
      if (tgRunning || disposed) return;
      tgRunning = true;
      let fails = 0;
      let linkDown = false;
      let probed = false;
      let lastProxyNote = null;
      const OFFLINE_AFTER = 3;
      try {
        offset = Number(await fsp.readFile(OFFSET_FILE, "utf8").catch(() => "0")) || 0;
        try {
          const persisted = await loadState();
          linkDown = persisted.link?.status === "offline";
        } catch {
        }
        while (!disposed && await isLeader()) {
          const cfg = await loadConfig();
          if (!cfg.enabled || !cfg.botToken) {
            await new Promise((r) => setTimeout(r, 5e3));
            continue;
          }
          const proxyNote = cfg.proxy ? `proxy ${redactProxy2(cfg.proxy)} [${cfg.proxySource}]` : "direct (no proxy configured)";
          if (proxyNote !== lastProxyNote) {
            lastProxyNote = proxyNote;
            log("info", `Telegram transport: ${proxyNote}`);
          }
          if (!probed) {
            probed = true;
            try {
              const me = await tgApi(cfg, "getMe", {}, 15e3);
              fails = 0;
              void syncBotCommands(cfg);
              if (linkDown) {
                linkDown = false;
                await setLinkOnline(`bot @${me?.username ?? "?"}`);
              } else {
                await mutateState2((s) => {
                  s.link = { status: "online", since: s.link?.status === "online" ? s.link?.since ?? Date.now() : Date.now(), lastError: "", fails: 0 };
                });
                log("info", `Telegram link ok (bot @${me?.username ?? "?"})`);
              }
            } catch (e) {
              if (e?.telegram && (e.code === 401 || e.code === 404)) {
                log("error", `Telegram rejected the bot token (getMe: ${e.code}) \u2014 check botToken in ${CFG_FILE}, then restart OpenCode`);
              } else {
                const short = e?.telegram ? `Telegram error ${e.code ?? "?"}: ${clip(String(e.message).replace(/^getMe:\s*/, ""), 120)}` : shortNetError2(e);
                fails = OFFLINE_AFTER;
                if (!linkDown) {
                  linkDown = true;
                  await setLinkOffline(short);
                }
              }
            }
          }
          let batch = [];
          try {
            const res = await tgApi(
              cfg,
              "getUpdates",
              { offset, timeout: 50, limit: 100, allowed_updates: ["message", "callback_query"] },
              7e4
            );
            batch = Array.isArray(res) ? res : [];
            fails = 0;
            if (linkDown) {
              linkDown = false;
              await setLinkOnline("poll succeeded");
            }
          } catch (e) {
            if (e?.telegram && (e.code === 401 || e.code === 404)) {
              log("error", `telegram auth/method error \u2014 check botToken/apiBase in ${CFG_FILE}`);
              await new Promise((r) => setTimeout(r, 3e4));
            } else if (e?.telegram && e.code === 409) {
              log("warn", `getUpdates conflict (409): another poller is using this bot token \u2014 backing off 5s`);
              await new Promise((r) => setTimeout(r, 5e3));
            } else {
              fails++;
              const short = e?.telegram ? `Telegram error ${e.code ?? "?"}: ${clip(String(e.message).replace(/^getUpdates:\s*/, ""), 120)}` : shortNetError2(e);
              if (fails === 1) log("warn", `getUpdates failed (${short}) \u2014 retrying`);
              else if (fails % 10 === 0) log("warn", `Telegram still unreachable (${fails} failed polls): ${short}`);
              else log("debug", `getUpdates failed (${short}) [${fails} in a row]`);
              if (fails >= OFFLINE_AFTER && !linkDown) {
                linkDown = true;
                await setLinkOffline(short);
              }
              await new Promise((r) => setTimeout(r, 3e3));
            }
            continue;
          }
          if (!await isLeader()) break;
          for (const u of batch) {
            try {
              if (typeof u.update_id === "number") offset = Math.max(offset, u.update_id + 1);
              await handleUpdate(u);
            } catch (e) {
              log("warn", `update: ${e?.message ?? e}`);
            }
          }
          if (batch.length) await fsp.writeFile(OFFSET_FILE, String(offset), "utf8").catch(() => {
          });
        }
      } finally {
        tgRunning = false;
        if (!disposed && await isLeader()) {
          setTimeout(() => void tgLoop(), 1500);
        }
      }
    }
    async function hello() {
      await enqueue({ t: "hello", key: KEY, dir: MY_DIR, serverUrl: SERVER_URL, client: CLIENT, ts: Date.now() });
    }
    try {
      await fsp.mkdir(OUTBOX, { recursive: true });
      await fsp.mkdir(INBOX, { recursive: true });
      const cfg = await loadConfig();
      if (!cfg.enabled) {
        log("info", "disabled via config");
      } else if (!cfg.botToken) {
        log("warn", `no botToken in ${CFG_FILE}`);
      } else if (!cfg.authorizedChatIds.length) {
        const hint = "no paired chats yet \u2014 send /start to the Telegram bot and pair with the shown code";
        log("info", hint);
        try {
          console.log(`[raven] ${hint}`);
        } catch {
        }
      }
      log("info", `init client=${CLIENT} dir=${MY_DIR || "-"} server=${SERVER_URL || "-"}`);
      await hello();
      timers.push(setInterval(() => void leaderTick(), 3e3));
      timers.push(setInterval(() => void inboxTick(), 1e3));
      timers.push(setInterval(() => void hello(), 6e4));
      watchDir2(OUTBOX, () => kickDrain2());
      watchDir2(INBOX, () => kickInbox2());
      o.onReady?.();
      void leaderTick();
      void inboxTick();
    } catch (e) {
      log("error", `init failed: ${e?.message ?? e}`);
    }
    return {
      feedEvent: async (event) => {
        try {
          const cfg = await loadConfig();
          if (!cfg.enabled || !cfg.botToken) return;
          await enqueue({
            t: "event",
            key: KEY,
            dir: MY_DIR,
            serverUrl: SERVER_URL,
            client: CLIENT,
            ts: Date.now(),
            event: { type: event.type, properties: event.properties ?? {} }
          });
        } catch (e) {
          log("warn", `feedEvent: ${e?.message ?? e}`);
        }
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        for (const t of timers) {
          try {
            clearInterval(t);
          } catch {
          }
        }
        for (const w of watchers.splice(0)) {
          try {
            w.close();
          } catch {
          }
        }
        try {
          const o2 = await readOwner();
          if (o2?.key === KEY) await fsp.rm(LOCK, { recursive: true, force: true });
        } catch {
        }
        for (const [, w] of waiters) {
          clearTimeout(w.timer);
          w.reject(new Error("bridge disposing"));
        }
        waiters.clear();
        log("info", "disposed");
      }
    };
  }
}
var PAIR_TTL_MS, PAIR_MAX_ATTEMPTS, PAIR_ALPHABET, BUTTON_MAP, BOT_COMMANDS;
var init_core = __esm({
  "src/core.ts"() {
    "use strict";
    init_util();
    PAIR_TTL_MS = 10 * 6e4;
    PAIR_MAX_ATTEMPTS = 5;
    PAIR_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    BUTTON_MAP = {
      "\u{1F3E0} Home": "/start",
      "\u{1F4DA} Sessions": "/sessions",
      "\u2795 New": "/new",
      "\u{1F4E5} Inbox": "/inbox",
      "\u2699\uFE0F Settings": "/settings"
    };
    BOT_COMMANDS = /* @__PURE__ */ new Set([
      "start",
      "help",
      "sessions",
      "new",
      "inbox",
      "settings",
      "status",
      "use",
      "open",
      "abort",
      "reload",
      "skip",
      "cancel",
      "agent",
      "pair",
      "unpair",
      "approve",
      "deny"
    ]);
  }
});

// src/drivers/claude.ts
var claude_exports = {};
__export(claude_exports, {
  ClaudeDriver: () => ClaudeDriver
});
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fsp2 from "node:fs/promises";
import fs2 from "node:fs";
import os3 from "node:os";
import path3 from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";
function firstText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n").trim();
}
function msgOf(withParts) {
  return (withParts?.parts ?? []).map((p) => p?.text ?? "").join(" ").trim();
}
function describeTool(tool, input) {
  try {
    if (tool === "Bash" && typeof input?.command === "string") return `run: ${input.command.slice(0, 160)}`;
    if ((tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit") && input?.file_path) return `modify ${String(input.file_path).slice(0, 160)}`;
    if (tool === "Read" && input?.file_path) return `read ${String(input.file_path).slice(0, 160)}`;
    return JSON.stringify(input).slice(0, 160);
  } catch {
    return tool;
  }
}
var ALIAS_MODELS, ClaudeDriver;
var init_claude = __esm({
  "src/drivers/claude.ts"() {
    "use strict";
    init_util();
    ALIAS_MODELS = ["default", "sonnet", "opus", "haiku"];
    ClaudeDriver = class {
      bin;
      home;
      dirOf;
      emit;
      token = randomUUID2().slice(0, 12);
      server = null;
      port = 0;
      settingsFile = "";
      runs = /* @__PURE__ */ new Map();
      approvals = /* @__PURE__ */ new Map();
      byHook = /* @__PURE__ */ new Map();
      constructor(opts) {
        this.home = opts.home;
        this.dirOf = opts.dirOf;
        this.emit = opts.emit;
        this.bin = opts.bin || process.env.RAVEN_CLAUDE_BIN || "";
      }
      projectsRoot() {
        return process.env.CLAUDE_PROJECTS_DIR || path3.join(os3.homedir(), ".claude", "projects");
      }
      available() {
        return !!this.resolveBin();
      }
      resolveBin() {
        if (this.bin && fs2.existsSync(this.bin)) return this.bin;
        const viaPath = findOnPath(["claude"]);
        if (viaPath) return viaPath;
        const guesses = process.platform === "win32" ? [
          path3.join(process.env.APPDATA || path3.join(os3.homedir(), "AppData", "Roaming"), "npm", "claude.cmd"),
          path3.join(os3.homedir(), ".local", "bin", "claude.exe")
        ] : [path3.join(os3.homedir(), ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
        for (const g of guesses) if (g && fs2.existsSync(g)) return g;
        return null;
      }
      async start() {
        this.loadIdMap();
        await new Promise((resolve) => {
          this.server = createServer((req, res) => void this.handleHttp(req, res));
          this.server.listen(0, "127.0.0.1", () => {
            this.port = this.server.address().port;
            resolve();
          });
        });
        this.settingsFile = path3.join(this.home, "claude-settings.json");
        const hookUrl = `http://127.0.0.1:${this.port}/hook/${this.token}`;
        const settings = {
          hooks: {
            PreToolUse: [{ matcher: "", hooks: [{ type: "http", url: hookUrl, timeout: 600 }] }]
          }
        };
        await fsp2.writeFile(this.settingsFile, JSON.stringify(settings, null, 2), { mode: 384 });
      }
      async stop() {
        for (const [, r] of this.runs) {
          try {
            r.child.kill("SIGTERM");
          } catch {
          }
        }
        for (const [, a] of this.approvals) a.respond("deny");
        try {
          this.server?.close();
        } catch {
        }
      }
      async handleHttp(req, res) {
        const want = `/hook/${this.token}`;
        if (!String(req.url || "").startsWith(want)) {
          res.writeHead(404).end();
          return;
        }
        let body = "";
        req.on("data", (c) => body += c);
        req.on("error", () => {
        });
        await new Promise((done) => req.on("end", () => done()));
        let payload = {};
        try {
          payload = JSON.parse(body);
        } catch {
        }
        const sid = `cl_${payload.session_id || "unknown"}`;
        const tool = String(payload.tool_name ?? "tool");
        const input = payload.tool_input ?? {};
        const summary = describeTool(tool, input);
        const id = `per_cl_${randomUUID2().slice(0, 10)}`;
        const approval = {
          id,
          sid,
          tool,
          summary,
          respond: (decision) => {
            try {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: decision,
                    permissionDecisionReason: decision === "allow" ? "approved from Telegram" : "rejected from Telegram"
                  }
                })
              );
            } catch {
            }
            this.approvals.delete(id);
            void this.emit("permission.replied", { sessionID: sid, requestID: id, reply: decision === "allow" ? "once" : "reject" });
          }
        };
        this.approvals.set(id, approval);
        this.byHook.set(sid + payload.tool_use_id, approval);
        await this.emit("permission.asked", {
          id,
          sessionID: sid,
          permission: tool,
          patterns: [summary],
          metadata: {},
          always: []
        });
        req.on("close", () => {
          if (this.approvals.has(id) && this.byHook.get(sid + payload.tool_use_id) === approval) {
            this.approvals.delete(id);
            void this.emit("permission.replied", { sessionID: sid, requestID: id, reply: "reject" });
          }
        });
      }
      listSessions() {
        const rev = /* @__PURE__ */ new Map();
        for (const [ours, rid] of this.claudeId) rev.set(rid, ours);
        const out = [];
        let dirs = [];
        try {
          dirs = fs2.readdirSync(this.projectsRoot());
        } catch {
          return out;
        }
        for (const d of dirs) {
          const full = path3.join(this.projectsRoot(), d);
          let files = [];
          try {
            files = fs2.readdirSync(full).filter((f) => f.endsWith(".jsonl"));
          } catch {
            continue;
          }
          for (const f of files) {
            const fp = path3.join(full, f);
            try {
              const st = fs2.statSync(fp);
              const meta = this.transcriptMeta(fp);
              const uuid = f.replace(/\.jsonl$/, "");
              out.push({
                id: `cl_${rev.get(uuid) || uuid}`,
                title: meta.title || uuid.slice(0, 8),
                directory: meta.cwd || "",
                time: { updated: st.mtimeMs },
                model: meta.model ? { providerID: "anthropic", modelID: meta.model } : void 0,
                agent: meta.mode === "plan" ? "plan" : "build"
              });
            } catch {
            }
          }
        }
        out.sort((a, b) => b.time.updated - a.time.updated);
        return out.slice(0, 40);
      }
      transcriptMeta(fp) {
        const res = { title: "", cwd: "", model: "", mode: "" };
        try {
          const fd = fs2.openSync(fp, "r");
          const buf = Buffer.alloc(65536);
          const n = fs2.readSync(fd, buf, 0, buf.length, 0);
          fs2.closeSync(fd);
          for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
            if (!line.trim().startsWith("{")) continue;
            let j;
            try {
              j = JSON.parse(line);
            } catch {
              continue;
            }
            if (j.cwd && !res.cwd) res.cwd = String(j.cwd);
            if (j.type === "assistant" && j.message?.model && !res.model) res.model = String(j.message.model);
            const mode = j.message?.mode || j.mode;
            if (mode && !res.mode) res.mode = String(mode);
            if (!res.title && j.type === "user") {
              const t = firstText(j.message?.content);
              if (t) res.title = t.replace(/\s+/g, " ").slice(0, 60);
            }
            if (res.cwd && res.title && res.model) break;
          }
        } catch {
        }
        return res;
      }
      transcriptMessages(sid, limit = 8, before = "") {
        const uuid = this.realIdOf(sid);
        const fp = this.findTranscript(uuid);
        if (!fp) return [];
        let raw = "";
        try {
          raw = fs2.readFileSync(fp, "utf8");
        } catch {
          return [];
        }
        const msgs = [];
        for (const line of raw.split("\n")) {
          if (!line.trim().startsWith("{")) continue;
          let j;
          try {
            j = JSON.parse(line);
          } catch {
            continue;
          }
          if (j.type !== "user" && j.type !== "assistant") continue;
          const text = firstText(j.message?.content);
          if (!text) continue;
          msgs.push({
            info: {
              id: String(j.uuid || `${j.timestamp ?? ""}`),
              role: j.type,
              time: { created: Number(j.timestamp) || 0 },
              modelID: j.message?.model,
              agent: j.message?.mode
            },
            parts: [{ type: "text", text }]
          });
        }
        let out = msgs;
        if (before) {
          const idx = out.findIndex((m) => m.info.id === before);
          if (idx >= 0) out = out.slice(0, idx);
        }
        return out.slice(-limit);
      }
      findTranscript(uuid) {
        let dirs = [];
        try {
          dirs = fs2.readdirSync(this.projectsRoot());
        } catch {
          return null;
        }
        for (const d of dirs) {
          const fp = path3.join(this.projectsRoot(), d, `${uuid}.jsonl`);
          if (fs2.existsSync(fp)) return fp;
        }
        return null;
      }
      async list() {
        const sessions = this.listSessions();
        const statuses = {};
        const previews = {};
        for (const s of sessions) {
          if (this.runs.has(s.id)) statuses[s.id] = { type: "busy" };
          const last = this.transcriptMessages(s.id, 1)[0];
          if (last) previews[s.id] = String(msgOf(last).slice(0, 200));
        }
        return { sessions, statuses, previews };
      }
      async detail(sid) {
        const uuid = this.realIdOf(sid);
        const s = this.listSessions().find((x) => x.id === sid);
        const meta = s ? { cwd: s.directory, model: s.model?.modelID || "", mode: s.agent || "build" } : this.transcriptMeta(this.findTranscript(uuid) || "");
        const info = {
          id: sid,
          title: s?.title || uuid.slice(0, 8),
          directory: meta.cwd || "",
          time: { updated: s?.time?.updated || Date.now(), created: s?.time?.updated || Date.now() },
          model: meta.model ? { providerID: "anthropic", modelID: meta.model } : void 0,
          agent: meta.mode
        };
        return {
          info,
          status: this.runs.has(sid) ? { type: "busy" } : { type: "idle" },
          messages: this.transcriptMessages(sid, 8),
          children: []
        };
      }
      async createSession(title, dir) {
        const uuid = randomUUID2();
        const sid = `cl_${uuid}`;
        this.pendingCreate.set(sid, { title: title || "Claude chat", dir: dir || this.dirOf() });
        return { id: sid, title: title || "Claude chat", directory: dir || "", time: { updated: Date.now() } };
      }
      pendingCreate = /* @__PURE__ */ new Map();
      // our sid -> real claude session id (assigned on first run of a new session)
      claudeId = /* @__PURE__ */ new Map();
      mapFile() {
        return path3.join(this.home, "claude-map.json");
      }
      loadIdMap() {
        try {
          const j = JSON.parse(fs2.readFileSync(this.mapFile(), "utf8"));
          for (const [k, v] of Object.entries(j)) if (typeof v === "string") this.claudeId.set(k, v);
        } catch {
        }
      }
      saveIdMap() {
        try {
          fs2.writeFileSync(this.mapFile(), JSON.stringify(Object.fromEntries(this.claudeId)));
        } catch {
        }
      }
      realIdOf(sid) {
        return this.claudeId.get(sid) || sid.replace(/^cl_/, "");
      }
      async prompt(sid, text, model, agent) {
        if (this.runs.has(sid)) throw new Error("Claude is already answering in this session \u2014 wait or tap \u23F9 Stop");
        const bin = this.resolveBin();
        if (!bin) throw new Error(`claude binary not found (set RAVEN_CLAUDE_BIN or install Claude Code)`);
        const pc = this.pendingCreate.get(sid);
        const realId = this.realIdOf(sid);
        const hasTranscript = !!this.findTranscript(realId);
        const known = this.listSessions().find((s) => s.id === sid);
        const cwd = (known?.directory && fs2.existsSync(known.directory) ? known.directory : "") || (pc?.dir && fs2.existsSync(pc.dir) ? pc.dir : "") || this.dirOf();
        const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--settings", this.settingsFile];
        if (hasTranscript) args.push("--resume", realId);
        if (model?.modelID && model.modelID !== "default") args.push("--model", model.modelID);
        args.push("--permission-mode", agent === "plan" ? "plan" : "acceptEdits");
        const child = spawn(bin, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"], shell: spawnShellFor(bin) });
        const run = { sid, child, text: "", partialAt: 0 };
        this.runs.set(sid, run);
        await this.emit("session.status", { sessionID: sid, status: { type: "busy" } });
        if (!hasTranscript) {
          await this.emit("session.created", { info: { id: sid, title: pc?.title || text.slice(0, 60), directory: cwd, time: { updated: Date.now() } } });
          this.pendingCreate.delete(sid);
        }
        let buf = "";
        let finalText = "";
        let sawInit = false;
        let lastStderr = "";
        child.stdout.on("data", async (c) => {
          buf += c.toString("utf8");
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith("{")) continue;
            let j;
            try {
              j = JSON.parse(line);
            } catch {
              continue;
            }
            if (j.type === "system" && j.subtype === "init") {
              sawInit = true;
              if (!hasTranscript && j.session_id && String(j.session_id) !== sid.replace(/^cl_/, "")) {
                this.claudeId.set(sid, String(j.session_id));
                this.saveIdMap();
              }
            }
            if (j.type === "stream_event") {
              const d = j.event?.delta;
              if (d?.type === "text_delta" && typeof d.text === "string") {
                run.text += d.text;
                const now = Date.now();
                if (now - run.partialAt > 1200) {
                  run.partialAt = now;
                  await this.emit("message.part.updated", { sessionID: sid, part: { type: "text", text: run.text } });
                }
              }
            }
            if (j.type === "assistant" && !sawInit) {
              const t = firstText(j.message?.content);
              if (t && t.length > run.text.length) {
                run.text = t;
                await this.emit("message.part.updated", { sessionID: sid, part: { type: "text", text: run.text } });
              }
            }
            if (j.type === "system" && j.subtype === "api_retry") {
              const hint = lastStderr ? `: ${lastStderr.slice(0, 120)}` : "";
              await this.emit("session.status", { sessionID: sid, status: { type: "retry", attempt: j.attempt, message: `claude API retrying${hint}`.slice(0, 200) } });
            }
            if (j.type === "result") {
              finalText = String(j.result ?? run.text ?? "");
              if (j.is_error) {
                await this.emit("session.error", { sessionID: sid, error: { name: "ClaudeError", data: { message: finalText || lastStderr || "claude returned an error" } } });
              }
            }
          }
        });
        child.on("close", async (code) => {
          this.runs.delete(sid);
          const text2 = finalText || run.text;
          if (text2) await this.emit("message.part.updated", { sessionID: sid, part: { type: "text", text: text2 } });
          if (!text2 && code !== 0 && lastStderr) await this.emit("session.error", { sessionID: sid, error: { name: "ClaudeExit", data: { message: lastStderr.slice(0, 300) } } });
          await this.emit("session.status", { sessionID: sid, status: { type: "idle" } });
          await this.emit("session.updated", { info: { id: sid, time: { updated: Date.now() } } });
        });
        child.stderr.on("data", (c) => {
          lastStderr = String(c).trim().slice(0, 300) || lastStderr;
        });
        try {
          child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
          child.stdin.end();
        } catch {
        }
      }
      async abort(sid) {
        const r = this.runs.get(sid);
        if (!r) return false;
        try {
          r.child.kill("SIGTERM");
          return true;
        } catch {
          return false;
        }
      }
      pending() {
        return [...this.approvals.values()].map((a) => ({ id: a.id, sessionID: a.sid, permission: a.tool, patterns: [a.summary] }));
      }
      reply(requestID, reply) {
        const a = this.approvals.get(requestID);
        if (!a) throw new Error("Claude approval not found (answered already?)");
        a.respond(reply === "reject" ? "deny" : "allow");
      }
      providerList() {
        const models = {};
        for (const m of ALIAS_MODELS) models[m] = { id: m, name: m === "default" ? "default (CLI configured model)" : m };
        return { all: [{ id: "anthropic", name: "Claude", models }], connected: ["anthropic"], default: {} };
      }
    };
  }
});

// src/drivers/codex.ts
var codex_exports = {};
__export(codex_exports, {
  CodexDriver: () => CodexDriver
});
import { spawn as spawn2 } from "node:child_process";
import fs3 from "node:fs";
import os4 from "node:os";
import path4 from "node:path";
import { randomUUID as randomUUID3 } from "node:crypto";
function vscodeBundledCodex() {
  const extRoot = path4.join(os4.homedir(), ".vscode", "extensions");
  let entries = [];
  try {
    entries = fs3.readdirSync(extRoot);
  } catch {
    return null;
  }
  const exeNames = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
  const preferred = process.platform === "darwin" ? process.arch === "arm64" ? "macos-aarch64" : "macos-x86_64" : process.platform === "win32" ? process.arch === "arm64" ? "win32-arm64" : "win32-x64" : process.arch === "arm64" ? "linux-arm64" : "linux-x64";
  for (const e of entries) {
    if (!/openai\.chatgpt|codex/i.test(e)) continue;
    const binDir = path4.join(extRoot, e, "bin");
    let subs = [];
    try {
      subs = fs3.readdirSync(binDir);
    } catch {
      continue;
    }
    const ordered = [...subs.filter((s) => s === preferred), ...subs.filter((s) => s !== preferred)];
    for (const sub of ordered) {
      for (const exe of exeNames) {
        const p = path4.join(binDir, sub, exe);
        try {
          if (fs3.existsSync(p) && fs3.statSync(p).isFile()) return p;
        } catch {
        }
      }
    }
  }
  return null;
}
function turnsToMessages(turns) {
  const out = [];
  for (const t of turns) {
    const items = t?.items ?? t?._items ?? (Array.isArray(t) ? t : []);
    let userText = "";
    let assistantText = "";
    for (const it of items) {
      const type = String(it?.type ?? "").toLowerCase();
      if (type === "usermessage" || type === "user_message") userText += (userText ? "\n" : "") + String(it?.text ?? it?.content ?? "");
      if (type === "agentmessage" || type === "agent_message") assistantText += (assistantText ? "\n" : "") + String(it?.text ?? "");
    }
    const when = Number(t?.startedAt ?? t?.time?.created ?? 0);
    if (userText) out.push({ info: { id: `t${when}u`, role: "user", time: { created: when } }, parts: [{ type: "text", text: userText }] });
    if (assistantText) out.push({ info: { id: `t${when}a`, role: "assistant", time: { created: when } }, parts: [{ type: "text", text: assistantText }] });
  }
  return out;
}
var CodexDriver;
var init_codex = __esm({
  "src/drivers/codex.ts"() {
    "use strict";
    init_util();
    CodexDriver = class {
      bin;
      home;
      dirOf;
      emit;
      child = null;
      buf = "";
      rpcId = 1;
      rpcPending = /* @__PURE__ */ new Map();
      approvals = /* @__PURE__ */ new Map();
      busy = /* @__PURE__ */ new Set();
      streamText = /* @__PURE__ */ new Map();
      restarting = null;
      constructor(opts) {
        this.home = opts.home;
        this.dirOf = opts.dirOf;
        this.emit = opts.emit;
        this.bin = opts.bin || process.env.RAVEN_CODEX_BIN || "";
      }
      resolveBin() {
        if (this.bin && fs3.existsSync(this.bin)) return this.bin;
        const viaPath = findOnPath(["codex"]);
        if (viaPath) return viaPath;
        const guesses = process.platform === "win32" ? [
          path4.join(process.env.APPDATA || path4.join(os4.homedir(), "AppData", "Roaming"), "npm", "codex.cmd"),
          path4.join(os4.homedir(), ".local", "bin", "codex.exe")
        ] : [
          "/opt/homebrew/bin/codex",
          "/usr/local/bin/codex",
          path4.join(os4.homedir(), ".local", "bin", "codex")
        ];
        for (const g of guesses) if (g && fs3.existsSync(g)) return g;
        return vscodeBundledCodex();
      }
      available() {
        return !!this.resolveBin();
      }
      async ensure() {
        if (this.child && !this.child.killed && this.child.exitCode === null) return;
        if (this.restarting) return this.restarting;
        this.restarting = this.start().finally(() => this.restarting = null);
        return this.restarting;
      }
      async start() {
        const bin = this.resolveBin();
        if (!bin) throw new Error("codex binary not found (install @openai/codex or set RAVEN_CODEX_BIN)");
        const child = spawn2(bin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], cwd: this.dirOf(), env: process.env, shell: spawnShellFor(bin) });
        this.child = child;
        child.stdout.on("data", (c) => void this.onData(c.toString("utf8")));
        child.stderr.on("data", () => {
        });
        child.on("exit", () => {
          if (this.child === child) this.child = null;
          for (const p of this.rpcPending.values()) {
            clearTimeout(p.timer);
            p.reject(new Error("codex app-server exited"));
          }
          this.rpcPending.clear();
        });
        await this.rpc("initialize", { clientInfo: { name: "raven", title: "Raven", version: "1" }, capabilities: { experimentalApi: true } }, 2e4);
        this.notify("initialized", {});
      }
      async stop() {
        try {
          this.child?.kill("SIGTERM");
        } catch {
        }
        this.child = null;
      }
      onData(chunk) {
        this.buf += chunk;
        let idx;
        while ((idx = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, idx).trim();
          this.buf = this.buf.slice(idx + 1);
          if (!line.startsWith("{")) continue;
          let j;
          try {
            j = JSON.parse(line);
          } catch {
            continue;
          }
          void this.onMsg(j);
        }
      }
      async onMsg(j) {
        if (j.method && j.id !== void 0) {
          const handled = await this.onServerRequest(j);
          if (!handled) this.write({ id: j.id, result: {} });
          return;
        }
        if (j.id !== void 0 && (j.result !== void 0 || j.error !== void 0)) {
          const p = this.rpcPending.get(Number(j.id));
          if (p) {
            this.rpcPending.delete(Number(j.id));
            clearTimeout(p.timer);
            if (j.error) p.reject(new Error(String(j.error?.message ?? "codex rpc error")));
            else p.resolve(j.result);
          }
          return;
        }
        if (j.method) await this.onNotification(j);
      }
      threadOf(props) {
        const t = props?.threadId || props?.thread_id || props?.thread?.id || "";
        return t ? `cx_${t}` : "";
      }
      async onNotification(j) {
        const m = String(j.method || "");
        const p = j.params || {};
        const sid = this.threadOf(p);
        if (m === "turn/started" && sid) {
          this.busy.add(sid);
          this.streamText.set(sid, { full: "", at: 0 });
          await this.emit("session.status", { sessionID: sid, status: { type: "busy" } });
          return;
        }
        if (m === "item/agentMessage/delta" && sid) {
          const st = this.streamText.get(sid) ?? { full: "", at: 0 };
          st.full += String(p.delta ?? "");
          const now = Date.now();
          if (now - st.at > 1200) {
            st.at = now;
            await this.emit("message.part.updated", { sessionID: sid, part: { type: "text", text: st.full } });
          }
          return;
        }
        if (m === "item/completed" && sid) {
          const item = p.item || {};
          if (String(item.type || "").toLowerCase().includes("agentmessage")) {
            const text = String(item.text ?? "");
            if (text) {
              const st = this.streamText.get(sid);
              if (st) st.full = text;
              await this.emit("message.part.updated", { sessionID: sid, part: { type: "text", text } });
            }
          }
          return;
        }
        if (m === "turn/completed" && sid) {
          this.busy.delete(sid);
          const status = String(p.turn?.status ?? "completed");
          if (status === "failed") await this.emit("session.error", { sessionID: sid, error: { name: "CodexTurnFailed", data: { message: String(p.turn?.error?.message ?? "turn failed") } } });
          await this.emit("session.status", { sessionID: sid, status: { type: "idle" } });
          await this.emit("session.updated", { info: { id: sid, time: { updated: Date.now() } } });
          return;
        }
        if (m === "thread/status/changed" && sid) {
          const s = String(p.status?.type ?? p.status ?? "").toLowerCase();
          await this.emit("session.status", { sessionID: sid, status: { type: s.includes("active") || s.includes("busy") ? "busy" : "idle" } });
        }
      }
      async onServerRequest(j) {
        const m = String(j.method || "");
        const p = j.params || {};
        if (!/requestApproval/.test(m)) return false;
        const sid = this.threadOf(p);
        const rawCmd = p.command ?? p.reason ?? p.patch ?? "";
        const summary = Array.isArray(rawCmd) ? rawCmd.join(" ") : String(rawCmd).replace(/\s+/g, " ").slice(0, 200);
        const id = `per_cx_${randomUUID3().slice(0, 10)}`;
        this.approvals.set(id, { rpcId: j.id, threadId: sid, summary, method: m });
        await this.emit("permission.asked", {
          id,
          sessionID: sid,
          permission: m.includes("fileChange") ? "patch" : "exec",
          patterns: [summary || m],
          metadata: {},
          always: []
        });
        return true;
      }
      reply(requestID, decision) {
        const a = this.approvals.get(requestID);
        if (!a) throw new Error("Codex approval not found (answered already?)");
        this.approvals.delete(requestID);
        const value = decision === "reject" ? { decision: "decline" } : decision === "always" ? { decision: "acceptForSession" } : { decision: "accept" };
        this.write({ id: a.rpcId, result: value });
        void this.emit("permission.replied", { sessionID: a.threadId, requestID, reply: decision });
      }
      pending() {
        return [...this.approvals.entries()].map(([id, a]) => ({ id, sessionID: a.threadId, permission: a.method.includes("fileChange") ? "patch" : "exec", patterns: [a.summary] }));
      }
      write(msg) {
        try {
          this.child?.stdin?.write(JSON.stringify(msg) + "\n");
        } catch {
        }
      }
      rpc(method, params, timeoutMs = 2e4) {
        const id = this.rpcId++;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            this.rpcPending.delete(id);
            reject(new Error(`codex ${method}: timeout`));
          }, timeoutMs);
          this.rpcPending.set(id, { resolve, reject, timer });
          this.write({ id, method, params });
        });
      }
      notify(method, params) {
        this.write({ method, params });
      }
      async list() {
        await this.ensure();
        let res = null;
        try {
          res = await this.rpc("thread/list", { limit: 40, sortKey: "updated" });
        } catch (e) {
          throw e;
        }
        const arr = res?.threads ?? res?.data ?? res?.items ?? (Array.isArray(res) ? res : []);
        const sessions = arr.map((t) => ({
          id: `cx_${t.id ?? t.threadId}`,
          title: String(t.name || t.title || (Array.isArray(t.preview) ? t.preview.join(" ") : t.preview) || t.firstUserMessage || `${t.id ?? ""}`.slice(0, 8)).slice(0, 80),
          directory: String(t.cwd ?? t.directory ?? ""),
          time: { updated: Number(t.updatedAt ?? t.updated_at ?? t.time?.updated ?? Date.now()) },
          model: t.model ? { providerID: "openai", modelID: String(t.model) } : void 0
        }));
        const statuses = {};
        for (const s of sessions) if (this.busy.has(s.id)) statuses[s.id] = { type: "busy" };
        return { sessions, statuses, previews: {} };
      }
      async detail(sid) {
        await this.ensure();
        const threadId = sid.replace(/^cx_/, "");
        let turns = [];
        try {
          const r = await this.rpc("thread/read", { threadId, includeTurns: true });
          const t = r?.thread ?? r;
          turns = t?.turns ?? [];
          return {
            info: {
              id: sid,
              title: String(t?.name || t?.firstUserMessage || threadId.slice(0, 8)).slice(0, 80),
              directory: String(t?.cwd ?? ""),
              time: { updated: Number(t?.updatedAt ?? Date.now()) },
              model: t?.model ? { providerID: "openai", modelID: String(t.model) } : void 0,
              agent: "build"
            },
            status: this.busy.has(sid) ? { type: "busy" } : { type: "idle" },
            messages: turnsToMessages(turns).slice(-8),
            children: []
          };
        } catch {
          return {
            info: { id: sid, title: threadId.slice(0, 8), directory: "", time: { updated: Date.now() }, agent: "build" },
            status: this.busy.has(sid) ? { type: "busy" } : { type: "idle" },
            messages: [],
            children: []
          };
        }
      }
      history(sid, limit = 30) {
        const threadId = sid.replace(/^cx_/, "");
        const out = [];
        void threadId;
        void limit;
        return out;
      }
      async createSession(title, dir, model) {
        await this.ensure();
        const r = await this.rpc("thread/start", { cwd: dir || this.dirOf(), ...model && model !== "default" ? { model } : {} });
        const t = r?.thread ?? r;
        const id = String(t?.id ?? "");
        if (!id) throw new Error("codex thread/start returned no id");
        const sid = `cx_${id}`;
        await this.emit("session.created", { info: { id: sid, title: title || id.slice(0, 8), directory: dir || this.dirOf(), time: { updated: Date.now() } } });
        return { id: sid, title: title || id.slice(0, 8), directory: dir || "", time: { updated: Date.now() } };
      }
      async prompt(sid, text, model) {
        await this.ensure();
        const threadId = sid.replace(/^cx_/, "");
        this.busy.add(sid);
        await this.emit("session.status", { sessionID: sid, status: { type: "busy" } }).catch(() => {
        });
        try {
          await this.rpc(
            "turn/start",
            {
              threadId,
              input: [{ type: "text", text }],
              ...model?.modelID && model.modelID !== "default" ? { model: model.modelID } : {}
            },
            1e4
          );
        } catch (e) {
          this.busy.delete(sid);
          await this.emit("session.status", { sessionID: sid, status: { type: "idle" } }).catch(() => {
          });
          throw e;
        }
      }
      async abort(sid) {
        try {
          await this.rpc("turn/interrupt", { threadId: sid.replace(/^cx_/, "") }, 8e3);
          return true;
        } catch {
          return false;
        }
      }
      providerList() {
        const models = { default: { id: "default", name: "default (config.toml)" } };
        try {
          const raw = JSON.parse(fs3.readFileSync(path4.join(os4.homedir(), ".codex", "models_cache.json"), "utf8"));
          const arr = Array.isArray(raw) ? raw : raw?.models ?? raw?.data ?? [];
          for (const m of arr) {
            const id = String(m?.slug ?? m?.model ?? m?.id ?? "");
            if (id) models[id] = { id, name: String(m?.display_name ?? m?.name ?? id) };
          }
        } catch {
        }
        try {
          const cfg = fs3.readFileSync(path4.join(os4.homedir(), ".codex", "config.toml"), "utf8");
          const m = /^model\s*=\s*"([^"]+)"/m.exec(cfg);
          if (m && !models[m[1]]) models[m[1]] = { id: m[1], name: `${m[1]} (config)` };
        } catch {
        }
        const known = ["gpt-5.5", "gpt-5.1-codex-max", "gpt-5-codex"];
        for (const k of known) if (!models[k]) models[k] = { id: k, name: k };
        return { all: [{ id: "openai", name: "OpenAI", models }], connected: ["openai"], default: {} };
      }
    };
  }
});

// src/daemon.ts
var daemon_exports = {};
__export(daemon_exports, {
  runDaemon: () => runDaemon
});
import { execFile as execFile2 } from "node:child_process";
import fsp3 from "node:fs/promises";
import path5 from "node:path";
import { randomUUID as randomUUID4 } from "node:crypto";
async function gitState(dir) {
  const run = (args) => new Promise((res) => {
    execFile2("git", ["-C", dir, ...args], { timeout: 4e3 }, (e, out) => res(e ? "" : String(out ?? "").trim()));
  });
  const branch = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
  const branches = (await run(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads/"])).split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 8);
  return { branch, branches };
}
async function loadRavenConfig(home) {
  try {
    return JSON.parse(await fsp3.readFile(path5.join(home, "raven.json"), "utf8"));
  } catch {
    return {};
  }
}
async function runDaemon() {
  const home = ravenHome();
  await fsp3.mkdir(home, { recursive: true });
  const cfg = await loadRavenConfig(home);
  const workdir = String(cfg?.clients?.claude?.workspace || process.env.RAVEN_WORKDIR || process.cwd());
  let feed = null;
  const emit = async (type, properties) => {
    if (!feed) return;
    await feed(type, properties);
  };
  const claude = new ClaudeDriver({ bin: cfg?.clients?.claude?.bin, home, dirOf: () => workdir, emit });
  const codex = new CodexDriver({ bin: cfg?.clients?.codex?.bin, home, dirOf: () => workdir, emit });
  const claudeOn = cfg?.clients?.claude?.enabled !== false && claude.available();
  const codexOn = cfg?.clients?.codex?.enabled !== false && codex.available();
  if (claudeOn) await claude.start().catch(() => {
  });
  const bySid = (sid) => String(sid).startsWith("cl_") ? claude : String(sid).startsWith("cx_") ? codex : null;
  const anyDriver = () => claudeOn ? claude : codexOn ? codex : null;
  async function runAction(action, payload) {
    const sid = String(payload?.sessionID ?? payload?.sid ?? "");
    const d = bySid(sid) || (action === "session.create" ? payload?.client === "cx" ? codex : claude : null);
    switch (action) {
      case "session.list": {
        const sessions = [];
        const statuses = {};
        const previews = {};
        const parts = await Promise.allSettled([claudeOn ? claude.list() : null, codexOn ? codex.list() : null]);
        for (const r of parts) {
          if (r.status !== "fulfilled" || !r.value) continue;
          sessions.push(...r.value.sessions);
          Object.assign(statuses, r.value.statuses);
          Object.assign(previews, r.value.previews);
        }
        return { sessions, statuses, previews };
      }
      case "session.detail":
        if (!d) throw new Error("unknown session " + sid);
        return d.detail(sid);
      case "session.messages":
        if (!d) throw new Error("unknown session " + sid);
        return d.transcriptMessages ? d.transcriptMessages(sid, payload?.limit ?? 8) : (await d.detail(sid)).messages;
      case "session.history":
        if (!d) throw new Error("unknown session " + sid);
        if (d === claude) return claude.transcriptMessages(sid, payload?.limit ?? 30);
        return (await codex.detail(sid)).messages;
      case "session.get":
        if (!d) throw new Error("unknown session " + sid);
        return (await d.detail(sid)).info;
      case "session.create": {
        const target = payload?.client === "cx" ? codex : claude;
        return target.createSession(String(payload?.title ?? ""), String(payload?.dir ?? ""));
      }
      case "session.prompt":
        if (!d) throw new Error("unknown session " + sid);
        return d.prompt(sid, String(payload?.text ?? ""), payload?.model, payload?.agent);
      case "session.abort":
        if (!d) throw new Error("unknown session " + sid);
        return { aborted: await d.abort(sid) };
      case "provider.list":
        if (d === claude || claudeOn && !sid) return claude.providerList();
        if (d === codex || codexOn) return codex.providerList();
        return { all: [], connected: [], default: {} };
      case "permission.list": {
        const out = [];
        if (claudeOn) out.push(...claude.pending());
        if (codexOn) out.push(...codex.pending());
        return out;
      }
      case "permission.reply": {
        const rid = String(payload?.requestID ?? "");
        if (rid.startsWith("per_cl_")) return claude.reply(rid, String(payload?.reply ?? "reject"));
        if (rid.startsWith("per_cx_")) return codex.reply(rid, String(payload?.reply ?? "reject"));
        throw new Error("approval not owned by daemon");
      }
      case "question.list":
        return [];
      case "pending": {
        const permissions = [];
        const statuses = {};
        if (claudeOn) permissions.push(...claude.pending());
        if (codexOn) permissions.push(...codex.pending());
        const list = await runAction("session.list", {}).catch(() => null);
        return { permissions, questions: [], statuses: list?.statuses ?? {} };
      }
      case "instance.commands":
      case "instance.agents":
        return [];
      case "git.state": {
        const dir = String(payload?.dir ?? "") || workdir;
        if (!dir) return { branch: "", branches: [] };
        try {
          return await gitState(dir);
        } catch {
          return { branch: "", branches: [] };
        }
      }
      case "session.rename": {
        const reg = null;
        void reg;
        void anyDriver;
        throw new Error("renaming is only supported for opencode sessions");
      }
      default:
        throw new Error(`raven daemon: unknown action ${action}`);
    }
  }
  const handle = await startBridge({
    home,
    key: randomUUID4(),
    dir: "",
    serverUrl: "",
    client: "daemon",
    runAction
  });
  feed = (t, p) => handle.feedEvent({ type: t, properties: p });
  return {
    dispose: async () => {
      await handle.dispose();
      await claude.stop().catch(() => {
      });
      await codex.stop().catch(() => {
      });
    }
  };
}
var init_daemon = __esm({
  "src/daemon.ts"() {
    "use strict";
    init_core();
    init_util();
    init_claude();
    init_codex();
  }
});

// src/cli.ts
init_util();
import fs4 from "node:fs";
import fsp4 from "node:fs/promises";
import path6 from "node:path";
import os5 from "node:os";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
var HERE = path6.dirname(fileURLToPath(import.meta.url));
function cfgPath() {
  return path6.join(ravenHome(), "raven.json");
}
function opencodePluginsDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return path6.join(process.env.OPENCODE_CONFIG_DIR, "plugins");
  const xdg = process.env.XDG_CONFIG_HOME || path6.join(os5.homedir(), ".config");
  return path6.join(xdg, "opencode", "plugins");
}
function legacyPluginPaths() {
  const dir = opencodePluginsDir();
  return [path6.join(dir, "telegram-bridge.ts"), path6.join(dir, "telegram-bridge.js")];
}
function pluginPath() {
  return path6.join(opencodePluginsDir(), "raven.js");
}
function readCfg() {
  try {
    return JSON.parse(fs4.readFileSync(cfgPath(), "utf8"));
  } catch {
    return {};
  }
}
async function ask(question, hidden = false) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  if (!hidden) {
    const a2 = await new Promise((res) => rl.question(question, res));
    rl.close();
    return a2.trim();
  }
  process.stdout.write(question);
  try {
    process.stdin.setRawMode(true);
  } catch {
  }
  const a = await new Promise((res) => {
    let buf = "";
    const onData = (b) => {
      const s = b.toString("utf8");
      for (const ch of s) {
        if (ch === "\n" || ch === "\r") {
          process.stdin.off("data", onData);
          try {
            process.stdin.setRawMode(false);
          } catch {
          }
          process.stdout.write("\n");
          rl.close();
          res(buf.trim());
          return;
        }
        if (ch === "\x7F" || ch === "\b") buf = buf.slice(0, -1);
        else {
          buf += ch;
          process.stdout.write("*");
        }
      }
    };
    process.stdin.on("data", onData);
  });
  return a;
}
function guessOpencode() {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", ["opencode"], { stdio: "ignore" });
    return true;
  } catch {
    return process.platform === "darwin" && fs4.existsSync("/Applications/OpenCode.app");
  }
}
async function checkToken(token, proxy) {
  const envProxy = proxy ? { proxy } : null;
  void envProxy;
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(15e3) });
  const j = await res.json().catch(() => ({}));
  if (!j?.ok) throw new Error(j?.description || `http ${res.status}`);
  return String(j.result?.username ?? "bot");
}
async function cmdSetup(args) {
  const yes = args.includes("-y") || args.includes("--yes");
  const noService = args.includes("--no-service");
  const tokenFlag = args.includes("--token") ? args[args.indexOf("--token") + 1] : "";
  const proxyFlag = args.includes("--proxy") ? args[args.indexOf("--proxy") + 1] : "";
  let token = tokenFlag;
  if (!token) token = await ask("Telegram bot token (from @BotFather): ", true);
  if (!token) {
    console.error("no token provided");
    process.exit(1);
  }
  if (proxyFlag) {
    process.env.HTTPS_PROXY = proxyFlag;
    process.env.https_proxy = proxyFlag;
  }
  try {
    const bot = await checkToken(token, proxyFlag);
    console.log(`\u2705 token ok \u2014 bot @${bot}`);
  } catch (e) {
    console.error(`\u274C token rejected: ${e?.message ?? e}`);
    process.exit(1);
  }
  const home = ravenHome();
  await fsp4.mkdir(home, { recursive: true });
  const prev = readCfg();
  const legacy = (() => {
    try {
      return JSON.parse(fs4.readFileSync(path6.join(ravenHomeLegacyFile(), "telegram-bridge.json"), "utf8"));
    } catch {
      return null;
    }
  })();
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
      codex: { enabled: true, bin: prev?.clients?.codex?.bin || "" }
    }
  };
  await fsp4.writeFile(cfgPath(), JSON.stringify(cfg, null, 2), { mode: 384 });
  console.log(`config \u2192 ${cfgPath()}`);
  const pdir = opencodePluginsDir();
  await fsp4.mkdir(pdir, { recursive: true });
  const bundled = path6.join(HERE, "raven-plugin.js");
  if (fs4.existsSync(bundled)) {
    await fsp4.copyFile(bundled, pluginPath());
    console.log(`opencode plugin \u2192 ${pluginPath()}`);
  } else {
    console.log(`\u26A0 plugin bundle not found next to the CLI (${bundled}) \u2014 opencode steps skipped`);
  }
  for (const l of legacyPluginPaths()) {
    try {
      await fsp4.rm(l, { force: true });
      console.log(`removed legacy ${l}`);
    } catch {
    }
  }
  if (!noService) {
    if (process.platform !== "darwin") {
      console.log("background service is macOS (launchd) only \u2014 skipped.");
      console.log("run `raven run` under your supervisor to keep the daemon alive (see README).");
    } else {
      try {
        await installService();
      } catch (e) {
        console.log(`service install skipped: ${e?.message ?? e}`);
      }
    }
  }
  console.log("");
  console.log("Next steps:");
  console.log("  1. Restart OpenCode Desktop (or run `raven run` to start the daemon now).");
  console.log("  2. Open your bot in Telegram and send /start.");
  console.log("  3. Raven prints a 6-character pairing code in the terminal (plus a desktop notification on macOS).");
  console.log(`  4. Reply to the bot with: /pair THECODE \u2014 that links this chat. Anyone unpaired can never read your sessions.`);
  if (yes) console.log("(non-interactive: done)");
}
function ravenHomeLegacyFile() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME || path6.join(os5.homedir(), ".config");
  return path6.join(xdg, "opencode");
}
function plistPath() {
  return path6.join(os5.homedir(), "Library", "LaunchAgents", "dev.raven.daemon.plist");
}
async function installService() {
  const [head, ...tail] = [process.env.RAVEN_BIN || process.execPath, process.env.RAVEN_CLI_ENTRY || path6.join(HERE, "raven-cli.js"), "run"];
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
  <key>WorkingDirectory</key><string>${os5.homedir()}</string>
</dict>
</plist>
`;
  await fsp4.mkdir(path6.dirname(plistPath()), { recursive: true });
  await fsp4.writeFile(plistPath(), plist);
  const domain = `gui/${process.getuid?.() ?? 501}`;
  const label = "dev.raven.daemon";
  let loaded = false;
  try {
    execFileSync("launchctl", ["print", domain + "/" + label], { stdio: "ignore" });
    loaded = true;
  } catch {
  }
  if (loaded) {
    execFileSync("launchctl", ["kickstart", "-k", domain + "/" + label], { stdio: "inherit" });
  } else {
    execFileSync("launchctl", ["bootstrap", domain, plistPath()], { stdio: "inherit" });
  }
  console.log(`launchd service installed \u2192 ${plistPath()}`);
}
async function cmdRun() {
  const { runDaemon: runDaemon2 } = await Promise.resolve().then(() => (init_daemon(), daemon_exports));
  const d = await runDaemon2();
  const bye = async () => {
    await d.dispose();
    process.exit(0);
  };
  process.on("SIGINT", () => void bye());
  process.on("SIGTERM", () => void bye());
  console.log(`[raven] daemon running (home: ${ravenHome()}) \u2014 Ctrl-C to stop`);
}
async function cmdStatus() {
  const cfg = readCfg();
  const home = ravenHome();
  const owner = (() => {
    try {
      return JSON.parse(fs4.readFileSync(path6.join(home, "leader.lock", "owner.json"), "utf8"));
    } catch {
      return null;
    }
  })();
  const state = (() => {
    try {
      return JSON.parse(fs4.readFileSync(path6.join(home, "state.json"), "utf8"));
    } catch {
      return null;
    }
  })();
  console.log("config     :", cfgPath(), cfg.botToken ? `(token ${String(cfg.botToken).slice(0, 6)}\u2026)` : "(missing!)");
  console.log("paired     :", (cfg.authorizedChatIds ?? []).join(", ") || "none \u2014 send /start to the bot to pair");
  console.log("leader     :", owner ? `${String(owner.key).slice(0, 8)} (pid ${owner.pid})` : "none");
  console.log("link       :", state?.link?.status ?? "?", state?.link?.lastError ? `(${state.link.lastError.slice(0, 60)})` : "");
  console.log("opencode   :", guessOpencode() ? "found" : "not found");
  const { ClaudeDriver: ClaudeDriver2 } = await Promise.resolve().then(() => (init_claude(), claude_exports));
  const { CodexDriver: CodexDriver2 } = await Promise.resolve().then(() => (init_codex(), codex_exports));
  console.log("claude bin :", new ClaudeDriver2({ home, dirOf: () => process.cwd(), emit: async () => {
  } }).resolveBin() ?? "not found");
  console.log("codex bin  :", new CodexDriver2({ home, dirOf: () => process.cwd(), emit: async () => {
  } }).resolveBin() ?? "not found");
  console.log("logs       :", path6.join(home, "raven.log"));
}
async function cmdLogs(follow) {
  const file = path6.join(ravenHome(), "raven.log");
  const printTail = (n) => {
    try {
      const raw = fs4.readFileSync(file, "utf8").split("\n");
      const lines = raw[raw.length - 1] === "" ? raw.slice(0, -1) : raw;
      for (const l of lines.slice(-n)) console.log(l);
    } catch {
      console.log(`no log file yet at ${file} (is the daemon running?)`);
    }
  };
  if (!follow) {
    printTail(80);
    return;
  }
  printTail(20);
  let pos = 0;
  try {
    pos = fs4.statSync(file).size;
  } catch {
    return;
  }
  const timer = setInterval(() => {
    try {
      const size = fs4.statSync(file).size;
      if (size < pos) pos = 0;
      if (size > pos) {
        const fd = fs4.openSync(file, "r");
        const buf = Buffer.alloc(size - pos);
        fs4.readSync(fd, buf, 0, buf.length, pos);
        fs4.closeSync(fd);
        pos = size;
        process.stdout.write(buf.toString("utf8"));
      }
    } catch {
    }
  }, 500);
  const stop = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
function launchdGuard() {
  if (process.platform === "darwin") return true;
  console.log("the background service is macOS (launchd) only \u2014 run `raven run` under your supervisor instead.");
  return false;
}
async function cmdUninstall(purge) {
  if (process.platform === "darwin") {
    try {
      execFileSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/dev.raven.daemon`], { stdio: "ignore" });
    } catch {
    }
    try {
      await fsp4.rm(plistPath(), { force: true });
    } catch {
    }
    console.log("removed service");
  }
  await fsp4.rm(pluginPath(), { force: true });
  for (const l of legacyPluginPaths()) await fsp4.rm(l, { force: true });
  console.log("removed plugin");
  if (purge) {
    await fsp4.rm(ravenHome(), { recursive: true, force: true });
    console.log("removed", ravenHome());
  } else {
    console.log(`kept config/logs in ${ravenHome()} (use --purge to remove)`);
  }
}
async function main() {
  const [, , cmd = "help", ...rest] = process.argv;
  switch (cmd) {
    case "setup":
      await cmdSetup(rest);
      break;
    case "run":
      await cmdRun();
      break;
    case "service":
      if (!launchdGuard()) break;
      if (rest[0] === "remove") {
        try {
          execFileSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/dev.raven.daemon`], { stdio: "ignore" });
          await fsp4.rm(plistPath(), { force: true });
          console.log("service removed");
        } catch (e) {
          console.error("remove failed:", e?.message ?? e);
        }
      } else if (rest[0] === "status") {
        try {
          console.log(execFileSync("launchctl", ["print", `gui/${process.getuid?.() ?? 501}/dev.raven.daemon`], { encoding: "utf8" }));
        } catch {
          console.log("service not installed");
        }
      } else {
        await installService();
      }
      break;
    case "pair": {
      try {
        const stt = JSON.parse(fs4.readFileSync(path6.join(ravenHome(), "state.json"), "utf8"));
        const pr = stt.pairing;
        if (pr && Date.now() - pr.createdAt < 10 * 6e4) {
          console.log(`Pairing request from "${pr.name}" (chat ${pr.chatId}) \u2014 code: ${pr.code}`);
          console.log(`They should send:  /pair ${pr.code}`);
        } else {
          console.log("No pending pairing request. From the new Telegram chat send /start to the bot first, then run 'raven pair' again to read its code.");
        }
      } catch {
        console.log("No pairing request found (is the daemon or OpenCode running?). Start it with 'raven run' or open OpenCode.");
      }
      break;
    }
    case "status":
      await cmdStatus();
      break;
    case "logs":
      await cmdLogs(rest.includes("-f") || rest.includes("--follow"));
      break;
    case "uninstall":
      await cmdUninstall(rest.includes("--purge"));
      break;
    default:
      console.log(
        [
          "raven \u2014 Telegram bridge for opencode \xB7 Claude Code \xB7 Codex",
          "",
          "usage:",
          "  raven setup            wizard: token, config, plugin, background service (macOS)",
          "  raven run              run the daemon in the foreground",
          "  raven service install|remove|status   (macOS launchd only)",
          "  raven pair             show the pending pairing code (send /start in the new chat first)",
          "  raven status           what's paired, who's leader, where logs live",
          "  raven logs [-f]        tail the bridge log",
          "  raven uninstall [--purge]"
        ].join("\n")
      );
  }
}
main().catch((e) => {
  console.error("raven:", e?.message ?? e);
  process.exit(1);
});
