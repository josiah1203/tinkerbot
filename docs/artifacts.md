# CI artifact adapters

Artifacts are optional local evidence. The normalized result always includes an adapter type, producer label when known, source path, parsing status, completeness, metrics, records, and unknowns. Missing or malformed files are explicit `missing`/`malformed` states and never become fabricated coverage or test results.

Supported adapters:

- LCOV (`lcov.info` or `--type lcov`)
- Istanbul coverage JSON (`coverage-final.json` or `--type istanbul`)
- coverage.py JSON (`--type coverage.py`)
- Go coverprofile (`coverage.out` or `--type go-coverprofile`)
- gcov text (`*.gcov` or `--type gcov`)
- LLVM coverage export JSON (`--type llvm-cov`)
- JUnit XML (`junit.xml` or `--type junit`)
- Jest and Vitest JSON result formats (`--type jest` or `--type vitest`)
- Stryker JSON (`--type stryker`)
- SARIF (`*.sarif` or `--type sarif`)
- generic JSON (`--type generic`)

Use the CLI locally:

```sh
pr-proof artifacts --input coverage/lcov.info
pr-proof artifacts --input test-results/junit.xml --type junit --format json
```

The generic adapter accepts any valid JSON and records it without claiming a domain-specific interpretation. An organization may add a future adapter by preserving the same normalized fields; it must document producer/version handling, partial-input behavior, security limits, and fixture tests before being enabled in a policy pack.
