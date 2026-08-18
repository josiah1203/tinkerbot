# Agent Collision Guard

## User problem

Concurrent branches or worktrees can overlap on files, symbols, migrations, lockfiles, public APIs, or generated outputs.

## CLI and Action surface

Planned: `pr-proof collisions --base ... --head ... --compare REF`. It will remain a local comparison tool, not an orchestration service.

## Inputs and outputs

Inputs are two local Git revisions/worktrees and the shared parser graph. Output would classify overlapping files, symbols, migration directories, lockfiles, public APIs, and generated artifacts.

## Rules and unknowns

Exact file/symbol/path overlap is deterministic. Unavailable worktrees, generated outputs, dynamic symbols, and uncommitted changes not represented by a revision are `UNKNOWN`.

## Security, false positives, and configuration

Do not inspect other users’ directories without explicit paths. Lockfiles and generated outputs can be intentionally shared, so findings need ownership/context configuration.

## Fixtures and out of scope

Fixtures need disjoint branches, same-file changes, moved symbols, same migrations, and generated outputs. Merge arbitration, messaging, and agent scheduling are out of scope.
