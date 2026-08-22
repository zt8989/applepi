import { Hono } from 'hono';
import { handleChatApprove } from './routes/approve.js';
import { handleChat } from './routes/chat.js';
import {
  handleConfigGeneralGet,
  handleConfigGeneralPut,
  handleConfigGet,
  handleConfigLastUsedLevelPost,
  handleConfigLastUsedPost,
  handleConfigModelsGet,
  handleConfigOpenFileGet,
  handleConfigOpenFilePost,
  handleConfigProvidersGet,
  handleConfigProvidersPut,
} from './routes/config.js';
import { handleFilesGet } from './routes/files.js';
import { handlePickFolderPost } from './routes/pick-folder.js';
import { handleSessionGet, handleSessionPatch } from './routes/session.js';
import type { ChatSeam } from './routes/seam.js';
import {
  handleWorkspacesGet,
  handleWorkspacesPatch,
  handleWorkspacesPost,
} from './routes/workspaces.js';

/**
 * The Hono app (ADR-0017) — every agent API route lives here; web/tui are
 * clients. `seam` is the request-level test entry (ADR-0017 §8): production
 * servers call createApp() with no seam.
 */
export function createApp(seam?: { chat?: ChatSeam }): Hono {
  const app = new Hono();
  app.get('/api/health', (c) => c.json({ ok: true, pid: process.pid }));
  app.get('/api/session', (c) => handleSessionGet(c.req.raw));
  app.patch('/api/session', (c) => handleSessionPatch(c.req.raw));
  app.get('/api/workspaces', () => handleWorkspacesGet());
  app.post('/api/workspaces', (c) => handleWorkspacesPost(c.req.raw));
  app.patch('/api/workspaces', (c) => handleWorkspacesPatch(c.req.raw));
  app.post('/api/chat', (c) => handleChat(c.req.raw, seam?.chat));
  app.post('/api/chat/approve', (c) => handleChatApprove(c.req.raw, seam?.chat));
  app.get('/api/files', (c) => handleFilesGet(c.req.raw));
  app.get('/api/config', () => handleConfigGet());
  app.get('/api/config/general', () => handleConfigGeneralGet());
  app.put('/api/config/general', (c) => handleConfigGeneralPut(c.req.raw));
  app.get('/api/config/providers', () => handleConfigProvidersGet());
  app.put('/api/config/providers', (c) => handleConfigProvidersPut(c.req.raw));
  app.get('/api/config/models', (c) => handleConfigModelsGet(c.req.raw));
  app.post('/api/config/last-used', (c) => handleConfigLastUsedPost(c.req.raw));
  app.post('/api/config/last-used-level', (c) => handleConfigLastUsedLevelPost(c.req.raw));
  app.get('/api/config/open-file', () => handleConfigOpenFileGet());
  app.post('/api/config/open-file', () => handleConfigOpenFilePost());
  app.post('/api/pick-folder', () => handlePickFolderPost());
  return app;
}