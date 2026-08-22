import { Hono } from 'hono';
import { handleChatApprove } from './routes/approve.js';
import { handleChat } from './routes/chat.js';
import { handleSessionGet, handleSessionPatch } from './routes/session.js';
import type { ChatSeam } from './routes/seam.js';
import {
  handleWorkspacesGet,
  handleWorkspacesPatch,
  handleWorkspacesPost,
} from './routes/workspaces.js';

/**
 * The Hono app (ADR-0017). Agent API routes migrate in tickets 02–04.
 * Session-scoped harness state lives on the app's module scope — one server,
 * one harness cache. `seam` is the request-level test entry (ADR-0017 §8):
 * production servers call createApp() with no seam.
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
  return app;
}