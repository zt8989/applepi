import type { Ctx, HookStack, Middleware } from './types.js';

interface Layer {
  mw: Middleware;
  priority: number;
}

/**
 * Onion middleware bus.
 *
 * Each stack is an ordered list of middleware. Higher priority = OUTER layer:
 * it enters first (pre-next code runs before inner layers) and exits last
 * (post-next code runs after inner layers). Not calling `next()` = veto.
 * Throwing is caught per-layer and surfaced as `ctx.error` (soft isolation);
 * the inner chain is still run so the final handler can emit an ERROR result
 * instead of crashing the whole loop.
 */
export class OnionBus {
  private stacks: Record<HookStack, Layer[]> = {
    session: [],
    llm: [],
    tool: [],
    // ADR-0010: three block stacks (base → permission → skills), run in that
    // fixed order by buildSystemPrompt().
    'prompt/base': [],
    'prompt/permission': [],
    'prompt/skills': [],
  };

  use(stack: HookStack, mw: Middleware, opts?: { priority?: number }): void {
    this.stacks[stack].push({ mw, priority: opts?.priority ?? 0 });
  }

  /**
   * Remove a middleware by reference from a stack (ADR-0009 extension-reload:
   * scoped registrations are revoked by identity). No-op if absent.
   */
  remove(stack: HookStack, mw: Middleware): void {
    this.stacks[stack] = this.stacks[stack].filter((l) => l.mw !== mw);
  }

  private chain(
    stack: HookStack,
    ctx: Ctx,
    final: () => Promise<void>,
  ): () => Promise<void> {
    const layers = [...this.stacks[stack]].sort(
      (a, b) => b.priority - a.priority, // high priority outermost
    );

    const dispatch = (i: number): (() => Promise<void>) => {
      if (i >= layers.length) return final;
      const layer = layers[i];
      return async () => {
        let calledNext = false;
        const next = async (): Promise<void> => {
          calledNext = true;
          await dispatch(i + 1)();
        };
        try {
          await layer.mw(ctx, next);
        } catch (err) {
          // Soft isolation: a misbehaving middleware must not crash the loop.
          ctx.error = err;
          if (!calledNext) {
            // errored before delegating: still run the inner chain so the
            // final handler can produce a safe ERROR result.
            try {
              await dispatch(i + 1)();
            } catch {
              /* inner also threw; leave ctx.error set */
            }
          }
          return;
        }
        if (!calledNext) {
          // returned without calling next -> intentional veto
          ctx.state.__vetoed = true;
        }
      };
    };
    return dispatch(0);
  }

  /** Run a stack with `final` as the innermost handler. Mutates `ctx`. */
  async run(stack: HookStack, ctx: Ctx, final: () => Promise<void>): Promise<void> {
    const runner = this.chain(stack, ctx, final);
    await runner();
  }
}
