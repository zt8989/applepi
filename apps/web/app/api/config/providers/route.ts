import { handleConfigProvidersGet, handleConfigProvidersPut } from '@applepi/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/config/providers — delegate to the shared server (ADR-0017). */
export async function GET() {
  return handleConfigProvidersGet();
}

/** PUT /api/config/providers — delegate to the shared server (ADR-0017). */
export async function PUT(req: Request) {
  return handleConfigProvidersPut(req);
}
