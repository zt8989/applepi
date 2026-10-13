import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Message,
} from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  compactionSettings,
  compactReasonText,
  decideCompaction,
  effectiveCompactionSettings,
  isCompactionSummary,
  lastContextTokens,
  planCut,
  readCompactionEnabled,
  runCompaction,
  writeCompactionEnabled,
} from '../src/compact';
import { createAgentReducer, loopWiring } from '../src/reducer';
import { createAgentStore, createAutoCompact, waitForIdle } from '../src/store';
import { createFauxRuntime } from '../src/provider';
import { createInitialState, type AgentState } from '../src/state';
import type { AgentAction } from '../src/actions';

/**
 * 上下文压缩（compact）。
 *
 * ## 这组测试守的是什么
 *
 * 压缩是**唯一**会主动销毁用户可见对话内容的操作。一条压缩消息进去，
 * 前面几十轮对话就从上下文里消失了 —— 而模型是**不会**抱怨的，它只会若无其事地
 * 继续，然后说出「你没提过要改那个文件」这种话。
 *
 * 所以这里守三件��：
 *   1. **不该压的时候不压**（判定阈值、窗口夹紧）；
 *   2. **压了之后消息序列仍然合法**（没有孤儿 toolResult、摘要排在最前）；
 *   3. **压不了的时候如实说**（不静默、不假装成功、对话原样保留）。
 *
 * 切点算法本身不测 —— 它是 pi 的 `findCutPoint`，我们只测**怎么把它接进我们的模型**。
 */

const usage = (totalTokens: number) => ({
  input: totalTokens,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function user(text: string, size = 0): Message {
  const content = size > 0 ? text.padEnd(size, '·') : text;
  return { role: 'user', content, timestamp: Date.now() } as Message;
}

function assistantOk(totalTokens: number): Message {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: '好' }],
    usage: usage(totalTokens),
    stopReason: 'stop',
    timestamp: Date.now(),
  } as unknown as Message;
}

function stateWith(messages: readonly Message[], contextWindow: number): AgentState {
  const base = createInitialState({
    systemPrompt: '',
    providerName: 'p',
    modelId: 'm',
    toolNames: [],
    sessionId: 't',
  });
  return {
    ...base,
    messages: [...messages],
    model: {
      ...base.model,
      seeded: true,
      contextWindow,
      capabilities: {
        midConvoSystemMessages: false,
        midConvoToolAdditions: false,
        developerRole: false,
      },
    },
  };
}

// ─── 判定：不该压的时候不压 ───

test('占用远低于窗口：不压', () => {
  const state = stateWith([user('你好'), assistantOk(1000)], 200_000);
  const decision = decideCompaction({ state, settings: compactionSettings() });
  assert.equal(decision.should, false);
  assert.equal(decision.reason, null);
  assert.equal(decision.contextTokens, 1000);
});

test('占用超过「窗口 - reserve」：压，理由是 threshold', () => {
  const state = stateWith([user('你好'), assistantOk(190_000)], 200_000);
  const decision = decideCompaction({ state, settings: compactionSettings() });
  assert.equal(decision.should, true);
  assert.equal(decision.reason, 'threshold');
});

test('provider 报上下文溢出：压，理由是 overflow（哪怕占用看着不高）', () => {
  const overflow = {
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage: "This model's maximum context length is 8192 tokens",
    usage: usage(8192),
    timestamp: Date.now(),
  } as unknown as Message;
  const state = stateWith([user('你好'), overflow], 200_000);
  const decision = decideCompaction({
    state,
    settings: compactionSettings(),
    lastMessage: overflow as unknown as AssistantMessage,
  });
  assert.equal(decision.should, true, '溢出必须压：再发一次同样的请求还是会失败');
  assert.equal(decision.reason, 'overflow');
});

test('手动 /compact：看的是「用户要求」，不看阈值', () => {
  const state = stateWith([user('你好'), assistantOk(10)], 200_000);
  const decision = decideCompaction({ state, settings: compactionSettings(), manual: true });
  assert.equal(decision.should, true);
  assert.equal(decision.reason, 'manual');
});

