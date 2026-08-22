import { saveGeneralDefaults, getGeneralDefaults } from '@applepi/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET — the current global default slots (ADR-0016 通用设置). */
export async function GET() {
  try {
    return Response.json(await getGeneralDefaults());
  } catch (e: any) {
    return new Response(`general error: ${e?.message ?? String(e)}`, { status: 500 });
  }
}

/** PUT — overwrite the global default slots (model/reasoning/permission). */
export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as {
      model?: { providerId: string; modelId: string };
      reasoningLevel?: string;
      permissionLevel?: string;
    };
    await saveGeneralDefaults(body);
    return Response.json({ ok: true });
  } catch (e: any) {
    return new Response(`save general error: ${e?.message ?? String(e)}`, { status: 500 });
  }
}
