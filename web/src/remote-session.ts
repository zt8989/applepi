/**
 * 浏览器侧的状态客户端 —— 环**不在**这里跑。
 *
 * 之前浏览器里也有一份 Redux store，也跑环。那是错的：环有副作用（真调模型、真改文件），
 * 两处都跑就会出现「两边都发起调用」「消息流不一致」。
 *
 * 现在内核只有一个，在 Node 里（`src/server.ts`）。浏览器这份是个**镜像**：
 *
 *   - SSE 推来一帧状态 → 存进 snapshot，通知订阅者
 *   - `prompt()`        → POST 给 Node，由 Node dispatch
 *   - 界面渲染仍由 pi-web-ui 驱动，adapter 照旧从 `session.state` 读
 *
 * 关键点：`session.state` 每次都返回**新对象 / 新数组**。pi-web-ui 靠引用变化判断
 * 要不要重渲染，直接把远端那份对象原样透出去是不够的。
 */
import type { AssistantMessage, ImageContent, TextContent } from '@earendil-works/pi-ai';
import { isImageStub, stubImageData } from '../../src/message-content';
/** 服务端推来的那一帧（与 src/server.ts 的 Snapshot 对应，但只声明界面用到的部分）。 */
export interface RemoteSnapshot {
  type: 'snapshot';
  phase: 'idle' | 'thinking' | 'calling-tools';
  systemPrompt: string;
  providerName: string;
  modelId: string;
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high';
  messages: unknown[];
  streamingText: string;
  thinkingText: string;
  streamSeq: number;
  turns: number;
  /** 单回合轮数上限（提示「已用满 N 轮」时要用）。 */
  maxTurns: number;
  totalCost: number;
  usage: unknown;
  error: string | null;
  errorKind: string | null;
  errorNodeId: string | null;
  /** 回合为什么停了。null = 还在跑。 */
  stopReason: 'completed' | 'maxTurns' | 'error' | 'aborted' | null;
  retrying: boolean;
  aborted: boolean;
  toolNames: readonly string[];
  trace: unknown;
  sessionId: string;
  cwd: string;
  providers: readonly string[];
  stats: unknown;
  /** 内核是否需要 API key（faux/demo 为 false）。 */
  needsApiKey: boolean;
}
/**
 * pi-web-ui 认识的 lifecycle 事件（它只 `switch` 这几个 type，其余一概不看）。
 * 关键：subscribe 的回调**收事件**，不是收「状态变了」的通知 —— 它上来就 `switch (e.type)`。
 */
export type UiLifecycleEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: unknown[] }
  | { type: 'message_start'; message: unknown }
  | { type: 'message_update'; message: unknown }
  | { type: 'message_end'; message: unknown };
export interface RemoteSessionOptions {
  /** 覆盖 SSE 端点（测试用）。 */
  eventsUrl?: string;
  fetchImpl?: typeof fetch;
  /**
   * 命令处理器。返回 true 表示「这条输入是命令，别发给模型」。
   *
   * 拦截点放在这里而不是界面里：`prompt()` 是输入的**唯一**出口，判一次前缀就够，
   * 不必去碰 pi-web-ui 的组件内部。
   */
  onCommand?: ((text: string) => Promise<boolean>) | undefined;
  /**
   * 请求失败时回调（发消息被 409/400 挡下、附件超限……）。
   *
   * 为什么不抛：pi-web-ui 的 `sendMessage()` 没人 catch，一个未处理的 Promise 拒绝
   * 在控制台里只是一行红字，界面上却是「消息消失了、模型也不回」—— 用户无从判断
   * 是哪儿坏了。走回调才能把它变成一条看得见的提示。
   */
  onError?: ((message: string) => void) | undefined;
}

/** pi-web-ui 的 Attachment（只声明用到的字段）。 */
interface UiAttachment {
  type: 'image' | 'document';
  fileName: string;
  mimeType: string;
  /** base64，不带 `data:` 前缀。 */
  content: string;
  extractedText?: string | undefined;
}

