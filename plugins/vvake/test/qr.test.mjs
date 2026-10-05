// The encoder was checked against a real decoder (jsQR: every mask, L and M, versions 1–10). These tests pin
// the structure so a change that breaks it shows up without a decoder.
import assert from "node:assert/strict";
import { it } from "node:test";
import { encodeQr, qrToTerminal } from "../lib/qr.mjs";

it("picks the smallest version and draws the finder patterns", () => {
  const qr = encodeQr("https://vvake.com/claude/X7K2-9QPM");
  assert.equal(qr.version, 3);
  assert.equal(qr.size, 29);
  const finder = ["#######", "#.....#", "#.###.#", "#.###.#", "#.###.#", "#.....#", "#######"];
  for (const [ox, oy] of [[0, 0], [22, 0], [0, 22]])
    for (let y = 0; y < 7; y++) assert.equal(qr.modules[oy + y].slice(ox, ox + 7).map((d) => (d ? "#" : ".")).join(""), finder[y]);
  assert.equal(qr.modules[qr.size - 8][8], true, "dark module");
  assert.equal(encodeQr("y".repeat(200), { ecl: "L" }).version, 9);
  assert.throws(() => encodeQr("z".repeat(400)));
});

it("is deterministic and renders two rows per line with a quiet zone", () => {
  const a = encodeQr("hello");
  assert.deepEqual(a.modules, encodeQr("hello").modules);
  const lines = qrToTerminal(a).split("\n");
  assert.equal(lines.length, Math.ceil((a.size + 4) / 2));
  assert.ok(lines.every((l) => [...l].length === a.size + 4));
  assert.equal(lines[0], "█".repeat(a.size + 4));
});
