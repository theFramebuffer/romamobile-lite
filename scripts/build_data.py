#!/usr/bin/env python3
"""
Turn Rome's static GTFS zip into tiny per-stop JSON files.

Usage:  python scripts/build_data.py [gtfs.zip | URL] [output_dir]

Output (default: site/):
  stops.json        [[stop_id, name, "lines", "normalized name"], ...]
  s/<stop_id>.json  {"n": name, "t": [[trip_id, stop_sequence, line, headsign, scheduled_seconds], ...]}
  meta.json         {"built": ..., "date": ...}

Only trips running today (Europe/Rome) are kept, plus yesterday's trips that
run past midnight. Scheduled seconds are counted from today's midnight.
"""
import csv
import datetime as dt
import io
import json
import os
import re
import sys
import unicodedata
import urllib.request
import zipfile
from collections import defaultdict
from zoneinfo import ZoneInfo

GTFS_URL = "https://romamobilita.it/sites/default/files/rome_static_gtfs.zip"
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]+$")


def norm(s):
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def secs(t):
    t = (t or "").strip()
    if not t:
        return None
    h, m, s = t.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def rows(zf, name):
    if name not in zf.namelist():
        return
    with zf.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig", newline=""))


def active_services(zf, day):
    ymd = day.strftime("%Y%m%d")
    weekday = day.strftime("%A").lower()
    active = set()
    for r in rows(zf, "calendar.txt"):
        if r["start_date"] <= ymd <= r["end_date"] and r.get(weekday) == "1":
            active.add(r["service_id"])
    for r in rows(zf, "calendar_dates.txt"):
        if r["date"] == ymd:
            if r["exception_type"] == "1":
                active.add(r["service_id"])
            elif r["exception_type"] == "2":
                active.discard(r["service_id"])
    return active


def line_key(x):
    return (0, int(x), "") if x.isdigit() else (1, 0, x)


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else GTFS_URL
    out = sys.argv[2] if len(sys.argv) > 2 else "site"

    if src.startswith("http"):
        print("Downloading", src)
        req = urllib.request.Request(src, headers={"User-Agent": "romamobile-lite-builder"})
        data = urllib.request.urlopen(req, timeout=120).read()
        zf = zipfile.ZipFile(io.BytesIO(data))
    else:
        zf = zipfile.ZipFile(src)

    today = dt.datetime.now(ZoneInfo("Europe/Rome")).date()
    svc_today = active_services(zf, today)
    svc_yday = active_services(zf, today - dt.timedelta(days=1))
    print("Date", today, "- services today:", len(svc_today), "yesterday:", len(svc_yday))

    routes = {r["route_id"]: (r.get("route_short_name") or r.get("route_long_name") or r["route_id"])
              for r in rows(zf, "routes.txt")}

    # trip_id -> (line, headsign, is_today)
    trips = {}
    for r in rows(zf, "trips.txt"):
        sid = r["service_id"]
        in_today = sid in svc_today
        if in_today or sid in svc_yday:
            trips[r["trip_id"]] = (
                routes.get(r["route_id"], r["route_id"]),
                (r.get("trip_headsign") or "").strip(),
                in_today,
            )
    print("Trips kept:", len(trips))

    per_stop = defaultdict(list)
    for r in rows(zf, "stop_times.txt"):
        t = trips.get(r["trip_id"])
        if t is None:
            continue
        line, headsign, in_today = t
        s = secs(r.get("arrival_time"))
        if s is None:
            s = secs(r.get("departure_time"))
        if not in_today:
            # yesterday's trip: only the part after midnight matters today
            if s is None or s < 86400:
                continue
            s -= 86400
        sid = r["stop_id"]
        if not SAFE_ID.match(sid):
            continue
        hs = (r.get("stop_headsign") or "").strip() or headsign
        per_stop[sid].append([r["trip_id"], int(r["stop_sequence"]), line, hs, s])
    print("Stops with service:", len(per_stop))

    names = {r["stop_id"]: r["stop_name"].strip() for r in rows(zf, "stops.txt")}

    os.makedirs(os.path.join(out, "s"), exist_ok=True)
    index = []
    for sid, lst in per_stop.items():
        name = names.get(sid, sid)
        lst.sort(key=lambda x: (x[4] is None, x[4]))
        with open(os.path.join(out, "s", sid + ".json"), "w", encoding="utf-8") as f:
            json.dump({"n": name, "t": lst}, f, ensure_ascii=False, separators=(",", ":"))
        lines = sorted({x[2] for x in lst}, key=line_key)
        shown = " ".join(lines[:8]) + (" ..." if len(lines) > 8 else "")
        index.append([sid, name, shown, norm(name)])
    index.sort(key=lambda x: x[3])
    with open(os.path.join(out, "stops.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(out, "meta.json"), "w") as f:
        json.dump({"built": dt.datetime.now(dt.timezone.utc).isoformat(), "date": str(today)}, f)
    print("Done:", len(index), "stops written to", out)


if __name__ == "__main__":
    main()