/**
 * 从 prompt 入参里取纯文本。
 *
 * 两种形状都要认：光秃秃一个字符串（无附件时 pi-web-ui 就是这么传的），或者
 * `{content: '...'}`（带附件时它传的是对象）。
 */
function readPromptText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input !== null && typeof input === 'object' && 'content' in input) {
    const content = (input as { content?: unknown }).content;
    if (typeof content === 'string') return content;
  }
  return '';
}

/** 取附件数组。pi-web-ui 在没有附件时**干脆不给这个字段**（不是给空数组）。 */
function readAttachments(input: unknown): UiAttachment[] {
  if (input === null || typeof input !== 'object' || !('attachments' in input)) return [];
  const attachments = (input as { attachments?: unknown }).attachments;
  return Array.isArray(attachments) ? (attachments as UiAttachment[]) : [];
}

/**
 * 附件 → pi-ai 的 content 块。
 *
 * 折法必须与 pi-web-ui 内部的 `convertAttachments` 一致（它也是：图片 → image 块；
 * 带 extractedText 的文档 → 带 `[Document: 文件名]` 头的 text 块），否则同一次发送
 * 在界面上是一种形状、发给模型是另一种。
 *
 * 这里**不 import** 那个函数：它会把 pdfjs / jszip / xlsx 整条依赖链拉进我们的模块图，
 * 而它自己早已全量加载过了。形状对等 + 服务端再校验一遍，比多一条依赖更稳。
 *
 * 返回 `undefined` = 没有附件（或附件全是非文本又抽不出字），让服务端走纯文本老路。
 */
function buildContent(
  text: string,
  attachments: readonly UiAttachment[],
): (TextContent | ImageContent)[] | undefined {
  if (attachments.length === 0) return undefined;
  const blocks: (TextContent | ImageContent)[] = [];
  // 文本块只在非空时加：用户可能只发图，而一个空的 text 块会让某些 provider 报参数错。
  if (text.trim()) blocks.push({ type: 'text', text });
  for (const attachment of attachments) {
    if (attachment.type === 'image') {
      blocks.push({ type: 'image', data: attachment.content, mimeType: attachment.mimeType });
    } else if (attachment.extractedText) {
      blocks.push({
        type: 'text',
        text: `\n\n[Document: ${attachment.fileName}]\n${attachment.extractedText}`,
      });
    }
  }
  return blocks.length > 0 ? blocks : undefined;
}

/**
 * 造一个 session（鸭子类型），喂给 pi-web-ui 的 `AgentInterface.session`。
 *
 * 它只暴露 adapter 真正用到的那几个成员 —— 见 web/src/session-adapter.ts 的 SessionView。
 */
