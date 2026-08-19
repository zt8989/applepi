import { OnionBus } from './bus.js';
import { runLoop, type LlmCall } from './loop.js';
import { SessionStore, slugWorkspace, type SessionMessage } from './session.js';
import { defaultSecurityPolicy, type SecurityPolicy } from './security.js';
import { PROMPT_BLOCKS, type PromptBlockName } from './types.js';
import type {
  Ctx,
  HarnessApi,
  HookStack,
  Middleware,
  PromptBag,
  SessionContext,
  SetupFn,
  SlashHandler,
  ToolSpec,
} from './types.js';

export interface RunOpts {
  maxTurns?: number;
  llmCall?: LlmCall;
  /** Also persist the built system prompt this run (start event + message +
   *  end event) via the single `persistSystemPrompt` path. True on session
   *  start / /reload; false on ordinary turns. */
  persistSystemPrompt?: boolean;
}

/** Result of one system-prompt build (ADR-0010). */
export interface BuiltSystemPrompt {
  prompt: string;
  /** Canonical block names that actually contributed content this build. */
  sections: string[];
}

/** Build-time prompt accumulator: 3 arrays + `set` (ADR-0010 Q5/Q7/Q14). */
export function createPromptBag(): PromptBag {
  const bag: PromptBag = {
    base: [],
    permission: [],
    skills: [],
    set(block, value) {
      bag[block] = typeof value === 'function' ? value(bag[block]) : value;
    },
  };
  return bag;
}

/**
 * The event names that trigger a full prompt rebuild. `system_prompt` is the
 * blanket entry (session start / `/reload` / `/new`); `system_prompt/<block>`
 * are semantic triggers recording WHICH block changed (ADR-0010 Q9/Q12).
 */
const PROMPT_REBUILD_EVENTS = ['system_prompt', ...PROMPT_BLOCKS.map((b) => `system_prompt/${b}`)];

export interface HarnessOptions {
  /** Workspace slug override (defaults to slugWorkspace(process.cwd())). */
  workspace?: string;
  /**
   * The security policy. Defaults to `defaultSecurityPolicy` (ADR-0009 Q7=b):
   * core always ships a working policy; supplying your own replaces it and
   * means self-responsibility for the level skeleton.
   */
  securityPolicy?: SecurityPolicy;
}

/**
 * Everything one extension registered during `setup`, tracked so a reload can
 * revoke it (ADR-0009 Q13=b: core tracks registration scopes automatically).
 */
interface ExtensionScope {
  tools: string[];
  middlewares: { stack: HookStack; mw: Middleware }[];
  slashCommands: string[];
  /** Cleanups returned by `useEffect` calls, run in registration order. */
  effects: (() => void)[];
}

export class Harness {
  readonly bus = new OnionBus();
  readonly workspace: string;
  readonly securityPolicy: SecurityPolicy;
  session: SessionContext = { history: [], config: {}, scratch: {} };
  sessionStore: SessionStore | null = null;
  private tools = new Map<string, ToolSpec>();
  private slashCommands = new Map<string, SlashHandler>();
  /** Core event handlers: `system_prompt` is handled here; everything else
   *  falls back to writing a lifecycle event line (ADR-0008 follow-up). */
  private eventHandlers = new Map<string, (payload: any) => Promise<any>>();

  // Extension lifecycle (ADR-0009): the scope being set up right now, and all
  // scopes recorded since construction, so reloadExtensions() can revoke them.
  private currentScope: ExtensionScope | null = null;
  private scopes: ExtensionScope[] = [];

  constructor(opts: HarnessOptions = {}) {
    this.workspace = opts.workspace ?? slugWorkspace(process.cwd());
    this.securityPolicy = opts.securityPolicy ?? defaultSecurityPolicy;
    // Prompt rebuild is a core-handled event family: `system_prompt` (blanket)
    // and `system_prompt/<block>` (semantic triggers) all rebuild ALL blocks
    // (rebuild-all, Q4) and persist ONE complete system message, returning
    // { prompt, sections } so callers can log sections.
    for (const ev of PROMPT_REBUILD_EVENTS) {
      this.eventHandlers.set(ev, async () => {
        const built = await this.buildSystemPrompt();
        await this.persistSystemPrompt(built);
        return built;
      });
    }
    // Core-owned registrations (survive extension reload).
    this.securityPolicy.install(this.api);
  }

