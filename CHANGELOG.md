# Changelog

## 0.1.1

* Check monotonic deadlines before callback invocation and when accepting results. Late startup, health, and operation results can no longer bypass an expired timer waiting in Node's event loop.
* Count synchronous observer time against startup and shutdown budgets.
* Snapshot OS error codes before allowlisting, so a mutable property getter cannot substitute an unchecked value.
* Add deterministic regressions for delayed invocation, late settlement, delayed observers, and diagnostic getters.

## 0.1.0

Initial source release.

* Single-use child-process supervision with an explicit lifecycle.
* Serialized health probes, failure thresholds, and recovery transitions.
* Startup, health, operation, and shutdown deadlines.
* Cooperative cancellation and idempotent bounded shutdown.
* Fixed error messages with allowlisted diagnostic context.
* Deterministic race tests, real process fixtures, runnable examples, and package checks.
* No runtime dependencies.

Known boundaries: direct-child termination only; abrupt Windows termination; no forced cancellation of JavaScript callbacks; no npm registry release.