export function createRemoteSession(options: RemoteSessionOptions = {}) {
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const eventsUrl = options.eventsUrl ?? '/api/events';

  let snapshot: RemoteSnapshot | null = null;
  /**
   * 占位串 → 真 base64 的图片缓存。
   *
   * 服务端的**广播帧**会把图片折成短占位串（见 src/message-content.ts 的
   * stubImageData）—— 不剥的话一张 2MB 的图会在一次回合的几百帧里反复传几百 MB，
   * 页面直接卡死。而**首帧**（新连接）与 `/api/snapshot` 带的是真图。
   *
   * 所以：首帧把每张真图按「它的占位串」记进这个 Map，之后的广播帧就只剩占位串。
   * 渲染时用同一个 `resolveImageStub()` 换回来（见 web/src/user-message.ts）。
   *
   * 用内容哈希当 key 是关键：同一张图在首帧与广播帧里的占位串天然一致，
   * 不需要维护任何跨帧的序号映射。
   */
  const imageCache = new Map<string, string>();
  // pi-web-ui 的 subscribe 回调收的是 **lifecycle 事件**（`{type: 'message_start'}` 这种），
  // 不是「状态变了」的裸回调 —— 它直接 `switch (e.type)`。所以这里要主动合成事件。
  const listeners = new Set<(event: UiLifecycleEvent) => void>();
  let source: EventSource | null = null;
  let connected = false;
  /** 收到远端状态的次数；界面用它做「已连接」提示。 */
  let received = 0;
  /** 上一帧，用来判断「这一帧多了/少了几条消息」。 */
  let previous: RemoteSnapshot | null = null;
/** 已经画过的错误文案（去重，见 errorNotice）。新对话 / 恢复会话时清掉。 */
let shownError: string | null = null;

  const emit = (event: UiLifecycleEvent): void => {
    for (const listener of listeners) listener(event);
  };

  /** 本仓库自己的订阅（顶栏、轨迹面板用）：不关心事件类型，只要「变了」。 */
  const plainListeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of plainListeners) listener();
  };

  /** 扫一帧的消息，把里面的真图 base64 记进 imageCache（key 用它自己的占位串）。 */
  const cacheImages = (messages: unknown[]): void => {
    for (const m of messages) {
      if (m === null || typeof m !== 'object') continue;
      const content = (m as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue;
        const b = block as { type?: unknown; data?: unknown };
        if (b.type !== 'image' || typeof b.data !== 'string') continue;
        if (isImageStub(b.data)) continue;
        imageCache.set(stubImageData(b.data), b.data);
      }
    }
  };

  const applySnapshot = (next: RemoteSnapshot): void => {
    const before = previous;
    previous = next;
    snapshot = next;
    received += 1;

    // 把这一帧里出现的**真图**记进缓存（首帧走这条路）。已是占位串的跳过 ——
    // 反过来做（把占位串存成自己）会污染缓存。
    cacheImages(next.messages);

    const messages = next.messages;
    const beforeMessages = before?.messages ?? [];
    const grew = messages.length > beforeMessages.length;
    const wasStreaming = before?.phase !== 'idle';
    const isStreaming = next.phase !== 'idle';

    // pi-web-ui 只认这几种：message_start / turn_start / turn_end / agent_start（重渲染）、
    // message_end（清流式容器）、agent_end（收尾）、message_update（喂流式容器）。
    if (!before) {
      emit({ type: 'agent_start' });
    } else if (grew) {
      // 新消息落地：逐条补 message_start + message_end，pi-web-ui 才会把气泡加进去。
      for (let i = beforeMessages.length; i < messages.length; i += 1) {
        const message = messages[i] as { role?: string } | undefined;
        if (!message) continue;
        emit({ type: 'message_start', message });
        emit({ type: 'message_end', message });
      }
    } else if (next.streamingText && next.streamingText !== before?.streamingText) {
      // 流式增量：message_update 让它把文本喂进流式容器。
      emit({
        type: 'message_update',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: next.streamingText }],
        },
      });
    }

    if (wasStreaming && !isStreaming) {
      // 环闭合：告诉它收尾。
      emit({ type: 'agent_end', messages });
    }

    notify();
  };

  const connect = (): void => {
    if (source) return;
    // EventSource 自带断线重连，浏览器端不用管。
    source = new EventSource(eventsUrl);
    source.onopen = () => {
      connected = true;
      notify();
    };
    // 注解只能给 `source.onmessage` 这个赋值语句（EventSource 的属性类型是
    // `(this: EventSource, ev: MessageEvent) => any`）。事件本身不泛型：EventSource 收的
    // SSE 数据只是 `string`，泛型化没有意义（那是 XMLHttpRequest 那侧的签名）。
    source.onmessage = (event: MessageEvent) => {
      try {
        applySnapshot(JSON.parse(event.data as string) as RemoteSnapshot);
      } catch {
        // 半帧 JSON（理论上不会发生，EventSource 保证整帧）：丢掉这一帧，等下一帧。
      }
    };
    source.onerror = () => {
      // readyState !== CONNECTING 说明重连也失败了。EventSource 会自己继续重试。
      connected = source?.readyState !== 2;
      notify();
    };
  };

  const post = async (path: string, body: unknown): Promise<void> => {
    await doFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  /**
   * 每次都造一份新的 state 对象。
   *
   * pi-web-ui 拿到 state 后按引用比较来决定重渲染；如果一直返回同一个对象，
   * 界面就永远不更新（这是 pi-agent-core 那套「就地改数组」的老问题的镜像）。
   */
/**
 * 内核的 `error` 折成一条 assistant 消息 —— pi-web-ui 只认这种形状的错误。
 *
 * ## 为什么不能只给 session.errorMessage
 *
 * pi-web-ui 的 `Messages.ts` 只渲染 `message.stopReason === 'error' && message.errorMessage`
 * 那个红框。它**从不读** session 上的 `errorMessage` —— 之前我们一直往那个字段写错误，
 * 于是「撞轮数上限」「LLM 调用失败」在 Web 上一个字都不显示，看上去就是「卡住了不动」。
 *
 * ## 为什么由渲染层合成，而不是让内核多存一条消息
 *
 * 内核的 `messages` 是要喂回模型的：多塞一条错误助手消息会污染上下文，模型会以为那是他自己说的。
 * 所以这里只在**交给 UI 的副本**上追加 —— 落盘、回放、下一轮请求看到的都还是干净的消息流。
 *
 * 同一个错误只画一次（`shownError` 去重）：内核不会重复推同一个 error，
 * 但下一条消息进来时 messages 变长，不去重就会把上一条错误重画一遍。
 */
const errorNotice = (s: RemoteSnapshot | null): AssistantMessage | null => {
  const text = s?.error;
  // 内核把 error 清空（用户又发话了 / 新对话）时，把去重标记也清掉，
  // 这样下一次**同样**的报错仍然会显示出来。
  if (!text) {
    shownError = null;
    return null;
  }
  if (text === shownError) return null;
  shownError = text;
  return {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: s?.providerName ?? 'unknown',
    model: s?.modelId ?? 'unknown',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    // 这两个字段才是 pi-web-ui 画红框的依据。
    stopReason: 'error',
    // 撞轮数上限不是故障，是「这一轮到此为止」—— 换个说法，
    // 免得每次收工都像报了个错。真正的失败才提示「已停止」。
    errorMessage: s?.stopReason === 'maxTurns' ? `这一轮已用满 ${s.maxTurns} 轮上限，已自动收工。可以直接追问，或用 /new 换个会话继续。` : text,
    timestamp: Date.now(),
  } as AssistantMessage;
};


  const makeState = (): Record<string, unknown> => {
    const s = snapshot;
    const notice = errorNotice(s);
    return {
      systemPrompt: s?.systemPrompt ?? '',
      model: s
        ? { id: s.modelId, provider: s.providerName, name: s.modelId, api: 'openai-completions' }
        : undefined,
      thinkingLevel: s?.thinkingLevel ?? 'off',
      // 复制数组：远端那份不能被界面直接改。
      // 末尾那条错误消息只给 UI 看，不回灌给模型（见 errorNotice 的说明）。
      messages: notice ? [...(s?.messages ?? []), notice] : [...(s?.messages ?? [])],
      tools: [],
      isStreaming: s?.phase === 'thinking' || s?.phase === 'calling-tools',
      streamingText: s?.streamingText ?? '',
      pendingToolCalls: new Set<string>(),
      errorMessage: s?.error ?? undefined,
      turns: s?.turns ?? 0,
      totalCost: s?.totalCost ?? 0,
      toolNames: [...(s?.toolNames ?? [])],
      trace: s?.trace,
      stats: s?.stats,
      errorKind: s?.errorKind,
      errorNodeId: s?.errorNodeId,
      retrying: s?.retrying ?? false,
      aborted: s?.aborted ?? false,
      streamSeq: s?.streamSeq ?? 0,
      thinkingText: s?.thinkingText ?? '',
      sessionId: s?.sessionId ?? '',
      cwd: s?.cwd ?? '',
      providers: [...(s?.providers ?? [])],
      needsApiKey: s?.needsApiKey ?? true,
      received,
      connected,
    };
  };

  const session = {
    /** pi-web-ui 读它拿状态。每次新对象 → 每次都会重渲染。 */
    get state(): Record<string, unknown> {
      return makeState();
    },

    /** pi-web-ui 的更新驱动：回调收的是 lifecycle 事件（见 UiLifecycleEvent）。 */
    subscribe(listener: (event: UiLifecycleEvent) => void): () => void {
      listeners.add(listener);
      connect();
      return () => {
        listeners.delete(listener);
      };
    },

    /** 本仓库自己的订阅（顶栏、轨迹面板）：只要「变了」，不关心事件类型。 */
    onChange(listener: () => void): () => void {
      plainListeners.add(listener);
      connect();
      return () => {
        plainListeners.delete(listener);
      };
    },

    /** 发送一句话（可能带附件） → Node dispatch 进环。 */
    async prompt(input: unknown): Promise<void> {
      // pi-web-ui 带附件时传 `{role:'user-with-attachments', content: 文本, attachments: [...]}`，
      // 无附件时传光字符串。两条形状都得认：
      //   - 只读 `content` 里的字符串 → attachments 被整个丢弃，图片永远发不出去；
      //   - 只认「有文本才发」        → 用户只发一张截图时消息被当成空消息丢掉。
      const text = readPromptText(input);
      const content = buildContent(text, readAttachments(input));
      if (!text.trim() && !content) return;
      // 斜杠命令在浏览器侧处理，**不发**给内核（那是给界面/内核的管理动作，
      // 不是「跟模型说的话」）。
      if (options.onCommand && (await options.onCommand(text))) return;
      // 发的是 `content`（已折成 pi-ai 的块），不是 `attachments`：后者是浏览器侧
      // 的对象，前者才是内核与 LLM 都认、且能落盘回放的形状。
      const res = await doFetch('/api/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(content ? { text, content } : { text }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        options.onError?.(detail?.error ?? `发消息失败（HTTP ${res.status}）`);
      }
    },

    /**
     * pi-web-ui 的 AgentInterface 会调 `session.requestUpdate()`。
     * 我们靠 SSE 推帧已经会触发重渲染，所以这里只需通知订阅者。
     */
    requestUpdate(): void {
      notify();
    },

    /** 中断当前回合。 */
    abort(): void {
      void post('/api/abort', {});
    },

    /** pi-web-ui 的 MessageEditor 会**直接写**这个字段，所以做成 setter 翻成一次请求。 */
    set thinkingLevel(level: 'off' | 'minimal' | 'low' | 'medium' | 'high') {
      if (snapshot) snapshot.thinkingLevel = level;
      notify();
    },

    get thinkingLevel(): 'off' | 'minimal' | 'low' | 'medium' | 'high' {
      return snapshot?.thinkingLevel ?? 'off';
    },

    set model(model: { provider?: string; id?: string } | undefined) {
      if (!model?.provider || !model.id) return;
      void post('/api/model', { provider: model.provider, modelId: model.id });
    },

    get model(): unknown {
      return session.state.model;
    },

    /** 换模型（顶栏下拉用）。 */
    async setModel(provider: string, modelId: string): Promise<void> {
      await post('/api/model', { provider, modelId });
    },

    /** 新对话。 */
    async reset(): Promise<void> {
      await post('/api/reset', {});
    },

    // ── 给本仓库界面用的（不是 pi-web-ui 契约） ──
    /** 当前快照（只读）。轨迹面板直接读它。 */
    get snapshot(): RemoteSnapshot | null {
      return snapshot;
    },
    /**
     * 占位串 → 真 base64。渲染器拿它把广播帧里的短占位换回图片
     * （见 web/src/user-message.ts）。**只读**。
     */
    get images(): ReadonlyMap<string, string> {
      return imageCache;
    },
    isConnected(): boolean {
      return connected;
    },
    /** 手动断开（页面卸载时用）。 */
    dispose(): void {
      source?.close();
      source = null;
      listeners.clear();
      plainListeners.clear();
    },
  };

  return session;
}

export type RemoteSession = ReturnType<typeof createRemoteSession>;