  /**
   * Publish an event (single entry for all events, ADR-0008 follow-up).
   * Handled events (the prompt-rebuild family: `system_prompt` and
   * `system_prompt/<block>`) run their handler; any other event writes a
   * lifecycle event line to the session store (P7), if attached.
   */
  async emit(event: string, payload: any = {}): Promise<any> {
    const handler = this.eventHandlers.get(event);
    if (handler) return handler(payload);
    await this.sessionStore?.appendEvent(event, payload);
  }

  readonly api: HarnessApi = {
    registerTool: (spec: ToolSpec) => {
      if (this.tools.has(spec.name)) {
        throw new Error(`tool "${spec.name}" already registered`);
      }
      this.tools.set(spec.name, spec);
      this.currentScope?.tools.push(spec.name);
    },
    use: (stack: HookStack, mw: Middleware, opts?: { priority?: number }) => {
      this.bus.use(stack, mw, opts);
      this.currentScope?.middlewares.push({ stack, mw });
    },
    useEffect: (effect: () => (() => void) | void) => {
      const cleanup = effect();
      if (typeof cleanup === 'function') this.currentScope?.effects.push(cleanup);
    },
    registerSlashCommand: (name: string, handler: SlashHandler) => {
      const key = name.replace(/^\//, '');
      if (this.slashCommands.has(key)) {
        throw new Error(`slash command "/${key}" already registered`);
      }
      this.slashCommands.set(key, handler);
      this.currentScope?.slashCommands.push(key);
    },
    getSlashCommand: (name: string) =>
      this.slashCommands.get(name.replace(/^\//, '')),
    emit: (event: string, payload?: any) => this.emit(event, payload),
    ctx: this.session,
    getTools: () => [...this.tools.values()],
  };

  /** Restore policy state (permission level) from the attached session store. */
  async restoreSecurity(store: SessionStore): Promise<void> {
    await this.securityPolicy.restore(store, this.session);
  }

  /**
   * Register an extension by its setup(api) function. Everything it registers
   * is tracked in a fresh scope, revoked by `reloadExtensions()` (ADR-0009).
   */
  registerExtension(fn: SetupFn): void {
    const scope: ExtensionScope = { tools: [], middlewares: [], slashCommands: [], effects: [] };
    this.scopes.push(scope);
    this.currentScope = scope;
    try {
      fn(this.api);
    } finally {
      this.currentScope = null;
    }
  }

  /**
   * Scan a directory for `*.ext.{ts,js,mjs}` files and register each.
   * Any file exporting `setup` (or default) as a SetupFn is wired in.
   * Missing directory is treated as "no extensions" (non-fatal).
   */
  async loadExtensionsFromDir(dir: string): Promise<string[]> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const { pathToFileURL } = await import('node:url');
    let files: string[] = [];
    try {
      files = await fs.readdir(dir);
    } catch {
      return [];
    }
    const loaded: string[] = [];
    const extFiles = files.filter((f) => /\.ext\.(ts|js|mjs)$/.test(f));
    for (const f of extFiles) {
      // file URL, not a raw path: Windows backslashes break dynamic import()
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
      const setup = (mod.setup ?? mod.default) as SetupFn | undefined;
      if (typeof setup === 'function') {
        this.registerExtension(setup);
        loaded.push(f);
      }
    }
    return loaded;
  }

  /**
   * Extension reload (ADR-0009 Q17=a, Q21–Q23): revoke every scoped
   * registration from ALL previously set-up extensions — run `useEffect`
   * cleanups first (release external resources), then remove tools,
   * middlewares, and slash commands — then re-scan `dir` and re-inject.
   * `session.scratch` / `session.history` are preserved (no new Harness).
   * Core-owned registrations (SecurityPolicy) are untouched.
   *
   * Note: extensions registered directly via `registerExtension` (e.g.
   * `baseExtension`) are also revoked here; the caller re-registers them
   * after this call (as main.ts does).
   */
  async reloadExtensions(dir: string): Promise<string[]> {
    for (const scope of this.scopes) {
      for (const cleanup of scope.effects) {
        try {
          cleanup();
        } catch (e: any) {
          // Soft isolation: a bad cleanup must not abort the reload.
          console.error(`[reload] effect cleanup failed: ${e?.message ?? e}`);
        }
      }
      for (const name of scope.tools) this.tools.delete(name);
      for (const { stack, mw } of scope.middlewares) this.bus.remove(stack, mw);
      for (const name of scope.slashCommands) this.slashCommands.delete(name);
    }
    this.scopes = [];
    return this.loadExtensionsFromDir(dir);
  }

  /**
   * Convert registered tools into Vercel AI SDK tool defs (no execute).
   * No cropping since ADR-0009 (Q8=b): the model always sees the full surface.
   */
  buildToolDefs(): Record<string, { description: string; parameters: ToolSpec['parameters'] }> {
    const defs: Record<string, { description: string; parameters: ToolSpec['parameters'] }> = {};
    for (const t of this.tools.values()) {
      defs[t.name] = { description: t.description, parameters: t.parameters };
    }
    return defs;
  }

  /**
   * Assemble the system prompt by running the three `prompt/*` block stacks
   * (ADR-0010). Order is STRUCTURAL: base → permission → skills (Q2/Q16),
   * independent of registration order or priority. Each stack's middleware
   * writes its block via `bag.set(block, ...)`; the harness joins the
   * non-empty blocks in canonical order and reports which blocks contributed
   * as `sections` (Q10). Veto (skipping `next()`) affects only later
   * middleware WITHIN the same block stack (Q15=a); it never blocks
   * persistence.
   */
  async buildSystemPrompt(): Promise<BuiltSystemPrompt> {
    const ctx: Ctx = { session: this.session, state: {}, prompt: createPromptBag() };
    for (const block of PROMPT_BLOCKS) {
      await this.bus.run(`prompt/${block}` as HookStack, ctx, async () => {});
    }
    const sections: PromptBlockName[] = [];
    const parts: string[] = [];
    for (const block of PROMPT_BLOCKS) {
      const arr = ctx.prompt![block] ?? [];
      const trimmed = arr.filter((p) => typeof p === 'string' && p.trim().length > 0).map((p) => p.trim());
      if (trimmed.length > 0) {
        sections.push(block);
        parts.push(trimmed.join('\n\n'));
      }
    }
    return { prompt: parts.join('\n\n'), sections };
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
          await this.emit('skill/start', { name, source });
          await next();
          const res = ctx.toolResult ?? '';
          const ok = !res.startsWith('ERROR');
          await this.emit('skill/end', {
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

  /**
   * Persist a built system prompt: `system_prompt/start` event + system
   * message line + `system_prompt/end` event. This is the ONLY place the
   * system prompt is persisted — the `system_prompt` event handler (session
   * start, `/reload`, `/level`) and `run({ persistSystemPrompt: true })` both
   * go through here, so the persist path is single (2026-08-19 follow-up).
   */
  private async persistSystemPrompt(built: BuiltSystemPrompt): Promise<void> {
    if (!this.sessionStore) return;
    await this.emit('system_prompt/start', { sections: built.sections });
    await this.sessionStore.appendMessage('system', built.prompt);
    await this.emit('system_prompt/end', { sections: built.sections });
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
    const built = await this.buildSystemPrompt();
    if (opts.persistSystemPrompt) {
      await this.persistSystemPrompt(built); // single persist path (2026-08-19)
    }

    const messages: any[] = [{ role: 'system', content: built.prompt }];
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
          ? (role, content) => this.sessionStore!.appendMessage(role, content)
          : undefined,
      });
    });

    // Persist only conversation turns; the system prompt is rebuilt on each run.
    this.session.history = messages.filter((m) => m.role !== 'system');
    return messages;
  }
}
