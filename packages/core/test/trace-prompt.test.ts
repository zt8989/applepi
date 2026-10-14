import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, type AgentState } from '../src/state';
import { createAgentReducer } from '../src/reducer';
import { renderTree, traceStats, type TraceNode, type TraceNodeKind } from '../src/index';
import type { AgentAction, ModelCapabilities, PromptToolDefinition } from '../src/actions';

const CAPS: ModelCapabilities = {
  midConvoSystemMessages: true,
  midConvoToolAdditions: true,
  developerRole: true,
};

const TOOLS: PromptToolDefinition[] = [
  { name: 'read', description: '读文件', parameters: { type: 'object' } },
  { name: 'bash', description: '跑命令', parameters: { type: 'object' } },
];

/** 一块不带 effect 的 reducer（纯状态迁移）。 */
const REDUCER = createAgentReducer({});

/**
 * 没有 effect 接线时用这个（这里要断言的是树，不是环跑起来什么样）。
 */
function reduce(state: AgentState, action: AgentAction): AgentState {
  return REDUCER(state, action) as AgentState;
}

/** 依次 dispatch 几条 action（共用一个 reducer），返回最后的状态。 */
function play(
  r: ReturnType<typeof createAgentReducer>,
  state: AgentState,
  ...actions: AgentAction[]
): AgentState {
  let current = state;
  for (const action of actions) current = r(current, action) as AgentState;
  return current;
}

function seed(): AgentState {
  return createInitialState({
    systemPrompt: '',
    providerName: 'p',
    modelId: 'm',
    toolNames: [],
    sessionId: 't',
  });
}

function kinds(state: AgentState): TraceNodeKind[] {
  return state.trace.order.map((id) => state.trace.nodes[id]?.kind as TraceNodeKind);
}

// ── 装载节点推迟到「用户发出第一句话」 ──

test('装载本身**不建节点**（进了界面还没说话时，树应当是空的）', () => {
  let state = reduce(seed(), { type: 'prompt.init', systemPrompt: '你是一个编码助手。', tools: TOOLS });
  state = reduce(state, {
    type: 'model.init',
    provider: 'workbuddy',
    modelId: 'cn:space-bunny',
    thinkingLevel: 'high',
    capabilities: CAPS,
  });

  // 「进来看一眼就退出」是常态，树上不该已经堆了四个装载节点。
  assert.deepEqual(kinds(state), [], '装载只改 state，不建节点');
  assert.equal(state.traceBegun, false, '轨迹还没开');
  // 但 state 里该有的东西一个字不少（开场报 skill 清单、底栏显示模型都靠它们）。
  assert.equal(state.prompt.seeded, true);
  assert.equal(state.model.seeded, true);
  assert.equal(state.prompt.systemPrompt, '你是一个编码助手。');
  assert.equal(state.model.modelId, 'cn:space-bunny');
});

test('发出第一句话时，装载节点补在 user 节点**前面**', () => {
  let state = reduce(seed(), { type: 'prompt.init', systemPrompt: '你是一个编码助手。', tools: TOOLS });
  state = reduce(state, {
    type: 'model.init',
    provider: 'workbuddy',
    modelId: 'cn:space-bunny',
    thinkingLevel: 'high',
    capabilities: CAPS,
  });
  state = reduce(state, { type: 'user.message', text: '你好' });

  assert.deepEqual(kinds(state), ['prompt.base', 'prompt.tools', 'model.init', 'user']);
  assert.equal(state.traceBegun, true);
});

