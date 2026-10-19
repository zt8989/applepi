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
 * pi-web-ui 恰好要一个「部分助手消息」——所以每次变化都发整份状态（简单、不会漂移），
 * 再补一条 `message_update` 让流式容器跟上。
 *
 * **发整份，但不逐 token 发** —— 流式期一个 token 一次 dispatch，那是几百 MB/s 的
 * `JSON.stringify` 垃圾（真把进程撞到 OOM 过）。合帧的细节与实测数字见 `FRAME_INTERVAL_MS`。
 * 事件与状态**同一帧一起发**，顺序是**先状态后事件**（`message_update` 要读 `state.isStreaming`）。
 */

import type { AgentStore } from '@ela/core/store';
import { stopCauseText, type AgentState } from '@ela/core/state';
import { abortRun } from '@ela/core/run-control';
import { isThinkingLevel } from '@ela/core/thinking-level';
import { deriveStream, type StreamNoticeEntry } from '@ela/core/stream';
import { expandSkillCommand, skillsInPrompt } from '@ela/core/skills';
import { expandPromptTemplate, promptTemplatesInPrompt } from '@ela/core/prompts';
import type { DialogHost } from '@ela/core/extension-ui';
import type { QuestionnaireIntent } from '@ela/core/questionnaire';
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

/** 桥要内核给的几个回调 —— 都是内核独有的能力（TUI 拿到的也是同一批）。
 *
 * ## 会话身份（id / cwd）不在这里
 *
 * 早先这两个是从外面递进来的：`cwd` 一份常量、`getSessionId` 一个函数。
 * 现在它们在 **store 里**（`state.session`）—— 与 TUI 读的是同一个地方。
 * 桥只负责把它们转上线协议。
 */
