// `pnpm tui` (ADR-0017): build the shared server + the TUI (build-first), ensure
// the server is running, then boot the Ink client against it.
import { spawn, spawnSync } from 'node:child_process';

const shell = process.platform === 'win32';
const cmd = (c) => spawnSync(c, { stdio: 'inherit', shell });
const build1 = cmd('pnpm --filter @applepi/server build');
const build2 = cmd('pnpm --filter @applepi/tui build');
if (build1.status !== 0) process.exit(build1.status ?? 1);
if (build2.status !== 0) process.exit(build2.status ?? 1);

const { ensureServer } = await import('@applepi/server');
const { url } = await ensureServer();
console.log(`applepi server: ${url}`);

const child = spawn(process.execPath, ['apps/tui/dist/index.js'], {
  stdio: 'inherit',
  shell: false,
});
child.on('exit', (code) => process.exit(code ?? 0));