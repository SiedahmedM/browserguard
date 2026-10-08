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

## Cross-platform verification and release decision

[CI run 37727697739](https://github.com/SiedahmedM/browserguard/actions/runs/37727697739) passed all jobs. Linux and macOS each pass all 74 tests, including a real child that ignores SIGTERM and requires escalation. Windows passes 73 with the one documented POSIX-only skip. Every platform passes lint, type checking, builds, the synthetic example, and package installation/type checks. The dependency/secret job passes.

The root commit is 12587b5a9888e3d8df0565f4da67bb4a9ce48dad with no parents. Git has no object alternates or shallow boundary, and its only remote is this project's repository. Author metadata uses the maintainer's GitHub noreply address.

Final scope review: 578 production TypeScript lines, zero runtime dependencies, and none of the excluded browser/agent/persistence capabilities. GO for public source publication with the documented cleanup and platform limits. Added a package test that extracts and executes the README quick start to prevent example drift. The GitHub release will include the buildable source and an installable tarball; no npm registry publication is requested.

## Public release and deadline follow-up

Published the repository and 0.1.0 GitHub release after the private CI passed. Verified anonymous README access, MIT license detection, enabled private vulnerability reporting, and successful installation/execution from the public release tarball. npm remains unpublished.

Final review identified a callback ordering gap: a callback could finish after its budget while an expired Node timer had not run yet. Added monotonic deadline checks before callback invocation, on callback settlement, and before declaring startup healthy. Startup and shutdown also count time spent in observers against their budgets. These checks reject late results; they still cannot interrupt a blocked event loop. Eight deterministic regressions cover delayed invocation, late success, late rejection, health timeout, startup readiness, late spawn, and delayed observers. Preparing a patch release without changing the original public tag.

The diagnostic review also found that reading an error-code getter repeatedly could validate one value and return a different one. The sanitizer now snapshots the property once before allowlisting it, with a regression proving a changing getter cannot inject an unchecked diagnostic value. Patch verification now covers 83 tests.

## Final patch verification

[CI run 37728728856](https://github.com/SiedahmedM/browserguard/actions/runs/37728728856) passed all four jobs for the 0.1.1 implementation. Linux and macOS pass all 83 tests; Windows passes 82 and skips only real POSIX signal escalation. Measured implementation coverage is 99.43% of lines and at least 94.88% of branches. Package checks execute the README quick start against the installed tarball on all three platforms.

The package remains 18 files with zero runtime dependencies; the production implementation is 601 TypeScript lines. Full-history Gitleaks and npm audit remain clean. The local identifier, link, and reference-block comparison passed again. No unresolved implementation or publication blockers remain. GO for 0.1.1 source release; retain the original 0.1.0 tag, publish the corrected package as 0.1.1, and keep npm registry publication separate.
