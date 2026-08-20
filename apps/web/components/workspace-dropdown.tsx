'use client';

import { useEffect, useRef, useState } from 'react';
import type { WorkspaceNode } from '@/lib/chat-store';
import { ChevronIcon, FolderIcon, FolderOpenIcon, PlusIcon, SearchIcon } from './icons';

export interface WorkspaceDropdownProps {
  workspaces: WorkspaceNode[];
  current: string | null;
  onSelect: (workspacePath: string) => void;
  onAdd: (p: string) => Promise<string>;
  /** Render the trigger pill (folder icon + label + chevron). */
  trigger: (open: boolean) => React.ReactNode;
}

/**
 * Base-style workspace dropdown (reference shot): search field + folder list +
 * separator + 「新建工作空间」/「打开本地文件夹」(native macOS picker).
 */
export function WorkspaceDropdown({ workspaces, current, onSelect, onAdd, trigger }: WorkspaceDropdownProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'list' | 'add'>('list');
  const [query, setQuery] = useState('');
  const [path, setPath] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const filtered = query
    ? workspaces.filter((w) => (w.path ?? w.slug).toLowerCase().includes(query.toLowerCase()))
    : workspaces;

  const pick = (p: string) => {
    setOpen(false);
    setQuery('');
    setMode('list');
    setErr(null);
    onSelect(p);
  };

  const submitAdd = async () => {
    setErr(null);
    try {
      const p = await onAdd(path.trim());
      pick(p);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  };

  const pickNative = async () => {
    setErr(null);
    try {
      const res = await fetch('/api/pick-folder', { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      const { path: p } = (await res.json()) as { path: string };
      pick(p);
    } catch (e: any) {
      setMode('add');
      setPath('');
      setErr(e?.message ?? String(e));
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className="cursor-pointer">
        {trigger(open)}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-1 w-80 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-lg">
          {mode === 'list' ? (
            <>
              <div className="flex items-center gap-2 border-b border-neutral-100 px-3 py-2">
                <SearchIcon className="h-3.5 w-3.5 text-neutral-400" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索工作空间"
                  className="w-full bg-transparent text-sm outline-none placeholder:text-neutral-400"
                  autoFocus
                />
              </div>
              <div className="max-h-64 overflow-y-auto py-1">
                {filtered.length === 0 && (
                  <p className="px-3 py-3 text-xs text-neutral-400">没有匹配的工作空间</p>
                )}
                {filtered.map((w) => {
                  const label = w.path ?? w.slug;
                  const active = current === label;
                  return (
                    <button
                      key={w.slug}
                      type="button"
                      onClick={() => pick(label)}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-50 ${
                        active ? 'font-medium text-neutral-900' : 'text-neutral-600'
                      }`}
                    >
                      <FolderIcon className="h-4 w-4 shrink-0 text-neutral-400" />
                      <span className="flex-1 truncate">{label}</span>
                      {active && <span className="text-xs text-emerald-600">✓</span>}
                      {!active && w.sessions.length > 0 && (
                        <span className="text-[11px] text-neutral-400">{w.sessions.length}</span>
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="border-t border-neutral-100 p-1">
                <button
                  type="button"
                  onClick={() => {
                    setMode('add');
                    setErr(null);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50"
                >
                  <PlusIcon className="h-4 w-4 text-neutral-400" />
                  新建工作空间
                </button>
                <button
                  type="button"
                  onClick={() => void pickNative()}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50"
                >
                  <FolderOpenIcon className="h-4 w-4 text-neutral-400" />
                  打开本地文件夹
                </button>
              </div>
            </>
          ) : (
            <div className="p-3">
              <p className="mb-2 text-xs font-medium text-neutral-500">新建工作空间</p>
              <input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void submitAdd()}
                placeholder="/abs/path/to/workspace"
                className="w-full rounded-lg border border-neutral-200 px-2.5 py-1.5 font-mono text-xs outline-none focus:border-neutral-400"
                autoFocus
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void submitAdd()}
                  className="rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700"
                >
                  添加
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode('list');
                    setErr(null);
                  }}
                  className="rounded-lg px-2 py-1.5 text-xs text-neutral-500 hover:text-neutral-800"
                >
                  取消
                </button>
              </div>
              {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The base-style pill trigger used in the composer footer. */
export function WorkspacePillTrigger({ label, open }: { label: string; open: boolean }) {
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50">
      <FolderIcon className="h-3.5 w-3.5 text-neutral-400" />
      <span className="max-w-48 truncate">{label}</span>
      <ChevronIcon className={`h-3 w-3 text-neutral-400 transition-transform ${open ? 'rotate-180' : ''}`} />
    </span>
  );
}
