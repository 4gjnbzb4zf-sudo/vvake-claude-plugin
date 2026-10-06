/**
 * The real hook process (`node vvake.mjs hook`) against a fake VVake API, with a temp state folder and a fixed
 * clock. Also checks that nothing from the prompt ever reaches the API.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/vvake.mjs", import.meta.url));
const MIN = 60_000;
const T0 = new Date(2026, 9, 5, 9, 0).getTime();
const SECRET = "the secret prompt about payroll.ts";

// ── Fake API ────────────────────────────────────────────────────────────────
const freshLock = () => ({ requiredMin: 10, postponedUntil: null, clearedAt: null, postponesLeftToday: 3, skipsLeftThisWeek: 2, nextRequiredMin: 11, lastResortRequiredMin: 13, lastResortOnly: false });
const api = {
  approved: false,
  movedMin: 0,
  busyUntil: null,
  revoked: false,
  down: false,
  /** The fake clock of the escapes (the hook's VVAKE_NOW_MS). */
  nowMs: 0,
  lock: freshLock(),
  steps: 0,
  rule: { enabled: true, afterMin: 90, unlockMin: 10, overridesPerDay: 2, unlockBy: "move", warnMin: 10 },
  requests: [],
};
let server;
let base;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      api.requests.push({ method: req.method, url: req.url, body, auth: req.headers.authorization ?? null });
      const send = (status, data) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(data === undefined ? "" : JSON.stringify(data));
      };
      const authed = req.headers.authorization === "Bearer vvd_test_token_0123456789abcdef" && !api.revoked;
      if (api.down && req.url.startsWith("/v1/desk/") && req.url !== "/v1/desk/pair" && req.url !== "/v1/desk/token") return send(503, { error: "server" });
      const L = api.lock;
      const cost = (n) => Math.ceil(10 * Math.pow(1.1, n) - 1e-9);
      const price = () => Object.assign(L, { requiredMin: cost(api.steps), nextRequiredMin: cost(api.steps + 1), lastResortRequiredMin: cost(api.steps + 2), lastResortOnly: L.postponesLeftToday === 0 && L.skipsLeftThisWeek === 0 });
      if (req.url === "/v1/desk/postpone" && authed) {
        if (L.postponesLeftToday === 0) return send(409, { error: "conflict", reason: "no_postpones", lock: L });
        const b = JSON.parse(body || "{}");
        L.postponesLeftToday--;
        api.steps++;
        L.postponedUntil = new Date(api.nowMs + b.minutes * 60_000).toISOString();
        return send(200, price());
      }
      if (req.url === "/v1/desk/skip" && authed) {
        if (L.skipsLeftThisWeek === 0) return send(409, { error: "conflict", reason: "no_skips", lock: L });
        L.skipsLeftThisWeek--;
        L.clearedAt = new Date(api.nowMs).toISOString();
        return send(200, price());
      }
      if (req.url === "/v1/desk/unlock" && authed) {
        api.steps += 2;
        L.clearedAt = new Date(api.nowMs).toISOString();
        return send(200, price());
      }
      if (req.url === "/v1/desk/resume" && authed) {
        L.postponedUntil = null;
        return send(200, price());
      }
      if (req.url === "/v1/desk/pair") {
        return send(200, { userCode: "X7K2-9QPM", deviceCode: "d".repeat(43), verifyUrl: "https://vvake.com/claude/X7K2-9QPM", appUrl: "vvake://claude/X7K2-9QPM", interval: 3, expiresIn: 600 });
      }
      if (req.url === "/v1/desk/token") {
        if (!api.approved) return send(428, { error: "authorization_pending" });
        return send(200, { token: "vvd_test_token_0123456789abcdef", deskId: "desk-1", name: "Test Mac", rule: api.rule, busy: false, busyUntil: null });
      }
      if (req.url === "/v1/desk/sync") {
        if (!authed) return send(401, { error: "unauthorized" });
        const b = JSON.parse(body || "{}");
        return send(200, { rule: api.rule, busy: !!api.busyUntil, busyUntil: api.busyUntil, desk: { id: "desk-1", name: "Test Mac" }, lock: api.lock, ...(b.since ? { movedMin: api.movedMin } : {}) });
      }
      if (req.url === "/v1/desk/token" && req.method === "DELETE") return send(204);
      send(404, { error: "not_found" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// ── Running the hook ────────────────────────────────────────────────────────
function run(home, nowMs, args, stdin) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, VVAKE_HOME: home, VVAKE_API: base, VVAKE_NOW_MS: String(nowMs), VVAKE_NO_SPAWN: "1" },
    });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("error", reject);
    p.on("close", () => resolve(out));
    p.stdin.end(stdin ?? "");
  });
}

