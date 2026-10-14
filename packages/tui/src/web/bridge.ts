/**
 * 内核 → 浏览器的桥。
 *
 * ## 它在哪一层
 *
 * `main.ts` 起内核（`createKernel()`），TUI 订阅同一个 store 画终端界面；本文件是
 * **第二个订阅者** —— 它把内核的 `AgentState` 映射成 [web-protocol](@ela/core/web-protocol)
 * 里那份「pi-web-ui 认的形状」，交给 [server](server.ts) 广播给浏览器。
 *
 * 桥**不持有环**：消息进来是 `store.dispatch`，中止是 `abortRun()`，换模型/开新会话是
 * 内核的回调。与 TUI 完全同源 —— 「环只有一份」这条铁律在 web 这一侧同样成立。
 *
 * ## 为什么发「整份状态 + 少量事件」
 *
 * pi-web-ui 的 `AgentInterface` 有两个落点：
 *
 *   - `session.state.messages` 是**稳定列表**（每条消息渲染一次）；
 *   - `session.subscribe` 的 `message_update` 喂**流式容器**（当前这条还没落进列表的）。
 *
 * 内核的 `streamingText` / `thinkingText` 是流式期的中间态（不进 `messages`），而
 * pi-web-ui 恰好要一个「部分助手消息」——所以每次 store 变化都发整份状态（简单、不会漂移），
 * 再补一条 `message_update` 让流式容器跟上。事件与状态**同一次变化一起发**，
 * 顺序是**先状态后事件**（`message_update` 要读 `state.isStreaming`）。
 */

import type { AgentStore } from '@ela/core/store';
import { stopCauseText, type AgentState } from '@ela/core/state';
import { abortRun } from '@ela/core/run-control';
import { isThinkingLevel } from '@ela/core/thinking-level';
import { deriveStream, type StreamNoticeEntry } from '@ela/core/stream';
import {
  WEB_PROTOCOL_VERSION,
  STREAM_NOTICE_ROLE,
  type WebAgentEvent,
  type WebAgentState,
  type WebClientMessage,
  type WebModelRef,
  type WebServerMessage,
  type WebStreamItem,
  type WebStreamNotice,
} from '@ela/core/web-protocol';
import type {
  Api,
  AssistantMessage,
  Model,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
} from '@earendil-works/pi-ai';

/** 桥要内核给的几个回调 —— 都是内核独有的能力（TUI 拿到的也是同一批）。 */
export interface WebBridgeOptions {
  store: AgentStore;
  /** 工具的工作目录（界面上显示用）。 */
  cwd: string;
  /** 按 provider/modelId 解析出真的模型对象；解析不到给 `null`。 */
  resolveModel: (provider: string, id: string) => Model<Api> | null;
  /** 当前会话 id（**取值**，`/new` 之后会变）。 */
  getSessionId: () => string;
  /** 换模型（内核的 `setModel()`：会 dispatch 两条 action）。 */
  setModel: (provider: string, id: string) => boolean;
  /** 开新会话（换 id → 换文件）。 */
  newSession: () => void;
  /**
   * 可选的模型目录 —— **与 TUI 的 `/model` 面板同一份**。
   *
   * 调用方传的是 `modelRefs(...getAvailableSnapshot())`（见 `modelRefs`）；不传就
   * 空列表（选择器里只有当前模型那一条）。
   */
  modelCatalog?: readonly WebModelRef[] | undefined;
  /** 当前作用域（`settings.json` 的 `enabledModels`）。每次握手现读 —— 用户可能在
   * TUI 里刚改过。`null` = 全开。 */
  scopedModelIds?: (() => readonly string[] | null) | undefined;
}

/** 零用量：流式中的部分消息还没账可算。 */
function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * 由内核的中间态拼一条**部分助手消息**。
 *
 * `stopReason: 'pending'` 是真话：它还没停。pi-web-ui 的渲染器只读 `content`
 * （text / thinking / toolCall 三种块），其余字段是给类型与统计用的。
 */
