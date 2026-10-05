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
  totalCost: number;
  usage: unknown;
  error: string | null;
  errorKind: string | null;
  errorNodeId: string | null;
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
  // pi-web-ui 的 subscribe 回调收的是 **lifecycle 事件**（`{type: 'message_start'}` 这种），
  // 不是「状态变了」的裸回调 —— 它直接 `switch (e.type)`。所以这里要主动合成事件。
  const listeners = new Set<(event: UiLifecycleEvent) => void>();
  let source: EventSource | null = null;
  let connected = false;
  /** 收到远端状态的次数；界面用它做「已连接」提示。 */
  let received = 0;
  /** 上一帧，用来判断「这一帧多了/少了几条消息」。 */
  let previous: RemoteSnapshot | null = null;

  const emit = (event: UiLifecycleEvent): void => {
    for (const listener of listeners) listener(event);
  };

  /** 本仓库自己的订阅（顶栏、轨迹面板用）：不关心事件类型，只要「变了」。 */
  const plainListeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of plainListeners) listener();
  };

  const applySnapshot = (next: RemoteSnapshot): void => {
    const before = previous;
    previous = next;
    snapshot = next;
    received += 1;

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
    source.onmessage = (event: MessageEvent<string>) => {
      try {
        applySnapshot(JSON.parse(event.data) as RemoteSnapshot);
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
  const makeState = (): Record<string, unknown> => {
    const s = snapshot;
    return {
      systemPrompt: s?.systemPrompt ?? '',
      model: s
        ? { id: s.modelId, provider: s.providerName, name: s.modelId, api: 'openai-completions' }
        : undefined,
      thinkingLevel: s?.thinkingLevel ?? 'off',
      // 复制数组：远端那份不能被界面直接改。
      messages: [...(s?.messages ?? [])],
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

    /** 发送一句话 → Node dispatch 进环。 */
    async prompt(input: unknown): Promise<void> {
      const text =
        typeof input === 'string'
          ? input
          : input !== null &&
              typeof input === 'object' &&
              'content' in input &&
              typeof (input as { content?: unknown }).content === 'string'
            ? (input as { content: string }).content
            : '';
      if (!text.trim()) return;
      await post('/api/message', { text });
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
