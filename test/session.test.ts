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
import { configHome, encodeCwd, listSessions } from '../src/config-home';
import type { AgentAction } from '../src/actions';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';

/**
 * 会话文件（`sessions/<cwd>/<id>.jsonl`）：格式与 pi 一致，用于「恢复历史」。
 *
 * 全部测试把 `REDUX_AGENT_DIR` 指到临时目录，绝不碰真实的 `~/.redux-agent`。
 */

/** 在一个隔离的配置家目录里跑 fn。 */
async function withHome(fn: (home: string) => Promise<void> | void): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'redux-home-'));
  const previous = process.env['REDUX_AGENT_DIR'];
  process.env['REDUX_AGENT_DIR'] = dir;
  try {
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env['REDUX_AGENT_DIR'];
    else process.env['REDUX_AGENT_DIR'] = previous;
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
    const kernel = createKernel({
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
      assert.equal(kernel.store.getState().systemPrompt, '装载过的 prompt');
      assert.equal(kernel.store.getState().model.seeded, true, 'model 保留');
    } finally {
      kernel.dispose();
    }
  });
});

test('开新会话后，两段对话落在**两个文件**里（旧的不被续写）', async () => {
  await withHome(async () => {
    const { createKernel } = await import('../src/kernel');
    const kernel = createKernel({
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

      const file1 = path.join(sessionPathIn('/proj'), 'para1.jsonl');
      const file2 = path.join(sessionPathIn('/proj'), `${second.id}.jsonl`);
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
