# API reference

## BrowserSupervisor

`new BrowserSupervisor(options?)` creates an idle, single-use supervisor. It creates no process, timer, or global signal handler until launch. Calling `close()` while idle makes it permanently stopped.

| Option | Default | Meaning |
| --- | --- | --- |
| `startupTimeoutMs` | 30000 | Launch through first successful readiness check |
| `healthCheckIntervalMs` | 5000 | Delay after a completed check before the next check |
| `healthCheckTimeoutMs` | 2000 | Maximum wait for one callback |
| `failureThreshold` | 3 | Consecutive false results or exceptions before unhealthy |
| `shutdownTimeoutMs` | 10000 | Total wait from close request to confirmed exit |
| `gracefulShutdownMs` | Half the shutdown timeout | Delay before forced termination |
| `operationTimeoutMs` | 30000 | Default deadline for one consumer operation |
| `onStateChange` | None | Callback receiving a frozen `{ from, to }` snapshot |

Durations and thresholds must be positive integers within Node's timer range, at most 2147483647. The grace period can be zero and must be less than the shutdown timeout. Invalid configuration throws `RangeError` or `TypeError`.

The observer runs synchronously after a state update. It may call `close()`. Its exceptions and rejected return promises are contained; the supervisor does not wait for it or use it to decide health. Keep observers fast.

## launch

`launch({ command, args?, cwd?, env?, signal?, healthCheck? }): BrowserSession`

The executable and arguments are separate. Shell execution is disabled. Child input, output, and error streams are ignored rather than buffered. Use an absolute executable path when PATH lookup is inappropriate. The launch signal applies for the entire lifetime, not only startup.

Omitting `env` inherits the host environment. Supplying `env` replaces it. The library neither logs nor returns it, but the launched program naturally receives that environment. Executables, arguments, callbacks, and environment configuration must come from trusted application code.

`healthCheck({ signal, pid })` may return a boolean or a promise of one. Only literal `true` passes. A throw, rejection, or other result is a failed check. The callback owns probe-specific I/O and must connect the supplied signal to cancellable APIs. Verify the child you launched; probing an unrelated service can give false readiness.

A pre-aborted signal prevents spawning. Spawn failures are reported by initial readiness and `closed`, so callers retain a session they can close. A second launch throws `InvalidStateError`.

## Session

`state` is one of idle, starting, healthy, unhealthy, stopping, stopped, or failed. `pid` is the spawned child's PID if assigned; it remains diagnostic information after exit. `signal` aborts when the lifetime ends. Do not use the PID later to kill or adopt a process.

`waitUntilHealthy()` returns the initial readiness promise. It rejects on startup failure, cancellation, or early exit. Once fulfilled, it stays fulfilled even if health later degrades. It is not a lock or a guarantee that the process will remain alive. Calling it before launch rejects with `InvalidStateError`.

`run(work, { timeoutMs?, signal? }?)` admits one callback at a time while healthy and supplies `{ signal }`. A completed callback releases its deadline and caller abort listener. Its return value is passed through. Exceptions are converted into sanitized `OperationError` instances. No raw cause is retained.

An operation timeout or cancellation initiates session cleanup. A crash rejects active work with `UnexpectedExitError`. An ordinary failed health check does not cancel an already running operation, though unhealthy sessions refuse new operations. The caller can close in a state observer if it needs a stricter policy.

`close()` is idempotent: all callers receive the same promise, including after a failed cleanup. It resolves after confirmed direct-child exit and rejects only if exit remains unconfirmed at the total deadline. It never waits for a user callback to cooperate before signalling the child.

`closed` always resolves:

```ts
interface CloseResult {
  state: "stopped" | "failed";
  exited: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: BrowserGuardError;
  cleanupError?: CleanupError;
}
```

Here `exited: true` also covers a launch that created no child. Cancellation normally ends in stopped; startup errors, unexpected exit, timeouts, and cleanup failure end in failed. If a startup failure is followed by a cleanup failure, both errors are available.

## Errors

All operational errors extend `BrowserGuardError`. Its `code` is a stable string and `context` is frozen. Diagnostics may contain a phase, PID, timeout, exit code, signal, and an allowlisted OS error code. Commands, arguments, environment values, callback error messages, and arbitrary abort reasons are discarded.

| Class | Code |
| --- | --- |
| StartupError | STARTUP_FAILED |
| HealthCheckError | HEALTH_CHECK_FAILED |
| TimeoutError | TIMEOUT |
| CancellationError | CANCELLED |
| UnexpectedExitError | UNEXPECTED_EXIT |
| CleanupError | CLEANUP_FAILED |
| OperationError | OPERATION_FAILED |
| InvalidStateError | INVALID_STATE |

A health failure is available through `lastError` until a successful probe. A terminal failure takes precedence. Await your operations and close promises even though internal rejection handlers prevent abandoned background work from generating unhandled rejections.
