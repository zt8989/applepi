import { Cmd, loop, type CmdType, type LoopReducer } from 'redux-loop';
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import type { AgentAction, AgentActionType, ModelCapabilities } from './actions';
import { createInitialState, isRetryable, type AgentState, type LlmErrorKind } from './state';
import { appendNode, patchNode, type TraceNode } from './trace';
/**
 * 一张纯表：action → (下一个状态, 该发哪些 effect)。
 *
 * 没有 if (kind === 'agent')，没有 driver/mode：reducer 只做两件事，
 * 算状态、查「这个 action 类型的 effect 是谁」。`agent.run` 与 `tool.call` 在这里
 * 完全平级 —— 它们各自有一行，各自的效果来自注入的 effect 表。
 *
 * 环写出来就是这个表自己接上的：
 *   user.message    → [agent.run]
 *   agent.run       → [llm.done]（effect 回流）
 *   llm.done        → 无工具：[ ]（结束）／有工具：[tool.call]
 *   tool.call       → [tool.batch.done]（effect 回流）
 *   tool.batch.done → [agent.run]   ← 环在这里闭合
 */
export type ReducerEffects = {
  [K in AgentActionType]: (
    action: Extract<AgentAction, { type: K }>,
    state: AgentState,
  ) => CmdType[];
};

/**
 * 状态迁移表（纯函数，无副作用）。用映射类型让每个 handler 的 action
 * 自动收窄到自己那一个 variant（否则联合类型上取不到 .delta/.message 之类）。
 */
type TransitionHandlers = {
  [K in AgentActionType]: (
    state: AgentState,
    action: Extract<AgentAction, { type: K }>,
  ) => AgentState;
};
/**
 * 轨迹小工具：全部是纯函数，只是为了让下面的 transitions 表读起来像业务而不是像 XML。
 */

/** 开一个新的 LLM 尝试节点。parent 取**调用发起那一刻**的 tip。 */
function openLlmAttempt(state: AgentState, now: number): { state: AgentState; node: TraceNode } {
  const attempt = state.llmAttempts + 1;
  // 「重试」= 本轮不是第一次尝试（第一次失败后接线又发了 agent.run）。
  const retry = attempt > 1;
  const { tree, node } = appendNode(state.trace, state.trace.tipId, 'llm.attempt', {
    status: 'pending',
    label: retry ? `第 ${attempt} 次尝试（重试）` : `第 ${attempt} 次尝试`,
    meta: { provider: state.providerName, model: state.modelId },
    createdAt: now,
  });
  return {
    state: {
      ...state,
      trace: tree,
      openLlmNodeId: node.id,
      llmAttempts: attempt,
      retrying: retry,
    },
    node,
  };
}

/** 成功：在 attempt 下挂 result 节点（它才是推进 tip 的那个）。 */
function closeLlmSuccess(state: AgentState, now: number, detail: string): AgentState {
  const openId = state.openLlmNodeId;
  let { trace } = state;
  if (openId) trace = patchNode(trace, openId, { status: 'ok', endedAt: now });
  const { tree, node } = appendNode(
    trace,
    openId,
    'llm.result',
    { status: 'ok', label: summarize(detail), detail, createdAt: now, endedAt: now },
  );
  return { ...state, trace: tree, openLlmNodeId: null, retrying: false };
}

/**
 * 失败：在 attempt 下挂一个 error 节点。
 *
 * 注意 error 节点**不推进 tip**（见 trace.ts 的 TIP_ADVANCING_KINDS）—— 所以下一次重试开的新 attempt，
 * parent 拿到的仍然是超时前那个节点，于是树长成 git 那样的分叉，而不是「错误的子节点才是正史」。
 */
function closeLlmFailure(
  state: AgentState,
  now: number,
  error: string,
  kind: LlmErrorKind,
  nodeId: string | null,
): AgentState {
  // effect 若带了自己的 nodeId（它知道自己开的是哪个 attempt），以它为准。
  const openId = nodeId ?? state.openLlmNodeId;
  let { trace } = state;
  const status = kind === 'aborted' ? 'aborted' : 'error';
  if (openId) trace = patchNode(trace, openId, { status, endedAt: now });
  const { tree, node } = appendNode(trace, openId, 'error', {
    status,
    label: error,
    detail: error,
    meta: { kind },
    createdAt: now,
    endedAt: now,
  });
  return { ...state, trace: tree, openLlmNodeId: null, errorNodeId: node.id, errorKind: kind };
}

