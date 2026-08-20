'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChatStore, SessionNode, WorkspaceNode } from '@/lib/chat-store';
import {
  ArchiveIcon,
  BellIcon,
  ChevronIcon,
  DotsIcon,
  FolderIcon,
  PlusIcon,
  SearchIcon,
} from './icons';

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return '刚刚';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} 天前`;
  return new Date(t).toLocaleDateString('zh-CN');
}

const PAGE = 5;

function SessionRow({
  session,
  workspacePath,
  active,
  store,
}: {
  session: SessionNode;
  workspacePath: string;
  active: boolean;
  store: ChatStore;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(session.title);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  const commitRename = async () => {
    const t = name.trim();
    if (t && t !== session.title) await store.renameSession(session.id, t);
    setRenaming(false);
  };

  return (
    <div className={`group relative flex items-center gap-1 rounded-lg px-2 py-1.5 ${active ? 'bg-neutral-100' : 'hover:bg-neutral-50'}`}>
      <button
        type="button"
        onClick={() => void store.openSession(workspacePath, session.id)}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        title={session.id}
      >
        {renaming ? (
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename();
              if (e.key === 'Escape') setRenaming(false);
            }}
            className="w-full rounded bg-white px-1 text-xs outline-none ring-1 ring-neutral-300"
            autoFocus
          />
        ) : (
          <>
            <span
              className={`truncate text-[13px] ${active ? 'font-medium text-neutral-900' : 'text-neutral-600'}`}
            >
              {session.pinned ? '📌 ' : ''}
              {session.title}
            </span>
            <span className="shrink-0 text-[11px] text-neutral-400">{relativeTime(session.ts)}</span>
          </>
        )}
      </button>

      <div className="hidden items-center gap-0.5 group-hover:flex">
        <button
          type="button"
          title="通知"
          onClick={() => void store.toggleNotify(session.id, !session.notify)}
          className={`rounded p-1 hover:bg-neutral-200 ${
            session.notify ? 'text-neutral-600' : 'text-neutral-400 hover:text-neutral-600'
          }`}
        >
          <BellIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="归档"
          onClick={() => void store.archiveSession(session.id)}
          className="rounded p-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-600"
        >
          <ArchiveIcon className="h-3.5 w-3.5" />
        </button>
        <div ref={menuRef} className="relative">
          <button
            type="button"
            title="更多"
            onClick={() => setMenuOpen((o) => !o)}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-600"
          >
            <DotsIcon className="h-3.5 w-3.5" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-40 mt-1 w-36 overflow-hidden rounded-lg border border-neutral-200 bg-white py-1 shadow-md">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setRenaming(true);
                  setName(session.title);
                }}
                className="block w-full px-3 py-1.5 text-left text-xs text-neutral-700 hover:bg-neutral-50"
              >
                重命名
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  void store.togglePin(session.id, !session.pinned);
                }}
                className="block w-full px-3 py-1.5 text-left text-xs text-neutral-700 hover:bg-neutral-50"
              >
                {session.pinned ? '取消置顶' : '置顶'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  store.exportSession(session.id);
                }}
                className="block w-full px-3 py-1.5 text-left text-xs text-neutral-700 hover:bg-neutral-50"
              >
                导出 jsonl
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function WorkspaceGroup({
  ws,
  collapsed,
  onToggle,
  store,
}: {
  ws: WorkspaceNode;
  collapsed: boolean;
  onToggle: () => void;
  store: ChatStore;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? ws.sessions : ws.sessions.slice(0, PAGE);
  const hidden = ws.sessions.length - visible.length;
  const label = ws.path ?? ws.slug;

  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left hover:bg-neutral-50"
      >
        <ChevronIcon
          className={`h-3 w-3 shrink-0 text-neutral-400 transition-transform ${collapsed ? '-rotate-90' : ''}`}
        />
        <FolderIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-neutral-800">{label}</span>
        <span className="text-[11px] text-neutral-400">{ws.sessions.length}</span>
      </button>
      {!collapsed && (
        <div className="ml-3 border-l border-neutral-100 pl-2">
          {visible.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              workspacePath={label}
              active={store.workspace === label && store.activeSessionId === s.id}
              store={store}
            />
          ))}
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-0.5 px-2 py-1 text-[11px] text-neutral-400 hover:text-neutral-600"
            >
              查看更多 ({hidden})
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Flat result row used while a session search query is active.
function SearchRow({
  session,
  workspaceLabel,
  store,
}: {
  session: SessionNode;
  workspaceLabel: string;
  store: ChatStore;
}) {
  return (
    <button
      type="button"
      onClick={() => void store.openSession(workspaceLabel, session.id)}
      className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-neutral-50"
    >
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-700">
          {session.pinned ? '📌 ' : ''}
          {session.title}
        </span>
        <span className="shrink-0 text-[11px] text-neutral-400">{relativeTime(session.ts)}</span>
      </div>
      <div className="truncate pl-0.5 text-[10px] text-neutral-400">{workspaceLabel}</div>
    </button>
  );
}

export function Sidebar({ store, onNavigate }: { store: ChatStore; onNavigate?: () => void }) {
  const [collapsedAll, setCollapsedAll] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');

  const goto = (fn: () => void) => {
    fn();
    onNavigate?.();
  };

  const q = query.trim().toLowerCase();
  const matches = q
    ? store.workspaces.flatMap((w) =>
        w.sessions
          .filter((s) => s.title.toLowerCase().includes(q))
          .map((s) => ({ session: s, label: w.path ?? w.slug })),
      )
    : [];

  return (
    <div className="flex h-full w-72 flex-col border-r border-neutral-200/70 bg-white">
      {/* brand + new chat */}
      <div className="flex items-center justify-between px-3 pb-1 pt-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-neutral-900 text-sm font-medium text-white">
            π
          </div>
          <span className="text-sm font-medium text-neutral-900">applepi</span>
        </div>
        <button
          type="button"
          onClick={() => goto(store.newSession)}
          className="rounded-lg px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
        >
          新对话
        </button>
      </div>

      {/* spaces header */}
      <div className="mt-2 flex items-center justify-between px-3 py-1">
        <button
          type="button"
          onClick={() => setCollapsedAll((c) => !c)}
          className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400 hover:text-neutral-600"
        >
          <ChevronIcon
            className={`h-3 w-3 transition-transform ${collapsedAll ? '-rotate-90' : ''}`}
          />
          空间 ({store.workspaces.reduce((n, w) => n + w.sessions.length, 0)})
        </button>
      </div>

      {/* session search */}
      <div className="px-3 pb-1">
        <div className="flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1.5 focus-within:border-neutral-300">
          <SearchIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话"
            className="w-full bg-transparent text-xs text-neutral-700 outline-none placeholder:text-neutral-400"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              title="清除"
              className="shrink-0 text-neutral-400 hover:text-neutral-600"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* workspace tree / search results */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {q ? (
          matches.length === 0 ? (
            <p className="px-2 py-4 text-xs text-neutral-400">无匹配会话</p>
          ) : (
            matches.map(({ session, label }) => (
              <SearchRow key={session.id} session={session} workspaceLabel={label} store={store} />
            ))
          )
        ) : store.workspaces.length === 0 ? (
          <p className="px-2 py-4 text-xs text-neutral-400">
            暂无工作区。在下方输入框附近选择「工作空间」添加。
          </p>
        ) : (
          store.workspaces.map((ws) => (
            <WorkspaceGroup
              key={ws.slug}
              ws={ws}
              collapsed={collapsedAll || collapsed[ws.slug] === true}
              onToggle={() => {
                if (collapsedAll) {
                  setCollapsedAll(false);
                  setCollapsed((c) => ({ ...c, [ws.slug]: false }));
                } else {
                  setCollapsed((c) => ({ ...c, [ws.slug]: !(c[ws.slug] === true) }));
                }
              }}
              store={store}
            />
          ))
        )}
      </div>

      {/* sidebar footer: new workspace */}
      <div className="border-t border-neutral-100 p-2">
        <button
          type="button"
          onClick={() => goto(store.newSession)}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-neutral-500 hover:bg-neutral-50 hover:text-neutral-800"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          新建会话
        </button>
      </div>
    </div>
  );
}
