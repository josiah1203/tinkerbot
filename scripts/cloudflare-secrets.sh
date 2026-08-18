#!/usr/bin/env bash
set -euo pipefail

config_path="apps/control-plane-worker/wrangler.jsonc"
environment=""
action="${1:-}"
secret_name="${2:-}"

usage() {
  printf '%s\n' "Usage: bash scripts/cloudflare-secrets.sh list [environment]" "       bash scripts/cloudflare-secrets.sh put SECRET_NAME [environment]" "" "put opens Wrangler's interactive prompt; it never accepts a secret value as an argument."
}

if [[ "$action" != "list" && "$action" != "put" ]]; then
  usage
  exit 2
fi

if [[ "$action" == "put" ]]; then
  case "$secret_name" in
    WORKOS_CLIENT_ID|WORKOS_API_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|SESSION_ENCRYPTION_KEY) ;;
    *) printf 'Unsupported secret name: %s\n' "$secret_name" >&2; exit 2 ;;
  esac
fi

environment="${3:-${2:-}}"
if [[ "$action" == "put" ]]; then
  environment="${3:-}"
fi

environment_args=()
if [[ -n "$environment" ]]; then
  environment_args+=(--env "$environment")
fi

if [[ "$action" == "list" ]]; then
  pnpm exec wrangler secret list --config "$config_path" "${environment_args[@]}"
else
  pnpm exec wrangler secret put "$secret_name" --config "$config_path" "${environment_args[@]}"
fi
