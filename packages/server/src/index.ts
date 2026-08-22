import { serve } from '@hono/node-server';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.js';
import { DEFAULT_PORT, serverPort } from './config.js';
import { createIdleGuard, idleTimeoutFromEnv } from './idle-guard.js';
import { appendServerLog } from './log.js';

export { DEFAULT_PORT, serverPort } from './config.js';
export { createApp } from './app.js';
export { serverLogPath, appendServerLog } from './log.js';
export { createIdleGuard, idleTimeoutFromEnv } from './idle-guard.js';
export { ensureServer, probeHealth, serverUrl, spawnServer, startHeartbeat } from './attach.js';
// The canonical level vocabulary, re-exported so clients (TUI command mapping)
// do not re-declare the domain's permission levels.
export { PERMISSION_LEVELS } from '@applepi/core';
export {
  sessionsRoot,
  unslugWorkspace,
  workspaceToSlug,
  getSessionModel,
  getProviders,
  getGeneralDefaults,
  saveGeneralDefaults,
  saveProviders,
  listModels,
  saveLastUsed,
  saveLastUsedLevel,
  sessionReasoningLevel,
  configFileHidden,
  openConfigFile,
  getHarness,
  sessionMode,
  buildSystemPrompt,
  bindSession,
  buildTurnMessages,
  entryPath,
  entryName,
  readManifest,
  sessionTitle,
  sessionPinned,
  sessionNotify,
  listWorkspaces,
  addWorkspace,
  renameWorkspace,
  removeWorkspace,
  applySessionAction,
  readSessionFile,
  pickFolder,
  type ManifestEntry,
  type SessionInfo,
  type WorkspaceInfo,
  type SessionActionRequest,
} from './server.js';
export { handleSessionGet, handleSessionPatch } from './routes/session.js';
export {
  handleWorkspacesGet,
  handleWorkspacesPatch,
  handleWorkspacesPost,
} from './routes/workspaces.js';
export { handleChat } from './routes/chat.js';
export { handleChatApprove } from './routes/approve.js';
export type { ChatSeam } from './routes/seam.js';
export { handleFilesGet } from './routes/files.js';
export {
  handleConfigGet,
  handleConfigGeneralGet,
  handleConfigGeneralPut,
  handleConfigProvidersGet,
  handleConfigProvidersPut,
  handleConfigModelsGet,
  handleConfigLastUsedPost,
  handleConfigLastUsedLevelPost,
  handleConfigOpenFileGet,
  handleConfigOpenFilePost,
} from './routes/config.js';
export { handlePickFolderPost } from './routes/pick-folder.js';

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
  const idle = createIdleGuard({ timeoutMs: idleTimeoutFromEnv() });
  const app = createApp({ refresh: idle.refresh });
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