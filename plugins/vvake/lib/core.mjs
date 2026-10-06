/**
 * The plugin's brain, pure: state + one prompt (time, kind) + the rule → next state + what Claude Code should do
 * (let it through, show a message, or block with a friendly reason). No I/O here; see vvake.mjs for that.
 *
 * Rules mirror @vvfit/game-core `focus.ts` (focusDecision, nextDeskMinutes) and `deskLock.ts` (the escapes) from the
 * VVake monorepo; this plugin ships on its own, so they are copied, not imported. Keep both in sync:
 * - Desk time keeps counting through short pauses; a gap of 5+ minutes between prompts starts it over.
 * - Lock after `afterMin` of continuous desk time, never while postponed, warned `warnMin` before.
 * - Unlocks by moving (active minutes of real sessions since the lock, from the API) or, when `unlockBy` is
 *   "away" or without the app / offline, by time away (no prompts, and on macOS no keyboard either).
 * - Escapes (the VVake API keeps the counters when linked; this copy is used without the app or offline):
 *   postpone 30 min / 1 h / 4 h, 3 a local day, each one +10% of moving for the next unlock (compounding, rounded up);
 *   skip, 2 a Monday–Sunday week, confirmed after 10 s; the last resort (/vvake:unlock), never limited so nobody is
 *   ever stuck, +2 steps. The price resets at midnight and when an unlock is earned by moving.
 * - Only ever blocks at the start of a new prompt, never a running task.
 */

export const MIN = 60_000;
export const HOUR = 60 * MIN;
/** A gap this long between prompts (or with no keyboard) is a break: desk time starts over. */
export const GAP_MIN = 5;

export const POSTPONE_MINUTES = [30, 60, 240];
export const POSTPONES_PER_DAY = 3;
export const POSTPONE_STEP = 0.1;
export const SKIPS_PER_WEEK = 2;
export const SKIP_COUNTDOWN_S = 10;
/** A skip asked with /vvake:skip is confirmed by a second /vvake:skip between 10 s and this long after. */
export const SKIP_CONFIRM_MS = 2 * MIN;
export const LAST_RESORT_STEPS = 2;
/** `urgent:` and /vvake:urgent without a duration: a 30-minute postpone. */
export const URGENT_DEFAULT_MIN = 30;

export const DEFAULT_RULE = Object.freeze({ enabled: true, afterMin: 90, unlockMin: 10, overridesPerDay: 2, unlockBy: "move", warnMin: 10 });
/** Without the app: the same rule, unlocked by time away. */
export const LOCAL_RULE = Object.freeze({ ...DEFAULT_RULE, unlockBy: "away" });

export const NO_ESCAPES = Object.freeze({ day: null, postponesToday: 0, steps: 0, week: null, skipsThisWeek: 0, postponedUntilMs: null });

export function initialState(day) {
  return {
    v: 2,
    day,
    /** Start of the current stretch at the desk (first prompt after a break). */
    deskStartMs: null,
    lastPromptMs: null,
    /** While locked: the lock start and the last prompt that was turned away. */
    lockedSinceMs: null,
    lastAttemptMs: null,
    /** Longest stretch with no prompt since the lock (minutes). */
    awayMaxMin: 0,
    warned: false,
    /** The escapes (a copy of the API's when linked, the only one without the app). */
    esc: { ...NO_ESCAPES },
    /** /vvake:skip asked, waiting for the confirmation. */
    skipAskedMs: null,
    /** v1 state files: urgent mode, read as a postpone until it ends. */
    urgentUntilMs: null,
    unlocksToday: 0,
    // Your own stats, never shown as a reproach.
    unlocksTotal: 0,
    skipsTotal: 0,
    urgentTotal: 0,
    locksTotal: 0,
    movedUnlocksTotal: 0,
  };
}

// ── Escapes (game-core deskLock.ts) ────────────────────────────────────────

/** The Monday ("YYYY-MM-DD") of a local day's week. */
export function weekOf(day) {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
}

export function rollEscapes(e, day) {
  let out = { ...NO_ESCAPES, ...e };
  if (out.day !== day) out = { ...out, day, postponesToday: 0, steps: 0 };
  const week = /^\d{4}-\d\d-\d\d$/.test(day) ? weekOf(day) : day;
  if (out.week !== week) out = { ...out, week, skipsThisWeek: 0 };
  return out;
}

/** Minutes of moving to unlock: the rule's plus 10% per step, compounding, rounded up to the minute. */
export const requiredMin = (baseMin, steps) => Math.ceil(baseMin * Math.pow(1 + POSTPONE_STEP, Math.max(0, steps)) - 1e-9);

