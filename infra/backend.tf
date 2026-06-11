# State backend.
#
# Default is local state (infra/terraform.tfstate, gitignored). For team use or
# CI applies, switch to a remote backend so state isn't lost with the runner.
# Cloudflare R2 speaks the S3 API and works well here:
#
# terraform {
#   backend "s3" {
#     bucket                      = "roo26-tfstate"
#     key                         = "roo26/terraform.tfstate"
#     region                      = "auto"
#     endpoints                   = { s3 = "https://<account-id>.r2.cloudflarestorage.com" }
#     skip_credentials_validation = true
#     skip_region_validation      = true
#     skip_requesting_account_id  = true
#     skip_metadata_api_check     = true
#     skip_s3_checksum            = true
#     use_path_style              = true
#   }
# }
#
# Provide R2 access keys via AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, then
# run `tofu init -reconfigure`.
