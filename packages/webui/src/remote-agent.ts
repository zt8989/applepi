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
import type { QuestionnaireIntent, QuestionnaireSnapshot } from '@ela/core/questionnaire';
import { extractAttachments, withUserAttachments } from './attachments';

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
  /** 底栏那一行工作目录（服务端算好的 `~/proj (main)`，见 `stats.ts`）。 */
  cwdText = '';

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
    // 附件在**展示前**还原：服务端的历史里是 pi 的 content 块，界面要的是
    // `user-with-attachments`（见 `attachments.ts` 的文件头）。
    this.messages = withUserAttachments(stripAssistantUsage(state.messages));
    this.currentModel = state.model;
    this.currentThinking = state.thinkingLevel;
    this.isStreaming = state.isStreaming;
    this.streamingMessage = state.streamingMessage;
    this.pendingToolCalls = new Set(state.pendingToolCalls);
    this.errorMessage = state.errorMessage ?? undefined;
    this.toolNames = state.toolNames;
    this.toolTimings = state.toolTimings;
    this.statsText = state.statsText;
    this.statsLevel = state.statsLevel;
    this.sessionId = state.sessionId;
    this.cwd = state.cwd;
    this.cwdText = state.cwdText;
  }

  toolNames: readonly string[] = [];
  /**
   * 工具调用的耗时（`toolCallId` → 毫秒），服务端算好发来的（见 `tool-view.ts`）。
   *
   * 与 TUI 同一个来源：内核的 `state.toolTimings`。
   */
  toolTimings: Readonly<Record<string, number>> = {};
  /** 底栏统计行（与 TUI **逐字同形**）—— 服务端算好发来的。 */
  statsText = '';
  /** 统计行的告警级别（上下文占用 >70% / >90%）。 */
  statsLevel: 'none' | 'warn' | 'error' = 'none';
}

/** 扩展要求的一个对话框（`ctx.ui.select/confirm/input` 的浏览器那一份）。 */
export interface UiRequest {
  id: string;
  method: 'select' | 'confirm' | 'input';
  title: string;
  /** `select` 的选项。 */
  options?: string[] | undefined;
  /** `confirm` 的正文。 */
  message?: string | undefined;
  /** `input` 的占位符。 */
  placeholder?: string | undefined;
}

/** 一份问卷的一帧（服务端是唯一状态源）。 */
export interface UiQuestionnaire {
  id: string;
  snapshot: QuestionnaireSnapshot;
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
  /** 扩展要弹一个对话框（选择 / 是非题 / 文本输入）。 */
  onUiRequest?: ((request: UiRequest) => void) | undefined;
  /** 关掉那个弹窗（另一端先答了，或整轮被中断）。 */
  onUiCancel?: ((id: string) => void) | undefined;
  /**
   * 一份**问卷**（多题 tab）的整份快照 —— 它是"常驻的一份表"，不是一问一答：
   * 切题、勾选、提交都会再发一帧（同一个 `id`）。
   */
  onUiQuestionnaire?: ((update: UiQuestionnaire) => void) | undefined;
  /** 问卷结束了（提交 / 放弃 / 拆台）。 */
  onUiQuestionnaireClose?: ((id: string) => void) | undefined;
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

  /**
   * pi-web-ui 的发送路径。入参可能是字符串，也可能是一条 `user-with-attachments` 消息。
   *
   * ## 附件
   *
   * 图片 / 文档从入参里挑出来随 `prompt` 一起发（见 `attachments.ts` 的
   * `extractAttachments()`）。**斜杠命令只认纯文字**：带附件时那句话是给模型的，
   * 不能被命令拦下 —— 否则 pi-web-ui 已经清掉的附件就白丢了。
   */
  async prompt(input: unknown): Promise<void> {
    const text = extractText(input);
    const attachments = extractAttachments(input);
    if (text.trim() === '' && attachments.length === 0) return;
    // 斜杠命令：走 HTTP 接口，不发给模型（与 TUI 的 `runCommand` 同一个分工）。
    if (attachments.length === 0 && (await this.hooks.onPrompt?.(text)) === true) return;
    if (attachments.length === 0) {
      this.send({ type: 'prompt', text });
      return;
    }
    this.send({ type: 'prompt', text, attachments });
  }

  abort(): void {
    this.send({ type: 'abort' });
  }

  /** 回答一个扩展对话框。`cancelled` = 用户把它关了（不是空答案）。 */
  respondUi(id: string, response: { value?: string; cancelled?: boolean }): void {
    this.send({ type: 'ui-response', id, ...response });
  }

  /**
   * 问卷里的一个动作。
   *
   * 只推**意图**（切题 / 勾选 / 提交）：状态在服务端一份，两边各算必然漂。
   */
  respondQuestionnaire(id: string, intent: QuestionnaireIntent): void {
    this.send({ type: 'ui-questionnaire-intent', id, intent });
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

  /**
   * 恢复一个历史会话（侧边栏里点一条）。
   *
   * 只发 id + cwd：路径由服务端拼（`findSessionFile`），浏览器不需要知道磁盘布局。
   * 服务端那边还要判一次「环在不在跑」（侧边栏自己也锁了，见 `sidebar.ts`）。
   */
  resumeSession(id: string, cwd: string): void {
    this.send({ type: 'resumeSession', id, cwd });
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
      case 'ui-request':
        this.hooks.onUiRequest?.(message);
        break;
      case 'ui-cancel':
        this.hooks.onUiCancel?.(message.id);
        break;
      case 'ui-questionnaire':
        this.hooks.onUiQuestionnaire?.(message);
        break;
      case 'ui-questionnaire-close':
        this.hooks.onUiQuestionnaireClose?.(message.id);
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

/** 从 pi-web-ui 传来的入参里抠出文本（字符串 / `{content}` / `{content: blocks}`）。 */export function extractText(input: unknown): string {
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

/**
 * 抹掉助手消息上的 `usage` —— 界面不显示 pi-web-ui 那行逐条用量。
 *
 * ## 为什么要抹
 *
 * pi-web-ui 的 `assistant-message` 会给**每条**带 `usage` 的助手消息渲染一行
 * `↑186 ↓1.2k R164k`（它自己的 `formatUsage()`）。而底栏那一行（`statsText`）是服务端
 * 按 `statsLine()` 算的整行，含 `CH`（缓存命中率）与上下文占用。**两个口径同时挂着
 * 只会让人对不上账**（逐条那份是「最后一次调用」还是「这条」？），所以只留底栏那份。
 *
 * 剥掉的是「给浏览器的那一份」：服务端照发，线协议一个字节不动 —— 哪天要显示它
 * （比如逐条成本面板）直接把这层去掉就行。
 */
export function stripAssistantUsage(messages: readonly unknown[]): unknown[] {
  return messages.map((message) => {
    const record = message as { role?: unknown; usage?: unknown } | null;
    if (record === null || record.role !== 'assistant' || record.usage === undefined) return message;
    return { ...record, usage: undefined };
  });
}