import { getPermissionLevel, pendingToolCalls } from '@applepi/core';
import {
  applySessionAction,
  bindSession,
  getHarness,
  readSessionFile,
  sessionMode,
  sessionTitle,
  type SessionActionRequest,
} from '../server.js';

/**
 * GET /api/session?workspace=<path>&session=<id>
 *   default: hydrate the session (messages + level + title + pending).
 *   &format=jsonl: download the raw session file.
 *
 * PATCH /api/session — session actions (rename/pin/unpin/archive/unarchive/
 * notify/level/reasoning/model), see SessionActionRequest.
 */
export async function handleSessionGet(req: Request): Promise<Response> {
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

  const mode = await sessionMode(workspace, session);
  const harness = getHarness(workspace, mode);
  const store = await bindSession(harness, workspace, session, mode);
  const loaded = await store.load();
  const level = getPermissionLevel({ session: harness.session });
  // Reasoning override read from the persisted session config (ADR-0016).
  const config = await store.loadConfig();
  const reasoning = config.reasoningLevel;
  // Mode: `sessionMode` reads the persisted config identity (ADR-0016).
  const title = await sessionTitle(store.workspace, session);
  // Outstanding approval, server-resolved so the client can render an
  // ask_user text-input card even after a refresh (expectsAnswer lives in the
  // tool spec, which the client never sees).
  const outstanding = pendingToolCalls(loaded.messages)[0];
  const pending = outstanding
    ? {
        toolCallId: outstanding.toolCallId,
        toolName: outstanding.toolName,
        args: outstanding.args,
        expectsAnswer: harness.getTool(outstanding.toolName)?.expectsAnswer === true,
      }
    : null;
  return Response.json({ messages: loaded.messages, level, reasoning, mode, title, pending });
}

export async function handleSessionPatch(req: Request): Promise<Response> {
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