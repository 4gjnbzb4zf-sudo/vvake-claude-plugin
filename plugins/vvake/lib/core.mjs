/**
 * The plugin's brain, pure: state + one prompt (time, kind) + the rule → next state + what Claude Code should do
 * (let it through, show a message, or block with a friendly reason). No I/O here; see vvake.mjs for that.
 *
 * Rules mirror @vvfit/game-core `focus.ts` (focusDecision, nextDeskMinutes) from the VVake monorepo; this plugin
 * ships on its own, so they are copied, not imported. Keep both in sync:
 * - Desk time keeps counting through short pauses; a gap of 5+ minutes between prompts starts it over.
 * - Lock after `afterMin` of continuous desk time, never while urgent / busy, warned `warnMin` before.
 * - Unlocks by moving (active minutes of real sessions since the lock, from the API) or, when `unlockBy` is
 *   "away" or without the app / offline, by time away (no prompts, and on macOS no keyboard either).
 * - Always escapable: unlock (never limited, only counted), skip (a few a day), urgent (instant, unlimited).
 * - Only ever blocks at the start of a new prompt, never a running task.
 */

export const MIN = 60_000;
export const HOUR = 60 * MIN;
/** A gap this long between prompts (or with no keyboard) is a break: desk time starts over. */
export const GAP_MIN = 5;
/** `!urgent` / `urgent:` without a duration: 2 hours. */
export const URGENT_DEFAULT_MS = 2 * HOUR;

export const DEFAULT_RULE = Object.freeze({ enabled: true, afterMin: 90, unlockMin: 10, overridesPerDay: 2, unlockBy: "move", warnMin: 10 });
/** Without the app: the same rule, unlocked by time away. */
export const LOCAL_RULE = Object.freeze({ ...DEFAULT_RULE, unlockBy: "away" });

export function initialState(day) {
  return {
    v: 1,
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
    urgentUntilMs: null,
    skipsToday: 0,
    unlocksToday: 0,
    // Your own stats, never shown as a reproach.
    unlocksTotal: 0,
    skipsTotal: 0,
    urgentTotal: 0,
    locksTotal: 0,
    movedUnlocksTotal: 0,
  };
}

/** Per-day counters start over at local midnight. */
export const rollDay = (s, day) => (s.day === day ? s : { ...s, day, skipsToday: 0, unlocksToday: 0 });

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

export const urgentOn = (s, nowMs) => s.urgentUntilMs !== null && s.urgentUntilMs > nowMs;

// ── Prompt classification (the prompt text is only looked at here, locally; it is never stored or sent) ──

/**
 * `urgent: …`, `!urgent …`, `urgence: …` (and `#urgent`): urgent work goes through at once.
 * Note: in the Claude Code terminal a leading `!` switches to bash mode, so `urgent:` is the form we advertise.
 */
