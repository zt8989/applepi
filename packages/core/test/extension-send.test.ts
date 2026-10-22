import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extensionMessageAction, extensionMessageText } from '../src/extension-host';
import { createKernel } from '../src/kernel';
import { createAgentStore, waitForIdle } from '../src/store';
import { createFauxRuntime } from '../src/provider';
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';

/**
 * 扩展的 `pi.sendMessage` 落到环上 —— 后台任务完成通知走的就是这条路。
 *
 * ## 这组测试守什么
 *
 * 两处「错了不报错、只丢消息」的地方：
 *
 * 1. **`content` 的形状**。pi 的 `CustomMessage.content` 可以是纯字符串，也可以是
 *    content 块数组。只认数组时，字符串会归一成空串，落点把空消息丢掉 ——
 *    `pi-background-tasks` 的 `<background-task-notification>` 正好是字符串，症状是
 *    「任务 completed、`notified` 是 true，界面上什么都不发生」。
 * 2. **相位**。环在跑的时候发 `user.message` 是 no-op（reducer 只收「开始一个新回合」
 *    的输入），消息静默消失；必须按 `deliverAs` 排队。
 */

/** `pi-background-tasks` 真正发出来的形状（见它的 `notifyCompletion`）。 */
const NOTIFICATION = {
  customType: 'background-task-notification',
  content:
    '<background-task-notification>\n  <task-id>bd28b009b</task-id>\n  <status>completed</status>\n</background-task-notification>',
  display: true,
  details: { id: 'bd28b009b' },
};

const FOLLOW_UP = { deliverAs: 'followUp', triggerTurn: true } as const;

// ── content 归一 ──

test('字符串 content 不被吞：完成通知就是字符串', () => {
  assert.equal(extensionMessageText(NOTIFICATION), NOTIFICATION.content);
});

test('content 块数组照旧拼成文本（非 text 块跳过）', () => {
  const message = {
    content: [{ type: 'text', text: '甲' }, { type: 'image', data: 'x' }, '乙'],
  };
  assert.equal(extensionMessageText(message), '甲\n乙');
});

test('没有 content → 空串（落点据此不 dispatch）', () => {
  assert.equal(extensionMessageText({ customType: 'x' }), '');
  assert.equal(extensionMessageText(undefined), '');
});

// ── 投递路由 ──

test('空闲时：一条 user.message（于是开新回合，模型看得见）', () => {
  const action = extensionMessageAction(NOTIFICATION.content, FOLLOW_UP, 'idle');
  assert.deepEqual(action, { type: 'user.message', text: NOTIFICATION.content });
  assert.equal(extensionMessageAction('   \n', FOLLOW_UP, 'idle'), null, '空白不当下一个回合的开头');
});

test('环在跑 + followUp：排队，不是丢掉', () => {
  assert.deepEqual(extensionMessageAction('跑完了', FOLLOW_UP, 'thinking'), {
    type: 'queue.input',
    text: '跑完了',
    as: 'followUp',
  });
});

test('环在跑 + steer：排 steer 队（工具跑完就插进去）', () => {
  assert.deepEqual(extensionMessageAction('插一句', { deliverAs: 'steer' }, 'calling-tools'), {
    type: 'queue.input',
    text: '插一句',
    as: 'steer',
  });
});

test('环在跑 + nextTurn：按 followUp 处理（本项目没有「下个回合开头」那种挂起点）', () => {
  assert.deepEqual(extensionMessageAction('稍后', { deliverAs: 'nextTurn' }, 'thinking'), {
    type: 'queue.input',
    text: '稍后',
    as: 'followUp',
  });
});

test('环在跑 + 没写 deliverAs：默认 followUp（不打断当前回合）', () => {
  assert.deepEqual(extensionMessageAction('通知', {}, 'thinking'), {
    type: 'queue.input',
    text: '通知',
    as: 'followUp',
  });
});

// ── 端到端：那条通知真的进了对话 ──

test('完成通知在空闲时落到对话里（回归：曾经整条被归一成空串丢掉）', async () => {
  const faux = createFauxRuntime();
  faux.setResponses([fauxAssistantMessage([fauxText('收到')], { stopReason: 'stop' })]);
  const store = createAgentStore({ runtime: faux.runtime, systemPrompt: 'test', sessionId: 'ext-send' });

  const action = extensionMessageAction(NOTIFICATION.content, FOLLOW_UP, store.getState().phase);
  assert.ok(action, '这条路不该产出空消息');
  store.dispatch(action);
  await waitForIdle(store, 20_000);
  await new Promise((r) => setTimeout(r, 50));

  const state = store.getState();
  const user = state.messages.find((m) => m.role === 'user');
  assert.ok(user, '通知该作为用户消息进 messages');
  assert.match(String(user.content), /bd28b009b/, '任务 id 得在，否则模型不知道是哪条');
  assert.equal(state.turnIndex, 1, '顺带开了一个回合');
});

