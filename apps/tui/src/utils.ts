/**
 * Pure TUI helpers (ADR-0017 R2Q6: protocol parsing and command mapping are
 * pure functions and unit-tested; Ink components are not).
 */
import { randomUUID } from 'node:crypto';

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