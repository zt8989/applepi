/**
 * Port configuration (ADR-0017). Default 3210, overridable via APPLEPI_PORT
 * so tests and multi-instance runs can isolate. Bound to 127.0.0.1 only.
 * A present-but-invalid APPLEPI_PORT throws (fail fast) instead of silently
 * binding a port the web proxy does not expect.
 */
export const DEFAULT_PORT = 3210;

export function serverPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.APPLEPI_PORT;
  if (!raw) return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`APPLEPI_PORT must be an integer 1-65535, got "${raw}"`);
  }
  return n;
}