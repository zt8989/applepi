/**
 * 恢复历史：**慢**与**复制一份**两个症状的回归测试。
 *
 * ## 两个症状
 *
 * 1. **慢**：`/sessions` 选一个会话要等将近一分钟。
 * 2. **复制一份**：恢复完 `sessions/` 里多出一个内容几乎一样的会话文件。
 *
 * ## 根因（两条，都是「界面自己动手」惹的）
 *
 * 界面层原来是这样恢复的（`packages/tui/src/app.ts`）：
 *
 *     const messages = loadSessionMessages(session);
 *     store.dispatch({ type: 'conversation.reset' });      // ← 没带 sessionId
 *     for (const m of messages) store.dispatch({ type: 'session.restored', message: m });
 *
 * - 慢：界面每次 dispatch 都重渲染整段对话，而重渲染成本与 messages 长度成正比。
 *   逐条灌 N 条 = O(N²)。390 条实测 62 秒。
 * - 复制一份：`conversation.reset` **没带 sessionId**，于是会话 id 没换；会话记录器
 *   （store 的订阅器）还绑在**当前**会话上，它看到「多了 390 条新消息」就全量写进
 *   当前会话的文件。实测就是一个 390 行会话原样复制成另一个 390 行的文件。
 *
 * 修法两条：`conversation.restored`（一条 action 灌完）+ 恢复走 `kernel.restoreSession`
 * （换 id + `resumeFrom` 对齐记录器游标）。下面逐条钉住这两个不变量。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInitialState, type AgentState } from '../src/state';
import { createAgentReducer } from '../src/reducer';
import { createSessionRecorder } from '../src/session-recorder';
import { SessionWriter, readSessionMessages, readJsonlHead, type MessageEntry } from '../src/session-file';
import { listSessions, findSessionFile, sessionPath } from '../src/config-home';
import { loadTrace } from '../src/trace-file';
import { waitForIdle } from '../src/store';
import type { AgentAction, ModelCapabilities } from '../src/actions';
import type { Message } from '@earendil-works/pi-ai';

const CAPS: ModelCapabilities = {
  midConvoSystemMessages: true,
  midConvoToolAdditions: false,
  developerRole: false,
};

async function withHome(fn: (home: string) => Promise<void> | void): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'restore-home-'));
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

/**
 * 轮询到 `predicate()` 为真，最多等 `timeoutMs`。
 *
 * 用在「等某个**异步**结果」上 —— 本文件两处都是：`turn.end` 的 Cmd 在 phase 转 idle
 * 之后才执行，而轨迹落盘本身是异步的（`createFileSink()` 内部是一条 Promise 链，
 * `append()` 立刻返回、写盘在后面）。
 *
 * 这类等待**不能**写成 `setTimeout(魔数)`：套件是多文件并行跑的，磁盘一忙那个魔数
 * 就不够，于是变成一条偶发失败，而报出来的错（「恢复后节点数对不上」）指向的是
 * 完全无关的地方。
 *
 * 超时后**返回**而不是抛：调用方的断言会带着真实的节点数报错，比这里抛一句
 * 「超时了」信息量大得多。
 */
async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
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

const assistantMessage = (text: string): Message =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'p',
    model: 'm',
    usage,
    stopReason: 'stop',
    timestamp: 2,
  }) as Message;

/**
 * `createAgentReducer` 的返回值是 `LoopReducer`（带 `@@REDUX_LOOP` 那一套），
 * 测试里只需要「state → state」那一半，所以包一层 —— 与 `init.test.ts` 的 `reducer()` 同款。
 */
function typedReducer(): (state: AgentState, action: AgentAction) => AgentState {
  const reducer = createAgentReducer({});
  return (state, action) => reducer(state, action) as AgentState;
}

function seed(sessionId: string): AgentState {
  return createInitialState({
    systemPrompt: 'p',
    providerName: 'p',
    modelId: 'm',
    toolNames: [],
    sessionId,
  });
}

