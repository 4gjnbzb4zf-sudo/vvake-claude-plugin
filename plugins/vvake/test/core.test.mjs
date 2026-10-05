import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_RULE,
  LOCAL_RULE,
  MIN,
  URGENT_PREFIX,
  deskMinutes,
  emergencyUnlock,
  initialState,
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

const T0 = new Date(2026, 9, 5, 9, 0).getTime();
const base = { rule: DEFAULT_RULE, busy: false, movedMin: null, keyboardAwayMin: null, awayCounts: false };

/** Prompts every `everyMin` minutes from `from` for `forMin` minutes; returns the last result. */
function work(s, from, forMin, everyMin = 4, ctx = {}) {
  let r = { state: s };
  for (let m = 0; m <= forMin; m += everyMin) {
    r = onPrompt(r.state, { ...base, ...ctx, nowMs: from + m * MIN });
    if (r.block) return { ...r, atMin: m };
  }
  return r;
}

describe("desk time from prompt timestamps", () => {
  it("counts through short pauses, a 5-minute gap starts it over", () => {
    let s = initialState("d");
    s = onPrompt(s, { ...base, nowMs: T0 }).state;
    s = onPrompt(s, { ...base, nowMs: T0 + 4 * MIN }).state;
    s = onPrompt(s, { ...base, nowMs: T0 + 8 * MIN }).state;
    assert.equal(deskMinutes(s, T0 + 8 * MIN), 8);
    s = onPrompt(s, { ...base, nowMs: T0 + 13 * MIN }).state; // 5 min gap
    assert.equal(deskMinutes(s, T0 + 13 * MIN), 0);
    assert.equal(deskMinutes(s, T0 + 16 * MIN), 3);
    assert.equal(deskMinutes(s, T0 + 19 * MIN), 0, "already a break when nothing came for 5 min");
  });

  it("warns once before the lock, then locks with a friendly message at the rule", () => {
    const r = work(initialState("d"), T0, 200);
    assert.equal(r.atMin, 92);
    assert.match(r.block, /^92 min at the desk\. Move 10 minutes and Claude is back\./);
    assert.match(r.block, /urgent:/);
    assert.match(r.block, /\/vvake:skip \(2 lefts? today\) or \/vvake:unlock/);
    assert.equal(r.state.lockedSinceMs, T0 + 92 * MIN);
    assert.equal(r.state.locksTotal, 1);
    let s = initialState("d");
    const warnings = [];
    for (let m = 0; m < 90; m += 4) {
      const x = onPrompt(s, { ...base, nowMs: T0 + m * MIN });
      s = x.state;
      if (x.message) warnings.push(m);
    }
    assert.deepEqual(warnings, [80]);
  });

  it("follows the rule: off never locks (and releases), custom afterMin", () => {
    assert.equal(work(initialState("d"), T0, 300, 4, { rule: { ...DEFAULT_RULE, enabled: false } }).block, undefined);
    assert.equal(work(initialState("d"), T0, 100, 4, { rule: { ...DEFAULT_RULE, afterMin: 30 } }).atMin, 32);
    const locked = work(initialState("d"), T0, 200).state;
    const off = onPrompt(locked, { ...base, rule: { ...DEFAULT_RULE, enabled: false }, nowMs: T0 + 93 * MIN });
    assert.equal(off.block, undefined);
    assert.equal(off.state.lockedSinceMs, null);
  });
});

describe("unlock decisions", () => {
  const locked = () => work(initialState("d"), T0, 200).state; // locked at +92
  const L = T0 + 92 * MIN;

  it("stays locked until the API reports enough moving minutes", () => {
    let r = onPrompt(locked(), { ...base, nowMs: L + 2 * MIN, movedMin: 4 });
    assert.match(r.block, /^Still 6 min of moving/);
    r = onPrompt(r.state, { ...base, nowMs: L + 14 * MIN, movedMin: 11 });
    assert.equal(r.block, undefined);
    assert.match(r.message, /11 min of moving/);
    assert.equal(r.state.lockedSinceMs, null);
    assert.equal(r.state.movedUnlocksTotal, 1);
    assert.equal(deskMinutes(r.state, L + 15 * MIN), 1, "desk time starts over");
  });

  it("time away doesn't unlock a move-only rule, but does when away counts (no app, offline, rule 'away')", () => {
    const away = { nowMs: L + 12 * MIN, movedMin: 0 };
    assert.ok(onPrompt(locked(), { ...base, ...away }).block);
    assert.equal(onPrompt(locked(), { ...base, ...away, awayCounts: true }).block, undefined);
    assert.equal(onPrompt(locked(), { ...base, ...away, rule: LOCAL_RULE, awayCounts: true }).block, undefined);
  });

  it("time away is the longest stretch without prompts, and on macOS without the keyboard", () => {
    let r = onPrompt(locked(), { ...base, awayCounts: true, nowMs: L + 6 * MIN });
    assert.match(r.block, /^Still 4 min/);
    r = onPrompt(r.state, { ...base, awayCounts: true, nowMs: L + 7 * MIN });
    assert.match(r.block, /^Still 4 min/, "the 6-min stretch is kept");
    assert.ok(onPrompt(r.state, { ...base, awayCounts: true, nowMs: L + 18 * MIN, keyboardAwayMin: 3 }).block, "typing elsewhere is not away");
    assert.equal(onPrompt(r.state, { ...base, awayCounts: true, nowMs: L + 18 * MIN, keyboardAwayMin: 10 }).block, undefined);
  });
});

