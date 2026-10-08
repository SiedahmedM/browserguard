import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [mode, directory, ...extra] = process.argv.slice(2);
if (mode === 'exit-now') process.exit(7);
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
if (mode === 'graceful') process.on('SIGTERM', () => {
  writeFileSync(join(directory, 'terminated'), 'graceful');
  process.exit(0);
});
writeFileSync(join(directory, 'arguments.json'), JSON.stringify(extra));
writeFileSync(join(directory, 'ready'), String(process.pid));
setInterval(() => {
  if (existsSync(join(directory, 'crash'))) process.exit(9);
}, 10);
