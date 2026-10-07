import type {
  AssistantMessage,
  ImageContent,
  ModelThinkingLevel,
  TextContent,
  ToolCall,
  ToolResultMessage,
} from '@earendil-works/pi-ai';
import type { Message } from '@earendil-works/pi-ai';
import type { LlmErrorKind, StopCause } from './state';
import type { SkillInfo } from './skills';

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
export type AgentAction =
  /**
   * ═══ prompt 侧 ═══
   *
   * 与 model 分开装载：prompt 是「跟模型说什么」，model 是「用哪个模型说」。两者独立变，
   * 而且将来会有洋葱式 middleware 挂上来（见 src/middleware.ts），它在 action 前后插手，
   * 对 prompt 和对模型一视同仁 —— 所以 prompt 这块只管装载，不管扩展。
   */
  /**
   * 人说了什么。`content` 是可选的：Web 侧带附件时，adapter 会把附件折成
   * text/image content 块一起带进来，消息仍是标准的 pi-ai user 消息。
   */
  /**
   * ═══ prompt 侧 ═══
   *
   * 这三条独立于 model：system prompt 后面要挂 Hooks（按事件追加片段、改写、注入），
   * 那属于 prompt 的事，不该和「用哪个模型」混在一起。model.init 只管模型与能力。
   */
  /**
   * 装载 prompt：基础 system prompt + 工具定义 + （将来）hook 产生的片段。
   *
   * `tools` 是**完整定义**（name/description/parameters），不只是名字 —— 这些要原样进
   * LLM 请求，所以落进 state 后回放不必重跑。
   */
  | {
      type: 'prompt.init';
      /** 基础 system prompt（内核装配时定的那段）。 */
      systemPrompt: string;
      /** 工具的完整定义。 */
      tools: PromptToolDefinition[];
      /**
       * 装进来的 skill 清单（`skills.ts` 加载，官方 `loadSkills()`）。
       *
       * 与 `systemPrompt` 一起定下来 —— 因为 `formatSkillsForPrompt()` 的输出是
       * system prompt 的一部分。单独存一份是为了界面能画清单、能判「这个 skill 这一轮
       * 到底在不在 prompt 里」（`/skill:x` 之前要查）。
       *
       * 没有就是没装（旧轨迹回放、测试）—— 判据是 `undefined`，不是空数组：
       * 空数组也可能意味着「装了但一个都没有」。
       */
      skills?: SkillInfo[] | undefined;
      /** 加载诊断（重名 / frontmatter 不合法…），TUI 开场要显示。 */
      skillDiagnostics?: string[] | undefined;
    }
  /**
   * 中途追加一段 prompt（`system` 或 `developer` role）。
   *
   * 落进 `state.messages` —— 即 Conversation 的一部分，所以它会被一起落盘、一起回放。
   * 模型支不支持中途插：`ModelCapabilities.midConvoSystemMessages`。不支持时 pi-ai 会把后来的
   * system 消息折进开头那条，我们不自己折。
   */
  | {
      type: 'prompt.segment.added';
      role: 'system' | 'developer';
      text: string;
      /** 来源标记（哪个 hook / 手动），UI 要显示「这段是哪来的」。 */
      source?: string | undefined;
    }


  /** ═══ model 侧 ═══ */
  /**
   * 装载模型：当前 provider / model / 思考级别，以及这个模型**支持什么**。
   *
   * 能力（capabilities）是模型的属性而不是运行时状态，所以随 model.init 一起落盘 ——
   * 回放时不需要重新去问 provider「这个模型能不能中途插 system」。
   */
  | {
      type: 'model.init';
      provider: string;
      modelId: string;
      thinkingLevel: ModelThinkingLevel;
      capabilities: ModelCapabilities;
      /**
       * 上下文窗口（token）。底箱要算「已用 / 窗口」的百分比。
       *
       * **可选**：省略就是 0，底箱会不画那个百分比。真实运行时内核一定会给
       * （它从模型对象读），但测试里造 action 不用关心这个。
       *
       * 为什么存在 action 里而不让界面去查模型：模型可能换，而这个值随 model.init
       * 落盘 —— 回放时不用重新去问 provider 它的窗口有多大。
       */
      contextWindow?: number;
    }
  | {
      /**
       * 人说了什么。`content` 是可选的：Web 侧带附件时，adapter 会把附件折成
       * text/image content 块一起带进来，消息仍是标准的 pi-ai user 消息。
       */
      type: 'user.message';
      text: string;
      content?: (TextContent | ImageContent)[] | undefined;
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
  /** 一个工具出结果。 */
  | { type: 'tool.result'; message: ToolResultMessage }
  /** 一批工具跑完了。 */
  | { type: 'tool.batch.done'; count: number }
  /** 换了模型。 */
  | { type: 'model.changed'; provider: string; modelId: string }
  /** 换了思考级别。 */
  | { type: 'thinking.changed'; level: ModelThinkingLevel }
  /**
   * 轨迹节点已落盘。持久化是 effect（写文件 / localStorage），它把游标推回来，
   * 于是 reducer 知道自己已经写过哪一段，重复的记录不会二次落盘。
   */
  | { type: 'trace.persisted'; upToSeq: number }
  /**
   * 恢复历史：把一条**已有会话里读回来的**消息塞进 messages。
   *
   * 它跟 `user.message` / `llm.done` 的区别是：消息不是「刚发生的」，是「上次发生的」。
   * 迁移时**不能**开新的 user 节点、也不能推进 tip —— 轨迹是那一轮的东西，这里只是把
   * 对话补齐。所以相位不动、树不动。
   *
   * 零 token：不重跑模型，纯粹是把 JSONL 里读到的内容灌回状态。
   */
  | { type: 'session.restored'; message: Message }
  /**
   * 恢复历史：**一次**把整批消息灌回去（清对话 + 换会话 id）。
   *
   * ## 为什么不能靠 N 条 `session.restored`
   *
   * 界面每个 dispatch 都会重渲染整段对话，而重渲染的成本与 messages 长度成正比 ——
   * 逐条灌 N 条就是 O(N²)。390 条消息实测 62 秒（`tmp-bench` 那份脚本就是这个数），
   * 用户看到的是「卡了一分钟」。合成一条 dispatch 只渲染一次，代价降到 O(N)。
   *
   * ## 与逐条版的差别
   *
   * 状态结果完全一样（messages 等于这批，`phase`/`trace` 不动）。另外因为它带着
   * `sessionId`，恢复时**顺带换了会话 id** —— 界面用它就不必再单独 dispatch 一次
   * `conversation.reset`，那次 dispatch 在这个组合里是多余的（第 0 次消息没有、
   * 但每次都白白重渲染一整屏）。
   */
  | { type: 'conversation.restored'; sessionId: string; messages: Message[] }
  /**
   * 清空对话。
   *
   * 带 `sessionId` 就是**开新会话**（新 id → 新文件）；不带则只清对话、沿用原 id
   * —— 后者会让之后的消息追加进同一个文件，所以界面上的「新会话」一定要带 id。
   */
  | { type: 'conversation.reset'; sessionId?: string | undefined };

export type AgentActionType = AgentAction['type'];
