# Client distribution

Tinkerbot distributes one proprietary terminal client through authorized channels. None of the commands on this page publish a package, create a release, or configure a provider account.

## Release artifacts

Build the supported targets in an authorized release environment. Cross-compilation depends on the Bun/OpenTUI target dependencies being available there.

```sh
TINKERBOT_TUI_TARGETS=bun-darwin-arm64,bun-darwin-x64,bun-linux-arm64,bun-linux-x64 \
pnpm release:clients
```

This produces `dist/release/tinkerbot-<version>-<target>.tar.gz` and `dist/release/manifest.json`. The manifest lists every artifact’s SHA-256 and deliberately records `signed: false` until an approved signing workflow produces provenance. Do not upload or advertise an unsigned artifact as a production release.

## npm and Bun

The package is restricted and must be published only to the approved private registry after the release artifacts and provenance are approved. `publishConfig.access` is `restricted`; an operator must still explicitly select the registry during authorized publication.

```sh
npm install -g @tinkerbot/cli@<version> --registry https://<approved-registry>
bun add -g @tinkerbot/cli@<version> --registry https://<approved-registry>
```

No public npm publishing command belongs in the release runbook.

## Homebrew

After both Darwin archives are in the manifest, render the formula from the same checksums:

```sh
TINKERBOT_RELEASE_BASE_URL=https://<approved-download-host>/<version> \
pnpm release:homebrew
```

Commit the generated `dist/release/tinkerbot.rb` to the approved private tap only after its URL, checksum, and signing/provenance review pass. Consumers then use `brew install <organization>/tinkerbot/tinkerbot`.

## curl installer

Host `scripts/install.sh`, `manifest.json`, and the approved archives in one HTTPS release directory. The installer selects the current Darwin/Linux architecture, downloads the manifest, validates the artifact’s SHA-256, then installs `tb` to `$HOME/.local/bin` (or `TINKERBOT_INSTALL_DIR`).

```sh
curl -fsSL https://<approved-download-host>/<version>/install.sh | \
  TINKERBOT_RELEASE_BASE_URL=https://<approved-download-host>/<version> sh
```

The host, version, signing identity, registry, and Homebrew tap are external release gates. The placeholders must be replaced by the release owner; they are intentionally not guessed in source.
