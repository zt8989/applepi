import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInitialState, type AgentState } from '../src/state';
import { createAgentReducer } from '../src/reducer';
import { createSessionRecorder } from '../src/session-recorder';
import {
  createSessionHeader,
  readSession,
  readSessionMessages,
  SessionWriter,
  sessionTitle,
} from '../src/session-file';
import { configHome, encodeCwd, listSessions, findFileById } from '../src/config-home';
import type { AgentAction } from '../src/actions';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';

/**
 * 会话文件（`sessions/<cwd>/<id>.jsonl`）：格式与 pi 一致，用于「恢复历史」。
 *
 * 全部测试把 `PI_CODING_AGENT_DIR` 指到临时目录，绝不碰真实的 `~/.redux-agent`。
 */

/** 在一个隔离的配置家目录里跑 fn。 */
async function withHome(fn: (home: string) => Promise<void> | void): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'redux-home-'));
  const previous = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = dir;
  try {
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const userMessage = (text: string): Message =>
  ({ role: 'user', content: text, timestamp: 1 }) as Message;

const assistantMessage = (text: string): AssistantMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'p',
    model: 'm',
    usage,
    stopReason: 'stop',
    timestamp: 1,
  }) as unknown as AssistantMessage;

// ── 目录编码 ──

test('encodeCwd：与 pi 同样的规则（`--` 包起来，/ \\ : 变 -）', () => {
  // 注意 `C:` 与紧跟的 `\` 各自变一个 `-`，所以是 `C--` —— pi 的代码跑出来也一样。
  assert.equal(encodeCwd('C:\\Users\\me\\proj'), '--C--Users-me-proj--', 'Windows 路径');
  assert.equal(encodeCwd('/home/me/proj'), '--home-me-proj--', 'POSIX 路径');
  assert.equal(encodeCwd('/a/b'), '--a-b--');
});

// ── 写与读 ──

test('会话文件：首行是 pi 形状的 header，其后每行一条 entry', async () => {
  await withHome(async (home) => {
    const f = path.join(home, 's.jsonl');
    const w = new SessionWriter('s1', 'C:\\proj');
    w.start(createSessionHeader({ id: 's1', cwd: 'C:\\proj' }));
    w.appendMessage(userMessage('第一句'));
    w.appendMessage(assistantMessage('答一句'));

    const raw = await readFile(f.replace(/s\.jsonl$/, 's1.jsonl'), 'utf8').catch(() => '');
    void raw;
    // 用 SessionWriter 自己的路径读（它算过 encodeCwd）
    const lines = (await readFile(w.path, 'utf8')).split('\n').filter(Boolean);
    const header = JSON.parse(lines[0] as string) as Record<string, unknown>;
    assert.equal(header['type'], 'session');
    assert.equal(header['id'], 's1');
    assert.equal(header['cwd'], 'C:\\proj');
    assert.equal(typeof header['timestamp'], 'string');

    const first = JSON.parse(lines[1] as string) as Record<string, unknown>;
    assert.equal(first['type'], 'message');
    assert.equal(first['id'], 'e1');
    assert.equal(first['parentId'], null, '第一条没有父');

    const second = JSON.parse(lines[2] as string) as Record<string, unknown>;
    assert.equal(second['id'], 'e2');
    assert.equal(second['parentId'], 'e1', '串成链（pi 用它做 session tree）');
  });
});

test('读回来：message 条目按顺序取出，header 不算消息', async () => {
  await withHome(async () => {
    const w = new SessionWriter('s2', '/proj');
    w.start();
    w.appendMessage(userMessage('甲'));
    w.appendMessage(assistantMessage('乙'));
    w.appendModelChange('workbuddy', 'cn:space-bunny');
    w.appendMessage(userMessage('丙'));

    const messages = readSessionMessages(w.path);
    assert.deepEqual(
      messages.map((m) => m.role),
      ['user', 'assistant', 'user'],
      '只取 message 条目（model_change 那种不算）',
    );

    const session = readSession(w.path);
    assert.ok(session);
    assert.equal(session.header.id, 's2');
    assert.equal(session.entries.length, 4, 'entries 含非 message 条目');
    // 追加顺序：user(msg) assistant(msg) model_change user(msg) —— 第 3 条才是 model_change。
    assert.equal(session.entries[2]?.['type'], 'model_change');
  });
});

