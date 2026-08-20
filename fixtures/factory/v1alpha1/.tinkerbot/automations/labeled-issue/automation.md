---
enabled: true
agent: foreman
triggers:
  - provider: github
    event: issue_labeled
    filter:
      repos: [acme/payments-service]
      labels: [factory-ready]
---

Review the labeled issue and decide the next required stage. Preserve the issue's acceptance criteria and return unresolved product questions to a human.
