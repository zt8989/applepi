'use client';

import type { ChatStore } from '@/lib/chat-store';
import { WorkspaceDropdown, WorkspacePillTrigger } from './workspace-dropdown';

/**
 * The pills row under the composer (base-style footer). The workspace picker
 * only appears on the first-screen new-session state (empty thread); once a
 * session exists the workspace is implicit. Permission selection now lives in
 * the composer toolbar, next to the "+" button.
 */
export function ComposerFooter({ store }: { store: ChatStore }) {
  const showWorkspace = !store.activeSessionId && store.messages.length === 0;
  const current = store.workspace
    ? store.workspaces.find((w) => w.path === store.workspace)
    : undefined;
  const pillLabel = store.workspace
    ? current?.name ?? store.workspace.split('/').pop() ?? store.workspace
    : '选择工作空间';
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
    </div>
  );
}
