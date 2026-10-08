# Worklog

## 2026-10-07: investigation and scope

Completed a read-only reference review before implementation. Only generic process-management requirements were retained. No source, documentation, configuration, fixtures, or history is being imported. The detailed private assessment is kept outside this repository.

Scope: Node.js 24 LTS, TypeScript, no production dependencies, one owned child per single-use supervisor, explicit state machine, health probes, operation deadlines, cancellation, and bounded close. No browser interaction, automatic restart, credential persistence, or external services.

Decisions:

* Return the session immediately from launch, so shutdown is available during startup. Initial readiness is a separate promise.
* Schedule health checks after the preceding callback settles. A probe timeout terminates supervision instead of starting another callback that could overlap.
* Send signals only through the ChildProcess handle created by this instance. No PID adoption, process-name matching, shell execution, or system-wide cleanup.
* Limit each session to one consumer operation at a time. Deadline or cancellation ends the session and requests cleanup; callbacks must cooperate with AbortSignal to release their own resources.
* Keep errors to fixed messages and allowlisted diagnostics. Do not add command or environment fields to diagnostics, or retain raw callback errors and abort reasons.
* Use injected clocks and child handles internally for deterministic race tests, plus real synthetic child processes for platform checks.

Next: implement and test; document the state machine and limitations; review the package and Git history; run cross-platform CI before public release. npm publication is outside this task.

## Implementation and local checks

Implemented the state machine, direct-child adapter, bounded callback helper, errors, and public types. Strict TypeScript builds and ESLint pass. The first suite has 65 tests: 64 pass on Windows, and the real POSIX-only signal escalation test is skipped there. Deterministic escalation tests pass on every platform.

The synthetic example runs through readiness, a consumer operation, and confirmed close. The package check builds an 18-file tarball, installs it into a temporary consumer, checks ESM exports and TypeScript declarations, exercises process cleanup, and confirms there are no runtime dependencies. The initial dependency audit reports zero vulnerabilities.

Added API, architecture, security, contribution, license, changelog, and release documentation. CI uses pinned action revisions with read-only repository permissions. The secret scanner download is checksum-verified. Cross-platform CI and the final provenance/security review remain pending.

## Pre-push review

Expanded the suite to 74 tests. Windows passes 73 with the documented POSIX-only skip. Added invalid-input, late-result, observer reentrancy, sanitized error, and 1,001-probe resource-bound checks. A real installed Chrome also passed the isolated Chromium example, including readiness, shutdown, and temporary-directory removal.

Gitleaks 8.30.1 found no secrets in the staged project. A separate local review found no restricted project identifiers or local machine paths in tracked content, no broken documentation links, and no matching eight-line source/documentation blocks against the read-only reference. That comparison is supporting evidence; the scope and implementation were also reviewed directly.

The new GitHub repository was created privately. Next: commit the independent implementation, run the three-platform CI and full-history scan, then complete the public release review.
