import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_RULE,
  LOCAL_RULE,
  MIN,
  NO_ESCAPES,
  URGENT_PREFIX,
  cleared,
  deskMinutes,
  escapeView,
  initialState,
  lastResortLocal,
  onPrompt,
  parseCommand,
  parsePostpone,
  postponeLocal,
  released,
  requiredMin,
  rollDay,
  rollEscapes,
  skipLocal,
  statusLine,
  weekOf,
} from "../lib/core.mjs";

const T0 = new Date(2026, 9, 5, 9, 0).getTime();
const base = { rule: DEFAULT_RULE, movedMin: null, keyboardAwayMin: null, awayCounts: false };

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
    assert.match(r.block, /urgent: \(postpones 30 min\).*3 postpones left today, each one adds 10%: next unlock 11 min\./);
    assert.match(r.block, /\/vvake:skip \(2 skips left this week\)/);
    assert.match(r.block, /phone or watch/);
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

describe("escapes (game-core deskLock.ts copy)", () => {
  const D = "2026-10-05"; // a Monday
  it("+10% per postpone, compounding, rounded up; weeks from Monday", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 7].map((n) => requiredMin(10, n)), [10, 11, 13, 14, 15, 20]);
    assert.equal(weekOf("2026-10-11"), "2026-10-05");
    assert.equal(weekOf("2026-10-12"), "2026-10-12");
  });

  it("postpone: 30 min / 1 h / 4 h, 3 a day, a new day gives them back and drops the price", () => {
    let e = rollEscapes(NO_ESCAPES, D);
    for (const m of [30, 60, 240]) {
      const r = postponeLocal(e, m, T0);
      assert.ok(r.ok);
      e = r.state;
    }
    assert.equal(e.postponedUntilMs, T0 + 240 * MIN);
    assert.deepEqual(postponeLocal(e, 30, T0), { ok: false, reason: "no_postpones" });
    assert.deepEqual(postponeLocal(e, 45, T0), { ok: false, reason: "invalid" });
    assert.equal(escapeView(e, 10, T0).requiredMin, 14);
    const next = rollEscapes(e, "2026-10-06");
    assert.equal(next.postponesToday, 0);
    assert.equal(next.steps, 0);
  });

  it("skip: 2 a week; the last resort always works and costs two steps", () => {
    let e = rollEscapes(NO_ESCAPES, D);
    e = skipLocal(e).state;
    e = skipLocal(e).state;
    assert.deepEqual(skipLocal(e), { ok: false, reason: "no_skips" });
    assert.equal(rollEscapes(e, "2026-10-11").skipsThisWeek, 2);
    assert.equal(rollEscapes(e, "2026-10-12").skipsThisWeek, 0);
    for (let i = 0; i < 3; i++) e = postponeLocal(e, 30, T0).state;
    assert.equal(escapeView(e, 10, T0).lastResortOnly, true);
    assert.equal(escapeView(lastResortLocal(e), 10, T0).requiredMin, 17);
  });

  it("parses postpones to the nearest length", () => {
    assert.equal(parsePostpone(""), 30);
    assert.equal(parsePostpone("30m"), 30);
    assert.equal(parsePostpone("1h"), 60);
    assert.equal(parsePostpone("2h"), 60);
    assert.equal(parsePostpone("3h"), 240);
    assert.equal(parsePostpone("today"), 240);
    assert.equal(parsePostpone("off"), "off");
    assert.equal(parsePostpone("soon"), null);
  });
});

