import type { LanguageModelV1 } from 'ai';
import type { ZodType } from 'zod';

/** The onion middleware stacks (ADR-0008 adds `system_prompt`). */
export type HookStack = 'session' | 'llm' | 'tool' | 'system_prompt';

/** A tool registered by core or an extension. */
export interface ToolSpec {
  name: string;
  description: string;
  /** Zod schema for the tool arguments (maps to Vercel AI SDK parameters). */
  parameters: ZodType<any>;
  execute: (args: any, ctx: Ctx) => Promise<string> | string;
}

/** The model-facing shape of a tool (description + zod parameters, no execute). */
export interface ToolDef {
  description: string;
  parameters: ZodType<any>;
}

/** Slash-command handler. Returns the text to print in the REPL. */
export type SlashHandler = (arg: string, api: HarnessApi) => string | Promise<string>;

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
  // system_prompt stack (ADR-0008)
  /** Accumulator of system-prompt sections, pushed by middleware. */
  promptParts?: string[];
  /** Labels of the sections actually contributed during this build. */
  sections?: string[];
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
  /**
   * Register an EXTERNAL side effect (timer, fs watcher, child process, ...)
   * created by this extension. The effect runs synchronously during `setup`;
   * its return value (if a function) is the cleanup invoked when the harness
   * reloads (ADR-0009 Q21–Q23). May be called multiple times.
   */
  useEffect(effect: () => (() => void) | void): void;
  /** Register a slash command; dispatch checks these before built-ins (Q13=a). */
  registerSlashCommand(name: string, handler: SlashHandler): void;
  /** Look up an extension-registered slash command (undefined if absent). */
  getSlashCommand(name: string): SlashHandler | undefined;
  /**
   * Publish an event (ADR-0008 follow-up). The harness owns a handler map:
   * `system_prompt` is handled in core (rebuild + persist, returning the
   * built `{ prompt, sections }`); any other event falls back to writing a
   * lifecycle event line to the session store (P7). All events go through
   * this single entry — there is no per-event method on the API.
   */
  emit(event: string, payload?: any): Promise<any>;
  ctx: SessionContext;
  getTools(): ToolSpec[];
}

/** Extension entry: a function that wires capabilities into the api. */
export type SetupFn = (api: HarnessApi) => void;

export type { LanguageModelV1 };
