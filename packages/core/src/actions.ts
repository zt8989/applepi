import type {
  AssistantMessage,
  ImageContent,
  ModelThinkingLevel,
  TextContent,
  ToolCall,
  ToolResultMessage,
  Usage,
} from '@earendil-works/pi-ai';
import type { Message } from '@earendil-works/pi-ai';
import type { LlmErrorKind, StopCause } from './state';
import type { QueueKind } from './state';
import type { TraceNodeStatus, TraceTree } from './trace';
import type { ExtensionLifecycleEvent } from './extension-events';
import type { SkillInfo } from './skills';
import type { PromptTemplateInfo } from './prompts';
import type { CompactReason } from './compact';

/**
 * 工具的完整定义 —— 落进 state 后回放不必重跑。
 *
 * 只留三样：真正进 LLM 请求的就是这三样。`label` 是我们自己界面用的展示名，
 * 不发给模型，所以不算在这里（state.tools 里另有一份带 label 的清单给 UI）。
 */
export interface PromptToolDefinition {
  name: string;
  description: string;
  /** typebox schema，原样透传给 provider。 */
  parameters: unknown;
}

/**
 * 模型能力（pi-ai 的 `Model` 上那几个 supports* 标志）。
 *
 * 只收三个**真正影响本项目行为**的：能不能中途插 system/developer、能不能中途加工具、
 * 支不支持 developer role。其余几十个标志对我们没意义，不搬。
 */
export interface ModelCapabilities {
  /** 对话开始后还能插 system/developer 消息。不支持时 pi-ai 折进开头那条。 */
  midConvoSystemMessages: boolean;
  /** system 消息能否中途引入新工具。需要 midConvoSystemMessages。 */
  midConvoToolAdditions: boolean;
  /** 用 `developer` 而不是 `system`（OpenAI Responses 一族）。 */
  developerRole: boolean;
}

/**
 * 一切皆 Action。
 *
 * Agent 不是一等公民：它只是 `agent.run` 这一个 Action，和 `tool.call`、
 * `user.message`、`llm.done` 完全平级。reducer 里没有任何 `if (kind === 'agent')`
 * 这类分支 —— 谁来执行 `agent.run`（自己调 pi-ai，还是别的什么东西）
 * 是**接线**的事，由 store 创建时注入的 effect 表决定。
 *
 * 环（用 action 名写出来就是全部）：
 *
 *   user.message → agent.run → llm.started → llm.delta* → llm.done
 *                                            ├─ 无工具 ─────────────────→ (idle)
 *                                            └─ 有工具 → tool.call → tool.start* →
 *                                               tool.result* → tool.batch.done → agent.run
 *
 * 失败与重试也写在环里：
 *
 *   llm.failed（可重试且还有次数）→ 相位仍 thinking → agent.run（同一 tip 下再开一个 attempt）
 *
 * 注意 `llm.done` 之后的 `tool.call` 也是一个 action：它由 reducer 的接线发出来，
 * 走的是同一条 dispatch 回流，而不是从 effect 里直接跳到工具执行。
 */

/**
 * 模型侧一整套参数 —— `model.init` 与 `model.changed` **共用同一形状**。
 *
 * 两条 action 的差别只剩**语义**（装载 vs 切换），不再有「一条只带标识、另一条才带
 * 能力」的分裂。于是：
 *
 *   - 谁被 dispatch 都能把 state 装成完整、可用的模型（不需要「保守清零 → 再补」的中间态）；
 *   - 测试与调用方只需要认识一种载荷；
 *   - 轨迹里记的是**那一刻真正生效的那一版**，不必猜它是从哪条 action 来的。
 */
export interface ModelSpec {
  provider: string;
  modelId: string;
  thinkingLevel: ModelThinkingLevel;
  /**
   * 模型支不支持 reasoning（思考）。底栏据此决定显不显示 `• <级别>`。
   *
   * **可选**：省略就是 `false`（不显示）。真实运行时内核一定会给
   * （它从模型对象读 `reasoning`），测试里造 action 不用关心这个。
   */
  reasoning?: boolean | undefined;
  /** 这个模型支持什么（中途插 system / developer role / 中途加工具）。 */
  capabilities: ModelCapabilities;
  /**
   * 上下文窗口（token）。底箱要算「已用 / 窗口」的百分比。
   *
   * **可选**：省略就是 0，底箱会不画那个百分比。真实运行时内核一定会给
   * （它从模型对象读），但测试里造 action 不用关心这个。
   *
   * 为什么存在 action 里而不让界面去查模型：模型可能换，而这个值随模型落盘 ——
   * 回放时不用重新去问 provider 它的窗口有多大。
   */
  contextWindow?: number | undefined;
}

