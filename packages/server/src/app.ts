import { Hono } from 'hono';

/**
 * The Hono app (ADR-0017). Ticket 01 ships the skeleton + health route only;
 * the agent API routes migrate in tickets 02–04. Session-scoped harness state
 * will live on the app instance ("one server, one harness cache").
 */
export function createApp(): Hono {
  const app = new Hono();
  app.get('/api/health', (c) =>
    c.json({ ok: true, pid: process.pid }),
  );
  return app;
}