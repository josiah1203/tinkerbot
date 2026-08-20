# Control-plane authentication

Browser sign-in is WorkOS AuthKit with PKCE S256, state, and nonce cookies. Redirect URIs are allowlisted via `WORKOS_REDIRECT_URI` and `CONTROL_PLANE_URL`. Cookie-authenticated mutations require a matching Origin. Auth and invitation endpoints are rate-limited.

Sessions persist in encrypted D1. `expires_at` is enforced on authorization; `/auth/session` may refresh and otherwise fails closed. Membership removal denies access. Org switch is a CSRF-protected POST.

CLI login stores a short-lived session in `~/.tinkerbot/credentials.json` (mode 0600), overridable with `TINKERBOT_CONTROL_PLANE_URL` and `TINKERBOT_SESSION_TOKEN`. Action ingestion uses OIDC-exchanged run tokens, not pasted WorkOS session UUIDs.