export type AgentAction =
  /**
   * prompt 侧：人说了什么 + 装载 prompt。
   *
   * prompt 与 model 分开装载（「跟模型说什么」vs「用哪个模型说」），两者独立变；将来挂上来的
   * 洋葱式 middleware（见 `middleware.ts`）对二者一视同仁，所以这块只管装载，不管扩展。
   *
   * `user.message` 的 `content` 可选：Web 侧带附件时 adapter 把附件折成 text/image content
   * 块一起带进来，消息仍是标准的 pi-ai user 消息。
   *
   * `prompt.init` 装基础 system prompt + 完整工具定义 + skill 清单。`tools` 是**完整定义**
   * （不只是名字）—— 它们要原样进 LLM 请求，落进 state 后回放不必重跑。
   */
  | {
      type: 'prompt.init';
      /** 基础 system prompt（内核装配时定的那段）。 */
      systemPrompt: string;
      /**
       * system prompt 的**分段**（`system-prompt.ts` 的 `buildPromptParts`）。
       *
       * `systemPrompt` 是它的渲染结果。两份一起装：回放 / 恢复时拿得到分段，
       * 中途的 prompt 变更才能按段 patch（前缀缓存的前提，见 `prompt-head.ts`）。
       *
       * **可选**：旧轨迹的 init 段里没有它（那时只有一整段可用）。
       */
      sections?: Record<string, string> | undefined;
      /** 工具的完整定义。 */
      tools: PromptToolDefinition[];
      /**
       * 装进来的 skill 清单，与 `systemPrompt` 一起定下来（skill 清单是它的一部分）。
       * 单独存一份是为了界面能画清单、能判「这个 skill 这一轮到底在不在 prompt 里」。
       *
       * 判据是 `undefined` 而不是空数组：空数组也可能意味着「装了但一个都没有」。
       */
      skills?: SkillInfo[] | undefined;
      /** 加载诊断（重名 / frontmatter 不合法…），TUI 开场要显示。 */
      skillDiagnostics?: string[] | undefined;
      /**
       * 装进来的 prompt 模板（`prompts.ts` 加载）。
       *
       * 它们**不拼进** system prompt，但仍是装载结果：开场横幅要报 `[Prompts]`、
       * 补全要列命令、回车要认「这条是不是模板」。
       *
       * 没有就是没装（旧轨迹回放、测试）—— 判据是 `undefined`，不是空数组。
       */
      promptTemplates?: PromptTemplateInfo[] | undefined;
      /** prompt 模板加载诊断（重名 / frontmatter 不合法…），TUI 开场要显示。 */
      promptDiagnostics?: string[] | undefined;
    }
  /**
   * 中途追加一段 prompt（`system` 或 `developer` role）。落进 `state.messages`，所以会被一起
   * 落盘、一起回放。模型支不支持中途插由 `ModelCapabilities.midConvoSystemMessages` 决定，
   * 不支持时 pi-ai 会把后来的 system 消息折进开头那条，我们不自己折。
   *
   * `sections` 按**段名** patch（而不是再接一整段文本）：只需带上**变了的段**，`null` 表示
   * 删掉那一段 —— 这样已有消息一个字节不动，前缀缓存能活下来（见 `prompt-head.ts`）。
   * 带 `sections` 时 `text` 通常为空。
   */
  | {
      type: 'prompt.segment.added';
      role: 'system' | 'developer';
      text: string;
      sections?: Record<string, string | null> | undefined;
      /** 来源标记（哪个 hook / 手动），UI 要显示「这段是哪来的」。 */
      source?: string | undefined;
    }


  /**
   * 工具集变了（`pi.setActiveTools()` → 本项目的 `state.prompt.tools`）。
   *
   * **只改「当前声明」，不动 head**：变更怎么告诉模型是下一步的事（`agent.run` 在请求前
   * diff 出 `toolsAdded` / `toolsRemoved` 追加一条 system 消息）。两件事分开的理由见
   * `prompt-head.ts`：head 一动，前缀缓存全废。
   */
  | {
      type: 'tools.changed';
      /** **当前**工具的完整定义（`declaredToolset()` 算好的那份）。 */
      tools: PromptToolDefinition[];
    }

