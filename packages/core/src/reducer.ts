import { Cmd, loop, type CmdType, type LoopReducer } from 'redux-loop';
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import type { AgentAction, AgentActionType, ModelSpec } from './actions';
import {
  createInitialState,
  isRetryable,
  stopCauseText,
  type AgentState,
  type LlmErrorKind,
  type QueuedInput,
  type StopCause,
  type TurnEndReason,
} from './state';
import { appendNode, patchNode, type TraceNode, type TraceNodeStatus, type TraceTree } from './trace';
import { compactReasonText, type CompactReason } from './compact';
import { buildPromptHead, declaredToolSchemas, toolDeclarationDelta } from './prompt-head';
/**
 * 一张纯表：action → (下一个状态, 该发哪些 effect)。
 *
 * 没有 if (kind === 'agent')，没有 driver/mode：reducer 只做两件事，
 * 算状态、查「这个 action 类型的 effect 是谁」。`agent.run` 与 `tool.call` 在这里
 * 完全平级 —— 它们各自有一行，各自的效果来自注入的 effect 表。
 *
 * 环写出来就是这个表自己接上的：
 *   user.message    → [turn.start → step.start → agent.run]
 *   step.start      → [agent.run]
 *   agent.run       → [llm.started → llm.delta* → llm.done]（effect 回流）
 *   llm.done        → 无工具：[queue.delivered?] / [turn.end]（回合收工）
 *                   ／有工具：[tool.call]
 *   tool.call       → [tool.batch.done]（effect 回流）
 *   tool.batch.done → steer 有货：[queue.delivered → step.start]
 *                   ／否则：[step.start → agent.run]   ← 环在这里闭合
 *
 * ## 两层容器：turn 与 step
 *
 * - **turn** = 一次用户输入引发的整个回合（user → 若干 step → 收工）。
 * - **step** = 一次 LLM 调用 **加上它触发的工具批次**（取代了原先的 `llm.attempt`）。
 *
 * 轨迹树于是是 `user → turn → step → llm.result / tool.*`。
 * 重试的分叉发生在 **step 这一层**：容器与失败都不推进 tip，所以重试的新 step
 * 仍然挂回同一个 turn 节点。
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

/**
 * 开一个新的 step 容器（一次 LLM 调用 + 它的工具批次）。
 *
 * ## parent 为什么仍然是 tip
 *
 * 这是整个分叉语义的所在地。原先它开的是 `llm.attempt`，现在叫 `step.start`，
 * 但 parent 的取法**一模一样**：取**发起这一刻**的 tip。
 *
 * 于是第一次失败（step 不推进 tip、error 也不推进）之后，重试开的新 step 拿到的
 * 仍然是超时前那个节点的 id —— 在 turn 容器下面长出 git 那样的分叉。
 */
function openStepNode(state: AgentState, now: number): { state: AgentState; node: TraceNode } {
  const attempt = state.llmAttempts + 1;
  // 「重试」= 本次 step 不是第一次尝试（第一次失败后接线又发了 agent.run）。
  const retry = attempt > 1;
  // step 挂到 **turn 节点**下面（而不是 tip）—— 这是新层级里唯一需要改的地方：
  // 工具结果会推进 tip（tool.result 在集合里），若 step 也挂 tip，
  // 第二个 step 就会挂到第一个 step 的 tool.result 底下，层数无法控制。
  const parentId = state.openTurnNodeId ?? state.trace.tipId;
  const stepIndex = state.stepIndex + 1;
  const { tree, node } = appendNode(state.trace, parentId, 'step.start', {
    status: 'pending',
    label: retry ? `第 ${stepIndex} 步（重试）` : `第 ${stepIndex} 步`,
    meta: { provider: state.providerName, model: state.modelId },
    createdAt: now,
  });
  return {
    state: {
      ...state,
      trace: tree,
      openLlmNodeId: node.id,
      openStepNodeId: node.id,
      stepIndex,
      llmAttempts: attempt,
      retrying: retry,
      // 这个 step 里已经完成的工具数（step.end 要用它写节点标签）。
      stepToolCalls: 0,
    },
    node,
  };
}

/** 成功：在 step 下挂 result 节点（它才是推进 tip 的那个）。 */
function closeLlmSuccess(
  state: AgentState,
  now: number,
  detail: string,
  message: Message,
): AgentState {
  const openId = state.openStepNodeId ?? state.openLlmNodeId;
  let { trace } = state;
  if (openId) trace = patchNode(trace, openId, { status: 'ok', endedAt: now });
  const { tree, node } = appendNode(trace, openId, 'llm.result', {
    status: 'ok',
    label: summarize(detail),
    detail,
    message,
    createdAt: now,
    endedAt: now,
  });
  return { ...state, trace: tree, openLlmNodeId: null, retrying: false };
}

/** 关掉当前 step 容器（`step.end` 节点）。它**不推进 tip** —— tip 由里面的 result 推进。 */
function closeStepNode(
  state: AgentState,
  now: number,
  status: TraceNodeStatus,
): AgentState {
  const openId = state.openStepNodeId;
  if (openId === null) return { ...state, openLlmNodeId: null };
  // `stepToolCalls` **先**取出来写进标签，**然后**才在返回值里归零。
  // 顺序反了的话标签会永远写 0（拿到的已是清零后的值）——
  // 而这个数在 step.end 之后就再也没地方能重新取到了。
  const toolCalls = state.stepToolCalls;
  const { tree } = appendNode(state.trace, openId, 'step.end', {
    status,
    label: `第 ${state.stepIndex} 步结束（${toolCalls} 个工具调用）`,
    meta: { tools: String(toolCalls) },
    createdAt: now,
    endedAt: now,
  });
  return {
    ...state,
    trace: tree,
    openStepNodeId: null,
    openLlmNodeId: null,
    totalSteps: state.totalSteps + 1,
    // 下一步的工具数从头数（否则每个 step.end 的标签会一直累加）。
    stepToolCalls: 0,
    // **`turnSteps` 在这里加，而不是在各个调用点加。**
    //
    // 为什么：调它的地方有四四处（llm.done 无工具、llm.failed、llm.giveup、
    // tool.batch.done），少一处就少算一步 —— 而 turn.end 的标签会写「1 步」
    // 而树上明明有两个 step.end。那种错误不报错，只是数字对不上。
    // 「关掉一个 step」这件事只发生在这里，所以计数器也只该在这里动。
    turnSteps: state.turnSteps + 1,
  };
}

/**
 * 关掉整个回合（`turn.end` 节点，**推进 tip**）。
 *
 * 与 step 不同，回合容器闭合时**要**推进 tip —— 后面发生的事（下一回合、用户消息）
 * 都从它下面长出来，与 `compact` 节点同口径。
 */
function closeTurnNode(
  state: AgentState,
  now: number,
  reason: TurnEndReason,
  reasonText: string,
): AgentState {
  const openId = state.openTurnNodeId;
  if (openId === null) return state;
  const { tree } = appendNode(state.trace, openId, 'turn.end', {
    status: reason === 'completed' ? 'ok' : reason === 'aborted' ? 'aborted' : 'error',
    label: `回合 ${state.turnIndex} 结束：${reasonText}`,
    meta: { reason, steps: String(state.turnSteps) },
    createdAt: now,
    endedAt: now,
  });
  return { ...state, trace: tree, openTurnNodeId: null, openTurnSeq: null };
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
  /** effect 告诉我们的节点 id（它知道自己开的是哪个 step）。 */
  nodeId: string | null,
  cause: StopCause,
): AgentState {
  // **effect 若带了自己的 nodeId，以它为准**（与旧代码一致）。
  //
  // 为什么要这个优先级：step 容器**会被重开**。一次重试开的是新的兄弟 step，而失败的
  // 那一步早已关掉（`llm.failed` 里的 `closeStepNode`）—— 于是到下一次失败时
  // `openStepNodeId` 可能已经指向**下一个** step 或是 null。若无脑用 state 里的那个，
  // error 节点会被挂到错误的父下（症状：树分叉位置对不上，且不报错）。
  // effect 手里握着自己开的那一步，所以它的说法更权威。
  const openId = nodeId ?? state.openStepNodeId;
  let { trace } = state;
  // 用户自己按停止不是故障：标成 aborted（灰的），别和真错误（红的）混为一谈。
  const status = kind === 'aborted' ? 'aborted' : 'error';
  if (openId) trace = patchNode(trace, openId, { status, endedAt: now });
  const { tree, node } = appendNode(trace, openId, 'error', {
    status,
    label: error,
    detail: error,
    // cause 一起落进 meta：回放/看树时能分清「超时」与「用户按了停止」—— 二者 kind 都是 aborted。
    meta: { kind, cause },
    createdAt: now,
    endedAt: now,
  });
  return { ...state, trace: tree, openLlmNodeId: null, errorNodeId: node.id, errorKind: kind };
}

/**
 * 从失败的类别推出**停止原因**（`StopCause`）。
 *
 * 为什么不让界面自己推：`kind === 'aborted'` 既可能是用户按了停止，
 * 也可能是内核被关掉时顺手 abort 的 —— 都是 aborted，但前者不该弹红框。
 * 所以 effect 侧把真实原因（`action.cause`）带进来，这里只做兜底推断：
 * effect 没带 cause 时（比如老代码路径）至少还能给出一个不至于错的粗分类。
 */
