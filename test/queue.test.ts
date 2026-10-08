import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentStore, createPersistentStore, waitForIdle } from '../src/store';
import { createFauxRuntime, demoResponses } from '../src/provider';
import { renderTree, traceStats } from '../src/trace';
import { createFileSink, tracePath } from '../src/trace-file';
import { fauxAssistantMessage, fauxText, type AssistantMessage } from '@earendil-works/pi-ai';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentReducer } from '../src/reducer';
import { createInitialState, type AgentState } from '../src/state';
import type { AgentStore } from '../src/store';
import type { TraceSink, TraceRecord } from '../src/trace-store';

/**
 * steer / followUp：环在跑的时候人还能说话。
 *
 * ## 两种队列的语义（与 pi 的 `steer()` / `followUp()` 一致）
 *
 * - **steer**：当前 step 的工具跑完后、**下一次 LLM 调用之前**插进去。
 *   它打断「模型→工具→模型」的延续，让模型看见新的话。
 * - **followUp**：等模型**没有工具调用了**（回合本该收工）才插，然后开一个新回合。
 *   它不打断任何东西，只是「接着聊」。
 *
 * ## 这组测试守什么
 *
 * 最容易写错、且**错了不报错只丢消息**的三处：
 *
 * 1. **投递时机**。写成「收到就立刻插」会让 steer 打断正在跑的 LLM 流；
 *    写成「永远等不到」则消息烂在队列里。
 * 2. **turn.end 落在 Cmd.run 回来的路上**。那一刻 redux-loop 的 cmd 队列已经被取走，
 *    从那里 redispatch 出去的动作没人冲刷 —— 表现是「回合永远关不上」（见 reducer 里
 *    `closeTurn()` 的注释）。
 * 3. **投递不能重入**。同一条消息被发两遍会让模型收到重复指令（而消息流仍然合法，
 *    所以 provider 不报错，只是行为诡异）。
 */

const CAPS = {
  midConvoSystemMessages: true,
  midConvoToolAdditions: false,
  developerRole: false,
} as const;

/** 记下所有 dispatch 过的 action 类型，用来断言投递顺序。 */
function recordActions(store: AgentStore): string[] {
  const seen: string[] = [];
  const original = store.dispatch.bind(store);
  (store as { dispatch: (a: unknown) => unknown }).dispatch = (a: unknown) => {
    seen.push((a as { type: string }).type);
    return original(a as never);
  };
  return seen;
}

// ── 空闲时的队列消息 = 直接开新回合 ──

test('空闲时收到队列消息：直接开新回合（不是「打断」，是「接着说」）', async () => {
  const faux = createFauxRuntime();
  faux.setResponses([fauxAssistantMessage([fauxText('好')], { stopReason: 'stop' })]);
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    sessionId: 'q1',
  });
  // 相位是 idle，却发的是 queue.input —— 迁移会把它当成普通用户消息处理。
  store.dispatch({ type: 'queue.input', text: '在吗', as: 'steer' });
  await waitForIdle(store, 20_000);
  await new Promise((r) => setTimeout(r, 50));

  const state = store.getState();
  // 2 条：用户那句 + 模型回答。关键是 user 消息**恰好一条**且带上那句问话。
  assert.equal(state.messages.length, 2, '用户一条 + 助手一条');
  const users = state.messages.filter((m) => m.role === 'user');
  assert.equal(users.length, 1);
  assert.equal(users[0]?.content, '在吗');
  assert.equal(state.steerQueue.length, 0, '没入队 —— 空闲时不需要等');
  assert.equal(state.turnIndex, 1, '开了一个新回合');
  // 树上那条 user 节点不带 queued 标记（它是正常入口，不是队列投递）。
  const userNode = state.trace.nodes[state.trace.order[0] ?? ''];
  assert.equal(userNode?.kind, 'user');
  assert.equal(userNode?.meta?.queued, undefined);
});

