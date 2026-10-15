import type {
  ImageContent,
  Message,
  ModelThinkingLevel,
  TextContent,
  ToolCall,
  Usage,
} from '@earendil-works/pi-ai';
import type { ModelCapabilities, PromptToolDefinition } from './actions';
import type { SkillInfo } from './skills';
import { compactionSettings, type CompactionSettings } from './compact';
import { createTraceTree, newSessionId, type TraceTree } from './trace';

/** 相位：只描述「现在在等谁」，不含任何驱动方式的信息。 */
export type Phase = 'idle' | 'thinking' | 'calling-tools';

/**
 * 排队的用户输入 —— 环在跑的时候人还能说话（与 pi 的 steer / followUp 同一个口径）。
 *
 * ## 两种队列的差别是**投递时机**，不是优先级
 *
 * - `steer`：当前 step 的工具跑完后、**下一次 LLM 调用之前**插入。
 *   也就是说它会打断「模型→工具→模型」这个循环的延续，让模型看到新的话。
 * - `followUp`：等到模型**没有工具调用了**（回合本该收工）才插入，然后开一个新回合。
 *   它不打断任何东西，只是「接着聊」。
 *
 * 两者都是 FIFO，各自独立成列（pi 也是两列：两个队列的元素互不排队）。
 *
 * ## 为什么入队的是 text 而不是 Message
 *
 * 与 `user.message` 一样，附件在装载时折成 content 块 —— 入队的就是「一句话」，
 * 真要发出去时才组装成消息（见 reducer 的 `queue.delivered`）。
 */
export interface QueuedInput {
  text: string;
  content?: (TextContent | ImageContent)[] | undefined;
  /** 入队时刻（毫秒）。界面显示「排了多久」用；也是 FIFO 的稳定排序依据。 */
  at: number;
}

/** 队列里那条输入怎么来的 —— 界面用它选颜色（与 pi 的 pendingMessages 同一个口径）。 */
export type QueueKind = 'steer' | 'followUp';

/**
 * 一次「回合」（turn）的结局。
 *
 * 界面/轨迹靠它区分「这一回合是自己说完的」与「是被外部打断的」——
 * 而这两种在 `stopReason` 里都是 `completed`/`aborted`，分不开。
 */
export type TurnEndReason = 'completed' | 'maxTurns' | 'error' | 'aborted' | 'interrupted';

export interface ExecutingTool {
  call: ToolCall;
  startedAt: number;
}

/**
 * 一个正在跑的工具当前的**中间输出**。
 *
 * ## 为什么要单独一份而不是提前写进 messages
 *
 * `messages` 是**发给模型的那份历史**，它只该有终值。中间态一旦进去就有三个麻烦：
 *   - 每个增量都要 append 一条，最终得去重、还得让模型看到一堆中间状态；
 *   - 流式过程中随时可能被 Ctrl-C 掉，于是 messages 里留下一个**没有结果**的工具调用
 *     —— 协议非法（下一个请求直接被 provider 拒）；
 *   - 落盘器会把中间态一起写进会话文件，恢复出来是一堆垃圾。
 *
 * 所以中间态只放这里（纯展示），终值才进 `messages`。
 */
export interface ToolProgress {
  toolCallId: string;
  content: (TextContent | ImageContent)[];
}

/** LLM 失败的类别 —— 决定它是不是「可重试」的（超时/网络可重试，鉴权/参数不行）。 */
export type LlmErrorKind = 'timeout' | 'network' | 'auth' | 'model' | 'aborted' | 'unknown';

/**
 * 回合为什么停了 —— 界面据此区分「正常收工」和「被砍」。
 *
 * ## 为什么不能靠 errorKind 猜
 *
 * `errorKind` 说的是「LLM 调用失败的原因」，它对「撞轮数上限」这种**根本没失败**的情况没有定义
 * （一直是 null）。而 `error` 又只是一句给人看的字符串，界面没法拿它做判断。
 * 结果就是：撞上限、LLM 报错、手动中断在界面上长得一模一样，只能靠猜。
 *
 * - `completed`：模型自己说完了，正常的。
 * - `maxTurns`：撞了单回合轮数上限，被砍。
 * - `error`：LLM 调用失败（配 `errorKind` 看是哪一类）。
 * - `aborted`：用户手动中断。
 */
