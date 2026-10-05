import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createKernel } from '../src/kernel';
import { createInitialState, type AgentState } from '../src/state';
import { createAgentReducer } from '../src/reducer';
import { applyMiddleware, promptSegmentMiddleware, type ActionMiddleware } from '../src/middleware';
import { loadInit, loadSession } from '../src/trace-file';
import { traceStats } from '../src/trace';
import type { AgentAction, ModelCapabilities, PromptToolDefinition } from '../src/actions';

const CAPS: ModelCapabilities = {
  midConvoSystemMessages: true,
  midConvoToolAdditions: false,
  developerRole: true,
};

function seed(): AgentState {
  return createInitialState({
    systemPrompt: '',
    providerName: 'p',
    modelId: 'm',
    toolNames: [],
    sessionId: 't',
  });
}

function reducer(): (s: AgentState, a: AgentAction) => AgentState {
  const r = createAgentReducer({});
  return (s, a) => r(s, a) as AgentState;
}

// ─── prompt 侧装载 ───

test('prompt.init：装载 system prompt 与工具的**完整定义**（不只名字）', () => {
  const reduce = reducer();
  const tools: PromptToolDefinition[] = [
    { name: 'read', description: '读文件', parameters: { type: 'object' } },
    { name: 'bash', description: '跑命令', parameters: { type: 'object' } },
  ];
  const state = reduce(seed(), { type: 'prompt.init', systemPrompt: '你是…', tools });

  assert.equal(state.prompt.seeded, true);
  assert.equal(state.prompt.systemPrompt, '你是…');
  // 完整定义在 state 里 —— 回放不必重装配工具
  assert.equal(state.prompt.tools.length, 2);
  assert.equal(state.prompt.tools[0]?.description, '读文件');
  assert.deepEqual(state.prompt.tools[1]?.parameters, { type: 'object' });
  // 扁平别名同步
  assert.equal(state.systemPrompt, '你是…');
  assert.deepEqual(state.toolNames, ['read', 'bash']);
});

test('prompt.init 之前 seeded=false（回放据此判断 init 段读到没有）', () => {
  assert.equal(seed().prompt.seeded, false);
});

// ─── model 侧装载 ───

test('model.init：装载 provider / model / thinkingLevel / 能力，四项都在', () => {
  const state = reducer()(seed(), {
    type: 'model.init',
    provider: 'deepseek',
    modelId: 'deepseek-v4',
    thinkingLevel: 'high',
    capabilities: CAPS,
  });

  assert.equal(state.model.seeded, true);
  assert.equal(state.model.provider, 'deepseek');
  assert.equal(state.model.modelId, 'deepseek-v4');
  assert.equal(state.model.thinkingLevel, 'high');
  assert.deepEqual(state.model.capabilities, CAPS);
  // 扁平别名同步
  assert.equal(state.providerName, 'deepseek');
  assert.equal(state.thinkingLevel, 'high');
});

test('model.init 与 prompt.init 互不干扰：两块独立装载', () => {
  const reduce = reducer();
  let state = reduce(seed(), { type: 'prompt.init', systemPrompt: 'P', tools: [] });
  state = reduce(state, {
    type: 'model.init',
    provider: 'x',
    modelId: 'y',
    thinkingLevel: 'low',
    capabilities: CAPS,
  });
  // prompt 那次装载的还在
  assert.equal(state.prompt.systemPrompt, 'P');
  assert.equal(state.prompt.seeded, true);
  assert.equal(state.model.seeded, true);

  // 反过来：只装 model 不动 prompt
  const bare = reduce(seed(), {
    type: 'model.init',
    provider: 'x',
    modelId: 'y',
    thinkingLevel: 'off',
    capabilities: CAPS,
  });
  assert.equal(bare.prompt.seeded, false);
});

// ─── 中途插入 system / developer ───

test('prompt.segment.added：落进 messages，所以会被一起落盘、一起回放', () => {
  const reduce = reducer();
  let state = reduce(seed(), { type: 'prompt.init', systemPrompt: 'base', tools: [] });
  state = reduce(state, {
    type: 'prompt.segment.added',
    role: 'developer',
    text: '额外约束：回答用中文',
    source: 'manual',
  });

  assert.equal(state.messages.length, 1);
  const message = state.messages[0] as { role: string; content: string; source?: string };
  assert.equal(message.role, 'developer', 'developer role 原样保留');
  assert.equal(message.content, '额外约束：回答用中文');
  assert.equal(message.source, 'manual');
});