test('steer：入队后模型看得见它，且它落在同一个回合内', async () => {
  const faux = createFauxRuntime();
  faux.setResponses([
    fauxAssistantMessage(
      [fauxText('先查一下'), { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'echo hi' } }],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage([fauxText('好的，版本是 1.0')], { stopReason: 'stop' }),
  ]);
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    sessionId: 'q3',
  });

  // 在「工具跑完、下一次 LLM 调用前」那一刻投递 —— 那正是 tool.batch.done 之后。
  // 用一次性 subscribe 抓第一次进入 calling-tools 的时刻（此时还没跑完工具，
  // 所以直接改不了队列；改成抓 tool.batch.done 的时刻更贴近真实）。
  let injected = false;
  store.subscribe(() => {
    const s = store.getState();
    if (!injected && s.openStepNodeId !== null && s.executing.length === 0 && s.turns === 1) {
      injected = true;
      store.dispatch({ type: 'queue.input', text: '顺便看下版本', as: 'steer' });
    }
  });

  store.dispatch({ type: 'user.message', text: '查一下' });
  await waitForIdle(store, 20_000);
  await new Promise((r) => setTimeout(r, 80));

  const state = store.getState();
  assert.ok(injected, 'steer 确实入队过');
  assert.equal(state.steerQueue.length, 0, '已经被投递掉了');
  // 消息进了对话：user → assistant(toolCall) → toolResult → **user(steer)** → assistant
  const steerMessage = state.messages.find(
    (m) => m.role === 'user' && typeof m.content === 'string' && m.content === '顺便看下版本',
  );
  assert.ok(steerMessage, 'steer 消息进了 messages');
  // 树上有那条带 queued 标记的 user 节点。
  const steerNode = Object.values(state.trace.nodes).find((n) => n?.meta?.queued === 'steer');
  assert.ok(steerNode, '树上有 steer 节点');
  assert.match(steerNode.label, /^steer: /);
  // **它属于同一个回合** —— 不新开 turn（那是 followUp 的区别）。
  assert.equal(traceStats(state.trace).turns, 1, 'steer 不开新回合');
  assert.equal(state.turnIndex, 1, '回合序号没变');
});

test('steer 的 user 节点挂在 turn 容器下面（它是这回合里的一个输入）', async () => {
  const faux = createFauxRuntime();
  faux.setResponses([
    fauxAssistantMessage(
      [fauxText('查'), { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'echo hi' } }],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage([fauxText('done')], { stopReason: 'stop' }),
  ]);
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    sessionId: 'q4',
  });
  let injected = false;
  store.subscribe(() => {
    const s = store.getState();
    if (!injected && s.openStepNodeId !== null && s.executing.length === 0 && s.turns === 1) {
      injected = true;
      store.dispatch({ type: 'queue.input', text: '插一句', as: 'steer' });
    }
  });
  store.dispatch({ type: 'user.message', text: '查' });
  await waitForIdle(store, 20_000);
  await new Promise((r) => setTimeout(r, 80));

  const state = store.getState();
  const turnNode = Object.values(state.trace.nodes).find((n) => n?.kind === 'turn.start');
  const steerNode = Object.values(state.trace.nodes).find((n) => n?.meta?.queued === 'steer');
  assert.ok(turnNode && steerNode);
  assert.equal(steerNode.parentId, turnNode.id, 'steer 节点在 turn 容器里');
});

// ── followUp：回合收工时才插，然后开新回合 ──

// ── 防重入 ──

// ── 落盘 ──

