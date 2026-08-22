import { saveLastUsed } from '@applepi/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { providerId: string; modelId: string };
    if (!body.providerId || !body.modelId) {
      return new Response('missing providerId/modelId', { status: 400 });
    }
    await saveLastUsed(body.providerId, body.modelId);
    return Response.json({ ok: true });
  } catch (e: any) {
    return new Response(`last-used error: ${e?.message ?? String(e)}`, { status: 500 });
  }
}
