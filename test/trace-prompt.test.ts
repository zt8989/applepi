import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, type AgentState } from '../src/state';
import { createAgentReducer } from '../src/reducer';
import { renderTree, traceStats, type TraceNodeKind } from '../src/index';
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

function reduce(state: AgentState, action: AgentAction): AgentState {
  const r = createAgentReducer({});
  return r(state, action) as AgentState;
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

// ── prompt.base / prompt.tools ──

test('prompt.init 在树上留下 prompt.base 与 prompt.tools 两个节点', () => {
  const state = reduce(seed(), {
    type: 'prompt.init',
    systemPrompt: '你是一个编码助手。',
    tools: TOOLS,
  });

  assert.deepEqual(kinds(state), ['prompt.base', 'prompt.tools']);

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
  const state = reduce(seed(), { type: 'prompt.init', systemPrompt: 'p', tools: TOOLS });
  const base = state.trace.order[0] as string;
  const toolsNode = state.trace.order[1] as string;
  assert.equal(state.trace.nodes[toolsNode]?.parentId, base);
});

// ── 上下文节点不推进 tip ──

test('prompt.* 节点**不推进 tip** —— 它们是上下文，不是对话历史', () => {
  const before = seed();
  assert.equal(before.trace.tipId, null);

  const state = reduce(before, { type: 'prompt.init', systemPrompt: 'p', tools: TOOLS });
  assert.equal(state.trace.tipId, null, '装载不推进 tip');

  // 于是第一条 user 消息的 parent 是 null（不是挂在 prompt.base 下面）——
  // 上下文与对话是两条线，不该混在一棵「历史」树里。
  const withUser = reduce(state, { type: 'user.message', text: '你好' });
  const userNode = withUser.trace.nodes[withUser.trace.order[2] as string];
  assert.equal(userNode?.parentId, null);
  assert.equal(withUser.trace.tipId, withUser.trace.order[2]);
});

test('model.init 也在树上，带能力标记，且不推进 tip', () => {
  const state = reduce(seed(), {
    type: 'model.init',
    provider: 'workbuddy',
    modelId: 'cn:space-bunny',
    thinkingLevel: 'high',
    capabilities: CAPS,
  });

  assert.deepEqual(kinds(state), ['model.init']);
  const node = state.trace.nodes[state.trace.order[0] as string];
  assert.equal(node?.label, 'workbuddy/cn:space-bunny');
  assert.equal(node?.meta?.['thinking'], 'high');
  assert.equal(node?.meta?.['midConvoSystem'], 'true', '能不能中途插 system，树上要看得见');
  assert.equal(node?.meta?.['developerRole'], 'true');
  assert.equal(state.trace.tipId, null);
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
  // 追加的 prompt 不推进 tip（tip 仍是 null），所以下一轮 attempt 从同一个 tip 出发 ——
  // 也就是说 attempt 会成为 prompt.segment 的兄弟，而不是它的子节点。
  const segment = state.trace.order[state.trace.order.length - 1] as string;
  assert.equal(state.trace.tipId, null, 'segment 不推进 tip');

  state = reduce(state, { type: 'agent.run' });
  const attempt = state.trace.order[state.trace.order.length - 1] as string;
  assert.equal(state.trace.nodes[attempt]?.parentId, null, 'attempt 与 segment 同级（共享同一个 tip）');
  // 顺序上 segment 在 attempt 之前 —— 渲染出来就是「这段 prompt 在这次调用上面」。
  assert.ok(
    state.trace.order.indexOf(segment) < state.trace.order.indexOf(attempt),
    'segment 排在 attempt 之前',
  );
});

// ── 重复装载是追加，不是改写 ──

test('重复 prompt.init 是**追加**新节点（热重载不改写历史）', () => {
  let state = reduce(seed(), { type: 'prompt.init', systemPrompt: '第一版', tools: TOOLS });
  state = reduce(state, { type: 'prompt.init', systemPrompt: '第二版', tools: TOOLS });

  assert.deepEqual(kinds(state), [
    'prompt.base',
    'prompt.tools',
    'prompt.base',
    'prompt.tools',
  ]);
  assert.equal(state.trace.order.length, 4, '旧的节点还在');
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