// ── 真扩展 + 真内核：`pi.sendMessage` 的整条线 ──

/**
 * 探针扩展：装载完就发一条与 `pi-background-tasks` 同形的完成通知。
 *
 * 用真文件而不是内联工厂：`pi.sendMessage` 只在 `loadExtensions()` 装出来的宿主里
 * 才是真的（见 `extension-lifecycle.test.ts` 的取舍）。
 */
const NOTIFY_PROBE_SOURCE = `
export default function (pi) {
  pi.on('session_start', () => {
    setTimeout(() => {
      pi.sendMessage(
        {
          customType: 'background-task-notification',
          content: '<background-task-notification>\\n  <task-id>probe-1</task-id>\\n  <status>completed</status>\\n</background-task-notification>',
          display: true,
          details: { id: 'probe-1' },
        },
        { deliverAs: 'followUp', triggerTurn: true },
      );
    }, 0);
  });
}
`;

/**
 * 投不出去时必须抛 —— 扩展把结论记在 `globalThis` 里，测试从外头读。
 *
 * 为什么要抛：`pi-background-tasks` 的 `notifyCompletion` 是「先当成功、只在 catch 里
 * 回滚 `notified`」。宿主静默成功 → 盘上记的「已送达」。
 */
const EMPTY_SEND_PROBE_SOURCE = `
export default function (pi) {
  pi.on('session_start', () => {
    const g = globalThis;
    g.__emptySend = {};
    try {
      pi.sendMessage(
        { customType: 'x', content: [], display: true },
        { deliverAs: 'followUp', triggerTurn: true },
      );
      g.__emptySend.threw = false;
    } catch (error) {
      g.__emptySend.threw = true;
      g.__emptySend.message = error instanceof Error ? error.message : String(error);
    }
  });
}
`;

/**
 * 记下每一次 `session_start` / `session_shutdown`，并给每个扩展**实例**一个自增代号。
 *
 * 切会话在 pi 那边是「收掉旧激活 → 新实例重新激活」，所以代号是断言「真的换了实例」的证据：
 * 只再发一次 `session_start` 给旧实例就是 `pi-background-tasks` 报
 * `pi_bg_reload_owner_activation_conflict` 的那条路。
 */
const SESSION_START_PROBE_SOURCE = `
export default function (pi) {
  const g = globalThis;
  g.__sessionStarts = g.__sessionStarts ?? [];
  g.__sessionShutdowns = g.__sessionShutdowns ?? [];
  g.__probeInstances = (g.__probeInstances ?? 0) + 1;
  const instance = g.__probeInstances;
  pi.on('session_start', (event, ctx) => {
    g.__sessionStarts.push({
      reason: event.reason,
      previousSessionFile: event.previousSessionFile,
      sessionFile: ctx?.sessionManager?.getSessionFile?.(),
      instance,
    });
  });
  pi.on('session_shutdown', (event) => {
    g.__sessionShutdowns.push({ reason: event.reason, targetSessionFile: event.targetSessionFile, instance });
  });
}
`;

/** 切会话要**重装宿主**（jiti 重来一遍），并行跑测试时比单纯发个事件慢得多。 */
const SWITCH_TIMEOUT_MS = 30_000;

/** 等到 `predicate` 为真（或超时）—— 扩展是 fire-and-forget，等不到就是 bug。 */
async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('等超时了');
}