export function partialAssistantMessage(
  state: AgentState,
  model: Model<Api> | null,
): AssistantMessage {
  const content: (TextContent | ThinkingContent | ToolCall)[] = [];
  if (state.thinkingText) content.push({ type: 'thinking', thinking: state.thinkingText });
  if (state.streamingText) content.push({ type: 'text', text: state.streamingText });
  for (const call of state.executing) content.push(call.call);
  return {
    role: 'assistant',
    content,
    api: model?.api ?? ('unknown' as Api),
    provider: state.providerName,
    model: state.modelId,
    usage: zeroUsage(),
    stopReason: 'pending',
    timestamp: Date.now(),
  };
}

/**
 * 把内核的模型目录投影成线协议里的紧凑条目。
 *
 * 调用方直接喂 `modelRuntimeFor(runtime).getAvailableSnapshot()` —— 那是 TUI 的
 * `/model` 面板用的同一份（已配置 provider 内那些），所以两边列表天然一致。
 */
export function modelRefs(models: readonly Model<Api>[]): WebModelRef[] {
  return models.map((model) => ({
    provider: String(model.provider),
    id: model.id,
    name: model.name === undefined || model.name === '' ? model.id : model.name,
    reasoning: model.reasoning === true,
  }));
}

/**
 * 把轨迹派生的会话流变成线协议里的 `messages`：真消息原样，提示转成合成消息。
 *
 * 提示走一个**自定义 role**（`STREAM_NOTICE_ROLE`），由浏览器那边注册的 renderer 画成卡。
 * 它只活在这份线上数据里：`state.messages`（发给模型的）一个字节都不动。
 */
function streamItems(state: AgentState): WebStreamItem[] {
  return deriveStream(state.trace, state.messages).map((entry) =>
    entry.kind === 'message'
      ? entry.message
      : ({
          role: STREAM_NOTICE_ROLE,
          tone: entry.tone,
          title: entry.title,
          ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
          timestamp: Date.now(),
        } satisfies WebStreamNotice),
  );
}

/** 最后一条助手消息（收工时发 `message_end` 用）。 */
function lastAssistant(messages: readonly WebStreamItem[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message !== undefined && message.role === 'assistant') return message as AssistantMessage;
  }
  return undefined;
}

/**
 * 一条连接一个桥？不是 —— **一个桥，多个订阅者**。
 *
 * 桥盯的是 store（全局唯一），浏览器可以有多个标签页同时开着：它们都要看到同一份
 * 状态，也都能发话（谁发都进同一个环）。订阅者是「连接」，桥本身不是。
 */
export class WebBridge {
  readonly version = WEB_PROTOCOL_VERSION;

  private readonly options: WebBridgeOptions;
  private readonly listeners = new Set<(message: WebServerMessage) => void>();
  private readonly unsubscribe: () => void;
  private previous: WebAgentState;
  private readonly notices: string[];
  /** 上一次发出去的流式文本 —— 只在真的变了才发 `message_update`（否则每个 store 变化都刷屏）。 */
  private lastStreamingKey = '';

  constructor(options: WebBridgeOptions, notices: readonly string[] = []) {
    this.options = options;
    this.notices = [...notices];
    this.previous = this.snapshot();
    this.unsubscribe = options.store.subscribe(() => this.onStoreChange());
  }

  /** 新连接进来时的开场：整份状态 + 模型目录 + 诊断。 */
  hello(): WebServerMessage {
    return {
      type: 'hello',
      version: this.version,
      state: this.snapshot(),
      models: [...(this.options.modelCatalog ?? [])],
      scopedModelIds: this.scopeIds(),
      notices: this.notices,
    };
  }

  /**
   * 作用域：`null` = 全开。
   *
   * 空数组也归一化成 `null` —— 与 TUI 那边同一个口径
   * （`model-picker.ts` 的 `configured === null || length === 0 ? null : …`）。
   * 两处若不同，界面会显示「只看已启用（0 个）」而实际是全开。
   */
  private scopeIds(): string[] | null {
    if (this.options.scopedModelIds === undefined) return null;
    const ids = this.options.scopedModelIds();
    return ids === null || ids.length === 0 ? null : [...ids];
  }

