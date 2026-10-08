import { spawn, type ChildProcess } from 'node:child_process';
import type { LaunchOptions } from '../types.js';

export interface Clock {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(timer: unknown): void;
}
export type ChildHandle = Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'on' | 'once' | 'off' | 'kill' | 'unref'>;
export interface Runtime {
  readonly clock: Clock;
  spawn(options: LaunchOptions): ChildHandle;
}
export const nodeRuntime: Runtime = {
  clock: {
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimeout: timer => clearTimeout(timer as NodeJS.Timeout),
  },
  spawn(options) {
    const child = spawn(options.command, [...(options.args ?? [])], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: { ...options.env } }),
      shell: false,
      windowsHide: true,
      detached: false,
      stdio: 'ignore',
    });
    // A failed kill can report an error after a bounded close has returned.
    // This guard holds no supervisor state and disappears on the native close.
    const ignoreError = (): void => {};
    child.on('error', ignoreError);
    child.once('close', () => child.off('error', ignoreError));
    return child;
  },
};

export function duration(value: number, name: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > 2_147_483_647) {
    throw new RangeError(name + ' must be an integer within the Node timer range.');
  }
  return value;
}

export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Internal promises may settle before a caller asks for them.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