export function causeFromKind(kind: LlmErrorKind, cause?: StopCause): StopCause {
  if (cause !== undefined) return cause;
  if (kind === 'aborted') return 'user';
  if (kind === 'timeout' || kind === 'network' || kind === 'auth' || kind === 'model') return kind;
  return 'llm-error';
}
/** 取一段文本的头一行做 label。 */
function summarize(text: string): string {
  const first = text.trim().split('\n')[0] ?? '';
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

/**
 * 给重复的 tool call id 改名，保证一轮里的 id 唯一。
 *
 * ## 为什么必须做
 *
 * 协议要求：一个 assistant 消息里有几个 toolCall，就必须有几个对应的 toolResult，
 * 且靠 id 配对。模型偶尔会返回**重复的 id**（同一批里两个都叫 `call_1`），于是：
 *   - `toolResult` 的判重会把第二个结果丢掉，消息流变成「2 个 call、1 个 result」——协议非法，
 *     provider 报错或行为异常，表现为**会话莫名停掉**；
 *   - `openToolNodeIds[id]` 也会互相覆盖，第一个工具的轨迹节点永远闭合不了。
 *
 * 去重是错的（丢掉模型真要执行的调用），必须在我们这一层把 id 变唯一。
 *
 * ## 怎么改
 *
 * id 在会话里出现过就加 `#2`、`#3` 后缀。id 对模型只是占位符（它下一轮看到的是我们回传的
 * toolResult 与新 id 的配对），所以改写是安全的 —— 而且**必须**改写。
 *
 * 同一批内的重复、以及与历史消息的重复，都算「出现过」。
 *
 * @returns 改写后的 message、toolCalls，以及「原 id → 新 id」的映射（排障用）。
 */
function dedupeToolCallIds(
  message: AssistantMessage,
  state: AgentState,
): { message: AssistantMessage; toolCalls: ToolCall[]; renames: Map<string, string> } {
  const calls = message.content.filter((c): c is ToolCall => c.type === 'toolCall');
  if (calls.length === 0) return { message, toolCalls: calls, renames: new Map() };

  // 已用过的 id：历史 toolResult 里的 + 历史 assistant 消息里的。
  const used = new Set<string>();
  for (const m of state.messages) {
    if (m.role === 'toolResult') used.add(m.toolCallId);
    if (m.role === 'assistant') {
      for (const c of m.content) {
        if (c.type === 'toolCall') used.add(c.id);
      }
    }
  }

  const renames = new Map<string, string>();
  const claimed = new Set<string>();
  const rewritten = calls.map((call) => {
    const original = call.id;
    if (!used.has(original) && !claimed.has(original)) {
      claimed.add(original);
      return call;
    }
    // 撞了：加后缀直到唯一。
    let n = 2;
    let candidate = `${original}#${n}`;
    while (used.has(candidate) || claimed.has(candidate)) {
      n += 1;
      candidate = `${original}#${n}`;
    }
    claimed.add(candidate);
    // 每次改名都记一条（不用 has() 去重）：三个同名 id 会产生两条改名记录，
    // 告警要能反映真实次数 —— 少了就看不出模型重复了几次。
    renames.set(`${original}@${n}`, candidate);
    return { ...call, id: candidate };
  });

  if (renames.size === 0) return { message, toolCalls: rewritten, renames };

  // 改写后的 toolCall 必须放回 message.content —— messages 里要用新 id，
  // 否则后面 toolResult 回来的 id 与消息里的对不上（那正是要避免的病）。
  let index = 0;
  const content = message.content.map((c) => {
    if (c.type !== 'toolCall') return c;
    const next = rewritten[index];
    index += 1;
    return next ?? c;
  });
  return { message: { ...message, content }, toolCalls: rewritten, renames };
}

/**
 * 把一份 `ModelSpec` 装进 state —— `model.init` 与 `model.changed` **共用这一份**。
 *
 * 载荷一致的好处就在这里：两条 action 只差「该不该在轨迹上留痕」，状态迁移一字不差。
 * 早先 `model.changed` 只改标识、把能力保守清成 false（等 `model.init` 补），
 * 于是存在一个「说要用新模型、却不知道它支持什么」的中间态 —— 现在没有了。
 */
function applyModelSpec(state: AgentState, spec: ModelSpec): AgentState {
  return {
    ...state,
    model: {
      provider: spec.provider,
      modelId: spec.modelId,
      thinkingLevel: spec.thinkingLevel,
      reasoning: spec.reasoning ?? false,
      capabilities: spec.capabilities,
      contextWindow: spec.contextWindow ?? 0,
      seeded: true,
    },
    // 扁平别名跟着更新（真相在 model 块里）。
    providerName: spec.provider,
    modelId: spec.modelId,
    thinkingLevel: spec.thinkingLevel,
  };
}

/** 把 prompt 那半（base / tools / skills）追加到树上。parent 取此刻的 tip。 */
function appendPromptNodes(tree: TraceTree, prompt: AgentState['prompt'], now: number): TraceTree {
  const skills = prompt.skills ?? [];
  // detail 用 **state 里的** systemPrompt（已经拼好 skill 清单），
  // 而不是 init action 载荷里的那份：树上要显示的就是真正发给模型的那一整段。
  const { tree: afterBase, node: baseNode } = appendNode(tree, tree.tipId, 'prompt.base', {
    status: 'ok',
    label: summarize(prompt.systemPrompt),
    detail: prompt.systemPrompt,
    createdAt: now,
    endedAt: now,
  });
  const tools = prompt.tools;
  // parent 用 base 节点的 **id**（不是它的 tipId —— prompt.base 不推进 tip，
  // 那样取会拿到装载前的 tip，两兄弟就散了）。
  const { tree: afterTools } = appendNode(afterBase, baseNode.id, 'prompt.tools', {
    status: 'ok',
    label: tools.map((t) => t.name).join(', ') || '（无）',
    detail: tools.map((t) => `${t.name}: ${t.description}`).join('\n'),
    meta: { count: String(tools.length) },
    createdAt: now,
    endedAt: now,
  });
  // skill 清单第三个节点：与 prompt / tools 平级，都是「装了什么」。
  // **只在有 skill 时才建节点** —— 零 skill 的会话多一个空节点是噪声。
  return skills.length > 0
    ? appendNode(afterTools, baseNode.id, 'prompt.skills', {
        status: 'ok',
        label: skills.map((s) => s.name).join(', '),
        detail: skills
          .map((s) => `${s.name}（${s.scope}）: ${s.description}\n  ${s.filePath}`)
          .join('\n'),
        meta: { count: String(skills.length) },
        createdAt: now,
        endedAt: now,
      }).tree
    : afterTools;
}

/** 把 model 那半（provider / model / 思考级别 / 能力）追加到树上。 */
function appendModelNode(
  tree: TraceTree,
  model: AgentState['model'],
  now: number,
  /** 节点种类：装载（`model.init`）还是切换（`model.changed`）。 */
  kind: 'model.init' | 'model.changed',
): TraceTree {
  const caps = model.capabilities;
  // 能力逐条写进 meta：树上就能一眼看出「这个模型能不能中途插 system」。
  return appendNode(tree, tree.tipId, kind, {
    status: 'ok',
    label: `${model.provider}/${model.modelId}`,
    meta: {
      thinking: String(model.thinkingLevel),
      reasoning: String(model.reasoning),
      midConvoSystem: String(caps.midConvoSystemMessages),
      midConvoTools: String(caps.midConvoToolAdditions),
      developerRole: String(caps.developerRole),
    },
    createdAt: now,
    endedAt: now,
  }).tree;
}

/**
 * 补上装载段的轨迹节点 —— **用户发出第一句话的那一刻**。
 *
 * ## 为什么要有这一步
 *
 * 装载（prompt / tools / skills / model）必须**立刻**可用：开场就要报 skill 清单、
 * `/skill:x` 要立刻能展开、底栏要显示模型。所以那些留在 `prompt.init` / `model.init` 里，
 * 它们只改 state，**不进轨迹树**。
 *
 * 而「在树上留痕」应该等到**真的有对话** —— 一个只装了东西、一句话都没说的会话，
 * 轨迹树上只有四个装载节点、文件里也只有装载记录：纯噪声。
 * （会话文件那边早就是这么做的：`SessionWriter.start()` 记下 header 但不落盘，
 * 见 docs/architecture/sessions.md「空会话不落盘」。这里是它的轨迹侧对应物。）
 *
 * ## 为什么节点内容从 state 读
 *
 * 补出来的必然是**这一刻生效**的那一版装载（期间热重载过 prompt 也算数）——
 * 与模型真正看到的一致，而不是内核初始化时快照下来的那一版。
 *
 * ## 幂等
 *
 * `traceBegun` 守卫：已经补过就原样返回，不会把装载节点追加第二遍。
 * （开局之后再来一条 `prompt.init` = 热重载，**那一条自己**会追加新节点，见 transitions。）
 *
 * @returns 带上装载节点的树（不推进 tip —— 上下文不是「发生过的事」）。
 */
function beginTrace(state: AgentState, now: number): TraceTree {
  if (state.traceBegun) return state.trace;
  let tree = state.trace;
  if (state.prompt.seeded) tree = appendPromptNodes(tree, state.prompt, now);
  if (state.model.seeded) tree = appendModelNode(tree, state.model, now, 'model.init');
  return tree;
}

/**
 * 把「模型 / 思考级别变了」补成**一个** `model.init` 节点 —— 推迟到下次真要发消息时补。
 *
 * ## 为什么不在 `model.init` / `thinking.changed` 里当场补
 *
 * 那两个 action 是**界面动作**（`/model`、`Ctrl+P`、`Shift+Tab`、`/thinking`、设置面板
 * 里改某一档），而轨迹树要回答的是「这一轮实际发出去的是什么」。所以：
 *
 * - 来回切三次、或先换模型再调思考级别 = 树上**一个**节点，内容是最后那版；
 * - 节点落在 user 节点**之前**（也就是 `turn.start` 之前），读起来就是
 *   「这一轮带着这个模型/档位」，与 `beginTrace()` 补装载节点同一个口径。
 *
 * 标记（`modelTraceDirty`）只在 `traceBegun` 之后置上：树还没开时本来就不建节点，
 * `beginTrace()` 会从 state 里读出那一刻生效的那一版（包含刚改的档位）。
 */
function flushModelChange(state: AgentState, now: number): AgentState {
  if (!state.modelTraceDirty) return state;
  return {
    ...state,
    trace: appendModelNode(state.trace, state.model, now, 'model.changed'),
    modelTraceDirty: false,
  };
}


/**
 * 请求即将发起时，把**工具集的变化**声明进消息流。
 *
 * `state.prompt.tools` 是「能执行什么」，transcript 里的声明是「模型能调什么」；
 * 两者不一致就追加一条 `toolsAdded` / `toolsRemoved` 的 system 消息 —— 与
 * pi-agent-core 的 `declareToolChanges(context, pendingMessages)` 同一步。
 *
 * ## 为什么 head 要拿 `headTools`
 *
 * head 是 `messages[0]` 的**不可变历史**，它的 `toolsAdded` 必须一直是装载时那批。
 * 拿「当前工具集」去构造 head 的话，`web_enable` 一启用新工具，head 就跟着变，
 * 前面所有 token 的缓存前缀全废 —— 那是这次改动要防的头号事故。
 * 变更只能作为**新的** system 消息追加（`toolDeclarationDelta` 算出来的差）。
 *
 * ## 为什么放在 `agent.run` 而不是 effect 里
 *
 * 状态只能由 action 改。`agent.run` 正是「请求即将发起」那一步（下一件事就是
 * `callLlm`），所以声明在这里落地最准 —— effect 里改 state 会绕过 reducer。
 */
function withToolDeclarations(state: AgentState): Message[] {
  const changes = toolDeclarationDelta({
    head: buildPromptHead({
      systemPrompt: state.prompt.systemPrompt,
      ...(state.prompt.sections !== undefined ? { sections: state.prompt.sections } : {}),
      tools: declaredToolSchemas(state.prompt.headTools ?? state.prompt.tools),
    }),
    currentTools: declaredToolSchemas(state.prompt.tools),
    messages: state.messages,
  });
  if (changes === undefined) return state.messages;
  const message: Message = {
    role: 'system',
    content: '',
    toolsAdded: changes.toolsAdded,
    ...(changes.toolsRemoved.length > 0 ? { toolsRemoved: changes.toolsRemoved } : {}),
    timestamp: Date.now(),
  };
  return [...state.messages, message];
}

const transitions: TransitionHandlers = {
  // ── prompt 侧装载 ──

  /**
 * 装载 prompt：**已经拼好的那一整段 system prompt** + 工具的**完整定义**。
 *
 * tools 落进 state 之后，`effects.ts` 就不用每次 `getTools()` 现算了 —— 既少一次 IO，
 * 也让回放时不必重新装配工具就能知道当时发给模型的是什么。
 *
 * ## 这里**不开**轨迹节点，也不拼 prompt
 *
 * 装载节点（prompt.base / prompt.tools / prompt.skills）改由 `beginTrace()` 补上 ——
 * 也就是**用户真的发出第一句话时**才建。
 *
 * 为什么推迟：内核一装配就 dispatch 这两条装载，于是「打开界面还没说话」也已经有了
 * 四个节点（切到轨迹页一打开就是一屏提示词与工具名），并且 `traces/<id>.jsonl` 立刻被建出来。
 * 而「进来看一眼就退出」是常态 —— 那些会话文件里只有装载段、零条对话，
 * 是纯粹的噪声（会话文件那边早就有同样的处理：`SessionWriter.start()` 不落盘，
 * 见 docs/architecture/sessions.md「空会话不落盘」；这里是它的轨迹侧对应物）。
 *
 * ## 为什么这里**不再**拼 skill 清单
 *
 * 早先是 `systemPrompt + formatSkillsForPrompt(skills)` —— 手工往尾巴上接。
 * 现在 prompt 由 pi 的 `buildSystemPrompt` 拼，skill 清单进它自己的 `<skills>` 段
 * （见 [system-prompt.ts](system-prompt.ts)）。
 *
 * 差别不只是「谁拼的」：接在尾巴上时，那段清单是**没有标签的裸文本**，模型不知道
 * 那是系统给的规则还是用户说的话；而 `<skills>` 是有边界的段。
 * 更要紧的是**只有一处**会拼 —— 两处各拼一遍（内核拼一次、reducer 再接一次）迟早漂移，
 * 而症状是「prompt 里 skill 清单出现两次」，token 白花且模型困惑。
 *
 * **state 里该有的东西一个字不少** —— prompt、tools、skills、诊断全都立刻可用，
 * 界面开场就能报 skill 清单、`/skill:x` 就能展开。推迟的只是「在树上留痕」与「落盘」。
 */
  'prompt.init': (state, action) => {
    const prompt = {
      // 原样接收：内核拼好的那一段就是最终形态（工具规则 / AGENTS.md / cwd / skills）。
      systemPrompt: action.systemPrompt,
      tools: action.tools,
      // 装载时那一批**单独留一份**：head 的 `toolsAdded` 用它，之后工具集再变也不动
      // （见 PromptState.headTools）。
      headTools: action.tools,
      ...(action.sections ? { sections: action.sections } : {}),
      ...(action.skills ? { skills: action.skills } : {}),
      ...(action.skillDiagnostics && action.skillDiagnostics.length > 0
        ? { skillDiagnostics: action.skillDiagnostics }
        : {}),
      seeded: true,
    };
    return {
      ...state,
      // **已经开过树**的话（即热重载：会话已经聊起来了又重装一次），立刻追加新节点 ——
      // 旧节点留在树上不改写（装载是不可变的历史）。开局那次不走这里：
      // 树还没开，由第一条 user.message 统一补（见 beginTrace）。
      trace: state.traceBegun ? appendPromptNodes(state.trace, prompt, Date.now()) : state.trace,
      prompt,
      // 扁平别名跟着更新（真相在 prompt 块里）。
      systemPrompt: prompt.systemPrompt,
      toolNames: action.tools.map((tool) => tool.name),
    };
  },

  /**
   * 中途追加一段 prompt。落进 `messages` —— 它是 Conversation 的一部分，所以会被一起
   * 落盘、一起回放。
   *
   * 模型支不支持中途插是**模型**的事（`state.model.capabilities`），我们不自己折：
   * 不支持时 pi-ai 会把后来的 system 消息折进开头那条。
   */
  'prompt.segment.added': (state, action) => {
    const now = Date.now();
    const message: Message = {
      role: action.role,
      content: action.text,
      ...(action.sections !== undefined ? { sections: action.sections } : {}),
      timestamp: now,
      ...(action.source !== undefined ? { source: action.source } : {}),
    } as Message;
    // 也进轨迹树：追加 prompt 是「上下文变了」，树上要看得见它插在哪个 attempt 之前。
    // parent 取此刻的 tip —— 于是它就落在「下一轮会读它的那次调用」的正上方。
    const { tree } = appendNode(state.trace, state.trace.tipId, 'prompt.segment', {
      status: 'ok',
      label: action.text === '' ? summarize(Object.keys(action.sections ?? {}).join(' ')) : summarize(action.text),
      detail:
        action.text === ''
          ? JSON.stringify(action.sections ?? {})
          : action.text,
      message,
      meta: {
        role: action.role,
        ...(action.sections !== undefined ? { sections: Object.keys(action.sections).join(',') } : {}),
        ...(action.source !== undefined ? { source: action.source } : {}),
      },
      createdAt: now,
      endedAt: now,
    });
    return { ...state, trace: tree, messages: [...state.messages, message] };
  },

  /**
   * 工具集变了：只更新**当前声明**。
   *
   * `headTools` 保持不动（head 是不可变历史）。老轨迹回放里可能还没有这个字段
   * （那时声明就是 `tools` 那一份）—— 首次变更时把**变更前**那份记下来当 head，
   * 否则 head 会跟着新工具集走，前缀立刻作废。
   */
  'tools.changed': (state, action) => ({
    ...state,
    prompt: {
      ...state.prompt,
      tools: action.tools,
      ...(state.prompt.headTools === undefined ? { headTools: state.prompt.tools } : {}),
    },
    // 扁平别名跟着更新（真相在 prompt 块里）。
    toolNames: action.tools.map((tool) => tool.name),
  }),

  // ── model 侧装载 ──

  /**
   * 装载模型：provider / model / 思考级别 + 这个模型支持什么。
   *
   * 能力随它一起落盘：回放时不必再问 provider「这个模型能不能中途插 system」。
   *
   * 与 `prompt.init` 同一个理由（见那条的注释）：开局那次**不开**轨迹节点，
   * 那一个 `model.init` 节点由 `beginTrace()` 在第一条用户消息时补上。
   * 之后的**切换**走 `model.changed`（另一条 action，载荷相同）—— 那条才会开 `model.changed` 节点。
   */
  'model.init': (state, action) => applyModelSpec(state, action),

  'user.message': (state, action) => {
    if (state.phase !== 'idle') return state;
    const now = Date.now();
    // 有附件时 content 是一组 text/image 块；否则就是纯文本。
    const message: Message = {
      role: 'user',
      content: action.content ?? action.text,
      timestamp: now,
    };
    // **先补装载节点、再补「换过模型 / 思考级别」那一笔、最后才是 user 节点** ——
    // 顺序就是它们在树上的顺序，于是渲染出来是「这次调用带着什么上下文」在
    // 「用户说了什么」上面。
    //
    // 第一步就是「进入会话不建节点，发了第一句话才建」：内核一装配时树上还是空的
    // （prompt.init / model.init 只改 state），到这里才第一次有节点。
    //
    // 第二步是同一件事的后半段：树已经开着的时候切换了模型 / 档位，那一条
    // `model.init` 也在这一刻落下（`turn.start` 之前）。第一次发话时它是个空操作
    // —— 装载那一版刚由第一步补过。
    const begun = beginTrace(state, now);
    const withModel = flushModelChange({ ...state, trace: begun }, now);
    // 用户节点是一棵新树的根，并且推进 tip —— 后面所有的回合都挂在它下面。
    const { tree, node } = appendNode(withModel.trace, withModel.trace.tipId, 'user', {
      status: 'ok',
      label: summarize(action.text),
      detail: action.text,
      message,
      createdAt: now,
      endedAt: now,
    });
    return {
      // 展开 `withModel` 而不是 `state`：它带着 `flushModelChange` 清过的标记（以及
      // 刚补上的那条 `model.init`——`tree` 就是在它上面接着长的）。
      ...withModel,
      trace: tree,
      traceBegun: true,
      phase: 'thinking',
      error: null,
      errorNodeId: null,
      errorKind: null,
      // 新一句话 = 上一回合的收工理由作废（这一轮还没停）。
      stopReason: null,
      stopCause: null,
      stopCauseDetail: null,
      retrying: false,
      aborted: false,
      llmAttempts: 0,
      // `turns` 也必须归零，否则 maxTurns 变成「整个会话累计」的上限。
      // 归零前这里必须是 0 起步：一次提问 = 一个 turn = 一条 react 循环（LLM→工具→LLM…）。
      // 漏了这一行，第二次提问就只剩「25 减去前几次累计」那么点额度，于是聊着聊着就停了。
      turns: 0,
      // **`turnIndex` 不在这里加**：那是 `turn.start` 的活。
      // 两处都加会让第一个回合就变成「回合 2」（实测），而且没有任何报错 ——
      // 界面只是每个回合都从 2 开始报。
      //
      // `stepIndex` / `turnSteps` 每个新回合都从头数。
      stepIndex: 0,
      turnSteps: 0,
      streamingText: '',
      thinkingText: '',
      pendingToolCalls: [],
      executing: [],
      messages: [...state.messages, message],
      openLlmNodeId: null,
      openStepNodeId: null,
      // **不填 openTurnNodeId**：回合容器由 `turn.start` 开（它才是「回合开始」这件事）。
      // 这里抢先填上会让 `turn.start` 的防重入守卫直接返回，于是树上永远没有 turn 节点。
      openTurnNodeId: null,
    };
  },

  /**
   * ═══ steer / followUp ═══
   *
   * 两个队列**互不影响**：一列在等什么，与另一列有没有东西无关。
   * 这与 pi 同（`getSteeringMessages()` 与 `getFollowUpMessages()` 是两个独立列表）。
   *
   * 空闲时收到队列消息 = 用户在等一个回合，直接变成正常输入：
   * 那不是「打断」，是「接着说」。
   */
  'queue.input': (state, action) => {
    const item: QueuedInput = {
      text: action.text,
      content: action.content,
      at: Date.now(),
    };
    // 空闲 = 没有正在跑的回合可打断。这条消息应该**立即开一个新回合**，
    // 而不是入队等一个永远不会来的投递时机（相位 idle 时既不会有 tool.batch.done
    // 也不会有 llm.done 来触发投递）。所以这里直接转成 `user.message` ——
    // 与 pi 的 `prompt()` 在空闲时直接开跑是同一个道理。
    if (state.phase === 'idle') {
      // 直接跑 user.message 的迁移 —— 复用那段「归零计数器 + 开 user 节点」的逻辑，
      // 而不是手写一遍。写两遍必然漂移（而漂移的后果是第二个回合的计数从 1 开始）。
      return transitions['user.message'](state, {
        type: 'user.message',
        text: action.text,
        content: action.content,
      });
    }
    return action.as === 'steer'
      ? { ...state, steerQueue: [...state.steerQueue, item] }
      : { ...state, followUpQueue: [...state.followUpQueue, item] };
  },

  /**
   * 清空两条队列（`Alt+Up` 把排队消息还回编辑器时用）。
   *
   * ## 为什么不动 `deliveringInput`
   *
   * 那一条已经「取出、即将插」了（在途），还回编辑器管不到它 —— 它马上就会变成一条
   * 真正的 user 消息。把它也算作「未发出」而回尸，会造成「模型看到了一条、编辑器里
   * 也有一条」的重复。所以只清**还没取**的那两条队列。
   *
   * 纯函数：队列本来就是空的时候返回**原对象**（保持 reducer 的引用稳定，
   * 让订阅者能靠 `===` 跳过无变化的帧）。
   */
  'queue.clear': (state) => {
    if (state.steerQueue.length === 0 && state.followUpQueue.length === 0) return state;
    return { ...state, steerQueue: [], followUpQueue: [] };
  },

  /**
   * 投递一条排队消息：组装成 user 消息插进 `messages`，并开一个 user 轨迹节点。
   *
   * ## 与 `user.message` 的差别（为什么必须是两条 action）
   *
   * `user.message` 会把相位拉到 thinking、把 `turns` 与 step 计数清零。
   * 而投递 steer 时一个 step 可能刚结束，相位必须保持「还要继续跑」——
   * 走 `user.message` 那条路会把正在跑的回合重置（用户看到「对话重来了一遍」）。
   *
   * 所以这里只做两件事：**加消息 + 开 user 节点**（带 `as` 标记），
   * 其余状态由 wiring 随后发的 `step.start` / `agent.run` 推进。
   */
  'queue.delivered': (state, action) => {
    // 防重入：一条已经在途（deliveringInput 非 null）时不接新的一条。
    // 否则连按两次「取队列」会把同一条消息发两遍。
    if (state.deliveringInput !== null) return state;
    const now = Date.now();
    const message: Message = {
      role: 'user',
      content: action.content ?? action.text,
      timestamp: now,
    };
    const isSteer = action.as === 'steer';
    // 插进来的这条消息也要在下一次请求里生效，所以「换过模型 / 档位」那一笔
    // 同样先落在它前面（第一次发话时由 user.message 补过，这里一般是空操作）。
    const withModel = flushModelChange(state, now);
    // steer 的 user 节点挂在**当前回合容器**下面（它是这回合里的一个额外输入）；
    // followUp 的则是**新回合的起点**，所以要挂在 tip 下面（新容器稍后开在它底下）。
    const parentId = isSteer ? (state.openTurnNodeId ?? withModel.trace.tipId) : withModel.trace.tipId;
    const userNode = appendNode(withModel.trace, parentId, 'user', {
      status: 'ok',
      label: `${isSteer ? 'steer' : 'followUp'}: ${summarize(action.text)}`,
      detail: action.text,
      message,
      meta: { queued: action.as },
      createdAt: now,
      endedAt: now,
    });
    const base: AgentState = {
      // 展开 `withModel`：它带着清过的标记与刚补的 `model.init`。
      ...withModel,
      trace: userNode.tree,
      messages: [...state.messages, message],
      deliveringInput: null,
      deliveringAs: null,
      steerQueue: isSteer ? state.steerQueue.slice(1) : state.steerQueue,
      followUpQueue: isSteer ? state.followUpQueue : state.followUpQueue.slice(1),
    };
    if (isSteer) {
      // steer 不碰回合容器：它属于**当前**回合（对齐 pi：「当前 step 的工具跑完后插进来」）。
      // 但相位要离开 idle —— 「接着往下走」这件事本身说明还有活要干。
      return { ...base, openTurnNodeId: state.openTurnNodeId, phase: 'thinking' };
    }
    // **followUp 开新回合 —— 所以必须先把旧容器收尾。**
    //
    // 两点理由：
    // 1. `step.start` 的防重入守卫是「容器开着就返回」。而不先关旧容器，
    //    新容器一开就立刻撞上那条守卫（见下面 `openTurnSeq` 那句注释）。
    // 2. 旧容器不关就没有 `turn.end` 节点 —— 树上会看到一个**永远不闭合**的回合，
    //    而回放出来的回合就少一个闭合点（`traceStats` 数的是 `turn.start`，不受影响）。
    //
    // 旧回合的结局记 'completed'：它确实是正常说完的（正要接下一句）。
    const closed = closeTurnNode(base, now, 'completed', turnReasonText('completed'));
    // 新容器挂在 **tip** 下面（即那条 followUp 的 user 节点，它推进了 tip）。
    const opened = appendNode(closed.trace, closed.trace.tipId, 'turn.start', {
      status: 'pending',
      label: `回合 ${closed.turnIndex + 1}`,
      createdAt: now,
    });
    return {
      ...closed,
      trace: opened.tree,
      openTurnNodeId: opened.node.id,
      // 容器已经换过了，所以序号也同步 —— `step.start` 靠它判断「有没有旧容器待收尾」。
      openTurnSeq: closed.turnIndex + 1,
      turnIndex: closed.turnIndex + 1,
      stepIndex: 0,
      turnSteps: 0,
    };
  },

  /**
   * 开一个新回合的容器（`turn.start`）。
   *
   * ## 为什么它不跟着 `user.message` 一起开
   *
   * `user.message` 之后**不一定**会开 turn —— 队列里的 followUp 也会走
   * `queue.delivered` → `agent.run`，那才是开 turn 的地方。把开容器从
   * 「收到用户消息」拆出来，可以让两种入口共用同一条路径。
   */
  'turn.start': (state) => {
    // 回合已经在跑就别再开一个。
    if (state.openTurnNodeId !== null) return state;
    const now = Date.now();
    const turnIndex = state.turnIndex + 1;
    // 「换过模型 / 档位」那一笔要在容器**之前**落下 —— 它就是这条不变式本身：
    // 树上的 `model.init` 说的是「这一轮用的是这个」，所以必须在 turn.start 上面。
    // （走 user.message 的路已经在补 user 节点前刷过了，这里一般是空操作；
    //  留着它是因为这一条才是「在 turn.start 之前」的硬保证。）
    const withModel = flushModelChange(state, now);
    // turn 挂到 **tip**（即那条 user 节点）下面。
    const { tree, node } = appendNode(withModel.trace, withModel.trace.tipId, 'turn.start', {
      status: 'pending',
      label: `回合 ${turnIndex}`,
      createdAt: now,
    });
    return {
      ...withModel,
      trace: tree,
      openTurnNodeId: node.id,
      turnIndex,
      // 新回合从头数 step（而 turnIndex 是会话级的，不归零）。
      stepIndex: 0,
      turnSteps: 0,
    };
  },

  /**
   * 关掉回合容器。**收工相位由各发起方（llm.done / llm.failed / 撞上限）决定** ——
   * 那时相位已经是 idle，所以这里不发 Cmd，只改状态。
   */
  'turn.end': (state) => {
    // 没有容器可关（还没开过回合、或已经关过）：什么也不做。
    if (state.openTurnNodeId === null) return state;
    // 结局由 state 推：stopReason 说出了什么让它停下，stopCause 说得更准。
    // 两者都是 null = 还在跑，那不该走到这里。
    const reason: TurnEndReason =
      state.stopCause === 'maxTurns'
        ? 'maxTurns'
        : state.stopCause === 'completed' || state.stopReason === 'completed'
          ? 'completed'
          : state.stopReason === 'aborted' || state.aborted
            ? 'aborted'
            : 'error';
    const closed = closeTurnNode(state, Date.now(), reason, turnReasonText(reason));
    // **关回合后 followUp 直接开新回合 —— 在这条迁移里做，不是接线里。**
    //
    // 为什么：这条路是被 llm.done / llm.failed / tool.batch.done 触发的，
    // 而那三个都是 `Cmd.run` 回来的 —— 那一刻 install() enhancer 的 cmdsQueue
    // 已经被外层 dispatch 取走了。接线在这里 redispatch 出去的 `turn.start`
    // 没人冲刷，于是「模型说完了，用户排的那句话就永远躺在队列里」。
    //
    // 而 reducer 是纯的，它可以直接开：开容器、算序号，全在这一条迁移里完成。
    const queued = state.followUpQueue[0];
    if (queued === undefined) {
      return { ...closed, stepIndex: 0, turnSteps: state.turnSteps };
    }
    const now = Date.now();
    // 「换过模型 / 档位」那一笔也先落下来：这条 followUp 马上要开一个新回合，
    // 而新回合用的是「此刻生效」的那一版。
    const flushed = flushModelChange(closed, now);
    // 先把 followUp 那句话作为 user 消息插进去（它开启新回合，所以算回合的起点），
    // 再开回合容器 —— 于是 user 节点在树上排在 turn.start 之前，与正常入口一致。
    const message: Message = {
      role: 'user',
      content: queued.content ?? queued.text,
      timestamp: now,
    };
    const userNode = appendNode(flushed.trace, flushed.trace.tipId, 'user', {
      status: 'ok',
      label: `followUp: ${summarize(queued.text)}`,
      detail: queued.text,
      message,
      meta: { queued: 'followUp' },
      createdAt: now,
      endedAt: now,
    });
    const opened = appendNode(userNode.tree, userNode.tree.tipId, 'turn.start', {
      status: 'pending',
      label: `回合 ${closed.turnIndex + 1}`,
      createdAt: now,
    });
    return {
      // 展开 `flushed`（它带着清过的标记与可能刚补上的那条 `model.init`）。
      ...flushed,
      trace: opened.tree,
      openTurnNodeId: opened.node.id,
      openTurnSeq: closed.turnIndex + 1,
      turnIndex: closed.turnIndex + 1,
      stepIndex: 0,
      turnSteps: 0,
      messages: [...closed.messages, message],
      followUpQueue: closed.followUpQueue.slice(1),
      // 新的一句话 = 上一回合的收工理由作废。
      stopReason: null,
      stopCause: null,
      stopCauseDetail: null,
      // 相位得离开 idle，否则 waitForIdle 会以为已经收工而提前返回。
      phase: 'thinking',
    };
  },

  /**
   * 开一个新 step（一次 LLM 调用 + 它的工具批次）。
   *
   * 原先这一步叫 `llm.attempt`；现在 `step.start` 与 `step.end` 成对出现，
   * 而 `llm.result` / `tool.*` 挂在两者之间。
   */
  'step.start': (state) => {
    // 防重入：上一个 step 还开着时不要又开一个。
    if (state.openStepNodeId !== null) return state;
    let base = state;
    // **先把上一个回合收尾（幂等）。**
    //
    // 为什么需要：「开了新回合但上一个还没关」是一种真实存在的中间态 ——
    // followUp 到达时 reducer 直接开新容器（见 queue.delivered 的注释），
    // 而给旧回合发 `turn.end` 在那条路上发不出去（Cmd.run 回来时没人冲刷，
    // 见 `closeTurn()` 的注释）。
    //
    // 挂在**这一步**而不是统一交给 turn.end，是因为「开了新回合之后下一步一定是
    // step.start」是必然的 —— 把收尾挂在一个必然到来的边上，就不会再出现
    // 「容器一直开着、turn.end 永远不来」的挂起。
    //
    // 判据：`openTurnNodeId` 的序号（openTurnSeq）比当前 `turnIndex` 旧。
    if (state.openTurnNodeId !== null && state.openTurnSeq !== null
      && state.openTurnSeq < state.turnIndex) {
      base = closeTurnNode(base, Date.now(), 'completed', turnReasonText('completed'));
    }
    const opened = openStepNode(base, Date.now());
    return {
      ...opened.state,
      // **重试要清掉上一次的错误**。
      //
      // 为什么这里要清（`agent.run` 也会清）：重试路径是
      // `llm.failed →（接线）step.start → agent.run`，而 `agent.run` 的守卫是
      // 「phase 为 thinking 且 step 已开着就返回」。这一步已经把 step 开上了，
      // 于是 `agent.run` 走进那条守卫直接返回 —— 它清不掉 error。
      //
      // 留着不清的症状是「重试已经成功，底栏还挂着上一条超时红字」。
      error: null,
      errorNodeId: null,
      errorKind: null,
      aborted: false,
    };
  },

  /** 关掉 step 容器。它**不推进 tip** —— 推进的是里面的 result / error。 */
  'step.end': (state, action) => {
    const closed = closeStepNode(state, Date.now(), action.status);
    return { ...closed, turnSteps: state.turnSteps };
  },

  /**
   * 发起一次 LLM 调用。**这里只改相位与重试计数，不开轨迹节点** ——
   * 开 `step.start` 的是它自己那条 action（两者由 wiring 连着）。
   *
   * 拆开的原因：step 容器是一个需要 `step.end` 配对的**区间**，
   * 而 `agent.run` 只是「请求跑一次 LLM」。把两者混在一个 action 里，
   * 重试时就得重新开一个容器而无法先关掉旧的那个。
   *
   * `openStepNodeId !== null` 的守卫是为了防重入：上一次 step 还开着时不要又跑。
   */
  'agent.run': (state) => {
    if (state.phase === 'thinking' && state.openStepNodeId !== null) return state;
    return {
      ...state,
      // 请求即将发起 —— 工具集的变化要在**这一刻**声明出去（pi 的 `declareToolChanges`
      // 同一步）：变了就追加一条 system 消息，没变一个字节都不加。
      messages: withToolDeclarations(state),
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
    const raw = action.message;
    //
    // 模型偶尔会返回**重复的 tool call id**。我们控制不了模型，但必须在自己这一层消掉冲突，
    // 否则消息流会变成「两个 toolCall(call_1) 只有一个 toolResult」——那是协议里非法的序列，
    // provider 会报错或行为异常（表现为会话莫名停掉）。
    //
    // 对策：给 toolCall 换一个**内部唯一 id**（原 id 已在会话内出现过就加后缀），
    // 并让 messages 里的 assistant 消息与 toolResult 用同一套新 id —— 对模型而言 id 只是个占位符。
    const { message, toolCalls, renames } = dedupeToolCallIds(raw, state);
    if (renames.size > 0) {
      // 冲突必须留痕：模型给了重复 id 而我们悄悄改名了，如果什么都不说，
      // 将来出现「工具结果对不上」时根本查不出是哪一步干的。
      // renames 的 key 是 `原id@序号`（保证多次改名都能记下），
      // 告警要显示的是「原 id → 新 id」，所以把序号剥掉。
      for (const [key, to] of renames) {
        const from = (key.split('@')[0] ?? key);
        console.warn(
          `[agent] 模型返回了重复的 tool call id「${from}」，已改名为「${to}」以保证消息序列合法。`,
        );
      }
    }
    const text = message.content
      .map((c) => (c.type === 'text' ? c.text : c.type === 'toolCall' ? `[调用 ${c.name}]` : ''))
      .join(' ')
      .trim();
    // 成功：在当前 step 下面挂 llm.result，由它推进 tip。
    //
    // **这一步不开 step.end**：有工具时 step 还没完（工具批次也要算在这个 step 里），
    // 它的闭合点是 tool.batch.done。只有「无工具」才在这一步就把 step 关掉。
    const closed = closeLlmSuccess(state, Date.now(), text, message);
    const hasTools = toolCalls.length > 0;
    //
    // **用户按了停止**（pi-ai 把那份部分消息以 `stopReason: 'aborted'` 交回来）。
    //
    // ⚠️ **超时进来的不算这一支**：`callLlm` 在把消息交给这里之前就按 `timedOut` 把它
    // 拦成了 `LlmTimeoutError`（超时要报错、要重试，不能伪装成用户的选择）。
    // 所以「一份 aborted 消息走到这里」只能是手动中断（或内核关停）。
    // 以前超时也会落到这里 —— 症状是 120s 的 step 记成 `ok` + 空的 llm.result
    // + 「用户中断」，错误一个字都不留（见 effects.ts `callLlm` 里那段注释）。
    //
    // 这一支必须在这里分：以前无论什么 stopReason 都写成 `completed`，于是界面显示
    // 「✗ 模型自己说完了：Request was aborted」+「按 Ctrl+R 看轨迹树」—— 用户自己按的
    // 停止，却像被程序报了个错，而那句「模型自己说完了」也是错的。
    //
    // 保留那份**部分消息**（pi 也这么做：中止不会把已经流出来的话吞掉），中止说明由
    // 渲染那一层交给 pi 的 `AssistantMessageComponent` 自己画（`stopReason === 'aborted'`
    // → 它画 `Operation aborted`，与 pi 逐字一致）。
    const aborted = message.stopReason === 'aborted';
    // 中止时**不接手那些工具调用**：用户都喊停了，再跑 `rm -rf` 就很离谱。
    const continues = hasTools && !aborted;
    // 无工具 = 模型自己说完了 —— 这是整个回合的终点，所以现在就把 step 与 turn 都关上。
    // 有工具 = 还要跑下一轮，step 留着等 tool.batch.done 收尾。
    const withStep = continues ? closed : closeStepNode(closed, Date.now(), aborted ? 'aborted' : 'ok');
    return {
      ...withStep,
      messages: [...withStep.messages, message],
      streamingText: '',
      thinkingText: '',
      turns: withStep.turns + 1,
      usage: message.usage ?? withStep.usage,
      totalCost: withStep.totalCost + (message.usage?.cost?.total ?? 0),
      pendingToolCalls: aborted ? [] : toolCalls,
      // 中止不往 `error` 里写：那一条会被尾部渲染成一段中文说明 + 轨迹节点提示，
      // 而 pi 的写法是「中止说明属于那条 assistant 消息」（见上）。
      error: aborted ? null : (message.errorMessage ?? withStep.error),
      phase: continues ? 'calling-tools' : 'idle',
      // 有工具 = 这一轮还没完（要接着跑下一轮 LLM），所以不是「停」。
      // 无工具 = 模型自己说完了，这才是真正的收工。
      stopReason: continues ? null : aborted ? 'aborted' : 'completed',
      // 正常收工的原因也记一份：界面不必再猜「completed」是被砍的还是真说完。
      stopCause: continues ? null : aborted ? 'user' : 'completed',
      stopCauseDetail: continues ? null : stopCauseText(aborted ? 'user' : 'completed'),
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
    const cause = causeFromKind(kind, action.cause);
    const closed = closeLlmFailure(state, Date.now(), action.error, kind, action.nodeId ?? null, cause);
    // 只有一个确实在跑的 step 才谈得上「重试」；工具批次的失败走这里时 openStepNodeId 已是 null。
    const wasLlmAttempt = state.openStepNodeId !== null;
    const canRetry =
      wasLlmAttempt && isRetryable(kind) && closed.llmAttempts < closed.maxLlmAttempts;
    // **无论要不要重试，都得先关掉这个 step 容器** —— 失败的那一步已经结束了。
    //
    // 为什么要重试也关：重试在树上长成的是**兄弟**（同一个 turn 下的另一个
    // `step.start`），而不是同一个容器的第二次尝试。否则树会长成
    // 「一个 step 里挤着两次尝试」，而失败与重试哪个在前就再也分不清了 ——
    // 那正是原先 git 分叉语义要表达的东西。
    //
    // 而 `step.start` 的防重入守卫靠的正是 `openStepNodeId === null`，不关它，
    // 重试开的新 step 会被直接丢掉（环停在 thinking，用户看到「卡住了」）。
    const withStep = closeStepNode(
      closed,
      Date.now(),
      kind === 'aborted' ? 'aborted' : 'error',
    );
    return {
      ...withStep,
      phase: canRetry ? 'thinking' : 'idle',
      error: action.error,
      errorKind: kind,
      errorNodeId: closed.errorNodeId,
      retrying: canRetry,
      streamingText: '',
      thinkingText: '',
      executing: [],
      aborted: kind === 'aborted',
      // 还要重试 = 这一轮**没停**，别让界面以为收工了。
      stopReason: canRetry ? null : kind === 'aborted' ? 'aborted' : 'error',
      // 还要重试 = 还没停，原因留空；真停了就记**具体**原因（用户手动 / 超时 / 鉴权…）。
      stopCause: canRetry ? null : cause,
      stopCauseDetail: canRetry ? null : stopCauseText(cause),
    };
  },

  /** 重试用尽：留一个 stop 节点（它是闭合的，所以推进 tip），相位回 idle。 */
  'llm.giveup': (state, action) => {
    const cause = causeFromKind(action.kind, action.cause);
    const now = Date.now();
    // stop 节点挂在 **turn 容器**下面（与 step 同理：回合是它们共同的父）。
    const parentId = state.openTurnNodeId ?? state.trace.tipId;
    const { tree } = appendNode(state.trace, parentId, 'stop', {
      status: 'ok',
      label: action.error,
      detail: action.error,
      // 跟错误节点一样把 cause 记进 meta：树上就能看出「用户主动停了」而不是「模型坏了」。
      meta: { kind: action.kind, cause },
      createdAt: now,
      endedAt: now,
    });
    // 重试已经用尽 = 这一步真的结束了，把 step 容器也关上。
    const withStep = closeStepNode(
      { ...state, trace: tree },
      now,
      action.kind === 'aborted' ? 'aborted' : 'error',
    );
    return {
      ...withStep,
      phase: 'idle',
      error: action.error,
      errorKind: action.kind,
      retrying: false,
      streamingText: '',
      thinkingText: '',
      executing: [],
      stopReason: action.kind === 'aborted' ? 'aborted' : 'error',
      stopCause: cause,
      stopCauseDetail: stopCauseText(cause),
    };
  },

  /** 持久化游标：effect 写完文件后推回来，避免同一段重复落盘。 */
  /**
   * 恢复历史：把已有会话的消息灌进 messages。
   *
   * **只加消息，不动相位也不动轨迹树** —— 这些消息是「上次发生的」，开新节点或推进 tip
   * 会把历史伪装成这一轮。轨迹是那一轮的东西，这里只负责把对话补齐。
   */
  'session.restored': (state, action) => ({
    ...state,
    messages: [...state.messages, action.message],
  }),

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
   * 工具开始：开一个 tool.call 节点，parent 是发起这一刻的 tip（即那条 llm.result）。
   *
   * 为什么仍用 tip 而不是 step 容器：llm.result 推进了 tip，所以它就是 step 容器
   * 与工具节点之间的那个点。挂到 tip 上，工具就落在 llm.result 底下 —— 与原先一致。
   */
  'tool/start': (state, action) => {
    const now = Date.now();
    const argsText = JSON.stringify(action.call.arguments ?? {});
    const { tree, node } = appendNode(state.trace, state.trace.tipId, 'tool.call', {
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

  /**
   * 工具执行中的流式增量。
   *
   * **只改 `toolProgress`，不动 `messages` / 轨迹树**：
   *   - `messages` 只该有终值（理由见 `ToolProgress` 的注释：中途被 Ctrl-C 掉会在
   *     messages 里留下一个没有结果的 toolCall，那是协议非法的）；
   *   - 轨迹树是「一次尝试一节点」，节点在 `tool/start` 开、在 `tool.result` 闭合。
   *     每来一块输出就 append 一个节点会把树冲垮（一个 `npm install` 能刷出几百个）。
   *
   * 工具不在跑时的 progress 丢弃：那是过期消息（工具已经结束才回来的尾巴）。
   */
  'tool.progress': (state, action) => {
    const openId = state.openToolNodeIds[action.toolCallId];
    if (openId === undefined) return state;
    return {
      ...state,
      toolProgress: {
        ...state.toolProgress,
        [action.toolCallId]: { toolCallId: action.toolCallId, content: action.content },
      },
    };
  },

  'tool.result': (state, action) => {
    const result: ToolResultMessage = action.message;
    const exists = state.messages.some(
      (m) => m.role === 'toolResult' && m.toolCallId === result.toolCallId,
    );
    if (exists) {
      // 正常情况下不该走到这里 —— llm.done 已经把重复 id 改掉了。
      // 走到了说明还有别的路径漏了，别静默丢弃：丢了工具结果，消息序列就非法了。
      console.warn(
        `[agent] 收到重复的 toolResult（toolCallId=${result.toolCallId}），已忽略。` +
          `如果反复出现，说明 id 去重漏了哪条路径。`,
      );
      return state;
    }
    const now = Date.now();
    const openId = state.openToolNodeIds[result.toolCallId] ?? null;
    const text = result.content
      .map((c) => (c.type === 'text' ? c.text : '[image]'))
      .join(' ')
      .replace(/\s+/g, ' ');
    let { trace } = state;
    // **失败时 attempt 节点本身要标成 error**，不是 ok。
    //
    // 为什么：轨迹渲染判断「这组兄弟要不要画分叉」看的是**兄弟节点的 status**
    // （isForkGroup）。工具报错时 error 节点挂在 attempt *下面*，于是兄弟组里仍然是
    // 一堆 status='ok' 的 attempt —— 分叉就画不出来了，而那恰恰是最该画的一处。
    // 失败的事实记在子节点上，父节点却显示「成功」，两边自相矛盾。
    if (openId) trace = patchNode(trace, openId, { status: result.isError ? 'error' : 'ok', endedAt: now });
    // 工具失败也是一个 error 节点（同样不推进 tip），成功才是 tool.result 推进。
    const { tree, node } = result.isError
      ? appendNode(trace, openId, 'error', {
          status: 'error',
          label: text,
          detail: text,
          message: result,
          meta: { tool: result.toolName },
          createdAt: now,
          endedAt: now,
        })
      : appendNode(trace, openId, 'tool.result', {
          status: 'ok',
          label: summarize(text),
          detail: text,
          message: result,
          meta: { tool: result.toolName },
          createdAt: now,
          endedAt: now,
        });
    const openToolNodeIds = { ...state.openToolNodeIds };
    delete openToolNodeIds[result.toolCallId];
    // 中间输出到此为止：终值已经在 messages 里，再留着会让界面把它又画一遍。
    // （顺序要紧：在下面算 toolTimings 之前不能删 —— 它还要读 openToolNodeIds。）
    const toolProgress = { ...state.toolProgress };
    delete toolProgress[result.toolCallId];
    // 耗时记在这里（见 AgentState.toolTimings 的注释）：`tool/start` 打的点在这条
    // action 到达时已经过去一会儿了，而这是唯一同时拿到「开始 id」与「结束时刻」的地方。
    // 取 startedAt 走 openToolNodeIds：它还没被删（上两行才删），所以拿得到。
    const startedAt = state.openToolNodeIds[result.toolCallId] !== undefined
      ? state.trace.nodes[state.openToolNodeIds[result.toolCallId] ?? '']?.createdAt
      : undefined;
    return {
      ...state,
      trace: tree,
      openToolNodeIds,
      toolProgress,
      // 工具数加一：`step.end` 的标签要写「这一步跑了几个工具」，
      // 而 tool.batch.done 到来时容器已经关了 —— 所以得在每个 result 上累积。
      stepToolCalls: state.stepToolCalls + 1,
      // 负数/NaN 一律不记：界面会拿它算 `Took x.xs`，一个 NaN 会显示成 "Took NaNs"。
      toolTimings:
        startedAt !== undefined && Number.isFinite(startedAt) && now >= startedAt
          ? { ...state.toolTimings, [result.toolCallId]: now - startedAt }
          : state.toolTimings,
      errorNodeId: result.isError ? node.id : state.errorNodeId,
      executing: state.executing.filter((t) => t.call.id !== result.toolCallId),
      pendingToolCalls: state.pendingToolCalls.filter((c) => c.id !== result.toolCallId),
      messages: [...state.messages, result],
    };
  },

  // 工具批次收尾：还能再来一轮就回 thinking（effect 会发 agent.run），
  // 撞上轮数上限就直接收工回 idle —— 相位必须在这里闭合，否则 waitForIdle 永远等不到。
  //
  // 它同时是 **steer 的投递点**（对齐 pi：「当前 step 的工具跑完后、下一次 LLM 调用前」）。
  // 但投递本身**不在这里做** —— 接线在读到迁移后的 state 时看到 steerQueue 非空，
  // 再发一条 `queue.delivered`。reducer 只负责算状态，不发 action。
  'tool.batch.done': (state) => {
    if (state.phase !== 'calling-tools') return state;
    const now = Date.now();
    // 工具跑完 = 这个 step 的区间结束了（LLM 调用 + 它的工具批次都齐了）。
    const closed = closeStepNode(state, now, 'ok');
    const withStep = closed; // turnSteps 已由 closeStepNode 加过
    if (state.turns >= state.maxTurns) {
      // 撞上限：留一个 stop 节点（推进 tip），这样「为什么停了」也在树上。
      //
      // stop 挂在 **turn 容器**下面，与 step 同父 —— 它们是同一回合里的两件事。
      const parentId = state.openTurnNodeId ?? state.trace.tipId;
      const { tree } = appendNode(withStep.trace, parentId, 'stop', {
        status: 'ok',
        label: `已达单回合上限（${state.maxTurns} 轮）`,
        createdAt: now,
        endedAt: now,
      });
      return {
        ...withStep,
        trace: tree,
        phase: 'idle',
        error: `已达单回合轮数上限（${state.maxTurns} 轮 LLM 调用），停止。`,
        errorKind: null,
        // 「没出错，是被上限砍的」—— 界面靠它把这种情况和真失败区分开（见 StopReason）。
        stopReason: 'maxTurns',
        stopCause: 'maxTurns',
        stopCauseDetail: stopCauseText('maxTurns'),
        llmAttempts: 0,
      };
    }
    // 工具批次结束 = 这一步结束，重试计数归零（下一步又从第 1 次尝试开始）。
    //
    // 相位留在 thinking：接线看到它会发 step.start（然后 agent.run），
    // 于是模型看到工具结果、继续干活。
    return {
      ...withStep,
      phase: 'thinking',
      streamingText: '',
      thinkingText: '',
      llmAttempts: 0,
    };
  },

  /**
   * 换模型。与 `model.init` **同一套参数**（`ModelSpec`），只差语义与留痕。
   *
   * 载荷一致的好处：这里不再需要「先保守清零、等 model.init 补上」—— 一步到位。
   * 轨迹上怎么体现：树开着才置 `modelTraceDirty`，由 `flushModelChange()` 在下次发话前
   * 补一个 **`model.changed` 节点**（来回切三次只留一个，内容是最新那版）。
   */
  'model.changed': (state, action) => ({
    ...applyModelSpec(state, action),
    modelTraceDirty: state.traceBegun ? true : state.modelTraceDirty,
  }),
  'thinking.changed': (state, action) => ({
    ...state,
    model: { ...state.model, thinkingLevel: action.level },
    thinkingLevel: action.level,
    // 思考级别也是「这一轮实际用的上下文」的一部分（写在 model.init 节点的 meta 里），
    // 所以跟换模型走同一条路：只置标记，下次发话时一并补进树。
    modelTraceDirty: state.traceBegun ? true : state.modelTraceDirty,
  }),

  // ── 上下文压缩 ──

  /**
   * 开始压缩：只置相位标记 + 开一个 `compact` 节点（pending）。
   *
   * **只改状态，不动 messages** —— 真正干活的 effect 拿一条 `compact.done` /
   * `compact.failed` 回来。这条 action 本身不花钱。
   *
   * ## 守卫：压缩期间不能再来一次
   *
   * 摘要要打网络（几秒）。这段时间里如果又来一条 `compact.request`，
   * 两个摘要会**同时**基于同一份 messages 生成，回来时后写的覆盖先写的 ——
   * 其中一份摘要的内容已经被丢掉了（不是错，是白花的钱 + 丢信息）。
   * 所以这里直接忽略。
   *
   * ## 守卫：环在跑时不许压
   *
   * 压缩会把 `messages` 整份换掉。若在「LLM 正在流 / 工具正在跑」时换掉，
   * 那条流回来时看到的已经不是它请求的那份历史了 ——
   * 更糟的是 `tool.result` 会找不到它的 `toolCallId`，消息序列变成非法的。
   * 用户要压就等这一轮结束（界面也会拦），这不是自动压。
   */
  'compact.request': (state, action) => {
    if (state.compacting) return state;
    if (state.phase !== 'idle') return state;
    // tree 上开一个 pending 节点，parent 取此刻的 tip。
    // **先开 pending 再等结果**，而不是等压缩完才开：那样中途挂掉就什么都没有，
    // 而「开始压缩了」这个事实本身就该留在树上。
    const { tree, node } = appendNode(state.trace, state.trace.tipId, 'compact', {
      status: 'pending',
      label: compactReasonText(action.reason),
      createdAt: Date.now(),
    });
    return { ...state, trace: tree, compacting: true, openCompactNodeId: node.id };
  },

  /**
   * 压完了：整份换掉 messages，闭合 `compact` 节点（它推进 tip）。
   *
   * ## 为什么 `compact` 节点推进 tip
   *
   * 压缩之后的那条线是从摘要开始的，不是从被压掉的那段历史延续的。
   * 不推进 tip 的话，下一个 `user` 节点会挂在「压缩前最后一个节点」下面 ——
   * 树上看起来像是从旧历史里长出来的，而实际上中间已经换过内容了。
   * 这与 git 里 squash 一段历史之后接上新提交是同一个形状。
   *
   * ## 为什么 label 里带条数
   *
   * 「压掉了多少」是这个操作唯一值得看的信息：条数没降说明切点没找到
   * （可压的还不够），那就是个可疑的静默退化。
   */
  'compact.done': (state, action) => {
    const now = Date.now();
    const { reason, summarizedCount, keptCount, tokensBefore } = action;
    const why = compactReasonText(reason);
    let { trace } = state;
    // **就地改写**那个 pending 节点（不另开一个）：压这件事从头到尾就是一个节点，
    // 「开始压缩」与「压完了多少条」是同一件事的两个时刻。
    // 另开一个的话，树上会出现两个 compact 节点，而第二个才是结果 —— 读的人得猜哪个算数。
    //
    // 它从 pending 变成 ok，于是**推进 tip**（见上）。
    if (state.openCompactNodeId) {
      trace = patchNode(trace, state.openCompactNodeId, {
        status: 'ok',
        label: `${why}压缩：${summarizedCount} 条 → ${keptCount} 条`,
        detail: action.summary,
        meta: {
          reason,
          summarized: String(summarizedCount),
          kept: String(keptCount),
          tokensBefore: String(tokensBefore),
        },
        endedAt: now,
      });
    }
    return {
      ...state,
      trace,
      compacting: false,
      openCompactNodeId: null,
      messages: action.messages,
      // 摘要这次也花了 token：记进去，否则底栏的累计用量会比真实支出少一块。
      usage: action.usage ?? state.usage,
      totalCost: state.totalCost + (action.usage?.cost?.total ?? 0),
      lastCompaction: { reason, summarizedCount, keptCount, tokensBefore },
      // 压缩成功**不碰** error / stopReason / stopCause：它不是「一轮对话的结果」。
      // 上一轮为什么停的那句话与压缩无关，动它就是撒谎。
    };
  },

  /**
   * 压失败：把 pending 节点标成 error（对话一个字都没动）。
   *
   * 不推 `stopReason` / `stopCause`：压缩不是一轮对话，它不「结束」什么。
   * 但 `stopCause` 要写 —— 否则界面上只能显示一句干巴巴的 `error` 字符串。
   */
  'compact.failed': (state, action) => {
    const now = Date.now();
    let { trace } = state;
    if (state.openCompactNodeId) {
      trace = patchNode(trace, state.openCompactNodeId, { status: 'error', endedAt: now });
    }
    const { tree, node } = appendNode(trace, state.openCompactNodeId, 'error', {
      status: 'error',
      label: action.error,
      detail: action.error,
      meta: { kind: 'compact-error', cause: 'compact-error' },
      createdAt: now,
      endedAt: now,
    });
    return {
      ...state,
      trace: tree,
      compacting: false,
      openCompactNodeId: null,
      error: action.error,
      errorKind: null,
      errorNodeId: node.id,
      stopReason: null,
      stopCause: 'compact-error',
      stopCauseDetail: stopCauseText('compact-error'),
    };
  },

  /**
   * 清空对话（可选：换一个新会话 id）。
   *
   * 保留已装载的 prompt / model —— 它们是**会话级**的（这个内核用哪个模型、跟它说什么），
   * 不是这一轮对话的产物。换模型请走 `model.changed`，别混在这里。
   *
   * 带 `action.sessionId` 时轨迹树的 sessionId 也跟着换，于是落盘换到新文件；
   * 不带则沿用原 id（只清对话）—— 但那样之后的消者会追加进同一个文件，
   * 所以界面上的「新会话」都应该带上新 id。
   */
  'conversation.reset': (state, action) => {
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
      sessionId: action.sessionId ?? state.trace.sessionId,
      // 换会话不换工作目录（cwd 是内核启动时定的，恢复跳目录也不改）——
      // 但会话身份得带着走，否则 `state.session` 会被重建成 `process.cwd()`。
      cwd: state.session.cwd,
    });
    return {
      ...fresh,
      // 保留装载好的两块（会话级的，不是对话级的）。
      prompt: state.prompt,
      model: state.model,
      persistedSeq: state.persistedSeq,
    };
  },

  /**
   * 恢复历史：清对话 + 换会话 id + **一次**灌完整批消息。
   *
   * 结果与「`conversation.reset` + N 条 `session.restored`」完全一样，但只 dispatch 一次
   * —— 界面每 dispatch 一次就重渲染整段对话，逐条灌是 O(N²)，一条灌是 O(N)。
   *
   * 为什么 `conversation.reset` 的那些字段一个都不能少：轨迹树要换 id（于是换落盘文件）、
   * `persistedSeq` 要带过来（那条游标属于轨迹文件，不是这次对话的）。漏掉任一个，
   * 恢复之后发出去的第一句话要么写进旧轨迹文件、要么把旧轨迹重写一遍。
   *
   * 不动 `phase` / `trace`（除了换 id 之外）：这些消息是「上次发生的」，开新节点或推进 tip
   * 会把历史伪装成这一轮 —— 与 `session.restored` 同一个理由。
   *
   * ## 相位为什么要带着走（不能只靠 createInitialState）
   *
   * `createInitialState` 给的是 `idle`。如果恢复动作把相位一并清成 idle，而恢复之前环
   * 正在跑（比如「上一回合没结束就切会话」），那么：正在等 token 的那条流回来时看到
   * 相位是 idle → 当成过期丢弃；而新的输入又可以发出去 —— 于是**两处都跑**，
   * 消息流会交叉。
   *
   * 恢复历史在界面上确实要求相位是 idle（`/sessions` 里「上一回合没结束」会先拒绝），
   * 但那条守卫属于界面与内核的入口策略，不是这条迁移的职责 —— reducer 不该假设
   * 「没人会趁环在跑的时候恢复」。所以这里原样带着走。
   */
  'conversation.restored': (state, action) =>
    restoredConversationState(state, action.sessionId, action.messages),

  /**
   * 恢复历史 + **轨迹树**。
   *
   * 与 `conversation.restored` 只差一样东西：那棵树。共用同一个迁移体（见
   * `restoredConversationState`），避免两处各写一遍「哪些状态带着走」——
   * 那种重复的代价是：将来加了一项（比如 thinkingLevel），只改了一处，
   * 于是「有轨迹的恢复」与「没轨迹的恢复」行为不同，而症状极难归因。
   *
   * `traceBegun` 置真：树非空就说明这段会话**确实发过话**，而它是落盘器
   * 「要不要写」的判据（见 kernel.ts 的 `activeSink`）。若这里置假，
   * 恢复出来的树会被当成「还没开始」而**永远不落盘** —— 也就是恢复一次、
   * 进程一退，那段历史就只剩消息而没了轨迹。
   */
  'trace.restored': (state, action) => {
    const base = restoredConversationState(state, action.sessionId, action.messages);
    return {
      ...base,
      trace: action.trace,
      traceBegun: action.trace.order.length > 0,
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
 * 少了这一步，`step.start` 的迁移就不会跑，轨迹树上也就永远开不出 step 节点。
 *
 * ## **不能**包成 `Cmd.list`（曾经在这里踩了很久）
 *
 * `createAgentReducer` 收一个命令数组：长度为 1 走 `loop(state, cmd)`，
 * 大于 1 才走 `loop(state, Cmd.list(cmds))`。
 * 若本函数返回 `Cmd.list([...])` 而接线又把它当一个命令放回数组，
 * 就得到 `Cmd.list([Cmd.list([...])])` —— **嵌套的 LIST**。
 *
 * 而 redux-loop 的 `handleParallelList` 对**嵌套**的非 batch LIST 走这条分支：
 * `cmds.map(nested => executeCmdInternal(nested, ctx).then(r => Promise.all(r.map(wrappedDispatch))))`。
 * 内层 LIST 返回的 `[]` 于是既没被 dispatch 也没被报错 —— 那条 action **静默消失**。
 *
 * 症状极其隐蔽：reducer 迁移照跑（该开的节点都开了），只是链路在最后一步断掉，
 * 表现为「回合永远关不上 / 环再也不转」，而代码里找不到任何错误。
 * 这就是为什么这里写死**裸 Cmd**：打包是 `createAgentReducer` 的职责，不是接线的。
 */
function redispatch(action: AgentAction): CmdType {
  // **裸 Cmd，不能包成 `Cmd.list`**（注释在上一段的 doc 里）。
  return Cmd.action(action);
}

/** 开下一个 step：先 `step.start`（开容器），再 `agent.run`（真的调 LLM）。 */
function startStep(): CmdType {
  return Cmd.list([
    redispatch({ type: 'step.start' }),
    redispatch({ type: 'agent.run' }),
  ]);
}

/**
 * 从队列里取出一条待投递的输入，组装成 `queue.delivered`。
 *
 * 只在 reducer 说「该投递了」之后才调它 —— 它自己不判时机。
 * 队列头不存在时返回 null（调用方发不发都行，发一条空的是 bug）。
 */
function deliverQueued(steer: boolean, state: AgentState): CmdType | null {
  const queue = steer ? state.steerQueue : state.followUpQueue;
  const head = queue[0];
  if (head === undefined) return null;
  return redispatch({
    type: 'queue.delivered',
    text: head.text,
    content: head.content,
    as: steer ? 'steer' : 'followUp',
  });
}

/**
 * 回合真的收工了（相位已 idle）之后的一步：**把回合容器关上**。
 *
 * ## 为什么绕一圈
 *
 * 「关回合」对几乎所有路都是「从 effect 里回到 reducer」那个时刻才发生的
 * （llm.failed / llm.giveup / tool.batch.done 都是 Cmd.run 回来的）。
 * 而那时 `install()` enhancer 的 cmdsQueue 已经被外层 dispatch 取走 ——
 * 从那里 `redispatch` 出去的 action 没人冲刷，环就停在 idle 不再转。
 *
 * 所以这里**只**发一条 `turn.end`。它到达 reducer 时相位已是 idle，
 * 于是 `turn.end` 的迁移自己判断「要不要开下一回合」（有 followUp 就开），
 * 而那个判断是 reducer 做的 —— 接线不需要、也不应该在半路替它决定。
 */
/**
 * 回合真的收工了（相位已 idle）之后的一步：**把回合容器关上**。
 *
 * ## 为什么绕一圈（而不是在迁移里直接关）
 *
 * 「收工」对几乎所有路都是「从 effect 里回到 reducer」那个时刻才发生的
 * （llm.failed / llm.giveup / tool.batch.done 都是 Cmd.run 回来的）。
 * 而那时 `install()` enhancer 的 cmdsQueue 已经被外层 dispatch 取走 ——
 * 从那里 `redispatch` 出去的 action 没人冲刷，环就停在 idle 不再转。
 *
 * 所以这里**只**发一条 `turn.end`。它到达 reducer 时相位已是 idle，
 * 迁移会关掉容器、算出结局标签，**并且**顺手开下一个 followUp 回合。
 */
function closeTurn(): CmdType {
  // 裸 Cmd（不包 list）—— 理由见 `redispatch()` 的注释：包了会被
  // `Cmd.list([Cmd.list([...])])` 吞掉那条 action，而且不报错。
  return redispatch({ type: 'turn.end' });
}

/** 回合结束原因的人话版（与 stopCauseText 同风格，供 turn.end 标签用）。 */
function turnReasonText(reason: TurnEndReason): string {
  switch (reason) {
    case 'completed':
      return '模型说完了';
    case 'maxTurns':
      return '达到轮数上限';
    case 'aborted':
      return '用户中断';
    case 'interrupted':
      return '被新消息打断';
    case 'error':
      return '出错收工';
  }
}

/**
 * 从队列头取出一条待投递的输入（**不组装消息**，只是看一眼）。
 *
 * 真正的投递是 `queue.delivered`，由「投递点」那几行发出去。
 */
function peekQueued(steer: boolean, state: AgentState): QueuedInput | null {
  const queue = steer ? state.steerQueue : state.followUpQueue;
  return queue[0] ?? null;
}

export function loopWiring(table: {
  runAgent(text?: string): CmdType;
  runTools(calls: ToolCall[]): CmdType;
  /** 没有它就是「不支持压缩」：那条 action 不发任何 Cmd。 */
  runCompact?(): CmdType | undefined;
  markCompactReason?(reason: CompactReason): void;
}): Pick<
  ReducerEffects,
  | 'user.message'
  | 'turn.start'
  | 'turn.end'
  | 'step.start'
  | 'step.end'
  | 'agent.run'
  | 'queue.input'
  | 'queue.delivered'
  | 'llm.started'
  | 'llm.done'
  | 'llm.failed'
  | 'llm.giveup'
  | 'tool.call'
  | 'tool.batch.done'
  | 'compact.request'
> {
  return {
    /**
     * 新的一句用户消息 → 开回合容器 → 开第一步。
     *
     * 顺序要紧：`turn.start` 的迁移要先填上 `openTurnNodeId`，
     * `step.start` 才能挂到它下面（而不是挂到 user 节点上）。
     */
    'user.message': () => [redispatch({ type: 'turn.start' })],

    // turn.start 之后的起步：`step.start` 开容器，`agent.run` 真的调 LLM。
    //
    // 为什么不把 startStep() 写在 user.message 那行：queue.input 那条路径也要开回合
    // （它同样靠 turn.start 起步），把起步挂在 `turn.start` 上两条路径共用一处。
    //
    // **这也是为什么 user.message 那一行只发 turn.start**：若它同时发 agent.run，
    // turn.start 里的 startStep() 会再发一次 —— LLM 被调两遍，第二遍的结果
    // 直接覆盖第一遍，而轨迹树上就是两个 llm.result 兄弟。症状是「模型白答了一遍」。
    'turn.start': () => [startStep()],

    'turn.end': (_action, state) => {
      // **关回合之后还有可能继续**：followUp 的定义就是「模型说完了接着聊」。
      // 队列里有货就开一个新回合（`turn.start` 会自己带起 startStep），
      // 没有就真收工 —— 这时相位已是 idle，一条 Cmd 都不发。
      if (peekQueued(false, state) === null) return [];
      return [redispatch({ type: 'turn.start' })];
    },

    // step.start 只开容器；调 LLM 的 Cmd 在 startStep() 里与它一起发出。
    'step.start': () => [],

    // step.end 只改状态（关容器、totalSteps+1）。
    'step.end': () => [],

    'agent.run': (action) => [table.runAgent((action as { text?: string }).text)],

    /**
     * 队列里的消息进来。
     *
     * reducer 的迁移已经处理了「空闲 → 直接转成 user.message」那种情况 ——
     * 那种情况下它把相位拉到了 thinking 且回合容器尚未开，所以这里要补一个 `turn.start`
     * （它自己会带起 startStep）。
     *
     * 而「真的入队」时不需要发任何 Cmd：入队本身不干活，等投递点到了自然会发。
     *
     * 判据是**回合容器开没开**而不是相位 —— 空闲转 user.message 与真入队两种情况下
     * 相位都是 thinking，只有容器开没开能区分。
     */
    'queue.input': (_action, state) =>
      state.openTurnNodeId === null && state.phase !== 'idle'
        ? [redispatch({ type: 'turn.start' })]
        : [],

    /**
     * 投递完成后干什么，**取决于它是哪一列**（这是两者的唯一区别）：
     *
     * - `steer`：投递完**紧接着开下一步**。因为 steer 的投递点就是「工具跑完、
     *   下一次 LLM 调用前」—— 此刻模型还没看到新的话，必须马上跑一次。
     * - `followUp`：投递完**不开新回合**，而是先把刚开着的回合收尾。
     *   因为 followUp 的定义是「回合收工时才插」，它属于**下一个**回合；
     *   若不开新回合，那条消息就成了「说完了又冒出来一句话，却没人回」。
     *   开新回合的那一步由 wiring 的 `queue.input` 那行接（空队列入队 → 转 user.message
     *   → turn.start），不在这条里。
     */
    'queue.delivered': (action, state) => {
      const as = (action as { as: 'steer' | 'followUp' }).as;
      if (as === 'steer') return [startStep()];
      // followUp：**开启一个新回合**，由 `turn.start` 发出去。
      //
      // 容器为什么在这里（而不是接线里）：folllowUp 到达时通常**正有一个容器开着**
      // （它就是「刚说完话」那个回合），而 `turn.start` 的防重入守卫是「容器开着就返回」。
      // 接线不能自己关它（wiring 是纯函数，只发 Cmd）—— 所以关闭旧容器这件事
      // 已经写在 `queue.delivered` 的**迁移**里（见上面那段注释），到这里容器已空。
      //
      // 一串 followUp 会连着开好几个回合 —— 每投递一条就开一个，这是对的：
      // 它们本来就是「模型说完 → 我说一句 → 它再说」的每一轮。
      if (peekQueued(false, state) === null) return [];
      return [redispatch({ type: 'turn.start' })];
    },

    // 流开始前先发一条 action：UI 靠它把「正在生成」的点亮，而不是等第一个 delta。
    'llm.started': () => [],

    'llm.done': (action, state) => {
      // 注意：接线拿到的是**迁移后**的状态，而 llm.done 的迁移已经把相位推到了 calling-tools。
      // 所以这里不能用 'thinking' 判定（那会永远为假，工具就永远不跑）；
      // 也不能用 'idle'（llm.done 之后已经是 calling-tools 了）。
      // 该跑的判据是「这次确实带工具调用」，相位由 tool.call / runTools 自己去推进。
      const message = (action as { message: AssistantMessage }).message;
      const toolCalls = message.content.filter((c): c is ToolCall => c.type === 'toolCall');
      if (toolCalls.length > 0) {
        // 直接发 runTools（不是 redispatch）：工具 attempt 节点由 tool/start 的迁移开，
        // 而 tool/start 本来就是 runTools 内部 dispatch 的第一条 action。
        //
        // 为什么这里不用 redispatch 绕一圈：llm.done 是从 Cmd.run 的 successActionCreator 进来的，
        // 此时 install() enhancer 的 cmdsQueue 已经被外层 dispatch 取走，从这里再 dispatch 一个 action，
        // 它触发的 Cmd 没人冲刷 —— 环会停在 calling-tools。所以这一步老老实实发 Cmd。
        return [table.runTools(toolCalls)];
      }
      // **无工具 = 回合真的收工了**（迁移里已经把 step 关掉）。
      //
      // 队列里有货就不收工 —— 否则模型说完话就停下、用户输入的那句话永远没被看见。
      //
      // 判据是**队列**而不是相位：此时相位已是 idle，但 followUp 的意义就是
      // 「模型说完了接着聊」，若只看相位就会把这条消息永远留在队列里。
      if (peekQueued(true, state) !== null || peekQueued(false, state) !== null) {
        return [closeTurn()];
      }
      return [closeTurn()];
    },

    /**
     * 失败后要不要重试。reducer 已经判好了：`state.retrying` 为真就说明「可重试且还有次数」，
     * 并且它把相位留在了 thinking（所以环没闭合，waitForIdle 不会提前返回）。
     *
     * 这里补一个 step.start（它自带 agent.run），环就自己转起来了；新 step 会挂在
     * **同一个 turn 节点**下，因为失败没有推进 tip —— 树上于是长出一根分叉，
     * 和 git log --graph 一个形状。
     *
     * 不重试（重试用尽 / 不可重试）= 这一步结束。队列里有东西就继续，没有才关回合。
     */
    'llm.failed': (_action, state) => {
      if (state.retrying) return [startStep()];
      return [closeTurn()];
    },

    /**
     * 重试用尽（`llm.giveup`）。迁移里已经关了 step、留了 stop 节点，相位已回 idle。
     * 与 `llm.failed` 不重试时同一条路。
     */
    'llm.giveup': () => [closeTurn()],

    'tool.call': (action) => [table.runTools((action as { calls: ToolCall[] }).calls)],

    /**
     * 工具批次跑完 = **一个 step 结束**（迁移里已关容器）。接下来：
     *
     * 1. **steer 队列里有东西** → 投递它并立即开下一步（对齐 pi：「当前 step 的工具
     *    跑完后、下一次 LLM 调用前」）。这就是 steer 打断循环的地方。
     * 2. **撞轮数上限** → 收工，关回合。
     * 3. **否则** → 开下一步，让模型看到工具结果。
     *
     * 顺序要紧：steer 优先于「开下一步」。若先开下一步，模型会在**没看到**新话的情况下
     * 先跑一次 LLM —— 那条 steer 消息要等两轮才生效，与「立即插进来」的语义不符。
     */
    'tool.batch.done': (_action, state) => {
      // 撞轮数上限：迁移里已把相位推到 idle 并留了 stop 节点。收工，关回合。
      if (state.phase === 'idle') return [closeTurn()];
      const steer = peekQueued(true, state);
      if (steer !== null) {
        return [deliverQueued(true, state) ?? closeTurn()];
      }
      return [startStep()];
    },

    /**
     * 压缩上下文。
     *
     * **直接发 `runCompact()`，不绕一圈**：与 `llm.done` 里的工具同理由 ——
     * `llm.done` 是从 `Cmd.run` 的 successActionCreator 进来的，那时
     * `install()` enhancer 的 cmdsQueue 已经被外层 dispatch 取走，从这里再 dispatch
     * 一个 action，它触发的 Cmd 没人冲刷。而压缩的 pending 节点本来就由
     * `compact.request` 自己的迁移开好了（开在 effect 之前），不需要第二次 dispatch。
     *
     * **顺序：先 mark 再 run**：effect 里 `lastRequestedReason` 必须在读之前就位。
     */
    'compact.request': (action) => {
      // 没接内核（测试、另一个前端）：发一条 failed，而不是静默无反应 ——
      // 用户打了 /compact 却什么都没发生，比「不支持这个功能」糟糕得多。
      if (table.runCompact === undefined) {
        return [
          redispatch({
            type: 'compact.failed',
            error: '本内核不支持上下文压缩',
            reason: action.reason,
          }),
        ];
      }
      // **顺序：先 mark 再 run** —— effect 里的 lastRequestedReason 必须在读之前就位。
      //
      // 理由直接取 action 上的（必填）：它在 dispatch 那一刻就定下了，不在这里
      // 根据 state 重推一遍 —— 两处各推一次必然漂移，而漂移的后果是界面显示的
      // 理由与真正触发的原因不符（用户会据此排查错方向）。
      table.markCompactReason?.(action.reason);
      const run = table.runCompact();
      return run === undefined ? [] : [run];
    },
  };
}

/**
 * 「换一个已存在的会话」之后的基线状态。
 *
 * `conversation.restored` 与 `trace.restored` **共用**这一份，差别只在轨迹树
 * （前者空、后者带回读的那棵）。
 *
 * ## 为什么要抽出来而不是写两遍
 *
 * 这里列的是「换会话时**哪些东西要带着走**」——prompt、model、persistedSeq、
 * 以及正在跑的现场。这类清单**天然会变**（将来加一项），而两处各写一遍的代价是：
 * 只改了一处，于是「有轨迹的恢复」与「没轨迹的恢复」行为不同。
 * 那个症状（有时恢复有轨迹、有时没有）比「全都没有」难查得多。
 */
function restoredConversationState(
  state: AgentState,
  sessionId: string,
  messages: Message[],
): AgentState {
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
    sessionId,
    cwd: state.session.cwd,
  });
  return {
    ...fresh,
    // 会话级的三块带着走：换会话不等于换模型/系统提示。
    prompt: state.prompt,
    model: state.model,
    persistedSeq: state.persistedSeq,
    // 「正在跑」的现场也带着走（见 conversation.restored 的注释）。
    phase: state.phase,
    streamingText: state.streamingText,
    thinkingText: state.thinkingText,
    openLlmNodeId: state.openLlmNodeId,
    messages,
  };
}

export { transitions as _transitions };