test('中途插入不影响基础 prompt —— 它是 messages 的一部分，不是替换', () => {
  const reduce = reducer();
  let state = reduce(seed(), { type: 'prompt.init', systemPrompt: 'base', tools: [] });
  state = reduce(state, { type: 'prompt.segment.added', role: 'system', text: '追加的' });
  assert.equal(state.prompt.systemPrompt, 'base', '基础 prompt 没被改');
  assert.equal(state.messages.length, 1, '追加的那条在 messages 里');
});

// ─── 换模型 / 换思考级别 ───

test('model.changed：能力先保守清掉，等新的 model.init 补上', () => {
  const reduce = reducer();
  let state = reduce(seed(), {
    type: 'model.init',
    provider: 'a',
    modelId: 'x',
    thinkingLevel: 'off',
    capabilities: CAPS,
  });
  state = reduce(state, { type: 'model.changed', provider: 'b', modelId: 'y' });

  assert.equal(state.model.provider, 'b');
  assert.equal(state.model.modelId, 'y');
  // 能力不能沿用 —— 新模型可能不支持中途插
  assert.equal(state.model.capabilities.midConvoSystemMessages, false);

  // 补上新的能力
  state = reduce(state, {
    type: 'model.init',
    provider: 'b',
    modelId: 'y',
    thinkingLevel: 'off',
    capabilities: CAPS,
  });
  assert.equal(state.model.capabilities.midConvoSystemMessages, true);
});

test('thinking.changed：model 块与扁平别名一起更新', () => {
  const state = reducer()(seed(), { type: 'thinking.changed', level: 'max' });
  assert.equal(state.model.thinkingLevel, 'max');
  assert.equal(state.thinkingLevel, 'max');
});

// ─── 装载是会话级的，reset 不该清掉 ───

test('conversation.reset：清对话但**保留**已装载的 prompt / model', () => {
  const reduce = reducer();
  let state = reduce(seed(), { type: 'prompt.init', systemPrompt: 'base', tools: [
    { name: 'read', description: 'd', parameters: {} },
  ] });
  state = reduce(state, {
    type: 'model.init',
    provider: 'p',
    modelId: 'm',
    thinkingLevel: 'high',
    capabilities: CAPS,
  });
  state = reduce(state, { type: 'user.message', text: '你好' });
  assert.equal(state.messages.length, 1);

  state = reduce(state, { type: 'conversation.reset' });

  assert.equal(state.messages.length, 0, '对话清了');
  assert.equal(state.prompt.seeded, true, 'prompt 装载保留');
  assert.equal(state.prompt.tools.length, 1);
  assert.equal(state.model.seeded, true, 'model 装载保留');
  assert.equal(state.model.thinkingLevel, 'high', '思考级别也保留');
});

// ─── middleware：洋葱语义 ───

test('middleware：before 正序、after 逆序（洋葱）', () => {
  const order: string[] = [];
  const make = (name: string): ActionMiddleware => ({
    name,
    before: () => {
      order.push(`${name}:前`);
      return null;
    },
    after: () => {
      order.push(`${name}:后`);
    },
  });

  // before 返回 null 会丢弃，所以这里用一个不改写的 middleware
  const passthrough = (name: string): ActionMiddleware => ({
    name,
    before: (action) => {
      order.push(`${name}:前`);
      return action;
    },
    after: () => {
      order.push(`${name}:后`);
    },
  });

  void make;
  const state = seed();
  applyMiddleware(
    [passthrough('外'), passthrough('中'), passthrough('内')],
    { type: 'thinking.changed', level: 'low' },
    state,
    () => state,
  );

  assert.deepEqual(order, [
    '外:前',
    '中:前',
    '内:前',
    '内:后',
    '中:后',
    '外:后',
  ]);
});

test('middleware：before 返回 null 就丢弃这条 action（reducer 与 after 都不跑）', () => {
  const reduce = reducer();
  let ran = false;
  const drop: ActionMiddleware = {
    name: 'drop',
    before: () => null,
    after: () => {
      ran = true;
    },
  };

  const before = seed();
  const result = applyMiddleware(
    [drop],
    { type: 'user.message', text: 'x' },
    before,
    (action) => reduce(before, action),
    () => undefined,
  );

  assert.equal(result, before, '状态没变');
  assert.equal(result.messages.length, 0, 'reducer 没跑');
  assert.equal(ran, false, 'after 也没跑');
  assert.equal(result, before, '状态没变');
  assert.equal(result.messages.length, 0, 'reducer 没跑');
});

test('middleware：before 能改写 action', () => {
  const reduce = reducer();
  const rewrite: ActionMiddleware = {
    name: 'rewrite',
    before: (action) =>
      action.type === 'user.message' ? { ...action, text: `${action.text}（已改写）` } : action,
  };

  const from = seed();
  const result = applyMiddleware(
    [rewrite],
    { type: 'user.message', text: '原文' },
    from,
    (action) => reduce(from, action),
    () => undefined,
  );
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0]?.content, '原文（已改写）');
});

