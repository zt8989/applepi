/**
 * 浏览器侧的 `Agent` 替身。
 *
 * ## 为什么需要它
 *
 * pi-web-ui 的 `ChatPanel` / `AgentInterface` 只认一个 `pi-agent-core` 形状的 `Agent`：
 * 读 `agent.state`（messages / model / thinkingLevel / isStreaming / pendingToolCalls）、
 * `agent.subscribe(...)`、`await agent.prompt(...)`、`agent.abort()`。
 *
 * 而本项目的环**跑在服务端**（tui 进程里的 Redux Loop）。浏览器不该再有一份 agent、
 * 也不该拿得到模型密钥。所以这里给一个**形状一样、实现是网线**的替身：
 *
 *   state   ← 服务端推来的快照
 *   prompt  → `{type:'prompt'}` 发出去
 *   abort   → `{type:'abort'}`
 *   model / thinkingLevel 的 setter（pi-web-ui 的选择器会直接写它）→ 转发给服务端
 *
 * ## 事件为什么只转不造
 *
 * `AgentInterface` 订阅的 `message_start/turn_start/message_update/message_end/agent_end`
 * 全部由服务端发来（见 `@ela/core/web-protocol`）。浏览器侧**不猜**环进行到哪一步 ——
 * 猜出来的状态与服务端错过一次就再也对不上。
 */

import type { WebAgentState, WebClientMessage, WebServerMessage } from '@ela/core/web-protocol';

/** 宽松事件类型：pi-web-ui 只按 `type` 分支，其余字段它自己读。 */
export interface RemoteAgentEvent {
  type: string;
  [key: string]: unknown;
}

type Listener = (event: RemoteAgentEvent, signal?: AbortSignal) => void | Promise<void>;

/**
 * `agent.state` 的形状。
 *
 * `model` 与 `thinkingLevel` 是**访问器**：pi-web-ui 的模型选择器 / 思考级别选择器
 * 直接 `session.state.model = …` 写它，写下去就得转发到服务端（那里才是真相）。
 *
 * 服务端推来的快照走 `apply()`，直接写内部字段 —— 不触发转发（否则回音）。
 */
export class RemoteAgentState {
  messages: unknown[] = [];
  isStreaming = false;
  streamingMessage: unknown = null;
  pendingToolCalls: ReadonlySet<string> = new Set<string>();
  errorMessage: string | undefined = undefined;
  systemPrompt = '';
  tools: unknown[] = [];
  sessionId = '';
  cwd = '';

  /** pi-web-ui 写 `state.model` 时回调（由 RemoteAgent 接到「发给服务端」）。 */
  onModelSelected: ((provider: string, id: string) => void) | undefined;
  /** 同上，思考级别。 */
  onThinkingSelected: ((level: string) => void) | undefined;

  private currentModel: unknown = null;
  private currentThinking = 'off';

  get model(): unknown {
    return this.currentModel;
  }

  set model(value: unknown) {
    this.currentModel = value;
    const provider = (value as { provider?: unknown } | null)?.provider;
    const id = (value as { id?: unknown } | null)?.id;
    if (typeof provider === 'string' && typeof id === 'string') {
      this.onModelSelected?.(provider, id);
    }
  }

  get thinkingLevel(): string {
    return this.currentThinking;
  }

  set thinkingLevel(value: string) {
    if (value === this.currentThinking) return;
    this.currentThinking = value;
    this.onThinkingSelected?.(value);
  }

  /** 服务端快照 → 本地。**绕过 setter**（见类注释）。 */
  apply(state: WebAgentState): void {
    this.messages = state.messages;
    this.currentModel = state.model;
    this.currentThinking = state.thinkingLevel;
    this.isStreaming = state.isStreaming;
    this.streamingMessage = state.streamingMessage;
    this.pendingToolCalls = new Set(state.pendingToolCalls);
    this.errorMessage = state.errorMessage ?? undefined;
    this.toolNames = state.toolNames;
    this.sessionId = state.sessionId;
    this.cwd = state.cwd;
  }

  toolNames: readonly string[] = [];
}

export interface RemoteAgentHooks {
  /** 状态换了之后要让界面重画（pi-web-ui 靠事件触发，状态本身不触发）。 */
  onStateApplied?: (() => void) | undefined;
  /** 开场诊断（hello 里的 notices）。 */
  onNotices?: ((notices: readonly string[]) => void) | undefined;
  /** 一条即时提示（notice）。 */
  onNotice?: ((level: string, text: string) => void) | undefined;
  /** 连接状态：connecting / open / closed。 */
  onStatus?: ((status: 'connecting' | 'open' | 'closed') => void) | undefined;
  /**
   * 提问前的拦截：返回 `true` = 已当**斜杠命令**处理，不要再发给模型。
   *
   * 命令走 HTTP 接口（见 `commands.ts`），所以这里可以 `await`。
   */
  onPrompt?: ((text: string) => boolean | Promise<boolean>) | undefined;
}

