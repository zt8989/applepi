'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { processDataStream } from 'ai';
import {
  useExternalStoreRuntime,
  type AssistantRuntime,
  type ExternalStoreAdapter,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import type {
  ApproveRequestBody,
  ChatRequestBody,
  PendingApprovalInfo,
} from './types';

/**
 * Client-side chat store for the applepi web interface (ADR-0011).
 *
 * Implements the pause/resume approval protocol against the data-stream API:
 *   - every user turn owns ONE assistant message (id generated client-side and
 *     echoed to the server so continuation segments merge into the same
 *     message);
 *   - the first segment runs until the server pauses at an `ask` tool call;
 *     subsequent segments (approve/deny) stream tool results + more text into
 *     that same message;
 *   - sessions are persisted server-side; a refresh hydrates history and
 *     re-surfaces an outstanding approval.
 *
 * Shell state (base-style tree): workspaces grouped with their sessions,
 * active session / title / permission level, session actions.
 */

const genId = () => crypto.randomUUID();
const WS_KEY = 'applepi.web.workspace';
const sessionKey = (workspace: string) =>
  `applepi.web.session.${encodeURIComponent(workspace)}`;

export interface SessionNode {
  id: string;
  title: string;
  ts: string;
  pinned: boolean;
  notify?: boolean;
}
export interface WorkspaceNode {
  slug: string;
  path?: string;
  sessions: SessionNode[];
}

export interface ChatStore {
  runtime: AssistantRuntime;
  isRunning: boolean;
  messages: ThreadMessageLike[];
  workspace: string | null;
  setWorkspace: (w: string) => void;
  workspaces: WorkspaceNode[];
  refreshWorkspaces: () => Promise<void>;
  addWorkspace: (p: string) => Promise<string>;
  newSession: () => void;
  openSession: (workspacePath: string, sessionId: string) => Promise<void>;
  activeSessionId: string | null;
  sessionTitle: string | null;
  level: string;
  setLevel: (level: string) => Promise<void>;
  pending: PendingApprovalInfo | null;
  respond: (decision: 'approve' | 'deny') => Promise<void>;
  error: string | null;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  togglePin: (sessionId: string, pinned: boolean) => Promise<void>;
  toggleNotify: (sessionId: string, enabled: boolean) => Promise<void>;
  archiveSession: (sessionId: string) => Promise<void>;
  exportSession: (sessionId: string) => void;
}

function toText(message: { content: string | readonly { type: string; text?: string }[] }): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((p) => (p.type === 'text' ? p.text ?? '' : ''))
    .join('');
}

