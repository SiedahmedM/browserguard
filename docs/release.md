# Release review

## Scope and provenance

This is a fresh implementation of generic process-management behavior using public Node APIs. No source files, private documentation, production fixtures, configuration, or commit history were imported.

The pre-implementation review classified ordinary process ownership, cancellation, timers, health checks, and bounded cleanup as safe. Vendor-specific lifecycle recovery and containment were excluded because they require assumptions this library does not own.

Intentionally excluded: agent planning and orchestration, semantic element verification, learned routes and replay, stale-element recovery, credentials, authentication persistence, session transfer, model integrations, business data, production endpoints, and deployment architecture.

The public design adds no navigation or agent decision-making capability. Its reusable contribution is a small process state machine and the tests around failure ordering. That boundary is an engineering assessment, not a claim about legal ownership beyond the contributed code.

## Checklist

Before publishing a release:

* Inspect the public API and transition table for scope growth.
* Pass lint, strict type checking, deterministic tests, and real-process tests.
* Pass Linux, macOS, and Windows CI; explain platform-specific skips.
* Build and install the npm tarball in a clean consumer; verify ESM imports and declarations.
* Run the synthetic example and check the documented commands.
* Audit dependencies and scan all Git history for secrets.
* Review tracked files, package contents, comments, author metadata, and URLs.
* Confirm the Git history is fresh and contains no imported private history.
* Verify the cleanup claims still distinguish direct-child exit from process-tree containment.
* Record review results in WORKLOG.md.
* Obtain maintainer approval for any npm publication. GitHub source publication does not publish a registry package.

## 0.1.0 assessment

GO for public source release with the documented direct-child cleanup boundary. No unresolved release blockers were found. npm registry publication remains a separate decision.

The implementation is 578 TypeScript lines across seven files, with zero runtime dependencies. [The initial complete CI run](https://github.com/SiedahmedM/browserguard/actions/runs/37727697739) passed linting, type checking, coverage tests, the synthetic example, and package checks on all three platforms:

| Check | Result |
| --- | --- |
| Linux / Node 24 | 74 tests passed, including real SIGTERM escalation |
| macOS / Node 24 | 74 tests passed, including real SIGTERM escalation |
| Windows / Node 24 | 73 passed; one real POSIX-only test skipped; deterministic escalation passed |
| Local Chrome example | Readiness, direct-child shutdown, and temporary-directory removal passed |
| Package consumer | Clean tarball install, ESM API, TypeScript declarations, and lifecycle checks passed |
| Dependencies | npm audit reported zero vulnerabilities |
| Secrets | Gitleaks 8.30.1 reported no findings in staged content or complete Git history |
| Provenance | Fresh root commit, no imported parent history, no object alternates or private remote |
| Content review | No restricted identifiers, private endpoints, local machine paths, or copied source/documentation blocks found |

The public package excludes tests, development tooling, and work logs. A scope review found only ordinary process supervision, with all excluded features listed above still absent. Remaining limitations are deliberate: no process-tree containment, no forced JavaScript cancellation, and no cleanup guarantee after host termination. This is an implementation and release review, not an external security certification.

## Recreating the repository

Start in an empty directory with independently authored project files. Do not fork or add a private reference repository as a remote.

```sh
git init -b main
git add .
git commit -m "Implement process supervision and failure tests"
gh repo create SiedahmedM/browserguard --private --source . --remote origin --push
```

That repository name is intended for the project owner; contributors should use their own namespace. Run CI and the release checks while private. Only after explicit publication authorization:

```sh
gh repo edit SiedahmedM/browserguard --visibility public --accept-visibility-change-consequences
```

Keep npm publication separate. The package can be built and installed locally without a registry release.
