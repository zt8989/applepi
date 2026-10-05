/**
 * Redux 状态树 → pi-web-ui 的 `AgentInterface`。
 *
 * 这里是**唯一**一处「让 pi-web-ui 认识我们」的地方，也是这个仓库里唯一一个
 * 知道 pi-web-ui 存在的地方。它不含任何环的逻辑：环在 `src/` 里，已经跑完了。
 * 它只做两件事：
 *
 *   1. 造一个 `AgentInterface.session` 能吃的结构（鸭子类型，不是 `instanceof Agent`）。
 *   2. 把状态树的**变化**翻译成 pi-web-ui 认识的那 7 个 lifecycle 事件。
 *
 * 为什么不直接喂 action？因为 Cmd 内部的 `Cmd.dispatch` 走的是 redux-loop 自己的
 * dispatch，绕过了我们能包装的那一层 —— 想看「环的每一步」，唯一完整、可靠的口子
 * 是状态树本身。状态树是环的收敛点：从它出发不会漏掉任何一条 action。
 *
 * pi-web-ui 那边只 `switch` 这几个 type（见它的 AgentInterface.js）：
 *   message_start / turn_start / turn_end / agent_start → 重渲染
 *   message_end                                          → 清流式容器 + 重渲染
 *   agent_end                                            → 同上
 *   message_update                                       → 喂给流式容器
 * 其余事件它根本不看。
 */
import type {
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  ModelThinkingLevel,
  TextContent,
  ToolResultMessage,
} from '@earendil-works/pi-ai';
// 只 import 类型：这个包在 node 下加载会炸（lit 要 DOM），测试里要能 import 本文件。
import type { Attachment } from '@earendil-works/pi-web-ui';
import type { AgentTool } from '../../src/agent-tool';
import type { AgentStore } from '../../src/store';
import type { AgentState } from '../../src/state';
import { abortRun } from '../../src/run-control';

/** pi-web-ui 认识的 lifecycle 事件（只列出它 switch 得到的那些）。 */
export type UiEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: Message[] }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: Message; toolResults: ToolResultMessage[] }
  | { type: 'message_start'; message: Message }
  | { type: 'message_update'; message: Message }
  | { type: 'message_end'; message: Message };

export type UiEventListener = (event: UiEvent) => void;

/** `AgentInterface` 真正读到的那几个字段。别的它不看，也不必给。 */
export interface SessionView {
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ModelThinkingLevel;
  messages: Message[];
  tools: AgentTool[];
  isStreaming: boolean;
  streamingMessage?: Message;
  pendingToolCalls: ReadonlySet<string>;
  errorMessage?: string;
}

/** 交给 `<agent-interface>` 的 session。 */
export interface Session {
  readonly state: SessionView;
  prompt(input: string | { content?: string; attachments?: Attachment[] }): Promise<void>;
  abort(): void;
  subscribe(listener: UiEventListener): () => void;
}

export interface SessionAdapterOptions {
  store: AgentStore;
  /** 当前模型。换模型时用 `session.setModel()`，会被翻成 model.changed。 */
  model: Model<any>;
  /** 浏览器里能用的工具（Node-only 的那些在 main.ts 里已经滤掉了）。 */
  tools: readonly AgentTool[];
  /**
   * 附件 → content 块的转换。由 main.ts 注入 pi-web-ui 自己的
   * `convertAttachments()`，这样附件的折法与它内部一致。
   */
  convertAttachments: (attachments: Attachment[]) => (TextContent | ImageContent)[];
  /** UI 选了新模型时回调（换顶栏之类的）。 */
  onModelChange?: (model: Model<any>) => void;
}

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

/**
 * 由状态树拼一条「正在流式的助手消息」。
 *
 * 流式容器只认 `role: 'assistant'`，所以必须给全 pi-ai 的 AssistantMessage 形状。
 * 内容只有思考 + 文本两块：工具调用要等 `llm.done` 才整条进 messages，
 * 届时稳定列表里的 tool-message 会接手渲染。
 */
function partialAssistant(state: AgentState, model: Model<any>): AssistantMessage {
  const content: AssistantMessage['content'] = [];
  if (state.thinkingText) content.push({ type: 'thinking', thinking: state.thinkingText });
  if (state.streamingText) content.push({ type: 'text', text: state.streamingText });
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: ZERO_USAGE,
    stopReason: 'pending',
    timestamp: Date.now(),
  };
}

/** 从 prompt 入参里取出纯文本。 */
function promptText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && 'content' in input) {
    const content = (input as { content?: unknown }).content;
    if (typeof content === 'string') return content;
  }
  return '';
}

/**
 * 状态树的两次快照之间，UI 需要听到哪些事件。
 *
 * 全部从状态**推导**，不从 action 转发 —— 因为只有状态是环的完整投影。
 */
