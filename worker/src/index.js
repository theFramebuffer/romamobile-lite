// Roma mobile lite: caveman-HTML arrivals for Rome buses.
// Flow: search stop name -> pick stop -> see arrivals (stops away + minutes).
// Data: per-stop schedule files (GitHub Pages) + Roma Mobilita GTFS-Realtime feeds.

const TU_URL = "https://romamobilita.it/sites/default/files/rome_rtgtfs_trip_updates_feed.pb";
const VP_URL = "https://romamobilita.it/sites/default/files/rome_rtgtfs_vehicle_positions_feed.pb";

const S = {
  title: "RomaMobile Lite",
  search: "Cerca fermata",
  go: "Cerca",
  hint: "Nome della fermata (o il suo numero)",
  none: "Nessuna fermata trovata.",
  pick: "Scegli la fermata:",
  line: "Linea",
  dir: "Direzione",
  eta: "Arrivo",
  stops: "Fermate",
  refresh: "Aggiorna",
  home: "Nuova ricerca",
  nowrt: "Nessun dato in tempo reale al momento.",
  sched: "Da orario (senza dati in tempo reale)",
  soon: "in arrivo",
  atstop: "alla fermata",
  next: "prossima",
  credit: "Dati: Roma Servizi per la Mobilità, CC BY-SA",
  err: "Errore",
};

const NOW_GRACE = 60;       // keep arrivals up to 60s in the past
const HORIZON = 90 * 60;    // realtime arrivals up to 90 min ahead
const SCHED_HORIZON = 45 * 60;
const MAX_RT = 10;
const MAX_SCHED = 4;

// ---------- minimal protobuf reader (only what GTFS-RT needs) ----------

function varint(r) {
  let lo = 0, hi = 0, shift = 0, b;
  do {
    if (r.pos >= r.end) throw new Error("protobuf: unexpected end");
    b = r.buf[r.pos++];
    const v = b & 0x7f;
    if (shift < 28) lo |= v << shift;
    else if (shift === 28) { lo |= (v & 0x0f) << 28; hi |= v >> 4; }
    else hi |= v << (shift - 32);
    shift += 7;
  } while (b & 0x80);
  return [lo >>> 0, hi >>> 0];
}

// Yields [field, wireType, a, b]: varint -> a=lo, b=hi; length-delimited -> a=start, b=end
function* fields(buf, start, end) {
  const r = { buf, pos: start, end };
  while (r.pos < end) {
    const tag = varint(r)[0];
    const f = tag >>> 3, wt = tag & 7;
    if (wt === 0) { const [lo, hi] = varint(r); yield [f, 0, lo, hi]; }
    else if (wt === 2) {
      const len = varint(r)[0], s = r.pos;
      r.pos += len;
      if (r.pos > end) throw new Error("protobuf: bad length");
      yield [f, 2, s, s + len];
    } else if (wt === 1) { yield [f, 1, r.pos, r.pos + 8]; r.pos += 8; }
    else if (wt === 5) { yield [f, 5, r.pos, r.pos + 4]; r.pos += 4; }
    else throw new Error("protobuf: bad wire type " + wt);
  }
}

const dec = new TextDecoder();
const str = (buf, s, e) => dec.decode(buf.subarray(s, e));
const u64 = (lo, hi) => hi * 4294967296 + lo;
const i32 = (lo) => lo | 0;

function tripId(buf, s, e) {
  for (const [f, wt, a, b] of fields(buf, s, e)) {
    if (f === 1 && wt === 2) return str(buf, a, b);
  }
  return null;
}

function parseEvent(buf, s, e) {
  const ev = {};
  for (const [f, wt, a, b] of fields(buf, s, e)) {
    if (f === 1 && wt === 0) ev.delay = i32(a);
    else if (f === 2 && wt === 0) ev.time = u64(a, b);
  }
  return ev;
}

// Light pass over a feed: for each entity of kind `field` (3=trip_update, 4=vehicle)
// return [trip_id, start, end] without parsing the rest.
function* entities(buf, kind) {
  for (const [f, wt, a, b] of fields(buf, 0, buf.length)) {
    if (f !== 2 || wt !== 2) continue;
    for (const [f2, wt2, a2, b2] of fields(buf, a, b)) {
      if (f2 !== kind || wt2 !== 2) continue;
      for (const [f3, wt3, a3, b3] of fields(buf, a2, b2)) {
        if (f3 === 1 && wt3 === 2) { yield [tripId(buf, a3, b3), a2, b2]; break; }
      }
    }
  }
}

function feedTimestamp(buf) {
  for (const [f, wt, a, b] of fields(buf, 0, buf.length)) {
    if (f === 1 && wt === 2) {
      for (const [f2, wt2, a2, b2] of fields(buf, a, b)) {
        if (f2 === 3 && wt2 === 0) return u64(a2, b2);
      }
    }
    if (f === 2) break;
  }
  return null;
}

