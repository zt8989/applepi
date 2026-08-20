import { addWorkspace, listWorkspaces } from '@/lib/server';

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
