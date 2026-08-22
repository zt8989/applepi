import { streamText } from 'ai';
import type { ProviderProtocol, ReasoningLevel } from './config.js';
import type { Ctx, SessionContext, ToolDef, ToolSpec } from './types.js';

/**
 * The LLM-interaction deep module (ADR-0015): the single place that owns the
 * model-facing surface — the tool catalog and one **streamed** LLM response
 * segment — while hiding the concrete AI SDK. `loop` drives the
 * multi-turn orchestration; this module produces ONE streaming response
 * (`stream`) from `{ model, messages, tools }` and the reasoning mapping.
 *
 * It is constructed by the Harness shell with the session and the tool
 * registry. Per ADR-0015 it consumes a ready `{ prompt, tools }` surface and
 * hosts no capability-injection mechanism (no onion stacks). The non-streaming
 * `generate` path was removed with the CLI (`runLoop`) — the web is the only
 * interface and uses the streaming loop.
 */

/** The model-facing catalog built from registered tools (no execute). */
export type ToolCatalog = Record<string, ToolDef>;

/** Build the Vercel AI SDK tool-def catalog from registered `ToolSpec`s. */
export function buildToolDefs(tools: ToolSpec[]): ToolCatalog {
  const defs: ToolCatalog = {};
  for (const t of tools) {
    defs[t.name] = { description: t.description, parameters: t.parameters };
  }
  return defs;
}

/**
 * Reasoning level → providerOptions mapping.
 * - `off` threads nothing (model default / no thinking).
 * - openai (both completions & responses): `reasoningEffort`.
 * - anthropic: extended thinking with a scaled `budgetTokens`.
 * - unknown protocol: nothing (silent ignore, no error).
 */
export function reasoningProviderOptions(
  protocol: ProviderProtocol | undefined,
  level: ReasoningLevel | undefined,
): Record<string, Record<string, import('ai').JSONValue>> | undefined {
  if (!level || level === 'off') return undefined;
  if (protocol === 'openai-completions' || protocol === 'openai-responses') {
    return { openai: { reasoningEffort: level } };
  }
  if (protocol === 'anthropic-messages') {
    const budgetTokens = { low: 1024, medium: 2048, high: 4096 }[level] ?? 2048;
    return { anthropic: { thinking: { type: 'enabled', budgetTokens } } };
  }
  return undefined;
}

export interface LlmStreamOpts {
  model: any;
  messages: any[];
  messageId: string;
  /** Provider protocol — selects how `reasoningLevel` maps to request params. */
  protocol?: ProviderProtocol;
  /** Effective reasoning level for this run (session override ?? global default). */
  reasoningLevel?: ReasoningLevel;
  /** Test seam: the streamText call used per LLM turn. */
  streamTextCall?: typeof streamText;
}

export interface Llm {
  /** Build the model-facing tool catalog from the current tool registry. */
  buildToolDefs(): ToolCatalog;
  /**
   * Run ONE streaming LLM response. Returns the StreamTextResult plus the llm
   * context and the applied reasoning options.
   */
  stream(opts: LlmStreamOpts): Promise<{ result: any; ctx: Ctx; reasoningOpts: ReturnType<typeof reasoningProviderOptions> }>;
}

export interface LlmDeps {
  /** The agent's session state (threaded into the llm context). */
  session: SessionContext;
  /** Accessor for the currently-registered tools. */
  getTools: () => ToolSpec[];
}

/**
 * Build the LLM module. The Harness shell constructs one and owns it;
 * `loop` consumes its interface and never touches the AI SDK.
 */
export function createLlm(deps: LlmDeps): Llm {
  return {
    buildToolDefs: () => buildToolDefs(deps.getTools()),

    async stream({ model, messages, messageId, protocol, reasoningLevel, streamTextCall }) {
      const llm = streamTextCall ?? streamText;
      const ctx: Ctx = { session: deps.session, state: {}, messages };
      const tools = buildToolDefs(deps.getTools());
      const reasoningOpts = reasoningProviderOptions(protocol, reasoningLevel);
      const result = llm({
        model,
        messages: ctx.messages as any[],
        // no `execute`: we run tools ourselves through the tool seam.
        tools: tools as any,
        experimental_generateMessageId: () => messageId,
        ...(reasoningOpts ? { providerOptions: reasoningOpts } : {}),
      });
      return { result, ctx, reasoningOpts };
    },
  };
}
