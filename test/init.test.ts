import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createKernel } from '../src/kernel';
import { createInitialState, type AgentState } from '../src/state';
import { createAgentReducer } from '../src/reducer';
import { applyMiddleware, promptSegmentMiddleware, type ActionMiddleware } from '../src/middleware';
import { loadSession } from '../src/trace-file';
import { findFileById } from '../src/config-home';
import { traceStats } from '../src/trace';
import type { AgentAction, ModelCapabilities, PromptToolDefinition } from '../src/actions';

const CAPS: ModelCapabilities = {
  midConvoSystemMessages: true,
  midConvoToolAdditions: false,
  developerRole: true,
};

/**
 * 轨迹目录里某个会话**实际的**文件名。
 *
 * 轨迹文件名现在是 `<时间戳>_<id>.jsonl`（与 pi 的会话文件同名规则），
 * 所以不能再手拼 `<id>.jsonl`。`findFileById` 也认旧名，所以两种形状都能找到。
 */
function findTraceName(dir: string, id: string): string {
  const file = findFileById(dir, id);
  assert.ok(file, `轨迹文件 ${id} 应该在 ${dir} 里`);
  return path.basename(file);
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

// ─── 进入会话不建节点：推迟到用户发出第一句话 ───

test('进来看一眼就退出：树上 0 个节点，traces/ 里也不会有文件', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'idle-'));
  try {
    const kernel = await createKernel({
      provider: 'deepseek',
      systemPrompt: '你是测试助手',
      cwd: dir,
      demo: true,
      sessionId: 'idle-1',
      traceDir: dir,
    });
    try {
      const state = kernel.store.getState();
      assert.equal(state.trace.order.length, 0, '装载不建节点（切到轨迹页不该是一屏提示词）');
      assert.equal(state.traceBegun, false);
      // 但 state 里该有的东西一个字不少：开场报 skill 清单、底栏显示模型都靠它们。
      assert.equal(state.prompt.seeded, true);
      // prompt 现在是 **pi 拼的整段**，而传了 `systemPrompt` 就是走 `customPrompt` 那一路 ——
      // 官方语义是「顶掉默认前缀」，所以**只剩 preamble + cwd**（tools/rules/docs 那几段
      // 属于默认前缀的一部分）。不给 customPrompt 时才有那几段。
      assert.ok(
        state.prompt.systemPrompt.startsWith('你是测试助手'),
        `前言应是传进来的那句。实际开头：${state.prompt.systemPrompt.slice(0, 120)}`,
      );
      assert.ok(
        state.prompt.systemPrompt.includes('<cwd>'),
        'cwd 段总是有（官方无条件加）',
      );
      assert.equal(state.prompt.tools.length > 0, true);
      assert.equal(state.model.seeded, true);
    } finally {
      kernel.dispose();
    }
    // 等一下 flush（落盘器是异步写文件的）。
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(
      (await readdir(dir)).filter((f) => f.endsWith('.jsonl')),
      [],
      '没发过一句话的会话不该在盘上留文件（与会话文件那边同一个决定）',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('发出第一句话：装载节点补在前面，init 记录与轨迹一起落盘', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'begin-'));
  try {
    const kernel = await createKernel({
      provider: 'deepseek',
      systemPrompt: '你是测试助手',
      cwd: dir,
      demo: true,
      sessionId: 'begin-1',
      traceDir: dir,
    });
    kernel.store.dispatch({ type: 'user.message', text: '算一下 (3+4)*6' } as AgentAction);
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const s = kernel.store.getState();
      if (s.phase === 'idle' && s.turns > 0) break;
    }
    try {
      const kinds = kernel.store
        .getState()
        .trace.order.map((id) => kernel.store.getState().trace.nodes[id]?.kind);
      assert.deepEqual(
        kinds.slice(0, 4),
        ['prompt.base', 'prompt.tools', 'model.init', 'user'],
        '装载节点排在 user 节点前面（渲染出来就是「这次调用带着什么 prompt」）',
      );
      assert.equal(kernel.store.getState().traceBegun, true);
    } finally {
      kernel.dispose();
      await new Promise((r) => setTimeout(r, 300));
    }

    // 落盘：文件里 init 记录与 add 记录都有，回放照样零 token 复现。
    const session = await loadSession('begin-1', dir);
    assert.ok(session, '发了话就有文件了');
    assert.ok(
      session.init.prompt?.systemPrompt.startsWith('你是测试助手'),
      '回放读到的是**当时拼好的那一整段**（不是 customPrompt 的原文）',
    );
    assert.ok(session.init.model, 'model.init 也在');
    assert.ok(session.init.prompt && session.init.prompt.tools.length > 0, '工具完整定义也在');
    assert.deepEqual(
      (session.messages as { role: string }[]).map((m) => m.role),
      ['user', 'assistant', 'toolResult', 'assistant'],
      '消息链完整重建',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('init 记录只写一份（不会因为落盘器多冲几轮而重复）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'once-'));
  try {
    const kernel = await createKernel({
      provider: 'deepseek',
      systemPrompt: 'p',
      cwd: dir,
      demo: true,
      sessionId: 'once-1',
      traceDir: dir,
    });
    // 连着问三句（每一句都会让落盘器冲好几轮：delta、tool.result…）。
    for (const text of ['第一句', '第二句', '第三句']) {
      kernel.store.dispatch({ type: 'user.message', text } as AgentAction);
      for (let i = 0; i < 60; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
        const s = kernel.store.getState();
        if (s.phase === 'idle' && s.turns > 0) break;
      }
    }
    kernel.dispose();
    await new Promise((r) => setTimeout(r, 300));

    const raw = await readFile(path.join(dir, findTraceName(dir, 'once-1')), 'utf8');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l) as { op: string });
    assert.equal(
      lines.filter((l) => l.op === 'prompt.init').length,
      1,
      'prompt.init 记录只有一条（回放取最后一条，但重复就是垃圾行）',
    );
    assert.equal(lines.filter((l) => l.op === 'model.init').length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('恢复历史不补第二份 init 记录（那个会话的文件里已经有了）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'restore-init-'));
  try {
    const first = await createKernel({
      provider: 'deepseek',
      systemPrompt: 'p',
      cwd: dir,
      demo: true,
      sessionId: 'hist-1',
      traceDir: dir,
    });
    first.store.dispatch({ type: 'user.message', text: '旧的第一句' } as AgentAction);
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const s = first.store.getState();
      if (s.phase === 'idle' && s.turns > 0) break;
    }
    first.dispose();
    await new Promise((r) => setTimeout(r, 300));

    const traceFile = path.join(dir, findTraceName(dir, 'hist-1'));
    const before = await readFile(traceFile, 'utf8');

    const second = await createKernel({
      provider: 'deepseek',
      systemPrompt: 'p',
      cwd: dir,
      demo: true,
      sessionId: 'cur-1',
      traceDir: dir,
    });
    try {
      second.restoreSession(traceFile);
      await new Promise((r) => setTimeout(r, 300));
      const after = await readFile(traceFile, 'utf8');
      assert.equal(
        after.trim().split('\n').filter((l) => l.includes('"op":"prompt.init"')).length,
        1,
        '恢复不补 init（那个会话当初已经写过了）',
      );
      assert.equal(after, before, '恢复本身不往那个文件里追加任何东西');
    } finally {
      second.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── 端到端：装载落盘 + 零 token 回放 ───

test('端到端：装载与对话都落盘，回放时零 token 复现', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'init-'));
  try {
    const kernel = await createKernel({
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

    // 一个 loadSession 就够了：装载段、对话消息、轨迹树都在同一个文件里。
    const session = await loadSession('sess-init', dir);
    assert.ok(session, '会话在');

    // 装载段读回
    const init = session.init;
    assert.ok(init.prompt, 'prompt.init 在');
    assert.ok(
      init.prompt.systemPrompt.startsWith('你是测试助手'),
      `落盘的 prompt 是拼好的那一整段。实际开头：${init.prompt.systemPrompt.slice(0, 120)}`,
    );
    assert.deepEqual(
      init.prompt.tools.map((t) => t.name),
      ['read', 'write', 'edit', 'bash'],
      '工具的完整定义都在（回放不必重装配）',
    );
    assert.ok(init.prompt.tools[0]?.description, '连 description 一起落盘');
    assert.ok(init.model, 'model.init 在');
    assert.equal(init.model.provider, 'faux');
    assert.ok(init.model.capabilities, '能力也落盘（回放不必再问 provider）');

    // 装载段不再单独一个文件 —— 它就在同一个轨迹文件里。
    // （以前每个会话占两个 jsonl，一半内容还是重复的。）
    const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    assert.equal(files.length, 1, '一个会话只应该有一个 jsonl（不该再有 .init.jsonl）');
    assert.ok(
      files[0]?.endsWith('_sess-init.jsonl') || files[0] === 'sess-init.jsonl',
      `文件名应当是 <时间戳>_sess-init.jsonl（实际：${files[0]}）`,
    );
    const raw = await readFile(path.join(dir, files[0] ?? ''), 'utf8');
    assert.ok(
      raw.includes('"op":"prompt.init"') && raw.includes('"op":"model.init"'),
      '装载记录就在这个文件里（位置无所谓：回放按 op 类型收集，与行序无关）',
    );

    // 对话 + 轨迹读回（同一个 loadSession 的结果）
    assert.deepEqual(
      (session.messages as { role: string }[]).map((m) => m.role),
      ['user', 'assistant', 'toolResult', 'assistant'],
      '消息链完整重建 —— 零 token 就能复现这一轮',
    );
    const stats = traceStats(session.tree);
    // turns 数的是**回合**（turn.start 的个数），不是 LLM 调用次数 ——
    // 这一段只有一个回合（一条用户消息），模型在里面跑了两步。
    assert.equal(stats.turns, 1, '一个回合');
    assert.equal(stats.steps, 2, '两步 = 两次 LLM 调用');
    assert.equal(stats.toolCalls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('回放出的树与内存里的一致（tip 相同）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'replay-'));
  try {
    const kernel = await createKernel({
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