test('compaction.enabled=false：阈值与溢出都不触发（只有手动还能压）', () => {
  const state = stateWith([user('你好'), assistantOk(190_000)], 200_000);
  const off = compactionSettings({ enabled: false });
  assert.equal(decideCompaction({ state, settings: off }).should, false);
  assert.equal(
    decideCompaction({ state, settings: off, manual: true }).should,
    true,
    '关掉自动压不等于关掉手动压',
  );
});

test('小窗口要夹紧 reserve：否则阈值变成「永远成立」', () => {
  const clamped = effectiveCompactionSettings(compactionSettings(), 1000);
  assert.ok(
    clamped.reserveTokens <= 1000 * 0.2,
    `reserve 应夹到窗口的 20% 以内，实际 ${clamped.reserveTokens}`,
  );
  assert.ok(
    clamped.keepRecentTokens <= 1000 * 0.5,
    `keepRecent 应夹到窗口的 50% 以内，实际 ${clamped.keepRecentTokens}`,
  );

  // 默认 reserve 是 16384，窗口只有 1000 —— 不夹的话任何一次调用都会判定为「该压」。
  const state = stateWith([user('你好'), assistantOk(500)], 1000);
  assert.equal(
    decideCompaction({ state, settings: compactionSettings() }).should,
    false,
    '500/1000 不该触发（夹紧之后阈值是 800）',
  );
  assert.equal(
    decideCompaction({ state: stateWith([user('你好'), assistantOk(950)], 1000), settings: compactionSettings() })
      .should,
    true,
    '950/1000 该触发',
  );
});

test('大窗口不动配置（pi 的 16384 默认在 64k+ 的窗口上总是合理）', () => {
  const settings = compactionSettings();
  assert.deepEqual(effectiveCompactionSettings(settings, 200_000), settings);
});

test('窗口未知（0）：不夹，原样沿用配置', () => {
  const settings = compactionSettings();
  assert.deepEqual(effectiveCompactionSettings(settings, 0), settings);
});

test('lastContextTokens 跳过 aborted / error 的 usage（那一轮没真正装进去）', () => {
  const aborted = {
    role: 'assistant',
    content: [],
    usage: usage(999_999),
    stopReason: 'aborted',
    timestamp: 1,
  } as unknown as Message;
  assert.equal(
    lastContextTokens([assistantOk(1234), aborted]),
    1234,
    '中断那一轮的 usage 不可信，要看前一轮',
  );
  assert.equal(lastContextTokens([user('没有 usage')]), null);
});

// ─── 切点：压完之后消息序列仍然合法 ───

test('切点之后第一条不能是 toolResult（否则 provider 会报错）', () => {
  // 造一轮完整的「user → assistant(带 call) → toolResult」，后面再跟很多历史。
  const turn = [
    user('第一问', 9000),
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } }],
      usage: usage(100),
      stopReason: 'toolUse',
      timestamp: 2,
    } as unknown as Message,
    {
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'bash',
      content: [{ type: 'text', text: 'a'.repeat(9000) }],
      isError: false,
      timestamp: 3,
    } as unknown as Message,
  ];
  const history = Array.from({ length: 10 }, (_, i) => user(`历史${i}`, 9000));
  const plan = planCut([...turn, ...history], 20_000);
  assert.ok(plan, '有可摘的内容');
  assert.notEqual(plan.kept[0]?.role, 'toolResult', '保留的尾巴不能以 toolResult 开头');
});

test('没有可摘的内容时返回 null（不假装压过）', () => {
  assert.equal(planCut([user('很短')], 20_000), null);
});

test('切点会「往前留够 keepRecentTokens」，而不是从头切', () => {
  const messages = Array.from({ length: 30 }, (_, i) => user(`消息${i}`, 4000));
  const plan = planCut(messages, 20_000);
  assert.ok(plan);
  assert.ok(plan.kept.length > 0, '要保留最近的尾巴');
  assert.ok(
    plan.kept.length < messages.length,
    '要摘掉前面的一部分（否则压了等于没压）',
  );
  assert.equal(plan.summarized.length + plan.kept.length, messages.length, '不多不少');
});

// ─── 生成摘要（用假 stream，不打网络） ───