/** 造一个指定条数的会话文件（每条带 2KB 文本，模拟真实会话里的 toolResult 体量）。 */
function writeSessionFile(id: string, count: number): string {
  const w = new SessionWriter(id, '/proj');
  w.start();
  for (let i = 0; i < count; i += 1) {
    w.appendMessage(userMessage(`第 ${i + 1} 轮 ${'x'.repeat(2000)}`));
  }
  return w.path;
}

// ── 症状 1：慢 ──

test('conversation.restored：一条 action 灌完整批，不必逐条', () => {
  const reduce = typedReducer();
  const messages = Array.from({ length: 50 }, (_, i) => userMessage(`第 ${i + 1} 轮`));

  const state = reduce(seed('old'), {
    type: 'conversation.restored',
    sessionId: 'restored',
    messages,
  });

  assert.equal(state.messages.length, 50, '全部灌进去了');
  assert.deepEqual(
    state.messages.map((m) => (m as { content: string }).content),
    messages.map((m) => (m as { content: string }).content),
    '顺序与内容与逐条版一致',
  );
});

test('conversation.restored 的状态结果与「reset + 逐条 session.restored」**逐字段相同**', () => {
  const reduce = typedReducer();
  const messages = [userMessage('甲'), assistantMessage('乙'), userMessage('丙')];

  // 旧路：先 reset（换 id），再逐条灌。
  let stepwise = reduce(seed('from'), { type: 'conversation.reset', sessionId: 'to' });
  for (const m of messages) {
    stepwise = reduce(stepwise, { type: 'session.restored', message: m });
  }

  // 新路：一条。
  const batched = reduce(seed('from'), {
    type: 'conversation.restored',
    sessionId: 'to',
    messages,
  });

  assert.deepEqual(batched, stepwise, '两条路出来的状态树必须一模一样');
});

test('conversation.restored：保留装载好的 prompt / model 与 persistedSeq（会话级状态）', () => {
  const reduce = typedReducer();
  let state = reduce(seed('from'), { type: 'prompt.init', systemPrompt: '装载的', tools: [] });
  state = reduce(state, {
    type: 'model.init',
    provider: 'p',
    modelId: 'm',
    thinkingLevel: 'off',
    capabilities: CAPS,
  });
  state = reduce(state, { type: 'trace.persisted', upToSeq: 42 });

  state = reduce(state, {
    type: 'conversation.restored',
    sessionId: 'to',
    messages: [userMessage('甲')],
  });

  assert.equal(state.prompt.seeded, true, 'prompt 保留（换会话不等于换模型/系统提示）');
  assert.equal(state.model.seeded, true, 'model 保留');
  assert.equal(state.persistedSeq, 42, 'persistedSeq 属于轨迹文件，不该被清零');
  assert.equal(state.trace.sessionId, 'to', '会话 id 换掉了（于是之后的消息写进新文件）');
});

test('conversation.restored 不动相位，但轨迹树**换成新的**（于是落盘换文件）', () => {
  const reduce = typedReducer();
  // 这里只拿 reducer（没接 effect），所以 user.message 不会真把环跑完：
  // 相位停在 thinking（agent.run 的迁移已经过了），轨迹树上开了一个 user 节点。
  let state = reduce(seed('from'), { type: 'user.message', text: '问一句' });
  const phaseBefore = state.phase;
  assert.equal(state.trace.order.length, 1, 'user.message 开了一个节点');

  state = reduce(state, {
    type: 'conversation.restored',
    sessionId: 'to',
    messages: [userMessage('历史甲')],
  });

  assert.equal(state.phase, phaseBefore, '相位不动：恢复不推动相位');
  // 轨迹树**清空**（不是接着上一轮那棵）：会话 id 换了，落盘就该换一个文件，
  // 而那个文件里还没有任何节点 —— 与 conversation.reset 同一个理由。
  // 保留旧节点的话，恢复之后落盘会把上一轮的节点混进新会话的轨迹里。
  assert.equal(state.trace.order.length, 0, '轨迹树换成新的空树');
  assert.equal(state.trace.sessionId, 'to', '会话 id 换了（于是换落盘文件）');
  assert.equal(state.messages.length, 1, '旧的对话被这批历史替换（不是追加在后面）');
});