test('middleware：promptSegmentMiddleware 在 user.message 之后追加一段 prompt', () => {
  const reduce = reducer();
  const dispatched: AgentAction[] = [];
  const from = seed();
  const state = applyMiddleware(
    [promptSegmentMiddleware({ promptSource: 'test-hook' })],
    { type: 'user.message', text: '你好' },
    from,
    (action) => reduce(from, action),
    (a) => dispatched.push(a),
  );

  // reducer 正常跑了
  assert.equal(state.messages.length, 1);
  // 且额外 dispatch 了一条 prompt.segment.added
  assert.equal(dispatched.length, 1);
  const action = dispatched[0] as Extract<AgentAction, { type: 'prompt.segment.added' }>;
  assert.equal(action.type, 'prompt.segment.added');
  assert.equal(action.source, 'test-hook');
  // 不给 promptSource 就不动作（默认内核）
  const none: AgentAction[] = [];
  applyMiddleware(
    [promptSegmentMiddleware({})],
    { type: 'user.message', text: 'x' },
    seed(),
    (action) => reduce(from, action),
    (a) => none.push(a),
  );
  assert.equal(none.length, 0);
});

// ─── 端到端：装载落盘 + 零 token 回放 ───

test('端到端：装载与对话都落盘，回放时零 token 复现', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'init-'));
  try {
    const kernel = createKernel({
      provider: 'deepseek',
      systemPrompt: '你是测试助手',
      cwd: dir,
      demo: true,
      sessionId: 'sess-init',
      traceDir: dir,
      llmTimeoutMs: 20_000,
    });
    try {
      kernel.store.dispatch({ type: 'user.message', text: '算一下 (3+4)*6' });
      for (let i = 0; i < 60; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
        const s = kernel.store.getState();
        if (s.phase === 'idle' && s.turns > 0) break;
      }
    } finally {
      // dispose 会 flush 两个 sink
      kernel.dispose();
      await new Promise((r) => setTimeout(r, 200));
    }

    // 装载段读回
    const init = await loadInit('sess-init', dir);
    assert.ok(init, 'init 段在');
    assert.ok(init.prompt, 'prompt.init 在');
    assert.equal(init.prompt.systemPrompt, '你是测试助手');
    assert.deepEqual(
      init.prompt.tools.map((t) => t.name),
      ['read', 'write', 'edit', 'bash'],
      '工具的完整定义都在（回放不必重装配）',
    );
    assert.ok(init.prompt.tools[0]?.description, '连 description 一起落盘');
    assert.ok(init.model, 'model.init 在');
    assert.equal(init.model.provider, 'faux');
    assert.ok(init.model.capabilities, '能力也落盘（回放不必再问 provider）');

    // 对话 + 轨迹读回
    const session = await loadSession('sess-init', dir);
    assert.ok(session, '会话在');
    assert.deepEqual(
      (session.messages as { role: string }[]).map((m) => m.role),
      ['user', 'assistant', 'toolResult', 'assistant'],
      '消息链完整重建 —— 零 token 就能复现这一轮',
    );
    const stats = traceStats(session.tree);
    assert.equal(stats.turns, 2);
    assert.equal(stats.toolCalls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('回放出的树与内存里的一致（tip 相同）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'replay-'));
  try {
    const kernel = createKernel({
      provider: 'deepseek',
      systemPrompt: 'p',
      cwd: dir,
      demo: true,
      sessionId: 'r',
      traceDir: dir,
    });
    kernel.store.dispatch({ type: 'user.message', text: '算一下 (3+4)*6' });
    for (let i = 0; i < 60; i += 1) {
      await new Promise((res) => setTimeout(res, 100));
      const s = kernel.store.getState();
      if (s.phase === 'idle' && s.turns > 0) break;
    }
    const tip = kernel.store.getState().trace.tipId;
    kernel.dispose();
    await new Promise((r) => setTimeout(r, 200));

    const session = await loadSession('r', dir);
    assert.ok(session);
    assert.equal(session.tree.tipId, tip, 'HEAD 一致');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('回放跳过崩溃截断的半行', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'crash-'));
  try {
    await readFile; // 触发一次 fs 加载，确保 node 环境
    const { writeFile } = await import('node:fs/promises');
    const file = path.join(dir, 'c.jsonl');
    await writeFile(
      file,
      [
        JSON.stringify({
          op: 'message',
          message: { role: 'user', content: '第一条' },
        }),
        '{"op":"message","mess', // 崩溃截断
      ].join('\n'),
      'utf8',
    );
    const session = await loadSession('c', dir);
    assert.ok(session);
    assert.equal(session.messages.length, 1, '只恢复完整的那一行');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
