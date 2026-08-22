/**
 * Pure TUI helpers (ADR-0017 R2Q6: protocol parsing and command mapping are
 * pure functions and unit-tested; Ink components are not).
 */
import { randomUUID } from 'node:crypto';
import { PERMISSION_LEVELS } from '@applepi/server';

export function genMessageId(): string {
  return `msg-${randomUUID().slice(0, 8)}`;
}

export interface SessionStart {
  /** The session id announced by the server's `session` data part. */
  sessionId: string | null;
  /** The pending tool approval announced by the stream (if any). */
  pending:
    | { toolCallId: string; toolName: string; args: any; expectsAnswer?: boolean }
    | null;
}

export interface TurnView {
  text: string;
  toolCalls: { toolCallId: string; toolName: string; args: any; result?: string }[];
  sessionId: string | null;
  pending: { toolCallId: string; toolName: string; args: any; expectsAnswer?: boolean } | null;
  error: string | null;
  finished: boolean;
}

export function emptyTurn(): TurnView {
  return { text: '', toolCalls: [], sessionId: null, pending: null, error: null, finished: false };
}

/** Fold parsed parts (in arrival order) into the turn view. */
export function foldParts(view: TurnView, parts: any[]): TurnView {
  for (const p of parts) {
    switch (p.type) {
      case 'text':
        view.text += p.text;
        break;
      case 'error':
        view.error = p.message;
        view.finished = true;
        break;
      case 'data':
        for (const v of p.values) {
          if (v?.type === 'session' && typeof v.sessionId === 'string') view.sessionId = v.sessionId;
          if (v?.type === 'approval-pending') {
            view.pending = {
              toolCallId: String(v.toolCallId),
              toolName: String(v.toolName),
              args: v.args ?? {},
              expectsAnswer: v.expectsAnswer === true,
            };
          }
        }
        break;
      case 'tool-call':
        view.toolCalls.push({ toolCallId: p.toolCallId, toolName: p.toolName, args: p.args });
        break;
      case 'tool-result': {
        const tc = view.toolCalls.find((t) => t.toolCallId === p.toolCallId);
        if (tc) tc.result = p.result;
        if (view.pending?.toolCallId === p.toolCallId) view.pending = null;
        break;
      }
      case 'finish':
        view.finished = true;
        break;
      default:
        break;
    }
  }
  return view;
}

/** The tool call currently awaiting a decision (first without a result). */
export function awaitingApproval(view: TurnView) {
  return view.pending ?? view.toolCalls.find((t) => t.result === undefined) ?? null;
}

/** One history-note line for a tool call (shared by flush + resume render). */
export function renderToolNote(toolName: string, args: any, result?: string): string {
  return result !== undefined
    ? `[${toolName}] → ${String(result).slice(0, 200)}`
    : `[${toolName}] ${JSON.stringify(args ?? {})}`;
}

// ---- slash command mapping (ticket 08; pure + unit-tested) -----------------

export type TuiCommand =
  | { type: 'new'; mode?: 'base' | 'standard' }
  | { type: 'resume'; id: string }
  | { type: 'sessions' }
  | { type: 'config' }
  | { type: 'level'; level: string }
  | { type: 'help' }
  | { type: 'exit' }
  | { type: 'error'; message: string };

/**
 * Map an input line to a TUI command. Non-slash lines → null (ordinary chat).
 * Invalid forms map to `error` with a concrete message, never throw.
 */
export function parseCommand(line: string): TuiCommand | null {
  const text = line.trim();
  if (!text.startsWith('/')) return null;
  const parts = text.slice(1).split(/\s+/);
  const name = parts[0] ?? '';
  const arg = parts[1];
  switch (name) {
    case 'new':
      if (arg === undefined) return { type: 'new' };
      if (arg === 'base' || arg === 'standard') return { type: 'new', mode: arg };
      return { type: 'error', message: '/new 参数须为 base 或 standard' };
    case 'resume':
      if (!arg) return { type: 'error', message: '/resume 需要会话 id，如 /resume abcd1234' };
      return { type: 'resume', id: arg };
    case 'sessions':
      return { type: 'sessions' };
    case 'config':
      return { type: 'config' };
    case 'level':
      if (!arg || !(PERMISSION_LEVELS as readonly string[]).includes(arg)) {
        return { type: 'error', message: `/level 须为 ${PERMISSION_LEVELS.join('|')}` };
      }
      return { type: 'level', level: arg };
    case 'help':
      return { type: 'help' };
    case 'exit':
      return { type: 'exit' };
    default:
      return { type: 'error', message: `未知命令 /${name}（/help 查看）` };
  }
}