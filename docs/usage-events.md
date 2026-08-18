# Optional usage-event adapter

The core tool does not emit telemetry. A future opt-in adapter may consume a local event with this stable shape:

```json
{
  "event": "pr_revision_checked",
  "repository": "owner/repo",
  "pull_request": 42,
  "head_sha": "abc123",
  "features": ["test_integrity", "impact_proof"],
  "duration_ms": 4200,
  "mutants_run": 12
}
```

An adapter must be explicitly enabled, must not include source or secrets, and must document its network destination and retention policy.