async function prompt(home, nowMs, text, extra = {}) {
  api.nowMs = nowMs;
  const out = await run(home, nowMs, ["hook"], JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: text, ...extra }));
  return out ? JSON.parse(out) : null;
}

/** Prompts every 4 minutes from `fromMin` (relative to T0) until one is blocked or `toMin`. */
async function workUntilBlocked(home, fromMin, toMin) {
  for (let m = fromMin; m <= toMin; m += 4) {
    const out = await prompt(home, T0 + m * MIN, `${SECRET} #${m}`);
    if (out?.decision === "block") return { out, atMin: m };
  }
  return null;
}

const freshHome = () => mkdtempSync(join(tmpdir(), "vvake-claude-"));

// ── Tests ───────────────────────────────────────────────────────────────────
describe("the hook, end to end", { concurrency: false }, () => {
  it("not linked: shows the QR and the link instead of blocking, then links by itself once the phone approves", async () => {
    api.approved = false;
    const home = freshHome();
    const first = await prompt(home, T0, SECRET);
    assert.equal(first.decision, undefined);
    assert.match(first.systemMessage, /Scan to link your VVake/i);
    assert.match(first.systemMessage, /https:\/\/vvake\.com\/claude\/X7K2-9QPM/);
    assert.match(first.systemMessage, /█/);
    assert.equal(await prompt(home, T0 + MIN, SECRET), null, "shown once, never blocks");
    // Even past 90 min: no lock while not linked (the code expires after 10 min, nothing else happens).
    assert.equal(await workUntilBlocked(home, 2, 130), null);

    const home2 = freshHome();
    await prompt(home2, T0, SECRET);
    api.approved = true;
    const linked = await prompt(home2, T0 + 3 * MIN, SECRET);
    // This computer's own name, never the API's copy of it (VV-08, test/validate.test.mjs).
    assert.match(linked.systemMessage, /VVake linked \([^)\n]{1,40}\)/);
    const tok = join(home2, "claude", "token.json");
    assert.equal(statSync(tok).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(tok, "utf8")).token, "vvd_test_token_0123456789abcdef");
  });

  it("linked: locks after 90 min with the friendly message, and the API's moving minutes unlock it", async () => {
    api.approved = true;
    api.movedMin = 0;
    api.busyUntil = null;
    const home = freshHome();
    await prompt(home, T0 - 20 * MIN, "hello"); // shows the QR, polls nothing yet
    await prompt(home, T0 - 19 * MIN, "hello"); // the next prompt links
    const b = await workUntilBlocked(home, 0, 200);
    assert.equal(b.atMin, 92);
    assert.match(b.out.reason, /^92 min at the desk\. Move 10 minutes and Claude is back\./);
    assert.match(b.out.reason, /Urgent\? Start your message with urgent: \(postpones 30 min\) or \/vvake:urgent 1h · 3 postpones left today/);
    assert.match(b.out.reason, /\/vvake:skip \(2 skips left this week\)/);

    api.movedMin = 6;
    const still = await prompt(home, T0 + 100 * MIN, SECRET);
    assert.match(still.reason, /^Still 4 min of moving/);
    api.movedMin = 12;
    const back = await prompt(home, T0 + 108 * MIN, SECRET);
    assert.equal(back.decision, undefined);
    assert.match(back.systemMessage, /12 min of moving\. Nice\. Claude is back\./);
  });

  it("urgent: is a 30-min postpone on the API (+10% next time), /vvake:urgent off ends it, then 3 a day", async () => {
    api.movedMin = 0;
    api.lock = freshLock();
    api.steps = 0;
    const home = freshHome();
    await prompt(home, T0 - 20 * MIN, "hello");
    await prompt(home, T0 - 19 * MIN, "hello");
    const b = await workUntilBlocked(home, 0, 200);
    assert.ok(b);
    const t = T0 + (b.atMin + 1) * MIN;
    const u = await prompt(home, t, "urgent: the payment service is down");
    assert.equal(u.decision, undefined, "never blocked");
    assert.match(u.systemMessage, /Postponed 30 min: no lock until \d\d:\d\d\. Next unlock needs 11 min of moving instead of 10\. 2 postpones left today\./);
    for (let m = 2; m <= 28; m += 4) assert.equal((await prompt(home, t + m * MIN, SECRET))?.decision, undefined);
    const status = await prompt(home, t + 29 * MIN, "/vvake:status");
    assert.equal(status.decision, "block"); // commands are answered by the hook itself, Claude isn't called
    assert.match(status.reason, /postponed until \d\d:\d\d, no lock .* 2 postpones left today · 2 skips left this week/);
    const off = await prompt(home, t + 29 * MIN, "/vvake:urgent off");
    assert.match(off.reason, /^Postpone ended/);
    // Desk time kept counting: the next prompt is held again, needing 11 min now.
    assert.match((await prompt(home, t + 30 * MIN, SECRET))?.reason, /Move 11 minutes/);
    const one = await prompt(home, t + 31 * MIN, "/vvake:urgent 1h");
    assert.match(one.reason, /^Postponed 1 h: .* needs 13 min of moving instead of 11\. 1 postpone left today\./);
    await prompt(home, t + 32 * MIN, "/vvake:urgent 4h");
    const none = await prompt(home, t + 33 * MIN, "/vvake:urgent");
    assert.match(none.reason, /^No postpones left today \(3 a day\)\. \/vvake:skip \(2 skips left this week\)/);
    api.lock = freshLock();
    api.steps = 0;
  });

  it("skip: confirmed after 10 s, clears the lock; /vvake:unlock asks first while escapes remain, then always works", async () => {
    api.movedMin = 0;
    api.lock = freshLock();
    api.steps = 0;
    const home = freshHome();
    await prompt(home, T0 - 20 * MIN, "hello");
    await prompt(home, T0 - 19 * MIN, "hello");
    const b = await workUntilBlocked(home, 0, 200);
    const t = T0 + (b.atMin + 1) * MIN;
    const ask = await prompt(home, t, "/vvake:skip");
    assert.match(ask.reason, /^Skip this lock without moving\? It uses 1 of your 2 skips left this week\. Take 10 seconds: \/vvake:skip again after \d\d:\d\d:\d\d/);
    assert.match((await prompt(home, t + 4000, "/vvake:skip")).reason, /^6 s more/);
    const done = await prompt(home, t + 12_000, "/vvake:skip");
    assert.match(done.reason, /^Skipped\. Claude is back, desk time starts over\. 1 skip left this week\./);
    assert.equal((await prompt(home, t + MIN, SECRET))?.decision, undefined);
    // Locked again: /vvake:unlock lists what's left first.
    const b2 = await workUntilBlocked(home, b.atMin + 2, b.atMin + 200);
    const t2 = T0 + (b2.atMin + 1) * MIN;
    const first = await prompt(home, t2, "/vvake:unlock");
    assert.match(first.reason, /^The last resort costs the most: the next unlock would need 13 min of moving/);
    assert.match(first.reason, /Really stuck\? \/vvake:unlock anyway/);
    const anyway = await prompt(home, t2 + 1000, "/vvake:unlock anyway");
    assert.match(anyway.reason, /^Unlocked \(last resort\)\. .* Next unlock needs 13 min of moving\./);
    assert.equal((await prompt(home, t2 + MIN, SECRET))?.decision, undefined);
    api.lock = freshLock();
    api.steps = 0;
  });

  it("skipped from the phone (computer asleep): the next prompt goes through", async () => {
    api.movedMin = 0;
    api.lock = freshLock();
    const home = freshHome();
    await prompt(home, T0 - 20 * MIN, "hello");
    await prompt(home, T0 - 19 * MIN, "hello");
    const b = await workUntilBlocked(home, 0, 200);
    api.lock = { ...freshLock(), clearedAt: new Date(T0 + (b.atMin + 5) * MIN).toISOString(), skipsLeftThisWeek: 1 };
    const back = await prompt(home, T0 + (b.atMin + 30) * MIN, SECRET);
    assert.equal(back.decision, undefined);
    assert.match(back.systemMessage, /cleared from your phone/);
    api.lock = freshLock();
  });

  it("offline: urgent: still postpones (counted on this computer), never blocked", async () => {
    api.movedMin = 0;
    api.lock = freshLock();
    const home = freshHome();
    await prompt(home, T0 - 20 * MIN, "hello");
    await prompt(home, T0 - 19 * MIN, "hello");
    const b = await workUntilBlocked(home, 0, 200);
    api.down = true;
    const u = await prompt(home, T0 + (b.atMin + 1) * MIN, "urgent: prod");
    assert.equal(u.decision, undefined);
    assert.match(u.systemMessage, /Postponed 30 min.*\(offline: counted on this computer\)/);
    api.down = false;
  });

  it("local mode (no app): the same rules on this computer", async () => {
    const home = freshHome();
    await run(home, T0, ["link", "local"]);
    const r = await prompt(home, T0, "/vvake:urgent 4h");
    assert.match(r.reason, /^Postponed 4 h: no lock until 13:00\. Next unlock needs 11 min of moving instead of 10\. 2 postpones left today\.$/);
    assert.match(await run(home, T0 + 239 * MIN, ["status"]), /postponed until 13:00/);
    assert.doesNotMatch(await run(home, T0 + 241 * MIN, ["status"]), /postponed until/);
  });

  it("busyUntil from the phone is honoured: no lock while it lasts", async () => {
    api.movedMin = 0;
    api.busyUntil = new Date(T0 + 300 * MIN).toISOString();
    const home = freshHome();
    await prompt(home, T0 - 20 * MIN, "hello");
    await prompt(home, T0 - 19 * MIN, "hello"); // links, caches busyUntil
    assert.equal(await workUntilBlocked(home, 0, 200), null);
    api.busyUntil = null;
  });

  it("a desk unlinked from the phone stops locking", async () => {
    api.revoked = false;
    const home = freshHome();
    await prompt(home, T0 - 20 * MIN, "hello");
    await prompt(home, T0 - 19 * MIN, "hello");
    api.revoked = true;
    const b = await workUntilBlocked(home, 0, 100);
    assert.equal(b, null);
    api.revoked = false;
  });

  it("never sends anything from the prompt: only minutes and timestamps", () => {
    assert.ok(api.requests.length > 10);
    for (const r of api.requests) {
      assert.ok(!r.body.includes("payroll") && !r.body.includes("payment"), r.body);
      if (r.url === "/v1/desk/sync" && r.body) {
        const keys = Object.keys(JSON.parse(r.body)).sort();
        assert.ok(keys.every((k) => ["deskMin", "lockedSince", "since", "tz"].includes(k)), keys.join(","));
      }
      if (["/v1/desk/postpone", "/v1/desk/skip", "/v1/desk/unlock", "/v1/desk/resume"].includes(r.url) && r.body) {
        const keys = Object.keys(JSON.parse(r.body));
        assert.ok(keys.every((k) => ["minutes", "tz"].includes(k)), keys.join(","));
      }
      if (r.url === "/v1/desk/pair") assert.deepEqual(Object.keys(JSON.parse(r.body)), ["name"]);
    }
  });
});