export interface WebBridgeOptions {
  store: AgentStore;
  /** 按 provider/modelId 解析出真的模型对象；解析不到给 `null`。 */
  resolveModel: (provider: string, id: string) => Model<Api> | null;
  /** 换模型（内核的 `setModel()`：一条 `model.changed`）。 */
  setModel: (provider: string, id: string) => boolean;
  /** 开新会话（换 id → 换文件）。 */
  newSession: () => void;
  /**
   * 恢复一个历史会话（侧边栏里点一条）；没接就拒绝并说一声。
   *
   * 与 `newSession` 同一类：**必须由内核出手** —— 换 id、换文件、把记录器游标对齐，
   * 三件事在一起才是对的恢复（见 `kernel.ts` 的 `restoreSession`）。桥只传 id + cwd，
   * 路径由 main.ts 那边拼（`findSessionFile`）。
   */
  resumeSession?: ((id: string, cwd: string) => Promise<{ restored: number }>) | undefined;
  /**
   * 底栏统计行（TUI 的 `statsLine()`）。给了才发 `statsText` / `statsLevel`。
   *
   * 走回调而不是在桥里 import `app.ts` 的 `statsLine`：桥是「内核状态 → 线协议」那一
   * 层，不该知道 TUI 的组件模块 —— 那个模块会拉进一整棵 pi-tui 的渲染图，而桥在
   * 只要起了 web server（`--web`）就会被构造 —— 测试探针也一样。
   */
  stats?: ((state: AgentState) => { text: string; level: 'none' | 'warn' | 'error' }) | undefined;
  /**
   * 底栏那一行工作目录（TUI 的 `cwdLine()`：家目录缩 `~` + git 分支）。
   *
   * 与 `stats` 同一个理由走回调：那一行由 `app.ts` 的两个函数算（`cwdLine` /
   * `gitBranch`），而桥不该 import `app.ts`（它会拉进一整棵 pi-tui 的渲染图）。
   * 不给就退回裸 cwd。
   */
  cwdLabel?: ((state: AgentState) => string) | undefined;
  /**
   * 扩展装载完成的门（内核 `deferExtensions` 时才有，见 `kernel.ts` 的 `ready`）。
   *
   * 浏览器那侧发消息也要等它：装载前 state 里的工具集与 system prompt 还是
   * 「没有扩展」的形状，先发出去的那条会定下一份缺工具集的 head（不可改的历史，
   * 见 `prompt-head.ts`）。与终端那边 `send()` 是同一道门。
   */
  ready?: Promise<void> | undefined;
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
 * 状态帧的最小间隔（ms）。
 *
 * ## 为什么必须合帧
 *
 * 桥挂在 `store.subscribe` 上，而**流式 token 每一个都是一次 dispatch** —— 每帧都推是
 * 「一个 token 一帧」。`snapshot()` 本身不贵，贵的是它下游的 `JSON.stringify`：那是
 * **O(整段会话)** 的。实测一份 4.6MB 的会话，stringify 一次 13ms、产出 4.6MB 字符串，
 * 而流式期每帧要发 `state` + `message_update` 两份 —— 一个 token 就是 ~26ms CPU 加
 * ~9MB 垃圾。token 密集时（几十个/秒）等于每秒几百 MB 的垃圾，GC 追不上：堆会一路
 * 冲到 2GB 以上，最后以 `FATAL ERROR: heap out of memory` 收场（真发生过两次，
 * 崩溃报告里 `heapUsed` 2.6GB、上限 4.35GB）。顺带把 TUI 也拖住 —— 主线程在
 * stringify 里，按键与重画都得排队，症状就是「思考时界面直接卡死」。
 *
 * 合帧之后，整份状态与 token 速率解耦 —— **但不丢边界**。真正的判据是「结构变没变」
 * （见 `structureChanged`），`FRAME_INTERVAL_MS` 只是「多久重看一眼」：
 *
 *   - 结构变了（开跑 / 收工 / 换模型 / 工具起止 / 消息落地）→ **立刻**发一帧整份状态；
 *   - 只是流式文本在长 → 整份状态**不发**，只发一条 `message_update`（见
 *     `sendStreamingDelta`）；窗口到期重看一次，并最多 `STATE_MAX_IDLE_MS` 用
 *     一帧整份状态兜底；
 *   - 真的什么都没变 → 一个字节都不发（落盘器回的 `trace.persisted` 就是这种）。
 *
 * 于是「`isStreaming` 变了」「助手消息落地了」这类边界一格都不会丢，而一段 2MB 的
 * 会话跑 200 个 token，整份状态从 400 帧降到 2 帧（实测 883MB → 6.9MB）。
 */
const FRAME_INTERVAL_MS = 100;

/**
 * 整份状态帧的兜底间隔（ms）。
 *
 * 该不该发整份状态，判据是「结构变没变」（见 `structureChanged`）—— 而**判据是人写的**，
 * 漏一项的后果是浏览器一直显示旧值，而且**不会自己好**。所以再压一条：只要还在变，
 * 最多 `STATE_MAX_IDLE_MS` 必发一帧整份状态。代价是 1 帧/秒（4MB 的会话 = 4MB/s，
 * 相对改之前每 token 两份的几百 MB/s 可以忽略），换来「不可能漂移超过一秒」。
 *
 * ## 为什么流式文本不算「结构」
 *
 * 因为 `message_update`（见 `sendStreamingDelta`）已经把它单独发了。判据里再带上它，
 * 等于每 token 都「结构变了」—— 又回到改之前的老样子。
 */
const STATE_MAX_IDLE_MS = 1000;

/**
 * `WebAgentState` 里「变了就必须重发整份」的那几项。
 *
 * 都是**引用或原始值**（不比内容），所以比一次是 O(1)。剩下的那个会变的（流式文本）
 * 走 `message_update` 单独一条道。`snapshot()` 里出现的字段要么在这，要么在流式那一条里，
 * 漏一个就是「界面停在那儿不动」。
 */
interface StateStructure {
  sessionId: string;
  messages: readonly unknown[];
  phase: AgentState['phase'];
  providerName: string;
  modelId: string;
  thinkingLevel: AgentState['thinkingLevel'];
  executing: readonly unknown[];
  toolNames: readonly string[];
  toolTimings: Readonly<Record<string, number>>;
  stopReason: AgentState['stopReason'];
  stopCause: AgentState['stopCause'];
  error: string | null;
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
  /**
   * 开场诊断（给新连上来的浏览器）。
   *
   * **取值而不是快照**：内核 `deferExtensions` 时装载诊断是后台装载完才有的
   * （见 `WebBridgeOptions.ready`）——快照一次就等于永远报不出它们。
   */
  private readonly noticesSource: () => readonly string[];
  /** 扩展装载完成了吗（同步的一面，见 `WebBridgeOptions.ready`）。 */
  private extensionsReady: boolean;
  /** 上一次发出去的流式文本 —— 只在真的变了才发 `message_update`（否则每个 store 变化都刷屏）。 */
  private lastStreamingKey = '';
  /**
   * 客户端知不知道「现在在跑」。
   *
   * 流式增量（`message_update`）与状态帧是两条道，而协议要求**先状态后事件**
   * （`message_update` 要读 `state.isStreaming`）。这个开关就是那个先后关系：
   * 只有已经发过 `isStreaming=true` 的状态帧，才允许往客户端发 `message_update`。
   */
  private streamingStateSent = false;
  /** 上一帧整份状态是什么时候发的（兜底用，见 `STATE_MAX_IDLE_MS`）。 */
  private lastStateFrameAt = 0;
  /** 上一帧整份状态发出去时的「结构」（见 `StateStructure`）；`undefined` = 还没发过。 */
  private lastStructure: StateStructure | undefined;
  /** 这一窗里有变化还没发（见 `onStoreChange` 的合帧）。 */
  private dirty = false;
  /** 合帧定时器；`undefined` = 这一窗还没排。 */
  private frameTimer: ReturnType<typeof setTimeout> | undefined;
  /** 待回答的对话框：id → 帧 + 收尾函数。见 `requestDialog`。 */
  private readonly pendingDialogs = new Map<
    string,
    { message: WebServerMessage; finish: (value: string | undefined) => void }
  >();
  /** 对话框 id 的自增号（只需要在本进程内唯一）。 */
  private dialogSeq = 0;
  /**
   * 当前那份**问卷**（多题 tab）：整份快照 + 用户意图的回路。
   *
   * 与 `pendingDialogs` 不是一回事：那边是"一次一问、等一个答复"，这边是**常驻**的
   * 一份表（题切了、勾选变了都要重发整份快照）。服务端是唯一状态源 —— 浏览器只推意图，
   * 连"当前停在第几题"也由服务端拍。
   */
  private questionnaire:
    | { id: string; message: WebServerMessage; onIntent: (intent: QuestionnaireIntent) => void }
    | undefined;

