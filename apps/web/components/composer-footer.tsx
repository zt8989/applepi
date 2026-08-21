'use client';

import type { ChatStore } from '@/lib/chat-store';
import { WorkspaceDropdown, WorkspacePillTrigger } from './workspace-dropdown';

/**
 * The pills row under the composer (base-style footer). The workspace picker
 * and the bundle/mode picker only appear on the first-screen new-session state
 * (empty thread); once a session exists the workspace and mode are implicit.
 * Permission selection now lives in the composer toolbar, next to the "+"
 * button.
 */

const MODES: { id: string; label: string; desc: string }[] = [
  { id: 'standard', label: 'standard', desc: '全量能力（工具 + 记忆 + 技能）' },
  { id: 'base', label: 'base', desc: '极简：仅 bash 与文件编辑' },
];

/** A base/standard bundle picker for the new session (ADR-0015 mode selection). */
function ModeChip({ store }: { store: ChatStore }) {
  return (
    <div className="relative inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white px-2 py-1 pl-1 text-xs text-neutral-600 shadow-sm">
      <span className="pl-0.5">模式</span>
      <select
        value={store.mode}
        onChange={(e) => store.setMode(e.target.value)}
        className="cursor-pointer appearance-none rounded-full bg-neutral-100 px-2 py-0.5 pr-5 font-medium text-neutral-800 outline-none hover:bg-neutral-200"
        title="新会话的能力模式（创建后不可切换）"
        aria-label="选择新会话模式"
      >
        {MODES.map((m) => (
          <option key={m.id} value={m.id} title={m.desc}>
            {m.label}
          </option>
        ))}
      </select>
    </div>
  );
}

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
        <>
          <ModeChip store={store} />
          <WorkspaceDropdown
            workspaces={store.workspaces}
            current={store.workspace}
            onSelect={store.setWorkspace}
            onAdd={store.addWorkspace}
            trigger={(open) => (
              <WorkspacePillTrigger label={pillLabel} open={open} title={store.workspace ?? undefined} />
            )}
          />
        </>
      )}
    </div>
  );
}
