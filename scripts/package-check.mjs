import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), 'browserguard-package-'));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this check with npm run package:check.');
function run(script, args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 60_000, shell: false, windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Subprocess failed.');
  return result.stdout;
}
try {
  const [packed] = JSON.parse(run(npmCli, ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], root));
  for (const file of packed.files) {
    assert.ok(file.path.startsWith('dist/') || ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'].includes(file.path), 'Unexpected package file: ' + file.path);
    assert.ok(!file.path.endsWith('.map'), 'Source maps are not needed in this package.');
  }
  const consumer = join(temporary, 'consumer'); await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run(npmCli, ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, packed.filename)], consumer);
  await writeFile(join(consumer, 'check.mjs'), `
    import assert from 'node:assert/strict';
    import { BrowserSupervisor } from 'browserguard';
    const session = new BrowserSupervisor().launch({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] });
    try { await session.waitUntilHealthy(); assert.equal(await session.run(() => 42), 42); }
    finally { await session.close(); }
    assert.equal((await session.closed).exited, true);
    await assert.rejects(import('browserguard/dist/internal/runtime.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  `);
  run(join(consumer, 'check.mjs'), [], consumer);
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  const quickStart = readme.match(/```js\r?\n([\s\S]*?)```/)?.[1];
  assert.ok(quickStart, 'README must contain a runnable JavaScript quick start.');
  await writeFile(join(consumer, 'readme-example.mjs'), quickStart);
  run(join(consumer, 'readme-example.mjs'), [], consumer);
  await writeFile(join(consumer, 'check.ts'), `
    import { BrowserSupervisor, type BrowserSession, type LifecycleState } from 'browserguard';
    const owner = new BrowserSupervisor({ failureThreshold: 3 });
    const session: BrowserSession = owner.launch({ command: 'synthetic', healthCheck: async ({ signal, pid }) => !signal.aborted && pid > 0 });
    const state: LifecycleState = session.state;
    const value: Promise<number> = session.run(async ({ signal }) => signal.aborted ? 0 : 1);
    void state; void value;
    // @ts-expect-error arguments are strings, not a shell command string
    owner.launch({ command: 'synthetic', args: 'shell command' });
    // @ts-expect-error lifecycle states are a closed union
    const invalid: LifecycleState = 'running';
    void invalid;
  `);
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true, types: ['node'], typeRoots: [join(root, 'node_modules', '@types')] },
    include: ['check.ts'],
  }));
  run(join(root, 'node_modules', 'typescript', 'bin', 'tsc'), ['-p', join(consumer, 'tsconfig.json')], consumer);
  const manifest = JSON.parse(await readFile(join(consumer, 'node_modules', 'browserguard', 'package.json'), 'utf8'));
  assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
  console.log('Package verified: ' + packed.files.length + ' files, ' + packed.size + ' compressed bytes; clean install, README example, ESM import, types, lifecycle, and export boundary passed.');
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
