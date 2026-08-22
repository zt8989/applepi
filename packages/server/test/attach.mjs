// Attach protocol tests (ADR-0017, ticket 01): probe → spawn → attach.
// Drives real processes on 127.0.0.1 with APPLEPI_PORT isolation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../dist/index.js';
import {
  ensureServer,
  probeHealth,
  serverUrl,
  spawnServer,
} from '../dist/attach.js';

let passed = 0;
let failed = 0;
function ok(name, cond) {
  if (cond) {
    passed++;
    console.log(`  ok  - ${name}`);
  } else {
    failed++;
    console.error(`  FAIL - ${name}`);
  }
}

const origPort = process.env.APPLEPI_PORT;
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'applepi-attach-'));

function setPort(p) {
  if (p === undefined) delete process.env.APPLEPI_PORT;
  else process.env.APPLEPI_PORT = String(p);
}

// Pick a free port: bind a throwaway server, note the port, close it.
const throwaway = await startServer(0);
const freePort = throwaway.port;
await throwaway.close();

// 1. probeHealth: false on a dead port, true on a live health server.
ok('probeHealth false on dead port', !(await probeHealth(serverUrl(freePort))));
{
  const srv = await startServer(0);
  ok('probeHealth true on live server', await probeHealth(serverUrl(srv.port)));
  await srv.close();
}

// 2. ensureServer attaches to an already-running server (no spawn).
{
  const srv = await startServer(0);
  setPort(srv.port);
  const res = await ensureServer({ logPath: path.join(tmp, 'a.log') });
  ok('attach: no spawn when server already up', res.spawned === false && res.pid === null);
  await srv.close();
  setPort(undefined);
}

// 3. ensureServer spawns a detached server when none is running.
{
  const logPath = path.join(tmp, 'spawn.log');
  setPort(freePort);
  const res = await ensureServer({ logPath });
  ok('spawn: ensureServer spawned the server', res.spawned === true);
  ok('spawn: pid reported', typeof res.pid === 'number' && res.pid > 0);
  ok('spawn: health answers at the returned url', (await probeHealth(res.url)) === true);
  const log = await fs.readFile(logPath, 'utf8');
  ok('spawn: listening line in server log', /listening 127\.0\.0\.1:\d+ pid=\d+/.test(log));
  // The spawned child is detached: kill it to clean up.
  try {
    process.kill(res.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  setPort(undefined);
}

// 4. Busy port: a NON-health responder holds the port; our spawned child dies
//    EADDRINUSE, the probe keeps failing (not { ok: true }), ensureServer
//    gives up cleanly within the deadline.
{
  const http = await import('node:http');
  const blocker = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('busy');
  });
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  setPort(blocker.address().port);
  const t0 = Date.now();
  let threw = false;
  try {
    await ensureServer({ timeoutMs: 2500, logPath: path.join(tmp, 'busy.log') });
  } catch (e) {
    threw = /unreachable/.test(String(e.message));
  }
  ok('busy port: ensureServer rejects with unreachable error', threw);
  ok('busy port: rejects within the deadline', Date.now() - t0 < 10000);
  await new Promise((r) => blocker.close(r));
  setPort(undefined);
}

// 5. spawnServer child detaches (client can exit; server keeps running).
{
  setPort(freePort);
  const child = spawnServer(freePort, path.join(tmp, 'detach.log'));
  ok('spawnServer returns a child with pid', child.pid && child.pid > 0);
  // Poll until the child answers health (the server is up independently).
  let up = false;
  for (let i = 0; i < 40; i++) {
    if (await probeHealth(serverUrl(freePort))) {
      up = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  ok('spawned child answers health (detached)', up);
  try {
    process.kill(child.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  setPort(undefined);
}

setPort(origPort);
await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${passed} attach checks passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);