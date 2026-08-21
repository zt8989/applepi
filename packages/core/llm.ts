import { generateText, streamText } from 'ai';
import type { ProviderProtocol, ReasoningLevel } from './config.js';
import type { Ctx, SessionContext, ToolDef, ToolSpec } from './types.js';

/**
 * The LLM-interaction deep module (ADR-0015): the single place that owns the
 * model-facing surface — the tool catalog and one LLM response segment — while
 * hiding the concrete AI SDK. `loop` drives the multi-turn orchestration; this
 * module produces ONE response (non-streaming `generate` or streaming `stream`)
 * from `{ model, messages, tools }` and the reasoning mapping.
 *
 * It is constructed by the Harness shell with the session and the tool
 * registry. Per ADR-0015 it consumes a ready `{ prompt, tools }` surface and
 * hosts no capability-injection mechanism (no onion stacks).
 */

/** Shape of the LLM call the loop makes each turn. */
export type LlmCall = (args: {
  model: any;
  messages: any[];
  tools: any;
}) => Promise<any>;

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

export interface LlmGenerateOpts {
  model: any;
  messages: any[];
  /** Injectable LLM call. Defaults to Vercel AI SDK `generateText`. Swapping it
   *  lets tests drive the loop without a real provider/API key. */
  llmCall?: LlmCall;
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
   * Run ONE non-streaming LLM response. Returns the raw SDK result plus the
   * llm context (for trace orchestration).
   */
  generate(opts: LlmGenerateOpts): Promise<{ result: any; ctx: Ctx }>;
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
 * Build the LLM module. The Harness shell constructs one and owns it; `loop`
 * and `stream-loop` consume its interface and never touch the AI SDK.
 */
export function createLlm(deps: LlmDeps): Llm {
  return {
    buildToolDefs: () => buildToolDefs(deps.getTools()),

    async generate({ model, messages, llmCall }) {
      const call: LlmCall = llmCall ?? ((a: any) => generateText(a));
      const ctx: Ctx = { session: deps.session, state: {}, messages };
      const tools = buildToolDefs(deps.getTools());
      const result = await call({ model, messages: ctx.messages as any[], tools: tools as any });
      return { result, ctx };
    },

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
