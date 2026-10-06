#!/usr/bin/env node
/**
 * VVake for Claude Code: the UserPromptSubmit hook, the /vvake:* commands, the pairing poller and the lock watcher.
 *
 *   vvake.mjs hook                 the hook (JSON on stdin, JSON on stdout)
 *   vvake.mjs status|unlock [anyway]|skip|link [local]|unlink|urgent [30m|1h|4h|off]|help
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
  NO_ESCAPES,
  POSTPONES_PER_DAY,
  SKIP_CONFIRM_MS,
  SKIP_COUNTDOWN_S,
  SKIPS_PER_WEEK,
  URGENT_DEFAULT_MIN,
  URGENT_HINT,
  URGENT_PREFIX,
  cleared,
  clock,
  deskMinutes,
  escapeView,
  initialState,
  label,
  lastResortLocal,
  localDay,
  onPrompt,
  parseCommand,
  parsePostpone,
  postponeLocal,
  postponedUntil,
  released,
  remoteView,
  rollDay,
  skipLocal,
  statusLine,
} from "../lib/core.mjs";
import { encodeQr, qrToTerminal } from "../lib/qr.mjs";
import { isoOrNull, safeName, validId, validLock, validMinutes, validPairing, validRule, validToken } from "../lib/validate.mjs";

const SELF = fileURLToPath(import.meta.url);
const API = (process.env.VVAKE_API || "https://vvake-api.val-54e.workers.dev").replace(/\/+$/, "");
const DIR = join(process.env.VVAKE_HOME || join(homedir(), ".vvake"), "claude");
const UA = "vvake-claude-plugin/0.2";
/** The local day and week of the escapes are counted in this zone on the API too. */
const TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
})();
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
const loadToken = () => {
  // VV-08: the name is shown to Claude; an old token.json may hold the API's copy of it, so it is cleaned here too.
  const t = readJson("token.json");
  return t && validToken(t.token) ? { ...t, name: safeName(t.name) ?? "this computer" } : null;
};
/** An ISO date from the API as ms, or null (VV-08: never echo what isn't a date). */
const msOrNull = (v) => (isoOrNull(v) ? Date.parse(v) : null);
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

/**
 * Rule + postpone + the escapes' counters (`lock`), cached 5 min; `report` sends desk minutes and the lock start
 * (nothing else; plus the time zone the API counts local days in).
 */
async function remoteState(tok, { force = false, sinceMs = null, report = null } = {}) {
  const cache = readJson("cache.json");
  const t = now();
  if (!force && sinceMs === null && !report && cache && t - cache.fetchedMs < CACHE_MS) return { ...cache, ok: true, movedMin: null };
  try {
    const body = { ...(sinceMs !== null ? { since: new Date(sinceMs).toISOString() } : {}), ...(report ?? {}), ...(TZ ? { tz: TZ } : {}) };
    const r = await api("POST", "/v1/desk/sync", { token: tok.token, body });
    if (r.status === 401) return { revoked: true };
    if (r.status !== 200 || !r.data?.rule) throw new Error(`sync ${r.status}`);
    // VV-08: only checked values go on (they end up in Claude's context); the name is this computer's own.
    const fresh = {
      rule: { ...DEFAULT_RULE, ...validRule(r.data.rule) },
      busyUntilMs: msOrNull(r.data.busyUntil),
      lock: validLock(r.data.lock),
      name: tok.name,
      fetchedMs: t,
    };
    writeJson("cache.json", fresh);
    return { ...fresh, ok: true, movedMin: validMinutes(r.data.movedMin) };
  } catch {
    return { ...(cache ?? { rule: { ...DEFAULT_RULE }, busyUntilMs: null, lock: null, name: tok.name }), ok: false, movedMin: null };
  }
}

/** The escapes as the API counts them when linked (also offline, from the cache), else this computer's copy. */
function viewFor(s, remote, t) {
  const v = remote?.lock ? remoteView(remote.lock) : escapeView(s.esc ?? NO_ESCAPES, remote?.rule?.unlockMin ?? DEFAULT_RULE.unlockMin, t);
  // Urgent / busy set on the API before postpones existed (or by an older app): no lock either.
  if (remote?.busyUntilMs && remote.busyUntilMs > t) v.postponedUntilMs = Math.max(v.postponedUntilMs ?? 0, remote.busyUntilMs);
  return v;
}

const ESCAPE_PATHS = { postpone: "/v1/desk/postpone", skip: "/v1/desk/skip", unlock: "/v1/desk/unlock", resume: "/v1/desk/resume" };

