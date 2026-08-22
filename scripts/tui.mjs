// Placeholder for the TUI client (ticket 06: .scratch/shared-server-tui/
// issues/06-tui-shell-stream.md). `pnpm tui` will boot the Ink client; it
// follows the same build-first + ensure-server flow as the web shell.
import { spawnSync } from 'node:child_process';

const shell = process.platform === 'win32';
// shell:true routes args through cmd — pass one command string to avoid
// Node 24 DEP0190 (unescaped arg concatenation).
const build = spawnSync('pnpm --filter @applepi/server build', {
  stdio: 'inherit',
  shell,
});
if (build.status !== 0) process.exit(build.status ?? 1);

const { ensureServer } = await import('@applepi/server');
const { url } = await ensureServer();
console.log(`applepi server: ${url}`);
console.log('TUI 未实现 —— 见 .scratch/shared-server-tui/issues/06-tui-shell-stream.md（票 06）');