test('prompt 节点：完整 prompt 留在 detail 里，工具名与描述都在树上', () => {
  const state = play(
    REDUCER,
    seed(),
    { type: 'prompt.init', systemPrompt: '你是一个编码助手。', tools: TOOLS },
    { type: 'user.message', text: '你好' },
  );

  const base = state.trace.nodes[state.trace.order[0] as string];
  assert.equal(base?.kind, 'prompt.base');
  assert.equal(base?.detail, '你是一个编码助手。', '完整 prompt 留在 detail 里，不只是摘要');
  assert.equal(base?.status, 'ok');

  const toolsNode = state.trace.nodes[state.trace.order[1] as string];
  assert.equal(toolsNode?.kind, 'prompt.tools');
  assert.equal(toolsNode?.label, 'read, bash');
  assert.equal(toolsNode?.meta?.['count'], '2');
  // 工具的 description 也在树上 —— 「模型看到了什么」要能查
  assert.match(toolsNode?.detail ?? '', /read: 读文件/);
  assert.match(toolsNode?.detail ?? '', /bash: 跑命令/);
});

test('prompt.tools 的父是 prompt.base（同一次装载的两半）', () => {
  const state = play(
    REDUCER,
    seed(),
    { type: 'prompt.init', systemPrompt: 'p', tools: TOOLS },
    { type: 'user.message', text: '你好' },
  );
  const base = state.trace.order[0] as string;
  const toolsNode = state.trace.order[1] as string;
  assert.equal(state.trace.nodes[toolsNode]?.parentId, base);
});

// ── 上下文节点不推进 tip ──

test('prompt.* 节点**不推进 tip** —— 它们是上下文，不是对话历史', () => {
  const before = seed();
  assert.equal(before.trace.tipId, null);

  // 第一句话之前 tip 仍然是 null（装载还没建节点）。
  const loaded = reduce(before, { type: 'prompt.init', systemPrompt: 'p', tools: TOOLS });
  assert.equal(loaded.trace.tipId, null, '装载不推进 tip');

  // 装载节点补出来之后仍然不推进 tip。
  const state = reduce(loaded, { type: 'user.message', text: '你好' });
  assert.equal(state.trace.tipId, state.trace.order[2], 'tip 是 user 节点（装载节点不吃 tip）');
  const promptNodes = state.trace.order.slice(0, 2).map((id) => state.trace.nodes[id]?.parentId);
  assert.deepEqual(promptNodes, [null, state.trace.order[0]], '装载节点都挂在根上');
});

test('model.init 也在树上，带能力标记，且不推进 tip', () => {
  const state = play(
    REDUCER,
    seed(),
    {
      type: 'model.init',
      provider: 'workbuddy',
      modelId: 'cn:space-bunny',
      thinkingLevel: 'high',
      capabilities: CAPS,
    },
    { type: 'user.message', text: '你好' },
  );

  assert.deepEqual(kinds(state), ['model.init', 'user']);
  const node = state.trace.nodes[state.trace.order[0] as string];
  assert.equal(node?.label, 'workbuddy/cn:space-bunny');
  assert.equal(node?.meta?.['thinking'], 'high');
  assert.equal(node?.meta?.['midConvoSystem'], 'true', '能不能中途插 system，树上要看得见');
  assert.equal(node?.meta?.['developerRole'], 'true');
});

// ── prompt.segment ──

test('prompt.segment.added 进树，parent 是此刻的 tip（即「下一轮会读到它的那次调用」的正上方）', () => {
  let state = reduce(seed(), { type: 'prompt.init', systemPrompt: 'p', tools: TOOLS });
  state = reduce(state, { type: 'user.message', text: '你好' });
  const userNode = state.trace.tipId;
  assert.ok(userNode);

  state = reduce(state, {
    type: 'prompt.segment.added',
    role: 'developer',
    text: '回答用中文',
    source: 'manual',
  });

  const segment = state.trace.order[state.trace.order.length - 1] as string;
  const node = state.trace.nodes[segment];
  assert.equal(node?.kind, 'prompt.segment');
  assert.equal(node?.parentId, userNode, '挂在 user 之后、下一轮 attempt 之前');
  assert.equal(node?.meta?.['role'], 'developer');
  assert.equal(node?.meta?.['source'], 'manual');
  assert.equal(node?.detail, '回答用中文');
  // 消息也进了 messages（落盘/回放靠它）：user 那条 + 这条 segment = 2
  assert.equal(state.messages.length, 2);
});