export type StopReason = 'completed' | 'maxTurns' | 'error' | 'aborted';
/**
 * ═══ 停止的**具体原因** ═══
 *
 * `StopReason` 只说「这一轮是哪种结局」，它把好几件事压成了一个 `error`：模型超时、网络抖动、
 * 鉴权失败、工具批次整体挂掉、用户自己按了中断 —— 界面上全都长得一样（一条红字）。
 *
 * 这一层把「为什么停」拆细，界面与日志直接念它，不必去猜 `error` 的文案：
 *
 *   - `user`：用户手动中断（Ctrl-C / Web 的停止按钮）。**不是故障**，不该弹红框。
 *   - `timeout` / `network` / `auth` / `model` / `llm-error`：LLM 调用失败，细分到能对上处置办法。
 *   - `tool-error`：工具批次整体挂掉（LLM 根本没在跑）。
 *   - `maxTurns`：撞单回合轮数上限。
 *   - `completed`：模型自己说完了。
 *   - `shutdown`：进程/内核被关停（主动 abort 的非用户来源）。
 *
 * 它由 `llm.failed` / `llm.giveup` 这两条 action 带进来 —— 见 actions.ts 的 `cause` 字段。
 */
export type StopCause =
  | 'completed'
  | 'maxTurns'
  | 'user'
  | 'timeout'
  | 'network'
  | 'auth'
  | 'model'
  | 'llm-error'
  | 'tool-error'
  | 'shutdown'
  /**
   * 上下文压缩失败。
   *
   * 为什么它进 `StopCause` 而不是 `StopReason`：压缩**不是**一轮对话，它不结束任何东西。
   * 但它失败时用户确实需要知道（否则「为什么上下文一直超」没有答案），
   * 而 `stopCause` 正是「一句人话 + 按类型上色」的那一层。
   */
  | 'compact-error';

/** 停止原因 → 一句人话（界面与日志直接用，不必各写一份文案）。 */
export function stopCauseText(cause: StopCause): string {
  switch (cause) {
    case 'user':
      return '用户手动中断';
    case 'timeout':
      return '大模型调用超时';
    case 'network':
      return '网络错误';
    case 'auth':
      return '鉴权失败（API key 无效或无权限）';
    case 'model':
      return '模型侧报错';
    case 'llm-error':
      return '大模型调用失败';
    case 'tool-error':
      return '工具批次整体失败';
    case 'maxTurns':
      return '已达单回合轮数上限';
    case 'shutdown':
      return '被内核关闭';
    case 'compact-error':
      return '上下文压缩失败（对话原样保留）';
    case 'completed':
      return '模型自己说完了';
  }
}


/**
 * prompt 侧状态 —— 与 model 分开装载：prompt 是「跟模型说什么」，model 是「用哪个模型说」。
 * 整块由 `prompt.init` 装载，之后只被 `prompt.segment.added` 追加。
 *
 * 有了它，回放时不必重跑就知道当时发给模型的是什么。
 *
 * 扩展（洋葱式 middleware）不写在这里 —— 它横切所有 action，见 packages/core/src/middleware.ts。
 */
