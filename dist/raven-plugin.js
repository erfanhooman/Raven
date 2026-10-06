// src/opencode.ts
import { execFile as execFile2 } from "node:child_process";
import { randomUUID as randomUUID2 } from "node:crypto";

// src/core.ts
import fsp from "node:fs/promises";
import { watch } from "node:fs";
import path2 from "node:path";
import os2 from "node:os";
import net from "node:net";
import tls from "node:tls";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

// src/util.ts
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

// src/core.ts
var PAIR_TTL_MS = 10 * 6e4;
var PAIR_MAX_ATTEMPTS = 5;
var PAIR_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
var BUTTON_MAP = {
  "\u{1F3E0} Home": "/start",
  "\u{1F4DA} Sessions": "/sessions",
  "\u2795 New": "/new",
  "\u{1F4E5} Inbox": "/inbox",
  "\u2699\uFE0F Settings": "/settings"
};
var BOT_COMMANDS = /* @__PURE__ */ new Set([
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
    }, pairingHelp2 = function() {
      return [
        `\u{1F510} Raven isn't paired with this Telegram account yet.`,
        ``,
        `A one-time code was just shown ON YOUR COMPUTER (terminal + desktop notification; re-read it anytime with \`raven pair\`).`,
        `Send it here as:  /pair CODE`,
        `(expires in 10 minutes \u2014 the code never appears here in Telegram)`
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
    }, desktopNotify2 = function(title, msg) {
      try {
        if (process.platform === "darwin") {
          execFile("/usr/bin/osascript", ["-e", `display notification ${JSON.stringify(msg)} with title ${JSON.stringify(title)}`], () => {
          });
          return;
        }
        if (process.platform === "win32") {
          const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
          const xml = `<toast><visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(msg)}</text></binding></visual></toast>`;
          const ps = [
            `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null`,
            `$doc = New-Object Windows.Data.Xml.Dom.XmlDocument`,
            `$doc.LoadXml('${xml.replace(/'/g, "''")}')`,
            `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Raven.Telegram.Bot').Show($doc)`
          ].join("; ");
          execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 1e4 }, () => {
          });
          return;
        }
        execFile("notify-send", [title, msg], { timeout: 1e4 }, () => {
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
    var clientOf = clientOf2, clientName = clientName2, clientIcon = clientIcon2, noteInstanceResult = noteInstanceResult2, isInstanceUp = isInstanceUp2, scheduleWork = scheduleWork2, atomicWrite = atomicWrite2, saveState = saveState2, mutateState = mutateState2, kickDrain = kickDrain2, kickInbox = kickInbox2, watchDir = watchDir2, turnCardText = turnCardText2, buildQuestionKeyboard = buildQuestionKeyboard2, redactProxy = redactProxy2, readSock = readSock2, buildMultipart = buildMultipart2, makePairCode = makePairCode2, pairingHelp = pairingHelp2, formatStatus = formatStatus2, renderModelPage = renderModelPage2, permCardText = permCardText2, permCardKeyboard = permCardKeyboard2, questionCardText = questionCardText2, textPartsOf = textPartsOf2, buildTranscript = buildTranscript2, renderSelectionText = renderSelectionText2, desktopNotify = desktopNotify2, shortNetError = shortNetError2;
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
      macNotify("Raven \u2014 pairing", `Code ${req.code} \u2014 send /pair ${req.code} to the bot`);
      log("info", msg);
    }
    async function askOwnersToApprove(cfg, req) {
      const text = `\u{1F510} Pairing request: "${req.name}" (chat ${req.chatId})
Approve this account? (they must still enter the code shown on this computer)`;
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
        await tgSend(cfg, chatId, pairingHelp2());
        return;
      }
      const req = { code: makePairCode2(), chatId, name, createdAt: Date.now(), attempts: 0, ownerApproved: false };
      await mutateState2((s) => void (s.pairing = req));
      await announcePairing(req);
      if (cfg.ownerApprove) await askOwnersToApprove(cfg, req);
      await tgSend(cfg, chatId, pairingHelp2());
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
      await tgSend(cfg, fromChat, `\u2705 Approved. They can now send /pair with the code shown on this computer.`);
      await tgSend(cfg, targetChat, `\u2705 Approved by the owner! Now send /pair with the code shown on the computer.`).catch(() => {
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
    const macNotify = desktopNotify2;
    async function setLinkOnline(detail) {
      await mutateState2((s) => {
        s.link = { status: "online", since: Date.now(), lastError: "", fails: 0 };
      });
      log("info", `Telegram reconnected (${detail})`);
      macNotify("Raven", "Telegram reconnected \u2705");
    }
    async function setLinkOffline(errText) {
      await mutateState2((s) => {
        s.link = { status: "offline", since: Date.now(), lastError: errText, fails: (s.link?.fails ?? 0) + 1 };
      });
      log("error", `Telegram unreachable: ${errText} \u2014 check network/VPN/proxy ("proxy" in ${CFG_FILE}); retrying automatically`);
      macNotify("Raven", `Telegram unreachable: ${errText}`);
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

// src/opencode.ts
function createOpencodeDriver(input) {
  const MY_DIR = String(input.directory ?? process.cwd());
  const SERVER_URL = String(input.serverUrl ?? "http://127.0.0.1:4096").replace(/\/+$/, "");
  function authHeaders() {
    const pw = process.env.OPENCODE_SERVER_PASSWORD;
    if (!pw) return {};
    const user = process.env.OPENCODE_SERVER_USERNAME || "opencode";
    return { Authorization: "Basic " + Buffer.from(`${user}:${pw}`).toString("base64") };
  }
  async function oc(method, p, opts = {}) {
    const qs = new URLSearchParams({ ...opts.qs ?? {}, directory: MY_DIR });
    const url = `${SERVER_URL}${p}?${qs.toString()}`;
    const res = await fetch(url, {
      method,
      headers: {
        ...authHeaders(),
        ...opts.body !== void 0 ? { "content-type": "application/json" } : {}
      },
      body: opts.body !== void 0 ? JSON.stringify(opts.body) : void 0,
      signal: AbortSignal.timeout(2e4)
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`${method} ${p} -> ${res.status} ${txt.slice(0, 300)}`);
    }
    if (res.status === 204) return null;
    return res.json().catch(() => null);
  }
  async function executeAction(action, payload) {
    switch (action) {
      case "session.list": {
        const [sessions, statuses] = await Promise.all([
          oc("GET", "/session", { qs: { limit: "25" } }),
          oc("GET", "/session/status").catch(() => ({}))
        ]);
        const list = Array.isArray(sessions) ? sessions : [];
        const previews = {};
        await Promise.all(
          list.slice(0, 12).map(async (s) => {
            try {
              const msgs = await oc("GET", `/session/${encodeURIComponent(s.id)}/message`, { qs: { limit: "1" } });
              const last = Array.isArray(msgs) && msgs.length ? msgs[0] : null;
              const t = last ? msgText2(last) : "";
              if (t) previews[s.id] = t.replace(/\s+/g, " ");
            } catch {
            }
          })
        );
        return { sessions: list, statuses: statuses ?? {}, previews };
      }
      case "session.detail": {
        const sid = payload.sessionID;
        const [info, statuses, messages, children] = await Promise.all([
          oc("GET", `/session/${encodeURIComponent(sid)}`),
          oc("GET", "/session/status").catch(() => ({})),
          oc("GET", `/session/${encodeURIComponent(sid)}/message`, { qs: { limit: "8" } }).catch(() => []),
          oc("GET", `/session/${encodeURIComponent(sid)}/children`).catch(() => [])
        ]);
        return {
          info,
          status: (statuses ?? {})[sid] ?? { type: "idle" },
          messages: Array.isArray(messages) ? messages : [],
          children: Array.isArray(children) ? children : []
        };
      }
      case "session.history": {
        const qs = { limit: String(payload.limit ?? 30) };
        if (payload.before) qs.before = payload.before;
        const msgs = await oc("GET", `/session/${encodeURIComponent(payload.sessionID)}/message`, { qs });
        return Array.isArray(msgs) ? msgs : [];
      }
      case "session.get":
        return oc("GET", `/session/${encodeURIComponent(payload.sessionID)}`);
      case "session.messages":
        return oc("GET", `/session/${encodeURIComponent(payload.sessionID)}/message`, {
          qs: { limit: String(payload.limit ?? 8) }
        });
      case "session.create":
        return oc("POST", "/session", { body: payload?.title ? { title: payload.title } : {} });
      case "session.prompt": {
        const body = { parts: [{ type: "text", text: payload.text }] };
        if (payload.model) body.model = payload.model;
        if (payload.agent) body.agent = payload.agent;
        return oc("POST", `/session/${encodeURIComponent(payload.sessionID)}/prompt_async`, { body });
      }
      case "session.abort":
        return oc("POST", `/session/${encodeURIComponent(payload.sessionID)}/abort`);
      case "session.command":
        return oc("POST", `/session/${encodeURIComponent(payload.sessionID)}/command`, {
          body: { command: payload.command, arguments: payload.arguments ?? "" }
        });
      case "session.revert":
        return oc("POST", `/session/${encodeURIComponent(payload.sessionID)}/revert`, {
          body: payload?.messageID ? { messageID: payload.messageID } : {}
        });
      case "session.changes":
        return oc("GET", `/session/${encodeURIComponent(payload.sessionID)}/diff`).catch(() => []);
      case "session.tasks":
        return oc("GET", `/session/${encodeURIComponent(payload.sessionID)}/todo`).catch(() => []);
      case "instance.agents": {
        const r = await oc("GET", `/agent`);
        if (Array.isArray(r)) return r;
        for (const k of ["agents", "all", "data", "items"]) if (Array.isArray(r?.[k])) return r[k];
        return [];
      }
      case "instance.commands": {
        const r = await oc("GET", `/command`).catch(() => []);
        if (Array.isArray(r)) return r;
        for (const k of ["commands", "all", "data", "items"]) if (Array.isArray(r?.[k])) return r[k];
        return [];
      }
      case "provider.list":
        return oc("GET", `/provider`).catch(() => null);
      case "permission.list":
        return oc("GET", "/permission");
      case "permission.reply":
        return oc("POST", `/permission/${encodeURIComponent(payload.requestID)}/reply`, {
          body: { reply: payload.reply, ...payload.message ? { message: payload.message } : {} }
        });
      case "question.list":
        return oc("GET", "/question");
      case "question.reply":
        return oc("POST", `/question/${encodeURIComponent(payload.requestID)}/reply`, {
          body: { answers: payload.answers }
        });
      case "question.reject":
        return oc("POST", `/question/${encodeURIComponent(payload.requestID)}/reject`);
      case "pending": {
        const [permissions, questions, statuses] = await Promise.all([
          oc("GET", "/permission").catch(() => []),
          oc("GET", "/question").catch(() => []),
          oc("GET", "/session/status").catch(() => ({}))
        ]);
        return { permissions: permissions ?? [], questions: questions ?? [], statuses: statuses ?? {} };
      }
      case "git.state": {
        const dir = String(payload?.dir || MY_DIR);
        const run = (args) => new Promise((res) => {
          execFile2("git", ["-C", dir, ...args], { timeout: 4e3 }, (e, out) => res(e ? "" : String(out ?? "").trim()));
        });
        const branch = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
        const branches = (await run(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads/"])).split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 8);
        return { branch, branches };
      }
      default:
        throw new Error(`unknown action ${action}`);
    }
  }
  return { dir: MY_DIR, serverUrl: SERVER_URL, runAction: executeAction };
}
function msgText2(withParts) {
  const parts = withParts?.parts ?? [];
  const texts = parts.filter((p) => p?.type === "text" && typeof p.text === "string" && p.text.trim()).map((p) => String(p.text).trim());
  const tools = parts.filter((p) => p?.type === "tool" && p?.tool).map((p) => {
    const cmd = typeof p.state?.input?.command === "string" ? `: ${String(p.state.input.command).slice(0, 60)}` : "";
    const out = typeof p.state?.output === "string" && p.state.output.trim() ? ` \u2192 ${String(p.state.output.trim()).slice(0, 80)}` : "";
    return `\u{1F527} ${p.tool}${cmd}${out}`;
  });
  return [...texts, ...tools].join("\n").trim();
}
async function startOpencodePlugin(input) {
  const driver = createOpencodeDriver(input);
  return startBridge({
    home: ravenHome(),
    key: randomUUID2(),
    dir: driver.dir,
    serverUrl: driver.serverUrl,
    client: "oc",
    runAction: driver.runAction
  });
}

// src/plugin.ts
var INTERESTING = /* @__PURE__ */ new Set([
  "permission.asked",
  "permission.replied",
  "permission.v2.asked",
  "permission.v2.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "question.v2.asked",
  "question.v2.replied",
  "question.v2.rejected",
  "session.status",
  "session.idle",
  "session.error",
  "message.part.updated",
  "session.created",
  "session.updated",
  "session.deleted"
]);
var plugin_default = {
  id: "raven",
  server: async (input, _options) => {
    const handle = await startOpencodePlugin(input);
    return {
      event: async ({ event }) => {
        try {
          if (!event?.type || !INTERESTING.has(event.type)) return;
          await handle.feedEvent({ type: event.type, properties: event.properties ?? {} });
        } catch {
        }
      },
      dispose: async () => {
        await handle.dispose();
      }
    };
  }
};
export {
  plugin_default as default
};
