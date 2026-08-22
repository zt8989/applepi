import { handleConfigGeneralGet, handleConfigGeneralPut } from '@applepi/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/config/general — delegate to the shared server (ADR-0017). */
export async function GET() {
  return handleConfigGeneralGet();
}

/** PUT /api/config/general — delegate to the shared server (ADR-0017). */
export async function PUT(req: Request) {
  return handleConfigGeneralPut(req);
}
