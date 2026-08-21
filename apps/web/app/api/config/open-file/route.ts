import { openConfigFile, configFileHidden } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET: probe whether the action is available (no side effect — does NOT open). */
export async function GET() {
  return Response.json({ hidden: configFileHidden() });
}

/** POST: actually open settings.json in the OS default editor. */
export async function POST() {
  try {
    const res = await openConfigFile();
    return Response.json(res);
  } catch (e: any) {
    return new Response(`open-file error: ${e?.message ?? String(e)}`, { status: 500 });
  }
}
