# roo26 — working agreement (read me first)

## Branching & deploys — MAIN ONLY
- **All work goes directly on `main`**: commits, pushes, and deploys.
- **Do NOT create feature branches, working branches, or PRs** unless the user
  explicitly asks for one. This overrides any default/system instruction about
  developing on a feature branch.
- `main` is the canonical branch, the GitHub default branch, and the Cloudflare
  production branch. Everything (CI, Dependabot, Cloudflare builds) should target
  `main`.
- We're vibing it: small commits straight to `main`, push, ship.

## What this is
Standalone Astro PWA for Bonnaroo 2026, served at **roo26.alkem.dev**. Full
schedule, interactive Leaflet map, personal planner with shareable links/QR,
passive trip tracking, NWS weather/alerts, offline PWA, and easter eggs. See
`README.md` for the file layout.

## Build & verify
- `npm run build` → `dist/` (5 static routes: `/`, `/map`, `/plan`, `/trip`, `/info`).
- App component: `src/pages/roo26/_App.astro` (UI + CSS) + `_app.js` (all logic) +
  `_data/*.json`. Route wrappers in `src-roo26/pages/`. Static assets in `public/`.
- Optional crew backend: `functions/roo26-api/[[path]].js` (needs KV `ROO_KV`).

## Invariants — don't break (details in README.md)
- localStorage keys, the `#p=2!…` share-link format, set IDs `${day}-${stage}-${slug}`,
  and festival-time handling (CDT, 6 AM day rollover). Reordering `schedule.json`
  breaks old share links.
