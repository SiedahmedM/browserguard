# BrowserGuard

BrowserGuard supervises a child process from launch to shutdown. It separates process creation from readiness, runs application-defined health checks, and puts deadlines around startup, consumer operations, and cleanup.

The useful part is what happens when those steps race: a probe hangs, startup is cancelled, the child exits during shutdown, or several callers close the same session. Those cases have explicit outcomes and fault-injection tests.

TypeScript, Node.js 24 or later, ESM, no runtime dependencies.

## Try it

Install the GitHub release package:

```sh
npm install https://github.com/SiedahmedM/browserguard/releases/download/v0.1.0/browserguard-0.1.0.tgz
```

No npm registry release has been published. To build and inspect the source instead:

```sh
git clone https://github.com/SiedahmedM/browserguard.git
cd browserguard
npm ci --ignore-scripts
npm run check
npm run example
npm pack
```

You can also install the locally built package with `npm install /path/to/browserguard-0.1.0.tgz`. TypeScript consumers should have Node.js types installed.

This example runs an ordinary Node child, so it works without an installed browser:

```js
import { BrowserSupervisor } from "browserguard";

const supervisor = new BrowserSupervisor({
  startupTimeoutMs: 5_000,
  shutdownTimeoutMs: 2_000,
  gracefulShutdownMs: 250,
});

const session = supervisor.launch({
  command: process.execPath,
  args: ["-e", "setInterval(() => {}, 1000)"],
});

try {
  await session.waitUntilHealthy();

  const result = await session.run(async ({ signal }) => {
    signal.throwIfAborted();
    return "ready for consumer-owned work";
  }, { timeoutMs: 1_000 });

  console.log(result);
} finally {
  await session.close();
}
```

`launch()` returns immediately. This keeps the session available for cancellation while startup is pending. Without a health callback, readiness means the OS emitted the child's spawn event.

For a browser, provide a probe that establishes readiness for that particular child. [The Chromium example](examples/chromium.mjs) uses an isolated temporary data directory and a local debugging endpoint. After building, run `node examples/chromium.mjs /absolute/path/to/chromium`. It does not navigate or use an existing browser profile.

## Lifecycle contract

A supervisor owns one child for one lifetime. Create another supervisor to launch another process.

| API | Meaning |
| --- | --- |
| `launch(options)` | Start an executable directly, with a separate argument array |
| `waitUntilHealthy()` | Wait for initial readiness; subsequent calls return the same promise |
| `state`, `lastError` | Inspect the current lifecycle and sanitized diagnostic |
| `run(work, options)` | Admit one consumer operation while healthy, with a deadline and signal |
| `close()` | Share one bounded shutdown attempt across all callers |
| `closed` | Always resolve with the final state, exit information, and any cleanup error |

Repeated failed probes change `healthy` to `unhealthy`. A passing probe restores health. Checks never overlap, and there is no automatic restart.

A probe timeout ends the session. Otherwise a callback that ignored cancellation could remain alive while replacement checks accumulate. Consumer-operation timeout or cancellation also ends the session. Ordinary operation exceptions become `OperationError` and leave the process running.

Pass an `AbortSignal` to `launch` to cancel the whole lifetime, or to `run` to cancel an operation and close its session. State changes are observable through `onStateChange`.

See [the API reference](docs/api.md) for options and errors, and [the architecture](docs/architecture.md) for transition and race semantics.

## What cleanup means

Shutdown sends `SIGTERM`, then `SIGKILL` after the grace period if exit has not been observed. The total shutdown deadline bounds the wait. A successful `close()` confirms the direct child exited, or that no child was created. An unconfirmed exit rejects with `CleanupError`; `closed` still resolves with `exited: false`.

Only the directly spawned process is signalled. Descendants can survive, especially after a forced termination. There is no process-name search, arbitrary PID adoption, or process-tree cleanup claim. Windows termination is abrupt even for `SIGTERM`; use an executable, not a `.cmd` or `.bat` wrapper.

JavaScript deadlines require a responsive event loop. A signal cannot forcibly stop an uncooperative callback, undo its side effects, or clean up after the supervisor host is killed. Consumer callbacks own their own I/O and must honor cancellation.

## Verification

`npm test` runs deterministic clock/child fault injection and real synthetic-process tests. `npm run coverage` reports implementation coverage. `npm run package:check` installs the tarball into a temporary consumer and checks imports, declarations, lifecycle behavior, and package contents.

CI runs linting, type checking, tests, builds, the example, and package checks on Linux, macOS, and Windows. [The release checklist](docs/release.md) records review requirements.

MIT licensed. Contributions should preserve the small process-supervision scope; see [CONTRIBUTING.md](CONTRIBUTING.md).
