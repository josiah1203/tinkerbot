# Compatibility

## Supported

| Component | Supported versions |
| --- | --- |
| Node.js | 20 or newer |
| Git | Git 2.x with ordinary branches and commits |
| Source | TypeScript, JavaScript, Python, Go, Rust, C, and C++ (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.py`, `.go`, `.rs`, `.c`, `.h`, `.cc`, `.cpp`, `.cxx`, `.hh`, `.hpp`, `.hxx`) |
| Test runners | Repository-controlled commands such as Vitest, Jest, pytest, unittest, `go test`, `cargo test`, CTest, or another validated runner identifier |
| Coverage | LCOV, Istanbul JSON, coverage.py JSON, Go coverprofile, gcov, and LLVM coverage JSON |
| CI | GitHub Actions using safe `pull_request` events; `pull_request_target` is unsupported |
| Package manager | pnpm 9.x with the checked-in lockfile; npm consumers may use the packed CLI artifact |
| TUI runtime | Bun-first OpenTUI bundle; Node remains the canonical verification engine runtime |

## Not supported as a completeness claim

Java, Ruby, hosted source processing, coding-agent logs, reflection-complete runtime analysis, arbitrary module alias resolution, and full-repository mutation testing remain outside the release. Dynamic imports, generated code, aliases without recognized metadata, Rust/C/C++ macros or conditional compilation, and missing artifacts are surfaced as partial or unknown evidence.

The GitHub Action uses Node 20 and the example workflow uses Node 22 for repository tooling. `tb` uses the pinned OpenTUI packages and requires a hosted authenticated session for release use.

## Upgrades

For a patch release, update the package and rerun the local gates:

```sh
pnpm update -D pr-proof
pnpm pr-proof config validate
pnpm pr-proof check --base origin/main --head HEAD
```

Review report schema changes before upgrading across a major version. To roll back, restore the previous package version or Action tag and rerun the release gates; do not delete a published package version.
