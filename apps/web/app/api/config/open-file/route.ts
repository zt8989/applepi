import { handleConfigOpenFileGet, handleConfigOpenFilePost } from '@applepi/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET — probe whether the action is available. Delegate (ADR-0017). */
export async function GET() {
  return handleConfigOpenFileGet();
}

/** POST — open settings.json in the OS default editor. Delegate (ADR-0017). */
export async function POST() {
  return handleConfigOpenFilePost();
}