/**
 * 假流：真的用 pi-ai 的 `AssistantMessageEventStream` 类，不能用普通对象。
 *
 * ## 为什么不能用对象糊弄
 *
 * pi 的 `completeSummarization()` 调的是 `streamFn(...).result()` —— 它要**最终的
 * assistant 消息**，不是「把事件迭代一遍自己拼」。而 `AssistantMessageEventStream`
 * 是个带内部队列的类，`result()` 的行为（什么时候算完成、done 事件怎么用）都在类里。
 * 糊一个只有 `Symbol.asyncIterator` 的对象过去，压缩会报
 * `result is not a function` —— 而这个错只在真正调压缩时才出现。
 */
function streamOf(
  text: string,
  totalTokens = 100,
  stopReason: AssistantMessage['stopReason'] = 'stop',
): AssistantMessageEventStream {
  const message = {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'faux',
    model: 'fake',
    usage: usage(totalTokens),
    stopReason,
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
  const stream = createAssistantMessageEventStream();
  // 不 await：事件是同步 push 的，调用方（pi）自己 await result()。
  void (async () => {
    stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message } as never);
    stream.push({ type: 'done', reason: stopReason, message } as never);
  })();
  return stream;
}

test('压成功：摘要排在最前，保留的尾巴跟在后面', async () => {
  const faux = createFauxRuntime();
  const messages = Array.from({ length: 20 }, (_, i) => user(`消息${i}`, 6000));
  const outcome = await runCompaction({
    messages,
    model: faux.runtime.model,
    streamFn: () => streamOf('## Goal\n做完了该做的事'),
    settings: compactionSettings(),
    contextWindow: 40_000,
  });
  assert.ok(outcome);
  assert.equal(outcome.messages.length, 1 + outcome.keptCount);
  const first = outcome.messages[0];
  assert.ok(first && isCompactionSummary(first), '第一条必须是摘要消息');
  assert.match(String(first.content), /<summary>/, '正文包在 <summary> 里（与 pi 同形）');
  assert.match(String(first.content), /## Goal/, '摘要正文原样带上');
  assert.ok(outcome.summarizedCount > 0);
});

test('摘要写到一半被 token 上限截断（stopReason=length）：**必须**失败，不能把半截当摘要存进去', async () => {
  const faux = createFauxRuntime();
  const messages = Array.from({ length: 20 }, (_, i) => user(`消息${i}`, 6000));
  await assert.rejects(
    () =>
      runCompaction({
        messages,
        model: faux.runtime.model,
        // pi 的 `getSummarizationFailure()` 专门拦这个：length 停止意味着摘要**不完整**。
        streamFn: () => streamOf('## Goal\n做了一半就', 10, 'length'),
        settings: compactionSettings(),
        contextWindow: 40_000,
      }),
    /token cap|failed/,
    '半截摘要一旦存进 messages，模型会拿着残缺的「进度」继续干 —— 比不压糟糕得多',
  );
});

test('摘要报 error（provider 挂了）：同样失败，不返回半份结果', async () => {
  const faux = createFauxRuntime();
  const messages = Array.from({ length: 20 }, (_, i) => user(`消息${i}`, 6000));
  const broken = (): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      stream.push({
        type: 'error',
        error: new Error('summarization upstream exploded'),
      } as never);
    })();
    return stream;
  };
  await assert.rejects(
    () =>
      runCompaction({
        messages,
        model: faux.runtime.model,
        streamFn: broken,
        settings: compactionSettings(),
        contextWindow: 40_000,
      }),
    /压缩失败/,
    '失败也要说清「对话原样保留」，否则用户以为压过了',
  );
});

// ─── reducer：状态迁移 ───

function reduce(state: AgentState, action: AgentAction): AgentState {
  const r = createAgentReducer({});
  return r(state, action) as AgentState;
}

test('compact.request：开一个 pending 节点、置 compacting，但**不动 messages**', () => {
  const before = stateWith([user('还没压')], 200_000);
  const after = reduce(before, { type: 'compact.request', reason: 'manual' });
  assert.equal(after.compacting, true);
  assert.deepEqual(after.messages, before.messages, '压之前一个字都不能少（摘要还没生成）');
  const node = after.trace.nodes[after.trace.order[after.trace.order.length - 1] as string];
  assert.equal(node?.kind, 'compact');
  assert.equal(node?.status, 'pending');
  assert.match(node?.label ?? '', /手动/);
});