/** What the API's `lock` says, computed here (no app, offline). */
export function escapeView(e, baseMin, nowMs) {
  const postponesLeftToday = Math.max(0, POSTPONES_PER_DAY - e.postponesToday);
  const skipsLeftThisWeek = Math.max(0, SKIPS_PER_WEEK - e.skipsThisWeek);
  return {
    requiredMin: requiredMin(baseMin, e.steps),
    postponesLeftToday,
    skipsLeftThisWeek,
    nextRequiredMin: requiredMin(baseMin, e.steps + 1),
    lastResortRequiredMin: requiredMin(baseMin, e.steps + LAST_RESORT_STEPS),
    postponedUntilMs: e.postponedUntilMs !== null && e.postponedUntilMs > nowMs ? e.postponedUntilMs : null,
    clearedAtMs: null,
    lastResortOnly: postponesLeftToday === 0 && skipsLeftThisWeek === 0,
  };
}

/** The API's `lock` (ISO dates) → the same shape as escapeView. */
export function remoteView(lock) {
  return {
    requiredMin: lock.requiredMin,
    postponesLeftToday: lock.postponesLeftToday,
    skipsLeftThisWeek: lock.skipsLeftThisWeek,
    nextRequiredMin: lock.nextRequiredMin,
    lastResortRequiredMin: lock.lastResortRequiredMin,
    postponedUntilMs: lock.postponedUntil ? Date.parse(lock.postponedUntil) : null,
    clearedAtMs: lock.clearedAt ? Date.parse(lock.clearedAt) : null,
    lastResortOnly: !!lock.lastResortOnly,
  };
}

/** "30m", "1h", "4h", "90" … → 30 | 60 | 240 (the nearest), "off", or null when unreadable. Empty: 30. */
export function parsePostpone(arg) {
  const a = (arg ?? "").trim().toLowerCase();
  if (!a) return URGENT_DEFAULT_MIN;
  if (["off", "stop", "done", "fini", "non", "end"].includes(a)) return "off";
  if (["today", "aujourd'hui", "aujourdhui", "jour"].includes(a)) return 240;
  const m = /^(?:(\d{1,2})\s*h)?\s*(?:(\d{1,3})\s*(?:m|min)?)?$/.exec(a);
  if (!m || (!m[1] && !m[2])) return null;
  const min = Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  if (min <= 0) return null;
  return [...POSTPONE_MINUTES].sort((x, y) => Math.abs(x - min) - Math.abs(y - min))[0];
}

/** Locally (no app / offline): a postpone. { ok, state } or { ok: false, reason }. */
export function postponeLocal(e, minutes, nowMs) {
  if (!POSTPONE_MINUTES.includes(minutes)) return { ok: false, reason: "invalid" };
  if (e.postponesToday >= POSTPONES_PER_DAY) return { ok: false, reason: "no_postpones" };
  const until = Math.max(e.postponedUntilMs ?? 0, nowMs + minutes * MIN);
  return { ok: true, state: { ...e, postponesToday: e.postponesToday + 1, steps: e.steps + 1, postponedUntilMs: until } };
}

export function skipLocal(e) {
  if (e.skipsThisWeek >= SKIPS_PER_WEEK) return { ok: false, reason: "no_skips" };
  return { ok: true, state: { ...e, skipsThisWeek: e.skipsThisWeek + 1 } };
}

export const lastResortLocal = (e) => ({ ...e, steps: e.steps + LAST_RESORT_STEPS });
export const movedLocal = (e) => ({ ...e, steps: 0 });

// ── Days, desk time ────────────────────────────────────────────────────────

/** Per-day counters start over at local midnight (the escapes too, by day and by week). */
export const rollDay = (s, day) => {
  const esc = rollEscapes(s.esc ?? NO_ESCAPES, day);
  return s.day === day ? { ...s, esc } : { ...s, day, unlocksToday: 0, esc };
};

export const localDay = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export function deskMinutes(s, nowMs) {
  if (s.deskStartMs === null || s.lastPromptMs === null) return 0;
  if (nowMs - s.lastPromptMs >= GAP_MIN * MIN) return 0; // already on a break
  return Math.max(0, Math.floor((nowMs - s.deskStartMs) / MIN));
}

