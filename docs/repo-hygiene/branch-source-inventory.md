# Branch and Worktree Source Inventory

Status: reviewable provenance record; no branch or worktree was deleted.

Observed 2026-08-21 from local `main` in the repository root. `main` is the
canonical release source. A branch being present below does not make it an
independent source of truth; changes must be deliberately reconciled into
`main` or the branch must be archived by an authorized maintainer.

## Branch refs

| Ref | Commit | Relationship / disposition |
| --- | --- | --- |
| `main` | `917a11b` | Canonical local integration and release source; one commit ahead of `origin/main`. The current canonical-tree cleanup is staged locally and is not committed yet. |
| `codex/release-source-recovery` | `0bf74d7` | Tracked recovery branch. Its tip is behind the current `main` line; review only if a unique change is identified. |
| `codex/software-factory-ux` | `f193272` | Separate historical Factory UX line; one unique commit ahead of its `origin/main` base and substantially behind current `main`. Do not merge wholesale. |
| `codex/webui` | `deccb90` | Historical UI/TUI line with parallel commits; substantially behind current `main`. Selectively reconcile or archive. |

## Worktrees

| Path | Ref / state | Handling |
| --- | --- | --- |
| `/Users/josiah/Documents/ChatGPT/Dev Tools` | `main` at `917a11b` | Canonical working tree. |
| `/private/var/folders/tw/6qr20tr576ncmnr_s4ctj13h0000gn/T/tinkerbot-pr.FSoyYe6pPh` | `codex/software-factory-ux` at `f193272` | Historical parallel worktree; preserve until its unique changes are triaged. |
| `/Users/josiah/.codex/worktrees/791b/Dev Tools` | detached at `f1ebe43` | Detached historical snapshot; not a release source. |

## Source-of-truth policy

1. `main` and the ADRs linked from `docs/README.md` are the only canonical
   release and architecture sources.
2. A branch or worktree may contribute only through a reviewed cherry-pick or
   an explicit reconciliation record.
3. Branch cleanup is intentionally deferred here because deleting or archiving
   refs is an external repository-management action. The inventory makes the
   remaining provenance gate explicit and recoverable.