test('崩溃截断的尾行不让整个会话读不出来', async () => {
  await withHome(async () => {
    const w = new SessionWriter('s3', '/proj');
    w.start();
    w.appendMessage(userMessage('完整的一条'));
    const text = await readFile(w.path, 'utf8');
    await writeFile(w.path, `${text}{"type":"message","id":"e2","mess`, 'utf8');

    const messages = readSessionMessages(w.path);
    assert.equal(messages.length, 1, '坏行跳过，好的那条还在');
    assert.equal(messages[0]?.role, 'user');
  });
});

// ── 空会话不建文件 ──

test('只 start() 不 append：**不建文件**（免得 sessions/ 里全是空壳）', async () => {
  await withHome(async () => {
    const w = new SessionWriter('empty', '/proj');
    w.start();
    // 没有 append
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(w.path), false, '没写消息就不该有文件');

    // 第一条消息到了才落盘
    w.appendMessage(userMessage('有了'));
    assert.equal(existsSync(w.path), true);
  });
});

test('listSessions 的 entries 数的是**消息**数，不含 header', async () => {
  await withHome(async () => {
    const w = new SessionWriter('s4', '/proj');
    w.start();
    w.appendMessage(userMessage('一'));
    w.appendMessage(assistantMessage('二'));

    const list = listSessions();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, 's4');
    assert.equal(list[0]?.entries, 2, '2 条消息（不是 3 行）');
  });
});

// ── 标题 ──

test('sessionTitle 取第一句用户消息', async () => {
  await withHome(async () => {
    const w = new SessionWriter('s5', '/proj');
    w.start();
    w.appendMessage(assistantMessage('先说话的是助手'));
    w.appendMessage(userMessage('用户说的第一句\n后面还有'));
    assert.equal(sessionTitle(w.path), '用户说的第一句', '只取第一行');
  });
});

// ── 记录器：接在 store 上 ──

test('记录器：每条消息只写一次（不会因为流式更新重复写）', async () => {
  await withHome(async () => {
    const reducer = createAgentReducer({});
    let state: AgentState = createInitialState({
      systemPrompt: 'p',
      providerName: 'p',
      modelId: 'm',
      toolNames: [],
      sessionId: 'rec1',
    });
    let notify: (() => void) | null = null;
    const dispatch = (a: AgentAction): void => {
      state = reducer(state, a) as AgentState;
      notify?.();
    };
    const store = {
      getState: () => state,
      subscribe: (l: () => void) => {
        notify = l;
        return () => {
          notify = null;
        };
      },
      dispatch,
    };
    const rec = createSessionRecorder(store, { sessionId: 'rec1', cwd: '/proj', enabled: true });
    assert.ok(rec);

    dispatch({ type: 'user.message', text: '一问' });
    // 模拟流式：多次 delta 不改 messages，不该重复写
    dispatch({ type: 'llm.delta', delta: 'a' });
    dispatch({ type: 'llm.delta', delta: 'b' });
    dispatch({ type: 'llm.done', message: assistantMessage('一答') });
    rec?.dispose();

    assert.equal(rec?.written(), 2, '只有两条消息');
    const messages = readSessionMessages(rec.file);
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant']);
  });
});

test('记录器：resumeFrom 让恢复的会话**不重写**已有消息', async () => {
  await withHome(async () => {
    // 先造一个有 2 条消息的会话
    const w = new SessionWriter('r1', '/proj');
    w.start();
    w.appendMessage(userMessage('旧的甲'));
    w.appendMessage(assistantMessage('旧的乙'));

    // 恢复：把这些消息灌回一个 store，并告诉记录器「已有 2 条」
    const reducer = createAgentReducer({});
    let state: AgentState = createInitialState({
      systemPrompt: 'p',
      providerName: 'p',
      modelId: 'm',
      toolNames: [],
      sessionId: 'r1',
    });
    let notify: (() => void) | null = null;
    const dispatch = (a: AgentAction): void => {
      state = reducer(state, a) as AgentState;
      notify?.();
    };
    const store = {
      getState: () => state,
      subscribe: (l: () => void) => {
        notify = l;
        return () => {
          notify = null;
        };
      },
      dispatch,
    };
    const rec = createSessionRecorder(store, {
      sessionId: 'r1',
      cwd: '/proj',
      enabled: true,
      resumeFrom: 2, // ← 关键
    });
    assert.ok(rec);

    // 恢复两条旧消息
    dispatch({ type: 'session.restored', message: userMessage('旧的甲') });
    dispatch({ type: 'session.restored', message: assistantMessage('旧的乙') });
    // 再发一条新的
    dispatch({ type: 'user.message', text: '新的丙' });
    rec?.dispose();

    const messages = readSessionMessages(rec.file);
    assert.deepEqual(
      messages.map((m) => (m as { content: unknown }).content),
      ['旧的甲', [{ type: 'text', text: '旧的乙' }], '新的丙'],
      '两条旧的在文件里各只有一份，新的追加在后',
    );
    // 文件里 entry id 不能撞
    const session = readSession(rec.file);
    const ids = session?.entries.map((e) => e.id) ?? [];
    assert.equal(new Set(ids).size, ids.length, 'entry id 不重复');
  });
});

