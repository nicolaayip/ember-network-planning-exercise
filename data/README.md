# Data inventory

Gitignored except this file. Paths are relative to `data/`.

## Local files (place before engine run)

| Path | Required | Source |
| --- | --- | --- |
| `naptan_stops.csv` | Yes | [NaPTAN CSV](https://beta-naptan.dft.gov.uk/download) |
| `census2021-ts001-lsoa.csv` | Yes | ONS Census 2021 TS001 (usual residents by LSOA) |
| `tnds/S.zip` | No | [Traveline NTD](https://www.travelinedata.org.uk/traveline-open-data/traveline-national-dataset/) region `S` — Scottish competitor timetables |

## Brief inputs (assignment)

| Path | Purpose |
| --- | --- |
| `task/newcastle_edinburgh_routemap.kmz` | Route stops (Google My Maps export) |
| `task/newcastle_edinburgh_routetimetable.xlsx` | Proposed 8-column timetable |

Import both into `fixtures/routes/<route-id>.json`:

```bash
node scripts/import-route.js \
  --kmz data/task/newcastle_edinburgh_routemap.kmz \
  --timetable data/task/newcastle_edinburgh_routetimetable.xlsx \
  --route-id newcastle-edinburgh \
  --depot-name "Newcastle Depot"
```

## Fetched at runtime (cached under `cache/`, stored under `data/bods/`)

| Source | Env key | Notes |
| --- | --- | --- |
| Google Routes + Route Matrix | `GOOGLE_MAPS_API_KEY` | Leg times, OD matrix, polylines |
| OpenRouteService | `OPENROUTESERVICE_API_KEY` | Walk isochrones |
| WebTRIS | — | Traffic windows (England SRN) |
| ONS + ScotGov ArcGIS | — | LSOA / Data Zone boundaries + Scottish population |
| Overpass (OSM) | — | POI gravity, carriageway type |
| BODS + coach zip | `BODS_API_KEY` | Competitor timetables → `data/bods/` |
