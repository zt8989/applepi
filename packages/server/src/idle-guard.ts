import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { serverLogPath } from './log.js';

/**
 * Idle lease guard (ADR-0017 §6): the shared server exits when no client
 * heartbeat has refreshed it for `timeoutMs`. Every POST /api/heartbeat
 * refreshes the lease; the checker runs every `checkMs` and exits the process
 * on expiry. `timeoutMs <= 0` disables the guard entirely.
 */
export function createIdleGuard(opts: {
  timeoutMs: number;
  checkMs?: number;
  onExit?: () => void;
  logPath?: string;
}): { refresh: () => void; stop: () => void } {
  const timeoutMs = opts.timeoutMs;
  // timeoutMs <= 0 disables the guard entirely (no timer, no exit path).
  if (timeoutMs <= 0) {
    return { refresh: () => {}, stop: () => {} };
  }
  let lastSeen = Date.now();
  const checkMs = opts.checkMs ?? Math.min(Math.max(Math.floor(timeoutMs / 3), 1000), 15000);
  const timer = setInterval(() => {
    if (Date.now() - lastSeen > timeoutMs) {
      const logPath = opts.logPath ?? serverLogPath();
      try {
        mkdirSync(path.dirname(logPath), { recursive: true });
        // Synchronous on purpose: the exit path cannot await a queued write.
        appendFileSync(logPath, `idle timeout (${timeoutMs}ms) — no client heartbeat, exiting\n`, 'utf8');
      } catch {
        /* logging must never block the exit */
      }
      (opts.onExit ?? (() => process.exit(0)))();
    }
  }, checkMs);
  timer.unref?.();
  return {
    refresh: () => {
      lastSeen = Date.now();
    },
    stop: () => clearInterval(timer),
  };
}

export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Idle timeout from env: APPLEPI_IDLE_TIMEOUT_MS (0 = disabled, default 5 min). */
export function idleTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.APPLEPI_IDLE_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_IDLE_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_IDLE_TIMEOUT_MS;
}