test('writeSession=false：完全不建会话文件', async () => {
  await withHome(async () => {
    const state = createInitialState({
      systemPrompt: 'p',
      providerName: 'p',
      modelId: 'm',
      toolNames: [],
      sessionId: 'x',
    });
    const store = {
      getState: () => state,
      subscribe: () => () => {},
      dispatch: () => undefined,
    };
    const rec = createSessionRecorder(store, { sessionId: 'x', cwd: '/proj', enabled: false });
    assert.equal(rec, null, '关掉就是 null，不留半吊子对象');
  });
});

// ── session.restored：零 token 恢复 ──

test('session.restored 只加消息，**不动相位也不动轨迹树**', () => {
  const reducer = createAgentReducer({});
  let state: AgentState = createInitialState({
    systemPrompt: 'p',
    providerName: 'p',
    modelId: 'm',
    toolNames: [],
    sessionId: 't',
  });
  state = reducer(state, { type: 'prompt.init', systemPrompt: 'p', tools: [] }) as AgentState;
  const nodesBefore = state.trace.order.length;
  const phaseBefore = state.phase;

  state = reducer(state, { type: 'session.restored', message: userMessage('历史消息') }) as AgentState;

  assert.equal(state.messages.length, 1, '消息进去了');
  assert.equal(state.phase, phaseBefore, '相位不动（历史不是「正在跑」）');
  assert.equal(state.trace.order.length, nodesBefore, '轨迹树不动（历史属于那一轮）');
});

// ── conversation.restored：一次 dispatch 恢复整批（恢复必须**快**） ──

test('conversation.restored：一次 dispatch 灌完整批（逐条灌是 O(N²) 重渲染）', () => {
  const reducer = createAgentReducer({});
  let state: AgentState = createInitialState({
    systemPrompt: 'p',
    providerName: 'p',
    modelId: 'm',
    toolNames: [],
    sessionId: 'old',
  });
  state = reducer(state, { type: 'user.message', text: '当前会话的对话' }) as AgentState;
  const phaseBefore = state.phase;

  const history = [userMessage('旧的甲'), assistantMessage('旧的乙'), userMessage('旧的丙')];
  let dispatches = 0;
  const counted = (a: AgentAction): AgentState => {
    dispatches += 1;
    return reducer(state, a) as AgentState;
  };
  state = counted({ type: 'conversation.restored', sessionId: 'restored', messages: history });

  assert.equal(dispatches, 1, '恢复整批只 dispatch 一次');
  assert.deepEqual(
    state.messages.map((m) => m.role),
    ['user', 'assistant', 'user'],
    '整批按原顺序进了 messages',
  );
  assert.equal(state.trace.sessionId, 'restored', '恢复也换会话 id（之后的消息写进那个文件）');
  assert.equal(
    state.phase,
    phaseBefore,
    '相位**带着走**（不重置成 idle）：万一环正在跑，清成 idle 会让那条流回来时被当过期丢弃',
  );
  assert.equal(state.trace.sessionId, 'restored', '恢复也换会话 id（之后的消息写进那个文件）');
  assert.equal(state.trace.order.length, 0, '轨迹树换成新的空树（落盘换文件，不混上一轮的节点）');
});

test('conversation.restored 与「逐条版」状态等价（除了刻意换掉的 sessionId）', () => {
  const reducer = createAgentReducer({});
  const history = [userMessage('甲'), assistantMessage('乙'), userMessage('丙')];
  const mk = (): AgentState =>
    createInitialState({
      systemPrompt: 'p',
      providerName: 'p',
      modelId: 'm',
      toolNames: [],
      sessionId: 'old',
    });

  // 旧路：conversation.reset（不带 id）+ 逐条 session.restored。
  let old = mk();
  old = reducer(old, { type: 'conversation.reset' }) as AgentState;
  for (const message of history) {
    old = reducer(old, { type: 'session.restored', message }) as AgentState;
  }

  const now = reducer(mk(), {
    type: 'conversation.restored',
    sessionId: 'old',
    messages: history,
  }) as AgentState;

  assert.deepEqual(now.messages, old.messages, 'messages 完全一致');
  assert.equal(now.phase, old.phase, '相位一致');
  assert.equal(now.persistedSeq, old.persistedSeq, '轨迹落盘游标要带着走（别把旧轨迹重写一遍）');
});

