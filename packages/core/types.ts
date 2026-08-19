import type { LanguageModelV1 } from 'ai';
import type { ZodType } from 'zod';

/** The onion middleware stacks (ADR-0010: `system_prompt` split into three `prompt/*` block stacks). */
export type HookStack = 'session' | 'llm' | 'tool' | 'prompt/base' | 'prompt/permission' | 'prompt/skills';

/** Canonical system-prompt blocks in assembly order (ADR-0010 Q2/Q16). */
export const PROMPT_BLOCKS = ['base', 'permission', 'skills'] as const;
export type PromptBlockName = (typeof PROMPT_BLOCKS)[number];

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
  // system_prompt → PromptBag (ADR-0010)
  /**
   * The accumulated prompt blocks, one array per canonical block. Writes go
   * ONLY through `set(block, array | (old) => new)` — no direct mutation
   * (Q7=b). The updater form receives THIS block's old array (Q14=a); blocks
   * are invisible to each other.
   */
  prompt?: PromptBag;
  // error captured by soft isolation
  error?: unknown;
  [k: string]: any;
}

/**
 * PromptBag (ADR-0010): the mutable build surface for the system prompt.
 * `buildSystemPrompt()` runs the three `prompt/*` stacks in canonical order,
 * then joins the non-empty block arrays. Block order is structural — it
 * follows PROMPT_BLOCKS, never registration order or priority.
 */
export interface PromptBag {
  base: string[];
  permission: string[];
  skills: string[];
  set(
    block: PromptBlockName,
    value: string[] | ((old: string[]) => string[]),
  ): void;
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
   * Publish an event (ADR-0008 follow-up, ADR-0010). The harness owns a
   * handler map: `system_prompt` (full-rebuild entry) and the block events
   * `system_prompt/base|permission|skills` (semantic triggers) are handled in
   * core (rebuild ALL blocks + persist, returning `{ prompt, sections }`);
   * any other event falls back to writing a lifecycle event line to the
   * session store (P7). All events go through this single entry — there is no
   * per-event method on the API.
   */
  emit(event: string, payload?: any): Promise<any>;
  ctx: SessionContext;
  getTools(): ToolSpec[];
}

/** Extension entry: a function that wires capabilities into the api. */
export type SetupFn = (api: HarnessApi) => void;

export type { LanguageModelV1 };
