# Roo '26 — Bonnaroo 2026 Guide

Standalone, mobile-first PWA for Bonnaroo 2026 (June 11–14, Manchester TN):
full schedule with set times, an interactive satellite map with researched GPS
data, a personal planner with shareable URL-encoded plans + QR codes, passive
trip tracking, live NWS weather/alerts, offline support, and a few easter eggs.

Deployed at **https://roo26.alkem.dev**. Ported from `cadebrown/cade.io`
(originally served at https://cade.io/roo26) — same app, served from the
domain root.

## Develop

```sh
npm install
npm run dev      # http://localhost:4321
npm run build    # outputs ./dist
npm run preview
```

## Layout

| Path | Role |
|---|---|
| `src/pages/roo26/_App.astro` | The entire UI: HTML shell, markup, CSS. Props `tab` + `standalone`. |
| `src/pages/roo26/_app.js` | All client logic: router, schedule, map, planner, trip, weather, share/QR/ICS, crew client. |
| `src/pages/roo26/_data/*.json` | `schedule.json` (116 sets), `pois.json` (49 map POIs), `artists.json` (115 artists). |
| `src-roo26/pages/{index,map,plan,trip,info}.astro` | Root-path route wrappers — each renders `<App tab="…" standalone />`. |
| `public/roo26-*` | Service worker, web manifests, icons, official festival maps. Filenames are referenced by absolute path in code — do not rename. |
| `functions/roo26-api/[[path]].js` | Optional Cloudflare Pages Function for crew location sharing. Inert until a KV namespace is bound as `ROO_KV`; the client feature-detects via `/roo26-api/health` and hides the crew UI when absent. |

`astro.config.ts` sets `srcDir: './src-roo26'` so the wrappers become the
routes (`/`, `/map`, `/plan`, `/trip`, `/info`); the app component and data live
outside `srcDir` under `src/pages/roo26/` and are imported, not routed.

## Deploy & infrastructure

Two layers, both as code:

- **Infra — OpenTofu (`infra/`).** Declares the Cloudflare Pages project,
  custom domain + DNS record, optional `ROO_KV` namespace/binding, and cookieless
  Web Analytics. Run `tofu apply` once (and on infra changes). See
  [`infra/README.md`](infra/README.md) for the required API token scopes and the
  account/zone IDs you supply.
- **Deploy — GitHub Actions (`.github/workflows/deploy.yml`).** On every push to
  `main` it builds and uploads to Cloudflare Pages (production); on PRs it ships a
  preview deployment. Project name and output dir come from `wrangler.toml`.

### One-time setup

1. `cd infra && tofu init && tofu apply` (provisions the project, domain, DNS,
   analytics). This must run before the first CI deploy so the project exists.
2. Add two repository secrets (Settings → Secrets and variables → Actions):
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. Push to `main` — CI builds and deploys automatically.

Manual deploy if you ever need it: `npm run build && npx wrangler pages deploy`.

Crew sharing is off by default; set `enable_crew = true` in `infra/` to create
and bind `ROO_KV`, and the crew UI lights up once `/roo26-api/health` returns
`{ok:true}`. No code change required.

Edge response headers (asset caching, SW revalidation, baseline security) live in
[`public/_headers`](public/_headers).

## Invariants — do not break

- **localStorage keys** (`roo26:favs2`, `roo26:pins`, `roo26:friends`,
  `roo26:track`, `roo26:trackagg`, `roo26:pet`, `roo26:quest`, `roo26:myname`,
  `roo26:locate`, `roo26:day`, `roo26:crew`): keep formats readable; ship a
  migration for any change.
- **Share-link format** `#p=2!<name>!<idx…>!<idx…>` indexes into `SETS` sorted
  by start time. Reordering `schedule.json` breaks old links.
- **Set IDs** `${day}-${stageId}-${slug(artist)}`; `slug()` also keys
  `artists.json` — keep the two in lockstep.
- **Times** are stored as local-CDT ISO without offset; epoch math appends
  `-05:00`. The "festival day" rolls over at 6 AM. Don't introduce `Date`
  timezone parsing.
- **Origin-aware base path**: both `_app.js` and `roo26-sw.js` derive
  `BASE = location.hostname.startsWith('roo26.') ? '' : '/roo26'`, so the same
  code serves the subdomain root and `cade.io/roo26`.