// ── 开新会话：必须换文件 ──

test('conversation.reset 带 sessionId 时轨迹树也换 id（于是换文件）', () => {
  const reducer = createAgentReducer({});
  let state: AgentState = createInitialState({
    systemPrompt: 'p',
    providerName: 'p',
    modelId: 'm',
    toolNames: [],
    sessionId: 'old',
  });
  state = reducer(state, { type: 'user.message', text: '旧对话' }) as AgentState;
  assert.equal(state.trace.sessionId, 'old');

  state = reducer(state, { type: 'conversation.reset', sessionId: 'brand-new' }) as AgentState;

  assert.equal(state.trace.sessionId, 'brand-new', '树的 id 跟着换（落盘才会换文件）');
  assert.equal(state.messages.length, 0, '对话清空');
  assert.equal(state.trace.order.length, 0, '轨迹清空');
});

test('conversation.reset 不带 sessionId：沿用原 id（只清对话）', () => {
  const reducer = createAgentReducer({});
  let state: AgentState = createInitialState({
    systemPrompt: 'p',
    providerName: 'p',
    modelId: 'm',
    toolNames: [],
    sessionId: 'keep-me',
  });
  state = reducer(state, { type: 'conversation.reset' }) as AgentState;
  assert.equal(state.trace.sessionId, 'keep-me');
});

test('内核 newSession：换 id、清对话、保留装载的 prompt / model', async () => {
  await withHome(async () => {
    const { createKernel } = await import('../src/kernel');
    const kernel = await createKernel({
      provider: 'deepseek',
      systemPrompt: '装载过的 prompt',
      cwd: '/proj',
      demo: true,
      sessionId: 'first',
      traceDir: null, // 这个测试只关心会话文件
    });
    try {
      assert.equal(kernel.sessionId, 'first');
      const created = kernel.newSession();

      assert.notEqual(created.id, 'first', '换了 id');
      assert.equal(kernel.sessionId, created.id, '内核上的 id 也换');
      assert.equal(kernel.store.getState().messages.length, 0, '对话清空');
      assert.equal(kernel.store.getState().prompt.seeded, true, 'prompt 保留（会话级）');
      assert.ok(
        kernel.store.getState().systemPrompt.startsWith('装载过的 prompt'),
        'prompt 保留（它是拼好的那一整段，开头是传进来的前言）',
      );
      assert.equal(kernel.store.getState().model.seeded, true, 'model 保留');
    } finally {
      kernel.dispose();
    }
  });
});

test('开新会话后，两段对话落在**两个文件**里（旧的不被续写）', async () => {
  await withHome(async () => {
    const { createKernel } = await import('../src/kernel');
    const kernel = await createKernel({
      provider: 'deepseek',
      systemPrompt: 'p',
      cwd: '/proj',
      demo: true,
      sessionId: 'para1',
      traceDir: null,
    });
    try {
      kernel.store.dispatch({ type: 'user.message', text: '第一段' });
      await new Promise((r) => setTimeout(r, 50));
      const second = kernel.newSession();
      kernel.store.dispatch({ type: 'user.message', text: '第二段' });
      await new Promise((r) => setTimeout(r, 50));

      const dir = sessionPathIn('/proj');
      const file1 = findFileById(dir, 'para1');
      const file2 = findFileById(dir, second.id);
      assert.ok(file1, '第一段的文件应该建出来了');
      assert.ok(file2, '新会话的文件应该建出来了');
      const text1 = await readFile(file1, 'utf8');
      const text2 = await readFile(file2, 'utf8');

      assert.ok(text1.includes('第一段'), '第一段在自己的文件里');
      assert.ok(
        !text1.includes('第二段'),
        '第一段那文件里**没有**第二段 —— 这正是修掉的 bug（以前会续写进去）',
      );
      assert.ok(text2.includes('第二段'), '第二段在新文件里');
      assert.ok(!text2.includes('第一段'));
    } finally {
      kernel.dispose();
    }
  });
});

