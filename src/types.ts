import type { BrowserGuardError, CleanupError } from './errors.js';

export type LifecycleState = 'idle' | 'starting' | 'healthy' | 'unhealthy' | 'stopping' | 'stopped' | 'failed';
export interface StateTransition {
  readonly from: LifecycleState;
  readonly to: LifecycleState;
}
export interface SupervisorOptions {
  readonly startupTimeoutMs?: number;
  readonly healthCheckIntervalMs?: number;
  readonly healthCheckTimeoutMs?: number;
  readonly failureThreshold?: number;
  readonly shutdownTimeoutMs?: number;
  readonly gracefulShutdownMs?: number;
  readonly operationTimeoutMs?: number;
  readonly onStateChange?: (transition: StateTransition) => void;
}
export interface ProbeContext {
  readonly signal: AbortSignal;
  readonly pid: number;
}
export interface LaunchOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** Replaces the inherited environment when supplied. Never logged. */
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  /** Cancels the entire session, including after initial readiness. */
  readonly signal?: AbortSignal;
  readonly healthCheck?: (context: ProbeContext) => Promise<boolean> | boolean;
}
export interface OperationOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
export interface CloseResult {
  readonly state: 'stopped' | 'failed';
  readonly exited: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: BrowserGuardError;
  readonly cleanupError?: CleanupError;
}
export interface BrowserSession {
  readonly state: LifecycleState;
  readonly pid: number | undefined;
  readonly signal: AbortSignal;
  readonly lastError: BrowserGuardError | undefined;
  /** Always resolves, including when cleanup cannot be confirmed. */
  readonly closed: Promise<CloseResult>;
  /** Initial readiness only; does not wait for a later recovery. */
  waitUntilHealthy(): Promise<void>;
  run<T>(operation: (context: { readonly signal: AbortSignal }) => Promise<T> | T, options?: OperationOptions): Promise<T>;
  /** Concurrent calls share one attempt. Rejects only when cleanup is unconfirmed. */
  close(): Promise<void>;
}
