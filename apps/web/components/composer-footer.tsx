'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChatStore } from '@/lib/chat-store';
import { WorkspaceDropdown, WorkspacePillTrigger } from './workspace-dropdown';
import { ChevronIcon, ShieldIcon } from './icons';

const LEVEL_LABELS: Record<string, { label: string; desc: string }> = {
  readonly: { label: '只读', desc: '可读任意位置，禁止所有写入' },
  workspace: { label: '工作区', desc: '可写限定在工作区内（默认）' },
  fullaccess: { label: '完全访问', desc: '读写任意位置（仍受危险命令黑名单约束）' },
};

function PermissionDropdown({
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

  const meta = LEVEL_LABELS[level] ?? LEVEL_LABELS.workspace;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex cursor-pointer items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50"
        title="权限级别（工具按级别自决）"
      >
        <ShieldIcon className="h-3.5 w-3.5 text-neutral-400" />
        <span>{meta.label}</span>
        <ChevronIcon className={`h-3 w-3 text-neutral-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-1 w-64 overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 shadow-lg">
          {Object.entries(LEVEL_LABELS).map(([key, v]) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                onChange(key);
                setOpen(false);
              }}
              className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-neutral-50"
            >
              <span className={`mt-0.5 text-sm ${level === key ? 'text-neutral-900' : 'text-neutral-500'}`}>
                {level === key ? '✓' : ''}
              </span>
              <span>
                <span className={`block text-sm ${level === key ? 'font-medium text-neutral-900' : 'text-neutral-700'}`}>
                  {v.label}
                </span>
                <span className="block text-[11px] text-neutral-400">{v.desc}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The pills row under the composer (base-style footer). The workspace picker
 * only appears on the first-screen new-session state (empty thread); once a
 * session exists the workspace is implicit. The permission pill is always
 * available.
 */
export function ComposerFooter({ store }: { store: ChatStore }) {
  const showWorkspace = !store.activeSessionId && store.messages.length === 0;
  const current = store.workspace
    ? store.workspaces.find((w) => w.path === store.workspace)
    : undefined;
  const pillLabel = store.workspace
    ? current?.name ?? store.workspace.split('/').pop() ?? store.workspace
    : '选择工作区';
  return (
    <div className="flex flex-wrap items-center gap-2 px-1 pt-2">
      {showWorkspace && (
        <WorkspaceDropdown
          workspaces={store.workspaces}
          current={store.workspace}
          onSelect={store.setWorkspace}
          onAdd={store.addWorkspace}
          trigger={(open) => (
            <WorkspacePillTrigger label={pillLabel} open={open} title={store.workspace ?? undefined} />
          )}
        />
      )}
      <PermissionDropdown level={store.level} onChange={(l) => void store.setLevel(l)} />
    </div>
  );
}