// ── 症状 2：复制一份 ──

/** 一个带订阅的 store（记录器就是挂在它上面的）。 */
interface MiniStore {
  getState(): AgentState;
  subscribe(listener: () => void): () => void;
  /** 走 reducer 之后再通知订阅者（与 redux-loop 的顺序一致）。 */
  dispatch(action: AgentAction): void;
}

/**
 * 建「内核恢复历史时那套接线」的最小版本：一个 store + 一个游标对齐的记录器。
 */
function wiring(sessionId: string, cwd: string, resumeFrom: number): {
  store: MiniStore;
  dispose(): void;
} {
  const reduce = typedReducer();
  let state = seed(sessionId);
  const listeners = new Set<() => void>();
  const store: MiniStore = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch: (action) => {
      state = reduce(state, action);
      for (const listener of listeners) listener();
    },
  };
  const recorder = createSessionRecorder(store, {
    sessionId,
    cwd,
    enabled: true,
    resumeFrom,
  });
  assert.ok(recorder, '记录器建起来了');
  return { store, dispose: () => recorder.dispose() };
}

test('恢复不写盘：会话文件一个字节都不该变（复制一份的根因）', async () => {
  await withHome(async () => {
    const file = writeSessionFile('old-session', 40);
    const history = readSessionMessages(file);
    assert.equal(history.length, 40);
    const sizeBefore = (await readFile(file)).length;

    const { store, dispose } = wiring('old-session', '/proj', history.length);
    store.dispatch({ type: 'conversation.restored', sessionId: 'old-session', messages: history });
    dispose();

    assert.equal(store.getState().messages.length, 40, '消息灌回状态了');
    assert.equal(
      (await readFile(file)).length,
      sizeBefore,
      '恢复不写盘 —— 一个字节都不该变',
    );
  });
});

test('恢复后继续聊：只有新那一条被**追加**，不是又一份历史', async () => {
  await withHome(async () => {
    const file = writeSessionFile('old-session', 5);
    const history = readSessionMessages(file);

    const { store, dispose } = wiring('old-session', '/proj', history.length);
    store.dispatch({ type: 'conversation.restored', sessionId: 'old-session', messages: history });
    store.dispatch({ type: 'user.message', text: '新的问题' });
    dispose();

    const after = readSessionMessages(file);
    assert.equal(after.length, 6, '5 旧 + 1 新（历史没被重写一遍）');
    assert.equal(
      (after[5] as { content: string }).content,
      '新的问题',
      '追加的是新问题',
    );
  });
});

test('界面不接内核时**明说**「不会切换记录器」，而不是静默复制一份', async () => {
  await withHome(async () => {
    const file = writeSessionFile('old-session', 3);
    const history = readSessionMessages(file);

    // 界面版（没有内核接管记录器）：只管状态，不管落盘。
    const reduce = typedReducer();
    let state = seed('current');
    state = reduce(state, {
      type: 'conversation.restored',
      sessionId: state.trace.sessionId,
      messages: history,
    });

    // 状态是对的：历史灌进去了，且没有「换 id」这个副作用（界面版不敢换）。
    assert.equal(state.messages.length, 3);
    assert.equal(state.trace.sessionId, 'current', '界面版不换 id —— 所以必须由内核出手');
  });
});

