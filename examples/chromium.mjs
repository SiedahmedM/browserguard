import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserSupervisor } from 'browserguard';

const command = process.argv[2];
if (!command) throw new Error('Usage: node examples/chromium.mjs /absolute/path/to/chromium');
const directory = await mkdtemp(join(tmpdir(), 'browserguard-chromium-'));
const supervisor = new BrowserSupervisor({
  healthCheckIntervalMs: 250,
  onStateChange: ({ from, to }) => console.log(from + ' -> ' + to),
});

try {
  const session = supervisor.launch({
    command,
    args: [
      '--headless', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0', '--user-data-dir=' + directory, 'about:blank',
    ],
    healthCheck: async ({ signal }) => {
      let activePort;
      try { activePort = await readFile(join(directory, 'DevToolsActivePort'), { encoding: 'utf8', signal }); }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      const port = Number(activePort.split('\n')[0]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
      const response = await fetch('http://127.0.0.1:' + port + '/json/version', { signal });
      if (!response.ok) return false;
      const version = await response.json();
      return typeof version.Browser === 'string' && typeof version.webSocketDebuggerUrl === 'string';
    },
  });
  await session.waitUntilHealthy();
  console.log('Browser readiness probe passed.');
  await session.run(({ signal }) => delay(250, undefined, { signal }));
} finally {
  // The profile is new, temporary, and never shared with an existing browser.
  // Remove it only after confirmed direct-child exit. Descendants are not owned.
  await supervisor.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
