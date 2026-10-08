# Contributing

Use Node.js 24 LTS and npm.

```sh
npm ci --ignore-scripts
npm run check
npm run coverage
npm run example
npm run package:check
```

Tests use node:test. Deterministic tests inject a manual clock and child handle; integration tests launch small Node fixtures. No accounts, browser downloads, external services, or credentials are needed. The real POSIX escalation test is skipped on Windows because its signal semantics differ; the injected escalation test runs everywhere.

For a lifecycle change, add a regression test showing the event ordering that failed. Assert the final state and disposal of timers/listeners. Prefer a controlled promise or fake-clock advance over sleeps. Use actual child fixtures for OS behavior that a fake cannot establish.

Keep runtime dependencies at zero unless there is a compelling reason. Preserve direct process ownership, bounded work, sanitized diagnostics, and a small public API. Changes to state semantics belong in docs/architecture.md and CHANGELOG.md.

Do not contribute code, fixtures, logs, credentials, or documentation you do not have permission to publish. Browser interaction, learned behavior, authentication persistence, vendor-specific recovery, and deployment infrastructure are outside this project's scope.

Open a pull request explaining the behavior change and the test that demonstrates it. Report security issues privately as described in SECURITY.md. Contributions are provided under the project's MIT license.
