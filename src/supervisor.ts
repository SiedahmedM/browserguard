import type { SupervisorOptions } from './types.js';
import { SupervisorCore } from './internal/supervisor-core.js';
import { nodeRuntime } from './internal/runtime.js';

/** One process, one lifetime. Create a new instance for a new launch. */
export class BrowserSupervisor extends SupervisorCore {
  constructor(options: SupervisorOptions = {}) { super(options, nodeRuntime); }
}
