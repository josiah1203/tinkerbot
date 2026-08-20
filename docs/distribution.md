# Client distribution

Tinkerbot distributes the Node CLI through authorized channels. Release archives are produced by `pnpm release:clients` as `dist/release/tinkerbot-<version>-node.tar.gz` plus `manifest.json`.

The manifest records `"signed": false` until an approved signing workflow produces provenance (checksums, npm provenance, macOS Developer ID/notarization, Windows Authenticode, Linux cosign). Do not advertise an unsigned artifact as a signed production release.

```sh
pnpm release:clients
```

Publish `@tinkerbot/cli` only to the approved private registry. Homebrew and curl installers consume the same checksum manifest after Darwin/Windows/Linux signed binaries exist.
