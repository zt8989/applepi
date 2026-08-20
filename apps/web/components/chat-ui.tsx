'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import type { ChatStore } from '@/lib/chat-store';
import { ApprovalContext, ToolCallCard } from './approval-tool';
import { Sidebar } from './sidebar';
import { ComposerFooter } from './composer-footer';
import { MenuIcon, MicIcon, PlusIcon, SendIcon } from './icons';

function AssistantParts({ parts }: { parts: any[] }) {
  return (
    <div className="flex flex-col gap-1">
      {parts.map((p, i) => {
        if (p.type === 'text') {
          return (
            <ReactMarkdown
              key={i}
              className="prose prose-sm max-w-none text-sm leading-relaxed text-neutral-800"
            >
              {p.text ?? ''}
            </ReactMarkdown>
          );
        }
        if (p.type === 'tool-call') {
          return <ToolCallCard key={i} {...p} />;
        }
        return null;
      })}
    </div>
  );
}

function MessageRow({ message }: { message: ThreadMessageLike }) {
  if (message.role === 'user') {
    const text = (message.content as any[])
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('');
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-neutral-100 px-4 py-2 text-sm leading-relaxed text-neutral-800">
          {text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[92%]">
        <AssistantParts parts={message.content as any[]} />
      </div>
    </div>
  );
}

function Composer({ disabled }: { disabled: boolean }) {
  return (
    <ComposerPrimitive.Root
      className={`rounded-2xl border border-neutral-200 bg-white shadow-sm transition ${
        disabled ? 'pointer-events-none opacity-60' : ''
      }`}
    >
      <ComposerPrimitive.Input
        placeholder="发送消息…（/ 调用技能或指令）"
        className="max-h-48 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-sm text-neutral-900 outline-none placeholder:text-neutral-400"
      />
      <div className="flex items-center justify-between px-2 pb-2">
        <button
          type="button"
          title="附件（暂未支持）"
          className="rounded-lg p-1.5 text-neutral-400"
          disabled
        >
          <PlusIcon className="h-4 w-4" />
        </button>
        <div className="flex items-center gap-1">
          <button type="button" title="语音输入（暂未支持）" className="rounded-full p-2 text-neutral-400" disabled>
            <MicIcon className="h-4 w-4" />
          </button>
          <ComposerPrimitive.Send asChild>
            <button
              className="flex h-9 w-9 items-center justify-center rounded-full bg-neutral-900 text-white hover:bg-neutral-700 disabled:opacity-40"
              title="发送"
            >
              <SendIcon className="h-4 w-4" />
            </button>
          </ComposerPrimitive.Send>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}

export function ChatUI({ store }: { store: ChatStore }) {
  const { runtime, isRunning, pending, respond, error, messages } = store;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, isRunning]);

  const empty = messages.length === 0;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ApprovalContext.Provider
        value={{ pendingToolCallId: pending?.toolCallId ?? null, isRunning, respond }}
      >
        <div className="flex h-dvh items-stretch justify-center bg-stone-100 sm:p-4">
          <div className="flex h-full w-full max-w-7xl overflow-hidden bg-white sm:rounded-3xl sm:border sm:border-neutral-200/70 sm:shadow-sm">
            {/* desktop sidebar */}
            <div className="hidden h-full md:block">
              <Sidebar store={store} />
            </div>

            {/* mobile drawer */}
            {drawerOpen && (
              <div className="fixed inset-0 z-40 md:hidden">
                <div
                  className="absolute inset-0 bg-black/30"
                  onClick={() => setDrawerOpen(false)}
                />
                <div className="absolute inset-y-0 left-0 shadow-xl">
                  <Sidebar store={store} onNavigate={() => setDrawerOpen(false)} />
                </div>
              </div>
            )}

            {/* main */}
            <main className="flex min-w-0 flex-1 flex-col bg-white">
              <div className="flex items-center gap-2 border-b border-neutral-100 px-4 py-2.5">
                <button
                  type="button"
                  onClick={() => setDrawerOpen(true)}
                  className="rounded-lg p-1 text-neutral-500 hover:bg-neutral-100 md:hidden"
                  title="菜单"
                >
                  <MenuIcon />
                </button>
                <span className="truncate text-sm font-medium text-neutral-900">
                  {store.sessionTitle ?? '新对话'}
                </span>
              </div>

              {error && (
                <div className="mx-4 mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {error}
                </div>
              )}

              <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
                {empty ? (
                  <div className="flex h-full flex-col items-center justify-center gap-6">
                    <div className="text-center">
                      <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
                        今天帮你做些什么？
                      </h1>
                      <p className="mt-1.5 text-sm text-neutral-400">
                        选择一个工作空间，或继续已有会话
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="mx-auto flex max-w-3xl flex-col gap-5">
                    {messages.map((m) => (
                      <MessageRow key={m.id ?? String(messages.indexOf(m))} message={m} />
                    ))}
                    {isRunning && (
                      <div className="flex justify-start">
                        <span className="rounded-full bg-neutral-100 px-3 py-1.5 text-xs text-neutral-500">
                          运行中…
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* composer area */}
              <div className="mx-auto w-full max-w-2xl px-4 pb-4 pt-2">
                <Composer disabled={!store.workspace} />
                <ComposerFooter store={store} />
              </div>
            </main>
          </div>
        </div>
      </ApprovalContext.Provider>
    </AssistantRuntimeProvider>
  );
}