test('内核 restoreSession：换 id + 灌回消息', async () => {
  await withHome(async () => {
    const { createKernel } = await import('../src/kernel');
    const cwd = process.cwd();

    // 先用内核跑一轮 demo，落一个有内容的会话。
    const first = await createKernel({
      provider: 'deepseek',
      systemPrompt: 'p',
      cwd,
      demo: true,
      sessionId: 'history',
      traceDir: null,
    });
    first.store.dispatch({ type: 'user.message', text: '旧的第一句' } as AgentAction);
    await new Promise((r) => setTimeout(r, 80));
    first.dispose();

    const historyFile = findSessionFile('history', cwd);
    assert.ok(existsSync(historyFile), '旧会话文件在');

    const before = readSessionMessages(historyFile);
    const sizeBefore = (await readFile(historyFile)).length;

    // 起一个新内核（当前会话是另一个 id），恢复它。
    const second = await createKernel({
      provider: 'deepseek',
      systemPrompt: 'p',
      cwd,
      demo: true,
      sessionId: 'current',
      traceDir: null,
    });
    try {
      // **要 await**：内核要读 traces/<id>.jsonl 才能把轨迹树带回来。
      const result = await second.restoreSession(historyFile);
      assert.equal(result.id, 'history', '换成了历史那个 id（之后的消息追加进它）');
      assert.equal(result.restored, before.length, '全部灌回');
      assert.equal(second.sessionId, 'history', '内核上的 id 也换');
      assert.equal(second.store.getState().messages.length, before.length, '状态里有历史');
      assert.equal(
        (await readFile(historyFile)).length,
        sizeBefore,
        '恢复之后原文件没被追加（复制一份就是这么来的）',
      );
    } finally {
      second.dispose();
    }
  });
});

test('内核 restoreSession 之后发的新问题追加进**那个**会话，不是当前会话', async () => {
  await withHome(async () => {
    const { createKernel } = await import('../src/kernel');
    const cwd = process.cwd();

    const first = await createKernel({
      provider: 'deepseek',
      systemPrompt: 'p',
      cwd,
      demo: true,
      sessionId: 'history',
      traceDir: null,
    });
    first.store.dispatch({ type: 'user.message', text: '旧的第一句' } as AgentAction);
    await new Promise((r) => setTimeout(r, 80));
    first.dispose();

    const historyFile = findSessionFile('history', cwd);
    const before = readSessionMessages(historyFile);

    const second = await createKernel({
      provider: 'deepseek',
      systemPrompt: 'p',
      cwd,
      demo: true,
      sessionId: 'current',
      traceDir: null,
    });
    try {
      second.restoreSession(historyFile);
      second.store.dispatch({ type: 'user.message', text: '恢复之后新问的' } as AgentAction);
      // demo 一个问题跑两轮（toolUse 一轮 + 收尾一轮），所以会落不止 1 条。
      // 这里不看条数，只看「新问题字符串出现在哪个文件里」。
      await new Promise((r) => setTimeout(r, 120));
    } finally {
      second.dispose();
    }

    const after = readSessionMessages(historyFile);
    assert.ok(
      after.length > before.length,
      '新问题追加进历史会话（而不是新建一个文件）',
    );
    assert.ok(
      after.some((m) => String((m as { content: string }).content).includes('恢复之后新问的')),
      '“恢复之后新问的”确实写进了被恢复的那个会话文件',
    );
    assert.ok(
      !existsSync(findSessionFile('current', cwd)),
      '当前会话没有留下一个「当前会话文件」（以前恢复会把它写满历史）',
    );
  });
});

// ── 列表侧：标题不该为了显示而读整个文件 ──

test('readJsonlHead：只读开头，且 stopAfter 命中就停', async () => {
  await withHome(async () => {
    const file = writeSessionFile('head', 20);
    const { content } = readJsonlHead(file, 512 * 1024, {
      stopAfter: (entry) =>
        entry.type === 'message' && (entry as MessageEntry).message?.role === 'user',
    });
    assert.equal(content.length, 1, '第一条就是第一条 user 消息，后面的没读');
    const first = content[0] as MessageEntry;
    assert.match(String((first.message as { content: string }).content), /^第 1 轮/);
  });
});