/** No lock until then (ms): a postpone (here or from the API), or v1 urgent mode. Null when none runs. */
export function postponedUntil(s, nowMs, view = null) {
  const all = [s.esc?.postponedUntilMs, s.urgentUntilMs, view?.postponedUntilMs].filter((x) => typeof x === "number" && x > nowMs);
  return all.length ? Math.max(...all) : null;
}

// ── Prompt classification (the prompt text is only looked at here, locally; it is never stored or sent) ──

/**
 * `urgent: …`, `!urgent …`, `urgence: …` (and `#urgent`): a 30-minute postpone, the prompt goes through.
 * Note: in the Claude Code terminal a leading `!` switches to bash mode, so `urgent:` is the form we advertise.
 */
export const URGENT_PREFIX = /^\s*[!#]?\s*(urgent|urgence)\b/i;

/** `/vvake:status`, `/vvake:urgent 1h` … → { cmd, arg }, else null. */
export function parseCommand(prompt) {
  const m = /^\s*\/vvake:([a-z-]+)\b\s*(.*)$/is.exec(prompt ?? "");
  return m ? { cmd: m[1].toLowerCase(), arg: m[2].trim() } : null;
}

export const clock = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
export const label = (min) => (min >= 60 ? `${min / 60} h` : `${min} min`);

/** The escapes line under a lock: what's left and what it costs. */
export function escapesText(v) {
  const lines = [];
  if (v.postponesLeftToday > 0) {
    lines.push(
      `Urgent? Start your message with urgent: (postpones 30 min) or /vvake:urgent 1h · ${plural(v.postponesLeftToday, "postpone")} left today, each one adds 10%: next unlock ${v.nextRequiredMin} min.`,
    );
  } else lines.push("No postpones left today.");
  if (v.skipsLeftThisWeek > 0) lines.push(`Not now? /vvake:skip (${plural(v.skipsLeftThisWeek, "skip")} left this week).`);
  else if (v.lastResortOnly) lines.push(`No skips left this week. Last resort: /vvake:unlock (next unlock ${v.lastResortRequiredMin} min of moving).`);
  else lines.push("No skips left this week.");
  lines.push("Or from your phone or watch: VVake › Claude lock.");
  return lines.join("\n");
}

export const URGENT_HINT = "Urgent? Start your message with urgent: and Claude answers right away (a 30-min postpone, 3 a day).";

// ── State changes ──────────────────────────────────────────────────────────

/** Lock released by a postpone: desk time keeps counting, so the lock comes back when the postpone ends. */
export const released = (s) => ({ ...s, lockedSinceMs: null, lastAttemptMs: null, awayMaxMin: 0, warned: false });

/** Lock released (moved, skipped, last resort): desk time starts over from now. */
export function unlocked(s, nowMs) {
  return { ...released(s), deskStartMs: s.lockedSinceMs !== null ? nowMs : s.deskStartMs };
}

/** After a skip / last resort: desk time starts over, like a break. */
export const cleared = (s, nowMs) => ({ ...released(s), deskStartMs: nowMs, lastPromptMs: nowMs, skipAskedMs: null });

/**
 * One prompt. `ctx`: { nowMs, rule, view (escapeView / remoteView: requiredMin, postponedUntilMs, clearedAtMs, …),
 * movedMin (since the lock, null when unknown), keyboardAwayMin (macOS: longest keyboard-idle stretch since the lock,
 * null when unknown), awayCounts (time away unlocks: rule "away", no app, or API unreachable) }.
 * Returns { state, block?: reason, message?: shown without blocking }.
 */
export function onPrompt(prev, ctx) {
  const { nowMs, rule } = ctx;
  const view = ctx.view ?? escapeView(prev.esc ?? NO_ESCAPES, rule.unlockMin, nowMs);
  let s = prev;

  if (!rule.enabled) return { state: notePrompt(s.lockedSinceMs !== null ? unlocked(s, nowMs) : s, nowMs) };

  // Skipped (or last resort) from the phone or the watch after this lock began: Claude is back.
  if (s.lockedSinceMs !== null && view.clearedAtMs !== null && view.clearedAtMs >= s.lockedSinceMs) {
    return { state: notePrompt(cleared(s, nowMs), nowMs), message: "VVake: the lock was cleared from your phone. Claude is back." };
  }

  // Postponed (here, from the phone or the watch): no lock, no nudges; desk time keeps counting.
  if (postponedUntil(s, nowMs, view) !== null) return { state: notePrompt(released(s), nowMs) };

  const need = view.requiredMin;
  if (s.lockedSinceMs !== null) {
    // Time away: the longest stretch without a prompt since the lock (macOS: without the keyboard either).
    const gapMin = Math.floor((nowMs - (s.lastAttemptMs ?? s.lockedSinceMs)) / MIN);
    let awayMin = Math.max(s.awayMaxMin, gapMin);
    if (ctx.keyboardAwayMin !== null && ctx.keyboardAwayMin !== undefined) awayMin = Math.min(awayMin, ctx.keyboardAwayMin);
    const moved = ctx.movedMin ?? 0;
    const done = ctx.awayCounts ? Math.max(moved, awayMin) : moved;
    if (done >= need) {
      const byMoving = moved >= need;
      s = { ...unlocked(s, nowMs), movedUnlocksTotal: s.movedUnlocksTotal + (byMoving ? 1 : 0), esc: movedLocal(s.esc ?? NO_ESCAPES) };
      return { state: notePrompt(s, nowMs), message: byMoving ? `VVake: ${moved} min of moving. Nice. Claude is back.` : "VVake: welcome back. Claude is back." };
    }
    s = { ...s, lastAttemptMs: nowMs, awayMaxMin: Math.max(s.awayMaxMin, gapMin) };
    return { state: s, block: lockedText(view, need - done, ctx.awayCounts) };
  }

  s = notePrompt(s, nowMs);
  const desk = deskMinutes(s, nowMs);
  if (desk === 0) s = { ...s, warned: false };
  if (desk >= rule.afterMin) {
    s = { ...s, lockedSinceMs: nowMs, lastAttemptMs: nowMs, awayMaxMin: 0, locksTotal: s.locksTotal + 1, skipAskedMs: null };
    return {
      state: s,
      block: [
        `${desk} min at the desk. Move ${need} minutes and Claude is back.`,
        ctx.awayCounts ? `A walk logged on your watch or phone counts, or ${need} min away from the keyboard.` : "A walk or a workout logged on your watch or phone counts (the daily move too).",
        escapesText(view),
      ].join("\n"),
    };
  }
  const left = rule.afterMin - desk;
  if (rule.warnMin > 0 && left <= rule.warnMin && !s.warned) {
    return { state: { ...s, warned: true }, message: `VVake: ${desk} min at the desk. Claude takes a break in ${left} min, a good moment to wrap up.` };
  }
  return { state: s };
}

function lockedText(view, left, awayCounts) {
  return [
    `Still ${left} min of moving and Claude is back.`,
    awayCounts ? "A logged walk counts, so does time away from the keyboard." : "It unlocks by itself once your watch or phone logs the walk.",
    escapesText(view),
  ].join("\n");
}

/** A prompt at the desk (not locked): a 5-minute gap starts a new stretch. */
function notePrompt(s, nowMs) {
  const fresh = s.lastPromptMs === null || nowMs - s.lastPromptMs >= GAP_MIN * MIN || s.deskStartMs === null;
  return { ...s, lastPromptMs: nowMs, deskStartMs: fresh ? nowMs : s.deskStartMs };
}

/** One line for /vvake:status. */
export function statusLine(s, nowMs, { rule, view = null, linkedName = null, local = false, movedMin = null } = {}) {
  const v = view ?? escapeView(s.esc ?? NO_ESCAPES, rule.unlockMin, nowMs);
  const parts = [];
  const until = postponedUntil(s, nowMs, v);
  if (s.lockedSinceMs !== null && until === null) {
    parts.push(`locked since ${clock(s.lockedSinceMs)}`);
    parts.push(movedMin !== null ? `${movedMin}/${v.requiredMin} min moved` : `${v.requiredMin} min of moving to unlock`);
  } else {
    const desk = deskMinutes(s, nowMs);
    parts.push(`${desk} min at the desk`);
    if (!rule.enabled) parts.push("lock off");
    else if (until === null) parts.push(`lock in ${Math.max(0, rule.afterMin - desk)} min`);
  }
  if (until !== null) parts.push(`postponed until ${clock(until)}, no lock`);
  parts.push(`rule: after ${rule.afterMin} min, ${rule.unlockMin} min of moving${v.requiredMin > rule.unlockMin ? ` (${v.requiredMin} today)` : ""}`);
  parts.push(`${plural(v.postponesLeftToday, "postpone")} left today`);
  parts.push(`${plural(v.skipsLeftThisWeek, "skip")} left this week`);
  parts.push(linkedName ? `linked: ${linkedName}` : local ? "local mode (no app)" : "not linked: /vvake:link");
  return `VVake · ${parts.join(" · ")}`;
}
