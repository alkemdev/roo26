output "pages_project_name" {
  description = "Name of the Cloudflare Pages project (pass to wrangler --project-name)."
  value       = cloudflare_pages_project.roo26.name
}

output "pages_subdomain" {
  description = "The project's *.pages.dev hostname."
  value       = cloudflare_pages_project.roo26.subdomain
}

output "custom_domain" {
  description = "Custom domain the project serves."
  value       = cloudflare_pages_domain.roo26.name
}

output "kv_namespace_id" {
  description = "ROO_KV namespace id (null when crew sharing is disabled)."
  value       = var.enable_crew ? cloudflare_workers_kv_namespace.roo[0].id : null
}

output "web_analytics_token" {
  description = "Web Analytics beacon token (null when analytics is disabled)."
  value       = var.enable_web_analytics ? cloudflare_web_analytics_site.roo26[0].site_token : null
  sensitive   = true
}
