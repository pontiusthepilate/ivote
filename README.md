# Ivote

Citizen collation of Nigerian election results, polling unit by polling unit.

- **Reporter app** (`/`): pick Presidential (black), Senate (red) or House of Reps (green), find your
  polling unit (GPS, unit number, or State → LGA → Ward → Unit), enter party scores, add a photo of the
  result sheet, or report a problem with up to 10 photos/videos (≤30 s)/files, each with a comment.
- **Live results** (`/results`): national map coloured by leading party, drill down
  Nigeria → State → LGA → Ward → Polling unit (Senate/Reps also by senatorial district / federal
  constituency), party totals, coverage, disputed units, and a review screen per polling unit with every
  report, result-sheet photo and incident file.

## Run locally

```bash
npm install
npm run build-db      # once: builds data/ivote.sqlite from data/sources (≈7 s)
npm start             # http://localhost:4600
```

`.env` holds `PORT` and `ADMIN_KEY`. Click **Admin** at the bottom of `/results` and enter the key to
verify or reject individual reports.

Demo data: `npm run seed-demo` adds made-up results; `npm run clear-demo` removes them.
Before going live: `npm run reset-reports -- --yes` deletes **all** reports and uploads.

## How collation works

- One report = one phone's scores for one polling unit in one election.
- For each polling unit and election, exactly one report counts (`pu_results`):
  1. an admin-**verified** report, else
  2. the result the **most reporters agree on** (newest breaks ties).
- A phone that reports the same unit again **replaces** its own earlier report (corrections).
- Units where reporters sent different numbers are marked **disputed** and listed under *Needs review*.
- Totals for wards, LGAs, states, districts and the nation are sums over counted reports.
- Flags: `high_total` (over 3,000 votes), `no_sheet` (no photo). Flags inform review; they do not block.
- Party names are normalised (`labour party`, `L.P.` → `LP`).

Photos and files are stored per polling unit under the key
`<state>/<lga>/<ward>/<unit>/<election>/<result_sheet|incident>/…`, and indexed in the `media` table
(with `store` = `s3` or `local`), so any unit, ward or LGA can pull up its numbers and files together.

**Storage:** when `BUCKET_NAME` is set (plus `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_ENDPOINT_URL_S3`, `AWS_REGION`), files go to that S3-compatible bucket and `/media/:id` redirects to
a signed link valid for 1 hour; the bucket stays private. Without it, files go to `uploads/` on disk.
Production uses the Tigris bucket `ivote-uploads` (created with `fly storage create`). If storage is
unreachable the server answers 503 and the phone keeps the report and retries.

## Offline use

Reports are saved on the phone first (IndexedDB) and sent when there is network; the header shows
"N waiting to send". Each report carries a `client_id`, so a retry is never counted twice. A service
worker caches the app and every location list the user has opened.

## Parties and candidates

Each score row shows **party logo · party + candidate name · votes**; extra parties are typed into a box
and get their logo once the name matches a registered party. Candidate photos are not shown (for now). The ballot comes from
`/api/ballot` for the polling unit's district (Senate/Reps) or the whole country (Presidential).

- `parties.csv` — INEC's 22 registered parties; logos from inecnigeria.org/parties in `public/img/parties/`.
- `candidates_pres.csv` — INEC final presidential list (18 tickets), typed from the PDF.
- `candidates_senate.csv`, `candidates_reps.csv` — parsed from INEC's final lists
  (`2027 SENATE FINAL LIST OF CANDIDATES.pdf`, `2027 REPS FINAL LIST OF CANDIDATES.pdf`);
  `scripts/import-candidates.js` matches each row to the official district (1,303 Senate candidates in
  109/109 districts, 3,560 Reps candidates in 360/360 constituencies).
- Photos (currently hidden): 17 of 18 presidential photos are bundled in `public/img/candidates/`
  (6 from Wikimedia Commons, 11 from news sites; sources in `credits.json`). The `/api/ballot` response
  and `/api/admin/candidate-photo` upload still support photos if they are switched back on.
- Parties and candidates reload from `data/sources` on every server start.

## Data sources (`data/sources/`)

| File | What | Source |
|---|---|---|
| `polling_units.csv` | All 176,846 INEC polling units with codes, ward/LGA/state, senatorial district and federal constituency | github.com/Emeka-Onwuepe/Polling_Units_in_Nigeria |
| `pu_geo_locator.csv` | ~23k unit coordinates from the INEC locator | github.com/devolamide/Polling-Unit-Finder |
| `pu_geo_mykeels.csv` | ~96k geocoded unit coordinates (noisy) | github.com/mykeels/inec-polling-units |
| `ward_centroids.json` | Ward centre points | github.com/temikeezy/nigeria-geojson-data |
| `states.geojson`, `lgas.geojson` | State (37) and LGA (774) boundaries | geoBoundaries (gbOpen NGA ADM1/ADM2) |

The build keeps a coordinate only if it falls inside the unit's own LGA boundary, and drops geocodes
reused for many units (town-centre fallbacks). Result: ~50k units with trusted points. GPS lookup
picks the exact unit when the phone is within 350 m of one; otherwise it picks the nearest ward and the
user chooses the unit from that ward's list.

## Deploying

Live at https://vote.wwwaaayyy.com and https://ivote.fly.dev (Fly app `ivote`, region `lhr`, volume `/data` for the database,
Tigris bucket `ivote-uploads` for files). The polling unit database is built during the Docker build
and copied to the volume on first boot. Redeploy with `~/.fly/bin/fly deploy --app ivote --remote-only`. Needs Node ≥ 22.13 (uses `node:sqlite`).
Before election day:

- Use a paid or self-hosted map tile server; OpenStreetMap's public tiles are for light use only.
- Load-test `/api/reports` and `/api/results` (results are cached for 5 s per view).
- Consider SMS/USSD reporting for phones without data.