test('环在跑时 compact.request 被忽略（压缩会毁掉正在进行的轮次）', () => {
  const before = stateWith([user('在跑')], 200_000);
  const running: AgentState = { ...before, phase: 'thinking' };
  const after = reduce(running, { type: 'compact.request', reason: 'manual' });
  assert.equal(after.compacting, false, '不在 idle 时不许压');
  assert.equal(after.trace.order.length, running.trace.order.length, '也不该开节点');
});

test('已经在压了，第二次请求被忽略（两次摘要基于同一份历史，后写的会覆盖先写的）', () => {
  let state = stateWith([user('x')], 200_000);
  state = reduce(state, { type: 'compact.request', reason: 'manual' });
  const nodes = state.trace.order.length;
  const again = reduce(state, { type: 'compact.request', reason: 'manual' });
  assert.equal(again.trace.order.length, nodes, '不该开第二个节点');
});

test('compact.done：整份换掉 messages、闭合节点、**推进 tip**', () => {
  let state = stateWith([user('老对话1'), user('老对话2'), user('老对话3')], 200_000);
  state = reduce(state, { type: 'compact.request', reason: 'threshold' });
  const summaryMsg = {
    role: 'user',
    content: '…摘要…',
    timestamp: 1,
    tokensBefore: 900,
    compactionSummary: true,
  } as unknown as Message;
  const kept = [user('留着的那句')];
  const after = reduce(state, {
    type: 'compact.done',
    messages: [summaryMsg, ...kept],
    summary: '…摘要…',
    tokensBefore: 900,
    summarizedCount: 3,
    keptCount: 1,
    reason: 'threshold',
  });
  assert.equal(after.compacting, false);
  assert.equal(after.messages.length, 2);
  assert.ok(isCompactionSummary(after.messages[0] as Message));
  // 节点从 pending 变 ok，并且**推进 tip**（之后的事从压缩点长出来）
  const node = after.trace.nodes[after.trace.tipId ?? ''];
  assert.equal(node?.kind, 'compact', 'tip 应落在 compact 节点上');
  assert.equal(node?.status, 'ok');
  assert.match(node?.label ?? '', /超阈值压缩：3 条 → 1 条/);
  assert.equal(after.lastCompaction?.summarizedCount, 3);
});

test('compact.done 不该改动「上一轮为什么停」的说法', () => {
  let state: AgentState = {
    ...stateWith([user('x')], 200_000),
    stopReason: 'completed',
    stopCause: 'completed',
    stopCauseDetail: '模型自己说完了',
  };
  state = reduce(state, { type: 'compact.request', reason: 'manual' });
  const after = reduce(state, {
    type: 'compact.done',
    messages: [user('摘要')],
    summary: '…',
    tokensBefore: 10,
    summarizedCount: 1,
    keptCount: 0,
    reason: 'manual',
  });
  assert.equal(after.stopCause, 'completed', '压缩不是「这一轮的结果」，别改它');
  assert.equal(after.stopReason, 'completed');
});

test('compact.failed：对话一个字都不动，但要说清原因', () => {
  let state = stateWith([user('老对话')], 200_000);
  const before = state.messages;
  state = reduce(state, { type: 'compact.request', reason: 'manual' });
  const after = reduce(state, {
    type: 'compact.failed',
    error: '上下文压缩失败（对话原样保留）：网络错误',
    reason: 'manual',
  });
  assert.deepEqual(after.messages, before, '失败时对话原样保留');
  assert.equal(after.compacting, false, '不能卡在 compacting');
  assert.equal(after.stopCause, 'compact-error', '要说清是压缩失败');
  assert.match(after.stopCauseDetail ?? '', /原样保留/);
});

// ─── 自动触发（store 订阅器） ───