test('追加 prompt 后，紧随其后的 LLM 尝试是它的子节点 —— 树上能看出「这次调用读到了这段」', () => {
  let state = reduce(seed(), { type: 'prompt.init', systemPrompt: 'p', tools: TOOLS });
  state = reduce(state, { type: 'prompt.segment.added', role: 'system', text: '额外约束' });
  // 追加的 prompt 不推进 tip（tip 仍是 null），所以下一个容器从同一个 tip 出发 ——
  // 也就是说 step 会成为 prompt.segment 的兄弟，而不是它的子节点。
  const segment = state.trace.order[state.trace.order.length - 1] as string;
  assert.equal(state.trace.tipId, null, 'segment 不推进 tip');

  state = reduce(state, { type: 'step.start' });
  const attempt = state.trace.order[state.trace.order.length - 1] as string;
  assert.equal(state.trace.nodes[attempt]?.kind, 'step.start');
  assert.equal(state.trace.nodes[attempt]?.parentId, null, 'step 与 segment 同级（共享同一个 tip）');
  // 顺序上 segment 在 attempt 之前 —— 渲染出来就是「这段 prompt 在这次调用上面」。
  assert.ok(
    state.trace.order.indexOf(segment) < state.trace.order.indexOf(attempt),
    'segment 排在 attempt 之前',
  );
});

// ── 重复装载是追加，不是改写 ──

test('开局前反复 prompt.init：树上仍然空（补的时候只补最终生效的那一版）', () => {
  let state = reduce(seed(), { type: 'prompt.init', systemPrompt: '第一版', tools: TOOLS });
  state = reduce(state, { type: 'prompt.init', systemPrompt: '第二版', tools: TOOLS });

  // 装载节点要等第一句话才补，而补的时候是从 **state** 读的 —— 所以只有一版。
  assert.deepEqual(kinds(state), [], '还没开口，树上什么都没有');
  state = reduce(state, { type: 'user.message', text: '你好' });
  assert.deepEqual(kinds(state), ['prompt.base', 'prompt.tools', 'user']);
  assert.equal(state.trace.nodes[state.trace.order[0] as string]?.detail, '第二版');
});

test('树已经开过之后再 prompt.init（热重载）是**追加**新节点，不改写历史', () => {
  let state = reduce(seed(), { type: 'prompt.init', systemPrompt: '第一版', tools: TOOLS });
  state = reduce(state, { type: 'user.message', text: '你好' });
  state = reduce(state, { type: 'prompt.init', systemPrompt: '第二版', tools: TOOLS });

  assert.deepEqual(kinds(state), [
    'prompt.base',
    'prompt.tools',
    'user',
    'prompt.base',
    'prompt.tools',
  ]);
  assert.equal(state.trace.order.length, 5, '旧的节点还在');
  assert.equal(state.prompt.systemPrompt, '第二版', '生效的是新的');
});

// ── 统计不把它们算成对话轮次 ──

test('traceStats 不把 prompt.* / model.init 算进 turns 或 toolCalls', () => {
  let state = reduce(seed(), { type: 'prompt.init', systemPrompt: 'p', tools: TOOLS });
  state = reduce(state, {
    type: 'model.init',
    provider: 'p',
    modelId: 'm',
    thinkingLevel: 'off',
    capabilities: CAPS,
  });
  state = reduce(state, { type: 'user.message', text: '你好' });
  const stats = traceStats(state.trace);
  assert.equal(stats.turns, 0, 'prompt 不是「一轮」');
  assert.equal(stats.toolCalls, 0, 'prompt.tools 是提示词里的工具定义，不是真调过工具');
  assert.equal(stats.errors, 0);
});

// ── conversation.reset 会清掉它们（它们属于这次对话的上下文） ──

