import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { BrowserSupervisor, CancellationError, CleanupError, HealthCheckError, InvalidStateError, OperationError, StartupError, TimeoutError, UnexpectedExitError } from '../dist/index.js';
import { transitions } from '../dist/internal/supervisor-core.js';
import { harness, controlled, flush, assertReleased } from './helpers.mjs';

test('launch returns a session immediately and close reaps the owned child', async () => {
  const h = harness();
  assert.equal(h.supervisor.state, 'idle');
  const session = h.supervisor.launch({ command: 'synthetic', healthCheck: () => true });
  assert.equal(session, h.supervisor);
  assert.equal(session.state, 'starting');
  h.child.start();
  await session.waitUntilHealthy();
  assert.equal(session.state, 'healthy');
  await session.close();
  assert.equal(session.state, 'stopped');
  assert.deepEqual(h.child.signals, ['SIGTERM']);
  assert.deepEqual(h.events.map(x => x.to), ['starting', 'healthy', 'stopping', 'stopped']);
  assert.equal((await session.closed).exited, true);
  assertReleased(assert, h);
});

test('without a health callback, spawn is the readiness criterion', async () => {
  const h = harness();
  h.supervisor.launch({ command: 'synthetic' });
  assert.equal(h.supervisor.state, 'starting');
  h.child.start();
  await h.supervisor.waitUntilHealthy();
  assert.equal(h.clock.timers.size, 0);
  await h.supervisor.close();
});

test('immediate exit rejects readiness and does not signal a dead child', async () => {
  const h = harness();
  h.supervisor.launch({ command: 'synthetic', healthCheck: () => new Promise(() => {}) });
  h.child.start();
  h.child.exit(7);
  await assert.rejects(h.supervisor.waitUntilHealthy(), UnexpectedExitError);
  assert.equal(h.supervisor.state, 'failed');
  assert.equal((await h.supervisor.closed).exitCode, 7);
  await h.supervisor.close();
  assert.deepEqual(h.child.signals, []);
  assertReleased(assert, h);
});

test('a crash aborts an active operation with an unexpected-exit error', async () => {
  const h = harness();
  h.supervisor.launch({ command: 'synthetic' }); h.child.start();
  let signal;
  const work = h.supervisor.run(context => { signal = context.signal; return new Promise(() => {}); });
  await flush();
  h.child.exit(9);
  await assert.rejects(work, UnexpectedExitError);
  assert.equal(signal.aborted, true);
  assert.equal(h.supervisor.lastError.context.exitCode, 9);
  assert.equal(h.supervisor.state, 'failed');
  assertReleased(assert, h);
});

test('zero exit code is still unexpected outside shutdown', async () => {
  const h = harness(); h.supervisor.launch({ command: 'synthetic' }); h.child.start();
  h.child.exit(0);
  assert.equal((await h.supervisor.closed).error.code, 'UNEXPECTED_EXIT');
});

test('synchronous spawn failure is sanitized and cleanup completes', async () => {
  const h = harness({}, () => { throw Object.assign(new Error('private command and token'), { code: 'ENOENT' }); });
  h.supervisor.launch({ command: 'private-command', args: ['secret'], env: { TOKEN: 'secret' } });
  await assert.rejects(h.supervisor.waitUntilHealthy(), error => error instanceof StartupError && error.context.systemCode === 'ENOENT');
  assert.equal(h.supervisor.state, 'failed');
  assert.doesNotMatch(JSON.stringify(await h.supervisor.closed), /private|secret|TOKEN/);
  await h.supervisor.close();
  assertReleased(assert, h);
});

test('asynchronous spawn error without a PID releases everything', async () => {
  const h = harness(); h.child.pid = undefined;
  h.supervisor.launch({ command: 'synthetic' });
  h.child.emit('error', Object.assign(new Error('private path'), { code: 'EACCES' }));
  await assert.rejects(h.supervisor.waitUntilHealthy(), StartupError);
  assert.deepEqual(h.child.signals, []);
  assertReleased(assert, h);
});

