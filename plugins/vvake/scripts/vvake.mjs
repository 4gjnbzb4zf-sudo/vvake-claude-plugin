#!/usr/bin/env node
/**
 * VVake for Claude Code: the UserPromptSubmit hook, the /vvake:* commands, the pairing poller and the lock watcher.
 *
 *   vvake.mjs hook                 the hook (JSON on stdin, JSON on stdout)
 *   vvake.mjs status|unlock|skip|link [local]|unlink|urgent [2h|30m|today|off]|help
 *   vvake.mjs poll | watch         background helpers (started by the hook, detached)
 *
 * Privacy: the prompt is read only to spot `/vvake:` commands and the `urgent:` prefix, here, on this machine. It is
 * never stored and never sent. The API only ever gets desk minutes and timestamps (see README).
 * State: $VVAKE_HOME/claude (default ~/.vvake/claude), the token in a 0600 file. API: $VVAKE_API.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RULE,
  LOCAL_RULE,
  MIN,
  URGENT_HINT,
  URGENT_PREFIX,
  clock,
  deskMinutes,
  emergencyUnlock,
  initialState,
  localDay,
  onPrompt,
  parseCommand,
  parseDuration,
  rollDay,
  skip,
  startUrgent,
  statusLine,
  stopUrgent,
  urgentOn,
} from "../lib/core.mjs";
import { encodeQr, qrToTerminal } from "../lib/qr.mjs";

const SELF = fileURLToPath(import.meta.url);
const API = (process.env.VVAKE_API || "https://vvake-api.val-54e.workers.dev").replace(/\/+$/, "");
const DIR = join(process.env.VVAKE_HOME || join(homedir(), ".vvake"), "claude");
const UA = "vvake-claude-plugin/0.1";
/** Tests only: a fixed clock. */
const now = () => (process.env.VVAKE_NOW_MS ? Number(process.env.VVAKE_NOW_MS) : Date.now());
const CACHE_MS = 5 * MIN;
const IS_MAC = platform() === "darwin";

// ── Files ──────────────────────────────────────────────────────────────────

const file = (name) => join(DIR, name);