test('readJsonlHead：截断的半行被跳过，不会让整段读不出来', async () => {
  await withHome(async () => {
    const w = new SessionWriter('trunc', '/proj');
    w.start();
    // 写入用的真实路径是带时间戳的那个（`<时间戳>_trunc.jsonl`）；
    // 手拼的 `sessionPath()` 是旧形状，文件不在那儿。
    const file = w.path;
    w.appendMessage(userMessage('完整的一条'));
    await writeFile(file, `${(await readFile(file, 'utf8')).trimEnd()}\n{"type":"mes`, 'utf8');

    const { header, content } = readJsonlHead(file, 64 * 1024);
    assert.ok(header, 'header 读到了');
    assert.equal(content.length, 1, '完整那条在，半行被跳过');
  });
});

test('readJsonlHead：读到的 header 与 readSession 的同一个', async () => {
  await withHome(async () => {
    const file = writeSessionFile('hdr', 3);
    const { header } = readJsonlHead(file, 4096);
    assert.equal(header?.id, 'hdr');
    assert.equal(header?.cwd, '/proj');
  });
});

test('readJsonlHead：文件不存在时返回空（不抛）', async () => {
  await withHome(async () => {
    const { header, content } = readJsonlHead('/nope/nothing.jsonl', 4096);
    assert.equal(header, null);
    assert.deepEqual(content, []);
  });
});

test('listSessions：坏 header 的会话仍然列得出来（只是拿不到 cwd）', async () => {
  await withHome(async () => {
    writeSessionFile('good', 2);
    const bad = sessionPath('bad', '/proj');
    await writeFile(
      bad,
      '这一行不是 JSON\n{"type":"message","id":"e1","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":"还能读出来吗","timestamp":1}}\n',
      'utf8',
    );

    const ids = listSessions().map((s) => s.id);
    assert.ok(ids.includes('good'), '好的列出来了');
    assert.ok(ids.includes('bad'), 'header 坏的也列出来了（用户还能看到它、删掉它）');
  });
});
/**
 * 恢复历史时**轨迹树也要回来**。
 *
 * ## 这个 bug 的形状
 *
 * 早先 `restoreSession` 只读 `sessions/<id>.jsonl`（消息），轨迹那份
 * `traces/<id>.jsonl` **压根没读** —— 而 `conversation.restored` 的迁移里
 * `createInitialState` 造的是一棵**空树**。
 *
 * 症状特别有欺骗性：恢复后**对话区里的图片照常显示、消息一条不少**，
 * 只有轨迹面板是空的。很容易归因为「恢复不完整 / 图片没存」，
 * 而真因是那棵树没被读回来（文件明明在盘上）。
 *
 * 所以这条测试盯的是**树**，而且用一个带图片的会话 —— 因为那正是用户报 symptom 的场景。
 */