test('startup deadline includes waiting for the spawn event', async () => {
  const h = harness();
  h.supervisor.launch({ command: 'synthetic' });
  await h.clock.advance(100);
  await assert.rejects(h.supervisor.waitUntilHealthy(), error => error instanceof TimeoutError && error.context.phase === 'startup');
  assert.equal(h.supervisor.state, 'failed');
  assert.deepEqual(h.child.signals, ['SIGTERM']);
  assertReleased(assert, h);
});

test('repeated startup health failures cannot extend the startup deadline', async () => {
  const h = harness();
  h.supervisor.launch({ command: 'synthetic', healthCheck: () => false }); h.child.start();
  await h.clock.advance(99);
  assert.equal(h.supervisor.state, 'unhealthy');
  await h.clock.advance(1);
  await assert.rejects(h.supervisor.waitUntilHealthy(), TimeoutError);
  assertReleased(assert, h);
});

test('hanging health probe times out, aborts, and never overlaps a replacement', async () => {
  const h = harness(); let calls = 0; let signal;
  const late = controlled();
  h.supervisor.launch({ command: 'synthetic', healthCheck: context => { calls++; signal = context.signal; return late.promise; } });
  h.child.start();
  await h.clock.advance(20);
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
  await assert.rejects(h.supervisor.waitUntilHealthy(), error => error instanceof TimeoutError && error.context.phase === 'health');
  late.resolve(true);
  await h.clock.advance(1_000);
  assert.equal(calls, 1);
  assert.equal(h.supervisor.state, 'failed');
  assertReleased(assert, h);
});

test('health thresholds and recovery produce observable transitions', async () => {
  const h = harness(); const answers = [true, false, false, true];
  h.supervisor.launch({ command: 'synthetic', healthCheck: () => answers.shift() ?? true }); h.child.start();
  await h.supervisor.waitUntilHealthy();
  await h.clock.advance(10);
  assert.equal(h.supervisor.state, 'healthy');
  assert.ok(h.supervisor.lastError instanceof HealthCheckError);
  await h.clock.advance(10);
  assert.equal(h.supervisor.state, 'unhealthy');
  await h.clock.advance(10);
  assert.equal(h.supervisor.state, 'healthy');
  assert.equal(h.supervisor.lastError, undefined);
  assert.deepEqual(h.events.map(x => x.to), ['starting', 'healthy', 'unhealthy', 'healthy']);
  await h.supervisor.close();
  assertReleased(assert, h);
});

test('successful health checks reset the consecutive-failure counter', async () => {
  const h = harness(); const answers = [true, false, true, false, true];
  h.supervisor.launch({ command: 'synthetic', healthCheck: () => answers.shift() ?? true }); h.child.start();
  await h.clock.advance(40);
  assert.equal(h.events.some(x => x.to === 'unhealthy'), false);
  await h.supervisor.close();
});

test('rejected probes are ordinary failures and discard sensitive error text', async () => {
  const h = harness({ failureThreshold: 1 }); let failing = true;
  h.supervisor.launch({ command: 'synthetic', healthCheck: () => {
    if (failing) throw Object.assign(new Error('sensitive body'), { code: 'ECONNREFUSED' });
    return true;
  } }); h.child.start(); await flush();
  assert.equal(h.supervisor.state, 'unhealthy');
  assert.equal(h.supervisor.lastError.context.systemCode, 'ECONNREFUSED');
  assert.doesNotMatch(h.supervisor.lastError.stack, /sensitive body/);
  failing = false; await h.clock.advance(10);
  await h.supervisor.waitUntilHealthy();
  await h.supervisor.close();
});

test('health callbacks are serialized, with the interval measured after settlement', async () => {
  const h = harness({ healthCheckTimeoutMs: 80 }); const first = controlled(); let calls = 0;
  h.supervisor.launch({ command: 'synthetic', healthCheck: () => ++calls === 1 ? first.promise : true }); h.child.start();
  await h.clock.advance(50);
  assert.equal(calls, 1);
  first.resolve(true); await flush();
  await h.clock.advance(9); assert.equal(calls, 1);
  await h.clock.advance(1); assert.equal(calls, 2);
  await h.supervisor.close();
});