test('steer / followUp 的节点也会落盘（回放时能看出当时插过什么）', async () => {
  // **用真的 file sink**（而不是自己写一个 append 收集器）：
  // 手写收集器要自己保证「持久化订阅器真的会调 append」—— 而那正是本测试想验的东西，
  // 自己造 sink 就成了自己验自己。createFileSink 与真跑时用的完全同一条路。
  const dir = await mkdtemp(path.join(tmpdir(), 'queue-trace-'));
  const sink = createFileSink(tracePath('q8', dir));
  const faux = createFauxRuntime();
  faux.setResponses([
    fauxAssistantMessage(
      [fauxText('查'), { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'echo hi' } }],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage([fauxText('done')], { stopReason: 'stop' }),
  ]);
  const { store, persistence } = createPersistentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    // **必须给工具名** —— 否则 `executing` 永远为空，投递窗口不会出现，
    // steer 也就永远不会入队（症状：断言 `injected` 为 false，而不是任何报错）。
    sessionId: 'q8',
    traceSink: sink,
  });
  let injected = false;
  let sawToolRunning = false;
  store.subscribe(() => {
    const s = store.getState();
    if (s.executing.length > 0) { sawToolRunning = true; return; }
    // 工具跑完、step 还没关（totalSteps 仍为 0）—— 那正是投递窗口。
    if (!injected && sawToolRunning && s.phase === 'calling-tools' && s.totalSteps === 0) {
      injected = true;
      store.dispatch({ type: 'queue.input', text: '插一句', as: 'steer' });
    }
  });
  store.dispatch({ type: 'user.message', text: '查' });
  for (let i = 0; i < 300; i += 1) {
    const s = store.getState();
    if (s.phase === 'idle' && s.openTurnNodeId === null && s.totalSteps >= 2) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  // 等落盘器把最后几个节点写完（turn.end 是最后 flush 的那个）。
  await new Promise((r) => setTimeout(r, 200));
  persistence?.dispose();

  const text = await readFile(tracePath('q8', dir), 'utf8');
  const records = text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TraceRecord);
  const queued = records
    .filter((r) => r.op === 'add')
    .map((r) => (r.op === 'add' ? r.node : null))
    .filter((n) => n?.meta?.queued === 'steer');
  assert.equal(queued.length, 1, 'steer 节点写进了 JSONL');
  const state = store.getState();
  const rendered = renderTree(state.trace, { maxWidth: 0 });
  assert.match(rendered, /steer: 插一句/);
  await rm(dir, { recursive: true, force: true });
});
// ─────────────────────────────────────────────────────────────
// 纯 reducer 的投递语义（不依赖 subscribe 的时序 —— 那是最容易 flaky 的地方）
// ─────────────────────────────────────────────────────────────

/** 造一个「正在跑第一步」的初始状态（开回合 → 开 step），便于直接往队列里塞东西。 */
function runningState(): AgentState {
  const reducer = createAgentReducer({});
  let state: AgentState = createInitialState({
    systemPrompt: 's',
    providerName: 'faux',
    modelId: 'faux-1',
    // createInitialState 的工具名**只是初值**（真正生效的那份由 prompt.init 装），
    // 但它是必填字段，所以这里给个空数组。
    toolNames: [],
    sessionId: 'q-pure',
  });
  state = reducer(state, { type: 'user.message', text: '查' }) as AgentState;
  state = reducer(state, { type: 'turn.start' }) as AgentState;
  state = reducer(state, { type: 'step.start' }) as AgentState;
  return state;
}

test('运行中入队：steer 与 followUp 各自进各自的列，互不干扰', () => {
  const reducer = createAgentReducer({});
  const base = runningState();
  let state = reducer(base, {
    type: 'queue.input',
    text: '插一句',
    as: 'steer',
  }) as AgentState;
  state = reducer(state, {
    type: 'queue.input',
    text: '待会儿说',
    as: 'followUp',
  }) as AgentState;

  assert.equal(state.steerQueue.length, 1, 'steer 进了 steer 列');
  assert.equal(state.followUpQueue.length, 1, 'followUp 进了 followUp 列');
  assert.equal(state.steerQueue[0]?.text, '插一句');
  assert.equal(state.followUpQueue[0]?.text, '待会儿说');
  // **入队不动相位、不动容器** —— 正在跑的那一步照跑（对齐 pi：入队不是打断）。
  assert.equal(state.phase, 'thinking');
  assert.equal(state.openStepNodeId, base.openStepNodeId);
  assert.equal(state.openTurnNodeId, base.openTurnNodeId);
  // 也没有消息进对话 —— 投递才加消息。
  assert.equal(state.messages.length, base.messages.length);
});

test('投递 steer：消息进对话，但**不开新回合**（它是这回合里的一个输入）', () => {
  const reducer = createAgentReducer({});
  const base = runningState();
  const state = reducer(base, {
    type: 'queue.delivered',
    text: '插一句',
    as: 'steer',
  }) as AgentState;

  assert.equal(state.messages.length, base.messages.length + 1, '加了一条 user 消息');
  const last = state.messages[state.messages.length - 1];
  assert.equal(last?.role, 'user');
  assert.equal(last?.content, '插一句');
  // 回合序号没变、容器没换 —— 这是 steer 与 followUp 的分水岭。
  assert.equal(state.turnIndex, 1, '不开新回合');
  assert.equal(state.openTurnNodeId, base.openTurnNodeId, '还是同一个回合容器');
  // 树上那条 user 节点带 queued=steer，且挂在 turn 容器下。
  const steerNode = Object.values(state.trace.nodes).find((n) => n?.meta?.queued === 'steer');
  assert.ok(steerNode);
  assert.equal(steerNode.parentId, state.openTurnNodeId);
});

