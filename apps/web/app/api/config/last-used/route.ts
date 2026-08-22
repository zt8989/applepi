import { handleConfigLastUsedPost } from '@applepi/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/config/last-used — delegate to the shared server (ADR-0017). */
export async function POST(req: Request) {
  return handleConfigLastUsedPost(req);
}