function parseTripUpdate(buf, s, e) {
  const tu = { stus: [], delay: null };
  for (const [f, wt, a, b] of fields(buf, s, e)) {
    if (f === 2 && wt === 2) {
      const u = {};
      for (const [f2, wt2, a2, b2] of fields(buf, a, b)) {
        if (f2 === 1 && wt2 === 0) u.seq = a2;
        else if (f2 === 2 && wt2 === 2) u.arr = parseEvent(buf, a2, b2);
        else if (f2 === 3 && wt2 === 2) u.dep = parseEvent(buf, a2, b2);
        else if (f2 === 4 && wt2 === 2) u.stop = str(buf, a2, b2);
      }
      tu.stus.push(u);
    } else if (f === 5 && wt === 0) tu.delay = i32(a);
  }
  return tu;
}

function parseVehicle(buf, s, e) {
  const v = { status: 2 }; // spec default: IN_TRANSIT_TO
  for (const [f, wt, a, b] of fields(buf, s, e)) {
    if (f === 3 && wt === 0) v.seq = a;
    else if (f === 4 && wt === 0) v.status = a;
    else if (f === 5 && wt === 0) v.ts = u64(a, b);
  }
  return v;
}

// ---------- realtime logic ----------

// Predicted arrival (epoch seconds) at stop `stopId`/`seq` for one trip, or null.
function predictEta(tu, stopId, seq, schedEpoch) {
  let best = null;
  for (const u of tu.stus) {
    const ev = u.arr || u.dep;
    const exact = u.stop === stopId || (u.seq !== undefined && u.seq === seq);
    if (exact && ev) {
      if (ev.time) return ev.time;
      if (ev.delay !== undefined && schedEpoch !== null) return schedEpoch + ev.delay;
    }
    // delay propagates downstream from the last update at or before our stop
    if (ev && ev.delay !== undefined && u.seq !== undefined && u.seq <= seq) best = ev.delay;
  }
  if (best !== null && schedEpoch !== null) return schedEpoch + best;
  if (tu.delay !== null && schedEpoch !== null) return schedEpoch + tu.delay;
  return null;
}

// How many stops until the bus reaches ours. 0 = at the stop; null = unknown; <0 = passed.
function stopsAway(v, seq) {
  if (!v || v.seq === undefined) return null;
  // VehicleStopStatus: 0 INCOMING_AT, 1 STOPPED_AT, 2 IN_TRANSIT_TO.
  // current_stop_sequence is the stop it is at (1) or heading to (0, 2).
  const heading = v.status !== 1;
  return seq - v.seq + (heading ? 1 : 0);
}

function romeNow(nowMs) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Rome", hour12: false,
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(nowMs));
  const g = (t) => parseInt(p.find((x) => x.type === t).value, 10) % 24;
  const secsToday = g("hour") * 3600 + g("minute") * 60 + g("second");
  const nowS = Math.floor(nowMs / 1000);
  return { nowS, midnight: nowS - secsToday };
}

async function getFeed(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "romamobile-lite/1.0" },
    cf: { cacheTtl: 15, cacheEverything: true },
  });
  if (!r.ok) throw new Error(url + " -> HTTP " + r.status);
  return new Uint8Array(await r.arrayBuffer());
}

async function getData(env, path) {
  const base = (env.DATA_URL || "").replace(/\/$/, "");
  const r = await fetch(base + path, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!r.ok) return null;
  return r.json();
}

async function arrivals(env, stopId, nowMs = Date.now()) {
  const stop = await getData(env, "/s/" + stopId + ".json");
  if (!stop) return null;
  const { nowS, midnight } = romeNow(nowMs);

  const byTrip = new Map();
  for (const [tid, seq, line, head, sched] of stop.t) {
    byTrip.set(tid, { tid, seq, line, head, sched, epoch: sched === null ? null : midnight + sched });
  }

  const warnings = [];
  const [tuBuf, vpBuf] = await Promise.all([
    getFeed(TU_URL).catch((e) => { warnings.push(String(e.message || e)); return null; }),
    getFeed(VP_URL).catch((e) => { warnings.push(String(e.message || e)); return null; }),
  ]);

  const tus = new Map();
  if (tuBuf) {
    try {
      for (const [tid, a, b] of entities(tuBuf, 3)) {
        if (tid && byTrip.has(tid)) tus.set(tid, parseTripUpdate(tuBuf, a, b));
      }
    } catch (e) { warnings.push("trip updates: " + e.message); }
  }
  const vps = new Map();
  let vpAge = null;
  if (vpBuf) {
    try {
      for (const [tid, a, b] of entities(vpBuf, 4)) {
        if (tid && byTrip.has(tid)) vps.set(tid, parseVehicle(vpBuf, a, b));
      }
      const ts = feedTimestamp(vpBuf);
      if (ts) vpAge = nowS - ts;
    } catch (e) { warnings.push("vehicle positions: " + e.message); }
  }

  const rt = [], sc = [];
  for (const t of byTrip.values()) {
    const tu = tus.get(t.tid), vp = vps.get(t.tid);
    if (tu || vp) {
      const eta = tu ? predictEta(tu, stopId, t.seq, t.epoch) : null;
      const n = stopsAway(vp, t.seq);
      if (n !== null && n < 0) continue;                  // already passed
      if (eta !== null && (eta < nowS - NOW_GRACE || eta > nowS + HORIZON)) continue;
      if (eta === null && n === null) continue;
      rt.push({ line: t.line, head: t.head, eta, n });
    } else if (t.epoch !== null && t.epoch >= nowS && t.epoch <= nowS + SCHED_HORIZON) {
      sc.push({ line: t.line, head: t.head, eta: t.epoch, n: null });
    }
  }
  const order = (a, b) => (a.eta ?? Infinity) - (b.eta ?? Infinity) || (a.n ?? 99) - (b.n ?? 99);
  rt.sort(order); sc.sort(order);
  return { name: stop.n, nowS, rt: rt.slice(0, MAX_RT), sc: sc.slice(0, MAX_SCHED), warnings, vpAge,
           gotRealtime: tus.size + vps.size > 0 };
}

