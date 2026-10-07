import { Cmd, loop, type CmdType, type LoopReducer } from 'redux-loop';
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import type { AgentAction, AgentActionType, ModelCapabilities } from './actions';
import {
  createInitialState,
  isRetryable,
  stopCauseText,
  type AgentState,
  type LlmErrorKind,
  type StopCause,
} from './state';
import { appendNode, patchNode, type TraceNode, type TraceTree } from './trace';
import { compactReasonText, type CompactReason } from './compact';
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
  cause: StopCause,
): AgentState {
  // effect 若带了自己的 nodeId（它知道自己开的是哪个 attempt），以它为准。
  const openId = nodeId ?? state.openLlmNodeId;
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
function appendModelNode(tree: TraceTree, model: AgentState['model'], now: number): TraceTree {
  const caps = model.capabilities;
  // 能力逐条写进 meta：树上就能一眼看出「这个模型能不能中途插 system」。
  return appendNode(tree, tree.tipId, 'model.init', {
    status: 'ok',
    label: `${model.provider}/${model.modelId}`,
    meta: {
      thinking: String(model.thinkingLevel),
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
  if (state.model.seeded) tree = appendModelNode(tree, state.model, now);
  return tree;
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
 * 四个节点（Ctrl+T 一打开就是一屏提示词与工具名），并且 `traces/<id>.jsonl` 立刻被建出来。
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
      timestamp: now,
      ...(action.source !== undefined ? { source: action.source } : {}),
    } as Message;
    // 也进轨迹树：追加 prompt 是「上下文变了」，树上要看得见它插在哪个 attempt 之前。
    // parent 取此刻的 tip —— 于是它就落在「下一轮会读它的那次调用」的正上方。
    const { tree } = appendNode(state.trace, state.trace.tipId, 'prompt.segment', {
      status: 'ok',
      label: summarize(action.text),
      detail: action.text,
      meta: {
        role: action.role,
        ...(action.source !== undefined ? { source: action.source } : {}),
      },
      createdAt: now,
      endedAt: now,
    });
    return { ...state, trace: tree, messages: [...state.messages, message] };
  },

  // ── model 侧装载 ──

  /**
   * 装载模型：provider / model / 思考级别 + 这个模型支持什么。
   *
   * 能力随 init 一起落盘：回放时不必再问 provider「这个模型能不能中途插 system」。
   *
   * 与 `prompt.init` 同一个理由（见那条的注释）：开局那次**不开**轨迹节点，
   * 那一个 `model.init` 节点由 `beginTrace()` 在第一条用户消息时补上；
   * 已经开过树（换模型）则当场追加一个新节点，旧的不改写。
   */
  'model.init': (state, action) => {
    const model = {
      provider: action.provider,
      modelId: action.modelId,
      thinkingLevel: action.thinkingLevel,
      capabilities: action.capabilities,
      contextWindow: action.contextWindow ?? 0,
      seeded: true,
    };
    return {
      ...state,
      trace: state.traceBegun ? appendModelNode(state.trace, model, Date.now()) : state.trace,
      model,
      // 扁平别名跟着更新。
      providerName: action.provider,
      modelId: action.modelId,
      thinkingLevel: action.thinkingLevel,
    };
  },

  'user.message': (state, action) => {
    if (state.phase !== 'idle') return state;
    const now = Date.now();
    // 有附件时 content 是一组 text/image 块；否则就是纯文本。
    const message: Message = {
      role: 'user',
      content: action.content ?? action.text,
      timestamp: now,
    };
    // **先补装载节点、再开 user 节点** —— 顺序就是它们在树上的顺序，
    // 于是渲染出来是「这次调用带着什么 prompt」在「用户说了什么」上面。
    //
    // 这一步就是「进入会话不建节点，发了第一句话才建」：内核一装配时树上还是空的
    // （prompt.init / model.init 只改 state），到这里才第一次有节点。
    const withInit = beginTrace(state, now);
    // 用户节点是一棵新树的根，并且推进 tip —— 后面所有的 LLM 尝试都挂在它下面。
    const { tree, node } = appendNode(withInit, withInit.tipId, 'user', {
      status: 'ok',
      label: summarize(action.text),
      detail: action.text,
      createdAt: now,
      endedAt: now,
    });
    return {
      ...state,
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
      // 有工具 = 这一轮还没完（要接着跑下一轮 LLM），所以不是「停」。
      // 无工具 = 模型自己说完了，这才是真正的收工。
      stopReason: toolCalls.length > 0 ? null : 'completed',
      // 正常收工的原因也记一份：界面不必再猜「completed」是被砍的还是真说完。
      stopCause: toolCalls.length > 0 ? null : 'completed',
      stopCauseDetail: toolCalls.length > 0 ? null : stopCauseText('completed'),
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
    const { tree } = appendNode(state.trace, state.trace.tipId, 'stop', {
      status: 'ok',
      label: action.error,
      detail: action.error,
      // 跟错误节点一样把 cause 记进 meta：树上就能看出「用户主动停了」而不是「模型坏了」。
      meta: { kind: action.kind, cause },
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
        error: `已达单回合轮数上限（${state.maxTurns} 轮 LLM 调用），停止。`,
        errorKind: null,
        // 「没出错，是被上限砍的」—— 界面靠它把这种情况和真失败区分开（见 StopReason）。
        stopReason: 'maxTurns',
        stopCause: 'maxTurns',
        stopCauseDetail: stopCauseText('maxTurns'),
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
   * 不是这一轮对话的产物。换模型请走 `model.changed` + `model.init`，别混在这里。
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
  'conversation.restored': (state, action) => {
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
      sessionId: action.sessionId,
    });
    return {
      ...fresh,
      // 会话级的三块带着走：换会话不等于换模型/系统提示。
      prompt: state.prompt,
      model: state.model,
      persistedSeq: state.persistedSeq,
      // 「正在跑」的现场也带着走（见上面的注释）。
      phase: state.phase,
      streamingText: state.streamingText,
      thinkingText: state.thinkingText,
      openLlmNodeId: state.openLlmNodeId,
      messages: action.messages,
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
  /** 没有它就是「不支持压缩」：那条 action 不发任何 Cmd。 */
  runCompact?(): CmdType | undefined;
  markCompactReason?(reason: CompactReason): void;
}): Pick<
  ReducerEffects,
  | 'user.message'
  | 'agent.run'
  | 'llm.started'
  | 'llm.done'
  | 'llm.failed'
  | 'tool.call'
  | 'tool.batch.done'
  | 'compact.request'
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

export { transitions as _transitions };
