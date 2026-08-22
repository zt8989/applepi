import { handleChatApprove } from '@applepi/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/chat/approve — delegate to the shared server (ADR-0017). */
export async function POST(req: Request) {
  return handleChatApprove(req);
}