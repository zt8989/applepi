import { appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Server log (ADR-0017): `~/.applepi/server.log` by default; `APPLEPI_LOG`
 * overrides it (test isolation). The server appends its own lifecycle lines;
 * the attach spawn lets the child inherit the override via env.
 */
export function serverLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.APPLEPI_LOG ?? path.join(os.homedir(), '.applepi', 'server.log');
}

export async function logServer(line: string, logPath: string = serverLogPath()): Promise<void> {
  try {
    await appendFile(logPath, `${line}\n`, 'utf8');
  } catch {
    // Logging must never take the server down.
  }
}