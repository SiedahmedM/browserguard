export type ErrorCode =
  | 'STARTUP_FAILED' | 'HEALTH_CHECK_FAILED' | 'TIMEOUT' | 'CANCELLED'
  | 'UNEXPECTED_EXIT' | 'CLEANUP_FAILED' | 'OPERATION_FAILED' | 'INVALID_STATE';

export interface ErrorContext {
  readonly phase?: 'startup' | 'health' | 'operation' | 'shutdown';
  readonly pid?: number;
  readonly timeoutMs?: number;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly systemCode?: string;
}

export class BrowserGuardError extends Error {
  readonly context: Readonly<ErrorContext>;
  constructor(readonly code: ErrorCode, message: string, context: ErrorContext = {}) {
    super(message);
    this.name = new.target.name;
    this.context = Object.freeze({ ...context });
  }
}
export class StartupError extends BrowserGuardError {
  constructor(context: ErrorContext = {}) { super('STARTUP_FAILED', 'The child process could not start.', context); }
}
export class HealthCheckError extends BrowserGuardError {
  constructor(context: ErrorContext = {}) { super('HEALTH_CHECK_FAILED', 'The health check did not pass.', context); }
}
export class TimeoutError extends BrowserGuardError {
  constructor(context: ErrorContext = {}) { super('TIMEOUT', 'The deadline expired.', context); }
}
export class CancellationError extends BrowserGuardError {
  constructor(context: ErrorContext = {}) { super('CANCELLED', 'The operation was cancelled.', context); }
}
export class UnexpectedExitError extends BrowserGuardError {
  constructor(context: ErrorContext = {}) { super('UNEXPECTED_EXIT', 'The child exited outside shutdown.', context); }
}
export class CleanupError extends BrowserGuardError {
  constructor(context: ErrorContext = {}) { super('CLEANUP_FAILED', 'Child exit could not be confirmed before the shutdown deadline.', context); }
}
export class OperationError extends BrowserGuardError {
  constructor(context: ErrorContext = {}) { super('OPERATION_FAILED', 'The consumer operation failed.', context); }
}
export class InvalidStateError extends BrowserGuardError {
  constructor() { super('INVALID_STATE', 'This operation is not allowed in the current state.'); }
}

const SYSTEM_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 'ESRCH', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET']);
export function systemContext(error: unknown): Pick<ErrorContext, 'systemCode'> {
  try {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = error.code;
      if (typeof code === 'string' && SYSTEM_CODES.has(code)) return { systemCode: code };
    }
  } catch { /* Even error property getters belong to the caller. */ }
  return {};
}