describe("postponed, cleared, and the price", () => {
  const L = T0 + 92 * MIN;
  const locked = () => work(initialState("2026-10-05"), T0, 200).state;

  it("a postpone releases the lock and keeps desk time, so the lock comes back when it ends, needing more", () => {
    let s = locked();
    const esc = postponeLocal(rollEscapes(s.esc, "2026-10-05"), 30, L + MIN).state;
    s = { ...released(s), esc };
    let r = { state: s };
    for (let m = 2; m < 31; m += 3) {
      r = onPrompt(r.state, { ...base, nowMs: L + m * MIN });
      assert.equal(r.block, undefined);
      assert.equal(r.message, undefined);
    }
    r = onPrompt(r.state, { ...base, nowMs: L + 32 * MIN });
    assert.match(r.block, /Move 11 minutes and Claude is back\./);
    r = onPrompt(r.state, { ...base, nowMs: L + 40 * MIN, movedMin: 10 });
    assert.match(r.block, /^Still 1 min of moving/);
    r = onPrompt(r.state, { ...base, nowMs: L + 45 * MIN, movedMin: 11 });
    assert.equal(r.block, undefined);
    assert.equal(r.state.esc.steps, 0, "moving pays the price back");
  });

  it("the API's view: postponed from the phone, cleared from the phone, the required minutes", () => {
    const view = (x) => ({ ...escapeView(NO_ESCAPES, 10, L), ...x });
    const s = locked();
    const p = onPrompt(s, { ...base, nowMs: L + MIN, view: view({ postponedUntilMs: L + 60 * MIN }) });
    assert.equal(p.block, undefined);
    assert.equal(p.state.lockedSinceMs, null);
    const c = onPrompt(s, { ...base, nowMs: L + MIN, view: view({ clearedAtMs: L + 30_000 }) });
    assert.equal(c.block, undefined);
    assert.match(c.message, /cleared from your phone/);
    assert.equal(deskMinutes(c.state, L + 2 * MIN), 1, "desk time starts over");
    const old = onPrompt(s, { ...base, nowMs: L + MIN, view: view({ clearedAtMs: L - 60 * MIN }) });
    assert.ok(old.block, "a skip before this lock doesn't clear it");
    assert.match(onPrompt(s, { ...base, nowMs: L + 2 * MIN, movedMin: 12, view: view({ requiredMin: 13 }) }).block, /^Still 1 min/);
  });

  it("no escape left: the lock text points to the last resort", () => {
    let e = rollEscapes(NO_ESCAPES, "2026-10-05");
    for (let i = 0; i < 3; i++) e = postponeLocal(e, 30, 0).state;
    e = skipLocal(skipLocal(e).state).state;
    const r = work({ ...initialState("2026-10-05"), esc: e }, T0, 200);
    assert.match(r.block, /Move 14 minutes/);
    assert.match(r.block, /No postpones left today\./);
    assert.match(r.block, /Last resort: \/vvake:unlock \(next unlock 17 min of moving\)/);
  });

  it("v1 urgent mode in an old state file still holds until it ends", () => {
    const s = { ...locked(), urgentUntilMs: L + 60 * MIN };
    assert.equal(onPrompt(s, { ...base, nowMs: L + MIN }).block, undefined);
  });

  it("cleared(): desk time starts over", () => {
    const s = cleared(locked(), L + 5 * MIN);
    assert.equal(s.lockedSinceMs, null);
    assert.equal(deskMinutes(s, L + 6 * MIN), 1);
  });
});

describe("urgent prefix", () => {
  it("urgent:, !urgent, urgence, #urgent; not words that merely start alike", () => {
    for (const p of ["urgent: prod is down", "!urgent fix it", "  Urgent, the deploy", "urgence : la prod", "#urgent", "URGENT"]) assert.ok(URGENT_PREFIX.test(p), p);
    for (const p of ["urgently refactor", "fix the urgent bug", "/vvake:urgent"]) assert.ok(!URGENT_PREFIX.test(p), p);
  });
});

describe("commands and status", () => {
  it("parses /vvake: commands", () => {
    assert.deepEqual(parseCommand("/vvake:urgent 1h"), { cmd: "urgent", arg: "1h" });
    assert.deepEqual(parseCommand("  /vvake:status"), { cmd: "status", arg: "" });
    assert.equal(parseCommand("please /vvake:status"), null);
  });

  it("status line", () => {
    const s = work(initialState("d"), T0, 40).state;
    assert.equal(
      statusLine(s, T0 + 40 * MIN, { rule: DEFAULT_RULE, linkedName: "Mac" }),
      "VVake · 40 min at the desk · lock in 50 min · rule: after 90 min, 10 min of moving · 3 postpones left today · 2 skips left this week · linked: Mac",
    );
    const u = { ...s, esc: postponeLocal(rollEscapes(s.esc, "d"), 60, T0 + 40 * MIN).state };
    assert.match(statusLine(u, T0 + 41 * MIN, { rule: DEFAULT_RULE }), /postponed until 10:40, no lock · rule: after 90 min, 10 min of moving \(11 today\) · 2 postpones left today/);
  });
});