export class RemoteAgent {
  readonly state = new RemoteAgentState();

  /**
   * `AgentInterface` 会拿 `session.streamFn === streamSimple` 判断「要不要包一层代理」。
   * 给一个自己的函数就永远不相等 —— 于是它不会去动 `getAppStorage()`，也不会改我们的
   * `getApiKey`。这个函数**永远不会被调用**（提问走服务端）。
   */
  streamFn: unknown = () => {
    throw new Error('RemoteAgent: LLM 调用在服务端，这里不该被调用');
  };

  /** 密钥在服务端，浏览器侧没有。给个占位值，让 pi-web-ui 的「有没有 key」检查让路。 */
  getApiKey = async (): Promise<string> => 'server-side';

  private readonly listeners = new Set<Listener>();
  private socket: WebSocket | undefined;
  private reconnectTimer: number | undefined;
  private closedByUs = false;

  constructor(private readonly hooks: RemoteAgentHooks = {}) {
    this.state.onModelSelected = (provider, id) => this.send({ type: 'setModel', provider, id });
    this.state.onThinkingSelected = (level) => this.send({ type: 'setThinking', level });
  }

  connect(url: string): void {
    this.closedByUs = false;
    this.hooks.onStatus?.('connecting');
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener('open', () => this.hooks.onStatus?.('open'));
    socket.addEventListener('message', (event) => this.onMessage(String(event.data)));
    socket.addEventListener('close', () => {
      this.hooks.onStatus?.('closed');
      if (!this.closedByUs) this.scheduleReconnect(url);
    });
    socket.addEventListener('error', () => this.hooks.onStatus?.('closed'));
  }

  dispose(): void {
    this.closedByUs = true;
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** pi-web-ui 的发送路径。入参可能是字符串，也可能是一条 `user-with-attachments` 消息。 */
  async prompt(input: unknown): Promise<void> {
    const text = extractText(input);
    if (text.trim() === '') return;
    // 斜杠命令：走 HTTP 接口，不发给模型（与 TUI 的 `runCommand` 同一个分工）。
    if ((await this.hooks.onPrompt?.(text)) === true) return;
    this.send({ type: 'prompt', text });
  }

  abort(): void {
    this.send({ type: 'abort' });
  }

  waitForIdle(): Promise<void> {
    return Promise.resolve();
  }

  /** 服务端与 pi-web-ui 的队列口径一致（`store.dispatch queue.input`），浏览器侧不排队。 */
  steer(): void {}
  followUp(): void {}
  clearSteeringQueue(): void {}
  clearFollowUpQueue(): void {}
  clearAllQueues(): void {}
  hasQueuedMessages(): boolean {
    return false;
  }
  peekQueuedMessages(): unknown[] {
    return [];
  }
  reset(): void {
    this.send({ type: 'newSession' });
  }

  /** 新会话（界面上的按钮用）。 */
  startNewSession(): void {
    this.send({ type: 'newSession' });
  }

  private send(message: WebClientMessage): void {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  private onMessage(raw: string): void {
    let message: WebServerMessage;
    try {
      message = JSON.parse(raw) as WebServerMessage;
    } catch {
      return;
    }
    switch (message.type) {
      case 'hello':
        this.hooks.onNotices?.(message.notices);
        this.state.apply(message.state);
        this.hooks.onStateApplied?.();
        break;
      case 'state':
        this.state.apply(message.state);
        this.hooks.onStateApplied?.();
        break;
      case 'notice':
        this.hooks.onNotice?.(message.level, message.text);
        break;
      case 'event':
        this.dispatch(message.event as RemoteAgentEvent);
        break;
      default:
        break;
    }
  }

  private dispatch(event: RemoteAgentEvent): void {
    for (const listener of this.listeners) {
      try {
        void listener(event);
      } catch {
        // 一个订阅者抛错不该让别的订阅者收不到 —— 界面自己会重试下一帧。
      }
    }
  }

  private scheduleReconnect(url: string): void {
    if (this.reconnectTimer !== undefined) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect(url);
    }, 1000);
  }
}

/** 从 pi-web-ui 传来的入参里抠出文本（字符串 / `{content}` / `{content: blocks}`）。 */
export function extractText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (typeof input !== 'object' || input === null) return '';
  const content = (input as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text') {
          const text = (block as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .filter((text) => text !== '')
      .join('\n');
  }
  return '';
}