# Implementation notes

The MVP and expansion remain intentionally useful without an LLM. They rely on Git’s normalized diff, a shared language registry, the TypeScript compiler API plus bounded Python/Go/Rust/C/C++ adapters, local coverage/test/mutation artifacts, existing test commands, OpenAPI/Swagger documents, and fixture/snapshot diffs. Each module emits structured evidence, explicit unknowns, and bounded findings so future integrations can add richer explanations without changing the verdict contract.
