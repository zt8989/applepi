import type { LanguageModelV1 } from 'ai';
import type { ZodType } from 'zod';

/**
 * How a tool call is gated in stream interfaces (web UI) before it executes
 * (ADR-0011): `auto` runs without asking; `ask` pauses the stream for an
 * explicit user decision. May be a function of the args so a tool can
 * classify per call (e.g. bash: read commands auto, writes ask). Absent ->
 * `ask` (conservative default). The CLI never consults this — its interactive
 * level model is unchanged.
 */
export type ApprovalMode = 'auto' | 'ask';

/** A tool registered on the harness by a bundle, capability, or plugin. */
export interface ToolSpec {
  name: string;
  description: string;
  /** Zod schema for the tool arguments (maps to Vercel AI SDK parameters). */
  parameters: ZodType<any>;
  execute: (args: any, ctx: Ctx) => Promise<string> | string;
  /** Stream-interface approval classification (ADR-0011). Default 'ask'. */
  approval?: ApprovalMode | ((args: any) => ApprovalMode | Promise<ApprovalMode>);
  /**
   * ask-only: when true, the approval card offers a free-text answer and the
   * answer is fed back as this tool call's result — the tool's `execute` is
   * NOT called (ask_user). Default false.
   */
  expectsAnswer?: boolean;
}

/** The model-facing shape of a tool (description + zod parameters, no execute). */
export interface ToolDef {
  description: string;
  parameters: ZodType<any>;
}

/**
 * Slash-command handler (user-only, registered on the harness). Returns the
 * text to print in the REPL. Since ADR-0015, handlers are core or app owned
 * and close over the harness/state they need — there is no extension `api`.
 */
export type SlashHandler = (arg: string) => string | Promise<string>;

/**
 * Per-request context threaded into tool `execute` (ADR-0015 security seam).
 * `loop`/`stream-loop` build one per tool call; the current permission level
 * is read via `getPermissionLevel(ctx)` from `session.scratch`, so every tool
 * self-determines its behavior (ADR-0009 Q4/Q6).
 */
export interface Ctx {
  /** Session-level state owned by the harness. */
  session: SessionContext;
  /** Generic mutable bag for tool coordination. */
  state: Record<string, any>;
  messages?: any[];
  toolName?: string;
  toolArgs?: any;
  toolResult?: string;
  [k: string]: any;
}

export interface SessionContext {
  /** Conversation history (any[] to stay loosely typed across AI SDK versions). */
  history: any[];
  /** Build-time immutable session config (workspace, mode) — ADR-0015. */
  config: Record<string, any>;
  /** In-memory state (permission level, loaded skills, memory mirror, ...). */
  scratch: Record<string, any>;
}

export type { LanguageModelV1 };
