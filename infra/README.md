# infra/ — Cloudflare IaC (OpenTofu)

Declarative definition of everything Roo '26 needs at the edge. Asset uploads
are handled separately by the GitHub Actions deploy workflow; this manages the
project and its surrounding resources.

## What it manages

| Resource | Purpose |
|---|---|
| `cloudflare_pages_project.roo26` | The Pages project (direct-upload). |
| `cloudflare_pages_domain.roo26` | Attaches `roo26.alkem.dev`. |
| `cloudflare_dns_record.roo26` | Proxied CNAME → `<project>.pages.dev`. |
| `cloudflare_workers_kv_namespace.roo` | `ROO_KV` for crew sharing (only when `enable_crew = true`). |
| `cloudflare_web_analytics_site.roo26` | Cookieless analytics, auto-injected beacon. |

## Prerequisites (you provide these — they can't be scripted)

1. **API token** — Cloudflare dashboard → My Profile → API Tokens → Create.
   Permissions: **Account · Cloudflare Pages · Edit**, **Account · Workers KV
   Storage · Edit**, **Account · Account Analytics · Read** /
   **Zone · Web Analytics · Edit**, and **Zone · DNS · Edit** on `alkem.dev`.
2. **Account ID** — Cloudflare dashboard → any domain → right sidebar.
3. **Zone ID** for `alkem.dev` — same place.

## Apply

```sh
cd infra
cp terraform.tfvars.example terraform.tfvars   # fill in account_id + zone_id
export TF_VAR_cloudflare_api_token=...          # don't commit the token
tofu init
tofu plan
tofu apply
```

Deploys themselves are handled by Cloudflare Pages' native Git integration
(CF builds on every push to `main`), not by this config — `tofu apply` only
provisions/maintains the project and its surrounding resources.

## State

State is local by default (gitignored). Run infra changes from your machine, or
switch to the R2 remote backend in `backend.tf` if you want shared/CI state.
