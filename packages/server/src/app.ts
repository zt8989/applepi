import { Hono } from 'hono';
import { handleSessionGet, handleSessionPatch } from './routes/session.js';
import {
  handleWorkspacesGet,
  handleWorkspacesPatch,
  handleWorkspacesPost,
} from './routes/workspaces.js';

/**
 * The Hono app (ADR-0017). Ticket 01 shipped the skeleton + health route;
 * agent API routes migrate in tickets 02–04. Session-scoped harness state
 * lives on the app's module scope — one server, one harness cache.
 */
export function createApp(): Hono {
  const app = new Hono();
  app.get('/api/health', (c) => c.json({ ok: true, pid: process.pid }));
  app.get('/api/session', (c) => handleSessionGet(c.req.raw));
  app.patch('/api/session', (c) => handleSessionPatch(c.req.raw));
  app.get('/api/workspaces', () => handleWorkspacesGet());
  app.post('/api/workspaces', (c) => handleWorkspacesPost(c.req.raw));
  app.patch('/api/workspaces', (c) => handleWorkspacesPatch(c.req.raw));
  return app;
}