/**
 * One escape (postpone | skip | unlock | resume). Linked: the API's rules and counters (shared with the phone and the
 * watch). Without the app, or when the API can't be reached: this computer's copy of the same rules, so an escape
 * always works offline. Returns { ok, reason?, view, state, remote }.
 */
async function applyEscape(s, kind, minutes = null) {
  const t = now();
  const tok = loadToken();
  if (tok) {
    const body = { ...(kind === "postpone" ? { minutes } : {}), ...(TZ ? { tz: TZ } : {}) };
    const r = await api("POST", ESCAPE_PATHS[kind], { token: tok.token, body }).catch(() => null);
    if (r && (r.status === 200 || r.status === 409)) {
      const lock = validLock(r.status === 200 ? r.data : r.data?.lock);
      if (lock) {
        const cache = readJson("cache.json");
        if (cache) writeJson("cache.json", { ...cache, lock: { ...cache.lock, ...lock, clearedAt: cache.lock?.clearedAt ?? null } });
      }
      const view = lock ? remoteView(lock) : escapeView(s.esc, DEFAULT_RULE.unlockMin, t);
      // Keep the postpone here too, so it holds even if the API is out of reach later.
      const state = { ...s, esc: { ...s.esc, postponedUntilMs: kind === "resume" ? null : (view.postponedUntilMs ?? s.esc.postponedUntilMs) } };
      const reason = typeof r.data?.reason === "string" && /^[a-z_]{1,40}$/.test(r.data.reason) ? r.data.reason : null;
      return { ok: r.status === 200, reason, view, state, remote: true };
    }
  }
  const rule = (tok ? readJson("cache.json")?.rule : null) ?? (config().local ? LOCAL_RULE : DEFAULT_RULE);
  let esc = s.esc ?? NO_ESCAPES;
  if (kind === "postpone" || kind === "skip") {
    const r = kind === "postpone" ? postponeLocal(esc, minutes, t) : skipLocal(esc);
    if (!r.ok) return { ok: false, reason: r.reason, view: escapeView(esc, rule.unlockMin, t), state: s, remote: false };
    esc = r.state;
  } else if (kind === "unlock") esc = lastResortLocal(esc);
  else esc = { ...esc, postponedUntilMs: null };
  return { ok: true, reason: null, view: escapeView(esc, rule.unlockMin, t), state: { ...s, esc, urgentUntilMs: kind === "resume" ? null : s.urgentUntilMs }, remote: false };
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
  if (p && p.expiresMs - now() > 60_000 && validPairing(p)) return p;
  const r = await api("POST", "/v1/desk/pair", { body: { name: machineName() } }).catch(() => null);
  if (!r || r.status !== 200) return null;
  // VV-08: the links and the code are shown to Claude: VVake's own links only, or nothing.
  const valid = validPairing(r.data);
  if (!valid) return null;
  const fresh = { ...valid, expiresMs: now() + valid.expiresIn * 1000 };
  writeJson("pairing.json", fresh, 0o600);
  return fresh;
}

