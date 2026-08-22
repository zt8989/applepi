import { createLlm, type Llm } from './llm.js';
import { SessionStore, slugWorkspace, type SessionMessage } from './session.js';
import {
  applyPermissionLevel,
  defaultSecurityPolicy,
  type SecurityPolicy,
} from './security.js';
import type { Ctx, SessionContext, SlashHandler, ToolSpec } from './types.js';

export interface HarnessOptions {
  /** Workspace slug override (defaults to slugWorkspace(process.cwd())). */
  workspace?: string;
  /**
   * Override the on-disk session root for the stores this harness creates.
   * Defaults to `~/.applepi/sessions` (SessionStore default). Tests inject a
   * temp dir so resume() never touches the real user config (ADR-0016 era —
   * same seam SessionStore already exposes).
   */
  baseDir?: string;
  /**
   * The security policy. Defaults to `defaultSecurityPolicy` (ADR-0009 Q7=b):
   * core always ships a working policy; supplying your own replaces it and
   * means self-responsibility for the level skeleton.
   */
  securityPolicy?: SecurityPolicy;
}

/**
 * The Harness shell (ADR-0015): wires the core deep modules — `llm`,
 * `stream-loop`, `session`, `config`, `security`, `trace` — into a runnable
 * agent and owns the shared in-memory state. It hosts NO capability-injection
 * mechanism: tools are registered directly (`registerTool`) by whoever
 * assembled the active bundle/plugin set, the flat system prompt is assembled
 * by the app (bundle fragments → app interface fragments → plugin tail) and
 * handed to `llm`, and tool execution goes straight to `executeTool` (the
 * security seam). Slash commands are plain registered handlers (no `api`).
 */
export class Harness {
  readonly workspace: string;
  readonly securityPolicy: SecurityPolicy;
  private readonly baseDir?: string;
  /**
   * The LLM-interaction deep module (ADR-0015): tool catalog + one model
   * response (generate/stream). `loop` consumes it; the harness shell owns it.
   */
  readonly llm: Llm;
  session: SessionContext = { history: [], config: {}, scratch: {} };
  sessionStore: SessionStore | null = null;
  private tools = new Map<string, ToolSpec>();
  private slashCommands = new Map<string, SlashHandler>();

  constructor(opts: HarnessOptions = {}) {
    this.workspace = opts.workspace ?? slugWorkspace(process.cwd());
    this.securityPolicy = opts.securityPolicy ?? defaultSecurityPolicy;
    this.baseDir = opts.baseDir;
    this.llm = createLlm({
      session: this.session,
      getTools: () => [...this.tools.values()],
    });
    // Core-owned `/level` — user-only; the model has no level-changing tool
    // (ADR-0007 Q7). Slash semantics stay core so the CLI and web share them.
    // The flat prompt needs no rebuild trigger: it is re-read each turn, so
    // the new level surfaces on the next turn.
    this.registerSlashCommand('level', (arg) =>
      applyPermissionLevel(this.session, this.sessionStore, arg),
    );
  }

  // ---- tools ---------------------------------------------------------------

  /** Register a tool (throws on duplicate name). */
  registerTool(spec: ToolSpec): void {
    if (this.tools.has(spec.name)) {
      throw new Error(`tool "${spec.name}" already registered`);
    }
    this.tools.set(spec.name, spec);
  }

  /** Unregister a tool by name (no-op if absent). */
  unregisterTool(name: string): void {
    this.tools.delete(name);
  }

  /** Look up a registered tool by name (undefined if absent). */
  getTool(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  /** All currently-registered tools. */
  getTools(): ToolSpec[] {
    return [...this.tools.values()];
  }

  /**
   * Convert registered tools into Vercel AI SDK tool defs (no execute).
   * No cropping since ADR-0009 (Q8=b): the model always sees the full surface.
   * Delegates to the `llm` module's tool-catalog builder.
   */
  buildToolDefs(): Record<string, { description: string; parameters: ToolSpec['parameters'] }> {
    return this.llm.buildToolDefs() as Record<string, { description: string; parameters: ToolSpec['parameters'] }>;
  }

  // ---- slash commands --------------------------------------------------------

  /** Register a slash command; dispatch checks these before built-ins. */
  registerSlashCommand(name: string, handler: SlashHandler): void {
    const key = name.replace(/^\//, '');
    if (this.slashCommands.has(key)) {
      throw new Error(`slash command "/${key}" already registered`);
    }
    this.slashCommands.set(key, handler);
  }

  /** Look up a registered slash command (undefined if absent). */
  getSlashCommand(name: string): SlashHandler | undefined {
    return this.slashCommands.get(name.replace(/^\//, ''));
  }

  // ---- session ----------------------------------------------------------------

  /** Restore policy state (permission level) from the attached session store. */
  async restoreSecurity(store: SessionStore): Promise<void> {
    await this.securityPolicy.restore(store, this.session);
  }

  /** Point the harness at a session store (the only wiring `attachSession` does). */
  attachSession(store: SessionStore): void {
    this.sessionStore = store;
  }

  /** Switch the active session to `id`; load its history (replay). Missing → new. */
  async resume(id: string): Promise<SessionStore> {
    const ws = this.sessionStore?.workspace ?? this.workspace;
    const store = new SessionStore({ workspace: ws, sessionId: id, baseDir: this.baseDir });
    let loaded: { messages: SessionMessage[] };
    try {
      loaded = await store.load();
    } catch {
      await store.create(id);
      loaded = { messages: [] };
    }
    this.sessionStore = store;
    // Drop the system prompt (re-assembled by the app per turn); keep the
    // conversation turns.
    this.session.history = (loaded.messages ?? []).filter((m) => m.role !== 'system');
    // Restore the persisted session config (ADR-0016: workspace/mode identity,
    // resumed from the config file — self-contained, no manifest dependency).
    this.session.config = await store.loadConfig();
    return store;
  }

  // ---- tool execution (security seam, ADR-0015) --------------------------------

  /** Innermost handler for a tool call: execute the resolved tool. */
  async executeTool(ctx: Ctx): Promise<void> {
    const tool = this.tools.get(ctx.toolName!);
    if (!tool) {
      ctx.toolResult = `ERROR: unknown tool ${ctx.toolName}`;
      return;
    }
    try {
      ctx.toolResult = await tool.execute(ctx.toolArgs ?? {}, ctx);
    } catch (e: any) {
      ctx.toolResult = `ERROR: ${e?.message ?? e}`;
    }
  }
}