export interface PromptState {
  /** 基础 system prompt（渲染好的整段）。 */
  systemPrompt: string;
  /**
   * 整段 prompt 的**分段**（pi 的 `SystemPromptSections`：段名 → 文本）。
   *
   * `systemPrompt` 是它的渲染结果，而这个才是原料：有了它，中途的 prompt 变更才能
   * **按段 patch**（只有变了的段进新消息，已有消息一个字节不动 —— 前缀缓存因此保住）。
   * 没它的话任何变更都得整段重发。
   *
   * **可选**：旧轨迹文件的 init 段里没有这个字段。没有时只能当「一整段 prompt」
   * （head 用 `content` 而不是 `sections`，见 `prompt-head.ts`）。
   */
  sections?: Record<string, string>;
  /**
   * **当前**工具的完整定义（原样进 LLM 请求的那三样）。
   *
   * 会话中途会变（loader 工具 `web_enable` / `subagents_enable` 会调 `setActiveTools`），
   * 变更走 `tools.changed`，而「变了」这件事由 `agent.run` 在请求前 diff 成一条
   * `toolsAdded` / `toolsRemoved` 消息声明给模型（见 `prompt-head.ts`）。
   */
  tools: PromptToolDefinition[];
  /**
   * **装载时**那一批工具定义 —— head 里 `toolsAdded` 用的就是它，永不更新。
   *
   * 为什么必须留一份「旧的」：head 是**不可变历史**（前缀缓存靠的就是它一个字节不动）。
   * 工具集变了之后，如果 head 也跟着换成新的，前缀立刻作废 —— 变更必须作为
   * **新的** system 消息追加（`toolsAdded`），而不是去改第一条。
   *
   * 缺省（老轨迹回放 / 测试）时按「没有变过」处理：head 直接用 `tools`。
   */
  headTools?: PromptToolDefinition[];
  /**
   * 装进来的 skill 清单（`skills.ts` + 官方 `loadSkills()`）。
   *
   * **可选**而不是必填：旧轨迹回放与测试的 init 段里没有这个字段，所以判据要用
   * `undefined`（没装）而不是空数组（装了但一个都没有）。
   */
  skills?: SkillInfo[];
  /**
   * skill 加载的诊断（重名、frontmatter 不合法…）。
   *
   * 为什么要留在状态里而不只是打到 stderr：TUI 模式下 stderr 用户看不见，而「某个
   * skill 没加载上」正是**静默退化** —— 模型少了能力，用户与界面都不知道原因。
   * pi 把这类信息印在开场（`[Skill conflicts]`），我们也照做。
   */
  skillDiagnostics?: string[];
  /** 是否已经装载过。回放时据此判断「init 段读到了没有」。 */
  seeded: boolean;
}

/** 模型侧状态 —— 由 `model.init` 装载。 */
export interface ModelState {
  provider: string;
  modelId: string;
  /** 当前思考级别；`off` 表示不带 reasoning。 */
  thinkingLevel: ModelThinkingLevel;
  /**
   * 这个模型支不支持 reasoning（思考）。底栏据此决定显不显示 `• <级别>`。
   *
   * 为什么不看 `thinkingLevel !== 'off'`：非 reasoning 模型的级别**永远是** `off`，
   * 而 reasoning 模型也可以被用户设成 `off`（那时 pi 显示 `• thinking off`）。
   * 两种情况在 `thinkingLevel` 上长得一样，必须另存一个标志才分得开。
   */
  reasoning: boolean;
  /** 这个模型支持什么（中途插 system / developer role / 中途加工具）。 */
  capabilities: ModelCapabilities;
  /**
   * 上下文窗口（token）。底箱用它算「已用 / 窗口」。
   *
   * 不知道就是 0（而不是猜一个值）：底箱会据此决定画不画那个百分比。
   */
  contextWindow: number;
  seeded: boolean;
}