// ---------- HTML ----------

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function page(title, body) {
  return new Response(
    `<!DOCTYPE html><html lang="it"><head><meta charset="utf-8"><title>${esc(title)}</title>` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<style>body{font-family:sans-serif;margin:6px}table{border-collapse:collapse}` +
    `td,th{border:1px solid #888;padding:3px 5px;text-align:left}small{color:#555}</style>` +
    `</head><body>${body}<p><small>${S.credit}</small></p></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
}

function searchForm(q = "") {
  return `<h3>${S.title}</h3><form method="get" action="/"><p>${S.hint}:<br>` +
    `<input type="text" name="q" value="${esc(q)}" size="20"> <input type="submit" value="${S.go}"></p></form>`;
}

const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

function fmtEta(r, nowS) {
  if (r.eta === null) return "-";
  const m = Math.round((r.eta - nowS) / 60);
  return m <= 0 ? S.soon : m + " min";
}
function fmtN(n) {
  if (n === null) return "-";
  return n === 0 ? S.atstop : n === 1 ? S.next : String(n);
}

function renderArrivals(stopId, a) {
  let h = `<h3>${esc(a.name)}</h3><p><small>#${esc(stopId)}</small></p>`;
  if (a.rt.length) {
    h += `<table><tr><th>${S.line}</th><th>${S.dir}</th><th>${S.eta}</th><th>${S.stops}</th></tr>`;
    for (const r of a.rt) {
      h += `<tr><td><b>${esc(r.line)}</b></td><td>${esc(r.head)}</td><td>${fmtEta(r, a.nowS)}</td><td>${fmtN(r.n)}</td></tr>`;
    }
    h += `</table>`;
  } else {
    h += `<p>${S.nowrt}</p>`;
  }
  if (a.sc.length) {
    h += `<p>${S.sched}:</p><table>`;
    for (const r of a.sc) {
      h += `<tr><td><b>${esc(r.line)}</b></td><td>${esc(r.head)}</td><td>${fmtEta(r, a.nowS)}</td></tr>`;
    }
    h += `</table>`;
  }
  if (a.warnings.length) h += `<p><small>${S.err}: ${a.warnings.map(esc).join("; ")}</small></p>`;
  if (a.vpAge !== null && a.vpAge > 120) h += `<p><small>GPS: ${Math.round(a.vpAge / 60)} min fa</small></p>`;
  h += `<p><a href="/s/${esc(stopId)}">${S.refresh}</a> | <a href="/">${S.home}</a></p>`;
  return h;
}

// ---------- routing ----------

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/favicon.ico") return new Response(null, { status: 204 });

  const m = path.match(/^\/s\/([A-Za-z0-9_-]+)$/);
  if (m) {
    const a = await arrivals(env, m[1]);
    if (!a) return page(S.title, searchForm() + `<p>${S.none}</p>`);
    return page(a.name, renderArrivals(m[1], a));
  }

  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return page(S.title, searchForm());

  const index = await getData(env, "/stops.json");
  if (!index) return page(S.title, searchForm(q) + `<p>${S.err}: stops.json</p>`);

  if (/^\d+$/.test(q) && index.some((x) => x[0] === q)) {
    return Response.redirect(new URL("/s/" + q, url).toString(), 302);
  }

  const words = norm(q).split(" ").filter(Boolean);
  const hits = index.filter((x) => words.every((w) => x[3].includes(w))).slice(0, 30);
  let body = searchForm(q);
  if (!hits.length) body += `<p>${S.none}</p>`;
  else {
    body += `<p>${S.pick}</p><ul>`;
    for (const [id, name, lines] of hits) {
      body += `<li><a href="/s/${esc(id)}">${esc(name)}</a> <small>#${esc(id)} - ${esc(lines)}</small></li>`;
    }
    body += `</ul>`;
  }
  return page(S.title, body);
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      return page(S.err, `<p>${S.err}: ${esc(e.message || e)}</p><p><a href="/">${S.home}</a></p>`);
    }
  },
};

export { arrivals, entities, parseTripUpdate, parseVehicle, stopsAway, predictEta };