function deriveEvents(
  prev: AgentState,
  next: AgentState,
  model: Model<any>,
): UiEvent[] {
  const events: UiEvent[] = [];

  // 新的一轮 LLM：`llm.started` 把 streamSeq 加一（只增不减，所以 conversation.reset
  // 归零不会误触发）。这是唯一可靠的「流开始了」信号。
  if (next.streamSeq > prev.streamSeq) {
    events.push({ type: 'turn_start' });
    events.push({ type: 'message_start', message: partialAssistant(next, model) });
    events.push({ type: 'message_update', message: partialAssistant(next, model) });
  }

  // 正在流：把累积的文本推进流式容器。
  if (
    next.phase === 'thinking' &&
    (next.streamingText !== prev.streamingText || next.thinkingText !== prev.thinkingText)
  ) {
    events.push({ type: 'message_update', message: partialAssistant(next, model) });
  }

  // 新并入 messages 的消息（含 llm.done 的助手消息与每个 toolResult）。
  const appended = next.messages.slice(prev.messages.length);
  for (const message of appended) {
    events.push({ type: 'message_end', message });
    if (message.role === 'assistant') {
      events.push({ type: 'turn_end', message, toolResults: [] });
    }
  }

  // 一次 run 结束（相位回 idle）：清流式容器、关生成中动画。
  if (prev.phase !== 'idle' && next.phase === 'idle') {
    events.push({ type: 'agent_end', messages: next.messages.slice() });
  }

  return events;
}

export interface SessionAdapter extends Session {
  /** 换模型：翻成 model.changed，环与 UI 都跟着走。 */
  setModel(model: Model<any>): void;
  /** 当前模型（换过之后是新的那个）。 */
  readonly currentModel: Model<any>;
}

export function createSessionAdapter(options: SessionAdapterOptions): SessionAdapter {
  const { store, tools, convertAttachments, onModelChange } = options;
  let model = options.model;
  const listeners = new Set<UiEventListener>();
  let previous = store.getState();

  const emit = (event: UiEvent): void => {
    for (const listener of listeners) listener(event);
  };

  // 订阅 store，把每次状态变化翻译成 lifecycle 事件。
  // store.subscribe 在 dispatch 同步返回前就回调，所以 prev/next 一定成对。
  store.subscribe(() => {
    const next = store.getState();
    const events = deriveEvents(previous, next, model);
    previous = next;
    for (const event of events) emit(event);
  });

  const view = (): SessionView => {
    const state = store.getState();
    const built = {
      systemPrompt: state.systemPrompt,
      model,
      thinkingLevel: state.thinkingLevel,
      // 每次都是新的数组：pi-web-ui 按引用判断要不要重渲染，
      // 复用同一个引用的话「工具回合之后最后一条不显示」。
      messages: state.messages.slice(),
      tools: tools.slice(),
      isStreaming: state.phase !== 'idle',
      pendingToolCalls: new Set(state.executing.map((t) => t.call.id)),
      ...(state.error ? { errorMessage: state.error } : {}),
    } as SessionView;

    // MessageEditor 会直接写 `session.state.thinkingLevel = level`，所以这两个字段
    // 必须是可写的 —— 写成 setter，把赋值翻成 action，而不是改一个没人看的新对象。
    Object.defineProperty(built, 'thinkingLevel', {
      enumerable: true,
      get: () => store.getState().thinkingLevel,
      set: (level: ModelThinkingLevel) => store.dispatch({ type: 'thinking.changed', level }),
    });
    Object.defineProperty(built, 'model', {
      enumerable: true,
      get: () => model,
      set: (next: Model<any>) => {
        model = next;
        store.dispatch({ type: 'model.changed', provider: next.provider, modelId: next.id });
        onModelChange?.(next);
      },
    });
    return built;
  };

  return {
    get state() {
      return view();
    },
    get currentModel() {
      return model;
    },
    setModel(next: Model<any>) {
      // 走 setter 那条路，model.changed 与回调都归它管。
      (view() as { model: Model<any> }).model = next;
    },
    async prompt(input) {
      const text = promptText(input);
      if (!text.trim() && !hasAttachments(input)) return;
      const attachments = getAttachments(input);
      // 附件折成 content 块，和 pi-web-ui 内部的折法一致；消息本身仍是标准的
      // pi-ai user 消息，所以它能原样喂回 LLM。
      const content: (TextContent | ImageContent)[] | undefined = attachments?.length
        ? [{ type: 'text', text }, ...convertAttachments(attachments)]
        : undefined;
      store.dispatch({
        type: 'user.message',
        text,
        ...(content ? { content } : {}),
      });
    },
    abort() {
      abortRun();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function getAttachments(input: unknown): Attachment[] | undefined {
  if (input && typeof input === 'object' && 'attachments' in input) {
    const attachments = (input as { attachments?: Attachment[] }).attachments;
    return attachments && attachments.length > 0 ? attachments : undefined;
  }
  return undefined;
}

function hasAttachments(input: unknown): boolean {
  return getAttachments(input) !== undefined;
}