test('自动压缩：回合结束后超阈值就真的压（这条曾经是坏的 —— 订阅器只装在落盘那条路上）', async () => {
  const faux = createFauxRuntime();
  let summarizerCalls = 0;
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    streamFn: () => {
      // 第一次调用是摘要（自动压缩触发的），之后是普通回答。
      const isSummary = summarizerCalls === 0;
      summarizerCalls += 1;
      return streamOf(isSummary ? '## Goal\n压掉的老对话' : '好', 55_000);
    },
  });
  // 一大段历史（直接灌，不跑环）+ 一个很小的窗口。
  for (let i = 0; i < 30; i += 1) {
    store.dispatch({
      type: 'session.restored',
      message: user(`问题${i}`, 6000),
    } as AgentAction);
  }
  store.dispatch({ type: 'prompt.init', systemPrompt: 'test', tools: [] } as AgentAction);
  store.dispatch({
    type: 'model.init',
    provider: 'faux',
    modelId: 'fake',
    thinkingLevel: 'off',
    capabilities: {
      midConvoSystemMessages: false,
      midConvoToolAdditions: false,
      developerRole: false,
    },
    // 夹紧后 reserve = 12000，阈值 = 60000 - 12000 = 48000；usage 55000 会触发。
    contextWindow: 60_000,
  } as AgentAction);

  store.dispatch({ type: 'user.message', text: '第一句' } as AgentAction);
  await waitForIdle(store);
  // 等压缩（它是异步的：摘要要打一次网络）。
  for (let i = 0; i < 100 && store.getState().compacting; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }

  const state = store.getState();
  assert.ok(state.lastCompaction, '超阈值就该自动压（之前这里静默不压）');
  assert.equal(state.lastCompaction?.reason, 'threshold');
  assert.ok((state.lastCompaction?.summarizedCount ?? 0) > 0, '确实摘掉了一部分');
  assert.equal(
    isCompactionSummary(state.messages[0] as Message),
    true,
    '第一条应是摘要消息',
  );
  assert.equal(
    state.messages.length,
    1 + (state.lastCompaction?.keptCount ?? 0),
    '摘要 + 保留的尾巴，不多不少',
  );
  assert.equal(state.compacting, false, '不能卡在压缩中');
  // 树上留了一个 compact 节点，且它是 tip。
  const compactIds = state.trace.order.filter((id) => state.trace.nodes[id]?.kind === 'compact');
  const compactNode = state.trace.nodes[compactIds[compactIds.length - 1] as string];
  assert.equal(compactNode?.kind, 'compact');
  assert.equal(state.trace.tipId, compactNode?.id, '压缩推进 tip（之后的事从压缩点长出来）');
});

test('自动压缩：关着的时候真的不压（`/settings` 里关掉不是只把开关画上）', async () => {
  const faux = createFauxRuntime();
  let calls = 0;
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    // `autoCompactEnabled: false` = `settings.json` 里 `compaction.enabled: false`。
    autoCompactEnabled: false,
    streamFn: () => {
      calls += 1;
      // 与上面那条「超阈值就真的压」同一种历史与窗口：**如果**订阅器还在判，它会压。
      return streamOf('好', 55_000);
    },
  });
  for (let i = 0; i < 30; i += 1) {
    store.dispatch({ type: 'session.restored', message: user(`问题${i}`, 6000) } as AgentAction);
  }
  store.dispatch({ type: 'prompt.init', systemPrompt: 'test', tools: [] } as AgentAction);
  store.dispatch({
    type: 'model.init',
    provider: 'faux',
    modelId: 'fake',
    thinkingLevel: 'off',
    capabilities: {
      midConvoSystemMessages: false,
      midConvoToolAdditions: false,
      developerRole: false,
    },
    contextWindow: 60_000,
  } as AgentAction);
  store.dispatch({ type: 'user.message', text: '第一句' } as AgentAction);
  await waitForIdle(store);
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(store.getState().lastCompaction, null, '关掉了就不该自动压');
  assert.equal(calls, 1, '一次摘要调用都没有（只有那一轮普通回答）');
  // 30 条历史 + 这一句 + 模型那一句回答 = 32；历史一条都没被摘掉。
  assert.equal(store.getState().messages.length, 32, '历史原样，没有被摘要替换');
});