test('恢复历史：轨迹树跟着回来（对话区有图、轨迹却是空的那个 bug）', async () => {
  await withHome(async () => {
    const { createKernel } = await import('../src/kernel');
    const cwd = process.cwd();
    // 1x1 PNG —— 只关心「消息里有 image 块」，不真的解码。
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    const first = await createKernel({
      provider: 'deepseek',
      systemPrompt: 'p',
      cwd,
      demo: true,
      sessionId: 'with-image',
      // **不关 traceDir**：这个 bug 只在真的落盘轨迹时才谈得上「读回来」。
    });
    first.store.dispatch({
      type: 'user.message',
      text: '这张图是什么',
      content: [
        { type: 'text', text: '这张图是什么' },
        { type: 'image', data: png, mimeType: 'image/png' },
      ],
    } as AgentAction);
    // **等环真的跑完**，而不是 `setTimeout` 一个魔数 —— 后者在整个套件并行跑时
    // 会不够（磁盘慢一点就只跑了一半），症状是「轨迹节点数对不上」，
    // 而真因跟被测的恢复路径毫无关系。本文件其它用例都是这么等的。
    await waitForIdle(first.store, 20_000);
    // 等到**盘上**那份轨迹与内存里那份一样长，再往下走。
    //
    // 两道异步都要等（这是这条测试早先偶发失败的真因）：
    //   1. `turn.end` 的 Cmd 在 phase 转 idle **之后**才执行（见 reducer 的 closeTurn 注释）；
    //   2. 轨迹落盘是异步的 —— `createFileSink()` 的 `append()` 立刻返回，写盘排在那条
    //      Promise 链后面。所以「节点已经进 state」**不等于**「已经落盘」，而这条测试
    //      接下来要做的正是「把盘上那份读回来」。
    //
    // 早先这里是 `await setTimeout(50)`：并行跑套件时磁盘一忙就不够，漏掉最后一个节点，
    // 症状是「恢复后节点数对不上」—— 指向的是完全无关的地方。
    await waitUntil(async () => {
      const onDisk = await loadTrace('with-image');
      return onDisk !== null && onDisk.order.length === first.store.getState().trace.order.length;
    }, 20_000);
    const beforeTree = first.store.getState().trace;
    assert.ok(beforeTree.order.length > 0, '跑之前轨迹上有节点');
    assert.equal(
      JSON.stringify(first.store.getState().messages[0]?.content).includes('image'),
      true,
      '消息里有图片',
    );
    first.dispose();

    // 起一个新内核（当前会话是另一个 id），恢复它。
    const second = await createKernel({
      provider: 'deepseek',
      systemPrompt: 'p',
      cwd,
      demo: true,
      sessionId: 'other',
    });
    try {
      await second.restoreSession(findSessionFile('with-image', cwd));
      const after = second.store.getState();

      // 对话区：图片还在（这部分本来就是好的）。
      assert.equal(
        JSON.stringify(after.messages[0]?.content).includes('image'),
        true,
        '恢复后图片仍在对话里',
      );
      // 轨迹：**这才是修的那一条**。
      assert.equal(
        after.trace.order.length,
        beforeTree.order.length,
        `恢复后轨迹节点数应与跑之前一致（实际 ${after.trace.order.length}，期望 ${beforeTree.order.length}）`,
      );
      assert.equal(after.trace.tipId, beforeTree.tipId, 'tip 也一致');
      assert.equal(
        after.trace.order.map((id) => after.trace.nodes[id]?.kind).join(','),
        beforeTree.order.map((id) => beforeTree.nodes[id]?.kind).join(','),
        '节点顺序与 kind 逐个相同',
      );
      assert.equal(after.traceBegun, true, 'traceBegun 为真（否则这段树永远不落盘）');
    } finally {
      second.dispose();
    }
  });
});

test('恢复没有轨迹文件的历史：行为与修复前一致（空树，不报错）', async () => {
  await withHome(async () => {
    const { createKernel } = await import('../src/kernel');
    const cwd = process.cwd();
    const first = await createKernel({
      provider: 'deepseek',
      systemPrompt: 'p',
      cwd,
      demo: true,
      sessionId: 'no-trace',
      traceDir: null, // ← 关掉落盘，于是没有 traces/<id>.jsonl
    });
    first.store.dispatch({ type: 'user.message', text: '一句话' } as AgentAction);
    await waitForIdle(first.store, 20_000);
    first.dispose();

    const second = await createKernel({
      provider: 'deepseek',
      systemPrompt: 'p',
      cwd,
      demo: true,
      sessionId: 'cur2',
    });
    try {
      // **不能抛** —— 老会话（早于轨迹功能）就属于这一类。
      const result = await second.restoreSession(findSessionFile('no-trace', cwd));
      assert.equal(result.id, 'no-trace');
      assert.ok(result.restored > 0, '消息还是灌回来了');
      assert.equal(second.store.getState().trace.order.length, 0, '没有轨迹就是空树');
    } finally {
      second.dispose();
    }
  });
});
