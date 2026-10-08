import {
  type BrowserGuardError, CancellationError, CleanupError, HealthCheckError, InvalidStateError,
  OperationError, StartupError, TimeoutError, UnexpectedExitError, systemContext,
} from '../errors.js';
import type {
  BrowserSession, CloseResult, LaunchOptions, LifecycleState, OperationOptions, SupervisorOptions,
} from '../types.js';
import { boundedTask, type BoundedTask } from './bounded-task.js';
import { deferred, duration, type ChildHandle, type Runtime } from './runtime.js';

export const transitions: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = Object.freeze({
  idle: ['starting', 'stopped'],
  starting: ['healthy', 'unhealthy', 'stopping', 'failed'],
  healthy: ['unhealthy', 'stopping', 'failed'],
  unhealthy: ['healthy', 'stopping', 'failed'],
  stopping: ['stopped', 'failed'],
  stopped: [],
  failed: [],
});

/** Internal seam for deterministic tests. Not exported by the package entrypoint. */
export class SupervisorCore implements BrowserSession {
  private current: LifecycleState = 'idle';
  private child: ChildHandle | undefined;
  private childId: number | undefined;
  private spawned = false;
  private exited = false;
  private finished = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private readonly lifetime = new AbortController();
  private readonly ready = deferred<void>();
  private readonly completion = deferred<CloseResult>();
  private closing: ReturnType<typeof deferred<void>> | undefined;
  private readonly timers = new Set<unknown>();
  private startupTimer: unknown;
  private healthCheck: LaunchOptions['healthCheck'];
  private probe: BoundedTask<boolean> | undefined;
  private operation: BoundedTask<unknown> | undefined;
  private initialReady = false;
  private failures = 0;
  private failure: BrowserGuardError | undefined;
  private healthError: HealthCheckError | undefined;
  private cleanupError: CleanupError | undefined;
  private launchSignal: AbortSignal | undefined;
  private readonly settings: Required<Omit<SupervisorOptions, 'onStateChange'>>;
  private observer: SupervisorOptions['onStateChange'];

  constructor(options: SupervisorOptions, private readonly runtime: Runtime) {
    const shutdownTimeoutMs = duration(options.shutdownTimeoutMs ?? 10_000, 'shutdownTimeoutMs');
    this.settings = {
      startupTimeoutMs: duration(options.startupTimeoutMs ?? 30_000, 'startupTimeoutMs'),
      healthCheckIntervalMs: duration(options.healthCheckIntervalMs ?? 5_000, 'healthCheckIntervalMs'),
      healthCheckTimeoutMs: duration(options.healthCheckTimeoutMs ?? 2_000, 'healthCheckTimeoutMs'),
      shutdownTimeoutMs,
      gracefulShutdownMs: duration(options.gracefulShutdownMs ?? Math.floor(shutdownTimeoutMs / 2), 'gracefulShutdownMs', true),
      operationTimeoutMs: duration(options.operationTimeoutMs ?? 30_000, 'operationTimeoutMs'),
      failureThreshold: duration(options.failureThreshold ?? 3, 'failureThreshold'),
    };
    if (this.settings.gracefulShutdownMs >= shutdownTimeoutMs) {
      throw new RangeError('gracefulShutdownMs must be less than shutdownTimeoutMs.');
    }
    if (options.onStateChange !== undefined && typeof options.onStateChange !== 'function') {
      throw new TypeError('onStateChange must be a function.');
    }
    this.observer = options.onStateChange;
  }

  get state(): LifecycleState { return this.current; }
  get pid(): number | undefined { return this.childId; }
  get signal(): AbortSignal { return this.lifetime.signal; }
  get lastError(): BrowserGuardError | undefined { return this.failure ?? this.healthError; }
  get closed(): Promise<CloseResult> { return this.completion.promise; }

  launch(options: LaunchOptions): BrowserSession {
    if (this.current !== 'idle') throw new InvalidStateError();
    validateLaunch(options);
    this.healthCheck = options.healthCheck;
    this.launchSignal = options.signal;
    this.transition('starting');
    // An observer may close the supervisor during the transition.
    if (!this.active()) return this;
    this.launchSignal?.addEventListener('abort', this.onCancellation, { once: true });
    if (this.launchSignal?.aborted) { this.onCancellation(); return this; }
    this.startupTimer = this.schedule(() => this.fail(new TimeoutError({
      phase: 'startup', timeoutMs: this.settings.startupTimeoutMs, ...this.pidContext(),
    })), this.settings.startupTimeoutMs);
    try {
      this.child = this.runtime.spawn(options);
      this.childId = this.child.pid;
      this.child.once('spawn', this.onSpawn);
      this.child.once('exit', this.onExit);
      this.child.on('error', this.onChildError);
    } catch (error) {
      this.fail(new StartupError({ phase: 'startup', ...systemContext(error) }));
    }
    return this;
  }

