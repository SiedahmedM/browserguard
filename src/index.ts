export { BrowserSupervisor } from './supervisor.js';
export { BrowserGuardError, StartupError, HealthCheckError, TimeoutError, CancellationError, UnexpectedExitError, CleanupError, OperationError, InvalidStateError } from './errors.js';
export type { ErrorCode, ErrorContext } from './errors.js';
export type { BrowserSession, SupervisorOptions, LaunchOptions, OperationOptions, LifecycleState, StateTransition, CloseResult, ProbeContext } from './types.js';
