import { pickFolder } from '@applepi/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/pick-folder — native macOS folder chooser, returns the absolute path. */
export async function POST() {
  try {
    const p = await pickFolder();
    return Response.json({ path: p });
  } catch (e: any) {
    return new Response(e?.message ?? String(e), { status: 400 });
  }
}