describe("skip and unlock counters", () => {
  it("skip: a few a day, desk time starts over, a new day gives them back", () => {
    let s = work(initialState("2026-10-05"), T0, 200).state;
    let r = skip(s, T0 + 93 * MIN, DEFAULT_RULE);
    assert.match(r.text, /1 skip left today/);
    assert.equal(r.state.lockedSinceMs, null);
    assert.equal(r.state.skipsToday, 1);
    s = r.state;
    assert.equal(onPrompt(s, { ...base, nowMs: T0 + 94 * MIN }).block, undefined);
    r = skip(s, T0 + 95 * MIN, DEFAULT_RULE);
    assert.match(r.text, /No skips left today\./);
    r = skip(r.state, T0 + 96 * MIN, DEFAULT_RULE);
    assert.match(r.text, /^No skips left today\. \/vvake:unlock always works\./);
    assert.equal(r.state.skipsToday, 2);
    assert.equal(r.state.skipsTotal, 2);
    assert.equal(rollDay(r.state, "2026-10-06").skipsToday, 0);
    assert.equal(rollDay(r.state, "2026-10-06").skipsTotal, 2);
  });

  it("unlock: always works, never limited, only counted", () => {
    let s = initialState("d");
    for (let i = 0; i < 5; i++) {
      s = work(s, T0 + i * 300 * MIN, 200).state;
      const r = emergencyUnlock(s, T0 + i * 300 * MIN + 100 * MIN);
      assert.equal(r.text, "Unlocked. Claude is back. Desk time starts over.");
      s = r.state;
      assert.equal(s.lockedSinceMs, null);
    }
    assert.equal(s.unlocksToday, 5);
    assert.equal(s.unlocksTotal, 5);
    assert.match(emergencyUnlock(s, T0 + 2000 * MIN).text, /^Not locked/);
  });
});

describe("urgent", () => {
  it("the prefix: urgent:, !urgent, urgence, #urgent; not words that merely start alike", () => {
    for (const p of ["urgent: prod is down", "!urgent fix it", "  Urgent, the deploy", "urgence : la prod", "#urgent", "URGENT"]) assert.ok(URGENT_PREFIX.test(p), p);
    for (const p of ["urgently refactor", "fix the urgent bug", "/vvake:urgent"]) assert.ok(!URGENT_PREFIX.test(p), p);
  });

  it("starts 2 h (extends, never shortens), releases a lock, no lock and no nudges while on, ends by itself", () => {
    const locked = work(initialState("d"), T0, 200).state;
    let s = startUrgent(locked, T0 + 93 * MIN);
    assert.equal(s.lockedSinceMs, null);
    assert.equal(s.urgentUntilMs, T0 + 93 * MIN + 120 * MIN);
    assert.equal(s.urgentTotal, 1);
    assert.equal(startUrgent(s, T0 + 94 * MIN, 30 * MIN).urgentUntilMs, s.urgentUntilMs);
    // Two more hours of prompts: never blocked, never warned.
    let r = { state: s };
    for (let m = 94; m < 93 + 120; m += 3) {
      r = onPrompt(r.state, { ...base, nowMs: T0 + m * MIN });
      assert.equal(r.block, undefined);
      assert.equal(r.message, undefined);
    }
    assert.ok(urgentOn(r.state, T0 + 212 * MIN));
    assert.ok(!urgentOn(r.state, T0 + 213 * MIN));
    // Desk time kept counting, so the lock comes at the next prompt after urgent mode ends.
    assert.match(onPrompt(r.state, { ...base, nowMs: T0 + 214 * MIN }).block, /min at the desk/);
  });

  it("off, and busy / urgent from the phone (busyUntil) is honoured", () => {
    const s = startUrgent(initialState("d"), T0);
    assert.equal(stopUrgent(s).urgentUntilMs, null);
    const r = work(initialState("d"), T0, 300, 4, { busy: true });
    assert.equal(r.block, undefined);
    const locked = work(initialState("d"), T0, 200).state;
    const freed = onPrompt(locked, { ...base, nowMs: T0 + 93 * MIN, busy: true });
    assert.equal(freed.block, undefined);
    assert.equal(freed.state.lockedSinceMs, null);
  });

  it("durations", () => {
    assert.equal(parseDuration("", T0), 120 * MIN);
    assert.equal(parseDuration("2h", T0), 120 * MIN);
    assert.equal(parseDuration("30m", T0), 30 * MIN);
    assert.equal(parseDuration("90", T0), 90 * MIN);
    assert.equal(parseDuration("1h30", T0), 90 * MIN);
    assert.equal(parseDuration("today", T0), 15 * 60 * MIN); // 09:00 → midnight
    assert.equal(parseDuration("off", T0), "off");
    assert.equal(parseDuration("soon", T0), null);
  });
});

describe("commands and status", () => {
  it("parses /vvake: commands", () => {
    assert.deepEqual(parseCommand("/vvake:urgent 2h"), { cmd: "urgent", arg: "2h" });
    assert.deepEqual(parseCommand("  /vvake:status"), { cmd: "status", arg: "" });
    assert.equal(parseCommand("please /vvake:status"), null);
  });

  it("status line", () => {
    const s = work(initialState("d"), T0, 40).state;
    assert.equal(
      statusLine(s, T0 + 40 * MIN, { rule: DEFAULT_RULE, linkedName: "Mac" }),
      "VVake · 40 min at the desk · lock in 50 min · rule: after 90 min, 10 min of moving · 2 skips left today · linked: Mac",
    );
    const u = startUrgent(s, T0 + 40 * MIN);
    assert.match(statusLine(u, T0 + 41 * MIN, { rule: DEFAULT_RULE }), /urgent until 11:40, no lock/);
  });
});
