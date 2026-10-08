import { BrowserSupervisor } from 'browserguard';

// This synthetic child needs no installed browser or external service.
const supervisor = new BrowserSupervisor({
  startupTimeoutMs: 5_000,
  shutdownTimeoutMs: 2_000,
  gracefulShutdownMs: 250,
  onStateChange: ({ from, to }) => console.log(from + ' -> ' + to),
});
const session = supervisor.launch({
  command: process.execPath,
  args: ['-e', 'setInterval(() => {}, 1000)'],
  // Without a probe, readiness means the operating system reported spawn.
});
try {
  await session.waitUntilHealthy();
  const result = await session.run(async ({ signal }) => {
    signal.throwIfAborted();
    return 'Consumer work completed.';
  }, { timeoutMs: 1_000 });
  console.log(result);
} finally {
  await session.close();
}
