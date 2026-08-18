# Frontend UX audit

## Scope

This audit covers the local pr-proof control-plane preview at `http://127.0.0.1:4174`, using `/Users/josiah/Desktop/circle-master/` as the UI/UX source of truth for the shell, icon language, navigation proportions, spacing, colors, and responsive drawer pattern.

- Desktop viewport: 1280 × 720.
- Mobile viewport: 390 × 844.
- Routes reviewed: overview, repositories, repository detail and sections, verification history and run detail, findings, policies, baselines, team, integrations, all active settings sections, and the local report viewer.
- Interaction coverage: navigation, menus, command palette, filters, finding panel, local report export, auth states, settings controls, provider-unavailable states, mobile drawer, and direct deep links.

## Visual findings and fixes

### Resolved

1. Card gaps were too compressed and inconsistent. Standardized spacing now uses 12px for stat cards, 16px for two-column and billing cards, 12px for evidence tiles, and 10px for repository metric tiles.
2. Dashboard and policy cards stretched to the height of their tallest neighbor, creating large empty areas. Grid items now align to their natural height.
3. The desktop two-column sizing made the policy side column too narrow for its copy. The layout now gives the secondary column a 300px minimum and a more balanced 1.2fr/0.8fr split.
4. The final desktop spacing overrides were overriding the mobile breakpoint, causing stacked cards to collide at 390px. The mobile breakpoint now explicitly collapses both two-column and billing grids.
5. The mobile shell rendered two navigation-toggle buttons in the DOM. The duplicate sidebar toggle was removed; the topbar now owns the single mobile navigation control.
6. The settings search field had no behavior. It now filters settings links and hides empty groups, with a no-results message.
7. `Download preview JSON` and `Export metadata` were wired to a missing click branch. Both now download the browser-local structured report and confirm the action with a toast.
8. Unknown repository, run, and finding deep links silently displayed the first record. Unknown ids now render the control-plane not-found surface.
9. Closing a finding opened by a deep link left the URL pointing at the closed panel. Close and Escape now canonicalize the route back to `/app/findings`.
10. The local report viewer showed both a styled “Open JSON report” control and a second native file-picker control. The native input remains available to assistive technology but is visually hidden so the user sees one clear action.
11. The mobile drawer had no obvious close affordance. It now has an X close button inside both the main and settings sidebars, an outside-click scrim, Escape support, and `aria-expanded`/`aria-controls` state on the launcher. The drawer is layered above the scrim so it stays readable.
12. Settings has an explicit “Back to app” path, and the local report viewer has an “Open control plane” exit path. Both were exercised from the live preview.
13. The active control-plane shell now uses Circle’s dark tokens, 244px sidebar, 40px header rhythm, inset desktop frame, compact controls, and lucide-style icon sprite. The pr-proof routes and honest unavailable-state behavior remain unchanged.

## Interaction audit

| Surface | Exercised behavior | Result |
| --- | --- | --- |
| Shell navigation | Primary nav, settings sections, workspace menu, back-to-app link | Pass |
| Command palette | Open, focus, query filtering, result navigation, close | Pass |
| Workspace menus | Account menu, organization menu, team link, unavailable-state toast, toast dismissal | Pass |
| Overview | Connect repository feedback, local report link, finding panel entry | Pass |
| Repositories | Repository detail, section tabs, local-run feedback, repository-settings feedback | Pass |
| Verification runs | History filtering, run detail, local report link | Pass |
| Findings | Text/severity filters, finding panel, scrim/close behavior, metadata export | Pass |
| Policies/baselines | Create/use/provider-unavailable feedback, repository open links, baseline feedback | Pass |
| Team/integrations | Invite feedback, add-integration feedback, local report action, provider states | Pass |
| Settings | Search, save feedback, notification switches, billing actions, policy/baseline/report links | Pass |
| Local report | Browser-local export, return to control plane, local-only messaging | Pass |
| Authentication | Sign-out, sign-in validation, recovery response, reset-token guard, preview sign-up | Pass |
| Error states | Invalid repository, run, and finding deep links | Pass |
| Responsive shell | 390px overview, drawer open/close, mobile navigation, mobile settings drawer | Pass |
| Exit paths | Settings “Back to app”, report “Open control plane”, mobile close X, outside scrim close | Pass |

## Design quality check

- Colors use Circle’s near-black background/container/sidebar tokens with restrained surfaces and explicit amber/red/violet evidence states.
- Card borders and dividers use the same low-contrast line tokens; status colors are reserved for meaning rather than decoration.
- The Circle-style compact sidebar, grouped settings navigation, icon-led rows, compact headers, and inset desktop frame are present across the shell.
- Desktop cards have clear separation without excessive whitespace; mobile cards stack with an explicit 16px rhythm.
- Focus-visible outlines remain available through the global accent outline rule.
- Buttons that cannot be real in this environment explain why through a toast and do not claim persistence.

## Backend dependency handoff

The full frontend-to-backend contract inventory is in [frontend-backend-contract-audit.md](./frontend-backend-contract-audit.md). The highest-priority backend work is identity/session authorization, organization tenancy, GitHub repository connectivity, verification run lifecycle, evidence/report storage and export, finding/baseline/policy persistence, and server-authoritative billing entitlements.

## Remaining boundaries

- Provider-backed actions remain intentionally unavailable until their authenticated, authorized, audited backend contracts exist.
- The local report file chooser was reviewed and its validation handler is wired, but a real OS file-picker selection was not automated in this browser pass; the download and local report return flows were exercised.
- This is a focused visual/interaction audit, not a full WCAG conformance certification or production security review.

## Evidence

The accepted screenshots for this pass are stored in `docs/synara-audit/`, including:

- `11-qa-overview-full.png` — final desktop overview.
- `15-qa-run-detail.png` — final desktop run detail.
- `16-qa-findings.png` — final desktop findings surface.
- `25-qa-settings-billing.png` — final desktop billing settings.
- `31-qa-local-report.png` — final local report viewer.
- `35-qa-mobile-drawer.png` — mobile navigation drawer.
- `36-qa-settings-mobile.png` — mobile settings surface.
- `43-qa-overview-mobile-spacing.png` — final mobile card spacing.
- `46-mobile-nav-open.png` — main mobile drawer with visible close control and readable scrim layering.
- `49-settings-nav-open-close.png` — settings drawer with Back to app and close controls.
- `50-exit-desktop-final.png` — final desktop overview left ready for review.
- `51-mobile-nav-closed-final.png` — final mobile overview with the drawer closed.
- `52-circle-overview-desktop.png` — active Circle shell at desktop size.
- `53-circle-overview-mobile.png` — active Circle shell at 390px.
- `54-circle-drawer-open.png` — mobile drawer with close control and scrim.
- `55-circle-findings.png` — Circle findings surface.
- `56-circle-settings-billing.png` — Circle settings/billing surface.
- `57-circle-local-report.png` — Circle local report viewer.
