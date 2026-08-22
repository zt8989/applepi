import { serve } from '@hono/node-server';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.js';
import { DEFAULT_PORT, serverPort } from './config.js';
import { appendServerLog } from './log.js';

export { DEFAULT_PORT, serverPort } from './config.js';
export { createApp } from './app.js';
export { serverLogPath, appendServerLog } from './log.js';
export { ensureServer, probeHealth, serverUrl, spawnServer } from './attach.js';

export interface RunningServer {
  port: number;
  close: () => Promise<void>;
}

/**
 * Boot the shared runtime server on 127.0.0.1:port. Resolves once listening;
 * appends a lifecycle line to the server log. SIGINT exits immediately
 * (ADR-0017 lifecycle). Port 0 picks a free port (tests).
 */
export async function startServer(port: number = serverPort()): Promise<RunningServer> {
  const app = createApp();
  const server = serve(
    { fetch: app.fetch, hostname: '127.0.0.1', port },
    async (info) => {
      await appendServerLog(`listening 127.0.0.1:${info.port} pid=${process.pid} (${new Date().toISOString()})`);
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', (e) => reject(e));
  });
  process.on('SIGINT', () => {
    void server.close(() => process.exit(0));
  });
  const actual = server.address();
  const bound = typeof actual === 'object' && actual ? actual.port : port;
  return { port: bound, close: () => new Promise<void>((res) => server.close(() => res())) };
}

// Direct-run entry: `node dist/index.js` (pnpm serve). Imports as a library
// (tests, web shell, tui) do not boot anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((e) => {
    console.error(`server failed to start: ${e?.message ?? String(e)}`);
    process.exit(1);
  });
}