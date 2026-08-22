import {
  handleWorkspacesGet,
  handleWorkspacesPatch,
  handleWorkspacesPost,
} from '@applepi/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/workspaces — delegate to the shared server (ADR-0017). */
export async function GET() {
  return handleWorkspacesGet();
}

/** POST /api/workspaces — delegate to the shared server (ADR-0017). */
export async function POST(req: Request) {
  return handleWorkspacesPost(req);
}

/** PATCH /api/workspaces — delegate to the shared server (ADR-0017). */
export async function PATCH(req: Request) {
  return handleWorkspacesPatch(req);
}