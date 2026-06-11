variable "cloudflare_api_token" {
  description = "Cloudflare API token with Pages:Edit, Workers KV Storage:Edit, DNS:Edit, and Web Analytics:Edit on the target account/zone."
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the Pages project and KV."
  type        = string
}

variable "zone_id" {
  description = "Zone ID for alkem.dev (used for the DNS record)."
  type        = string
}

variable "project_name" {
  description = "Cloudflare Pages project name. Must match the --project-name used by the deploy workflow."
  type        = string
  default     = "roo26"
}

variable "production_branch" {
  description = "Git branch treated as production for the Pages project."
  type        = string
  default     = "main"
}

variable "domain" {
  description = "Custom domain served by the Pages project."
  type        = string
  default     = "roo26.alkem.dev"
}

variable "dns_record_name" {
  description = "Subdomain record name within the zone (the label, not the FQDN)."
  type        = string
  default     = "roo26"
}

variable "compatibility_date" {
  description = "Workers/Pages runtime compatibility date for the Functions runtime."
  type        = string
  default     = "2026-06-01"
}

variable "enable_crew" {
  description = "Create the ROO_KV namespace and bind it so the crew location-sharing feature turns on."
  type        = bool
  default     = false
}

variable "enable_web_analytics" {
  description = "Provision Cloudflare Web Analytics (privacy-friendly, no cookies) and auto-inject the beacon."
  type        = bool
  default     = true
}
