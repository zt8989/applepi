// Request-level tests for the server skeleton (ADR-0017): the Hono app is
// testable without a browser or a real provider — fetch(app.request) on the
// app, and a real listening server via startServer for the process-level path.
import assert from 'node:assert/strict';
import { createApp, startServer, serverPort, DEFAULT_PORT } from '../dist/index.js';

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ok - ${name}`);
}

// 1. Health route answers { ok: true } at the app level.
{
  const res = await createApp().request('/api/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.pid, 'number');
  ok('GET /api/health -> { ok: true } (app level)');
}

// 2. Unknown route -> 404, not a crash.
{
  const res = await createApp().request('/nope');
  assert.equal(res.status, 404);
  ok('unknown route -> 404');
}

// 3. startServer binds 127.0.0.1 on a picked port (0 = free); health over HTTP.
{
  const srv = await startServer(0);
  assert.ok(srv.port > 0, `bound a real port: ${srv.port}`);
  const res = await fetch(`http://127.0.0.1:${srv.port}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  await srv.close();
  ok('startServer listens on 127.0.0.1 and answers health over HTTP');
}

// 4. Port config: APPLEPI_PORT honored, defaults otherwise.
{
  assert.equal(serverPort({}), DEFAULT_PORT);
  assert.equal(serverPort({ APPLEPI_PORT: '4321' }), 4321);
  assert.equal(serverPort({ APPLEPI_PORT: 'abc' }), DEFAULT_PORT);
  assert.equal(serverPort({ APPLEPI_PORT: '0' }), DEFAULT_PORT);
  assert.equal(serverPort({ APPLEPI_PORT: '99999' }), DEFAULT_PORT);
  ok('serverPort: APPLEPI_PORT override + invalid fallback to default');
}

console.log(`\nhealth: ${passed} checks passed`);