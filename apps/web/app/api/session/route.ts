import { handleSessionGet, handleSessionPatch } from '@applepi/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/session — delegate to the shared server (ADR-0017). */
export async function GET(req: Request) {
  return handleSessionGet(req);
}

/** PATCH /api/session — delegate to the shared server (ADR-0017). */
export async function PATCH(req: Request) {
  return handleSessionPatch(req);
}