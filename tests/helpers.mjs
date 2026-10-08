import { EventEmitter } from 'node:events';
import { SupervisorCore } from '../dist/internal/supervisor-core.js';

export async function flush() {
  for (let index = 0; index < 16; index++) await Promise.resolve();
}

export class ManualClock {
  now = 0;
  next = 0;
  timers = new Map();
  setTimeout = (callback, ms) => {
    const id = ++this.next;
    this.timers.set(id, { at: this.now + ms, callback });
    return id;
  };
  clearTimeout = id => { this.timers.delete(id); };
  async advance(ms) {
    const target = this.now + ms;
    for (;;) {
      await flush();
      const entry = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!entry || entry[1].at > target) break;
      this.now = entry[1].at;
      this.timers.delete(entry[0]);
      entry[1].callback();
    }
    this.now = target;
    await flush();
  }
}

export class FakeChild extends EventEmitter {
  pid = 12345;
  exitCode = null;
  signalCode = null;
  signals = [];
  unrefCalls = 0;
  onKill = signal => { this.exit(null, signal); return true; };
  kill(signal) { this.signals.push(signal); return this.onKill(signal); }
  unref() { this.unrefCalls++; }
  start() { this.emit('spawn'); }
  exit(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

export function harness(options = {}, spawnOverride) {
  const clock = new ManualClock();
  const child = new FakeChild();
  const events = [];
  let launches = 0;
  const supervisor = new SupervisorCore({
    startupTimeoutMs: 100, healthCheckIntervalMs: 10, healthCheckTimeoutMs: 20,
    failureThreshold: 2, gracefulShutdownMs: 10, shutdownTimeoutMs: 30, operationTimeoutMs: 20,
    onStateChange: event => events.push(event), ...options,
  }, { clock, spawn: input => { launches++; return spawnOverride ? spawnOverride(input, child) : child; } });
  return { supervisor, child, clock, events, get launches() { return launches; } };
}

export function controlled() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function assertReleased(assert, fixture) {
  assert.equal(fixture.clock.timers.size, 0, 'all timers are released');
  assert.equal(fixture.child.listenerCount('spawn'), 0);
  assert.equal(fixture.child.listenerCount('exit'), 0);
  assert.equal(fixture.child.listenerCount('error'), 0);
}
