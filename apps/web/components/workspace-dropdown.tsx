'use client';

import { useEffect, useRef, useState } from 'react';
import type { WorkspaceNode } from '@/lib/chat-store';
import { ChevronIcon, FolderIcon, FolderOpenIcon, SearchIcon } from './icons';

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
 * separator + 「添加工作区」(native macOS picker, same as the sidebar).
 */
export function WorkspaceDropdown({ workspaces, current, onSelect, onAdd, trigger }: WorkspaceDropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
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
    onSelect(p);
  };

  const addViaPicker = async () => {
    try {
      const res = await fetch('/api/pick-folder', { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      const { path: p } = (await res.json()) as { path: string };
      if (!p) return;
      const added = await onAdd(p);
      pick(added);
    } catch (e: any) {
      window.alert(`添加工作区失败：${e?.message ?? String(e)}`);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className="cursor-pointer">
        {trigger(open)}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-1 w-80 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-lg">
          <div className="flex items-center gap-2 border-b border-neutral-100 px-3 py-2">
            <SearchIcon className="h-3.5 w-3.5 text-neutral-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索工作区"
              className="w-full bg-transparent text-sm outline-none placeholder:text-neutral-400"
              autoFocus
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <p className="px-3 py-3 text-xs text-neutral-400">没有匹配的工作区</p>
            )}
            {filtered.map((w) => {
              const label = w.name ?? w.path ?? w.slug;
              const fullPath = w.path ?? w.slug;
              const active = current === fullPath;
              return (
                <button
                  key={w.slug}
                  type="button"
                  onClick={() => pick(fullPath)}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-50 ${
                    active ? 'font-medium text-neutral-900' : 'text-neutral-600'
                  }`}
                  title={fullPath}
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
              onClick={() => void addViaPicker()}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50"
            >
              <FolderOpenIcon className="h-4 w-4 text-neutral-400" />
              添加工作区
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The base-style pill trigger used in the composer footer. */
export function WorkspacePillTrigger({ label, open, title }: { label: string; open: boolean; title?: string }) {
  return (
    <span
      title={title ?? label}
      className="flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50"
    >
      <FolderIcon className="h-3.5 w-3.5 text-neutral-400" />
      <span className="max-w-48 truncate">{label}</span>
      <ChevronIcon className={`h-3 w-3 text-neutral-400 transition-transform ${open ? 'rotate-180' : ''}`} />
    </span>
  );
}
