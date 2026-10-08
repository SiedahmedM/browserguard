# Changelog

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