/**
 * 会话身份：这一轮对话属于哪个会话、边界在哪。
 *
 * ## 为什么它必须在 `AgentState` 里
 *
 * 同一个进程里有**两个界面**（TUI 与 web），它们都要回答「现在是哪个会话」。
 * 早先这两样东西不在状态里：
 *
 *   - `sessionId` 住在内核闭包里（`current.sessionId`，那是**资源句柄**——
 *     轨迹 sink / 会话文件绑在哪个 id 上），界面只能通过一个 getter 去问内核；
 *   - `cwd` 是内核常量 + `WebBridge` **构造时**抄的一份，开着就不再变。
 *
 * 于是「共享同一个 store」在**会话身份**这里不成立：两端各自去问、或者各自抄一份，
 * 只要有一处忘了跟（或抄的时间不对），症状就是「浏览器点了新会话，另一边还是老 id」
 * —— 而那类不同步在界面上看不出原因。
 *
 * 放进状态后只剩一个真相：谁要 id / cwd 都读它（`state.session`）。内核里那对
 * `current` 仍然是资源句柄（它管文件），但**不再是对外的会话身份**。
 */
export interface SessionState {
  /** 会话 id（开新会话与恢复历史时会变）；会话文件名由它决定。 */
  id: string;
  /** 工具的工作目录（= 文件边界）。与内核的 `cwd` 同一份。 */
  cwd: string;
}

export interface AgentState {
  phase: Phase;

  /** 会话身份（id / cwd）—— 界面与桥都读它，不再各自去问内核。 */
  session: SessionState;

  // ── prompt 侧（与 model 分开，因为 system prompt 后面要挂 Hooks） ──
  prompt: PromptState;
  // ── model 侧 ──
  model: ModelState;

