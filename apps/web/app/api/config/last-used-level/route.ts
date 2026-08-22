import { saveLastUsedLevel } from '@applepi/server';
import { REASONING_LEVELS } from '@applepi/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/config/last-used-level — persist the global default reasoning
 * level (settings.json.lastUsedLevel). Per-session overrides use the
 * `reasoning` session action instead (/api/session PATCH).
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { level?: string };
    const level = body.level;
    if (!level || !(REASONING_LEVELS as readonly string[]).includes(level)) {
      return new Response(`level must be one of: ${REASONING_LEVELS.join('|')}`, { status: 400 });
    }
    await saveLastUsedLevel(level as any);
    return Response.json({ ok: true });
  } catch (e: any) {
    return new Response(`last-used-level error: ${e?.message ?? String(e)}`, { status: 500 });
  }
}
