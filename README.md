# RomaMobile Lite

Tiny, no-nonsense bus arrivals for Rome. Good for old browsers and spotty connections.

Type a stop name -> pick the stop -> see lines, directions, minutes and stops away.

How it works
- `scripts/build_data.py` (run daily by GitHub Actions) turns Rome's static GTFS into
  one small JSON file per stop and publishes them on GitHub Pages.
- `worker/src/index.js` (Cloudflare Worker) serves the 3 HTML pages and reads the live
  GTFS-Realtime feeds on each request. Nothing is stored.

## Live website
https://romamobile-lite.pages.dev/

## Setup

### 1. GitHub
1. Fork this repo and make it public.
2. Go into Settings -> Pages -> **Build and deployment -> Source: GitHub Actions**.
3. Go into the Actions tab -> "Build stop data" -> **Run workflow**. Wait for the green tick.
4. Open `https://YOUR-USERNAME.github.io/YOUR-REPO/stops.json`. If you see a long list, the data is live.

### 2. Cloudflare Worker
Dashboard method (no tools needed):
1. Cloudflare dashboard -> Workers & Pages -> Create -> Worker -> Deploy.
2. "Edit code" -> replace everything with the contents of `worker/src/index.js` -> Deploy.
3. Worker -> Settings -> Variables and Secrets -> add a text variable
   `DATA_URL` = `https://YOUR-USERNAME.github.io/YOUR-REPO` (no trailing slash) -> Deploy.

Or with the command line: edit `worker/wrangler.toml`, then `cd worker && npx wrangler deploy`.

## Tests
`python3 test/make_fake_gtfs.py && python3 scripts/build_data.py test/fake_gtfs.zip test/site && node test/worker.test.mjs`

Data: Roma Servizi per la Mobilità, CC BY-SA.