/** One poll on /v1/desk/token: "linked" | "pending" | "gone". */
async function pollOnce(p, timeoutMs = 3000) {
  const r = await api("POST", "/v1/desk/token", { body: { deviceCode: p.deviceCode }, timeoutMs }).catch(() => null);
  if (!r) return "pending";
  if (r.status === 200 && validToken(r.data?.token)) {
    // VV-08: this computer's own name, not the API's copy of it (it is shown to Claude).
    const name = safeName(machineName()) ?? "this computer";
    writeJson("token.json", { token: r.data.token, deskId: validId(r.data.deskId), name }, 0o600);
    writeJson("cache.json", { rule: { ...DEFAULT_RULE, ...validRule(r.data.rule) }, busyUntilMs: msOrNull(r.data.busyUntil), name, fetchedMs: now() });
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
      let view = viewFor(s, tok ? cache : { rule }, now());
      if (tok && Date.now() - lastApi > 2 * MIN) {
        lastApi = Date.now();
        // The state since the lock: moved minutes, and a skip or a postpone made on the phone or the watch.
        const q = `since=${encodeURIComponent(new Date(s.lockedSinceMs).toISOString())}${TZ ? `&tz=${encodeURIComponent(TZ)}` : ""}`;
        const r = await api("GET", `/v1/desk/state?${q}`, { token: tok.token }).catch(() => null);
        if (r?.status === 200) {
          moved = validMinutes(r.data.movedMin) ?? 0;
          const lock = validLock(r.data.lock);
          if (lock && cache) writeJson("cache.json", { ...cache, lock, busyUntilMs: msOrNull(r.data.busyUntil) });
          view = viewFor(s, { ...cache, rule, lock, busyUntilMs: msOrNull(r.data.busyUntil) }, now());
        }
      }
      if (!cur.notified) {
        if (moved >= view.requiredMin) {
          notify(`${moved} min of moving. Claude is back.`);
          cur.notified = true;
        } else if ((view.clearedAtMs !== null && view.clearedAtMs >= s.lockedSinceMs) || postponedUntil(s, now(), view) !== null) {
          notify("Lock lifted from your phone. Claude is back.");
          cur.notified = true;
        } else if ((rule.unlockBy === "away" || !tok) && cur.keyboardAwayMin >= view.requiredMin) {
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
  "/vvake:status       desk time, the rule, postpones and skips left",
  "/vvake:urgent [30m|1h|4h|off]   postpone the lock (3 a day, each adds 10% of moving), or start a message with urgent:",
  "/vvake:skip         skip this lock without moving (2 a week, confirm after 10 s)",
  "/vvake:unlock       last resort, always works (costs more moving next time)",
  "/vvake:link         link your VVake app (QR code) · /vvake:link local to use it without the app",
  "/vvake:unlink       unlink this computer",
  "Your phone and watch can postpone or skip too: VVake › Claude lock.",
].join("\n");

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const clockS = (ms) => `${clock(ms)}:${String(new Date(ms).getSeconds()).padStart(2, "0")}`;
const offlineNote = (r) => (r.remote || !loadToken() ? "" : " (offline: counted on this computer)");

/** The escapes as they are now (the API's when linked and reachable). */
async function currentView(s, tok) {
  const r = await currentRule(tok);
  return { rule: r.rule, view: viewFor(s, tok ? r : { rule: r.rule }, now()) };
}

/** A postpone (/vvake:urgent, the urgent: prefix): text for the user. */
async function postponeText(s, minutes, before) {
  const r = await applyEscape(s, "postpone", minutes);
  if (!r.ok) {
    if (r.reason === "no_postpones") {
      const v = r.view;
      return {
        state: r.state,
        ok: false,
        text: `No postpones left today (${POSTPONES_PER_DAY} a day). ${v.skipsLeftThisWeek > 0 ? `/vvake:skip (${plural(v.skipsLeftThisWeek, "skip")} left this week)` : "No skips left this week either"}, or the last resort /vvake:unlock.`,
      };
    }
    return { state: r.state, ok: false, text: "Try /vvake:urgent 30m, /vvake:urgent 1h or /vvake:urgent 4h." };
  }
  const v = r.view;
  const until = v.postponedUntilMs ?? now() + minutes * MIN;
  return {
    state: { ...released(r.state), urgentTotal: (r.state.urgentTotal ?? 0) + 1, skipAskedMs: null },
    ok: true,
    text: `Postponed ${label(minutes)}: no lock until ${clock(until)}. Next unlock needs ${v.requiredMin} min of moving instead of ${before}. ${plural(v.postponesLeftToday, "postpone")} left today.${offlineNote(r)}`,
  };
}

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
      text = statusLine(s, t, { rule: r.rule, view: viewFor(s, tok ? r : { rule: r.rule }, t), linkedName: tok?.name ?? null, local: !tok, movedMin: r.movedMin ?? null });
      if (tok && !r.ok) text += " · offline (time away counts too)";
      break;
    }
    case "unlock": {
      if (s.lockedSinceMs === null) {
        text = `Not locked. ${deskMinutes(s, t)} min at the desk.`;
        break;
      }
      const { view } = await currentView(s, tok);
      const anyway = /^(anyway|now|quand[- ]m[eê]me|force)$/i.test(arg);
      if (!view.lastResortOnly && !anyway) {
        const opts = [];
        if (view.postponesLeftToday > 0) opts.push(`/vvake:urgent 30m (${plural(view.postponesLeftToday, "postpone")} left today, next unlock ${view.nextRequiredMin} min)`);
        if (view.skipsLeftThisWeek > 0) opts.push(`/vvake:skip (${plural(view.skipsLeftThisWeek, "skip")} left this week)`);
        text = [
          `The last resort costs the most: the next unlock would need ${view.lastResortRequiredMin} min of moving. You still have:`,
          ...opts.map((o) => `- ${o}`),
          "Really stuck? /vvake:unlock anyway",
        ].join("\n");
        break;
      }
      const r = await applyEscape(s, "unlock");
      s = { ...cleared(r.state, t), unlocksToday: (r.state.unlocksToday ?? 0) + 1, unlocksTotal: (r.state.unlocksTotal ?? 0) + 1 };
      text = `Unlocked (last resort). Claude is back, desk time starts over. Next unlock needs ${r.view.requiredMin} min of moving.${offlineNote(r)}`;
      break;
    }
    case "skip": {
      if (s.lockedSinceMs === null) {
        text = "Not locked: nothing to skip. A skip clears a lock without moving (2 a week).";
        break;
      }
      const { view } = await currentView(s, tok);
      if (view.skipsLeftThisWeek <= 0) {
        text = `No skips left this week (${SKIPS_PER_WEEK} a week). ${view.postponesLeftToday > 0 ? "/vvake:urgent 30m postpones it" : "Last resort: /vvake:unlock"}.`;
        break;
      }
      const asked = s.skipAskedMs;
      if (asked !== null && asked !== undefined && t - asked >= SKIP_COUNTDOWN_S * 1000 && t - asked <= SKIP_CONFIRM_MS) {
        const r = await applyEscape(s, "skip");
        if (!r.ok) {
          s = { ...r.state, skipAskedMs: null };
          text = `No skips left this week (${SKIPS_PER_WEEK} a week). Last resort: /vvake:unlock.`;
          break;
        }
        s = { ...cleared(r.state, t), skipsTotal: (r.state.skipsTotal ?? 0) + 1 };
        text = `Skipped. Claude is back, desk time starts over. ${plural(r.view.skipsLeftThisWeek, "skip")} left this week.${offlineNote(r)}`;
        break;
      }
      if (asked !== null && asked !== undefined && t - asked < SKIP_COUNTDOWN_S * 1000) {
        text = `${Math.ceil((SKIP_COUNTDOWN_S * 1000 - (t - asked)) / 1000)} s more, then /vvake:skip again to confirm.`;
        break;
      }
      s = { ...s, skipAskedMs: t };
      text = `Skip this lock without moving? It uses 1 of your ${plural(view.skipsLeftThisWeek, "skip")} left this week. Take ${SKIP_COUNTDOWN_S} seconds: /vvake:skip again after ${clockS(t + SKIP_COUNTDOWN_S * 1000)} (within 2 min) to confirm.`;
      break;
    }
    case "urgent":
    case "urgence": {
      const d = parsePostpone(arg);
      if (d === "off") {
        const r = await applyEscape(s, "resume");
        s = r.state;
        text = "Postpone ended. Desk time keeps counting from here.";
      } else if (d === null) {
        text = "Try /vvake:urgent 30m, /vvake:urgent 1h, /vvake:urgent 4h or /vvake:urgent off.";
      } else {
        const { view } = await currentView(s, tok);
        const r = await postponeText(s, d, view.requiredMin);
        s = r.state;
        text = r.text;
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
      s = { ...s, lockedSinceMs: null, lastAttemptMs: null, awayMaxMin: 0, linkShownMs: t, linkedAnnounced: false, skipAskedMs: null };
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
    // Not linked and not local: nothing ever locks, nothing to postpone.
    if (!loadToken() && !config().local) return null;
    const { view } = await currentView(s, loadToken());
    const locked = s.lockedSinceMs !== null && postponedUntil(s, t, view) === null;
    // Already postponed: the prompt just goes through.
    if (postponedUntil(s, t, view) !== null) return null;
    const r = await postponeText(s, URGENT_DEFAULT_MIN, view.requiredMin);
    saveState(r.state);
    if (r.ok) return { systemMessage: `VVake: ${r.text}` };
    // No postpone left: a lock stays (the skip and the last resort are still there); no lock, the prompt goes through.
    return locked ? { decision: "block", reason: `urgent: can't postpone any more today. ${r.text}` } : { systemMessage: `VVake: ${r.text}` };
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

  let remote = { rule: LOCAL_RULE, busyUntilMs: null, lock: null, ok: true, movedMin: null };
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
    view: viewFor(s, remote, t),
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
      body: { deskMin: Math.min(deskMinutes(out.state, t), 1440), lockedSince: isLocked ? new Date(out.state.lockedSinceMs).toISOString() : null, ...(TZ ? { tz: TZ } : {}) },
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

