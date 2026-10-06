/**
 * What the VVake API answers is checked before any of it reaches Claude's context (audit VV-08: the hook's
 * systemMessage and the commands' output are read by Claude). A compromised or spoofed API (or a wrong VVAKE_API) must
 * not be able to put a foreign link or instructions there:
 * - pairing links are VVake's own: https://vvake.com/claude/<code> and vvake://claude/<code>, matching the code;
 * - numbers are integers in a sane range, dates are ISO dates, the rule's `unlockBy` is one of two words;
 * - names are cut to letters, digits, spaces and _ . ' ’ - (40 at most). The plugin shows its own machine name anyway.
 * Anything that fails is dropped (null), and the caller falls back to what it already knows. Pure, no dependencies.
 */

export const VERIFY_URL = /^https:\/\/vvake\.com\/claude\/[A-Z0-9-]{9}$/;
export const APP_URL = /^vvake:\/\/claude\/[A-Z0-9-]{9}$/;
const USER_CODE = /^[A-Z0-9-]{9}$/;
const DEVICE_CODE = /^[A-Za-z0-9_-]{32,64}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const DEFAULTS = Object.freeze({ enabled: true, afterMin: 90, unlockMin: 10, overridesPerDay: 2, unlockBy: "move", warnMin: 10 });
const RULE_RANGES = { afterMin: [1, 1440], unlockMin: [1, 600], overridesPerDay: [0, 50], warnMin: [0, 600] };

/** An integer in [min, max], else null. */
export const intIn = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null);
/** An ISO date-time string, else null. */
export const isoOrNull = (v) => (typeof v === "string" && ISO.test(v) && Number.isFinite(Date.parse(v)) ? v : null);

/** A name safe to show: plain characters only, one line, ≤ 40; null when nothing is left. */
export function safeName(s, max = 40) {
  if (typeof s !== "string") return null;
  const out = s
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/[^\p{L}\p{N}_ .'’-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
  return out || null;
}

/** POST /v1/desk/pair's answer, or null unless every field is what VVake sends. */
export function validPairing(p) {
  if (!p || typeof p !== "object") return null;
  const { userCode, deviceCode, verifyUrl, appUrl } = p;
  if (typeof userCode !== "string" || !USER_CODE.test(userCode)) return null;
  if (typeof deviceCode !== "string" || !DEVICE_CODE.test(deviceCode)) return null;
  if (typeof verifyUrl !== "string" || !VERIFY_URL.test(verifyUrl) || !verifyUrl.endsWith(`/${userCode}`)) return null;
  if (appUrl !== undefined && appUrl !== null && (typeof appUrl !== "string" || !APP_URL.test(appUrl) || !appUrl.endsWith(`/${userCode}`))) return null;
  const interval = intIn(p.interval, 1, 60);
  const expiresIn = intIn(p.expiresIn, 10, 3600);
  if (interval === null || expiresIn === null) return null;
  return { userCode, deviceCode, verifyUrl, ...(appUrl ? { appUrl } : {}), interval, expiresIn };
}

/** A desk token from POST /v1/desk/token, or null. */
export const validToken = (t) => (typeof t === "string" && TOKEN.test(t) ? t : null);

/** A short id (desk id), or null. */
export const validId = (s) => (typeof s === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(s) ? s : null);

/** Keeps a field that can't carry text: a boolean, a finite number, or an ISO date. */
const inert = (v) => typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e7) || isoOrNull(v) !== null || v === null;

/** The rule: known fields checked (a bad one falls back to the default), other fields kept only when inert. */
export function validRule(r) {
  const src = r && typeof r === "object" ? r : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) if (!(k in DEFAULTS) && /^[A-Za-z]{1,40}$/.test(k) && inert(v)) out[k] = v;
  out.enabled = typeof src.enabled === "boolean" ? src.enabled : DEFAULTS.enabled;
  for (const [k, [min, max]] of Object.entries(RULE_RANGES)) out[k] = intIn(src[k], min, max) ?? DEFAULTS[k];
  out.unlockBy = src.unlockBy === "away" || src.unlockBy === "move" ? src.unlockBy : DEFAULTS.unlockBy;
  return out;
}

const LOCK_INTS = ["requiredMin", "postponesLeftToday", "skipsLeftThisWeek", "nextRequiredMin", "lastResortRequiredMin"];

/** The escapes' counters from the API, or null when any of them isn't what it should be. */
export function validLock(l) {
  if (!l || typeof l !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(l)) if (/^[A-Za-z]{1,40}$/.test(k) && inert(v)) out[k] = v;
  for (const k of LOCK_INTS) {
    if (intIn(l[k], 0, 100_000) === null) return null;
    out[k] = l[k];
  }
  for (const k of ["postponedUntil", "clearedAt"]) {
    if (l[k] !== undefined && l[k] !== null && isoOrNull(l[k]) === null) return null;
    out[k] = l[k] ?? null;
  }
  out.lastResortOnly = l.lastResortOnly === true;
  return out;
}

/** Minutes moved from the API, or null. */
export const validMinutes = (v) => (typeof v === "number" ? intIn(Math.round(v), 0, 100_000) : null);