function readJson(name, fallback = null) {
  try {
    return JSON.parse(readFileSync(file(name), "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(name, data, mode = 0o644) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const tmp = file(`${name}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 1), { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file(name));
}

const remove = (name) => rmSync(file(name), { force: true });

const loadState = (t) => rollDay({ ...initialState(localDay(t)), ...readJson("state.json", {}) }, localDay(t));
const saveState = (s) => writeJson("state.json", s);
/** { token, deskId, name } in a 0600 file. */
const loadToken = () => readJson("token.json");
const config = () => readJson("config.json", {});

// ── API ────────────────────────────────────────────────────────────────────

async function api(method, path, { body, token, timeoutMs = 3000 } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { "user-agent": UA, ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

/** Rule + urgent / busy, cached 5 min; `report` sends desk minutes and the lock start (nothing else). */
async function remoteState(tok, { force = false, sinceMs = null, report = null } = {}) {
  const cache = readJson("cache.json");
  const t = now();
  if (!force && sinceMs === null && !report && cache && t - cache.fetchedMs < CACHE_MS) return { ...cache, ok: true, movedMin: null };
  try {
    const body = { ...(sinceMs !== null ? { since: new Date(sinceMs).toISOString() } : {}), ...(report ?? {}) };
    const r = await api("POST", "/v1/desk/sync", { token: tok.token, body });
    if (r.status === 401) return { revoked: true };
    if (r.status !== 200 || !r.data?.rule) throw new Error(`sync ${r.status}`);
    const fresh = { rule: { ...DEFAULT_RULE, ...r.data.rule }, busyUntilMs: r.data.busyUntil ? Date.parse(r.data.busyUntil) : null, name: r.data.desk?.name ?? tok.name, fetchedMs: t };
    writeJson("cache.json", fresh);
    return { ...fresh, ok: true, movedMin: typeof r.data.movedMin === "number" ? r.data.movedMin : null };
  } catch {
    return { ...(cache ?? { rule: { ...DEFAULT_RULE }, busyUntilMs: null, name: tok.name }), ok: false, movedMin: null };
  }
}

// ── Pairing ────────────────────────────────────────────────────────────────

function machineName() {
  if (IS_MAC) {
    try {
      const name = execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 1000 }).trim();
      if (name) return name.slice(0, 60);
    } catch {}
  }
  return hostname().replace(/\.local$/, "").slice(0, 60) || "this computer";
}

/** The current pairing, or a new one (null when the API can't be reached). */
async function ensurePairing() {
  const p = readJson("pairing.json");
  if (p && p.expiresMs - now() > 60_000) return p;
  const r = await api("POST", "/v1/desk/pair", { body: { name: machineName() } }).catch(() => null);
  if (!r || r.status !== 200) return null;
  const fresh = { ...r.data, expiresMs: now() + r.data.expiresIn * 1000 };
  writeJson("pairing.json", fresh, 0o600);
  return fresh;
}

/** One poll on /v1/desk/token: "linked" | "pending" | "gone". */
async function pollOnce(p, timeoutMs = 3000) {
  const r = await api("POST", "/v1/desk/token", { body: { deviceCode: p.deviceCode }, timeoutMs }).catch(() => null);
  if (!r) return "pending";
  if (r.status === 200 && r.data?.token) {
    writeJson("token.json", { token: r.data.token, deskId: r.data.deskId, name: r.data.name }, 0o600);
    writeJson("cache.json", { rule: { ...DEFAULT_RULE, ...r.data.rule }, busyUntilMs: r.data.busyUntil ? Date.parse(r.data.busyUntil) : null, name: r.data.name, fetchedMs: now() });
    remove("pairing.json");
    return "linked";
  }
  if (r.status === 428 || r.status === 429 || r.status >= 500) return "pending";
  remove("pairing.json");
  return "gone";
}

function pairingText(p) {
  let qr = "";
  try {
    // The app's own link: the iPhone camera opens VVake directly, no website needed.
    qr = qrToTerminal(encodeQr(p.appUrl || p.verifyUrl)) + "\n";
  } catch {}
  return [
    "VVake: scan to link your VVake (iPhone camera)",
    qr,
    `No camera handy? Open ${p.verifyUrl} on your iPhone.`,
    `Code ${p.userCode}, valid until ${clock(p.expiresMs)}. Then just keep working, it links by itself.`,
    "Only desk minutes and timestamps are ever sent, never your code or prompts.",
    "No app? /vvake:link local locks after 90 min and unlocks after 10 min away.",
  ].join("\n");
}

// ── Background helpers ─────────────────────────────────────────────────────

function alive(pidFile) {
  const pid = Number(readJson(pidFile)?.pid);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnHelper(cmd) {
  if (process.env.VVAKE_NO_SPAWN || alive(`${cmd}.pid`)) return;
  try {
    const child = spawn(process.execPath, [SELF, cmd], { detached: true, stdio: "ignore", env: process.env });
    child.unref();
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function notify(text) {
  try {
    if (IS_MAC) execFile("osascript", ["-e", `display notification ${JSON.stringify(text)} with title "VVake"`], () => {});
    else if (platform() === "linux") execFile("notify-send", ["VVake", text], () => {});
  } catch {}
}

/** Polls until the phone approves, the code expires or is cancelled (detached, at most 11 minutes). */
async function pollLoop() {
  writeJson("poll.pid", { pid: process.pid });
  const end = Date.now() + 11 * MIN;
  try {
    while (Date.now() < end) {
      const p = readJson("pairing.json");
      if (!p || p.expiresMs < now() || loadToken()) return;
      const r = await pollOnce(p);
      if (r === "linked") {
        notify("Linked. Back to Claude Code.");
        return;
      }
      if (r === "gone") return;
      await sleep((p.interval ?? 3) * 1000);
    }
  } finally {
    remove("poll.pid");
  }
}

/** macOS: seconds since the last keyboard / mouse event (never what was typed). */
function idleSeconds() {
  return new Promise((resolve) => {
    execFile("ioreg", ["-c", "IOHIDSystem", "-d", "4"], { timeout: 3000 }, (err, stdout) => {
      const m = !err && /"HIDIdleTime" = (\d+)/.exec(stdout);
      resolve(m ? Number(BigInt(m[1]) / 1_000_000n) / 1000 : null);
    });
  });
}

/**
 * While locked (detached, at most 6 h): on macOS samples keyboard idle every 30 s (the longest stretch since the
 * lock goes to watch.json, read by the hook), and every 2 min asks the API for the minutes moved, to say "Claude
 * is back" with a notification as soon as it's earned. Exits when the lock ends.
 */
async function watchLoop() {
  writeJson("watch.pid", { pid: process.pid });
  const end = Date.now() + 6 * 60 * MIN;
  let lastApi = 0;
  try {
    while (Date.now() < end) {
      const s = loadState(now());
      if (s.lockedSinceMs === null) return;
      const w = readJson("watch.json") ?? {};
      const cur = w.lockedSinceMs === s.lockedSinceMs ? w : { lockedSinceMs: s.lockedSinceMs, keyboardAwayMin: 0, notified: false };
      const cache = readJson("cache.json");
      const rule = config().local ? LOCAL_RULE : { ...DEFAULT_RULE, ...cache?.rule };
      if (IS_MAC) {
        const idle = await idleSeconds();
        if (idle !== null) {
          const sinceLock = (Date.now() - s.lockedSinceMs) / 1000;
          cur.keyboardAwayMin = Math.max(cur.keyboardAwayMin, Math.floor(Math.min(idle, sinceLock) / 60));
          cur.sampledMs = Date.now();
        }
      }
      const tok = loadToken();
      let moved = 0;
      if (tok && Date.now() - lastApi > 2 * MIN) {
        lastApi = Date.now();
        const r = await api("GET", `/v1/desk/moved?since=${encodeURIComponent(new Date(s.lockedSinceMs).toISOString())}`, { token: tok.token }).catch(() => null);
        if (r?.status === 200) moved = r.data.movedMin;
      }
      if (!cur.notified) {
        if (moved >= rule.unlockMin) {
          notify(`${moved} min of moving. Claude is back.`);
          cur.notified = true;
        } else if ((rule.unlockBy === "away" || !tok) && cur.keyboardAwayMin >= rule.unlockMin) {
          notify("Break done. Claude is back when you are.");
          cur.notified = true;
        }
      }
      writeJson("watch.json", cur);
      await sleep(30_000);
    }
  } finally {
    remove("watch.pid");
  }
}

// ── Commands ───────────────────────────────────────────────────────────────

async function currentRule(tok) {
  if (config().local && !tok) return { rule: LOCAL_RULE, busyUntilMs: null, ok: true };
  if (!tok) return { rule: DEFAULT_RULE, busyUntilMs: null, ok: true };
  return remoteState(tok);
}

const HELP = [
  "VVake for Claude Code: after a long stretch at the desk, Claude takes a break until you've moved.",
  "/vvake:status       desk time, the rule, urgent mode",
  "/vvake:urgent [2h|30m|today|off]   urgent work: no lock, no nudges (or start a message with urgent:)",
  "/vvake:skip         one of today's skips: desk time starts over",
  "/vvake:unlock       always works",
  "/vvake:link         link your VVake app (QR code) · /vvake:link local to use it without the app",
  "/vvake:unlink       unlink this computer",
].join("\n");

export async function runCommand(cmd, arg) {
  const t = now();
  let s = loadState(t);
  const tok = loadToken();
  let text;
  switch (cmd) {
    case "status": {
      if (!tok && !config().local) {
        text = statusLine(s, t, { rule: DEFAULT_RULE });
        break;
      }
      const r = await (tok ? remoteState(tok, { sinceMs: s.lockedSinceMs }) : currentRule(null));
      if (r.revoked) {
        remove("token.json");
        text = "VVake: this computer was unlinked from the phone. /vvake:link to link it again.";
        break;
      }
      text = statusLine(s, t, { rule: r.rule, busyUntilMs: r.busyUntilMs, linkedName: tok?.name ?? null, local: !tok, movedMin: r.movedMin ?? null });
      if (tok && !r.ok) text += " · offline (time away counts too)";
      break;
    }
    case "unlock": {
      const r = emergencyUnlock(s, t);
      s = r.state;
      text = r.text;
      break;
    }
    case "skip": {
      const r = skip(s, t, (await currentRule(tok)).rule);
      s = r.state;
      text = r.text;
      break;
    }
    case "urgent":
    case "urgence": {
      const d = parseDuration(arg, t);
      if (d === "off") {
        s = stopUrgent(s);
        text = "Urgent mode off. Desk time keeps counting from here.";
      } else if (d === null) {
        text = "Try /vvake:urgent 2h, /vvake:urgent 30m, /vvake:urgent today or /vvake:urgent off.";
      } else {
        s = startUrgent(s, t, d);
        text = `Urgent mode on until ${clock(s.urgentUntilMs)}. No lock, no nudges. Go. (/vvake:urgent off when done)`;
      }
      break;
    }
    case "link": {
      if (tok) {
        text = `Already linked to your VVake (${tok.name}). /vvake:unlink to start over.`;
        break;
      }
      if (/^local$/i.test(arg)) {
        writeJson("config.json", { ...config(), local: true });
        text = `Local mode: after ${LOCAL_RULE.afterMin} min at the desk Claude takes a break until you've been away ${LOCAL_RULE.unlockMin} min. Nothing is sent anywhere. /vvake:link to link the app instead.`;
        break;
      }
      const p = await ensurePairing();
      if (!p) {
        text = `VVake can't reach ${API} right now. Try /vvake:link again in a moment.`;
        break;
      }
      spawnHelper("poll");
      s = { ...s, linkShownMs: t };
      text = pairingText(p);
      break;
    }
    case "unlink": {
      if (tok) await api("DELETE", "/v1/desk/token", { token: tok.token }).catch(() => null);
      for (const f of ["token.json", "cache.json", "pairing.json", "watch.json"]) remove(f);
      writeJson("config.json", { ...config(), local: false });
      s = { ...s, lockedSinceMs: null, lastAttemptMs: null, awayMaxMin: 0, linkShownMs: t, linkedAnnounced: false };
      text = "Unlinked. Nothing locks any more. /vvake:link to link again.";
      break;
    }
    default:
      text = HELP;
  }
  saveState(s);
  return text;
}

// ── The hook ───────────────────────────────────────────────────────────────

/** Keyboard-away minutes from the watcher, when it watched this lock recently (macOS). */
function keyboardAway(s) {
  const w = readJson("watch.json");
  if (!IS_MAC || !w || w.lockedSinceMs !== s.lockedSinceMs || !w.sampledMs || Date.now() - w.sampledMs > 2 * MIN) return null;
  return w.keyboardAwayMin;
}

/** Returns the hook's JSON output (null = let the prompt through silently). */
export async function hook(input) {
  const t = now();
  const prompt = typeof input?.prompt === "string" ? input.prompt : "";
  const command = parseCommand(prompt);
  if (command) return { decision: "block", reason: await runCommand(command.cmd, command.arg) };

  let s = loadState(t);
  if (URGENT_PREFIX.test(prompt)) {
    s = startUrgent(s, t);
    saveState(s);
    return { systemMessage: `VVake: urgent mode until ${clock(s.urgentUntilMs)}. No lock, no nudges.` };
  }
  // Only a prompt you type starts or is held by a lock; turns Claude starts on its own pass through.
  if (input?.is_continuation) return null;

  let tok = loadToken();
  const local = !!config().local;
  let message = null;

  if (!tok && !local) {
    // Not linked: never block. Show the QR once, then a short reminder at most once a day.
    const p = readJson("pairing.json");
    if (p && p.expiresMs > t && (await pollOnce(p, 2000)) === "linked") tok = loadToken();
    if (!tok) {
      if (!s.linkShownMs) {
        const fresh = await ensurePairing();
        if (fresh) {
          spawnHelper("poll");
          s = { ...s, linkShownMs: t, linkHintDay: localDay(t) };
          message = pairingText(fresh);
        }
      } else if (s.linkHintDay !== localDay(t) && !(p && p.expiresMs > t)) {
        s = { ...s, linkHintDay: localDay(t) };
        message = "VVake isn't linked yet: /vvake:link shows the QR code (or /vvake:link local to use it without the app).";
      }
      saveState(s);
      return message ? { systemMessage: message } : null;
    }
  }

  let remote = { rule: LOCAL_RULE, busyUntilMs: null, ok: true, movedMin: null };
  if (tok) {
    const desk = deskMinutes(s, t);
    const cache = readJson("cache.json");
    const near = s.lockedSinceMs !== null || !cache || desk >= cache.rule.afterMin - cache.rule.warnMin - 1;
    remote = await remoteState(tok, near ? { sinceMs: s.lockedSinceMs, report: { deskMin: Math.min(desk, 1440), lockedSince: s.lockedSinceMs ? new Date(s.lockedSinceMs).toISOString() : null } } : {});
    if (remote.revoked) {
      for (const f of ["token.json", "cache.json"]) remove(f);
      saveState({ ...s, lockedSinceMs: null, lastAttemptMs: null, awayMaxMin: 0, linkShownMs: t, linkHintDay: localDay(t), linkedAnnounced: false });
      return { systemMessage: "VVake: this computer was unlinked from the phone, nothing locks any more. /vvake:link to link it again." };
    }
    if (!s.linkedAnnounced) {
      s = { ...s, linkedAnnounced: true };
      message = `VVake linked (${tok.name}). After ${remote.rule.afterMin} min at the desk, Claude takes a break until you've moved ${remote.rule.unlockMin} min. ${URGENT_HINT}`;
    }
  }

  const wasLocked = s.lockedSinceMs !== null;
  const out = onPrompt(s, {
    nowMs: t,
    rule: remote.rule,
    busy: remote.busyUntilMs !== null && remote.busyUntilMs > t,
    movedMin: remote.movedMin,
    keyboardAwayMin: keyboardAway(s),
    awayCounts: !tok || !remote.ok || remote.rule.unlockBy === "away",
  });
  saveState(out.state);
  const isLocked = out.state.lockedSinceMs !== null;
  if (isLocked && !wasLocked) spawnHelper("watch");
  if (tok && remote.ok && isLocked !== wasLocked) {
    await api("POST", "/v1/desk/sync", {
      token: tok.token,
      body: { deskMin: Math.min(deskMinutes(out.state, t), 1440), lockedSince: isLocked ? new Date(out.state.lockedSinceMs).toISOString() : null },
      timeoutMs: 2000,
    }).catch(() => null);
  }
  if (out.block) return { decision: "block", reason: out.block };
  const msg = [message, out.message].filter(Boolean).join("\n");
  return msg ? { systemMessage: msg } : null;
}

// ── Entry ──────────────────────────────────────────────────────────────────

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  try {
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function main() {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  if (Number(process.versions.node.split(".")[0]) < 18) {
    if (cmd === "hook") return; // never block on an old Node
    console.log("VVake needs Node.js 18 or later.");
    return;
  }
  if (cmd === "hook") {
    try {
      const out = await hook(await readStdin());
      if (out) process.stdout.write(JSON.stringify(out));
    } catch {
      // A broken hook must never stand between you and Claude.
    }
    return;
  }
  if (cmd === "poll") return pollLoop();
  if (cmd === "watch") return watchLoop();
  console.log(await runCommand(cmd, rest.join(" ")));
}

if (process.argv[1] && process.argv[1] === SELF) {
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  );
}