  /**
   * 浏览器侧的对话框宿主（`ctx.ui.select/confirm/input` 走它）。
   *
   * 发给**所有**连接：随便哪个标签页回答都算；谁先答就把别处的弹窗关掉。
   */
  readonly dialogs: DialogHost = {
    available: () => this.listeners.size > 0,
    select: (title, choices, signal) =>
      this.requestDialog({ method: 'select', title, options: [...choices] }, signal),
    confirm: (title, message, signal) =>
      this.requestDialog({ method: 'confirm', title, message }, signal).then((value) => value === 'yes'),
    input: (title, placeholder, signal) =>
      this.requestDialog(
        { method: 'input', title, ...(placeholder !== undefined ? { placeholder } : {}) },
        signal,
      ),
    questionnaire: {
      open: (snapshot, onIntent) => {
        const id = `uiq-${++this.dialogSeq}`;
        const message: WebServerMessage = { type: 'ui-questionnaire', id, snapshot };
        this.questionnaire = { id, message, onIntent };
        this.broadcast(message);
        return {
          push: (next) => {
            // 已经关掉的那一份：晚到的 push 丢掉（否则会在新一份问卷上画旧内容）。
            if (this.questionnaire?.id !== id) return;
            const frame: WebServerMessage = { type: 'ui-questionnaire', id, snapshot: next };
            this.questionnaire.message = frame;
            this.broadcast(frame);
          },
          close: () => {
            if (this.questionnaire?.id !== id) return;
            this.questionnaire = undefined;
            this.broadcast({ type: 'ui-questionnaire-close', id });
          },
        };
      },
    },
  };

  /** 广播一个对话框请求，等第一个回答（或 `signal` 中断）。 */
  private requestDialog(
    request: {
      method: 'select' | 'confirm' | 'input';
      title: string;
      options?: string[];
      message?: string;
      placeholder?: string;
    },
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const id = `ui-${++this.dialogSeq}`;
    return new Promise<string | undefined>((resolve) => {
      const finish = (value: string | undefined): void => {
        if (!this.pendingDialogs.delete(id)) return;
        // 别的标签页（以及双端里的终端）可能还在看同一个问题 —— 先让它们关掉。
        this.broadcast({ type: 'ui-cancel', id });
        resolve(value);
      };
      const message: WebServerMessage = { type: 'ui-request', id, ...request };
      this.pendingDialogs.set(id, { message, finish });
      if (signal.aborted) {
        finish(undefined);
        return;
      }
      signal.addEventListener('abort', () => finish(undefined), { once: true });
      this.broadcast(message);
    });
  }

