import type { LanguageModelV1 } from 'ai';
import type { ZodType } from 'zod';

/** The three onion middleware stacks. */
export type HookStack = 'session' | 'llm' | 'tool';

/** A tool registered by core or an extension. */
export interface ToolSpec {
  name: string;
  description: string;
  /** Zod schema for the tool arguments (maps to Vercel AI SDK parameters). */
  parameters: ZodType<any>;
  execute: (args: any, ctx: Ctx) => Promise<string> | string;
}

/**
 * Onion middleware. Inspect/mutate ctx before calling next(),
 * and again after next() returns. Not calling next() = veto.
 */
export type Middleware = (ctx: Ctx, next: () => Promise<void>) => Promise<void>;

/** Per-request context threaded through the onion stacks. */
export interface Ctx {
  /** Session-level state owned by the harness. */
  session: SessionContext;
  /** Generic mutable bag for middleware coordination. */
  state: Record<string, any>;
  // llm stack
  messages?: any[];
  response?: any;
  // tool stack
  toolName?: string;
  toolArgs?: any;
  toolResult?: string;
  // error captured by soft isolation
  error?: unknown;
  [k: string]: any;
}

export interface SessionContext {
  /** Conversation history (any[] to stay loosely typed across AI SDK versions). */
  history: any[];
  config: Record<string, any>;
  scratch: Record<string, any>;
}

/** Surface handed to every extension's setup(api). */
export interface HarnessApi {
  registerTool(spec: ToolSpec): void;
  use(stack: HookStack, mw: Middleware, opts?: { priority?: number }): void;
  ctx: SessionContext;
  getTools(): ToolSpec[];
}

/** Extension entry: a function that wires capabilities into the api. */
export type SetupFn = (api: HarnessApi) => void;

export type { LanguageModelV1 };