  /** 订阅广播。返回退订函数。 */
  subscribe(listener: (message: WebServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 处理一条来自浏览器的消息。返回给**这一条连接**的即时回执（没有就是空数组）。 */
  handle(message: WebClientMessage): WebServerMessage[] {
    switch (message.type) {
      case 'prompt': {
        const text = message.text.trim();
        if (text === '') return [];
        const state = this.options.store.getState();
        if (state.phase !== 'idle') {
          // 跑着的时候再发就排队（与 TUI 的 steer 同一个口径），不打断当前回合。
          this.options.store.dispatch({ type: 'queue.input', text, as: 'steer' });
          return [{ type: 'notice', level: 'info', text: '环在跑，这条已排队（工具跑完后投递）' }];
        }
        this.options.store.dispatch({ type: 'user.message', text });
        return [];
      }
      case 'abort': {
        abortRun();
        return [];
      }
      case 'setModel': {
        const ok = this.options.setModel(message.provider, message.id);
        return ok
          ? []
          : [
              {
                type: 'notice',
                level: 'warn',
                text: `换模型失败：找不到 ${message.provider}/${message.id}`,
              },
            ];
      }
      case 'setThinking': {
        // 不信任客户端：级别不认识就丢弃并说一声（dispatch 进去会变成一份没人认识的状态）。
        if (!isThinkingLevel(message.level)) {
          return [{ type: 'notice', level: 'warn', text: `不认识的思考级别：${message.level}` }];
        }
        this.options.store.dispatch({ type: 'thinking.changed', level: message.level });
        return [];
      }
      case 'newSession': {
        this.options.newSession();
        return [];
      }
      default:
        return [];
    }
  }

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  /** 组一份当前状态。整份发出去 —— 不做差分，差分是最容易漂移的那类优化。 */
  private snapshot(): WebAgentState {
    const state = this.options.store.getState();
    const model = this.options.resolveModel(state.providerName, state.modelId);
    const errorMessage =
      state.stopReason === 'error' || state.stopReason === 'aborted'
        ? state.stopCause === null
          ? state.stopReason === 'aborted'
            ? '已中止'
            : '出错了'
          : stopCauseText(state.stopCause)
        : null;
    return {
      sessionId: this.options.getSessionId(),
      cwd: this.options.cwd,
      messages: streamItems(state),
      model,
      thinkingLevel: state.thinkingLevel,
      isStreaming: state.phase !== 'idle',
      streamingMessage: state.phase === 'idle' ? null : partialAssistantMessage(state, model),
      pendingToolCalls: state.executing.map((tool) => tool.call.id),
      errorMessage,
      toolNames: [...state.toolNames],
    };
  }

  private onStoreChange(): void {
    const next = this.snapshot();
    const previous = this.previous;
    this.previous = next;

    const events: WebAgentEvent[] = [];
    if (!previous.isStreaming && next.isStreaming) {
      events.push({ type: 'agent_start' }, { type: 'turn_start' });
      if (next.streamingMessage) {
        events.push({ type: 'message_start', message: next.streamingMessage });
      }
    }
    if (next.isStreaming && next.streamingMessage) {
      const key = JSON.stringify(next.streamingMessage.content);
      if (key !== this.lastStreamingKey) {
        this.lastStreamingKey = key;
        events.push({ type: 'message_update', message: next.streamingMessage });
      }
    }
    if (previous.isStreaming && !next.isStreaming) {
      const last = lastAssistant(next.messages);
      if (last) events.push({ type: 'message_end', message: last });
      events.push({ type: 'agent_end' });
      this.lastStreamingKey = '';
    }

    // 先状态后事件：`message_update` 要读 `state.isStreaming`（见文件头）。
    this.broadcast({ type: 'state', state: next });
    for (const event of events) this.broadcast({ type: 'event', event });
  }

  private broadcast(message: WebServerMessage): void {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        // 一个连接写不进去（已经在关）不该拖垮别的连接，也不该拖垮环。
      }
    }
  }
}