test('自动压缩：占用不高就不压（阈值没到不要白花钱）', async () => {
  const faux = createFauxRuntime();
  let calls = 0;
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    streamFn: () => {
      calls += 1;
      return streamOf('好', 1000);
    },
  });
  store.dispatch({ type: 'prompt.init', systemPrompt: 'test', tools: [] } as AgentAction);
  store.dispatch({
    type: 'model.init',
    provider: 'faux',
    modelId: 'fake',
    thinkingLevel: 'off',
    capabilities: {
      midConvoSystemMessages: false,
      midConvoToolAdditions: false,
      developerRole: false,
    },
    contextWindow: 200_000,
  } as AgentAction);
  store.dispatch({ type: 'user.message', text: '第一句' } as AgentAction);
  await waitForIdle(store);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.getState().lastCompaction, null, '1000/200000 离阈值远得很');
  assert.equal(calls, 1, '只调了一次模型（没有被摘要调用）');
});

test('自动压缩：不支持时不装订阅器（`supported: false` 就是「不装」）', () => {
  // 「不支持」= 这张 effect 表里没有 `runCompact`（Web 侧自带表时可能是这样）。
  // 那时连开关都不给：一个什么都压不了的开关就是谎。
  assert.equal(createAutoCompact({ store: {} as never, supported: false }), null);
});

test('自动压缩：关掉之后可以当场再打开（`/settings` 里那一行）', () => {
  // 一个最小的 store：`createAutoCompact` 要 subscribe（它是个订阅器）与 getState。
  const stub = {
    getState: (): never => ({}) as never,
    subscribe: (): (() => void) => () => {},
  };
  const auto = createAutoCompact({ store: stub as never, supported: true, enabled: false });
  assert.ok(auto, '不支持才不装 —— 「关着」仍然要装，否则面板里打不开');
  assert.equal(auto.enabled(), false);
  auto.setEnabled(true);
  assert.equal(auto.enabled(), true);
  auto.dispose();
});

test('compact.request 的接线：先记理由、再发 runCompact（failActionCreator 拿不到 action）', () => {
  const order: string[] = [];
  // 直接验接线本身：用 loopWiring 拼一张最小表，看两步的**顺序**。
  const wiring = loopWiring({
    runAgent: () => undefined as never,
    runTools: () => undefined as never,
    runCompact: () => {
      order.push('runCompact');
      return undefined as never;
    },
    markCompactReason: (reason) => {
      order.push(`mark:${reason}`);
    },
  });
  wiring['compact.request'](
    { type: 'compact.request', reason: 'overflow' },
    stateWith([], 1),
  );
  assert.deepEqual(
    order,
    ['mark:overflow', 'runCompact'],
    '必须先记理由再发活（effect 读的是那个变量）',
  );
});

test('compactReasonText 三种理由各有一句人话', () => {
  assert.equal(compactReasonText('manual'), '手动');
  assert.equal(compactReasonText('threshold'), '超阈值');
  assert.match(compactReasonText('overflow'), /溢出/);
});

// ─── 摘要消息的形状 ───

test('isCompactionSummary 认结构标记，不认「内容长得像」', () => {
  const fake = user('<summary>\n## Goal\n我手打的\n</summary>');
  assert.equal(
    isCompactionSummary(fake),
    false,
    '用户手打一段一模一样的文本，不该被当成压缩点（否则回放会丢真历史）',
  );
});
test('compaction.enabled：读的是 pi 那个键，写下去 pi 也认', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ela-compact-home-'));
  const previous = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = home;
  try {
    await writeFile(
      path.join(home, 'settings.json'),
      `${JSON.stringify({ compaction: { enabled: false } })}\n`,
      'utf8',
    );
    assert.equal(readCompactionEnabled(home), false, '盘上关着就是关着');
    assert.equal(await writeCompactionEnabled(true, home), true);
    assert.equal(readCompactionEnabled(home), true);
    // 键名与 pi 一致（`compaction.enabled`）—— 写错键的症状是「本项目关了、pi 还在压」。
    const onDisk = JSON.parse(await readFile(path.join(home, 'settings.json'), 'utf8')) as {
      compaction?: { enabled?: boolean };
    };
    assert.equal(onDisk.compaction?.enabled, true);
  } finally {
    if (previous === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previous;
    await rm(home, { recursive: true, force: true });
  }
});
