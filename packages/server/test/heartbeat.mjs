// Heartbeat lease tests (ADR-0017 ticket 09). App-level: /api/heartbeat
// refreshes the guard. Process-level: a REAL spawned server with a short idle
// timeout stays alive while a client heartbeats, and exits shortly after the
// client stops.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp, createIdleGuard, startHeartbeat, startServer, spawnServer, probeHealth, serverUrl } from '../dist/index.js';

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

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'applepi-hb-'));
process.env.APPLEPI_SESSIONS_DIR = path.join(tmpRoot, 'sessions');

// 1. App level: /api/heartbeat invokes the refresh hook (the lease renews).
{
  let refreshes = 0;
  const app = createApp({ refresh: () => refreshes++ });
  let res = await app.request('/api/heartbeat', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(refreshes, 1);
  res = await app.request('/api/heartbeat', { method: 'POST' });
  assert.equal(refreshes, 2);
  ok('heartbeat: POST /api/heartbeat refreshes the lease hook', refreshes === 2);
}

// 2. Process level: idle timeout env honored; heartbeat keeps it alive;
//    stopping the heartbeat lets it exit (idle-exit logged).
{
  const probe = await startServer(0);
  const freePort = probe.port;
  await probe.close();

  // The spawned child inherits process.env — set the short idle timeout
  // BEFORE spawning so the guard boots with it.
  process.env.APPLEPI_IDLE_TIMEOUT_MS = '800';
  const logPath = path.join(tmpRoot, 'guard.log');
  const child = spawnServer(freePort, logPath);
  ok('heartbeat: spawned server child', child.pid && child.pid > 0);

  let up = false;
  for (let i = 0; i < 40; i++) {
    if (await probeHealth(serverUrl(freePort))) {
      up = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  ok('heartbeat: child boots with idle timeout 800ms', up);

  // Heartbeat every 150ms → still alive after 2s (well past the 800ms timeout).
  const hb = startHeartbeat(serverUrl(freePort), 150);
  await new Promise((r) => setTimeout(r, 2100));
  ok('heartbeat: lease renewed — alive past the idle timeout', (await probeHealth(serverUrl(freePort))) === true);

  // Stop heartbeating → the guard exits the server within ~2s.
  hb.stop();
  let exited = false;
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (!(await probeHealth(serverUrl(freePort)))) {
      exited = true;
      break;
    }
  }
  ok('heartbeat: server exits after the lease lapses', exited === true);

  const log = await fs.readFile(logPath, 'utf8');
  ok('heartbeat: idle-exit logged', /idle timeout/.test(log));
  delete process.env.APPLEPI_IDLE_TIMEOUT_MS;
}

// 3. Dual-client lease: two heartbeat sources renew together; when ONE stops
//    the server survives on the other; only when BOTH stop does it exit.
{
  const probe = await startServer(0);
  const port = probe.port;
  await probe.close();
  process.env.APPLEPI_IDLE_TIMEOUT_MS = '700';
  const child = spawnServer(port, path.join(tmpRoot, 'dual.log'));

  let up = false;
  for (let i = 0; i < 40; i++) {
    if (await probeHealth(serverUrl(port))) {
      up = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  ok('dual-client: server boots', up);

  const hb1 = startHeartbeat(serverUrl(port), 120);
  const hb2 = startHeartbeat(serverUrl(port), 120);
  await new Promise((r) => setTimeout(r, 1500));
  ok('dual-client: alive with two heartbeats', (await probeHealth(serverUrl(port))) === true);

  hb2.stop(); // one client leaves (e.g. TUI exits)
  await new Promise((r) => setTimeout(r, 1500));
  ok('dual-client: one client leaving does NOT kill the server', (await probeHealth(serverUrl(port))) === true);

  hb1.stop(); // web shell leaves too
  let exited = false;
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (!(await probeHealth(serverUrl(port)))) {
      exited = true;
      break;
    }
  }
  ok('dual-client: server exits after BOTH leases lapse', exited === true);
  delete process.env.APPLEPI_IDLE_TIMEOUT_MS;
}

// 4. timeoutMs <= 0 disables the guard entirely (no rapid self-exit).
{
  let exited = false;
  const guard = createIdleGuard({ timeoutMs: 0, onExit: () => (exited = true) });
  await new Promise((r) => setTimeout(r, 1300));
  ok('idle guard: timeoutMs 0 disables the guard (no exit)', exited === false);
  guard.stop();
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${passed} heartbeat checks passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);