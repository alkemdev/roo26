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

## Deploy — Cloudflare Workers
- Deploys on **Cloudflare Workers** (Static Assets + `@astrojs/cloudflare`), via
  Workers Builds on push to `main`. Config-as-code in `wrangler.jsonc`.
- `npm run build` → `dist/client` (assets) + `dist/server` (Worker). Verify the
  Worker locally with `npx wrangler dev` (test routes + `/roo26-api/health`).

## Build & verify
- 4 routes: `/`, `/map`, `/plan`, `/info` (clean no-slash URLs).
- App component: `src/pages/roo26/_App.astro` (UI + CSS) + `_app.js` (all logic) +
  `_data/*.json`. Route wrappers in `src-roo26/pages/`. Static assets in `public/`.
- Crew backend: `src-roo26/pages/roo26-api/[...path].ts` (on-demand Worker route,
  `prerender = false`; needs KV `ROO_KV` bound in `wrangler.jsonc`).

## Invariants — don't break (details in README.md)
- localStorage keys, the `#p=3!<name>!<srcIdx…>` share-link format (v2 `2!…` still
  decoded for old links), set IDs `${day}-${stage}-${slug}`, and festival-time
  handling (CDT, 8 AM day rollover). v3 indexes stable `srcIdx` values, so reordering
  `schedule.json` is safe for v3 links but still breaks legacy v2 links.