test('initial readiness remains the same fulfilled promise during later ill health', async () => {
  const h = harness({ failureThreshold: 1 }); let healthy = true;
  h.supervisor.launch({ command: 'synthetic', healthCheck: () => healthy }); h.child.start();
  const ready = h.supervisor.waitUntilHealthy(); await ready;
  healthy = false; await h.clock.advance(10);
  assert.equal(h.supervisor.state, 'unhealthy');
  assert.equal(h.supervisor.waitUntilHealthy(), ready);
  await ready;
  await h.supervisor.close();
});

test('concurrent shutdown callers share the same attempt', async () => {
  const h = harness(); h.child.onKill = () => true;
  h.supervisor.launch({ command: 'synthetic' }); h.child.start();
  const closes = Array.from({ length: 100 }, () => h.supervisor.close());
  assert.ok(closes.every(p => p === closes[0]));
  assert.deepEqual(h.child.signals, ['SIGTERM']);
  h.child.exit(0); await Promise.all(closes);
  assert.equal(h.supervisor.close(), closes[0]);
  assertReleased(assert, h);
});

test('shutdown during startup rejects readiness and prevents late health work', async () => {
  const h = harness(); let calls = 0;
  h.supervisor.launch({ command: 'synthetic', healthCheck: () => { calls++; return true; } });
  await h.supervisor.close();
  h.child.start();
  await assert.rejects(h.supervisor.waitUntilHealthy(), CancellationError);
  assert.equal(calls, 0);
  assert.equal(h.supervisor.state, 'stopped');
  assertReleased(assert, h);
});

test('shutdown during a health callback aborts it and ignores late rejection', async () => {
  const h = harness(); const late = controlled(); let signal;
  h.supervisor.launch({ command: 'synthetic', healthCheck: context => { signal = context.signal; return late.promise; } });
  h.child.start(); await flush();
  await h.supervisor.close();
  assert.equal(signal.aborted, true);
  late.reject(new Error('late private failure')); await flush();
  assert.equal(h.supervisor.state, 'stopped');
  assertReleased(assert, h);
});