export const URGENT_PREFIX = /^\s*[!#]?\s*(urgent|urgence)\b/i;

/** `/vvake:status`, `/vvake:urgent 2h` … → { cmd, arg }, else null. */
export function parseCommand(prompt) {
  const m = /^\s*\/vvake:([a-z-]+)\b\s*(.*)$/is.exec(prompt ?? "");
  return m ? { cmd: m[1].toLowerCase(), arg: m[2].trim() } : null;
}

/**
 * "2h", "30m", "90" (minutes), "1h30", "today" (until midnight), "off" → ms from now / "off" / null when unreadable.
 */
export function parseDuration(arg, nowMs) {
  const a = (arg ?? "").trim().toLowerCase();
  if (!a) return URGENT_DEFAULT_MS;
  if (["off", "stop", "done", "fini", "non"].includes(a)) return "off";
  if (["today", "aujourd'hui", "aujourdhui", "jour"].includes(a)) {
    const d = new Date(nowMs);
    d.setHours(24, 0, 0, 0);
    return d.getTime() - nowMs;
  }
  const m = /^(?:(\d{1,2})\s*h)?\s*(?:(\d{1,3})\s*(?:m|min)?)?$/.exec(a);
  if (!m || (!m[1] && !m[2])) return null;
  const ms = (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * MIN;
  return ms > 0 ? Math.min(ms, 24 * HOUR) : null;
}

export const clock = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const URGENT_HINT = "Urgent? Start your message with urgent: and Claude answers right away (or /vvake:urgent 2h).";

// ── State changes ──────────────────────────────────────────────────────────

export function startUrgent(s, nowMs, ms = URGENT_DEFAULT_MS) {
  const until = Math.max(s.urgentUntilMs ?? 0, nowMs + ms);
  return { ...unlocked(s, nowMs), urgentUntilMs: until, urgentTotal: s.urgentTotal + 1 };
}

export const stopUrgent = (s) => ({ ...s, urgentUntilMs: null });

/** Lock released: desk time starts over from now. */
function unlocked(s, nowMs) {
  return { ...s, lockedSinceMs: null, lastAttemptMs: null, awayMaxMin: 0, warned: false, deskStartMs: s.lockedSinceMs !== null ? nowMs : s.deskStartMs };
}

/** /vvake:unlock: always works, only counted. */
export function emergencyUnlock(s, nowMs) {
  if (s.lockedSinceMs === null) return { state: s, text: `Not locked. ${deskMinutes(s, nowMs)} min at the desk.` };
  return {
    state: { ...unlocked(s, nowMs), unlocksToday: s.unlocksToday + 1, unlocksTotal: s.unlocksTotal + 1 },
    text: "Unlocked. Claude is back. Desk time starts over.",
  };
}

/** /vvake:skip: one of today's skips; desk time starts over (a lock is released). */
export function skip(s, nowMs, rule) {
  if (s.skipsToday >= rule.overridesPerDay) {
    return { state: s, text: `No skips left today. /vvake:unlock always works. ${URGENT_HINT}` };
  }
  const n = s.skipsToday + 1;
  const left = rule.overridesPerDay - n;
  return {
    state: { ...unlocked(s, nowMs), deskStartMs: nowMs, lastPromptMs: nowMs, warned: false, skipsToday: n, skipsTotal: s.skipsTotal + 1 },
    text: `Skipped. Desk time starts over. ${left === 0 ? "No skips left today." : `${plural(left, "skip")} left today.`}`,
  };
}

/**
 * One prompt. `ctx`: { nowMs, rule, busy (API urgent / busy), movedMin (since the lock, null when unknown),
 * keyboardAwayMin (macOS: longest keyboard-idle stretch since the lock, null when unknown), awayCounts (time away
 * unlocks: rule "away", no app, or API unreachable) }.
 * Returns { state, block?: reason, message?: shown without blocking }.
 */
export function onPrompt(prev, ctx) {
  const { nowMs, rule } = ctx;
  let s = prev;

  // Urgent (local or from the phone): never locked, no nudges.
  if (urgentOn(s, nowMs) || ctx.busy) {
    s = s.lockedSinceMs !== null ? unlocked(s, nowMs) : s;
    return { state: notePrompt(s, nowMs) };
  }
  if (!rule.enabled) return { state: notePrompt(s.lockedSinceMs !== null ? unlocked(s, nowMs) : s, nowMs) };

  if (s.lockedSinceMs !== null) {
    // Time away: the longest stretch without a prompt since the lock (macOS: without the keyboard either).
    const gapMin = Math.floor((nowMs - (s.lastAttemptMs ?? s.lockedSinceMs)) / MIN);
    let awayMin = Math.max(s.awayMaxMin, gapMin);
    if (ctx.keyboardAwayMin !== null && ctx.keyboardAwayMin !== undefined) awayMin = Math.min(awayMin, ctx.keyboardAwayMin);
    const moved = ctx.movedMin ?? 0;
    const done = ctx.awayCounts ? Math.max(moved, awayMin) : moved;
    if (done >= rule.unlockMin) {
      const byMoving = moved >= rule.unlockMin;
      s = { ...unlocked(s, nowMs), movedUnlocksTotal: s.movedUnlocksTotal + (byMoving ? 1 : 0) };
      return { state: notePrompt(s, nowMs), message: byMoving ? `VVake: ${moved} min of moving. Nice. Claude is back.` : "VVake: welcome back. Claude is back." };
    }
    s = { ...s, lastAttemptMs: nowMs, awayMaxMin: Math.max(s.awayMaxMin, gapMin) };
    const left = rule.unlockMin - done;
    return { state: s, block: lockedText(s, rule, left, ctx.awayCounts) };
  }

  s = notePrompt(s, nowMs);
  const desk = deskMinutes(s, nowMs);
  if (desk === 0) s = { ...s, warned: false };
  if (desk >= rule.afterMin) {
    s = { ...s, lockedSinceMs: nowMs, lastAttemptMs: nowMs, awayMaxMin: 0, locksTotal: s.locksTotal + 1 };
    const skips = rule.overridesPerDay - s.skipsToday;
    return {
      state: s,
      block: [
        `${desk} min at the desk. Move ${rule.unlockMin} minutes and Claude is back.`,
        ctx.awayCounts ? `A walk logged on your watch or phone counts, or ${rule.unlockMin} min away from the keyboard.` : "A walk or a workout logged on your watch or phone counts (the daily move too).",
        URGENT_HINT,
        `Not now? /vvake:skip (${plural(Math.max(0, skips), "left")} today) or /vvake:unlock.`,
      ].join("\n"),
    };
  }
  const left = rule.afterMin - desk;
  if (rule.warnMin > 0 && left <= rule.warnMin && !s.warned) {
    return { state: { ...s, warned: true }, message: `VVake: ${desk} min at the desk. Claude takes a break in ${left} min, a good moment to wrap up.` };
  }
  return { state: s };
}

function lockedText(s, rule, left, awayCounts) {
  const skips = Math.max(0, rule.overridesPerDay - s.skipsToday);
  return [
    `Still ${left} min of moving and Claude is back.`,
    awayCounts ? "A logged walk counts, so does time away from the keyboard." : "It unlocks by itself once your watch or phone logs the walk.",
    URGENT_HINT,
    `Not now? /vvake:skip (${plural(skips, "left")} today) or /vvake:unlock.`,
  ].join("\n");
}

/** A prompt at the desk (not locked): a 5-minute gap starts a new stretch. */
function notePrompt(s, nowMs) {
  const fresh = s.lastPromptMs === null || nowMs - s.lastPromptMs >= GAP_MIN * MIN || s.deskStartMs === null;
  return { ...s, lastPromptMs: nowMs, deskStartMs: fresh ? nowMs : s.deskStartMs };
}

/** One line for /vvake:status. */
export function statusLine(s, nowMs, { rule, busyUntilMs = null, linkedName = null, local = false, movedMin = null } = {}) {
  const parts = [];
  const urgentUntil = Math.max(urgentOn(s, nowMs) ? s.urgentUntilMs : 0, busyUntilMs && busyUntilMs > nowMs ? busyUntilMs : 0);
  if (s.lockedSinceMs !== null) {
    parts.push(`locked since ${clock(s.lockedSinceMs)}`);
    if (movedMin !== null) parts.push(`${movedMin}/${rule.unlockMin} min moved`);
  } else {
    const desk = deskMinutes(s, nowMs);
    parts.push(`${desk} min at the desk`);
    if (!rule.enabled) parts.push("lock off");
    else if (!urgentUntil) parts.push(`lock in ${Math.max(0, rule.afterMin - desk)} min`);
  }
  if (urgentUntil) parts.push(`urgent until ${clock(urgentUntil)}, no lock`);
  parts.push(`rule: after ${rule.afterMin} min, ${rule.unlockMin} min of moving`);
  parts.push(`${plural(Math.max(0, rule.overridesPerDay - s.skipsToday), "skip")} left today`);
  parts.push(linkedName ? `linked: ${linkedName}` : local ? "local mode (no app)" : "not linked: /vvake:link");
  return `VVake · ${parts.join(" · ")}`;
}
