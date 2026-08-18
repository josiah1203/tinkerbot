# Control-plane authentication

The control plane uses a provider-neutral authentication adapter. The adapter boundary owns sign-in, sign-up, password reset requests, session refresh, sign-out, and session lookup. The shell only consumes the adapter contract and preserves a safe `returnTo` path for protected-route redirects.

## Current status

The legacy browser preview development adapter is not a production authorization boundary. The Cloudflare Worker has a WorkOS AuthKit path: OAuth state validation, server-side code exchange, encrypted D1 session persistence, secure HTTP-only cookies, session lookup/refresh, sign-out, D1 membership authorization, signed WorkOS membership-event synchronization, bounded current-user reconciliation, and opt-in cursor-based Events API replay are implemented behind `/auth/workos/*`, `/auth/session`, `/tenant/access`, `/tenant/membership/sync`, `/auth/signout`, `/integrations/workos/webhook`, and the scheduled handler.

Production configuration still required:

- D1 binding and `SESSION_ENCRYPTION_KEY` deployment secret;
- enabling the selected seven-day replay/bootstrap window after WorkOS credentials and webhook verification are ready;
- organization switching and server-side authorization for every future hosted resource;
- rate limiting for sign-in, sign-up, and password reset;
- CSRF protection for cookie-authenticated mutations;
- safe redirect allowlisting;
- provider webhook/event handling where applicable.

The Worker does not enable hosted UI routes automatically and does not treat a WorkOS organization identifier as proof of application-level membership. Membership rows are provisioned by verified WorkOS membership events, can be repaired for the current session organization through the sync route, and can be advanced through the cursor-based Events API consumer. The selected seven-day bootstrap is configured but not enabled, and full historical bootstrap, organization switching, and production browser configuration remain. An absent, suspended, invited, or removed row receives no hosted access.

The browser never supplies a trusted plan, role, organization, or entitlement. Those values must be resolved from the server-side session and organization membership.

## Assurance authorization

Release `tb` commands require a valid hosted session. Hosted assurance reads and ingestion require an active organization membership, repository authorization, and the server-side entitlement for hosted assurance metadata. Mutation routes also enforce origin checks and role requirements; the browser cannot grant itself access. Assurance records are keyed by organization and repository on the server, and missing session, membership, D1 storage, or provider configuration produces an explicit denial or unavailable response.
