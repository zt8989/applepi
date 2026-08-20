import {
  applySessionAction,
  bindSession,
  getHarness,
  readSessionFile,
  sessionTitle,
  type SessionActionRequest,
} from '@/lib/server';
import { getPermissionLevel } from '@applepi/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/session?workspace=<path>&session=<id>
 *   default: hydrate the session (messages + level + title).
 *   &format=jsonl: download the raw session file.
 *
 * PATCH /api/session — session actions (rename/pin/unpin/archive/unarchive/
 * notify/level), see SessionActionRequest.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const workspace = searchParams.get('workspace');
  const session = searchParams.get('session');
  if (!workspace || !session) {
    return new Response('missing workspace/session', { status: 400 });
  }

  if (searchParams.get('format') === 'jsonl') {
    const raw = await readSessionFile(workspace, session);
    return new Response(raw, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Content-Disposition': `attachment; filename="${session}.jsonl"`,
      },
    });
  }

  const harness = getHarness(workspace);
  const store = await bindSession(harness, workspace, session);
  const loaded = await store.load();
  const level = getPermissionLevel({ session: harness.session });
  const title = await sessionTitle(store.workspace, session);
  return Response.json({ messages: loaded.messages, level, title });
}

export async function PATCH(req: Request) {
  const body = (await req.json()) as { workspace?: string; sessionId?: string } & SessionActionRequest;
  if (!body.workspace || !body.sessionId) {
    return new Response('missing workspace/sessionId', { status: 400 });
  }
  try {
    await applySessionAction(body.workspace, body.sessionId, body);
    return Response.json({ ok: true });
  } catch (e: any) {
    return new Response(e?.message ?? String(e), { status: 400 });
  }
}
