// `pnpm dev` (ADR-0017): build the server (build-first convention — dynamic
// import so the build really runs first), ensure the shared server is
// running, then start the web shell against it. The web app itself no longer
// owns a backend — it attaches like any other client.
import { spawn, spawnSync } from 'node:child_process';

const shell = process.platform === 'win32';
// shell:true routes args through cmd — pass one command string to avoid
// Node 24 DEP0190 (unescaped arg concatenation).
const build = spawnSync('pnpm --filter @applepi/server build', {
  stdio: 'inherit',
  shell,
});
if (build.status !== 0) process.exit(build.status ?? 1);

const { ensureServer, startHeartbeat } = await import('@applepi/server');
const { url } = await ensureServer();
console.log(`applepi server: ${url}`);
// Renew the server's idle lease while this web-shell process lives.
startHeartbeat(url);

const child = spawn('pnpm', ['--filter', '@applepi/web', 'dev'], {
  stdio: 'inherit',
  shell,
});
child.on('exit', (code) => process.exit(code ?? 0));