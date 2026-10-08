import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BrowserSupervisor, CancellationError, StartupError, TimeoutError, UnexpectedExitError } from '../dist/index.js';

const script = fileURLToPath(new URL('./fixtures/child.mjs', import.meta.url));

async function fixture(t, mode = 'graceful', settings = {}, extra = []) {
  const directory = await mkdtemp(join(tmpdir(), 'browserguard-test-'));
  const supervisor = new BrowserSupervisor({
    startupTimeoutMs: 5_000, healthCheckTimeoutMs: 1_000, healthCheckIntervalMs: 10,
    shutdownTimeoutMs: 2_000, gracefulShutdownMs: 150, ...settings,
  });
  t.after(async () => {
    await supervisor.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const healthCheck = async ({ pid }) => {
    try { return await readFile(join(directory, 'ready'), 'utf8') === String(pid); }
    catch { return false; }
  };
  return { directory, supervisor, options: { command: process.execPath, args: [script, mode, directory, ...extra], healthCheck } };
}

test('real child reaches readiness and exits before close returns', async t => {
  const { supervisor, options, directory } = await fixture(t);
  const session = supervisor.launch(options);
  await session.waitUntilHealthy();
  assert.ok(session.pid > 0);
  await session.close();
  const result = await session.closed;
  assert.equal(result.exited, true);
  assert.equal(result.state, 'stopped');
  assert.throws(() => process.kill(session.pid, 0), { code: 'ESRCH' });
  if (process.platform !== 'win32') assert.equal(await readFile(join(directory, 'terminated'), 'utf8'), 'graceful');
});

test('real child exiting immediately is detected during startup', async t => {
  const { supervisor, options } = await fixture(t, 'exit-now');
  const session = supervisor.launch(options);
  await assert.rejects(session.waitUntilHealthy(), UnexpectedExitError);
  assert.equal((await session.closed).exitCode, 7);
});

test('real child crashes after readiness and aborts consumer work', async t => {
  const { supervisor, options, directory } = await fixture(t);
  const session = supervisor.launch(options); await session.waitUntilHealthy();
  const operation = session.run(() => new Promise(() => {}));
  await writeFile(join(directory, 'crash'), 'now');
  await assert.rejects(operation, UnexpectedExitError);
  assert.equal((await session.closed).exitCode, 9);
});

test('real spawn failure omits the command and its arguments from the error', async () => {
  const supervisor = new BrowserSupervisor();
  const session = supervisor.launch({ command: 'browserguard-nonexistent-executable', args: ['private-argument'], env: { PRIVATE_VALUE: 'private-environment' } });
  await assert.rejects(session.waitUntilHealthy(), StartupError);
  assert.doesNotMatch(JSON.stringify(await session.closed), /nonexistent|private|PRIVATE_VALUE/);
  assert.equal(session.lastError.context.systemCode, 'ENOENT');
  await session.close();
});

test('real startup deadline cleans up a child that never becomes healthy', async t => {
  const { supervisor, options } = await fixture(t, 'graceful', { startupTimeoutMs: 250 });
  const session = supervisor.launch({ ...options, healthCheck: () => false });
  await assert.rejects(session.waitUntilHealthy(), error => error instanceof TimeoutError && error.context.phase === 'startup');
  assert.equal((await session.closed).exited, true);
});

test('real hung probe is bounded and does not leave the child alive', async t => {
  const { supervisor, options } = await fixture(t, 'graceful', { healthCheckTimeoutMs: 50 });
  let signal;
  const session = supervisor.launch({ ...options, healthCheck: context => { signal = context.signal; return new Promise(() => {}); } });
  await assert.rejects(session.waitUntilHealthy(), TimeoutError);
  assert.equal(signal.aborted, true);
  assert.equal((await session.closed).exited, true);
});

test('real cancellation while startup is pending releases the lifetime listener', async t => {
  const { supervisor, options } = await fixture(t); const controller = new AbortController();
  const session = supervisor.launch({ ...options, signal: controller.signal, healthCheck: () => false });
  controller.abort();
  await assert.rejects(session.waitUntilHealthy(), CancellationError);
  assert.equal((await session.closed).exited, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('real POSIX child that ignores SIGTERM is killed after grace expires', { skip: process.platform === 'win32' ? 'Windows signals are unconditional termination.' : false }, async t => {
  const { supervisor, options } = await fixture(t, 'ignore-term');
  const session = supervisor.launch(options); await session.waitUntilHealthy();
  await session.close();
  assert.equal((await session.closed).signal, 'SIGKILL');
});

test('closing one owned child does not terminate another supervisor child', async t => {
  const first = await fixture(t); const second = await fixture(t);
  const a = first.supervisor.launch(first.options); const b = second.supervisor.launch(second.options);
  await Promise.all([a.waitUntilHealthy(), b.waitUntilHealthy()]);
  assert.notEqual(a.pid, b.pid);
  await a.close();
  assert.doesNotThrow(() => process.kill(b.pid, 0));
  assert.equal(b.state, 'healthy');
  await b.close();
});

test('command arguments containing shell metacharacters remain literal', async t => {
  const args = ['space separated', '; echo never', '& echo never', '$(echo never)', '| echo never', '"quoted"'];
  const { supervisor, options, directory } = await fixture(t, 'graceful', {}, args);
  const session = supervisor.launch(options); await session.waitUntilHealthy();
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'arguments.json'), 'utf8')), args);
  await session.close();
});

test('library installation does not register global process listeners', async t => {
  const names = ['SIGINT', 'SIGTERM', 'exit', 'uncaughtException', 'unhandledRejection'];
  const before = names.map(name => process.listenerCount(name));
  const { supervisor, options } = await fixture(t);
  supervisor.launch(options); await supervisor.waitUntilHealthy(); await supervisor.close();
  assert.deepEqual(names.map(name => process.listenerCount(name)), before);
});

test('repeated real launch/close cycles do not retain child process handles', async t => {
  const baseline = process.getActiveResourcesInfo().filter(name => name === 'ProcessWrap').length;
  for (let iteration = 0; iteration < 8; iteration++) {
    const { supervisor, options } = await fixture(t);
    supervisor.launch(options); await supervisor.waitUntilHealthy(); await supervisor.close();
  }
  // Native close notifications follow exit notifications in the event loop.
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(process.getActiveResourcesInfo().filter(name => name === 'ProcessWrap').length, baseline);
});