test('pre-aborted launch never spawns a child or exposes the abort reason', async () => {
  const h = harness(); const controller = new AbortController(); controller.abort('private abort reason');
  h.supervisor.launch({ command: 'synthetic', signal: controller.signal });
  await assert.rejects(h.supervisor.waitUntilHealthy(), CancellationError);
  assert.equal(h.launches, 0);
  assert.equal(h.supervisor.state, 'stopped');
  assert.doesNotMatch(JSON.stringify(await h.supervisor.closed), /private abort reason/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assertReleased(assert, h);
});

test('cancellation during startup initiates cleanup immediately', async () => {
  const h = harness(); const controller = new AbortController();
  h.supervisor.launch({ command: 'synthetic', signal: controller.signal });
  controller.abort(new Error('private reason'));
  await assert.rejects(h.supervisor.waitUntilHealthy(), CancellationError);
  assert.equal((await h.supervisor.closed).state, 'stopped');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assertReleased(assert, h);
});

test('lifetime cancellation during a later health check aborts and closes', async () => {
  const h = harness(); const controller = new AbortController(); let calls = 0; let signal;
  h.supervisor.launch({ command: 'synthetic', signal: controller.signal, healthCheck: context => {
    if (++calls === 1) return true;
    signal = context.signal; return new Promise(() => {});
  } }); h.child.start(); await h.supervisor.waitUntilHealthy();
  await h.clock.advance(10); controller.abort();
  assert.equal(signal.aborted, true);
  assert.equal((await h.supervisor.closed).state, 'stopped');
  assertReleased(assert, h);
});

test('failed graceful termination escalates once, within the total close deadline', async () => {
  const h = harness();
  h.child.onKill = signal => { if (signal === 'SIGKILL') h.child.exit(null, signal); return true; };
  h.supervisor.launch({ command: 'synthetic' }); h.child.start();
  const close = h.supervisor.close();
  await h.clock.advance(9); assert.deepEqual(h.child.signals, ['SIGTERM']);
  await h.clock.advance(1); await close;
  assert.deepEqual(h.child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal((await h.supervisor.closed).signal, 'SIGKILL');
  assertReleased(assert, h);
});

test('zero grace permits immediate forced escalation', async () => {
  const h = harness({ gracefulShutdownMs: 0 }); h.child.onKill = () => true;
  h.supervisor.launch({ command: 'synthetic' }); h.child.start(); h.supervisor.close();
  await h.clock.advance(0); assert.deepEqual(h.child.signals, ['SIGTERM', 'SIGKILL']);
  h.child.exit(); await h.supervisor.closed;
});

test('exit during shutdown cancels escalation and is not reported as a crash', async () => {
  const h = harness(); h.child.onKill = () => true;
  h.supervisor.launch({ command: 'synthetic' }); h.child.start();
  const close = h.supervisor.close(); await h.clock.advance(4); h.child.exit(0); await close;
  await h.clock.advance(100);
  assert.deepEqual(h.child.signals, ['SIGTERM']);
  assert.equal((await h.supervisor.closed).error, undefined);
  assertReleased(assert, h);
});

test('unconfirmed cleanup rejects close but resolves closed with diagnostics', async () => {
  const h = harness(); h.child.onKill = () => false;
  h.supervisor.launch({ command: 'synthetic' }); h.child.start();
  const close = h.supervisor.close(); await h.clock.advance(30);
  await assert.rejects(close, CleanupError);
  const outcome = await h.supervisor.closed;
  assert.equal(outcome.exited, false);
  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.cleanupError.context.pid, h.child.pid);
  assert.equal(h.child.unrefCalls, 1);
  assert.equal(h.supervisor.close(), close);
  assertReleased(assert, h);
});

test('kill exceptions do not bypass escalation or produce raw diagnostics', async () => {
  const h = harness(); h.child.onKill = () => { throw new Error('private command'); };
  h.supervisor.launch({ command: 'synthetic' }); h.child.start();
  const close = h.supervisor.close(); await h.clock.advance(30);
  await assert.rejects(close, CleanupError);
  assert.deepEqual(h.child.signals, ['SIGTERM', 'SIGKILL']);
  assert.doesNotMatch(JSON.stringify(await h.supervisor.closed), /private command/);
  assertReleased(assert, h);
});

test('startup and cleanup errors are both preserved', async () => {
  const h = harness(); h.child.onKill = () => false;
  h.supervisor.launch({ command: 'synthetic' });
  await h.clock.advance(130);
  await assert.rejects(h.supervisor.waitUntilHealthy(), TimeoutError);
  const result = await h.supervisor.closed;
  assert.equal(result.error.code, 'TIMEOUT');
  assert.equal(result.cleanupError.code, 'CLEANUP_FAILED');
  assertReleased(assert, h);
});

test('a child already marked exited is never signalled', async () => {
  const h = harness(); h.supervisor.launch({ command: 'synthetic' }); h.child.start();
  h.child.exitCode = 0;
  await h.supervisor.close();
  assert.deepEqual(h.child.signals, []);
  assertReleased(assert, h);
});

test('idle close is idempotent and prevents a later launch', async () => {
  const h = harness(); const close = h.supervisor.close(); await close;
  assert.equal(h.supervisor.close(), close);
  assert.equal(h.supervisor.state, 'stopped');
  assert.throws(() => h.supervisor.launch({ command: 'synthetic' }), InvalidStateError);
  assert.equal(h.launches, 0);
});

test('a supervisor cannot launch a second process', async () => {
  const h = harness(); h.supervisor.launch({ command: 'synthetic' });
  assert.throws(() => h.supervisor.launch({ command: 'another' }), InvalidStateError);
  await h.supervisor.close();
  assert.throws(() => h.supervisor.launch({ command: 'another' }), InvalidStateError);
  assert.equal(h.launches, 1);
});

test('observer failure cannot interrupt startup or cleanup', async () => {
  const h = harness({ onStateChange: () => { throw new Error('observer failed'); } });
  h.supervisor.launch({ command: 'synthetic' }); h.child.start();
  await h.supervisor.waitUntilHealthy(); await h.supervisor.close();
  assertReleased(assert, h);
});

test('observer can close synchronously during starting without spawning', async () => {
  let supervisor;
  const h = harness({ onStateChange: event => { if (event.to === 'starting') supervisor.close(); } });
  supervisor = h.supervisor; supervisor.launch({ command: 'synthetic' });
  assert.equal(h.launches, 0);
  assert.equal(supervisor.state, 'stopped');
  assertReleased(assert, h);
});

test('observer can close synchronously when a health result becomes healthy', async () => {
  let supervisor;
  const h = harness({ onStateChange: event => { if (event.to === 'healthy') supervisor.close(); } });
  supervisor = h.supervisor; supervisor.launch({ command: 'synthetic', healthCheck: () => true }); h.child.start();
  await supervisor.closed;
  assert.equal(supervisor.state, 'stopped'); assertReleased(assert, h);
});

test('operation runs with a cooperative signal and releases its deadline', async () => {
  const h = harness(); h.supervisor.launch({ command: 'synthetic' }); h.child.start();
  assert.equal(await h.supervisor.run(({ signal }) => { assert.equal(signal.aborted, false); return 42; }), 42);
  assert.equal(h.clock.timers.size, 0);
  await h.supervisor.close();
});

test('only one consumer operation can run at a time', async () => {
  const h = harness(); const first = controlled(); h.supervisor.launch({ command: 'synthetic' }); h.child.start();
  const pending = h.supervisor.run(() => first.promise);
  await assert.rejects(h.supervisor.run(() => 'second'), InvalidStateError);
  first.resolve('first'); assert.equal(await pending, 'first');
  assert.equal(await h.supervisor.run(() => 'third'), 'third');
  await h.supervisor.close();
});

test('operations are rejected before readiness, while unhealthy, and after close', async () => {
  const h = harness({ failureThreshold: 1 });
  await assert.rejects(h.supervisor.run(() => true), InvalidStateError);
  h.supervisor.launch({ command: 'synthetic', healthCheck: () => false });
  await assert.rejects(h.supervisor.run(() => true), InvalidStateError);
  h.child.start(); await flush();
  await assert.rejects(h.supervisor.run(() => true), InvalidStateError);
  await h.supervisor.close();
  await assert.rejects(h.supervisor.run(() => true), InvalidStateError);
});

test('operation deadline aborts the callback, fails the session, and triggers cleanup', async () => {
  const h = harness(); let signal; const late = controlled();
  h.supervisor.launch({ command: 'synthetic' }); h.child.start();
  const work = h.supervisor.run(context => { signal = context.signal; return late.promise; });
  await h.clock.advance(20);
  await assert.rejects(work, error => error instanceof TimeoutError && error.context.phase === 'operation');
  assert.equal(signal.aborted, true);
  assert.equal(h.supervisor.state, 'failed');
  late.reject(new Error('late operation error')); await flush();
  assertReleased(assert, h);
});

test('operation cancellation closes the session and detaches the external signal', async () => {
  const h = harness(); const controller = new AbortController();
  h.supervisor.launch({ command: 'synthetic' }); h.child.start();
  const work = h.supervisor.run(() => new Promise(() => {}), { signal: controller.signal });
  await flush(); controller.abort('private reason');
  await assert.rejects(work, CancellationError);
  assert.equal((await h.supervisor.closed).state, 'stopped');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assertReleased(assert, h);
});

test('pre-aborted operation never invokes user code', async () => {
  const h = harness(); const controller = new AbortController(); controller.abort(); let calls = 0;
  h.supervisor.launch({ command: 'synthetic' }); h.child.start();
  await assert.rejects(h.supervisor.run(() => { calls++; }, { signal: controller.signal }), CancellationError);
  assert.equal(calls, 0); assert.equal(h.supervisor.state, 'stopped'); assertReleased(assert, h);
});

test('operation exceptions are sanitized without making a live child fail', async () => {
  const h = harness(); h.supervisor.launch({ command: 'synthetic' }); h.child.start();
  await assert.rejects(h.supervisor.run(() => { throw new Error('private text'); }), error => error instanceof OperationError && !error.stack.includes('private text'));
  assert.equal(h.supervisor.state, 'healthy');
  await h.supervisor.close();
});

test('manual close aborts an active consumer operation', async () => {
  const h = harness(); h.supervisor.launch({ command: 'synthetic' }); h.child.start();
  let signal; const work = h.supervisor.run(context => { signal = context.signal; return new Promise(() => {}); });
  await flush(); await h.supervisor.close(); await assert.rejects(work, CancellationError);
  assert.equal(signal.aborted, true); assertReleased(assert, h);
});

test('successful operations detach caller abort listeners', async () => {
  const h = harness(); const controller = new AbortController();
  h.supervisor.launch({ command: 'synthetic' }); h.child.start();
  assert.equal(await h.supervisor.run(() => 1, { signal: controller.signal }), 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort(); assert.equal(h.supervisor.state, 'healthy'); await h.supervisor.close();
});

test('unknown system codes and hostile error getters are not exposed', async () => {
  for (const error of [{ code: 'secret-token', message: 'secret' }, { get code() { throw new Error('secret'); } }]) {
    const h = harness({}, () => { throw error; }); h.supervisor.launch({ command: 'synthetic' });
    await assert.rejects(h.supervisor.waitUntilHealthy(), StartupError);
    assert.equal(h.supervisor.lastError.context.systemCode, undefined);
    assert.doesNotMatch(JSON.stringify(await h.supervisor.closed), /secret/);
  }
});

test('background failures and async observer rejections never become unhandled', async () => {
  const unhandled = []; const listener = error => unhandled.push(error);
  process.on('unhandledRejection', listener);
  try {
    const h = harness({ onStateChange: async () => { throw new Error('observer'); } });
    h.child.onKill = () => false;
    const late = controlled();
    h.supervisor.launch({ command: 'synthetic', healthCheck: () => late.promise }); h.child.start();
    await h.clock.advance(100);
    late.reject(new Error('late'));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(unhandled, []);
    assertReleased(assert, h);
  } finally { process.off('unhandledRejection', listener); }
});

test('state transitions stay valid through adversarial event orderings', async () => {
  const sequences = [
    ['start', 'abort', 'exit', 'settle'], ['close', 'start', 'settle', 'exit'],
    ['start', 'settle', 'exit', 'close'], ['start', 'timeout', 'settle', 'exit'],
    ['start', 'settle', 'abort', 'close'], ['exit', 'start', 'abort', 'settle'],
    ['start', 'close', 'timeout', 'settle'], ['abort', 'exit', 'close', 'start'],
  ];
  for (const sequence of sequences) {
    const h = harness(); const pending = controlled(); const controller = new AbortController();
    h.supervisor.launch({ command: 'synthetic', signal: controller.signal, healthCheck: () => pending.promise });
    for (const event of sequence) {
      if (event === 'start') h.child.start();
      if (event === 'abort') controller.abort();
      if (event === 'exit') h.child.exit(3);
      if (event === 'settle') pending.resolve(true);
      if (event === 'close') h.supervisor.close();
      if (event === 'timeout') await h.clock.advance(100);
      await flush();
    }
    await h.supervisor.close();
    for (const event of h.events) assert.ok(transitions[event.from].includes(event.to), sequence.join(','));
    assertReleased(assert, h);
  }
});

for (const name of ['startupTimeoutMs', 'healthCheckIntervalMs', 'healthCheckTimeoutMs', 'failureThreshold', 'shutdownTimeoutMs', 'operationTimeoutMs']) {
  test(name + ' rejects invalid timer values', () => {
    for (const value of [0, -1, 1.5, NaN, Infinity, 2_147_483_648]) assert.throws(() => new BrowserSupervisor({ [name]: value }), RangeError);
  });
}

test('grace period must fit inside the total close deadline', () => {
  assert.throws(() => new BrowserSupervisor({ shutdownTimeoutMs: 10, gracefulShutdownMs: 10 }), RangeError);
  assert.throws(() => new BrowserSupervisor({ gracefulShutdownMs: -1 }), RangeError);
});

test('launch rejects invalid arguments before allocating resources', () => {
  for (const input of [{ command: '' }, { command: 'x\0y' }, { command: 'x', args: ['a\0b'] }, { command: 'x', args: 'shell text' }, { command: 'x', cwd: 42 }, { command: 'x', healthCheck: 42 }, { command: 'x', signal: {} }, { command: 'x', env: null }, { command: 'x', env: { VALUE: 42 } }, { command: 'x', env: { VALUE: 'a\0b' } }]) {
    const h = harness(); assert.throws(() => h.supervisor.launch(input), TypeError);
    assert.equal(h.supervisor.state, 'idle'); assert.equal(h.launches, 0); assertReleased(assert, h);
  }
});

test('waiting for readiness before launch fails instead of leaving an idle waiter', async () => {
  const h = harness();
  await assert.rejects(h.supervisor.waitUntilHealthy(), InvalidStateError);
  assert.equal(h.clock.timers.size, 0);
  await h.supervisor.close();
});

test('invalid operation options and observers allocate no resources', async () => {
  assert.throws(() => new BrowserSupervisor({ onStateChange: 42 }), TypeError);
  const h = harness(); h.supervisor.launch({ command: 'synthetic' }); h.child.start();
  await assert.rejects(h.supervisor.run(null), TypeError);
  await assert.rejects(h.supervisor.run(() => 1, { signal: {} }), TypeError);
  assert.throws(() => h.supervisor.run(() => 1, { timeoutMs: Infinity }), RangeError);
  assert.equal(h.clock.timers.size, 0);
  assert.equal(await h.supervisor.run(() => 'still usable'), 'still usable');
  await h.supervisor.close();
});

test('closing before the operation microtask prevents invocation', async () => {
  const h = harness(); let calls = 0;
  h.supervisor.launch({ command: 'synthetic' }); h.child.start();
  const work = h.supervisor.run(() => { calls++; });
  await h.supervisor.close(); await assert.rejects(work, CancellationError);
  assert.equal(calls, 0); assertReleased(assert, h);
});

test('late operation success cannot turn cancellation into success', async () => {
  const h = harness(); const late = controlled();
  h.supervisor.launch({ command: 'synthetic' }); h.child.start();
  const work = h.supervisor.run(() => late.promise); await flush();
  await h.supervisor.close(); late.resolve('late result');
  await assert.rejects(work, CancellationError);
  assert.equal(h.supervisor.state, 'stopped'); assertReleased(assert, h);
});

test('a process error after spawn begins cleanup and is sanitized', async () => {
  const h = harness(); h.supervisor.launch({ command: 'synthetic' }); h.child.start();
  h.child.emit('error', Object.assign(new Error('private data'), { code: 'EACCES' }));
  assert.equal((await h.supervisor.closed).state, 'failed');
  assert.equal(h.supervisor.lastError.context.systemCode, 'EACCES');
  assert.doesNotMatch(JSON.stringify(h.supervisor.lastError), /private data/);
  assertReleased(assert, h);
});

test('an error during termination does not prevent confirmed exit', async () => {
  const h = harness();
  h.child.onKill = () => { h.child.emit('error', new Error('signal delivery')); h.child.exit(0); return false; };
  h.supervisor.launch({ command: 'synthetic' }); h.child.start();
  await h.supervisor.close(); assert.equal((await h.supervisor.closed).exited, true);
  assertReleased(assert, h);
});

test('health success at the startup deadline follows event ordering', async () => {
  const h = harness({ healthCheckTimeoutMs: 200 }); const pending = controlled();
  h.supervisor.launch({ command: 'synthetic', healthCheck: () => pending.promise }); h.child.start();
  await h.clock.advance(99); pending.resolve(true); await flush(); await h.clock.advance(1);
  assert.equal(h.supervisor.state, 'healthy'); await h.supervisor.waitUntilHealthy();
  await h.supervisor.close(); assertReleased(assert, h);
});

test('one thousand successful probes retain only the next timer and fixed child listeners', async () => {
  const h = harness(); let calls = 0;
  h.supervisor.launch({ command: 'synthetic', healthCheck: () => { calls++; return true; } }); h.child.start();
  await h.supervisor.waitUntilHealthy(); await h.clock.advance(10_000);
  assert.equal(calls, 1_001);
  assert.equal(h.clock.timers.size, 1);
  assert.equal(h.child.listenerCount('spawn'), 0);
  assert.equal(h.child.listenerCount('exit'), 1);
  assert.equal(h.child.listenerCount('error'), 1);
  await h.supervisor.close(); assertReleased(assert, h);
});

test('diagnostic context and final results cannot be mutated', async () => {
  const h = harness(); h.supervisor.launch({ command: 'synthetic' }); h.child.exit(2);
  const result = await h.supervisor.closed;
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.error.context), true);
  assert.throws(() => { result.error.context.exitCode = 0; }, TypeError);
});
