# Synara UI audit

Date: 2026-08-17

## Scope and evidence

The reference application is `/Users/josiah/Desktop/untitled folder/synara-main`. The documented workflow is `bun run dev`; the focused web workflow is `bun run dev:web`.

The focused runner could not start in this checkout because the root script invokes the TypeScript runner through Node 22 (`Unknown file extension ".ts"`). Running the web app directly with `bun run --cwd apps/web dev -- --host 127.0.0.1` rendered the shell. Starting the companion server then stopped at a missing source module: `apps/server/src/git/Layers/GitCore`. As a result, the live settings content could not hydrate, but the shell and settings navigation were inspectable.

Accepted captures from the current run:

- [Desktop shell / startup state](./synara-audit/01-desktop-startup-blocker.png)
- [Mobile startup state](./synara-audit/02-mobile-startup-blocker.png)
- [Desktop settings shell](./synara-audit/03-settings-shell.png)

The desktop capture shows the persistent left rail, workspace mode switch, compact header actions, primary navigation, loading state, footer Settings/Help actions, and the dark zero-contrast surface. The settings capture shows a dedicated back affordance, searchable settings navigation, grouped sections, an active row, and a blank content surface while server-backed settings are unavailable. The mobile capture shows the centered startup mark without a usable shell; responsive settings content therefore remains a source-level audit rather than a live claim.

## Patterns to reuse

- Persistent left navigation with a clear active treatment and a dedicated settings mode.
- A workspace context switcher near the top of the rail.
- Compact icon actions for search, creation, and account/settings entry, each with accessible labels.
- Settings as a nested route with a “Back to app” action rather than a separate product surface.
- Settings navigation grouped by information domain and paired with a search field.
- Bordered, filled cards made from stacked rows separated by hairlines.
- Small row typography, muted descriptions, stable spacing, and quiet hover states.
- Loading and empty copy inside the same visual hierarchy as loaded content.
- Toast, dialog, reset, select, segmented-control, and keyboard-navigation primitives.
- System/light/dark theme tokens, density choices, and a sidebar seam that gives the main surface gentle depth.
- Command/search palettes for intent-driven retrieval rather than exposing every action in the primary rail.

## Patterns to adapt for pr-proof

- Replace workspace mode (Studio/Synara) with an organization selector and keep repository scope visible.
- Replace personal/workstation navigation with Overview, Repositories, Verification Runs, Policies, History, Team, and Settings.
- Keep settings grouped, but add organization-facing Account, Security, Notifications, Integrations, Billing, Members, and Audit Log.
- Keep the shell density and quiet borders, but give verification states explicit labels: Verified, Needs review, Unknown, and Failed.
- Keep loading/empty/error patterns, but always explain whether a state comes from the runner, a provider, or missing synchronized metadata.
- Adapt the command palette to repository/run/finding navigation and safe actions; do not expose workstation or agent actions.
- Adapt confirmations to policy blocking changes, repository disconnects, metadata deletion, billing state changes, and member removal.

## Patterns not appropriate for pr-proof

- Studio, personal notes, inbox, calendar, agents, files, new agent chat, provider/model controls, managed worktrees, and workstation-specific actions.
- A single opaque quality score or a decorative activity feed with no review action.
- A source editor or a second pull-request review surface.
- A loading state that leaves the user unable to tell whether the repository runner or the hosted control plane is responsible.
- Local-only provider usage, chat behavior, agent skills, or desktop update settings.

## Synara-specific code and business logic excluded

The pr-proof control plane does not import Synara components, contracts, routes, data stores, provider logic, desktop APIs, account state, thread state, or branding. It only migrates interaction concepts and visual relationships. Authentication, organization authorization, billing, entitlements, report synchronization, and audit events are implemented behind pr-proof-specific interfaces.

## Accessibility observations and limits

The inspected shell exposes named buttons, a labelled settings search field, grouped navigation regions, active-state semantics, and separate help/settings affordances. The source also includes keyboard handling for settings search, radio-like segmented controls, dialogs, and command palettes. The live startup blocker prevented a full keyboard traversal, focus-order check, form validation check, and screen-reader inspection of hydrated settings content. Those behaviors are tested in the pr-proof app independently.

