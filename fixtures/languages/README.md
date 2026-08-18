# Language support fixtures

These small fixtures exercise the language registry and bounded adapters without requiring the corresponding toolchains in CI.

- `python/` covers relative imports, a route decorator, a `coverage.py` JSON artifact, and `test_*.py` discovery.
- `go/` covers `go.mod` package resolution, `_test.go` discovery, and a Go coverprofile.
- `rust/` covers `mod`, `use`, `#[test]`, and compile-time macro uncertainty.
- `c/` and `cpp/` cover quoted/system includes, symbols, native test naming, and preprocessing uncertainty.

The fixtures are parser evidence, not a claim that PR Proof replaces each ecosystem’s compiler, test runner, or mutation engine.
