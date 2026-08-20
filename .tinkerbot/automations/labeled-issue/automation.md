---
enabled: true
agent: foreman
triggers:
  - provider: github
    event: issue_labeled
    filter:
      repos: [josiah1203/tinkerbot]
      labels: [factory-ready]
---

Review the labeled issue and decide the next required stage. Preserve acceptance criteria. Return unresolved product questions to a human. Never merge. Never rewrite a tb check verdict.
