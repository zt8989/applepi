/**
 * Shared message contract (deepen #03). One typed shape for the messages that
 * cross core → web:
 *   - `stream-loop` PRODUCES contract-conforming messages (assistant parts +
 *     tool-result messages);
 *   - the session jsonl persists them as-is;
 *   - the web client CONSUMES the contract: `hydrate` no longer re-merges
 *     `tool → tool-call` parts by hand — it folds via `mergeToolResults` and
 *     extracts text via the single `toText`.
 *
 * This module is a PURE leaf: no node/ai/react imports, so a client bundle
 * can import `@applepi/core/message` without pulling core's server surface.
 */

/** A content part of a contract message. */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool-call';
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      /** Present once the tool ran (merged from a tool-result message). */
      result?: unknown;
      /** True when the merged result looked like an error (ERROR/BLOCKED…). */
      isError?: boolean;
    }
  | { type: 'tool-result'; toolCallId: string; toolName: string; result: string };

/** A message in the shared contract. `content` is a string (user text /
 *  system prompt) or a parts array (assistant reasoning/text/tool-calls, tool
 *  results, merged UI messages). */
export interface ThreadMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string | MessagePart[];
}

/** The pending tool approval surfaced by the UI (ADR-0011 pause/resume). */
export interface PendingApproval {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

/** Extract the plain text of a message content (string or parts) — the ONE
 *  text extractor; consumers never re-derive it (deepen #03). */
export function toText(content: string | MessagePart[] | null | undefined): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('');
  }
  return '';
}

/** True when a merged result text looks like a tool error report. Shared by
 *  `mergeToolResults` and the streaming client (deepen #03 follow-up): one
 *  predicate, no hand-rolled regexes on either side of the wire. */
export function isErrorResult(result: unknown): boolean {
  return /^(ERROR|BLOCKED)/.test(String(result));
}

/**
 * Fold `role: 'tool'` messages into the owning assistant message's tool-call
 * parts (deepen #03). stream-loop persists tool results as separate tool
 * messages (mirroring the SDK wire format); the UI wants ONE assistant
 * message whose tool-call parts carry their results. Pure fold over the
 * contract — no React, no id generation — so it is unit-testable in core.
 *
 * Tool-result parts whose tool-call is missing are dropped (no ghost rows).
 */
export function mergeToolResults(messages: ThreadMessage[]): ThreadMessage[] {
  const out: ThreadMessage[] = [];
  for (const m of messages) {
    if (m.role !== 'tool' || typeof m.content === 'string') {
      out.push(m);
      continue;
    }
    for (const part of m.content) {
      if (part.type !== 'tool-result') continue;
      // The owning assistant message is the most recent one whose tool-call
      // carries this toolCallId and has no result yet.
      for (let i = out.length - 1; i >= 0; i--) {
        const holder = out[i];
        if (holder.role !== 'assistant' || typeof holder.content === 'string') continue;
        const idx = holder.content.findIndex(
          (c) =>
            c.type === 'tool-call' &&
            c.toolCallId === part.toolCallId &&
            c.result === undefined,
        );
        if (idx === -1) continue;
        const parts = [...holder.content];
        const target = parts[idx];
        if (target.type === 'tool-call') {
          parts[idx] = {
            ...target,
            result: part.result,
            isError: isErrorResult(part.result),
          };
        }
        out[i] = { ...holder, content: parts };
        break;
      }
    }
  }
  return out;
}

/** The outstanding tool approval in merged messages, or null (deepen #03):
 *  most recent assistant message's first tool-call part without a result. */
export function pendingApproval(messages: ThreadMessage[]): PendingApproval | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    const call = m.content.find(
      (p): p is Extract<MessagePart, { type: 'tool-call' }> =>
        p.type === 'tool-call' && p.result === undefined,
    );
    if (call) return { toolCallId: call.toolCallId, toolName: call.toolName, args: call.args ?? {} };
  }
  return null;
}