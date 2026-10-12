# Stage 4B implementation plan

Approved design: [Gateway-owned App Server connection](../specs/2026-10-13-app-server-ownership-design.md).

1. Add failing scoped-request cancellation and injected-owner tests. Record the baseline failures.
2. Add optional request/notification cancellation and narrow disposable consumer clients. Preserve the existing transport generation and privacy tests.
3. Extract the private-capability adapter; inject transport into router/plugin services, guard disposed/retired async results, and inject a separate preview filter and release callback.
4. Add the Gateway composition owner; wire production bootstrap, startup rollback and shutdown to it. Preserve the standalone compatibility constructor and diagnostic semantics.
5. Add owner integration tests: one transport, consumers isolated, Auto-off preview, retained privacy, construction/startup failure, cleanup exception, idempotent ordered shutdown. Run focused and full regressions; review all changed lifecycle paths.
6. Commit/push verified changes, validate five-platform CI, back up/update/restart the installed app, compare hashes and live health, then verify the browser without sending a message. Save delivery evidence outside the repository.

Execution is centralized because lifecycle changes are tightly coupled. Do not claim independent review from unavailable/unreadable agent reports. No extra dependencies or runtime migration.
