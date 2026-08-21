'use client';

import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  AssistantRuntimeProvider,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import type { ChatStore } from '@/lib/chat-store';
import {
  LEVEL_META,
  type LevelIcon,
  REASONING_META,
  REASONING_KEYS,
  estimateUsage,
  formatTokens,
} from '@/lib/display';
import { ApprovalContext, ToolCallCard } from './approval-tool';
import { Sidebar } from './sidebar';
import { ComposerFooter } from './composer-footer';
import {
  ChevronIcon,
  FullAccessIcon,
  MenuIcon,
  MicIcon,
  PlusIcon,
  ReadOnlyIcon,
  SendIcon,
  WorkspaceWriteIcon,
} from './icons';

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-1 overflow-hidden rounded-lg border border-neutral-100 bg-stone-50/60 text-[13px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-neutral-500 hover:bg-neutral-50"
      >
        <ChevronIcon className={`h-3 w-3 shrink-0 text-neutral-400 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="text-xs">思考过程</span>
      </button>
      {open && (
        <div className="max-h-64 overflow-y-auto whitespace-pre-wrap border-t border-neutral-100 px-3 py-2 text-xs leading-relaxed text-neutral-500">
          {text}
        </div>
      )}
    </div>
  );
}

function AssistantParts({ parts }: { parts: any[] }) {
  return (
    <div className="flex flex-col gap-1">
      {parts.map((p, i) => {
        if (p.type === 'reasoning') {
          return <ThinkingBlock key={i} text={p.text ?? ''} />;
        }
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

/** Level icons are React components, kept with the components that render them. */
const LEVEL_ICONS: Record<string, LevelIcon> = {
  readonly: ReadOnlyIcon,
  workspace: WorkspaceWriteIcon,
  fullaccess: FullAccessIcon,
};

function PermissionToolbarDropdown({
  level,
  onChange,
}: {
  level: string;
  onChange: (l: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const meta = LEVEL_META[level] ?? LEVEL_META.workspace;
  const Icon = LEVEL_ICONS[level] ?? ReadOnlyIcon;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex cursor-pointer items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-xs text-neutral-600 hover:bg-neutral-50"
        title="权限级别"
      >
        <Icon className="h-3.5 w-3.5 text-neutral-500" />
        <span className="hidden sm:inline">{meta.label}</span>
        <ChevronIcon className={`h-3 w-3 text-neutral-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-64 overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 shadow-lg">
          {Object.entries(LEVEL_META).map(([key, v]) => {
            const ItemIcon = LEVEL_ICONS[key] ?? ReadOnlyIcon;
            return (
              <button
                key={key}
                type="button"
                onClick={() => {
                  onChange(key);
                  setOpen(false);
                }}
                className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-neutral-50"
              >
                <ItemIcon className={`mt-0.5 h-4 w-4 shrink-0 ${level === key ? 'text-neutral-900' : 'text-neutral-500'}`} />
                <span className="flex-1">
                  <span className={`flex items-center gap-2 text-sm ${level === key ? 'font-medium text-neutral-900' : 'text-neutral-700'}`}>
                    {v.label}
                    {level === key && <span className="text-xs">✓</span>}
                  </span>
                  <span className="block text-[11px] text-neutral-400">{v.desc}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function useOutsideClick(ref: React.RefObject<HTMLDivElement | null>, onClose: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [ref, onClose, active]);
}

/**
 * Merged composer chip: 模型名 + 思考等级 in one element. Clicking opens a
 * popover with the reasoning-level picker (4 options) and the provider-grouped
 * model list. The separate usage ring (UsageRing) owns the usage detail.
 */
function ModelChip({ store }: { store: ChatStore }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [groups, setGroups] = useState<{ name: string; id: string; models: { id: string; displayName: string }[] }[]>([]);
  const [lastUsed, setLastUsed] = useState<{ providerId: string; modelId: string } | undefined>();

  useOutsideClick(ref, () => setOpen(false), open);

  // Empty-model UX (ADR-0016): force the picker open when no model resolved.
  const pickerTick = store.modelPickerTick ?? 0;
  useEffect(() => {
    if (pickerTick > 0) setOpen(true);
  }, [pickerTick]);

  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const d = await (await fetch('/api/config/providers')).json();
        const all: Record<string, any> = { ...d.builtins, ...d.user };
        const g = Object.entries(all).map(([id, p]) => ({
          id,
          name: p.displayName,
          models: (p.models ?? []).map((m: any) => ({ id: m.id, displayName: m.displayName || m.id })),
        }));
        setGroups(g);
        setLastUsed(d.lastUsedModel);
      } catch {
        /* ignore */
      }
    })();
  }, [open]);

  const modelLabel = (() => {
    const lu = lastUsed;
    if (lu) {
      const g = groups.find((x) => x.id === lu.providerId);
      const m = g?.models.find((x) => x.id === lu.modelId);
      if (m) return m.displayName;
    }
    return store.llm?.model ?? '默认模型';
  })();
  const levelLabel = REASONING_META[store.reasoning]?.label ?? REASONING_META.medium.label;

  const selectModel = async (providerId: string, modelId: string) => {
    setLastUsed({ providerId, modelId });
    try {
      await store.setModel(providerId, modelId);
    } catch {
      /* ignore */
    } finally {
      setOpen(false);
    }
  };

  const selectLevel = (level: string) => {
    void store.setReasoning(level);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex max-w-[240px] cursor-pointer items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-xs text-neutral-600 hover:bg-neutral-50"
        title="模型与思考等级"
      >
        <span className="truncate text-neutral-800">{modelLabel}</span>
        <span className="shrink-0 text-neutral-400">{levelLabel}</span>
        <ChevronIcon className={`h-3 w-3 shrink-0 text-neutral-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-30 mb-2 max-h-[26rem] w-80 overflow-y-auto rounded-xl border border-neutral-200 bg-white py-2 shadow-lg">
          {/* Reasoning level */}
          <div className="px-4 pb-2">
            <div className="mb-1.5 text-xs font-medium text-neutral-400">推理等级</div>
            <div className="grid grid-cols-4 gap-1">
              {REASONING_KEYS.map((key) => {
                const active = store.reasoning === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => selectLevel(key)}
                    className={`rounded-full border px-2 py-1 text-xs ${
                      active
                        ? 'border-neutral-900 bg-neutral-900 font-medium text-white'
                        : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50'
                    }`}
                  >
                    {REASONING_META[key].label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="mx-4 my-1 h-px bg-neutral-100" />

          {/* Model grouped list */}
          {groups.length === 0 && <div className="px-4 py-2 text-sm text-neutral-400">无可用提供方</div>}
          {groups.map((g) => (
            <div key={g.id} className="mb-1">
              <div className="px-4 py-1 text-xs font-medium text-neutral-400">{g.name}</div>
              {g.models.length === 0 && (
                <button
                  onClick={() => selectModel(g.id, '')}
                  className="flex w-full items-center px-4 py-1.5 text-left text-sm text-neutral-500 hover:bg-neutral-50"
                >
                  自定义模型 ID…
                </button>
              )}
              {g.models.map((m) => {
                const active = lastUsed?.providerId === g.id && lastUsed?.modelId === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => selectModel(g.id, m.id)}
                    className={`flex w-full items-center px-4 py-1.5 text-left text-sm hover:bg-neutral-50 ${
                      active ? 'bg-neutral-100 font-medium text-neutral-900' : 'text-neutral-700'
                    }`}
                  >
                    <span className="flex-1 truncate">{m.displayName}</span>
                    {active && <span className="ml-2 h-2 w-2 rounded-full bg-neutral-400" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Circular context-usage ring, clickable to open the usage detail panel. */
function UsageRing({ store }: { store: ChatStore }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClick(ref, () => setOpen(false), open);

  const usage = estimateUsage(store.messages, store.llm?.model ?? '');
  const pct = usage.percent;
  const R = 8;
  const C = 2 * Math.PI * R;
  const active = pct >= 90;

  return (
    <div ref={ref} className="relative flex items-center">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="用量详情"
        className="flex cursor-pointer items-center gap-1 rounded-full border border-neutral-200 bg-white px-1.5 py-1 text-neutral-600 hover:bg-neutral-50"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" className="-rotate-90">
          <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" className="text-neutral-100" strokeWidth="2" />
          <circle
            cx="10"
            cy="10"
            r="8"
            fill="none"
            stroke={active ? 'var(--color-red-500,#ef4444)' : 'var(--color-blue-500,#3b82f6)'}
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - pct / 100)}
          />
        </svg>
        <span className="hidden text-[11px] tabular-nums text-neutral-500 sm:inline">{usage.percent}%</span>
      </button>
      {open && <UsageDetailPanel store={store} usage={usage} onClose={() => setOpen(false)} />}
    </div>
  );
}

function UsageDetailPanel({
  store,
  usage,
  onClose,
}: {
  store: ChatStore;
  usage: ReturnType<typeof estimateUsage>;
  onClose: () => void;
}) {
  return (
    <div className="absolute bottom-full right-0 z-30 mb-2 w-72 rounded-xl border border-neutral-200 bg-white p-4 shadow-lg">
      <div className="flex items-center justify-between text-sm">
        <span className="text-neutral-900">上下文已用 {usage.percent}%</span>
        <span className="text-neutral-500">~{formatTokens(usage.tokens)} / {formatTokens(usage.limit)}</span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
        <div
          className={`h-full rounded-full transition-all ${usage.percent >= 90 ? 'bg-red-500' : 'bg-blue-500'}`}
          style={{ width: `${usage.percent}%` }}
        />
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-neutral-100 pt-2 text-sm">
        <span className="text-neutral-600">本次会话消耗</span>
        <span className="tabular-nums font-medium text-neutral-900">{formatTokens(store.usage)}</span>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="mt-2 w-full rounded-full border border-neutral-200 px-3 py-1 text-xs text-neutral-500 hover:bg-neutral-50"
      >
        关闭
      </button>
    </div>
  );
}

function Composer({ store }: { store: ChatStore }) {
  const [value, setValue] = useState('');
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const detectMention = (v: string, caret: number) => {
    const before = v.slice(0, caret);
    const m = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (!m) {
      setMention(null);
      return;
    }
    const query = m[1];
    const start = caret - query.length - 1;
    setMention({ query, start });
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!store.workspace) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await fetch(
          `/api/files?workspace=${encodeURIComponent(store.workspace!)}&q=${encodeURIComponent(query)}`,
        );
        if (r.ok) {
          const d = (await r.json()) as { files: string[] };
          setSuggestions(d.files.slice(0, 30));
        }
      } catch {
        // ignore transient fetch errors
      }
    }, 120);
  };

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setValue(v);
    detectMention(v, e.target.selectionStart ?? v.length);
  };

  const pick = (rel: string) => {
    if (!mention) return;
    const caret = taRef.current?.selectionStart ?? value.length;
    const next = value.slice(0, mention.start) + '@' + rel + ' ' + value.slice(caret);
    setValue(next);
    setMention(null);
    setSuggestions([]);
    store.addReference(rel);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const submit = () => {
    const text = value.trim();
    if (!text || !store.workspace) return;
    // Ask for desktop-notification permission on this user gesture (once).
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
    void store.send(text);
    setValue('');
    setMention(null);
    setSuggestions([]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape' && mention) {
      setMention(null);
      setSuggestions([]);
    }
  };

  const disabled = !store.workspace;

  return (
    <div
      className={`relative rounded-2xl border border-neutral-200 bg-white shadow-sm transition ${
        disabled ? 'opacity-60' : ''
      }`}
    >
      {store.references.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
          {store.references.map((p) => (
            <span
              key={p}
              className="inline-flex items-center gap-1 rounded-md bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-600"
            >
              <span className="max-w-[220px] truncate">{p}</span>
              <button
                type="button"
                onClick={() => store.removeReference(p)}
                className="text-neutral-400 hover:text-neutral-700"
                title="移除引用"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder={
          disabled ? '请先选择工作区' : '发送消息…（输入 @ 引用文件，/ 调用技能或指令）'
        }
        className="max-h-48 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-sm text-neutral-900 outline-none placeholder:text-neutral-400"
      />
      {mention && suggestions.length > 0 && (
        <div className="absolute bottom-full z-30 mb-2 max-h-56 w-full overflow-y-auto rounded-xl border border-neutral-200 bg-white py-1 shadow-lg">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => pick(s)}
              className="block w-full truncate px-3 py-1.5 text-left text-xs text-neutral-700 hover:bg-neutral-50"
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between px-2 pb-2">
        <div className="flex items-center gap-1">
          <button type="button" title="附件（暂未支持）" className="rounded-lg p-1.5 text-neutral-400" disabled>
            <PlusIcon className="h-4 w-4" />
          </button>
          <PermissionToolbarDropdown level={store.level} onChange={(l) => void store.setLevel(l)} />
        </div>
        <div className="flex items-center gap-1">
          <ModelChip store={store} />
          <UsageRing store={store} />
          <button
            type="button"
            title="语音输入（暂未支持）"
            className="rounded-full p-2 text-neutral-400"
            disabled
          >
            <MicIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={disabled}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-neutral-900 text-white hover:bg-neutral-700 disabled:opacity-40"
            title="发送"
          >
            <SendIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

export function ChatUI({ store }: { store: ChatStore }) {
  const { runtime, isRunning, pending, respond, error, messages } = store;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevPending = useRef(pending);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, isRunning]);

  // Surface a new approval request: desktop notification when permitted,
  // falling back to an in-page toast.
  useEffect(() => {
    if (pending && !prevPending.current && pending.toolName) {
      const title = `需要批准：${pending.toolName}`;
      const body = JSON.stringify(pending.args ?? {}).slice(0, 160);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          const n = new Notification(title, { body });
          n.onclick = () => window.focus();
        } catch {
          // notification construction can throw in some browsers; ignore
        }
      } else {
        setToast(`${title}　${body}`);
        const t = setTimeout(() => setToast(null), 5000);
        return () => clearTimeout(t);
      }
    }
    prevPending.current = pending;
  }, [pending]);

  const empty = messages.length === 0;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ApprovalContext.Provider
        value={{ pendingToolCallId: pending?.toolCallId ?? null, isRunning, respond }}
      >
        <div className="flex h-dvh w-full items-stretch justify-center bg-stone-100">
          <div className="flex h-full w-full overflow-hidden bg-white">
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

            {/* main: content is centered within this chat column (excludes the
                sidebar). Empty state groups the hero + composer and centers them
                on both axes here. */}
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

              {empty ? (
                <div className="relative flex min-h-0 flex-1 items-center justify-center px-4">
                  <div className="relative w-full max-w-2xl">
                    <div className="absolute bottom-full left-0 right-0 mb-6 text-center">
                      <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
                        今天帮你做些什么？
                      </h1>
                      <p className="mt-1.5 text-sm text-neutral-400">
                        选择一个工作区，或继续已有会话
                      </p>
                    </div>
                    <Composer store={store} />
                    <ComposerFooter store={store} />
                  </div>
                </div>
              ) : (
                <>
                  <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
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
                  </div>

                  {/* composer area: horizontally centered within main */}
                  <div className="mx-auto w-full max-w-2xl px-4 pb-4 pt-2">
                    <Composer store={store} />
                    <ComposerFooter store={store} />
                  </div>
                </>
              )}
            </main>
          </div>
        </div>
        {toast && (
          <div className="fixed bottom-4 right-4 z-50 max-w-xs rounded-lg border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-800 shadow-lg">
            {toast}
          </div>
        )}
      </ApprovalContext.Provider>
    </AssistantRuntimeProvider>
  );
}