  /**
   * 下面四个是 prompt / model 里常用字段的**扁平别名**，为了不让既有代码（UI、adapter、
   * 轨迹渲染）到处写 `state.prompt.systemPrompt`。真相在两块里，别处只读不算独立来源。
   */
  systemPrompt: string;
  providerName: string;
  modelId: string;
  /** 思考级别（pi-ai 的 ModelThinkingLevel）；'off' 表示不带 reasoning。 */
  thinkingLevel: ModelThinkingLevel;
  /** 对话消息（user / assistant / toolResult），LLM 的下一轮输入。 */
  messages: Message[];
  /** 已注册工具名（展示用）。 */
  toolNames: readonly string[];
  /** 本轮流式累积的助手文本。 */
  streamingText: string;
  /** 本轮流式累积的思考文本。 */
  thinkingText: string;
  /**
   * 每开始一次 LLM 尝试就 +1。UI 靠它识别「又发起了一次调用」——
   * 这正是重试发生的那一刻，也是树上要开新 attempt 分支的那一刻。
   */
  streamSeq: number;
  /** 最近一批待执行的工具调用。 */
  pendingToolCalls: ToolCall[];
  executing: readonly ExecutingTool[];
  /** 已完成的 LLM 轮数。 */
  turns: number;
  maxTurns: number;
  // ─── turn / step 两层容器（轨迹树与统计的唯一真相） ───
  /**
   * 当前回合（turn）的序号，从 1 开始；不在回合里时为 0。
   *
   * ## turn 与 step 的边界
   *
   * - **turn** = 一次用户输入引发的**整个回合**：从那条消息进来，到模型没有工具调用、
   *   这一轮真正收工为止。中间可以有好几个 step。
   * - **step** = 一次 LLM 调用 **加上它触发的工具批次**。它在轨迹树上就是原先
   *   `llm.attempt` 的位置（那个容器已被 `step.start` 取代）。
   *
   * 于是树形是 `user → turn → step → llm.result / tool.*`，
   * 而重试的开叉发生在 **step 这一层**（同父下多个 step.start），不是 turn 层。
   *
   * 与 pi 的 `turn_start` / `turn_end` 对齐（`step` 是本项目细分出来的，
   * pi 把「LLM 调用 + 工具」整段当一个 turn）。
   */
  turnIndex: number;
  /** 当前回合在跑的 step 序号，从 1 开始；不在 step 里时为 0。 */
  stepIndex: number;
  /**
   * 已完成的 step 总数（整个会话，不随回合归零）。
   *
   * 顶箱的「轮数」显示念它 —— 而 `turns` 是「当前回合内的 LLM 调用数」，
   * 每次新回合归零。两者名字相近但含义不同，所以这里写清楚。
   */
  totalSteps: number;
  // ─── 排队中的用户输入（steer / followUp） ───
  /** steer 队列：在下一次 LLM 调用前插入。FIFO。 */
  steerQueue: readonly QueuedInput[];
  /** followUp 队列：回合收工时才插入，然后开新回合。FIFO。 */
  followUpQueue: readonly QueuedInput[];
  /**
   * 已经「决定要发」但还没真正组装成消息的队列头（FIFO 弹出后的在途状态）。
   *
   * 为什么需要它：投递 steer 的那一刻要把一条 user 消息插进 `messages`。
   * 如果直接 `shift()` 然后拼消息，中间要是有别的东西读了队列就会不一致。
   * 而**先记账、再插入**这两步之间必然有一个 dispatch 边界（插入要发一条
   * `queue.delivered`），所以「已经取出来但还没插」的中间态必须显式存下来 ——
   * 否则连按两次「取队列」会把同一条消息发两遍。
   */
  deliveringInput: QueuedInput | null;
  /** 这条在途消息要送到哪一列（决定它算 steer 还是 followUp 的落点）。 */
  deliveringAs: QueueKind | null;
  usage: Usage | null;
  totalCost: number;
  error: string | null;
  /**
   * 最近一次错误对应的轨迹节点 id。界面靠它把「这次失败」和树上的节点对上，
   * 于是错误不只是状态里的一句字符串，而是树上看得见、能展开的一节点。
   */
  errorNodeId: string | null;
  /** 最近一次错误的类别。 */
  /** 最近一次错误的类别。 */
  errorKind: LlmErrorKind | null;
  /**
   * 回合为什么停了。`null` = 还在跑（idle 但没有收工理由 = 空闲，等下一句话）。
   *
   * 界面靠它决定怎么显示：`completed` 不该弹红框，`maxTurns` / `error` / `aborted` 要弹。
   */
  stopReason: StopReason | null;
  /**
   * 停止的**具体原因**（`StopCause`）。`null` = 这一轮还没停。
   *
   * 与 `stopReason` 的分工：`stopReason` 给「粗粒度的结局」（要不要弹红框），
   * 这个给「到底为什么」—— 用户手动中断、超时、鉴权失败在 `stopReason` 里都是 `error`/`aborted`，
   * 只有这里能分开。界面照它分色（用户中断是灰的、超时是黄的），日志照它写。
   */
  stopCause: StopCause | null;
  /**
   * 停止原因的一句人话，界面直接显示（免得每个界面各写一份 switch）。
   *
   * 为什么存在：`error` 是技术文案（`401 Unauthorized`），用户看不懂也不想看；
   * 这一句是给他看的（「鉴权失败，API key 无效或无权限」）。
   */
  stopCauseDetail: string | null;
  /** 这次失败正在自动重试（UI 显示「重试中…」）。 */
  retrying: boolean;
  aborted: boolean;

