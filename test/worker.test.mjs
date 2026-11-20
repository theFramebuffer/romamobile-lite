import fs from "node:fs";
import assert from "node:assert/strict";
import worker, { arrivals } from "../worker/src/index.js";

// --- tiny protobuf encoder ---
const vi = (n) => { const o = []; n = BigInt(n); if (n < 0n) n += 1n << 64n; do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const tag = (f, wt) => vi((f << 3) | wt);
const V = (f, n) => [...tag(f, 0), ...vi(n)];
const L = (f, bytes) => [...tag(f, 2), ...vi(bytes.length), ...bytes];
const T = (f, s) => L(f, [...Buffer.from(s)]);
const feed = (ts, entities) => new Uint8Array([
  ...L(1, [...T(1, "2.0"), ...V(3, ts)]),
  ...entities.flatMap((e, i) => L(2, [...T(1, String(i)), ...e])),
]);
const tripUpdate = (tid, stus, delay) => L(3, [
  ...L(1, T(1, tid)),
  ...stus.flatMap((u) => L(2, [
    ...(u.seq !== undefined ? V(1, u.seq) : []),
    ...(u.arr ? L(2, [...(u.arr.delay !== undefined ? V(1, u.arr.delay) : []), ...(u.arr.time ? V(2, u.arr.time) : [])]) : []),
    ...(u.stop ? T(4, u.stop) : []),
  ])),
  ...(delay !== undefined ? V(5, delay) : []),
]);
const vehicle = (tid, seq, status) => L(4, [...L(1, T(1, tid)), ...V(3, seq), ...(status !== undefined ? V(4, status) : [])]);

// --- pick a "now" of 10:02 Rome time today ---
const date = JSON.parse(fs.readFileSync("test/site/meta.json")).date;
let nowMs;
for (let h = 6; h <= 11; h++) {
  const d = new Date(`${date}T0${h % 10}:02:00Z`.replace("T010", "T10").replace("T011", "T11"));
  const hh = +new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", hour: "2-digit", hour12: false }).format(d);
  if (hh === 10) { nowMs = d.getTime(); break; }
}
assert.ok(nowMs, "could not build test clock");
const nowS = Math.floor(nowMs / 1000);

const tu = feed(nowS, [
  tripUpdate("T1", [{ seq: 3, stop: "79618", arr: { time: nowS + 420 } }]),                 // 7 min, explicit time
  tripUpdate("T3", [{ seq: 5, arr: { delay: 3900 } }]),                                       // 09:00 + 65 min = 3 min, propagated delay
  tripUpdate("OTHER", [{ seq: 1, arr: { time: nowS + 60 } }]),                                // unrelated trip, must be ignored
]);
const vp = feed(nowS - 20, [
  vehicle("T1", 1, 2),   // heading to seq 1 -> 3 stops away
  vehicle("T3", 6, 1),   // stopped at seq 6 -> 1 stop away
  vehicle("OTHER", 1, 2),
]);

globalThis.fetch = async (url) => {
  url = String(url);
  if (url.startsWith("https://data.test/")) {
    const f = "test/site" + url.slice("https://data.test".length);
    return fs.existsSync(f) ? new Response(fs.readFileSync(f)) : new Response("nope", { status: 404 });
  }
  if (url.includes("trip_updates")) return new Response(tu);
  if (url.includes("vehicle_positions")) return new Response(vp);
  return new Response("?", { status: 404 });
};
const env = { DATA_URL: "https://data.test" };

const a = await arrivals(env, "79618", nowMs);
console.log(JSON.stringify(a, null, 1));
assert.equal(a.name, "BALDELLI (Via)");
assert.equal(a.rt.length, 2);
assert.deepEqual(a.rt.map((r) => [r.line, Math.round((r.eta - nowS) / 60), r.n]), [["8", 3, 1], ["31", 7, 3]]);
assert.equal(a.warnings.length, 0);

// full HTTP-ish flow (freeze the clock at the fake 10:02)
Date.now = () => nowMs;
const html = await (await worker.fetch(new Request("https://w.test/s/79618"), env)).text();
assert.match(html, /BALDELLI/); assert.match(html, /Casaletto/); assert.match(html, /prossima/);
const s1 = await (await worker.fetch(new Request("https://w.test/?q=baldelli"), env)).text();
assert.match(s1, /href="\/s\/79618"/);
const s2 = await (await worker.fetch(new Request("https://w.test/?q=perche"), env)).text();   // accent-insensitive
assert.match(s2, /79619/);
const r3 = await worker.fetch(new Request("https://w.test/?q=79618"), env);                     // id shortcut
assert.equal(r3.status, 302);
const s4 = await (await worker.fetch(new Request("https://w.test/?q=zzzz"), env)).text();
assert.match(s4, /Nessuna fermata/);
const bad = await (await worker.fetch(new Request("https://w.test/s/nonexistent"), env)).text();
assert.match(bad, /Nessuna fermata/);
console.log("ALL TESTS PASSED");
