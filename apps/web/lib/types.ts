/** Shared API contract between the web client and the Next.js route handlers. */

export interface ChatRequestBody {
  /** Absolute path of the selected workspace (tools operate here). */
  workspace: string;
  /** Absent on the first message of a new session. */
  sessionId?: string;
  /** Assistant message id, owned by the client, reused across segments. */
  messageId: string;
  /** The user's message text. */
  message: string;
  /** Optional permission level for a brand-new session (no sessionId yet). */
  level?: string;
  /** Optional pre-chosen reasoning level for a brand-new session. */
  reasoning?: string;
}

export interface ApproveRequestBody {
  workspace: string;
  sessionId: string;
  messageId: string;
  toolCallId: string;
  decision: 'approve' | 'deny';
}

export interface PendingApprovalInfo {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface SessionSummary {
  id: string;
  title: string;
  ts: string;
  pinned: boolean;
  notify?: boolean;
}

export interface WorkspaceInfo {
  slug: string;
  /** Human path from the manifest, when recorded. */
  path?: string;
  /** Display name: last path segment (basename), e.g. `applepi`. */
  name?: string;
  sessions: SessionSummary[];
}

/** A serialized session message line (SessionStore replay, no system role). */
export interface HydratedMessage {
  role: 'user' | 'assistant' | 'tool';
  content: any;
}
