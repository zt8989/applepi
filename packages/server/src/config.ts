/**
 * Port configuration (ADR-0017). Default 3210, overridable via APPLEPI_PORT
 * so tests and multi-instance runs can isolate. Bound to 127.0.0.1 only.
 */
export const DEFAULT_PORT = 3210;

export function serverPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.APPLEPI_PORT;
  if (!raw) return DEFAULT_PORT;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_PORT;
}