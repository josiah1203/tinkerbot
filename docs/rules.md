# Rules

Findings use `info`, `warning`, `high`, and `critical` severity and always include a file, line, rule ID, evidence, suggested action, and confidence.

Initial rule IDs include:

- `assertion.removed`
- `assertion.count-reduced`
- `matcher.weakened`
- `tolerance.widened`
- `test.deleted`
- `test.disabled`
- `test.todo-added`
- `mock.unconditional-success`
- `mock.broad-replacement`
- `error-assertion.removed`
- `coverage.exclusion-added`
- `test.non-vacuous`
- `impact.unverified`
- `impact.dynamic-unknown`
- `impact.deleted-symbol`
- `mutation.survived`
- `contract.breaking`
- `contract.potentially-breaking`
- `contract.additive`
- `contract.unknown`
- `fixture.snapshot-deleted`
- `fixture.snapshot-churn`
- `fixture.snapshot-unexplained`
- `fixture.expected-error-removed`
- `fixture.less-specific`
- `fixture.acknowledgement-missing`
- `policy.unknown`

Rules are conservative. A normal test refactor that does not show a specific weakening pattern should not produce a warning merely because the file changed.
