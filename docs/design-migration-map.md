# pr-proof design migration map

| Synara concept inspected | pr-proof adaptation | Decision |
| --- | --- | --- |
| Persistent left sidebar | Organization-scoped control-plane rail | Migrate |
| Workspace mode switch | Organization/repository scope selector | Adapt |
| Search button and command palette | Route, repository, run, and finding retrieval | Adapt |
| Account/settings entry | Account menu plus nested Settings route | Adapt |
| Grouped SettingsSidebarNav | Settings groups for account, security, notifications, integrations, billing, team, audit | Migrate |
| Search settings field | Search setting names and deep-link to a section | Migrate |
| Bordered stacked SettingsCard rows | Billing, security, notification, integration, and policy configuration rows | Migrate |
| Segmented controls/selects | Theme, notification, plan/status filters, and evidence filters | Adapt |
| Reset buttons and unsaved reset epoch | Policy/settings reset with unsaved-change warning | Adapt |
| Toast manager | Save success/failure, connection state, and non-destructive action feedback | Migrate |
| Confirmation dialogs | Disconnect, metadata deletion, billing changes, policy blocking changes, member removal | Adapt |
| Loading/empty/error states | Runner connection, report sync, no repositories, no runs, missing evidence, provider unavailable | Adapt |
| Theme tokens and density | pr-proof dark/light tokens with evidence/status semantics | Adapt |
| Personal notes/inbox/calendar/agents/files | No equivalent in a verification control plane | Exclude |
| Synara providers, threads, desktop APIs, account data | Not part of pr-proof business logic | Exclude |

The implementation uses the relationship between surfaces, not Synara source files. It keeps pr-proof report schema and server-authoritative domain interfaces separate from the visual shell.

