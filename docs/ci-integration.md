# CI integration

Use `pull_request`, never `pull_request_target`, for contributor-controlled code:

```yaml
name: PR Proof
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  checks: write
  pull-requests: write
jobs:
  pr-proof:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4.2.2
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4.4.0
        with: { node-version: 22 }
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      # Replace this local path with the immutable released Action tag.
      - uses: ./
        with:
          base: ${{ github.event.pull_request.base.sha }}
          head: ${{ github.event.pull_request.head.sha }}
          policy: default
```

The Action runs entirely on the runner. Check Run and comment calls are best effort; local report files, annotations, and the step summary remain useful when a fork token cannot write. Upload `.pr-proof/report.sarif` with `actions/upload-artifact` or the organization’s approved SARIF uploader when `sarif: true`.

The Action never invokes `select-tests` to skip required CI tests. Use that command as a separate recommendation if a repository wants to schedule a narrower early test batch, while keeping the full required suite as the merge gate.
