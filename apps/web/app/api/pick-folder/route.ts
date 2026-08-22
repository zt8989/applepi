import { handlePickFolderPost } from '@applepi/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/pick-folder — delegate to the shared server (ADR-0017). */
export async function POST() {
  return handlePickFolderPost();
}
