import { OnionBus } from './bus.js';
import { runLoop } from './loop.js';
import type {
  Ctx,
  HarnessApi,
  HookStack,
  Middleware,
  SessionContext,
  SetupFn,
  ToolSpec,
} from './types.js';

export class Harness {
  readonly bus = new OnionBus();
  session: SessionContext = { history: [], config: {}, scratch: {} };
  private tools = new Map<string, ToolSpec>();

  readonly api: HarnessApi = {
    registerTool: (spec: ToolSpec) => {
      if (this.tools.has(spec.name)) {
        throw new Error(`tool "${spec.name}" already registered`);
      }
      this.tools.set(spec.name, spec);
    },
    use: (stack: HookStack, mw: Middleware, opts?: { priority?: number }) =>
      this.bus.use(stack, mw, opts),
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

  /** Run a full session: wrap the loop in the session stack, record history. */
  async run(prompt: string, model: any, maxTurns = 8): Promise<any[]> {
    const messages: any[] = [
      ...this.session.history,
      { role: 'user', content: prompt },
    ];
    const ctx: Ctx = { session: this.session, state: {}, messages };
    await this.bus.run('session', ctx, async () => {
      await runLoop(this, ctx.messages ?? [], { model, maxTurns });
    });
    this.session.history = messages;
    return messages;
  }
}
