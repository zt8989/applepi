// Placeholder for the TUI client (ticket 06: .scratch/shared-server-tui/
// issues/06-tui-shell-stream.md). `pnpm tui` will ensure the server and boot
// the Ink client; for now it only reports the state.
import { ensureServer } from '@applepi/server';

const { url } = await ensureServer();
console.log(`applepi server: ${url}`);
console.log('TUI 未实现 —— 见 .scratch/shared-server-tui/issues/06-tui-shell-stream.md（票 06）');