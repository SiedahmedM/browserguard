# Security

Report vulnerabilities using [GitHub private vulnerability reporting](https://github.com/SiedahmedM/browserguard/security/advisories/new). Do not put credentials, private logs, or exploit details into a public issue. Include the affected version, platform, a minimal synthetic reproduction, and the expected ownership or cleanup invariant.

Only the latest source release is maintained. There is no promised response-time SLA.

## Trust boundary

BrowserGuard is a lifecycle utility, not a sandbox. Applications must trust the executable, arguments, environment, health callback, operation callback, and state observer they provide.

Commands are spawned without a shell. Arguments are passed separately. The library never accepts an existing PID, searches by process name, invokes taskkill, or signals a process group. Nevertheless, deliberately choosing a shell executable, an unsafe executable, or attacker-controlled command arguments remains unsafe.

The child inherits the parent environment unless an explicit replacement is supplied. Do not give it secrets it does not need. No command, argument, environment value, child output, raw callback error, or abort reason is emitted by library diagnostics. The embedding application remains responsible for its own logs and telemetry.

There are no runtime dependencies, network calls, browser credentials, stored sessions, remote endpoints, or global exception handlers in the implementation.

## Cleanup boundary

Successful close confirms direct-child exit, not descendant termination. A failed close reports unconfirmed cleanup. A host crash, forced host termination, blocked event loop, or non-cooperative callback can defeat in-process cleanup. Use OS-level containment when those cases must be covered.

Health probes define what healthy means. The library cannot establish that an arbitrary callback checked the right process or that a successful probe guarantees future availability.

See docs/architecture.md for deadline and platform semantics. Dependency audits, package-content checks, secret scans, and race tests are release requirements, not proofs that all defects have been eliminated.
