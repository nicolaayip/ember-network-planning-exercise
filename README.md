<!-- @format -->

# Ember Network Planning — Newcastle–Edinburgh

Take-home exercise: review a proposed A1 coach route, timetable, and fleet plan under real-world constraints.

This repo contains:

- **`src/`** — analysis engine (route, traffic, demand, timetable audit, fleet scheduling)
- **`web/`** — read-only dashboard over a frozen engine output (maps, tables, written conclusions)

## For reviewers

You do **not** need to re-run the engine to evaluate the submission.

### Dashboard

Use the live link in the submission email. To run locally: `cd web && npm install && npm run dev`.

### Full engine re-run (optional)

Not required. The dashboard contains a complete frozen output from a prior run.

To regenerate from scratch:

1. Copy `.env.example` → `.env` and add API keys (Google Routes, OpenRouteService, BODS; TNDS optional for Scottish competitor coverage).
2. Download datasets listed in [`data/README.md`](data/README.md) (NaPTAN CSV, census population, etc.).
3. Run:

```bash
npm install
npm start -- --input fixtures/routes/newcastle-edinburgh.json
cd web && npm run sync && npm run dev
```

`MOCK=true` in `.env` serves from `cache/` only — cache is gitignored and empty on a fresh clone, so the first run needs network access and keys.