  // ─── 轨迹树（trace tree） ───
  /** 像 git log 一样的一次尝试一节点的执行历史。 */
  trace: TraceTree;
  /**
   * 轨迹是否**开过**（用户发出过第一句话）。
   *
   * 为什么要有这个标记：装载（prompt / tools / skills / model）在内核一装配时就已经进 state，
   * 但它们的**轨迹节点**推迟到用户发出第一句话才补上（见 `user.message` 里的 beginTrace）。
   * 所以「装载了但树还是空的」是一个正常状态，而不是漏了东西 ——
   * 界面上的「（还没有任何节点）」说的正是这句。
   *
   * 顺带当幂等守卫：补过装载段之后再来第二句话，不会把装载节点追加第二遍。
   */
  traceBegun: boolean;
  /**
   * 树开过之后换过模型 / 思考级别（`model.init` / `thinking.changed`），但**还没写进树**。
   *
   * ## 为什么不换一次就追加一个节点
   *
   * 切换是界面上的动作，而树上该回答的是「这一轮实际用的上下文是什么」。来回切三次、
   * 或先换模型再改思考级别，就会在对话中间多堆三个夹在两句人话之间的 `model.init`，
   * 而它们什么也没解释（真正生效的只有最后一个）。
   *
   * 现在只置一个标记，等到下一次真要发消息时由 `flushModelChange()` 补**一个**节点，
   * 内容是那一刻生效的那一版，位置在 user 节点**之前** —— 与装载节点的口径一致
   * 见 `beginTrace()`：发过话才留痕，而且留的是当时真正生效的那一版。
   */
  modelTraceDirty: boolean;
  /** 当前在跑的 LLM 尝试节点 id；没有则 null。 */
  openLlmNodeId: string | null;
  /** 当前在跑的 step 容器节点 id（`step.start`）；没有则 null。 */
  openStepNodeId: string | null;
  /** 当前回合容器节点 id（`turn.start`）；没有则 null。 */
  openTurnNodeId: string | null;
  /**
   * `openTurnNodeId` 那个容器的**序号**（= 开它时的 turnIndex）。
   *
   * 为什么不能只靠 `openTurnNodeId !== null` 判断「容器开着」：followUp 到达时
   * reducer 会**直接开新容器**而不给旧回合发 `turn.end`（那条路在 Cmd.run 回来时
   * 没人冲刷），于是一段时间里「新容器开着、旧容器还没关」。
   *
   * 这个字段就是用来区分那两种情况的：`openTurnSeq < turnIndex` = 有个旧容器待收尾。
   */
  openTurnSeq: number | null;
  /** 当前回合里**已经结束**的 step 数（写 turn.end 的标签用）。 */
  turnSteps: number;
  /** 当前 step 里**已经完成**的工具数（写 step.end 的标签用）。 */
  stepToolCalls: number;
  /** 正在执行的工具 → 它的 attempt 节点 id。 */
  openToolNodeIds: Readonly<Record<string, string>>;
  /**
   * 正在跑的工具的**中间输出**，key 是 toolCallId。
   *
   * 用来让长命令（`npm install`、带 sleep 的脚本）边跑边显示，而不是
   * 「卡住几十秒然后突然蹦出一坨」—— 用户看到它在输出，就不会以为卡死了。
   *
   * 工具结束（`tool.result`）就把那一条**删掉**：终值已经在 `messages` 里了，
   * 留着会让界面把终值又画一遍。
   */
  toolProgress: Readonly<Record<string, ToolProgress>>;
  /**
   * 已完成工具的**耗时**（毫秒），key 是 toolCallId。
   *
   * ## 为什么单独存一份，而不是去轨迹树上刨
   *
   * 界面要显示 `Took 0.5s`（pi 的 bash 块底部那行）。轨迹树上其实也有时间戳
   * （`tool.call.createdAt` / `endedAt`），但那条路要「按 toolName 猜是哪个节点」——
   * 同名工具连着调两次就猜错了，而猜错的表现是**显示一个错的数字**，不报错，最难发现。
   *
   * reducer 的 `tool.result` 拿得到这次调用的 id 与时刻，直接记一份即可：
   * **唯一真相、零猜测**。它只进界面，不进 prompt（`details` 那条路才进 prompt），
   * 所以不会污染发给模型的上下文，也不会被写进会话文件。
   *
   * 会话文件里不带它：恢复历史时 `state` 是从消息重建的，这些耗时显示不出来就显示不出来
   * （显示 `Took` 一个假数字比不显示更糟）。
   */
  toolTimings: Readonly<Record<string, number>>;
  /** 本轮（从 user.message 起）已发起的 LLM 尝试次数；用来判「还有没有重试机会」。 */
  llmAttempts: number;
  // ─── 上下文压缩 ───
  /**
   * 压缩是否正在进行中（摘要要打一次网络，可能好几秒）。
   *
   * 界面用它：压缩期间不能发新消息（否则压缩完会把那句话一起换掉），
   * 也不能开新会话（否则文件已经换了一半）。
   */
  compacting: boolean;
  /**
   * 正在跑的压缩对应的轨迹节点 id；没有则 null。
   *
   * 为什么要单独记：压缩是「先开一个 pending 节点，几秒后回来闭合它」的两段式，
   * 而 `openLlmNodeId` 已经被 LLM 那一段占着（压缩期间不可能同时在跑 LLM，
   * 但两者属于不同的活动，用不同的字段才能在排障时看出「当时在干什么」）。
   */
  openCompactNodeId: string | null;
  /**
   * 压缩参数（`enabled` / `reserveTokens` / `keepRecentTokens`）。
   *
   * 来源：`~/.pi/agent/settings.json` 的 `compaction` 段（pi 的官方键名，所以两边同一份配置），
   * 没配就是 pi 的默认值（enabled=true, reserve=16384, keepRecent=20000）。
   *
   * **为什么要进 state**：effect 读它来算，而它得跟着 `model.init` 一起落盘 ——
   * 将来换模型换窗口时，「当时是用什么阈值压的」是排障的一部分。
   */
  compactionSettings: CompactionSettings;
  /**
   * 最近一次压缩的结果摘要（给界面显示「N 条 → M 条，压掉了多少」）。
   *
   * 之所以进 state 而不是让界面自己 diff messages.length：
   * 界面 diff 出来的「少了多少条」在**恢复历史之后**没有意义（那条历史本来就没被压缩过），
   * 而这里记的是真的发生过一次压缩。
   */
  lastCompaction: {
    reason: 'manual' | 'threshold' | 'overflow';
    summarizedCount: number;
    keptCount: number;
    tokensBefore: number;
  } | null;
  /** 允许的最大 LLM 尝试次数（含首次），2 = 失败后重试一次。 */
  maxLlmAttempts: number;
  /** 一次 LLM 调用的超时（毫秒）。effect 读它给流上闸。 */
  llmTimeoutMs: number;
  /** 已经落盘到 seq 游标的节点数；持久化失败时不动，好让下一轮重试。 */
  persistedSeq: number;
}