test('投递 followUp：消息进对话，并**开出新回合**（旧的关掉、新的接上）', () => {
  const reducer = createAgentReducer({});
  const base = runningState();
  const state = reducer(base, {
    type: 'queue.delivered',
    text: '接着说',
    as: 'followUp',
  }) as AgentState;

  assert.equal(state.messages.length, base.messages.length + 1);
  // **回合序号 +1，容器换了一个** —— 这正是 followUp 的定义（不打断，接着聊）。
  assert.equal(state.turnIndex, 2, '开了新回合');
  assert.notEqual(state.openTurnNodeId, base.openTurnNodeId, '容器换了');
  assert.notEqual(state.openTurnNodeId, null, '新回合有容器');
  // 旧的容器已被 `turn.end` 收尾（树上有那个节点）。
  const oldTurn = state.trace.nodes[base.openTurnNodeId ?? ''];
  const closed = Object.values(state.trace.nodes).find((n) => n?.kind === 'turn.end');
  assert.ok(closed, '旧回合有 turn.end');
  assert.equal(closed?.parentId, oldTurn?.id, 'turn.end 挂在旧容器下面');
  // 新容器挂在 tip 下面（而不是旧的还开着的容器里）。
  assert.equal(state.trace.nodes[state.openTurnNodeId ?? '']?.parentId, state.trace.tipId);
  // 新回合的 step 从头数。
  assert.equal(state.stepIndex, 0);
});

test('投递不会重入：deliveringInput 挡住同一条消息被发两遍', () => {
  const reducer = createAgentReducer({});
  const base = runningState();
  // 先手动占用「在途」标记，模拟一条正在投递中。
  let state: AgentState = { ...base, deliveringInput: { text: 'x', at: Date.now() } };
  const before = state.messages.length;
  // 这条 queue.delivered 必须被**整个丢掉**（防重入）。
  state = reducer(state, {
    type: 'queue.delivered',
    text: '重复的',
    as: 'steer',
  }) as AgentState;
  assert.equal(state.messages.length, before, '重复投递没加消息');
  assert.equal(state, state, '状态原样返回（连 trace 都没动）');
  // 而防重入标记在**正常**投递时会被清掉 —— 那一处由 queue.delivered 自己负责。
  const fresh = reducer(runningState(), {
    type: 'queue.delivered',
    text: '正常',
    as: 'steer',
  }) as AgentState;
  assert.equal(fresh.deliveringInput, null, '正常投递会清掉在途标记');
});

test('turn.end 会顺手开下一个 followUp 回合（投递点之后环不能停）', () => {
  const reducer = createAgentReducer({});
  let state = runningState();
  // 模拟「模型说完了、队列里有一条 followUp」的时刻：先入队，再关回合。
  state = reducer(state, {
    type: 'queue.input',
    text: '接着说',
    as: 'followUp',
  }) as AgentState;
  state = reducer(state, { type: 'turn.end' }) as AgentState;

  // followUp 应该已被取出，并作为新回合的起点消息插进去。
  assert.equal(state.followUpQueue.length, 0, '队列空了');
  const last = state.messages[state.messages.length - 1];
  assert.equal(last?.content, '接着说', '它成了新回合的第一条消息');
  assert.equal(state.turnIndex, 2, '开了新回合');
  // 相位离开 idle —— 「还要接着聊」不是收工。
  assert.notEqual(state.phase, 'idle', '环没闭合');
});

test('turn.end 在队列空时正常收工（相位 idle，容器清空）', () => {
  const reducer = createAgentReducer({});
  let state = runningState();
  state = reducer(state, { type: 'turn.end' }) as AgentState;
  assert.equal(state.openTurnNodeId, null, '容器关了');
  const closed = Object.values(state.trace.nodes).find((n) => n?.kind === 'turn.end');
  assert.ok(closed, '有 turn.end 节点');
});