/** 落一个探针扩展，启一个真内核，跑完收拾干净（临时家目录 + 临时 cwd）。 */
async function withKernel(
  probeSource: string,
  run: (kernel: Awaited<ReturnType<typeof createKernel>>) => Promise<void>,
): Promise<void> {
  const agentDir = mkdtempSync(path.join(tmpdir(), 'ext-send-home-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'ext-send-cwd-'));
  mkdirSync(path.join(agentDir, 'extensions'), { recursive: true });
  writeFileSync(path.join(agentDir, 'extensions', 'probe.ts'), probeSource);
  const saved = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  const globals = globalThis as {
    __emptySend?: unknown;
    __sessionStarts?: unknown;
    __sessionShutdowns?: unknown;
  };
  delete globals.__emptySend;
  delete globals.__sessionStarts;
  delete globals.__sessionShutdowns;
  try {
    const kernel = await createKernel({ provider: 'faux', demo: true, cwd, traceDir: null });
    try {
      await run(kernel);
    } finally {
      kernel.dispose();
    }
  } finally {
    if (saved !== undefined) process.env['PI_CODING_AGENT_DIR'] = saved;
    else delete process.env['PI_CODING_AGENT_DIR'];
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('真扩展的 pi.sendMessage：空闲时整条通知进对话，并开一个新回合', async () => {
  await withKernel(NOTIFY_PROBE_SOURCE, async (kernel) => {
    const hasNotification = (): boolean =>
      kernel.store
        .getState()
        .messages.some((m) => m.role === 'user' && String(m.content).includes('probe-1'));
    await waitUntil(hasNotification);
    await waitForIdle(kernel.store, 20_000);

    const state = kernel.store.getState();
    assert.equal(state.turnIndex, 1, '通知自己开了第 1 个回合');
    const user = state.messages.find((m) => m.role === 'user');
    assert.match(String(user?.content), /background-task-notification/, '通知的正文一句不能少');
  });
});

test('投不出去就抛：归一后没文本的 pi.sendMessage 不当成功', async () => {
  await withKernel(EMPTY_SEND_PROBE_SOURCE, async () => {
    const sent = (globalThis as { __emptySend?: { threw?: boolean; message?: string } }).__emptySend;
    assert.ok(sent, '探针扩展该在 session_start 里跑一次');
    assert.equal(sent.threw, true, `空内容该抛（实际：${String(sent.message ?? '没抛')}）`);
  });
});

test('/resume 换一次扩展激活：先 session_shutdown，再由新实例 session_start', async () => {
  await withKernel(SESSION_START_PROBE_SOURCE, async (kernel) => {
    type Start = {
      reason?: string;
      previousSessionFile?: string;
      sessionFile?: string;
      instance?: number;
    };
    type Shutdown = { reason?: string; targetSessionFile?: string; instance?: number };
    const globals = globalThis as {
      __sessionStarts?: Start[];
      __sessionShutdowns?: Shutdown[];
    };
    const starts = globals.__sessionStarts ?? [];
    const shutdowns = globals.__sessionShutdowns ?? [];
    const fileA = starts[0]?.sessionFile;
    assert.ok(fileA !== undefined, '装载时就该报出会话文件（状态类扩展靠它认对话记录在哪）');

    // 先真跑一句，让会话文件 A 真的落盘（空会话不建文件，而 `/resume` 读的是盘上那份）。
    kernel.store.dispatch({ type: 'user.message', text: '第一句' });
    await waitForIdle(kernel.store, 20_000);
    await waitUntil(() => existsSync(fileA));

    // 切到一个新会话（B），再恢复 A —— 这样「从哪个切过来」与「恢复成哪个」才是两个文件。
    kernel.newSession();
    await waitUntil(() => starts.length >= 2, SWITCH_TIMEOUT_MS);
    const fileB = starts[1]?.sessionFile;

    // pi 的顺序：`session_shutdown` 先发（旧实例释放所有权），然后新实例接。
    assert.deepEqual(
      shutdowns.map((s) => s.reason),
      ['new'],
      '切会话必须先发 session_shutdown（pi-background-tasks 只在 shutdown 后才接受新身份）',
    );
    assert.equal(shutdowns[0]?.instance, starts[0]?.instance, 'shutdown 发给的是旧实例');
    assert.notEqual(starts[1]?.instance, starts[0]?.instance, '新会话由**新实例**接手，不是旧实例接第二发');

    await kernel.restoreSession(fileA);
    await waitUntil(() => starts.length >= 3, SWITCH_TIMEOUT_MS);

    const resumed = starts[2];
    assert.equal(resumed?.reason, 'resume', '`/resume` 的 reason 是 resume');
    assert.equal(resumed?.previousSessionFile, fileB, '报出被切走的那个会话文件');
    assert.equal(resumed?.sessionFile, fileA, 'ctx 报的是恢复后的会话文件，不是旧的');
    assert.notEqual(resumed?.instance, starts[1]?.instance, '恢复历史也是新实例（与 pi 的 switchSession 一致）');
    assert.equal(shutdowns[1]?.reason, 'resume');
    assert.equal(
      shutdowns[1]?.targetSessionFile,
      fileA,
      'shutdown 里要带「切到哪里」—— 那是 SessionShutdownEvent 的 targetSessionFile',
    );
  });
});

test('/new 也发 session_start{reason:\'new\'}（扩展靠它重新激活）', async () => {
  await withKernel(SESSION_START_PROBE_SOURCE, async (kernel) => {
    type Start = {
      reason?: string;
      previousSessionFile?: string;
      sessionFile?: string;
      instance?: number;
    };
    const starts =
      (globalThis as { __sessionStarts?: Start[] }).__sessionStarts ?? [];
    assert.deepEqual(
      starts.map((s) => s.reason),
      ['startup'],
      '装载时一发（reason 是 startup，与以前一致）',
    );

    const previousFile = starts[0]?.sessionFile;
    kernel.newSession();
    await waitUntil(() => starts.length >= 2, SWITCH_TIMEOUT_MS);

    assert.equal(starts[1]?.reason, 'new', '`/new` 的 reason 是 new，不是 startup');
    assert.equal(
      starts[1]?.previousSessionFile,
      previousFile,
      '要报出「从哪个会话切过来的」—— 那是 SessionStartEvent 里 previousSessionFile 的语义',
    );
    assert.notEqual(starts[1]?.sessionFile, previousFile, 'ctx 报的是新会话文件');
    assert.notEqual(
      starts[1]?.instance,
      starts[0]?.instance,
      '重发 session_start 给旧实例是 pi-background-tasks 报 activation_conflict 的那条路',
    );
    assert.deepEqual(
      kernel.extensions.errors.filter((error) => !error.includes('anthropic')),
      [],
      '切会话不该留下任何扩展诊断',
    );
  });
});

test('恢复的是**同一个**会话：不重装扩展（不白断一次 MCP / 工具）', async () => {
  await withKernel(SESSION_START_PROBE_SOURCE, async (kernel) => {
    type Start = { reason?: string; sessionFile?: string; instance?: number };
    const globals = globalThis as {
      __sessionStarts?: Start[];
      __sessionShutdowns?: unknown[];
    };
    const starts = globals.__sessionStarts ?? [];
    const file = starts[0]?.sessionFile;
    assert.ok(file !== undefined);
    kernel.store.dispatch({ type: 'user.message', text: '第一句' });
    await waitForIdle(kernel.store, 20_000);
    await waitUntil(() => existsSync(file));

    // webui 点侧边栏当前那一条 / 启动时 `--session <id>` 后再 restore，都会走到这里。
    await kernel.restoreSession(file);
    assert.equal(starts.length, 1, '同一个会话不该再发 session_start');
    assert.deepEqual(globals.__sessionShutdowns ?? [], [], '也不该把宿主收掉');
  });
});

test('从已有会话启动：装载那一发的 reason 是 resume（不是 startup）', async () => {
  // 与 pi 同口径：`hasExistingSession`（messages.length > 0）为真时 reason 是 resume。
  // 状态类扩展拿它区分「新开」与「接着聊」，所以这里跑两个真内核：先留一个带消息的
  // 会话文件，再用那个 sessionId 启动第二个。
  type Start = { reason?: string; previousSessionFile?: string; sessionFile?: string };
  const agentDir = mkdtempSync(path.join(tmpdir(), 'ext-send-home-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'ext-send-cwd-'));
  mkdirSync(path.join(agentDir, 'extensions'), { recursive: true });
  writeFileSync(path.join(agentDir, 'extensions', 'probe.ts'), SESSION_START_PROBE_SOURCE);
  const saved = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  // 这条测试自己起内核（要走两轮），所以自己清 `globalThis` 上的探针槽 ——
  // 不清的话读到的是上一条测试留下的、指向已删临时目录的旧路径。
  (globalThis as { __sessionStarts?: Start[] }).__sessionStarts = [];
  const startsOf = (): Start[] =>
    ((globalThis as { __sessionStarts?: Start[] }).__sessionStarts ??= []);
  try {
    const first = await createKernel({ provider: 'faux', demo: true, cwd, traceDir: null });
    const sessionId = first.sessionId;
    const file = startsOf()[0]?.sessionFile;
    assert.ok(file !== undefined, '装载时就该报出会话文件');
    try {
      first.store.dispatch({ type: 'user.message', text: '第一句' });
      await waitForIdle(first.store, 20_000);
    } finally {
      // 落盘是缓冲的：`dispose()` 会把会话记录器 flush 掉，所以先收内核再等文件。
      first.dispose();
    }
    await waitUntil(() => existsSync(file));

    startsOf().length = 0;
    const second = await createKernel({
      provider: 'faux',
      demo: true,
      cwd,
      traceDir: null,
      sessionId,
    });
    try {
      assert.equal(startsOf()[0]?.reason, 'resume', '接着聊已有会话 → resume');
    } finally {
      second.dispose();
    }
  } finally {
    if (saved !== undefined) process.env['PI_CODING_AGENT_DIR'] = saved;
    else delete process.env['PI_CODING_AGENT_DIR'];
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
