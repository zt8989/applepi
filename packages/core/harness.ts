import { OnionBus } from './bus.js';
import { runLoop, type LlmCall } from './loop.js';
import { SessionStore, slugWorkspace, type SessionMessage } from './session.js';
import type {
  Ctx,
  HarnessApi,
  HookStack,
  Middleware,
  SessionContext,
  SetupFn,
  SystemPromptContributor,
  ToolSpec,
} from './types.js';

interface Contributor {
  label: string;
  fn: SystemPromptContributor;
}

export interface RunOpts {
  maxTurns?: number;
  llmCall?: LlmCall;
  /** Persist a `system_prompt` event + message line. True on session start / /reload. */
  emitSystemPrompt?: boolean;
}

export class Harness {
  readonly bus = new OnionBus();
  readonly workspace: string;
  session: SessionContext = { history: [], config: {}, scratch: {} };
  sessionStore: SessionStore | null = null;
  private tools = new Map<string, ToolSpec>();
  private systemPromptContributors: Contributor[] = [];

  constructor(opts: { workspace?: string } = {}) {
    this.workspace = opts.workspace ?? slugWorkspace(process.cwd());
  }

  readonly api: HarnessApi = {
    registerTool: (spec: ToolSpec) => {
      if (this.tools.has(spec.name)) {
        throw new Error(`tool "${spec.name}" already registered`);
      }
      this.tools.set(spec.name, spec);
    },
    use: (stack: HookStack, mw: Middleware, opts?: { priority?: number }) =>
      this.bus.use(stack, mw, opts),
    addSystemPromptContributor: (fn: SystemPromptContributor, label?: string) => {
      this.systemPromptContributors.push({
        label: label ?? `contributor-${this.systemPromptContributors.length}`,
        fn,
      });
    },
    ctx: this.session,
    getTools: () => [...this.tools.values()],
  };

  /** Register an extension by its setup(api) function. */
  registerExtension(fn: SetupFn): void {
    fn(this.api);
  }

  /**
   * Scan a directory for `*.ext.{ts,js,mjs}` files and register each.
   * Any file exporting `setup` (or default) as a SetupFn is wired in.
   * Missing directory is treated as "no extensions" (non-fatal).
   */
  async loadExtensionsFromDir(dir: string): Promise<string[]> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    let files: string[] = [];
    try {
      files = await fs.readdir(dir);
    } catch {
      return [];
    }
    const loaded: string[] = [];
    const extFiles = files.filter((f) => /\.ext\.(ts|js|mjs)$/.test(f));
    for (const f of extFiles) {
      const mod = await import(path.join(dir, f));
      const setup = (mod.setup ?? mod.default) as SetupFn | undefined;
      if (typeof setup === 'function') {
        this.registerExtension(setup);
        loaded.push(f);
      }
    }
    return loaded;
  }

  /** Convert registered tools into Vercel AI SDK tool defs (no execute). */
  buildToolDefs(): Record<string, { description: string; parameters: ToolSpec['parameters'] }> {
    const defs: Record<string, { description: string; parameters: ToolSpec['parameters'] }> = {};
    for (const t of this.tools.values()) {
      defs[t.name] = { description: t.description, parameters: t.parameters };
    }
    return defs;
  }

  /** Assemble the system prompt from all registered contributors (base + extensions). */
  async buildSystemPrompt(): Promise<string> {
    const parts = await Promise.all(
      this.systemPromptContributors.map((c) => c.fn(this.session)),
    );
    return parts.filter((p) => typeof p === 'string' && p.length > 0).join('\n\n');
  }

  /** Labels of the registered contributors (for the system_prompt event payload). */
  contributorSections(): string[] {
    return this.systemPromptContributors.map((c) => c.label);
  }

  /** Attach a session store and install the skill-load event logger (tool stack). */
  attachSession(store: SessionStore): void {
    this.sessionStore = store;
    this.bus.use(
      'tool',
      async (ctx: Ctx, next) => {
        if (ctx.toolName === 'skill_load') {
          const name = ctx.toolArgs?.name;
          const source = ctx.toolArgs?.content
            ? 'content'
            : ctx.toolArgs?.path
              ? 'path'
              : 'unknown';
          await this.sessionStore?.appendEvent('skill/start', { name, source });
          await next();
          const res = ctx.toolResult ?? '';
          const ok = !res.startsWith('ERROR');
          await this.sessionStore?.appendEvent('skill/end', {
            ok,
            error: ok ? undefined : res,
          });
        } else {
          await next();
        }
      },
      { priority: 2 },
    );
  }

  /** Persist a fresh `system_prompt` event + message line (no user turn side effects). */
  async emitSystemPrompt(): Promise<string> {
    const systemPrompt = await this.buildSystemPrompt();
    if (this.sessionStore) {
      const sections = this.contributorSections();
      await this.sessionStore.appendEvent('system_prompt/start', { sections });
      await this.sessionStore.appendMessage('system', systemPrompt);
      await this.sessionStore.appendEvent('system_prompt/end', { sections });
    }
    return systemPrompt;
  }

  /** Enumerate sessions in the current workspace (delegates to core SessionStore). */
  listSessions(): Promise<string[]> {
    const ws = this.sessionStore?.workspace ?? this.workspace;
    return new SessionStore({ workspace: ws }).list();
  }

  /** Switch the active session to `id`; load its history (replay). Missing → new. */
  async resume(id: string): Promise<SessionStore> {
    const ws = this.sessionStore?.workspace ?? this.workspace;
    const store = new SessionStore({ workspace: ws, sessionId: id });
    let loaded: { messages: SessionMessage[] };
    try {
      loaded = await store.load();
    } catch {
      await store.create(id);
      loaded = { messages: [] };
    }
    this.sessionStore = store;
    // Drop the system prompt (rebuilt at run time); keep the conversation turns.
    this.session.history = (loaded.messages ?? []).filter((m) => m.role !== 'system');
    return store;
  }

  /** Innermost handler for the tool stack: execute the resolved tool. */
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

  /** Run a full session turn: persist system/user/assistant/tool, record history. */
  async run(prompt: string, model: any, opts: RunOpts = {}): Promise<any[]> {
    const emitSystem = opts.emitSystemPrompt ?? false;
    const systemPrompt = await this.buildSystemPrompt();

    const messages: any[] = [];
    if (emitSystem && this.sessionStore) {
      const sections = this.contributorSections();
      await this.sessionStore.appendEvent('system_prompt/start', { sections });
      await this.sessionStore.appendMessage('system', systemPrompt);
      await this.sessionStore.appendEvent('system_prompt/end', { sections });
    }
    messages.push({ role: 'system', content: systemPrompt });
    messages.push(...this.session.history);

    const userMsg = { role: 'user', content: prompt };
    messages.push(userMsg);
    await this.sessionStore?.appendMessage('user', prompt);

    const ctx: Ctx = { session: this.session, state: {}, messages };
    await this.bus.run('session', ctx, async () => {
      await runLoop(this, messages, {
        model,
        maxTurns: opts.maxTurns,
        llmCall: opts.llmCall,
        onMessage: this.sessionStore
          ? (role, content) => {
              this.sessionStore!.appendMessage(role, content);
            }
          : undefined,
      });
    });

    // Persist only conversation turns; the system prompt is rebuilt on each run.
    this.session.history = messages.filter((m) => m.role !== 'system');
    return messages;
  }
}
