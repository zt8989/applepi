import { addWorkspace, listWorkspaces, renameWorkspace, removeWorkspace } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/workspaces — existing workspaces (slugs + recorded paths + sessions). */
export async function GET() {
  const workspaces = await listWorkspaces();
  return Response.json({ workspaces });
}

/** POST /api/workspaces { path } — add a workspace by absolute path. */
export async function POST(req: Request) {
  const { path: p } = (await req.json()) as { path?: string };
  if (typeof p !== 'string' || !p.trim()) {
    return new Response('missing path', { status: 400 });
  }
  try {
    const ws = await addWorkspace(p.trim());
    return Response.json(ws);
  } catch (e: any) {
    return new Response(e?.message ?? String(e), { status: 400 });
  }
}

/**
 * PATCH /api/workspaces { action, slug, name? }
 *   - rename: set the display-name override (does not touch disk).
 *   - remove: logical delete — drop the manifest entry, keep session files.
 */
export async function PATCH(req: Request) {
  const { action, slug, name } = (await req.json()) as {
    action?: string;
    slug?: string;
    name?: string;
  };
  if (typeof slug !== 'string' || !slug) {
    return new Response('missing slug', { status: 400 });
  }
  try {
    if (action === 'rename') {
      if (typeof name !== 'string' || !name.trim()) {
        return new Response('missing name', { status: 400 });
      }
      await renameWorkspace(slug, name);
      return Response.json({ ok: true });
    }
    if (action === 'remove') {
      await removeWorkspace(slug);
      return Response.json({ ok: true });
    }
    return new Response('unknown action', { status: 400 });
  } catch (e: any) {
    return new Response(e?.message ?? String(e), { status: 400 });
  }
}
