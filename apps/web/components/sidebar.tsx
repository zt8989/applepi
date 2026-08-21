'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { ChatStore, SessionNode, WorkspaceNode } from '@/lib/chat-store';
import {
  ArchiveIcon,
  BellIcon,
  ChevronIcon,
  DotsIcon,
  FolderIcon,
  PanelLeftIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
} from './icons';
import { Modal } from './modal';
import { useSettings } from './settings-provider';

/**
 * Open the native macOS folder picker (POST /api/pick-folder) and return the
 * chosen absolute path, or null if the user cancelled / the picker errored.
 */
async function pickNativeFolder(): Promise<string | null> {
  try {
    const res = await fetch('/api/pick-folder', { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    const { path } = (await res.json()) as { path: string };
    return path || null;
  } catch {
    return null;
  }
}

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
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const label = ws.name ?? ws.path ?? ws.slug;
  const fullPath = ws.path ?? ws.slug;
  const [renameValue, setRenameValue] = useState(label);
  const [busy, setBusy] = useState(false);
  const visible = expanded ? ws.sessions : ws.sessions.slice(0, PAGE);
  const hidden = ws.sessions.length - visible.length;

  const openRename = () => {
    setMenuOpen(false);
    setRenameValue(label);
    setRenameOpen(true);
  };

  const submitRename = async () => {
    const next = renameValue.trim();
    if (!next) return;
    setBusy(true);
    try {
      await store.renameWorkspace(ws.slug, next);
      setRenameOpen(false);
    } catch (e) {
      window.alert(`重命名失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const openRemove = () => {
    setMenuOpen(false);
    setRemoveOpen(true);
  };

  const submitRemove = async () => {
    setBusy(true);
    try {
      await store.removeWorkspace(ws.slug);
      setRemoveOpen(false);
    } catch (e) {
      window.alert(`移除失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // 「+」：在该工作区下新建会话（若当前活动工作区不是它，先切换过去）。
  const handleNewSession = () => {
    if (store.workspace !== fullPath) store.setWorkspace(fullPath);
    store.newSession();
  };

  return (
    <div className="group/ws relative mb-1">
      <div className="flex items-center rounded-lg hover:bg-neutral-50">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left"
          title={fullPath}
        >
          <ChevronIcon
            className={`h-3 w-3 shrink-0 text-neutral-400 transition-transform ${collapsed ? '-rotate-90' : ''}`}
          />
          <FolderIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-neutral-800">{label}</span>
        </button>
        <div className="relative flex shrink-0 items-center pr-1">
          <div
            className={`flex items-center ${
              menuOpen ? 'opacity-100' : 'opacity-0 group-hover/ws:opacity-100'
            }`}
          >
            <button
              type="button"
              title="更多"
              onClick={() => setMenuOpen((o) => !o)}
              className="rounded p-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-600"
            >
              <DotsIcon className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="新建会话"
              onClick={handleNewSession}
              className="rounded p-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-600"
            >
              <PlusIcon className="h-3.5 w-3.5" />
            </button>
          </div>
          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setMenuOpen(false)}
              />
              <div className="absolute right-0 top-8 z-20 w-28 overflow-hidden rounded-lg border border-neutral-200 bg-white py-1 shadow-lg">
                <button
                  type="button"
                  onClick={openRename}
                  className="block w-full px-3 py-1.5 text-left text-xs text-neutral-700 hover:bg-neutral-50"
                >
                  重命名
                </button>
                <button
                  type="button"
                  onClick={openRemove}
                  className="block w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50"
                >
                  移除
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      {!collapsed && (
        <div className="ml-3 border-l border-neutral-100 pl-2">
          {visible.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              workspacePath={fullPath}
              active={store.workspace === fullPath && store.activeSessionId === s.id}
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

      <Modal open={renameOpen} onClose={() => setRenameOpen(false)} title="重命名工作区">
        <p className="truncate text-xs text-neutral-400" title={fullPath}>
          {fullPath}
        </p>
        <input
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submitRename()}
          maxLength={80}
          autoFocus
          className="mt-2 w-full rounded-lg border border-neutral-200 px-2.5 py-1.5 text-sm text-neutral-900 outline-none focus:border-neutral-400"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setRenameOpen(false)}
            className="rounded-lg px-3 py-1.5 text-xs text-neutral-500 hover:text-neutral-800"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void submitRename()}
            disabled={busy || !renameValue.trim()}
            className="rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
          >
            保存
          </button>
        </div>
      </Modal>

      <Modal open={removeOpen} onClose={() => setRemoveOpen(false)} title="移除工作区">
        <p className="text-xs text-neutral-500">
          确定从侧栏移除「<span className="font-medium text-neutral-800">{label}</span>」？
        </p>
        <p className="mt-2 text-[11px] text-neutral-400">
          会话文件会保留在磁盘，重新添加路径即可恢复。
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setRemoveOpen(false)}
            className="rounded-lg px-3 py-1.5 text-xs text-neutral-500 hover:text-neutral-800"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void submitRemove()}
            disabled={busy}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            移除
          </button>
        </div>
      </Modal>
    </div>
  );
}

// Flat result row used while a session search query is active.
function SearchRow({
  session,
  workspaceName,
  workspacePath,
  store,
}: {
  session: SessionNode;
  workspaceName: string;
  workspacePath: string;
  store: ChatStore;
}) {
  return (
    <button
      type="button"
      onClick={() => void store.openSession(workspacePath, session.id)}
      className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-neutral-50"
    >
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-700">
          {session.pinned ? '📌 ' : ''}
          {session.title}
        </span>
        <span className="shrink-0 text-[11px] text-neutral-400">{relativeTime(session.ts)}</span>
      </div>
      <div className="truncate pl-0.5 text-[10px] text-neutral-400">{workspaceName}</div>
    </button>
  );
}

export function Sidebar({ store, onNavigate }: { store: ChatStore; onNavigate?: () => void }) {
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const goto = (fn: () => void) => {
    fn();
    onNavigate?.();
  };

  // 工作区「+」：用原生文件夹选择器打开（添加）一个工作区，并立即在其下新建会话。
  const handleAddWorkspace = async () => {
    const path = await pickNativeFolder();
    if (!path) return;
    try {
      const ws = await store.addWorkspace(path);
      store.setWorkspace(ws);
      store.newSession();
      onNavigate?.();
    } catch (e) {
      window.alert(`添加工作区失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // 「新会话」按钮：若存在活动工作区则在其下新建会话；否则先添加工作区。
  const handleNewSession = async () => {
    if (!store.workspace) {
      const path = await pickNativeFolder();
      if (!path) return;
      try {
        const ws = await store.addWorkspace(path);
        store.setWorkspace(ws);
      } catch (e) {
        window.alert(`添加工作区失败：${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    goto(store.newSession);
  };

  const q = query.trim().toLowerCase();
  const matches = q
    ? store.workspaces.flatMap((w) =>
        w.sessions
          .filter((s) => s.title.toLowerCase().includes(q))
          .map((s) => ({
            session: s,
            name: w.name ?? w.path ?? w.slug,
            path: w.path ?? w.slug,
          })),
      )
    : [];

  return (
    <div
      className={`flex h-full shrink-0 flex-col border-r border-neutral-200/70 bg-white transition-all duration-200 ${
        collapsed ? 'w-14 items-center px-1' : 'w-72'
      }`}
    >
      {/* brand */}
      <div
        className={`flex items-center justify-between pt-3 ${
          collapsed ? 'px-1 pb-1' : 'px-3 pb-2'
        }`}
      >
        {collapsed ? (
          // 折叠态：隐藏独立开关，logo 本身即开关，hover 时 π 变为展开图标
          <button
            type="button"
            title="展开"
            onClick={() => setCollapsed(false)}
            className="group flex h-7 w-7 items-center justify-center rounded-lg bg-neutral-900 text-sm font-medium text-white hover:bg-neutral-700"
          >
            <span className="transition-opacity group-hover:hidden">π</span>
            <PanelLeftIcon className="hidden h-3.5 w-3.5 text-white group-hover:block" />
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-neutral-900 text-sm font-medium text-white">
              π
            </div>
            <span className="text-sm font-medium text-neutral-900">applepi</span>
          </div>
        )}
        {!collapsed && (
          <button
            type="button"
            title="折叠"
            onClick={() => setCollapsed(true)}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
          >
            <PanelLeftIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* new session */}
      {collapsed ? (
        <button
          type="button"
          title="新会话"
          onClick={() => void handleNewSession()}
          className="mt-2 rounded-lg p-2 text-neutral-500 hover:bg-neutral-100"
        >
          <PlusIcon className="h-4 w-4" />
        </button>
      ) : (
        <div className="px-3 py-2">
          <button
            type="button"
            onClick={() => void handleNewSession()}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-700 hover:border-neutral-300 hover:bg-neutral-50"
          >
            <PlusIcon className="h-4 w-4" />
            新会话
          </button>
        </div>
      )}

      {!collapsed && (
        <>
          {/* workspace header */}
          <div className="mt-1 flex items-center justify-between px-3 py-1.5">
            <span className="text-xs font-medium text-neutral-400">工作区</span>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                title="搜索会话"
                onClick={() => searchRef.current?.focus()}
                className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
              >
                <SearchIcon className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                title="添加工作区"
                onClick={() => void handleAddWorkspace()}
                className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
              >
                <PlusIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* session search */}
          <div className="px-3 pb-1">
            <div className="flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1.5 focus-within:border-neutral-300">
              <SearchIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
              <input
                ref={searchRef}
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
                matches.map(({ session, name, path }) => (
                  <SearchRow key={session.id} session={session} workspaceName={name} workspacePath={path} store={store} />
                ))
              )
            ) : store.workspaces.length === 0 ? (
              <p className="px-2 py-4 text-xs text-neutral-400">
                暂无工作区。点击上方「+」添加一个工作区。
              </p>
            ) : (
              store.workspaces.map((ws) => (
                <WorkspaceGroup
                  key={ws.slug}
                  ws={ws}
                  collapsed={collapsedGroups[ws.slug] === true}
                  onToggle={() =>
                    setCollapsedGroups((c) => ({ ...c, [ws.slug]: !(c[ws.slug] === true) }))
                  }
                  store={store}
                />
              ))
            )}
          </div>
        </>
      )}

      {/* settings */}
      <div
        className={`mt-auto border-t border-neutral-100 py-2 ${
          collapsed ? 'px-1' : 'px-3'
        }`}
      >
        <SettingsTrigger collapsed={collapsed} />
      </div>
    </div>
  );
}

function SettingsTrigger({ collapsed }: { collapsed: boolean }) {
  const { open } = useSettings();
  return (
    <button
      type="button"
      onClick={open}
      className={`flex items-center gap-2 rounded-lg text-left text-sm font-medium text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900 ${
        collapsed ? 'justify-center p-2' : 'px-2 py-1.5'
      }`}
    >
      <SettingsIcon className="h-4 w-4" />
      {!collapsed && '设置'}
    </button>
  );
}
