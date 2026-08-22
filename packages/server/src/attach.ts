import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serverPort } from './config.js';
import { serverLogPath } from './log.js';

/**
 * Attach protocol (ADR-0017): "probe → spawn → attach" is ONE shared helper
 * used by every client (web shell, tui). The first starter spawns the server
 * detached; everyone else attaches. Fixed localhost port + /api/health probe.
 */
export const DEFAULT_ATTACH_TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 600;
const PROBE_INTERVAL_MS = 250;

export function serverUrl(port: number = serverPort()): string {
  return `http://127.0.0.1:${port}`;
}

/** True when a server answers /api/health with { ok: true }. */
export async function probeHealth(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`${url}/api/health`, { signal: ctrl.signal });
      if (!res.ok) return false;
      const body = (await res.json()) as { ok?: unknown };
      return body?.ok === true;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}

/**
 * Spawn the server detached (build-first dist entry). stdout/stderr are
 * ignored — the server writes its own lifecycle lines to the log (default
 * ~/.applepi/server.log, overridable via APPLEPI_LOG passed through env). The
 * child is unref'd: the spawning client can exit without taking the server
 * down.
 */
export function spawnServer(port: number, logPath?: string): ChildProcess {
  // attach.js sits next to index.js in dist/.
  const entry = fileURLToPath(new URL('./index.js', import.meta.url));
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      APPLEPI_PORT: String(port),
      ...(logPath ? { APPLEPI_LOG: logPath } : {}),
    },
    windowsHide: true,
  });
  child.unref();
  return child;
}

/**
 * Ensure the shared server is reachable: probe; if absent, spawn it once and
 * keep probing until it answers (EADDRINUSE self-heal — a racing spawner's
 * server coming up answers the same probe). Throws after `timeoutMs`.
 */
export async function ensureServer(
  opts: { timeoutMs?: number; logPath?: string } = {},
): Promise<{ url: string; pid: number | null; spawned: boolean }> {
  const port = serverPort();
  const url = serverUrl(port);
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS);
  const logPath = opts.logPath ?? serverLogPath();
  let pid: number | null = null;
  while (Date.now() < deadline) {
    if (await probeHealth(url)) return { url, pid, spawned: pid !== null };
    if (pid === null) {
      const child = spawnServer(port, logPath);
      pid = child.pid ?? null;
    }
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
  }
  throw new Error(
    `applepi server unreachable at ${url} (timeout ${opts.timeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS}ms, spawned=${pid !== null})`,
  );
}