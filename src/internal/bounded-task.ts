import type { BrowserGuardError } from '../errors.js';
import type { Clock } from './runtime.js';
import { deferred } from './runtime.js';

export interface BoundedTask<T> {
  readonly promise: Promise<T>;
  cancel(error: BrowserGuardError): void;
}

/** Bounds the wait, not JavaScript execution. Never invokes another callback. */
export function boundedTask<T>(
  work: (signal: AbortSignal) => T | Promise<T>,
  clock: Clock,
  timeoutMs: number,
  timeoutError: BrowserGuardError,
  mapError: (error: unknown) => BrowserGuardError,
  external?: { signal: AbortSignal; error: BrowserGuardError },
): BoundedTask<T> {
  const result = deferred<T>();
  const controller = new AbortController();
  let settled = false;
  const release = (): void => {
    clock.clearTimeout(timer);
    external?.signal.removeEventListener('abort', onAbort);
  };
  const cancel = (error: BrowserGuardError): void => {
    if (settled) return;
    settled = true;
    release();
    result.reject(error);
    controller.abort(error);
  };
  const onAbort = (): void => { if (external) cancel(external.error); };
  const timer = clock.setTimeout(() => cancel(timeoutError), timeoutMs);
  external?.signal.addEventListener('abort', onAbort, { once: true });
  if (external?.signal.aborted) onAbort();
  void Promise.resolve().then(() => {
    if (settled) return;
    return work(controller.signal);
  }).then(value => {
    if (settled) return;
    settled = true;
    release();
    result.resolve(value as T);
  }, error => {
    if (settled) return;
    settled = true;
    release();
    result.reject(mapError(error));
  });
  return { promise: result.promise, cancel };
}
