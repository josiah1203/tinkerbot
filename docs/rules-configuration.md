# Rule policy

The default policy is advisory. Findings remain visible in terminal, JSON, Markdown, SARIF, and GitHub output, but missing coverage, dynamic analysis, mutation timeouts, fork permissions, and unavailable base revisions do not fail a pull request.

Repositories can opt into blocking with `test_integrity.mode: blocking` and an explicit `impact.fail_on` rule. Keep blocking focused on protected authentication, authorization, validation, error, or public API paths; a surviving mutant is still review evidence rather than proof of a production defect.

The expanded policy packs provide explicit presets for strict, public API, security-sensitive, database, agent-authored, and monorepo changes. Baselines can suppress only previously recorded findings or narrow expiring waivers; they do not silently weaken new findings.
