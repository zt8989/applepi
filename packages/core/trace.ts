import { Langfuse } from 'langfuse';
import { loadDotenv } from './config.js';

/**
 * Observability tracing (ADR-0011, web interface round 2): Langfuse Cloud,
 * instrumented at the CORE layer so the CLI and the web UI both benefit.
 * Keys come from ~/.applepi/.env (ADR-0004 convention):
 * LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL.
 *
 * Shape: one trace per agent turn (named `agent-turn`, session-scoped so
 * Langfuse groups all turns of a session), one generation per LLM call (with
 * token usage), one span per tool execution. When Langfuse is not configured
 * the tracer is a no-op — the harness must work without it.
 */

export interface SpanHandle {
  end(output?: unknown, usage?: unknown): void;
}

export interface TraceHandle {
  generation(name: string, input: unknown, opts?: { model?: string }): SpanHandle;
  span(name: string, input: unknown): SpanHandle;
}

export interface Tracer {
  session(name: string, sessionId: string, input?: unknown): TraceHandle | null;
}

let cached: Tracer | null | undefined;
let client: Langfuse | null = null;

/** Lazily build the Langfuse tracer (null when unconfigured). */
export async function getTracer(baseDir?: string): Promise<Tracer | null> {
  if (cached !== undefined) return cached;
  const secrets = await loadDotenv(baseDir);
  const pk = secrets.LANGFUSE_PUBLIC_KEY;
  const sk = secrets.LANGFUSE_SECRET_KEY;
  const bu = secrets.LANGFUSE_BASE_URL;
  if (!pk || !sk || !bu) {
    cached = null;
    return null;
  }
  client = new Langfuse({ publicKey: pk, secretKey: sk, baseUrl: bu });
  cached = {
    session(name, sessionId, input) {
      const trace = client!.trace({ name, sessionId, input });
      return {
        generation(gName, input, opts) {
          const g = trace.generation({ name: gName, model: opts?.model, input });
          return {
            end(output, usage) {
              g.end({ output, usage: usage as any });
            },
          };
        },
        span(sName, input) {
          const s = trace.span({ name: sName, input });
          return { end(output) { s.end({ output }); } };
        },
      };
    },
  };
  return cached;
}

/** Flush buffered traces (Langfuse SDK v3 auto-flushes on an interval). */
export async function flushTraces(): Promise<void> {
  await client?.flushAsync();
}

/** Best-effort human model label for a provider model instance. */
export function modelLabel(model: any): string | undefined {
  return (
    model?.modelId ??
    model?.model ??
    (typeof model?.name === 'string' ? model.name : undefined)
  );
}

/** Reset the cached tracer (tests only). */
export function resetTracer(): void {
  cached = undefined;
  client = null;
}