/** ═══ model 侧 ═══ */
  /**
   * 装载模型：当前 provider / model / 思考级别，以及这个模型**支持什么**。
   *
   * `model.init` 与 `model.changed` 的载荷**完全一致**（`ModelSpec`），只差语义：
   * 这条是「装载」，换模型走 `model.changed`。能力（capabilities）是模型的属性而不是
   * 运行时状态，所以随它一起落盘 —— 回放时不需要重新去问 provider「这个模型能不能中途插 system」。
   */
  | ({ type: 'model.init' } & ModelSpec)
  | {
      /**
       * 人说了什么。`content` 是可选的：Web 侧带附件时，adapter 会把附件折成
       * text/image content 块一起带进来，消息仍是标准的 pi-ai user 消息。
       */
      type: 'user.message';
      text: string;
      content?: (TextContent | ImageContent)[] | undefined;
    }
  /**
   * steer / followUp：环在跑的时候人还能说话。两种队列只差**投递时机**（与 pi 的
   * `steer()` / `followUp()` 一致）：
   *
   * - `as: 'steer'`：当前 step 的工具跑完后、下一次 LLM 调用前插入，会打断「模型→工具→模型」
   *   的延续，让模型看见新的话；
   * - `as: 'followUp'`：等模型没有工具调用了才插，然后开一个新回合。不打断任何东西。
   *
   * 两条队列各自 FIFO、互不排队。**不能**用 `user.message` 表达：那条的语义是「开始一个新
   * 回合」（开 user 节点、清 `turns`、把相位从 idle 拉到 thinking），而 steer 发生时相位正在
   * thinking / calling-tools，走那条路会把正在跑的回合重置掉。
   */
  | {
      type: 'queue.input';
      text: string;
      content?: (TextContent | ImageContent)[] | undefined;
      as: QueueKind;
    }
  /**
   * 一条排队的输入**已被取出并组装成 user 消息**：reducer 据此把消息插进 `messages`，
   * 并开一个 user 轨迹节点。
   *
   * 投递本身也是 action：「什么时候该投递」是**状态决定的**（steer 在 step 收尾、followUp
   * 在回合收工），而只有 reducer 知道状态。于是投递成了环上的一环，而不是 effect 里的隐藏
   * 副作用。
   */
  | {
      type: 'queue.delivered';
      text: string;
      content?: (TextContent | ImageContent)[] | undefined;
      as: QueueKind;
    }
  /**
   * 清空两条队列（不再投递）。pi 的 `Alt+Up` = `app.message.dequeue`。
   *
   * 「把这些消息还回编辑器」意味着「我先不发了」：还回文本是界面的事，但**队列必须一并清掉**
   * —— 否则下一次投递点它们照样插进对话，编辑器里一份、对话里又一份。
   */
  | { type: 'queue.clear' }
  /**
   * turn / step 两层容器：`turn.start` / `turn.end` 是一次用户输入引发的整个回合，
   * `step.start` / `step.end` 是一次 LLM 调用加上它触发的工具批次。
   *
   *   user.message → turn.start → step.start → llm.result → tool.*
   *                                        → step.end
   *                  → turn.end
   *
   * 容器（turn/step）都不推进 tip、一次失败也不推进 tip，所以**重试开的新 step 仍然挂回
   * 同一个 turn 节点**，在 turn 下面长出分叉。
   */
  | { type: 'turn.start' }
  /**
   * 关回合容器。
   *
   * **不带 reason / reasonText / steps** —— 它们都能从 state 推出来（见迁移里那段）。
   * 写在 action 上就是多一份真相：接线得先算出同样的值，而两处一旦漂移，
   * 症状是「节点上写着「模型说完了」，而状态里是超时」—— 不报错，只误导人排障。
   */
  | { type: 'turn.end' }
  /**
   * 续跑当前回合（`/continue`）：**不插 user 消息**，在当前 tip 下直接开一个新回合。
   *
   * 超时 / 网络错误 / 轮数上限把回合停下之后，想接着干只能再发一句「继续」——
   * 那句话会作为真实历史进 `messages`、进会话文件、进下一次请求。这条 action 让
   * 「从停下的地方再跑一次」不必污染对话：起步与 `user.message` 完全一样，只少那条消息。
   */
  | { type: 'turn.continue' }
  /**
   * 开一步的容器。
   *
   * **不带 stepIndex / attempt** —— 那两个数 reducer 自己能从 state 算出来
   * （`stepIndex + 1` / `llmAttempts + 1`）。写在这里等于多一份真相：
   * 接线得先算出同样的数再传进来，两处一旦漂移，节点标签与状态就对不上，
   * 而症状是「界面上第 3 步，树里写第 2 步」—— 不报错，只误导。
   */
  | { type: 'step.start' }
  | {
      type: 'step.end';
      stepIndex: number;
      /** 这一次 step 的结局：`ok` / `error` / `aborted`。 */
      status: TraceNodeStatus;
      /** 这一 step 里完成了几个工具调用（0 = 纯 LLM 回答）。 */
      toolCalls: number;
    }
  /** 跑一轮对话（= 调一次 LLM）。谁执行由 effect 表决定。 */
  | { type: 'agent.run'; text?: string | undefined }
  /** LLM 文本增量（流式渲染）。 */
  | { type: 'llm.delta'; delta: string }
  /** LLM 思考增量。 */
  | { type: 'llm.thinking'; delta: string }
  /** 一次 LLM 调用开始（流还没吐字，UI 用它起「正在生成」动画）。 */
  | { type: 'llm.started' }
  /**
   * 一次 LLM 调用完成。`nodeId` 是这次尝试对应的轨迹节点（`llm.attempt`），
   * reducer 靠它把 `llm.result` 挂到正确的父节点下。
   */
  | { type: 'llm.done'; message: AssistantMessage; nodeId?: string | undefined }
  /**
   * LLM 调用失败（超时、网络、鉴权、模型错误）。`kind` 决定要不要重试；
   * `nodeId` 是这次尝试的轨迹节点，error 节点挂在它下面。
   */
  | {
      type: 'llm.failed';
      error: string;
      kind?: LlmErrorKind | undefined;
      nodeId?: string | undefined;
      /**
       * 停下来的**具体原因**（见 state.ts 的 `StopCause`）。界面上「用户手动中断」与
       * 「大模型超时」必须分开显示，而 `kind` 把二者都压成了「失败」这一类 ——
       * 用户按停止根本不是失败，弹红框会让人以为程序坏了。所以这里单独带一句人类能读的原因。
       */
      cause?: StopCause | undefined;
    }
  /** 重试用尽或不该重试：彻底收工，相位回 idle，并在树上留一个 stop/error 节点。 */
  | {
      type: 'llm.giveup';
      error: string;
      kind: LlmErrorKind;
      nodeId?: string | undefined;
      /** 同 `llm.failed.cause`：这一轮最终为什么收工。 */
      cause?: StopCause | undefined;
    }
  /** 这些工具调用需要执行。 */
  | { type: 'tool.call'; calls: ToolCall[] }
  /** 一个工具开始执行。 */
  | { type: 'tool/start'; call: ToolCall }
  /**
   * 工具执行中的**流式增量**（长命令边跑边送）。
   *
   * `content` 是「到目前为止的**全部**输出」，不是 diff —— 界面直接整个替换。终值由
   * `tool.result` 写进 `messages`，这条只是给界面看的中间态。
   *
   * 单独一条 action：输出是 effect 驱动的工具执行里的事情，要回流到 reducer 只能这样
   * （与 `llm.delta` 同一个形状）。
   */
  | {
      type: 'tool.progress';
      toolCallId: string;
      content: (TextContent | ImageContent)[];
    }
  /** 一个工具出结果。 */
  | { type: 'tool.result'; message: ToolResultMessage }
  /** 一批工具跑完了。 */
  | { type: 'tool.batch.done'; count: number }
  /**
   * 换了模型。与 `model.init` **同一套参数**（`ModelSpec`）。
   *
   * 为什么与 `model.init` 分开而不是复用一条：语义不同 —— 这条是「**切**成了什么」
   * （轨迹里应当看得见），而 `model.init` 是「**装载**了什么」（开局那一次）。两者载荷
   * 相同，所以「整个模型状态」只有一种写法；分开的只是轨迹上该不该留痕、留哪种痕。
   */
  | ({ type: 'model.changed' } & ModelSpec)
  /** 换了思考级别。 */
  | { type: 'thinking.changed'; level: ModelThinkingLevel }
  /**
   * 一个 **pi agent 生命周期事件**（内核自己发的那些）。
   *
   * 它必须是 action：「状态只能由 action 改」，而轨迹树是 action 的产物 —— 只有走了 store 的
   * 事才会被记进树上、被落盘、被回放。「扩展/宿主收到了什么」本身就是该留下证据的历史。
   *
   * 落点是 kind 为 `extension.event` 的轨迹节点（**不推进 tip**）。但已经有专属节点的事件
   * 不再另开节点：`message_end` → `llm.result`，`tool_execution_*` → `tool.call` /
   * `tool.result`，`model_select` → `model.changed`。所以真正落 `extension.event` 的只有
   * 相位级三条（`agent_start` / `agent_end` / `agent_settled`）。
   *
   * 发出与记录在同一处（kernel 的 `recordLifecycle()`）：先 dispatch（进轨迹），再
   * `emitLifecycle()`（发给扩展）—— 分开做两遍必然会漂。
   */
  | { type: 'extension.lifecycle'; event: ExtensionLifecycleEvent }
  /**
   * 开始一次压缩。**不携带结果** —— 真正干活的是 effect（要花钱、要打网络），结果从
   * `compact.done` / `compact.failed` 回来。
   *
   * 不把压缩写成 `user.message` 之后的自动副作用，是为了**看得见**：自动压的话用户永远不知道
   * 对话刚被改写过，而「模型忘了什么」正是最难查的一类问题。
   */
  | {
      type: 'compact.request';
      /**
       * 为什么发起。
       *
       * **必填**：它必须在 dispatch 那一刻就定下来，因为 effect 的
       * `failActionCreator` 拿不到 action。自动压由内核判定时填
       * `threshold` / `overflow`，用户按 `/compact` 填 `manual`。
       */
      reason: CompactReason;
    }
  /**
   * 压完了。老对话已被换成一条摘要消息。
   *
   * `messages` 是**整份新历史**（摘要 + 保留的尾巴）而不是「增量」——
   * 因为压缩的本质就是「替换中间一大段」，增量表达不了。
   */
  | {
      type: 'compact.done';
      messages: Message[];
      /** 摘要正文（界面上可展开看）。 */
      summary: string;
      /** 压缩前的上下文 token 数（界面显示「从多少压到多少」）。 */
      tokensBefore: number;
      /** 压缩前估的 token 数（= tokensBefore，单独一份是为了与 pi 的结果形状一致）。 */
      estimatedTokensAfter?: number | undefined;
      /** 摘要这一次花掉的 token。 */
      usage?: Usage | undefined;
      /** 被摘掉 / 保留的消息条数（界面提示用）。 */
      summarizedCount: number;
      keptCount: number;
      /** 为什么压：用户手动 / 超阈值 / provider 报溢出。 */
      reason: CompactReason;
    }
  /**
   * 压失败。**对话原样保留**（压缩是优化，不是正确性要求）。
   */
  | { type: 'compact.failed'; error: string; reason: CompactReason }

  /**
   * 恢复历史：把一条**已有会话里读回来的**消息塞进 messages。
   *
   * 消息不是「刚发生的」而是「上次发生的」：迁移时**不**开新的 user 节点、也不推进 tip，
   * 相位不动、树不动 —— 只是把对话补齐。零 token：不重跑模型。
   */
  | { type: 'session.restored'; message: Message }
  /**
   * 恢复历史：**一次**把整批消息灌回去（清对话 + 换会话 id）。
   *
   * 不能靠 N 条 `session.restored`：界面每个 dispatch 都重渲染整段对话，成本与 messages
   * 长度成正比 —— 逐条灌 N 条就是 O(N²)（390 条实测 62 秒）。合成一条只渲染一次。
   *
   * 带着 `sessionId` 顺带换了会话 id，所以界面不必再单独 dispatch `conversation.reset`。
   */
  | { type: 'conversation.restored'; sessionId: string; messages: Message[] }
  /**
   * 恢复历史：**连轨迹树一起**灌回去。
   *
   * 只带 `messages` 不够：迁移时会造一份**全新的空树**，于是对话区有内容但轨迹面板是**空的**
   * —— 症状特别有欺骗性（消息都在，只有轨迹没了，很容易归因为「恢复不完整」，而真因是那条树
   * 压根没被读回来）。
   *
   * 单独一条而不是给 `conversation.restored` 加可选字段：「有没有轨迹文件」是**运行期事实**，
   * 可选字段会让内核与迁移各判一次，一旦不一致就是「有时恢复有轨迹有时没有」。
   */
  | {
      type: 'trace.restored';
      sessionId: string;
      messages: Message[];
      /** 从 `traces/<sessionId>.jsonl` 回放出来的那棵树。 */
      trace: TraceTree;
    }
  /**
   * 清空对话。
   *
   * 带 `sessionId` 就是**开新会话**（新 id → 新文件）；不带则只清对话、沿用原 id
   * —— 后者会让之后的消息追加进同一个文件，所以界面上的「新会话」一定要带 id。
   */
  | { type: 'conversation.reset'; sessionId?: string | undefined };

export type AgentActionType = AgentAction['type'];
