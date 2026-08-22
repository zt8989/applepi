import { render } from 'ink';
import { ensureServer } from '@applepi/server';
import { App } from './app.js';

// ADR-0017 attach: probe → spawn → attach (first starter boots the server).
if (!process.stdin.isTTY) {
  // Ink needs raw mode for input; piped/non-interactive invocations degrade
  // to a clear message instead of a reconciler stack trace.
  console.log('applepi tui 需要交互式终端（raw mode）。请在真实终端运行 pnpm tui。');
  process.exit(0);
}
const { url } = await ensureServer();
render(<App serverUrl={url} cwd={process.cwd()} />);