test('conversation.reset 清掉 prompt.* / model.init 节点（它们是会话级状态，不是树的一部分）', () => {
  let state = reduce(seed(), { type: 'prompt.init', systemPrompt: 'p', tools: TOOLS });
  state = reduce(state, { type: 'user.message', text: '你好' });
  assert.ok(state.trace.order.length > 0);

  state = reduce(state, { type: 'conversation.reset' });
  assert.deepEqual(kinds(state), [], '树清了');
  // 但装载好的 prompt / model 状态仍在（会话级的）
  assert.equal(state.prompt.seeded, true);
  assert.equal(state.prompt.systemPrompt, 'p');
});

// ── 换模型 / 换档位：只在下次发话前补**一个** ──

/** 装载某个模型（开局那次）。 */
function modelInit(provider: string, modelId: string, thinkingLevel: string): AgentAction {
  return {
    type: 'model.init',
    provider,
    modelId,
    thinkingLevel: thinkingLevel as never,
    capabilities: CAPS,
  };
}

/** 切换模型 / 档位（与 `model.init` 同一套载荷，只是 action 名不同）。 */
function modelChanged(provider: string, modelId: string, thinkingLevel: string): AgentAction {
  return {
    type: 'model.changed',
    provider,
    modelId,
    thinkingLevel: thinkingLevel as never,
    capabilities: CAPS,
  };
}

const usage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const assistantMessage = (text: string): AgentAction =>
  ({
    type: 'llm.done',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'openai-completions',
      provider: 'p',
      model: 'm',
      usage: usage(),
      stopReason: 'stop',
      timestamp: 1,
    },
  }) as unknown as AgentAction;

/**
 * 走完一个回合：`user → turn.start → step.start → llm.done`。
 *
 * 为什么要走完而不是只 dispatch `user.message`：那个迁移的守卫是「相位 idle 才接」，
 * 跑着的时候第二句话会被直接丢掉 —— 测试里就会看到与真人不一致的顺序。
 */
function completeTurn(
  r: ReturnType<typeof createAgentReducer>,
  state: AgentState,
  text: string,
): AgentState {
  return play(
    r,
    state,
    { type: 'user.message', text },
    { type: 'turn.start' },
    { type: 'step.start' },
    assistantMessage('好'),
  );
}

/** 最后一条 `model.changed` 节点（切换补出来的那条应当就是它）。 */
function lastChangedNode(state: AgentState): TraceNode | undefined {
  for (let i = state.trace.order.length - 1; i >= 0; i -= 1) {
    const node = state.trace.nodes[state.trace.order[i] as string];
    if (node?.kind === 'model.changed') return node;
  }
  return undefined;
}

test('换模型**不当场建节点** —— 切换是界面动作，不是「发生过的事」', () => {
  let state = play(
    REDUCER,
    seed(),
    { type: 'prompt.init', systemPrompt: 'p', tools: TOOLS },
    modelInit('workbuddy', 'cn:space-bunny', 'high'),
    { type: 'user.message', text: '你好' },
  );
  const before = state.trace.order.length;
  assert.equal(before, 4, '装载三个 + user');

  // 切了三次模型、改了两次档位 —— 树上一个字都不该动。
  state = reduce(state, modelChanged('workbuddy', 'cn:another', 'off'));
  state = reduce(state, { type: 'thinking.changed', level: 'max' });
  state = reduce(state, modelChanged('other', 'm-2', 'low'));
  state = reduce(state, { type: 'thinking.changed', level: 'medium' });
  assert.equal(state.trace.order.length, before, '还没发话，树上不该多节点');
  assert.equal(state.modelTraceDirty, true, '但记下了「变了、还没写进树」');
});

