'use client';

import { createContext, useContext } from 'react';

export interface ApprovalContextValue {
  /** The tool call currently awaiting the user's decision (server-ordered). */
  pendingToolCallId: string | null;
  isRunning: boolean;
  respond: (decision: 'approve' | 'deny') => void;
}

export const ApprovalContext = createContext<ApprovalContextValue | null>(null);

/**
 * Tool-call renderer (ADR-0011): a tool call without a result renders an
 * approval card; with a result it renders the tool output. Read-classified
 * tools stream their results inline, so only `ask` tools ever show the card.
 * Base-style visuals: subtle border, neutral palette, small radius.
 */
export function ToolCallCard(props: any) {
  const { toolName, toolCallId, args, result, isError } = props;
  const ctx = useContext(ApprovalContext);
  const awaiting = result === undefined;
  const isPending = ctx?.pendingToolCallId === toolCallId;

  if (!awaiting) {
    return (
      <div className="my-2 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-neutral-200/70 px-1.5 py-0.5 font-mono text-[11px] text-neutral-600">
            {toolName}
          </span>
          {isError ? (
            <span className="rounded bg-red-100 px-1.5 py-0.5 text-[11px] text-red-700">error</span>
          ) : (
            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-700">done</span>
          )}
        </div>
        <pre className="mt-1.5 max-h-44 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-neutral-600">
          {String(result)}
        </pre>
      </div>
    );
  }

  return (
    <div className="my-2 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-amber-100 px-1.5 py-0.5 font-mono text-[11px] text-amber-800">
            {toolName}
          </span>
          <span className="text-xs text-amber-700">等待批准</span>
        </div>
      </div>
      <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap rounded-lg bg-white/70 p-2 font-mono text-xs text-neutral-700">
        {JSON.stringify(args ?? {}, null, 2)}
      </pre>
      {isPending && !ctx?.isRunning ? (
        <div className="mt-2.5 flex gap-2">
          <button
            onClick={() => ctx?.respond('approve')}
            className="rounded-lg bg-neutral-900 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-neutral-700"
          >
            批准执行
          </button>
          <button
            onClick={() => ctx?.respond('deny')}
            className="rounded-lg border border-neutral-300 bg-white px-3.5 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-100"
          >
            拒绝
          </button>
        </div>
      ) : (
        <p className="mt-2.5 text-xs text-neutral-500">
          {ctx?.isRunning ? '处理中…' : '等待前序工具调用批准'}
        </p>
      )}
    </div>
  );
}