/** 取一段文本的头一行做 label。 */
function summarize(text: string): string {
  const first = text.trim().split('\n')[0] ?? '';
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

/**
 * 「还不知道这个模型支持什么」时的保守值：全 false。
 *
 * 用在两处：`createInitialState` 的空 model 块，以及 `model.changed` 之后等 `model.init` 补上之前。
 * 取保守值是因为「以为支持但实际不支持」会让 pi-ai 把消息发出去然后被 provider 拒；
 * 反过来「以为不支持但实际支持」只是少用了个特性。
 */
const UNKNOWN_CAPABILITIES: ModelCapabilities = {
  midConvoSystemMessages: false,
  midConvoToolAdditions: false,
  developerRole: false,
};

const transitions: TransitionHandlers = {
  // ── prompt 侧装载 ──

  /**
   * 装载 prompt：基础 system prompt + 工具的**完整定义**。
   *
   * tools 落进 state 之后，`effects.ts` 就不用每次 `getTools()` 现算了 —— 既少一次 IO，
   * 也让回放时不必重新装配工具就能知道当时发给模型的是什么。
   */
  'prompt.init': (state, action) => ({
    ...state,
    prompt: {
      systemPrompt: action.systemPrompt,
      tools: action.tools,
      seeded: true,
    },
    // 扁平别名跟着更新（真相在 prompt 块里）。
    systemPrompt: action.systemPrompt,
    toolNames: action.tools.map((tool) => tool.name),
  }),

  /**
   * 中途追加一段 prompt。落进 `messages` —— 它是 Conversation 的一部分，所以会被一起
   * 落盘、一起回放。
   *
   * 模型支不支持中途插是**模型**的事（`state.model.capabilities`），我们不自己折：
   * 不支持时 pi-ai 会把后来的 system 消息折进开头那条。
   */
  'prompt.segment.added': (state, action) => {
    const message: Message = {
      role: action.role,
      content: action.text,
      timestamp: Date.now(),
      ...(action.source !== undefined ? { source: action.source } : {}),
    } as Message;
    return { ...state, messages: [...state.messages, message] };
  },

  // ── model 侧装载 ──

  /**
   * 装载模型：provider / model / 思考级别 + 这个模型支持什么。
   *
   * 能力随 init 一起落盘：回放时不必再问 provider「这个模型能不能中途插 system」。
   */
  'model.init': (state, action) => ({
    ...state,
    model: {
      provider: action.provider,
      modelId: action.modelId,
      thinkingLevel: action.thinkingLevel,
      capabilities: action.capabilities,
      seeded: true,
    },
    // 扁平别名跟着更新。
    providerName: action.provider,
    modelId: action.modelId,
    thinkingLevel: action.thinkingLevel,
  }),

  'user.message': (state, action) => {
    if (state.phase !== 'idle') return state;
    // 有附件时 content 是一组 text/image 块（adapter 折好的）；否则就是纯文本。
    const message: Message = {
      role: 'user',
      content: action.content ?? action.text,
      timestamp: Date.now(),
    };
    // 用户节点是一棵新树的根，并且推进 tip —— 后面所有的 LLM 尝试都挂在它下面。
    const { tree, node } = appendNode(state.trace, state.trace.tipId, 'user', {
      status: 'ok',
      label: summarize(action.text),
      detail: action.text,
      createdAt: Date.now(),
      endedAt: Date.now(),
    });
    return {
      ...state,
      trace: tree,
      phase: 'thinking',
      error: null,
      errorNodeId: null,
      errorKind: null,
      retrying: false,
      aborted: false,
      llmAttempts: 0,
      streamingText: '',
      thinkingText: '',
      pendingToolCalls: [],
      executing: [],
      messages: [...state.messages, message],
      openLlmNodeId: null,
    };
  },

  /**
   * 开一个新的 LLM 尝试。**这里是分叉发生的地方**：parent 取此刻的 tip。
   * 第一次失败后 tip 原地未动，所以重试开的新 attempt 挂回同一个父节点 —— 父 id 指向超时前的节点。
   *
   * `openLlmNodeId !== null` 的守卫是为了防重入：上一次 attempt 还开着时不要又开一个。
   */
  'agent.run': (state) => {
    if (state.phase === 'thinking' && state.openLlmNodeId !== null) return state;
    const opened = openLlmAttempt(state, Date.now());
    return {
      ...opened.state,
      phase: 'thinking',
      error: null,
      errorNodeId: null,
      errorKind: null,
      aborted: false,
      streamingText: '',
      thinkingText: '',
      pendingToolCalls: [],
      executing: [],
    };
  },

  'llm.delta': (state, action) =>
    state.phase === 'thinking'
      ? { ...state, streamingText: state.streamingText + action.delta }
      : state,

  'llm.thinking': (state, action) =>
    state.phase === 'thinking'
      ? { ...state, thinkingText: state.thinkingText + action.delta }
      : state,

  /**
   * 一次 LLM 调用开始。不改消息流，只把「本轮重新开始流式累积」这件事记进状态，
   * 让 UI 能在还没收到第一个 delta 之前就显示生成中。
   */
  'llm.started': (state) => {
    if (state.phase !== 'thinking') return state;
    return { ...state, streamSeq: state.streamSeq + 1, streamingText: '', thinkingText: '' };
  },

  'llm.done': (state, action) => {
    if (state.phase === 'idle') return state;
    const message: AssistantMessage = action.message;
    const toolCalls = message.content.filter((c): c is ToolCall => c.type === 'toolCall');
    const text = message.content
      .map((c) => (c.type === 'text' ? c.text : c.type === 'toolCall' ? `[调用 ${c.name}]` : ''))
      .join(' ')
      .trim();
    // 成功：在这次 attempt 下面挂 llm.result，由它推进 tip。
    const closed = closeLlmSuccess(state, Date.now(), text);
    return {
      ...closed,
      messages: [...closed.messages, message],
      streamingText: '',
      thinkingText: '',
      turns: closed.turns + 1,
      usage: message.usage ?? closed.usage,
      totalCost: closed.totalCost + (message.usage?.cost?.total ?? 0),
      pendingToolCalls: toolCalls,
      error: message.errorMessage ?? closed.error,
      phase: toolCalls.length > 0 ? 'calling-tools' : 'idle',
    };
  },

  /**
   * 失败。**错误在这里也变成树上的一节点**，而且它不推进 tip。
   *
   * 可重试且还有次数时，相位**保持 thinking**：接线看到 thinking 就再发一条 agent.run，
   * 而 agent.run 开的新 attempt 挂回同一个父节点 —— 于是「重试」在树上就是一次分叉。
   * 这就是需求里「尝试调用的父 id 指向超时前的节点」的实现。
   */
  'llm.failed': (state, action) => {
    const kind: LlmErrorKind = action.kind ?? 'unknown';
    const closed = closeLlmFailure(state, Date.now(), action.error, kind, action.nodeId ?? null);
    // 只有一个确实在跑的 LLM 尝试才谈得上「重试」；工具批次的失败走这里时 openLlmNodeId 已是 null。
    const wasLlmAttempt = state.openLlmNodeId !== null;
    const canRetry =
      wasLlmAttempt && isRetryable(kind) && closed.llmAttempts < closed.maxLlmAttempts;
    return {
      ...closed,
      phase: canRetry ? 'thinking' : 'idle',
      error: action.error,
      errorKind: kind,
      errorNodeId: closed.errorNodeId,
      retrying: canRetry,
      streamingText: '',
      thinkingText: '',
      executing: [],
      aborted: kind === 'aborted',
    };
  },

  /** 重试用尽：留一个 stop 节点（它是闭合的，所以推进 tip），相位回 idle。 */
  'llm.giveup': (state, action) => {
    const { tree } = appendNode(state.trace, state.trace.tipId, 'stop', {
      status: 'ok',
      label: action.error,
      detail: action.error,
      meta: { kind: action.kind },
      createdAt: Date.now(),
      endedAt: Date.now(),
    });
    return {
      ...state,
      trace: tree,
      phase: 'idle',
      error: action.error,
      errorKind: action.kind,
      retrying: false,
      streamingText: '',
      thinkingText: '',
      executing: [],
    };
  },

  /** 持久化游标：effect 写完文件后推回来，避免同一段重复落盘。 */
  'trace.persisted': (state, action) => ({
    ...state,
    persistedSeq: Math.max(state.persistedSeq, action.upToSeq),
  }),

  /**
   * 工具调用。llm.done 的迁移已经把相位推到 calling-tools 了，所以这里**不能**再要求 idle ——
   * 那个守卫是给「llm.done 直接调 runTools」的老接线写的；现在 tool.call 是被重新 dispatch 进来的，
   * 到达时相位已经是 calling-tools，用 idle 判定会把它整条丢掉（环停在 calling-tools）。
   */
  'tool.call': (state, action) => {
    if (state.phase === 'idle') return state; // 空闲时来的 tool.call 是过期消息，忽略
    return { ...state, phase: 'calling-tools', pendingToolCalls: action.calls };
  },

  /**
   * 工具开始：开一个 tool.attempt 节点，parent 是发起这一刻的 tip（即那条 llm.result）。
   */
  'tool/start': (state, action) => {
    const now = Date.now();
    const argsText = JSON.stringify(action.call.arguments ?? {});
    const { tree, node } = appendNode(state.trace, state.trace.tipId, 'tool.attempt', {
      status: 'pending',
      label: `${action.call.name} ${argsText}`,
      detail: argsText,
      meta: { tool: action.call.name },
      createdAt: now,
    });
    return {
      ...state,
      trace: tree,
      openToolNodeIds: { ...state.openToolNodeIds, [action.call.id]: node.id },
      executing: [...state.executing, { call: action.call, startedAt: now }],
    };
  },

  'tool.result': (state, action) => {
    const result: ToolResultMessage = action.message;
    const exists = state.messages.some(
      (m) => m.role === 'toolResult' && m.toolCallId === result.toolCallId,
    );
    if (exists) return state;
    const now = Date.now();
    const openId = state.openToolNodeIds[result.toolCallId] ?? null;
    const text = result.content
      .map((c) => (c.type === 'text' ? c.text : '[image]'))
      .join(' ')
      .replace(/\s+/g, ' ');
    let { trace } = state;
    if (openId) trace = patchNode(trace, openId, { status: 'ok', endedAt: now });
    // 工具失败也是一个 error 节点（同样不推进 tip），成功才是 tool.result 推进。
    const { tree, node } = result.isError
      ? appendNode(trace, openId, 'error', {
          status: 'error',
          label: text,
          detail: text,
          meta: { tool: result.toolName },
          createdAt: now,
          endedAt: now,
        })
      : appendNode(trace, openId, 'tool.result', {
          status: 'ok',
          label: summarize(text),
          detail: text,
          meta: { tool: result.toolName },
          createdAt: now,
          endedAt: now,
        });
    const openToolNodeIds = { ...state.openToolNodeIds };
    delete openToolNodeIds[result.toolCallId];
    return {
      ...state,
      trace: tree,
      openToolNodeIds,
      errorNodeId: result.isError ? node.id : state.errorNodeId,
      executing: state.executing.filter((t) => t.call.id !== result.toolCallId),
      pendingToolCalls: state.pendingToolCalls.filter((c) => c.id !== result.toolCallId),
      messages: [...state.messages, result],
    };
  },

  // 工具批次收尾：还能再来一轮就回 thinking（effect 会发 agent.run），
  // 撞上轮数上限就直接收工回 idle —— 相位必须在这里闭合，否则 waitForIdle 永远等不到。
  'tool.batch.done': (state) => {
    if (state.phase !== 'calling-tools') return state;
    if (state.turns >= state.maxTurns) {
      // 撞上限：留一个 stop 节点（推进 tip），这样「为什么停了」也在树上。
      const { tree } = appendNode(state.trace, state.trace.tipId, 'stop', {
        status: 'ok',
        label: `已达单回合上限（${state.maxTurns} 轮）`,
        createdAt: Date.now(),
        endedAt: Date.now(),
      });
      return {
        ...state,
        trace: tree,
        phase: 'idle',
        error: `已达单回合工具调用上限（${state.maxTurns} 轮），停止。`,
        llmAttempts: 0,
      };
    }
    // 工具批次结束 = 一轮结束，重试计数归零（下一轮又从第 1 次尝试开始）。
    return {
      ...state,
      phase: 'thinking',
      streamingText: '',
      thinkingText: '',
      llmAttempts: 0,
    };
  },

  /**
   * 换模型。**能力也要跟着换** —— 新模型可能不支持中途插 system。
   * 能力从哪来？内核换模型时会重新 dispatch 一条 `model.init`，那条才是权威；
   * 这条只负责改标识，先把能力**保守地清掉**（标成不支持），等 model.init 补上。
   */
  'model.changed': (state, action) => ({
    ...state,
    model: {
      ...state.model,
      provider: action.provider,
      modelId: action.modelId,
      capabilities: UNKNOWN_CAPABILITIES,
    },
    providerName: action.provider,
    modelId: action.modelId,
  }),
  'thinking.changed': (state, action) => ({
    ...state,
    model: { ...state.model, thinkingLevel: action.level },
    thinkingLevel: action.level,
  }),

  /**
   * 新对话：清空 messages 与轨迹，但**保留**已装载的 prompt / model。
   *
   * 它们是**会话级**的（这个内核用哪个模型、跟它说什么），不是这一轮对话的产物。
   * 换模型请走 `model.changed` + `model.init`，别混在这里。
   */
  'conversation.reset': (state) => {
    const fresh = createInitialState({
      systemPrompt: state.prompt.systemPrompt,
      providerName: state.model.provider,
      modelId: state.model.modelId,
      ...(state.model.thinkingLevel !== undefined
        ? { thinkingLevel: state.model.thinkingLevel }
        : {}),
      toolNames: state.prompt.tools.map((tool) => tool.name),
      maxTurns: state.maxTurns,
      llmTimeoutMs: state.llmTimeoutMs,
      maxLlmAttempts: state.maxLlmAttempts,
      sessionId: state.trace.sessionId,
    });
    return {
      ...fresh,
      // 保留装载好的两块（会话级的，不是对话级的）。
      prompt: state.prompt,
      model: state.model,
      persistedSeq: state.persistedSeq,
    };
  },
};

/** 没有登记的 action 就是「纯状态变更」，不产生 Cmd。 */
const NO_EFFECT = (): CmdType[] => [];

/**
 * 接线表在运行时只是一张 `Record<string, fn>`，但 TS 看到的类型是所有 key 的交叉，
 * 取值时必须按具体 key 收窄。所以内部用「已收窄」的一侧，构造时再 cast 回去。
 */
type EffectFor<K extends AgentActionType> = ReducerEffects[K];
type AnyEffect = EffectFor<AgentActionType>;

export function createAgentReducer(
  effects: Partial<ReducerEffects>,
): LoopReducer<AgentState, AgentAction> {
  const table = { ...(effects as Record<string, AnyEffect | undefined>) } as Record<
    string,
    AnyEffect
  >;
  const transitionsByType = transitions as unknown as Record<
    string,
    (s: AgentState, a: AgentAction) => AgentState
  >;

  return (state, action) => {
    if (state === undefined) {
      throw new Error('agentReducer 需要一个确定的初始状态');
    }
    // redux-loop 会塞一个 @@REDUX_LOOP/* 的哨兵 action 进来（默认处理检查），
    // 状态照原样返回即可，别去查表。
    const typed = action as AgentAction;
    const transition = transitionsByType[typed.type];
    if (!transition) return state;

    const nextState = transition(state, typed);
    // 接线要读的是**迁移之后**的状态：像 llm.failed 判出的 retrying，正是 transition 刚算出来的。
    // 传旧状态的话，接线永远看不到本次 action 造成的新事实，重试也就发不出去。
    const emit = (table[typed.type] ?? NO_EFFECT) as (a: AgentAction, s: AgentState) => CmdType[];
    const cmds = emit(typed, nextState) ?? [];
    if (cmds.length === 0) return nextState;
    // redux-loop 的 loop(state, cmd) 只收一个命令；多个命令用 Cmd.list 打包。
    const [first, ...rest] = cmds;
    return rest.length === 0
      ? loop(nextState, first as CmdType)
      : loop(nextState, Cmd.list(cmds));
  };
}

/**
 * 环的接线。**每个字都是 Cmd** —— 没有一行 `if`，也没有一个直接的函数调用。
 *
 * 关键点：`llm.done` 之后发的是 `Cmd.action(tool.call)`，不是 `table.runTools(...)`。
 * 也就是说「LLM 说要调工具」这件事本身也要**再走一次 dispatch**，被 reducer 重新看到一次，
 * 然后 `tool.call` 那一行才发出真正干活的 `runTools`。这样整条环上没有一个环节是
 * 「上一个 effect 直接调用下一个 effect」—— 每一步都是 action 进、action 出。
 */
/**
 * 把一条 action 重新 dispatch 出去：让 reducer 再看到它一次，于是它自己的那行接线才发出下一个 Cmd。
 *
 * 这不是「直接调用下一个 effect」—— 中间隔着一次完整的 dispatch，状态先更新，接线再读新状态。
 * 少了这一步，`agent.run` 的迁移就不会跑，轨迹树上也就永远开不出 llm.attempt 节点。
 */
function redispatch(action: AgentAction): CmdType {
  return Cmd.action(action);
}

export function loopWiring(table: {
  runAgent(text?: string): CmdType;
  runTools(calls: ToolCall[]): CmdType;
}): Pick<
  ReducerEffects,
  | 'user.message'
  | 'agent.run'
  | 'llm.started'
  | 'llm.done'
  | 'llm.failed'
  | 'tool.call'
  | 'tool.batch.done'
> {
  return {
    // user.message 之后要走一次 agent.run，让它的迁移开出一个 llm.attempt 节点。
    'user.message': () => [redispatch({ type: 'agent.run' })],

    'agent.run': (action) => [table.runAgent((action as { text?: string }).text)],

    // 流开始前先发一条 action：UI 靠它把「正在生成」的点亮，而不是等第一个 delta。
    'llm.started': () => [],

    'llm.done': (action, state) => {
      // 注意：接线拿到的是**迁移后**的状态，而 llm.done 的迁移已经把相位推到了 calling-tools。
      // 所以这里不能用 'thinking' 判定（那会永远为假，工具就永远不跑）；
      // 也不能用 'idle'（llm.done 之后已经是 calling-tools 了）。
      // 该跑的判据是「这次确实带工具调用」，相位由 tool.call / runTools 自己去推进。
      const message = (action as { message: AssistantMessage }).message;
      const toolCalls = message.content.filter((c): c is ToolCall => c.type === 'toolCall');
      if (toolCalls.length === 0) return [];
      // 直接发 runTools（不是 redispatch）：工具 attempt 节点由 tool/start 的迁移开，
      // 而 tool/start 本来就是 runTools 内部 dispatch 的第一条 action。
      //
      // 为什么这里不用 redispatch 绕一圈：llm.done 是从 Cmd.run 的 successActionCreator 进来的，
      // 此时 install() enhancer 的 cmdsQueue 已经被外层 dispatch 取走，从这里再 dispatch 一个 action，
      // 它触发的 Cmd 没人冲刷 —— 环会停在 calling-tools。所以这一步老老实实发 Cmd。
      return [table.runTools(toolCalls)];
    },

    /**
     * 失败后要不要重试。reducer 已经判好了：`state.retrying` 为真就说明「可重试且还有次数」，
     * 并且它把相位留在了 thinking（所以环没闭合，waitForIdle 不会提前返回）。
     *
     * 这里补一条 agent.run，环就自己转起来了；新一轮 attempt 会挂在**同一个父节点**下，
     * 因为失败没有推进 tip —— 树上于是长出一根分叉，和 git log --graph 一个形状。
     */
    // 同样要绕一圈：只有让 reducer 再看到一次 agent.run，才会开出新的 attempt 节点。
    'llm.failed': (_action, state) =>
      state.retrying ? [redispatch({ type: 'agent.run' })] : [],

    'tool.call': (action) => [table.runTools((action as { calls: ToolCall[] }).calls)],

    // 同样绕一圈，让 agent.run 的迁移开出新一轮的 llm.attempt 节点。
    // 直接调 runAgent 的话，这一轮 LLM 在树上就没有 attempt 节点，result 变成孤儿。
    'tool.batch.done': (_action, state) =>
      state.turns >= state.maxTurns ? [] : [redispatch({ type: 'agent.run' })],
  };
}

export { transitions as _transitions };
