# Roo '26 — Cloudflare infrastructure as code (OpenTofu).
#
# Owns everything the app needs at the edge: the Pages project, the optional
# crew-sharing KV namespace + binding, the custom domain, its DNS record, and
# privacy-friendly Web Analytics. Asset uploads are done by the GitHub Actions
# deploy workflow (`wrangler pages deploy`) — this is a direct-upload project,
# so there is intentionally no `source` block wiring Cloudflare's own builder.

locals {
  # ROO_KV binding, attached to both prod and preview deploys when crew is on.
  kv_namespaces = var.enable_crew ? {
    ROO_KV = { namespace_id = cloudflare_workers_kv_namespace.roo[0].id }
  } : null
}

# Optional KV namespace backing the crew location-sharing feature. The client
# feature-detects via /roo26-api/health and hides all crew UI when it's absent,
# so leaving enable_crew = false ships a fully-working app without it.
resource "cloudflare_workers_kv_namespace" "roo" {
  count      = var.enable_crew ? 1 : 0
  account_id = var.cloudflare_account_id
  title      = "${var.project_name}-crew"
}

resource "cloudflare_pages_project" "roo26" {
  account_id        = var.cloudflare_account_id
  name              = var.project_name
  production_branch = var.production_branch

  deployment_configs = {
    production = {
      compatibility_date = var.compatibility_date
      kv_namespaces      = local.kv_namespaces
    }
    preview = {
      compatibility_date = var.compatibility_date
      kv_namespaces      = local.kv_namespaces
    }
  }
}

# Attach the custom domain to the Pages project.
resource "cloudflare_pages_domain" "roo26" {
  account_id   = var.cloudflare_account_id
  project_name = cloudflare_pages_project.roo26.name
  name         = var.domain
}

# Point the subdomain at the project's *.pages.dev hostname (proxied → the
# Pages custom-domain cert is issued automatically).
resource "cloudflare_dns_record" "roo26" {
  zone_id = var.zone_id
  name    = var.dns_record_name
  type    = "CNAME"
  content = cloudflare_pages_project.roo26.subdomain
  proxied = true
  ttl     = 1
  comment = "Managed by OpenTofu — Roo '26 Cloudflare Pages"
}

# Privacy-friendly, cookieless analytics; auto_install injects the beacon on
# the proxied custom domain with no code change.
resource "cloudflare_web_analytics_site" "roo26" {
  count        = var.enable_web_analytics ? 1 : 0
  account_id   = var.cloudflare_account_id
  host         = var.domain
  auto_install = true
}