/**
 * 算某个 cwd 的会话目录（与 config-home 同一规则）。
 *
 * 必须先 `path.resolve`：内核建会话时是把 cwd 解析过的（Windows 上 `/proj` → `C:\proj`），
 * 不解析就会算出另一个目录 —— 我第一版就是这样，测试去错误的路径找文件。
 */
function sessionPathIn(cwd: string): string {
  return path.join(configHome(), 'sessions', encodeCwd(path.resolve(cwd)));
}

// ── 记录器：换模型这件事本身也要落盘 ──

test('记录器：换模型会写一条 model_change（之前那个字段声明了但没人调）', async () => {
  // 这条盯的是一个**已存在**的静默退化：`SessionRecorderOptions.onModelChange` 早先是
  // 声明了却**没有任何调用方传它**，于是「这段对话中途换了模型」这个事实从来没进过
  // 会话文件。症状是恢复历史时看到一串消息，却不知道中间哪一段用的哪个模型 ——
  // 而「换模型」在界面 上是有明确反馈的（底栏变了），所以那一段对不上时特别难查。
  await withHome(async () => {
    const reducer = createAgentReducer({});
    let state: AgentState = createInitialState({
      systemPrompt: 'p',
      providerName: 'workbuddy',
      modelId: 'cn:space-bunny',
      toolNames: [],
      sessionId: 'mc1',
    });
    let notify: (() => void) | null = null;
    const dispatch = (a: AgentAction): void => {
      state = reducer(state, a) as AgentState;
      notify?.();
    };
    const store = {
      getState: () => state,
      subscribe: (l: () => void) => {
        notify = l;
        return () => {
          notify = null;
        };
      },
      dispatch,
    };
    const rec = createSessionRecorder(store, { sessionId: 'mc1', cwd: '/proj', enabled: true });
    assert.ok(rec);

    // 先说一句话（于是 header 与第一条消息落盘 —— 那个「空会话不建文件」的规则）。
    dispatch({ type: 'user.message', text: '第一句' });
    // 换模型：与 `kernel.setModel()` 发同样的两条 action。
    dispatch({ type: 'model.changed', provider: 'workbuddy', modelId: 'cn:deepseek-v4.1-flash' });
    dispatch({
      type: 'model.init',
      provider: 'workbuddy',
      modelId: 'cn:deepseek-v4.1-flash',
      thinkingLevel: 'off',
      capabilities: { midConvoSystemMessages: false, midConvoToolAdditions: false, developerRole: false },
      contextWindow: 0,
    });
    // 流式更新不该重复写 —— 订阅器每帧都跑，不去重的话会写出几百条 model_change。
    dispatch({ type: 'llm.delta', delta: 'x' });
    dispatch({ type: 'llm.delta', delta: 'y' });
    rec?.dispose();

    const session = readSession(rec.file);
    assert.ok(session);
    const changes = session.entries.filter((e) => e.type === 'model_change');
    assert.equal(changes.length, 1, `只该有一条 model_change，实际 ${changes.length}：${JSON.stringify(changes)}`);
    assert.equal(changes[0]?.modelId, 'cn:deepseek-v4.1-flash');
    assert.equal(changes[0]?.provider, 'workbuddy');
  });
});

test('记录器：没换模型时不写 model_change（不能每帧补一条）', async () => {
  // 与上一条同一个机制的反面：不换就不该有任何 model_change。
  // 漏了去重的话，这个文件会按帧增长 —— 而它恰好是「打开面板要扫」的那些文件之一。
  await withHome(async () => {
    const reducer = createAgentReducer({});
    let state: AgentState = createInitialState({
      systemPrompt: 'p',
      providerName: 'workbuddy',
      modelId: 'cn:space-bunny',
      toolNames: [],
      sessionId: 'mc2',
    });
    let notify: (() => void) | null = null;
    const dispatch = (a: AgentAction): void => {
      state = reducer(state, a) as AgentState;
      notify?.();
    };
    const store = {
      getState: () => state,
      subscribe: (l: () => void) => {
        notify = l;
        return () => {
          notify = null;
        };
      },
      dispatch,
    };
    const rec = createSessionRecorder(store, { sessionId: 'mc2', cwd: '/proj', enabled: true });
    assert.ok(rec);
    dispatch({ type: 'user.message', text: '一句话' });
    for (let i = 0; i < 50; i += 1) dispatch({ type: 'llm.delta', delta: 'z' });
    rec.dispose();
    const session = readSession(rec.file);
    assert.ok(session);
    assert.equal(
      session.entries.filter((e) => e.type === 'model_change').length,
      0,
      '没换模型就不该有 model_change',
    );
  });
});