  constructor(
    options: WebBridgeOptions,
    notices: readonly string[] | (() => readonly string[]) = [],
  ) {
    this.options = options;
    this.noticesSource = typeof notices === 'function' ? notices : () => notices;
    this.extensionsReady = options.ready === undefined;
    if (options.ready !== undefined) {
      void options.ready.then(() => {
        this.extensionsReady = true;
      });
    }
    this.previous = this.snapshot();
    this.unsubscribe = options.store.subscribe(() => this.onStoreChange());
  }

  /** 新连接进来时的开场：整份状态 + 诊断。 */
  hello(): WebServerMessage {
    return {
      type: 'hello',
      version: this.version,
      state: this.snapshot(),
      notices: [...this.noticesSource()],
    };
  }

  /**
   * 订阅广播。返回退订函数。
   *
   * ## 为什么第一个订阅者要先把「上一帧」对齐
   *
   * 没订阅者时 `onStoreChange()` 直接返回（见那里），`previous` 于是**停在没人看的那一刻**。
   * 浏览器接上来的瞬间如果拿那份陈旧的 `previous` 做差，下一个窗口会把积攒的一整段变化
   * 当成刚发生的事发出去 —— `agent_start` / `message_start` 之类会重复播一遍。
   * 所以第一个订阅者进来时先把 `previous` 归位到当下；`hello()` 本来就会带一份完整状态，
   * 订阅者拿到的东西一个字节都不少。
   */
  subscribe(listener: (message: WebServerMessage) => void): () => void {
    if (this.listeners.size === 0) {
      this.resync();
      this.listeners.add(listener);
    } else {
      this.listeners.add(listener);
    }
    // 还没回答的对话框补发给这个新连接 —— 没有这一步的话，先弹的对话框在
    // 「刷新页面 / 后开的标签页」里根本看不到，而服务端还卡在那里等答复。
    for (const { message } of this.pendingDialogs.values()) listener(message);
    // 问卷同理（而且它更常被刷新撞上：一填就是好几题，人在里面待得久）。
    if (this.questionnaire !== undefined) listener(this.questionnaire.message);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 把「上一帧」归位到当下（没人看的那段时间攒下的变化不要补播）。 */
  private resync(): void {
    this.previous = this.snapshot();
    this.lastStreamingKey = '';
    this.streamingStateSent = false;
    this.lastStructure = this.readStructure();
    this.lastStateFrameAt = Date.now();
    this.dirty = false;
    if (this.frameTimer !== undefined) {
      clearTimeout(this.frameTimer);
      this.frameTimer = undefined;
    }
  }

  /** 处理一条来自浏览器的消息。返回给**这一条连接**的即时回执（没有就是空数组）。 */
  handle(message: WebClientMessage): WebServerMessage[] {
    switch (message.type) {
      case 'prompt': {
        const raw = message.text.trim();
        if (raw === '') return [];
        // `/skill:<名字>` **不是命令**，而是「把 SKILL.md 展开成 `<skill>` 块发给模型」
        // —— 与 TUI 的 `editor.onSubmit` 同一处逻辑（共用同一个 `expandSkillCommand`）。
        // 展开必须在服务端做：SKILL.md 在磁盘上，浏览器读不到。
        const state = this.options.store.getState();
        let text = raw;
        if (raw.startsWith('/skill:')) {
          const name = raw.slice('/skill:'.length).split(/\s+/)[0] ?? '';
          const skills = skillsInPrompt(state);
          // 找不到同名 skill **不是错误**：保持原样发出去（与 pi 的
          // `_expandSkillCommand()` 一致 —— 它认不出就原样返回）。
          if (skills.some((skill) => skill.name === name)) {
            text = expandSkillCommand(raw, skills);
          }
        }
        // Prompt 模板：与 TUI 同一个展开函数（正文也在服务端）。没有同名模板时原样返回，
        // 所以未知的 `/xxx` 仍然按用户输入发出去（与终端那边一致，见 `editor.onSubmit`）；
        // 浏览器里的扩展命令在前端已经走 `/api/command` 了，这里只接模板与 skill。
        text = expandPromptTemplate(text, promptTemplatesInPrompt(state));
        if (state.phase !== 'idle') {
          // 跑着的时候再发就排队（与 TUI 的 steer 同一个口径），不打断当前回合。
          this.options.store.dispatch({ type: 'queue.input', text, as: 'steer' });
          return [{ type: 'notice', level: 'info', text: '环在跑，这条已排队（工具跑完后投递）' }];
        }
        // 扩展还在后台装（内核 `deferExtensions`）：等它装完再发 —— 见
        // `WebBridgeOptions.ready` 的注释（为什么要等）。**不丢用户的输入**：
        // 这里只是把同一条消息推后发，并说一声为什么。
        if (this.options.ready !== undefined && !this.extensionsReady) {
          const ready = this.options.ready;
          void ready.then(() => {
            this.options.store.dispatch({ type: 'user.message', text });
          });
          return [
            { type: 'notice', level: 'info', text: '扩展还在装载（终端那边同样），装载完就发出去' },
          ];
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
        // 环在跑时不能换会话（正在写消息）—— 与 TUI 的 `/new` 同一条规矩。
        // 桥这边是第二道闸：侧边栏已经把「新建」锁上了（
        // `sidebar.ts`），但浏览器可能拿着旧的一帧（另一个标签页刚发的命令）。
        if (this.options.store.getState().phase !== 'idle') {
          return [{ type: 'notice', level: 'warn', text: '上一回合还没结束，先中断再开新会话' }];
        }
        this.options.newSession();
        return [];
      }
      case 'resumeSession': {
        // 环在跑时不能换会话（消息还在往当前那个文件里写）—— 与 TUI 的 `/resume`
        // 同一口径：拒绝并说一声，不静默。
        if (this.options.store.getState().phase !== 'idle') {
          return [{ type: 'notice', level: 'warn', text: '上一回合还没结束，先中断再恢复历史' }];
        }
        const resume = this.options.resumeSession;
        if (resume === undefined) {
          return [{ type: 'notice', level: 'warn', text: '这个装配不能恢复历史会话' }];
        }
        // 恢复是异步的（要读文件、要读轨迹树），且恢复**不换工作目录**
        // （cwd 是内核启动时定的，见 reducer 的 `conversation.reset`）。
        // 不等着它：`handle` 是同步的，而阻塞在这里会让这条连接的其他消息排队。
        // 成功不提示（恢复的是哪一段，点的人自己清楚；恢复完界面自会重渲染）。
        void resume(message.id, message.cwd).catch((error: unknown) => {
            this.broadcast({
              type: 'notice',
              level: 'error',
              text: `恢复失败：${error instanceof Error ? error.message : String(error)}`,
            });
          });
        return [];
      }
      case 'ui-response': {
        // 第一个回答算数（`finish` 自己判重）。
        this.pendingDialogs.get(message.id)?.finish(message.cancelled === true ? undefined : message.value);
        return [];
      }
      case 'ui-questionnaire-intent': {
        // 问卷里的一个动作。只认当前那一份的 id（旧标签页拿着已关掉的问卷发东西，就当没看见）。
        if (this.questionnaire?.id === message.id) this.questionnaire.onIntent(message.intent);
        return [];
      }
      default:
        return [];
    }
  }

  dispose(): void {
    // 等着的对话框先放掉：不放的话扩展的那个 promise 永远不 resolve，
    // 而它还占着那一刻的工具调用（退出时看着就是「进程不退」）。
    for (const { finish } of [...this.pendingDialogs.values()]) finish(undefined);
    this.unsubscribe();
    this.listeners.clear();
    if (this.frameTimer !== undefined) {
      clearTimeout(this.frameTimer);
      this.frameTimer = undefined;
    }
  }

  /** 组一份当前状态。整份发出去 —— 不做差分，差分是最容易漂移的那类优化。 */
  private snapshot(): WebAgentState {
    const state = this.options.store.getState();
    const model = this.options.resolveModel(state.providerName, state.modelId);
    const stats = this.options.stats?.(state);
    const errorMessage =
      state.stopReason === 'error' || state.stopReason === 'aborted'
        ? state.stopCause === null
          ? state.stopReason === 'aborted'
            ? '已中止'
            : '出错了'
          : stopCauseText(state.stopCause)
        : null;
    return {
      // 会话身份从 **store** 里读（与 TUI 同一个地方）—— 不再各自去问内核。
      sessionId: state.session.id,
      cwd: state.session.cwd,
      cwdText: this.options.cwdLabel?.(state) ?? state.session.cwd,
      messages: streamItems(state),
      model,
      thinkingLevel: state.thinkingLevel,
      isStreaming: state.phase !== 'idle',
      streamingMessage: state.phase === 'idle' ? null : partialAssistantMessage(state, model),
      pendingToolCalls: state.executing.map((tool) => tool.call.id),
      errorMessage,
      toolNames: [...state.toolNames],
      // 拷一份：`state.toolTimings` 是活的对象（下一次 `tool.result` 会换成新的），
      // 而这一份会被 `JSON.stringify` 写进帧里 —— 拷一次就不怕以后被原地改到。
      toolTimings: { ...state.toolTimings },
      statsText: stats?.text ?? '',
      statsLevel: stats?.level ?? 'none',
    };
  }

  /**
   * store 变了：**先分道，再决定要不要真发**。
   *
   * 三件事，按代价从小到大：
   *
   *   1. 空转（没有浏览者）就一个字节都不算 —— 这才是最常见的情形（终端里跑 ela、
   *      没开 web 界面），而 `snapshot()` + `JSON.stringify` 都是 O(整段会话) 的；
   *   2. **流式增量**（只带「正在长的那一条」，几十 KB）立刻发；
   *   3. **整份状态**只在「结构变了」或「距上一帧超过 `STATE_MAX_IDLE_MS`」时发
   *      （见 `stateFrameDue`）。流式期两者都稳定，于是整份状态从「每 token 两份」
   *      降到「一秒一帧」。
   *
   * 同步发是故意的：原来的形状就是「store 一变就广播」；现在只是**大负载那一半**
   * 变成了按需 + 合帧，小负载那一半还是一条不漏。
   */
  private onStoreChange(): void {
    if (this.listeners.size === 0) return;
    const streamChanged = this.sendStreamingDelta();
    // **真的什么都没变就不算变化。**
    //
    // Redux 是「每次 dispatch 都通知」，而有些 dispatch 不动这两样东西 —— 最典型的是
    // 落盘器自己回的 `trace.persisted`（它就在 store 订阅器里 dispatch）。不挡这一下，
    // 一次落盘会引出一次广播，而广播又会再引出一次落盘 —— 自己把自己转起来。
    if (!streamChanged && !this.structureChanged()) return;
    this.dirty = true;
    // 该发整份就**立刻**发：「开跑 / 收工 / 工具起止」这些边界不能等到窗口末尾
    // （一窗才 100ms，但一秒里就能堆出好几个边界，界面会看起来一顿一顿的）。
    if (this.stateFrameDue(Date.now())) {
      this.sendFrame();
      this.dirty = false;
      return;
    }
    if (this.frameTimer === undefined) this.armFrameTimer();
  }

  /**
   * 开一个合帧窗口；窗口到了再看一次「该不该发整份」。
   *
   * `dirty` 只在**真发出整份状态**后才清：还没到该发的时候（比如只是流式文本在长，
   * 离兜底那一秒还早）就再等一个窗口 —— 否则兜底那一帧永远不会到点。
   */
  private armFrameTimer(): void {
    // `unref()`：这个定时器不该让进程为了「再看一眼」而多活 100ms。
    this.frameTimer = setTimeout(() => {
      this.frameTimer = undefined;
      if (this.listeners.size === 0 || !this.dirty) return;
      if (!this.stateFrameDue(Date.now())) {
        this.armFrameTimer();
        return;
      }
      this.dirty = false;
      this.sendFrame();
    }, FRAME_INTERVAL_MS);
    this.frameTimer.unref?.();
  }

  /** 现在该发整份状态了吗：结构变了，或兜底那一秒到了（见 `STATE_MAX_IDLE_MS`）。 */
  private stateFrameDue(now: number): boolean {
    return this.structureChanged() || now - this.lastStateFrameAt >= STATE_MAX_IDLE_MS;
  }

  /** 当前状态里的「结构」那几项（比引用，不比内容）。见 `StateStructure`。 */
  private readStructure(): StateStructure {
    const state = this.options.store.getState();
    return {
      sessionId: state.session.id,
      messages: state.messages,
      phase: state.phase,
      providerName: state.providerName,
      modelId: state.modelId,
      thinkingLevel: state.thinkingLevel,
      executing: state.executing,
      toolNames: state.toolNames,
      toolTimings: state.toolTimings,
      stopReason: state.stopReason,
      stopCause: state.stopCause,
      error: state.error,
    };
  }

  private structureChanged(): boolean {
    const last = this.lastStructure;
    if (last === undefined) return true;
    const now = this.readStructure();
    return (
      last.sessionId !== now.sessionId ||
      last.messages !== now.messages ||
      last.phase !== now.phase ||
      last.providerName !== now.providerName ||
      last.modelId !== now.modelId ||
      last.thinkingLevel !== now.thinkingLevel ||
      last.executing !== now.executing ||
      last.toolNames !== now.toolNames ||
      last.toolTimings !== now.toolTimings ||
      last.stopReason !== now.stopReason ||
      last.stopCause !== now.stopCause ||
      last.error !== now.error
    );
  }

  /**
   * 一份流式增量（`message_update`）。
   *
   * ## 为什么它与状态帧分道
   *
   * 状态帧的负载是 **O(整段会话)**（`messages` 全在里面），而 `message_update` 只带
   * 「正在长的那一条」。把前者降到按需是一回事，后者没有任何理由跟着降：降了症状是
   * 「浏览器里的回复一跳一跳，秒回的一轮干脆看不见动画」。
   *
   * 所以这一条**每个 store 变化都看**，只是内容真变了才发（`lastStreamingKey`）。
   */
  private sendStreamingDeltaOf(streaming: WebAgentState['streamingMessage'], isStreaming: boolean): boolean {
    if (!isStreaming || streaming === null) {
      // 这一轮完了：把键清掉，下一轮的第一帧才不会被上一轮的尾巴抑制。
      this.lastStreamingKey = '';
      return false;
    }
    const key = JSON.stringify(streaming.content);
    if (key === this.lastStreamingKey) return false;
    this.lastStreamingKey = key;
    this.broadcast({ type: 'event', event: { type: 'message_update', message: streaming } });
    return true;
  }

  /**
   * 从 store 里现算一条流式增量（`onStoreChange` 走这条）。
   *
   * 只读 `streamingText` / `thinkingText` / `executing` 那一小块，**不碰 `messages`**。
   *
   * @returns 真的发了一条（= 流式内容变了）。调用方靠它区分「这次变化要不要当回事」。
   */
  private sendStreamingDelta(): boolean {
    // 还没发过 `isStreaming=true` 的状态帧就不许发事件（协议要求先状态后事件）。
    if (!this.streamingStateSent) return false;
    const state = this.options.store.getState();
    if (state.phase === 'idle') return false;
    const model = this.options.resolveModel(state.providerName, state.modelId);
    return this.sendStreamingDeltaOf(partialAssistantMessage(state, model), true);
  }

  /** 发一帧整份状态 + 这一帧上的事件（两者次序：先状态后事件）。 */
  private sendFrame(): void {
    const next = this.snapshot();
    const previous = this.previous;
    this.previous = next;
    this.lastStructure = this.readStructure();
    this.lastStateFrameAt = Date.now();

    const events: WebAgentEvent[] = [];
    if (!previous.isStreaming && next.isStreaming) {
      events.push({ type: 'agent_start' }, { type: 'turn_start' });
      if (next.streamingMessage) {
        events.push({ type: 'message_start', message: next.streamingMessage });
      }
    }
    if (previous.isStreaming && !next.isStreaming) {
      const last = lastAssistant(next.messages);
      if (last) events.push({ type: 'message_end', message: last });
      events.push({ type: 'agent_end' });
    }

    // 先状态后事件：`message_update` 要读 `state.isStreaming`（见文件头）。
    this.broadcast({ type: 'state', state: next });
    this.streamingStateSent = next.isStreaming;
    for (const event of events) this.broadcast({ type: 'event', event });
    // 这一帧带上的流式内容也补一条增量：不然「开场那一帧刚好已经有字」会等到下一次
    // store 变化才显示（而快捷回合可能根本不再有下一次）。
    this.sendStreamingDeltaOf(next.streamingMessage, next.isStreaming);
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