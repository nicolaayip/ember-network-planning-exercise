<!-- @format -->

# Ember Network Planning — Newcastle–Edinburgh

Take-home exercise: review a proposed A1 coach route, timetable, and fleet plan under real-world constraints.

## How to review

The repo ships with a **frozen engine output** at `web/public/scenarios/newcastle-edinburgh.json`. Open the dashboard to read it — no API keys or engine run required:

```bash
cd web && npm install && npm run dev
```

## Repo layout

- **`web/`** — dashboard; **`web/public/scenarios/`** holds the frozen analysis JSON
- **`src/`** — analysis engine (only needed to regenerate that JSON)

## Re-running the engine (optional)

See [`data/README.md`](data/README.md) for required datasets and API keys. Pipeline:

```bash
# 1. Import brief inputs (KMZ + timetable) → fixtures/routes/newcastle-edinburgh.json
node scripts/import-route.js \
  --kmz data/task/newcastle_edinburgh_routemap.kmz \
  --timetable data/task/newcastle_edinburgh_routetimetable.xlsx \
  --route-id newcastle-edinburgh --depot-name "Newcastle Depot"

# 2. Run engine → output/newcastle-edinburgh.json
npm install
npm start -- --input fixtures/routes/newcastle-edinburgh.json

# 3. Publish to dashboard
cd web && npm run sync && npm run dev
```

Step 1 is already done — the committed fixture and scenario JSON are in the repo. Repeat it only if the brief inputs change.
