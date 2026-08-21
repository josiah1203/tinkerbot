#!/usr/bin/env sh
set -eu

: "${TINKERBOT_RELEASE_BASE_URL:?Set TINKERBOT_RELEASE_BASE_URL to the approved HTTPS release directory.}"
case "$TINKERBOT_RELEASE_BASE_URL" in https://*) ;; *) echo "TINKERBOT_RELEASE_BASE_URL must use HTTPS" >&2; exit 2;; esac

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$os" in darwin|linux) ;; *) echo "Unsupported operating system: $os" >&2; exit 2;; esac
arch="$(uname -m)"
case "$arch" in x86_64|amd64) arch=x64;; arm64|aarch64) arch=arm64;; *) echo "Unsupported architecture: $arch" >&2; exit 2;; esac
target="$os-$arch"
manifest_url="$TINKERBOT_RELEASE_BASE_URL/manifest.json"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM
curl -fsSL "$manifest_url" -o "$tmp/manifest.json"
read_manifest() { node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1]));const a=m.artifacts.find((x)=>x.target===process.argv[2]);if(!a)process.exit(3);process.stdout.write(`${a.file}\n${a.sha256}\n`)' "$tmp/manifest.json" "$target"; }
values="$(read_manifest)" || { echo "No artifact for $target in release manifest" >&2; exit 3; }
file="$(printf '%s\n' "$values" | sed -n '1p')"
expected="$(printf '%s\n' "$values" | sed -n '2p')"
curl -fsSL "$TINKERBOT_RELEASE_BASE_URL/$file" -o "$tmp/client.tar.gz"
actual="$(shasum -a 256 "$tmp/client.tar.gz" | awk '{print $1}')"
[ "$actual" = "$expected" ] || { echo "Checksum mismatch for $file" >&2; exit 4; }
prefix="${TINKERBOT_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$prefix"
tar -xzf "$tmp/client.tar.gz" -C "$tmp"
install -m 755 "$tmp/tb" "$prefix/tb"
echo "Installed tb to $prefix/tb"
