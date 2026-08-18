# Release runbook

This runbook prepares a release without publishing or modifying external GitHub repositories.

## Dry run

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
pnpm pack --pack-destination /tmp/pr-proof-pack-release
NPM_CONFIG_CACHE=/tmp/pr-proof-npm-cache npm pack --dry-run
```

The current pnpm 9 CLI does not implement a `pack --dry-run` flag, so packing into `/tmp` is the equivalent non-publishing dry run. Inspect the pack output and confirm that it contains the CLI entry point, `dist/packages`, `dist/action`, `action.yml`, documentation, `README.md`, `LICENSE`, and `pr-proof.yml`, but not `tests/`, `fixtures/`, `.pr-proof/`, secrets, or machine-specific paths.

## Versioning

The first release uses:

- Source/package/CLI version: `0.1.0`
- Report schema version: `1`
- Action release tag: `v0.1.0`
- Major compatibility tag: `v1`

These versions are related but independently meaningful. A report schema change must be versioned even when the CLI patch version changes.

## Authorized release steps

Run only from an authorized release checkout after review:

```sh
git add .
git commit -m "release: pr-proof v0.1.0"
git tag -a v0.1.0 -m "pr-proof v0.1.0"
git push origin main --follow-tags
pnpm publish --access public
```

After publishing the Action repository, point the `v1` tag at the same immutable release commit. Replace `OWNER/pr-proof-action@v1` in examples with the actual repository reference.

## Rollback

Do not delete a published package version. Deprecate a broken package version, move the major Action tag back to the last known-good immutable commit, and publish a patch release. Re-run the dry-run gates before restoring the tag.

## Live validation checklist

Use an authorized test organization and verify a small Vitest repository, a Jest repository, a repository without coverage, a mutation timeout, a large diff, a dynamic import, a fork PR, and a repeated synchronize event. Record Check Run creation/update, comment update, SARIF, annotations, exact base/head SHAs, duration, cache behavior, and absence of source/secrets in external output.
