# Assurance migration notes

Existing report schema v1, CLI aliases, local history, baselines, policies, GitHub Action, and local viewer remain compatible. Assurance data is optional and additive. Repositories do not need a change contract immediately; a missing `.tinkerbot/change-contract.yml` is reported as missing configuration, not compliance.

Receipt and assurance exports carry explicit schema versions, stable IDs, provenance, privacy classification, freshness, authority tier, and unknown/partial states. Older reports can be exported into an assurance bundle with missing sections left absent or UNKNOWN. No source migration is required. Hosted ingestion should be introduced only after organization/repository authorization, retention, deletion, and provider validation are configured.