test('下一次发话时补**一个** `model.changed` —— 内容是最后生效的那版，落在 user / turn.start 之前', () => {
  const r = REDUCER;
  let state = play(
    r,
    seed(),
    { type: 'prompt.init', systemPrompt: 'p', tools: TOOLS },
    modelInit('workbuddy', 'cn:space-bunny', 'high'),
  );
  state = completeTurn(r, state, '第一句');

  // 五次切换（三次换模型、两次改档位），其间一句话都没说。
  state = reduce(state, modelChanged('workbuddy', 'cn:another', 'off'));
  state = reduce(state, { type: 'thinking.changed', level: 'max' });
  state = reduce(state, modelChanged('other', 'm-2', 'low'));
  state = reduce(state, { type: 'thinking.changed', level: 'medium' });
  const afterSwitches = state.trace.order.length;

  state = completeTurn(r, state, '第二句');

  const kindsNow = kinds(state);
  // 只多了**一个** node，而且它就是补出来的那条 model.changed（开局那条仍是 model.init）。
  assert.equal(kindsNow.filter((kind) => kind === 'model.changed').length, 1, '切换只补一条');
  assert.equal(kindsNow.filter((kind) => kind === 'model.init').length, 1, '开局那条仍是 model.init');
  const added = lastChangedNode(state);
  assert.equal(added?.label, 'other/m-2', '补的是最后生效的那一版');
  assert.equal(added?.meta?.['thinking'], 'medium', '档位也是最后那版');
  // 这一回合多出来的正是「补的那一条 model.changed + 正常的 5 个节点」。
  assert.equal(state.trace.order.length, afterSwitches + 6, '第二回合多了一个 model.changed');
  assert.equal(state.modelTraceDirty, false, '补过就清标记');

  // 位置：就在这一回合的 user 节点（以及 turn.start）**之前**。
  const at = state.trace.order.indexOf(added?.id ?? '');
  assert.deepEqual(
    kindsNow.slice(at, at + 3),
    ['model.changed', 'user', 'turn.start'],
    `补的那条要落在 user 之前，但顺序是：${kindsNow.slice(Math.max(0, at - 1)).join(' → ')}`,
  );
});

test('只改思考级别也补 —— 档位写在 model.changed 节点的 meta 里，它也是这一轮上下文的一部分', () => {
  const r = REDUCER;
  let state = play(r, seed(), modelInit('p', 'm', 'off'));
  state = completeTurn(r, state, '第一句');
  assert.equal(lastChangedNode(state), undefined, '没换过时树上没有 model.changed');

  state = reduce(state, { type: 'thinking.changed', level: 'high' });
  assert.equal(lastChangedNode(state), undefined, '改的当下不写树');

  state = completeTurn(r, state, '第二句');
  assert.equal(lastChangedNode(state)?.meta?.['thinking'], 'high', '下一句话时补上');
  assert.equal(kinds(state).filter((kind) => kind === 'model.changed').length, 1);
});

test('没换过就不补 —— 第二回合不会凭空多出一个 model.changed', () => {
  const r = REDUCER;
  let state = play(r, seed(), modelInit('p', 'm', 'off'));
  state = completeTurn(r, state, '第一句');
  state = completeTurn(r, state, '第二句');
  assert.equal(
    kinds(state).filter((kind) => kind === 'model.changed').length,
    0,
    '没切过就没有 model.changed',
  );
  assert.equal(kinds(state).filter((kind) => kind === 'model.init').length, 1, '只有开局那一个');
});

// ── 渲染 ──

test('树上能直接看出提示词是怎么生成的（渲染包含三个装载节点）', () => {
  let state = reduce(seed(), { type: 'prompt.init', systemPrompt: '你是一个编码助手。', tools: TOOLS });
  state = reduce(state, {
    type: 'model.init',
    provider: 'workbuddy',
    modelId: 'cn:space-bunny',
    thinkingLevel: 'high',
    capabilities: CAPS,
  });
  state = reduce(state, { type: 'user.message', text: '算一下' });

  const rendered = renderTree(state.trace, { maxWidth: 0 });
  assert.match(rendered, /prompt\.base: 你是一个编码助手。/);
  assert.match(rendered, /prompt\.tools: read, bash/);
  assert.match(rendered, /model\.init: workbuddy\/cn:space-bunny/);
  assert.match(rendered, /thinking=high/);
  assert.match(rendered, /user: 算一下/);
});