export interface InitialStateOptions {
  systemPrompt: string;
  providerName: string;
  modelId: string;
  toolNames: readonly string[];
  thinkingLevel?: ModelThinkingLevel | undefined;
  maxTurns?: number | undefined;
  /** 一次 LLM 调用的超时（毫秒）；超时按可重试错误处理。 */
  llmTimeoutMs?: number | undefined;
  /** 单轮内最多几次 LLM 尝试（含首次），2 = 失败后重试一次。 */
  maxLlmAttempts?: number | undefined;
  /** 注入会话 id（测试用；默认按时间生成）。 */
  sessionId?: string | undefined;
  /** 工具的工作目录（会话边界）；不给则用 `process.cwd()`。 */
  cwd?: string | undefined;
  /** 注入已存在的轨迹（从 JSONL 回放时用）。 */
  trace?: TraceTree | undefined;
}

export const DEFAULT_LLM_TIMEOUT_MS = 120_000;

export function createInitialState(options: InitialStateOptions): AgentState {
  // 会话 id 只生成**一次**：轨迹树的 id 与会话身份必须是同一个 —— 分两次
  // `newSessionId()` 会让两者错开（症状：会话文件一个名、轨迹文件另一个名）。
  const sessionId = options.sessionId ?? newSessionId();
  // 初始值就是「空的 prompt / model 块」—— 内核随后会 dispatch prompt.init 与 model.init
  // 把真值装进去。构造函数只负责给形状，不负责装载。
  const emptyPrompt: PromptState = {
    systemPrompt: options.systemPrompt,
    tools: [],
    seeded: false,
  };
  const emptyModel: ModelState = {
    provider: options.providerName,
    modelId: options.modelId,
    thinkingLevel: options.thinkingLevel ?? 'off',
    // 装载前不知道：保守地算不支持（底栏就不画 `• <级别>`）。model.init 会补上真值。
    reasoning: false,
    capabilities: {
      midConvoSystemMessages: false,
      midConvoToolAdditions: false,
      developerRole: false,
    },
    // 不知道就是 0：底箱会不画那个百分比，而不是画一个猜的值。
    contextWindow: 0,
    seeded: false,
  };
  return {
    phase: 'idle',
    // 会话身份一开始就有（新会话也属于一个会话）—— 它的取值只有这一个地方：
    // 开新会话 / 恢复历史走 `conversation.reset` / `conversation.restored`，
    // 两者都通过 `createInitialState({ sessionId })` 重建它。
    session: { id: sessionId, cwd: options.cwd ?? process.cwd() },
    prompt: emptyPrompt,
    model: emptyModel,
    systemPrompt: options.systemPrompt,
    providerName: options.providerName,
    modelId: options.modelId,
    thinkingLevel: emptyModel.thinkingLevel,
    messages: [],
    toolNames: options.toolNames,
    streamingText: '',
    thinkingText: '',
    streamSeq: 0,
    pendingToolCalls: [],
    executing: [],
    turns: 0,
    // 默认**不设上限**：一次提问就是一条 ReAct 循环，模型要查多少轮由它自己说了算。
    // 曾经默认 25，表现为「模型正干着活突然停了」—— 但用户只发了一条消息，
    // 是 25 次 LLM 调用把这个大需求砍断了。命令行的 --max-turns 仍可显式设一个兜底值。
    maxTurns: options.maxTurns ?? Number.POSITIVE_INFINITY,
    turnIndex: 0,
    stepIndex: 0,
    totalSteps: 0,
    openStepNodeId: null,
    openTurnNodeId: null,
    openTurnSeq: null,
    turnSteps: 0,
    stepToolCalls: 0,
    steerQueue: [],
    followUpQueue: [],
    deliveringInput: null,
    deliveringAs: null,
    usage: null,
    totalCost: 0,
    error: null,
    errorNodeId: null,
    errorKind: null,
    stopReason: null,
    stopCause: null,
    stopCauseDetail: null,
    retrying: false,
    aborted: false,
    trace: options.trace ?? createTraceTree(sessionId),
    traceBegun: false,
    modelTraceDirty: false,
    openLlmNodeId: null,
    openToolNodeIds: {},
    toolProgress: {},
    toolTimings: {},
    llmAttempts: 0,
    compacting: false,
    openCompactNodeId: null,
    compactionSettings: compactionSettings(),
    lastCompaction: null,
    maxLlmAttempts: options.maxLlmAttempts ?? 2,
    llmTimeoutMs: options.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    persistedSeq: 0,
  };
}

/** 这些错误重试有意义：网络抖动、超时。鉴权/参数错重试多少次都一样。 */
export function isRetryable(kind: LlmErrorKind): boolean {
  return kind === 'timeout' || kind === 'network';
}

/** 从错误信息猜类别（effect 只拿到一个 Error，分类放在这里统一做）。 */
export function classifyLlmError(error: string): LlmErrorKind {
  const text = error.toLowerCase();
  if (text.includes('abort')) return 'aborted';
  if (text.includes('timeout') || text.includes('timed out') || text.includes('超时')) {
    return 'timeout';
  }
  if (
    text.includes('network') ||
    text.includes('fetch failed') ||
    text.includes('econnreset') ||
    text.includes('socket hang up') ||
    text.includes('enotfound') ||
    text.includes('网络')
  ) {
    return 'network';
  }
  if (
    text.includes('unauthorized') ||
    text.includes('forbidden') ||
    text.includes('api key') ||
    text.includes('401') ||
    text.includes('403') ||
    text.includes('鉴权')
  ) {
    return 'auth';
  }
  if (text.includes('model') || text.includes('模型')) return 'model';
  return 'unknown';
}
