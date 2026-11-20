# Roma mobile lite

Tiny, no-JavaScript bus arrivals for Rome, built for very old phones (Nokia E61 + Opera Mini).
Type a stop name -> pick the stop -> see lines, directions, minutes and stops away.

How it works
- `scripts/build_data.py` (run daily by GitHub Actions) turns Rome's static GTFS into
  one small JSON file per stop and publishes them on GitHub Pages.
- `worker/src/index.js` (Cloudflare Worker) serves the 3 HTML pages and reads the live
  GTFS-Realtime feeds on each request. Nothing is stored.

## Setup (once, from a computer)

### 1. GitHub
1. Create a new **public** repository (e.g. `romamobile-lite`) and upload everything in this folder
   (keep the `.github/workflows` folder; it starts with a dot, so check it uploaded).
2. Repo -> Settings -> Pages -> **Build and deployment -> Source: GitHub Actions**.
3. Repo -> Actions tab -> "Build stop data" -> **Run workflow**. Wait for the green tick.
4. Open `https://YOUR-USERNAME.github.io/YOUR-REPO/stops.json`. If you see a long list, the data is live.

### 2. Cloudflare Worker
Dashboard method (no tools needed):
1. Cloudflare dashboard -> Workers & Pages -> Create -> Worker -> name it `romamobile-lite` -> Deploy.
2. "Edit code" -> replace everything with the contents of `worker/src/index.js` -> Deploy.
3. Worker -> Settings -> Variables and Secrets -> add a text variable
   `DATA_URL` = `https://YOUR-USERNAME.github.io/YOUR-REPO` (no trailing slash) -> Deploy.

Or with the command line: edit `worker/wrangler.toml`, then `cd worker && npx wrangler deploy`.

### 3. On the E61
Open `https://romamobile-lite.YOUR-SUBDOMAIN.workers.dev/s/79618` in Opera Mini and bookmark it.
That goes straight to Baldelli. For any other stop, use the search page, then bookmark the result.

## Checking it works
Compare the first real result against the official Roma mobile / Muoversi a Roma app at the
same stop. If the Worker shows "Nessun dato in tempo reale" while buses are running, see below.

## Known unknowns (not testable without internet access)
- Whether the live trip-updates feed carries per-stop predictions. The code handles three cases
  (exact prediction, delay + schedule, stops-away only) but was only tested on synthetic data.
- Whether romamobilita.it answers requests coming from Cloudflare's servers.
- Whether the Worker stays inside Cloudflare's free CPU limit (10 ms per request) when decoding
  the full feed. It only fully decodes trips serving your stop, so it should, but it is unmeasured.
- Trip IDs in the live feed must match the static GTFS. The daily rebuild keeps them in sync.

## Tests
`python3 test/make_fake_gtfs.py && python3 scripts/build_data.py test/fake_gtfs.zip test/site && node test/worker.test.mjs`

Data: Roma Servizi per la Mobilita, CC BY-SA. Keep the credit line on the pages.
