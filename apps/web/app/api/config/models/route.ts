import { handleConfigModelsGet } from '@applepi/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/config/models — delegate to the shared server (ADR-0017). */
export async function GET(req: Request) {
  return handleConfigModelsGet(req);
}
