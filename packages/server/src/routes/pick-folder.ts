import { pickFolder } from '../server.js';

/** POST /api/pick-folder — native macOS folder chooser, returns the absolute path. */
export async function handlePickFolderPost(): Promise<Response> {
  try {
    const p = await pickFolder();
    return Response.json({ path: p });
  } catch (e: any) {
    return new Response(e?.message ?? String(e), { status: 400 });
  }
}