export function useChatStore(): ChatStore {
  const [workspace, setWorkspaceState] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : (localStorage.getItem(WS_KEY) ?? null),
  );
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const [level, setLevelState] = useState('workspace');
  const [messages, setMessages] = useState<ThreadMessageLike[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [pending, setPending] = useState<PendingApprovalInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceNode[]>([]);

  const messagesRef = useRef<ThreadMessageLike[]>(messages);
  const assistantIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const commit = useCallback((next: ThreadMessageLike[]) => {
    messagesRef.current = next;
    setMessages(next);
  }, []);

  // ---- workspaces / sessions -------------------------------------------------

  const refreshWorkspaces = useCallback(async () => {
    try {
      const res = await fetch('/api/workspaces');
      if (!res.ok) return;
      const data = await res.json();
      setWorkspaces(data.workspaces ?? []);
    } catch {
      // offline/server not ready: keep the last list
    }
  }, []);

  const addWorkspace = useCallback(
    async (p: string) => {
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
      });
      if (!res.ok) throw new Error((await res.text()) || 'failed to add workspace');
      const ws = (await res.json()) as { slug: string; path: string };
      await refreshWorkspaces();
      return ws.path;
    },
    [refreshWorkspaces],
  );

  const setWorkspace = useCallback(
    (w: string) => {
      localStorage.setItem(WS_KEY, w);
      setWorkspaceState(w);
      setSessionId(null);
      setSessionTitle(null);
      assistantIdRef.current = null;
      setPending(null);
      setError(null);
      commit([]);
    },
    [commit],
  );

  const newSession = useCallback(() => {
    if (workspace) localStorage.removeItem(sessionKey(workspace));
    setSessionId(null);
    setSessionTitle(null);
    assistantIdRef.current = null;
    setPending(null);
    setError(null);
    commit([]);
  }, [workspace, commit]);

  const sessionAction = useCallback(
    async (sessionId: string, body: Record<string, unknown>) => {
      const res = await fetch('/api/session', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace, sessionId, ...body }),
      });
      if (!res.ok) throw new Error((await res.text()) || 'session action failed');
    },
    [workspace],
  );

  const renameSession = useCallback(
    async (sid: string, title: string) => {
      await sessionAction(sid, { action: 'rename', title });
      if (sid === sessionIdRef.current) setSessionTitle(title);
      await refreshWorkspaces();
    },
    [sessionAction, refreshWorkspaces],
  );

  const togglePin = useCallback(
    async (sid: string, pinned: boolean) => {
      await sessionAction(sid, { action: pinned ? 'pin' : 'unpin' });
      await refreshWorkspaces();
    },
    [sessionAction, refreshWorkspaces],
  );

  const toggleNotify = useCallback(
    async (sid: string, enabled: boolean) => {
      await sessionAction(sid, { action: 'notify', enabled });
      await refreshWorkspaces();
    },
    [sessionAction, refreshWorkspaces],
  );

  const archiveSession = useCallback(
    async (sid: string) => {
      await sessionAction(sid, { action: 'archive' });
      if (sid === sessionIdRef.current) {
        setSessionId(null);
        setSessionTitle(null);
        commit([]);
        localStorage.removeItem(sessionKey(workspaceRef.current ?? ''));
      }
      await refreshWorkspaces();
    },
    [sessionAction, refreshWorkspaces, commit],
  );

  const exportSession = useCallback(
    (sid: string) => {
      if (!workspaceRef.current) return;
      const url = `/api/session?workspace=${encodeURIComponent(workspaceRef.current)}&session=${encodeURIComponent(sid)}&format=jsonl`;
      const a = document.createElement('a');
      a.href = url;
      a.download = `${sid}.jsonl`;
      a.click();
    },
    [],
  );

  const setLevel = useCallback(
    async (l: string) => {
      if (!sessionIdRef.current) {
        setLevelState(l); // no session yet: remember for the first message
        return;
      }
      await sessionAction(sessionIdRef.current, { action: 'level', level: l });
      setLevelState(l);
    },
    [sessionAction],
  );

  // ---- stream handling -----------------------------------------------------

  const appendText = useCallback(
    (assistantId: string, delta: string) => {
      const msgs = messagesRef.current;
      const idx = msgs.findIndex((m) => m.id === assistantId);
      if (idx === -1) return;
      const msg = msgs[idx];
      const parts = [...(msg.content as any[])];
      const lastText = [...parts].reverse().find((p) => p.type === 'text');
      if (lastText) {
        lastText.text += delta;
      } else {
        parts.push({ type: 'text', text: delta });
      }
      commit(msgs.map((m, i) => (i === idx ? { ...m, content: parts } : m)));
    },
    [commit],
  );

  const appendToolCall = useCallback(
    (assistantId: string, part: { toolCallId: string; toolName: string; args: any }) => {
      const msgs = messagesRef.current;
      const idx = msgs.findIndex((m) => m.id === assistantId);
      if (idx === -1) return;
      const msg = msgs[idx];
      commit(
        msgs.map((m, i) =>
          i === idx
            ? {
                ...m,
                content: [
                  ...(m.content as any[]),
                  { type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, args: part.args },
                ],
              }
            : m,
        ),
      );
    },
    [commit],
  );

  const attachToolResult = useCallback(
    (assistantId: string, toolCallId: string, result: any) => {
      const msgs = messagesRef.current;
      const idx = msgs.findIndex((m) => m.id === assistantId);
      if (idx === -1) return;
      commit(
        msgs.map((m, i) =>
          i === idx
            ? {
                ...m,
                content: (m.content as any[]).map((p) =>
                  p.type === 'tool-call' && p.toolCallId === toolCallId
                    ? { ...p, result, isError: /^(ERROR|BLOCKED)/.test(String(result)) }
                    : p,
                ),
              }
            : m,
        ),
      );
    },
    [commit],
  );

  const handleData = useCallback((value: unknown) => {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const v = item as Record<string, unknown>;
      if (v.type === 'session' && typeof v.sessionId === 'string') {
        setSessionId(v.sessionId);
        if (workspaceRef.current) {
          localStorage.setItem(sessionKey(workspaceRef.current), v.sessionId);
        }
      } else if (v.type === 'approval-pending') {
        setPending({
          toolCallId: String(v.toolCallId),
          toolName: String(v.toolName),
          args: (v.args ?? {}) as Record<string, unknown>,
        });
      }
    }
  }, []);

  const workspaceRef = useRef(workspace);
  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const levelRef = useRef(level);
  useEffect(() => {
    levelRef.current = level;
  }, [level]);

  const runSegment = useCallback(
    async (url: string, body: ChatRequestBody | ApproveRequestBody, assistantId: string) => {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const t = await res.text();
          throw new Error(t || `request failed (${res.status})`);
        }
        if (!res.body) throw new Error('empty response body');
        await processDataStream({
          stream: res.body,
          onTextPart: (text) => appendText(assistantId, text),
          onToolCallPart: (part) => appendToolCall(assistantId, part),
          onToolResultPart: (part) => attachToolResult(assistantId, part.toolCallId, part.result),
          onDataPart: handleData,
          onFinishMessagePart: () => setIsRunning(false),
          onErrorPart: (err) => setError(String(err)),
        });
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
        setError(e?.message ?? String(e));
        setIsRunning(false);
      } finally {
        abortRef.current = null;
      }
    },
    [appendText, appendToolCall, attachToolResult, handleData],
  );

  const onNew = useCallback(
    async (message: { content: string | readonly { type: string; text?: string }[] }) => {
      if (!workspaceRef.current) {
        setError('请先选择或添加一个工作区');
        return;
      }
      const text = toText(message).trim();
      if (!text) return;
      const assistantId = genId();
      assistantIdRef.current = assistantId;
      commit([
        ...messagesRef.current,
        { role: 'user', id: genId(), content: [{ type: 'text', text }] },
        { role: 'assistant', id: assistantId, content: [] },
      ]);
      setPending(null);
      setError(null);
      setIsRunning(true);
      const body: ChatRequestBody = {
        workspace: workspaceRef.current,
        sessionId: sessionIdRef.current ?? undefined,
        messageId: assistantId,
        message: text,
        // Pre-chosen permission level for a brand-new session.
        level: sessionIdRef.current ? undefined : levelRef.current,
      };
      await runSegment('/api/chat', body, assistantId);
      await refreshWorkspaces();
    },
    [commit, runSegment, refreshWorkspaces],
  );

  const respond = useCallback(
    async (decision: 'approve' | 'deny') => {
      const p = pendingRef.current;
      const assistantId = assistantIdRef.current;
      if (!p || !assistantId || !sessionIdRef.current) return;
      setPending(null);
      setError(null);
      setIsRunning(true);
      const body: ApproveRequestBody = {
        workspace: workspaceRef.current!,
        sessionId: sessionIdRef.current,
        messageId: assistantId,
        toolCallId: p.toolCallId,
        decision,
      };
      await runSegment('/api/chat/approve', body, assistantId);
    },
    [runSegment],
  );

  const pendingRef = useRef(pending);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  // ---- hydration -----------------------------------------------------------

  const hydrate = useCallback(
    async (ws: string, sid: string) => {
      try {
        const res = await fetch(`/api/session?workspace=${encodeURIComponent(ws)}&session=${encodeURIComponent(sid)}`);
        if (!res.ok) {
          // Session gone: start fresh.
          localStorage.removeItem(sessionKey(ws));
          setSessionId(null);
          commit([]);
          return;
        }
        const data = await res.json();
        if (typeof data.level === 'string') setLevelState(data.level);
        if (typeof data.title === 'string') setSessionTitle(data.title);
        const msgs = data.messages as { role: string; content: any }[];
        const out: ThreadMessageLike[] = [];
        let lastAssistantId: string | null = null;
        for (const m of msgs) {
          if (m.role === 'system') continue;
          if (m.role === 'user') {
            const text = typeof m.content === 'string' ? m.content : (m.content ?? [])
              .map((p: any) => (p.type === 'text' ? p.text : ''))
              .join('');
            out.push({ role: 'user', id: genId(), content: [{ type: 'text', text }] });
          } else if (m.role === 'assistant') {
            const id = genId();
            lastAssistantId = id;
            const parts = (m.content ?? []).map((p: any) => {
              if (p.type === 'text') return { type: 'text', text: p.text };
              if (p.type === 'tool-call') {
                return {
                  type: 'tool-call',
                  toolCallId: p.toolCallId,
                  toolName: p.toolName,
                  args: p.args ?? {},
                };
              }
              return p;
            });
            out.push({ role: 'assistant', id, content: parts });
          } else if (m.role === 'tool') {
            // Merge tool results into the owning assistant message's tool-call
            // part (rebuild the message immutably — parts are readonly).
            for (const p of m.content ?? []) {
              if (p.type !== 'tool-result') continue;
              const holder = [...out].reverse().find(
                (x) =>
                  x.role === 'assistant' &&
                  (x.content as any[]).some(
                    (c) => c.type === 'tool-call' && c.toolCallId === p.toolCallId && !c.result,
                  ),
              );
              if (!holder) continue;
              const hIdx = out.indexOf(holder);
              out[hIdx] = {
                ...holder,
                content: (holder.content as any[]).map((c) =>
                  c.type === 'tool-call' && c.toolCallId === p.toolCallId
                    ? { ...c, result: p.result, isError: /^(ERROR|BLOCKED)/.test(String(p.result)) }
                    : c,
                ),
              };
            }
          }
        }
        assistantIdRef.current = lastAssistantId;
        commit(out);
        // Re-surface an outstanding approval (tool-call part without a result).
        const pendingCall = [...out]
          .reverse()
          .flatMap((m) => (m.role === 'assistant' ? (m.content as any[]) : []))
          .find((p) => p.type === 'tool-call' && p.result === undefined);
        if (pendingCall) {
          setPending({
            toolCallId: pendingCall.toolCallId,
            toolName: pendingCall.toolName,
            args: pendingCall.args ?? {},
          });
        }
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    },
    [commit],
  );

  const openSession = useCallback(
    async (workspacePath: string, sid: string) => {
      localStorage.setItem(WS_KEY, workspacePath);
      localStorage.setItem(sessionKey(workspacePath), sid);
      setWorkspaceState(workspacePath);
      setSessionId(sid);
      setPending(null);
      setError(null);
      commit([]);
      await hydrate(workspacePath, sid);
      await refreshWorkspaces();
    },
    [hydrate, refreshWorkspaces, commit],
  );

  // Load the saved session for the current workspace on mount/workspace change.
  useEffect(() => {
    if (!workspace) {
      commit([]);
      return;
    }
    const saved = localStorage.getItem(sessionKey(workspace));
    if (saved) {
      setSessionId(saved);
      void hydrate(workspace, saved);
    } else {
      setSessionId(null);
      assistantIdRef.current = null;
      setPending(null);
      commit([]);
    }
    void refreshWorkspaces();
  }, [workspace, hydrate, refreshWorkspaces, commit]);

  const adapter = useMemo<ExternalStoreAdapter<ThreadMessageLike>>(
    () => ({
      messages,
      isRunning,
      setMessages: (m) => commit([...(m as ThreadMessageLike[])]),
      // Messages are already ThreadMessageLike — the converter is identity.
      convertMessage: (m) => m,
      onNew: onNew as any,
      onCancel: async () => {
        abortRef.current?.abort();
        setIsRunning(false);
      },
    }),
    [messages, isRunning, onNew, commit],
  );

  const runtime = useExternalStoreRuntime(adapter);

  return {
    runtime,
    isRunning,
    messages,
    workspace,
    setWorkspace,
    workspaces,
    refreshWorkspaces,
    addWorkspace,
    newSession,
    openSession,
    activeSessionId: sessionId,
    sessionTitle,
    level,
    setLevel,
    pending,
    respond,
    error,
    renameSession,
    togglePin,
    toggleNotify,
    archiveSession,
    exportSession,
  };
}
