import { handleConfigGet } from '@applepi/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/config — delegate to the shared server (ADR-0017). */
export async function GET() {
  return handleConfigGet();
}