  waitUntilHealthy(): Promise<void> {
    return this.current === 'idle' ? observedRejection(new InvalidStateError()) : this.ready.promise;
  }

  run<T>(work: (context: { readonly signal: AbortSignal }) => Promise<T> | T, options: OperationOptions = {}): Promise<T> {
    if (this.current !== 'healthy' || this.operation) return observedRejection(new InvalidStateError());
    if (typeof work !== 'function') return observedRejection(new TypeError('operation must be a function.'));
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
      return observedRejection(new TypeError('signal must be an AbortSignal.'));
    }
    const timeoutMs = duration(options.timeoutMs ?? this.settings.operationTimeoutMs, 'timeoutMs');
    const context = { phase: 'operation' as const, ...this.pidContext() };
    const task = boundedTask(
      signal => work({ signal }), this.runtime.clock, timeoutMs,
      new TimeoutError({ ...context, timeoutMs }), error => new OperationError({ ...context, ...systemContext(error) }),
      options.signal ? { signal: options.signal, error: new CancellationError(context) } : undefined,
    );
    this.operation = task;
    const result = task.promise.then(value => {
      if (this.operation === task) this.operation = undefined;
      return value;
    }, (error: BrowserGuardError) => {
      if (this.operation === task) this.operation = undefined;
      if (error instanceof TimeoutError || error instanceof CancellationError) this.fail(error);
      throw error;
    });
    void result.catch(() => undefined);
    return result;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing.promise;
    this.closing = deferred<void>();
    if (this.finished) {
      if (this.cleanupError) this.closing.reject(this.cleanupError);
      else this.closing.resolve();
      return this.closing.promise;
    }
    const reason = this.failure ?? new CancellationError({ phase: this.initialReady ? 'shutdown' : 'startup', ...this.pidContext() });
    this.ready.reject(reason);
    if (this.current === 'idle') {
      this.release(reason);
      this.finish();
      return this.closing.promise;
    }
    this.transition('stopping');
    this.release(reason);
    if (!this.child || this.child.pid === undefined || this.hasExited()) {
      this.finish();
      return this.closing.promise;
    }
    // Install both deadlines before signalling: injected handles can exit inline.
    this.schedule(() => {
      this.cleanupError = new CleanupError({
        phase: 'shutdown', timeoutMs: this.settings.shutdownTimeoutMs, ...this.pidContext(),
      });
      this.failure ??= this.cleanupError;
      try { this.child?.unref(); } catch { /* Failure is reported by the result. */ }
      this.finish(false);
    }, this.settings.shutdownTimeoutMs);
    this.schedule(() => this.sendSignal('SIGKILL'), this.settings.gracefulShutdownMs);
    this.sendSignal('SIGTERM');
    return this.closing.promise;
  }

  private active(): boolean {
    return this.current === 'starting' || this.current === 'healthy' || this.current === 'unhealthy';
  }

  private readonly onCancellation = (): void => {
    this.fail(new CancellationError({ phase: this.initialReady ? 'operation' : 'startup', ...this.pidContext() }));
  };

  private readonly onSpawn = (): void => {
    this.spawned = true;
    if (!this.active()) return;
    if (this.healthCheck) this.checkHealth();
    else this.markHealthy();
  };

  private readonly onChildError = (error: unknown): void => {
    if (!this.active()) return;
    this.fail(this.spawned
      ? new UnexpectedExitError({ ...this.pidContext(), ...systemContext(error) })
      : new StartupError({ phase: 'startup', ...this.pidContext(), ...systemContext(error) }));
  };

  private readonly onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (this.finished) return;
    this.exited = true;
    this.exitCode = code;
    this.exitSignal = signal;
    if (this.current !== 'stopping') {
      this.failure = new UnexpectedExitError({ ...this.pidContext(), exitCode: code, signal });
    }
    this.finish();
  };

  private hasExited(): boolean {
    return this.exited || (this.child !== undefined && (this.child.exitCode !== null || this.child.signalCode !== null));
  }

  private pidContext(): { pid?: number } {
    return this.childId === undefined ? {} : { pid: this.childId };
  }

  private checkHealth(): void {
    const check = this.healthCheck;
    const pid = this.childId;
    if (!this.active() || this.probe || !check || pid === undefined) return;
    const context = { phase: 'health' as const, pid };
    const task = boundedTask(
      signal => check({ signal, pid }), this.runtime.clock, this.settings.healthCheckTimeoutMs,
      new TimeoutError({ ...context, timeoutMs: this.settings.healthCheckTimeoutMs }),
      error => new HealthCheckError({ ...context, ...systemContext(error) }),
    );
    this.probe = task;
    void task.promise.then(healthy => {
      if (this.probe !== task || !this.active()) return;
      this.probe = undefined;
      if (healthy === true) this.markHealthy();
      else this.noteHealthFailure(new HealthCheckError(context));
      this.scheduleNextProbe();
    }, (error: BrowserGuardError) => {
      if (this.probe !== task || !this.active()) return;
      this.probe = undefined;
      if (error instanceof TimeoutError) this.fail(error);
      else {
        this.noteHealthFailure(error as HealthCheckError);
        this.scheduleNextProbe();
      }
    });
  }

  private markHealthy(): void {
    if (!this.active()) return;
    this.failures = 0;
    this.healthError = undefined;
    this.initialReady = true;
    this.clearTimer(this.startupTimer);
    this.startupTimer = undefined;
    this.ready.resolve();
    this.transition('healthy');
  }

  private noteHealthFailure(error: HealthCheckError): void {
    this.healthError = error;
    this.failures = Math.min(this.settings.failureThreshold, this.failures + 1);
    if (this.failures >= this.settings.failureThreshold) this.transition('unhealthy');
  }

  private scheduleNextProbe(): void {
    if (this.active()) this.schedule(() => this.checkHealth(), this.settings.healthCheckIntervalMs);
  }

  private fail(error: BrowserGuardError): void {
    if (!this.active()) return;
    this.failure = error;
    this.ready.reject(error);
    void this.close();
  }

  private sendSignal(signal: 'SIGTERM' | 'SIGKILL'): void {
    if (this.finished || !this.child) return;
    if (this.hasExited()) { this.finish(); return; }
    // ChildProcess, never a PID lookup or a process-name search, owns the signal.
    try { this.child.kill(signal); } catch { /* Still escalate and await confirmed exit. */ }
  }

  private schedule(callback: () => void, milliseconds: number): unknown {
    const timer = this.runtime.clock.setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, milliseconds);
    this.timers.add(timer);
    return timer;
  }

  private clearTimer(timer: unknown): void {
    if (timer === undefined) return;
    this.runtime.clock.clearTimeout(timer);
    this.timers.delete(timer);
  }

  private release(reason: BrowserGuardError): void {
    for (const timer of this.timers) this.runtime.clock.clearTimeout(timer);
    this.timers.clear();
    this.startupTimer = undefined;
    this.launchSignal?.removeEventListener('abort', this.onCancellation);
    this.launchSignal = undefined;
    this.probe?.cancel(reason);
    this.probe = undefined;
    this.operation?.cancel(reason);
    this.operation = undefined;
    this.healthCheck = undefined;
    if (!this.lifetime.signal.aborted) this.lifetime.abort(reason);
  }

  private finish(confirmed = true): void {
    if (this.finished) return;
    this.finished = true;
    const reason = this.failure ?? new CancellationError({ phase: 'shutdown', ...this.pidContext() });
    this.ready.reject(reason);
    this.release(reason);
    if (this.child) {
      this.exitCode ??= this.child.exitCode;
      this.exitSignal ??= this.child.signalCode;
      this.child.off('spawn', this.onSpawn);
      this.child.off('exit', this.onExit);
      this.child.off('error', this.onChildError);
      this.child = undefined;
    }
    const state = (this.failure && !(this.failure instanceof CancellationError)) || this.cleanupError ? 'failed' : 'stopped';
    const result: CloseResult = Object.freeze({
      state, exited: confirmed, exitCode: this.exitCode, signal: this.exitSignal,
      ...(this.failure ? { error: this.failure } : {}),
      ...(this.cleanupError ? { cleanupError: this.cleanupError } : {}),
    });
    this.completion.resolve(result);
    if (this.cleanupError) this.closing?.reject(this.cleanupError);
    else this.closing?.resolve();
    this.transition(state);
    this.observer = undefined;
  }

  private transition(to: LifecycleState): void {
    if (to === this.current) return;
    if (!transitions[this.current].includes(to)) throw new Error('Invalid internal lifecycle transition.');
    const from = this.current;
    this.current = to;
    try {
      const value = this.observer?.(Object.freeze({ from, to }));
      void Promise.resolve(value).catch(() => undefined);
    } catch { /* Observability must not interrupt resource disposal. */ }
  }
}

function validateLaunch(options: LaunchOptions): void {
  const text = (value: unknown): value is string => typeof value === 'string' && !value.includes('\0');
  if (!options || !text(options.command) || options.command.length === 0
    || (options.args !== undefined && (!Array.isArray(options.args) || !options.args.every(text)))
    || (options.cwd !== undefined && !text(options.cwd))
    || (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    || (options.env !== undefined && (typeof options.env !== 'object' || options.env === null || Array.isArray(options.env)
      || Object.entries(options.env).some(([key, value]) => !text(key) || (value !== undefined && !text(value)))))
    || (options.healthCheck !== undefined && typeof options.healthCheck !== 'function')) {
    throw new TypeError('Invalid launch options.');
  }
}

function observedRejection<T>(error: Error): Promise<T> {
  const promise = Promise.reject<T>(error);
  void promise.catch(() => undefined);
  return promise;
}
