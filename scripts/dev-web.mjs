// `pnpm dev` (ADR-0017): build the server (build-first convention), ensure the
// shared server is running, then start the web shell against it. The web app
// itself no longer owns a backend — it attaches like any other client.
import { spawn, spawnSync } from 'node:child_process';
import { ensureServer } from '@applepi/server';

const shell = process.platform === 'win32';
const build = spawnSync('pnpm', ['--filter', '@applepi/server', 'build'], {
  stdio: 'inherit',
  shell,
});
if (build.status !== 0) process.exit(build.status ?? 1);

const { url } = await ensureServer();
console.log(`applepi server: ${url}`);

const child = spawn('pnpm', ['--filter', '@applepi/web', 'dev'], {
  stdio: 'inherit',
  shell,
});
child.on('exit', (code) => process.exit(code ?? 0));