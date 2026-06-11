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
| `public/_headers` | Edge headers (immutable caching for `/_astro/*`, no-cache SW, baseline security). Honored by Workers Static Assets. |
| `src-roo26/pages/roo26-api/[...path].ts` | On-demand Worker route for crew location sharing (`prerender = false`). Inert until a KV namespace is bound as `ROO_KV` in `wrangler.jsonc`; the client feature-detects via `/roo26-api/health` and hides the crew UI when absent. |
| `wrangler.jsonc` | Cloudflare Workers config (Static Assets + `@astrojs/cloudflare`). |

`astro.config.ts` sets `srcDir: './src-roo26'` so the wrappers become the
routes (`/`, `/map`, `/plan`, `/trip`, `/info`); the app component and data live
outside `srcDir` under `src/pages/roo26/` and are imported, not routed.

## Deploy — Cloudflare Workers

Deploys run on **Cloudflare Workers** (Static Assets + on-demand routes via the
`@astrojs/cloudflare` adapter). Cloudflare's **Workers Builds** clones the repo
and runs the build itself on every push to `main` — no GitHub Actions.
`roo26.alkem.dev` is the canonical URL (the build emits absolute canonical/OG
tags there) and the link to share everywhere.

- **Build command:** `npm run build` → emits `dist/client` (assets) + `dist/server`
  (the Worker). The adapter writes the deploy config to `dist/server/wrangler.json`.
- **Deploy command:** `npx wrangler deploy` (Workers Builds default). The adapter's
  redirected config wires the Worker + `dist/client` assets automatically.
- **Bindings/config:** `wrangler.jsonc` (config-as-code). `html_handling:
  drop-trailing-slash` gives clean no-slash URLs (`/map`, not `/map/`).

### One-time setup (Cloudflare dashboard)

1. Workers & Pages → **Create → Import a repository** → `alkemdev/roo26`.
2. **Production branch `main`**; build/deploy commands as above (auto-detected for
   Astro). Node version from `.nvmrc`-equivalent / Workers default (22).
3. The Worker's **Settings → Domains & Routes** → add `roo26.alkem.dev` (same CF
   account as the `alkem.dev` zone → DNS + cert are automatic).

After that, every push to `main` ships to production. Local preview of the built
Worker (incl. the crew route): `npx wrangler dev`.

Crew sharing is off by default. Create a KV namespace, uncomment the
`kv_namespaces` binding (`ROO_KV`) in `wrangler.jsonc`, and the crew UI lights up
once `/roo26-api/health` returns `{ok:true}`. No code change required.

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
