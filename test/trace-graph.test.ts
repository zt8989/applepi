import test from 'node:test';
import assert from 'node:assert/strict';
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai';
import { createAgentStore, waitForIdle } from '../src/store';
import { createFauxRuntime } from '../src/provider';
import { createInitialState } from '../src/state';
import { createAgentReducer } from '../src/reducer';
import { appendNode, createTraceTree, renderTree, traceRows, type AgentState } from '../src/index';
import type { AgentAction } from '../src/actions';

/**
 * 渲染的**形状**：lazygit 那样的轨道树，缩进只由「轮」与「步」这两个容器给。
 *
 * ## 规则
 *
 * - `turn.start` / `step.start` **无条件**给子孙加一级缩进；别的节点不加
 *   （`llm.result` → `tool.call` → `tool.result` 是同一件事的两半，都在步里面那一列）。
 * - `turn.end` / `step.end` 画在**自己容器那一列**，符号 `└─` —— 于是括号是闭合的。
 * - **所有**节点都画 `○`（包括当前 tip）；tip 靠加粗区分（`emphasizedTraceLine()`），
 *   而这几个测试走的是 `renderTree()`／`traceRows()`（纯文本、不上色），所以这里
 *   看不到 tip —— 意不在字形。成败靠**颜色**（红加粗 / 绿），不再有 `✗` / `✓` 字符。
 *
 * ## 这组测试守的是什么
 *
 * 1. **缩进用完即还**：第 2 轮的缩进第 1 轮一样，不会随回合数一格格往右跑。
 *    这是「按容器缩进」而不是「按父子关系缩进」的全部意义 —— 轨迹树的链是一条直线，
 *    每个新回合都挂在上一个回合的 `turn.end` 底下，按父子缩进会长出一条阶梯。
 * 2. **容器的开与关在同一列**（`○  step.start` 与 `└─ step.end` 对齐）。
 * 3. **回合没有 `turn.end` 时也要收口**（那是真实存在的中间态，见 `traceRows` 的注释）。
 *
 * 早先这一组叫 `trace-flat.test.ts`，守的是「整棵树拉平、只有出错才画树枝」。
 * 改成轨道缩进之后那个约定整体作废，所以文件跟着换名 —— 留着会让名字撒谎。
 */

const usage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const assistantMessage = (
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
): AssistantMessage =>
  ({
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'faux',
    model: 'fake',
    usage: usage(),
    stopReason,
    timestamp: 1,
  }) as unknown as AssistantMessage;

const bashCall = (id: string, command: string): ToolCall => ({
  type: 'toolCall',
  id,
  name: 'bash',
  arguments: { command },
});

const CAPS = {
    midConvoSystemMessages: true,
    midConvoToolAdditions: false,
    developerRole: false,
} as const;

/** 从初始状态出发，依序 dispatch 一串 action（不开环，纯看 reducer 造出来的树）。 */
function play(...actions: AgentAction[]): AgentState {
  const reducer = createAgentReducer({});
  let state: AgentState = createInitialState({
    systemPrompt: 's',
    providerName: 'faux',
    modelId: 'fake',
    toolNames: [],
    sessionId: 'test',
  });
  for (const action of actions) state = reducer(state, action) as AgentState;
  return state;
}

/** 把渲染结果按行拆开，方便逐行比（去掉行首行尾空白）。 */
function lines(rendered: string): string[] {
  return rendered.split('\n').map((line) => line.trimEnd());
}

/** 把耗时（`12ms` / `1.2s`）打码 —— 它随机器快慢变，不该进逐字断言。 */
function maskDurations(rendered: string): string[] {
  return lines(rendered).map((line) => line.replace(/ \d+(\.\d+)?m?s/g, ' <t>'));
}

/** 每一行的行首轨道宽度（`│  ` 数几段）。用来断言「缩进几层」。 */
function indentOf(line: string): number {
  return line.split('│  ').length - 1;
}

// ── 纯 reducer 的形状（不需要真跑环） ──

test('一轮一步：轮一层、步一层，容器开与关在同一列', () => {
  const state = play(
    { type: 'user.message', text: '算一下' },
    { type: 'turn.start' },
    { type: 'step.start' },
    { type: 'llm.done', message: assistantMessage([{ type: 'text', text: '42' }], 'stop') },
    { type: 'turn.end' },
  );
  const rendered = renderTree(state.trace, { maxWidth: 0 });
  console.log(`\n${rendered}\n`);
  assert.deepEqual(maskDurations(rendered), [
    '○  n1 user: 算一下 <t>',
    '○  n2 turn.start: 回合 1',
    '│  ○  n3 step.start: 第 1 步 <t> (provider=faux, model=fake)',
    '│  │  ○  n4 llm.result: 42 <t>',
    '│  └─ n5 step.end: 第 1 步结束（0 个工具调用） <t> (tools=0)',
    '└─ n6 turn.end: 回合 1 结束：模型说完了 <t> (reason=completed, steps=1)',
  ]);
});

test('缩进用完即还：第 2 轮不该比第 1 轮深', () => {
  // 这是整组测试的**核心**。轨迹树的链是一条直线：第 2 轮的 user 挂在上一个回合的
  // `turn.end` 底下（tip 推进到那里），所以按父子关系缩进的话第 2 轮在第 3 层、
  // 第 10 轮在第 21 层 —— 屏幕上一条永远往右的阶梯。按容器缩进才会「出去一层、回来一层」。
  const turn = (text: string): AgentAction[] => [
    { type: 'user.message', text },
    { type: 'turn.start' },
    { type: 'step.start' },
    { type: 'llm.done', message: assistantMessage([{ type: 'text', text: '好' }], 'stop') },
    { type: 'turn.end' },
  ];
  const state = play(...turn('第一句'), ...turn('第二句'), ...turn('第三句'));
  const rendered = renderTree(state.trace, { maxWidth: 0 });
  console.log(`\n${rendered}\n`);

  for (const line of lines(rendered)) {
    if (line === '') continue;
    // 三轮会话里**没有任何一行**超过一层缩进（轮 1 层 + 步 1 层）。
    assert.ok(indentOf(line) <= 2, `不该超过两层缩进，但拿到：${JSON.stringify(line)}`);
  }
  // 三句 user 全在最左列。
  const userLines = lines(rendered).filter((line) => line.includes(' user: '));
  assert.equal(userLines.length, 3);
  for (const line of userLines) assert.equal(indentOf(line), 0, `user 该在最左列：${line}`);
  // 三个 turn.start 也全在最左列，三个 turn.end 都是 `└─`（统一一种符号 —— 包括
  // 最后一个同时是 tip 的那个）。
  assert.equal(lines(rendered).filter((line) => /^○  n\d+ turn\.start/.test(line)).length, 3);
  assert.equal(lines(rendered).filter((line) => /^└─ n\d+ turn\.end/.test(line)).length, 3);
});

test('装载节点（prompt.* / model.init）平铺 —— 它们本来就并列，不是链', () => {
  const state = play(
    { type: 'prompt.init', systemPrompt: '你是…', tools: [] },
    {
      type: 'model.init',
      provider: 'faux',
      modelId: 'fake',
      thinkingLevel: 'off',
      capabilities: CAPS,
    },
    { type: 'user.message', text: '在吗' },
  );
  const rendered = renderTree(state.trace, { maxWidth: 0 });
  console.log(`\n${rendered}\n`);
  // `prompt.tools` 在树上是 `prompt.base` 的孩子，但它们都**不是容器** —— 所以一样平铺。
  for (const line of lines(rendered)) {
    if (line === '') continue;
    assert.equal(indentOf(line), 0, `根层节点不该有缩进：${JSON.stringify(line)}`);
  }
});

test('重试：两个 step 块并排在轮的缩进里，各自 `└─` 收口', () => {
  const state = play(
    { type: 'user.message', text: '你好' },
    { type: 'turn.start' },
    { type: 'step.start' },
    { type: 'llm.failed', error: 'LLM 调用超时', kind: 'timeout' },
    { type: 'step.start' },
    { type: 'llm.done', message: assistantMessage([{ type: 'text', text: '好了' }], 'stop') },
  );
  const rendered = renderTree(state.trace, { maxWidth: 0 });
  console.log(`\n${rendered}\n`);

  // 两个 step 容器是兄弟 → 同一个缩进（1 层），不是一个比一个深。
  assert.match(rendered, /^│  ○  n3 step\.start: 第 1 步/m);
  assert.match(rendered, /^│  ○  n6 step\.start: 第 2 步（重试）/m);
  // 各自的闭合点与自己的容器同列（`step.end` 先弹栈再画）。
  assert.match(rendered, /^│  └─ n5 step\.end/m);
  assert.match(rendered, /^│  └─ n8 step\.end/m);
  // 失败那个的 error 孩子比它深一层。
  assert.match(rendered, /^│  │  ○  n4 error: LLM 调用超时/m);
  // user 在最左列（它不开缩进）。
  assert.match(rendered, /^○  n1 user: 你好/m);
});

test('回合没有 turn.end 时，下一句话也要从最左列开始', () => {
  // 真实存在的中间态：`turn.end` 是环转 idle **之后**另发的一条 Cmd，
  // 用户看到答案就接着说下一句时会挤在它前面。那一刻新 user 的 parent 取 tip，
  // 落在上一个回合**里面** —— 只认树的话，第二轮会被缩进到上一轮的括号里。
  const state = play(
    { type: 'user.message', text: '第一句' },
    { type: 'turn.start' },
    { type: 'step.start' },
    { type: 'llm.done', message: assistantMessage([{ type: 'text', text: '好' }], 'stop') },
    // 注意：这里**故意不**发 turn.end。
    { type: 'user.message', text: '第二句' },
    { type: 'turn.start' },
    { type: 'step.start' },
  );
  const rendered = renderTree(state.trace, { maxWidth: 0 });
  console.log(`\n${rendered}\n`);

  assert.match(rendered, /^○  n6 user: 第二句/m);
  assert.match(rendered, /^○  n7 turn\.start: 回合 2/m);
  assert.match(rendered, /^│  ○  n8 step\.start: 第 1 步/m);
  // 第 1 轮里那几行的缩进不受影响。
  assert.match(rendered, /^│  │  ○  n4 llm\.result: 好/m);
});

test('树结构本身没变：缩进只影响画法，不影响父子关系', () => {
  // 防「为了让界面好看把树改平了」—— 那会让 tip、重试的分叉、回放全失去意义。
  const state = play(
    { type: 'user.message', text: '你好' },
    { type: 'turn.start' },
    { type: 'step.start' },
    { type: 'llm.failed', error: '超时', kind: 'timeout' },
    { type: 'step.start' },
    { type: 'llm.done', message: assistantMessage([{ type: 'text', text: '好了' }], 'stop') },
  );
  const steps = state.trace.order.filter((id) => state.trace.nodes[id]?.kind === 'step.start');
  const userNode = state.trace.order[0] ?? '';
  const turnNode = state.trace.order[1] ?? '';
  assert.equal(steps.length, 2);
  // 两个 step 仍是**同一个父**（重试的 git 语义核心，见 trace.ts 的文件注释）。
  assert.equal(state.trace.nodes[turnNode]?.kind, 'turn.start');
  assert.equal(state.trace.nodes[turnNode]?.parentId, userNode, 'turn 挂在 user 下面');
  for (const id of steps) {
    assert.equal(state.trace.nodes[id]?.parentId, turnNode, '缩进不能动父子关系');
  }
  // 成功后才推进 tip —— 而且推进的是 `llm.result`（n7），**不是**随后的 `step.end`。
  assert.equal(state.trace.tipId, 'n7', 'tip 是 llm.result，不是 step.end');
  assert.equal(state.trace.nodes['n7']?.kind, 'llm.result');
  assert.equal(state.trace.nodes['n8']?.kind, 'step.end');
});

test('所有节点都是 `○` —— tip 不再换字形（早先 tip 是 `◎`，树上有两种圈）', () => {
  const state = play(
    { type: 'user.message', text: '你好' },
    { type: 'turn.start' },
    { type: 'step.start' },
    { type: 'llm.done', message: assistantMessage([{ type: 'text', text: '好了' }], 'stop') },
    { type: 'turn.end' },
  );
  const rows = traceRows(state.trace, { maxWidth: 0 });
  // 一个行首符号只有两种：`○`（节点）与 `└─`（容器闭合点）—— `◎` 这个字形彻底没了。
  for (const row of rows) {
    assert.ok(/^(│  )*(○  |└─ )$/.test(row.prefix), `行首符号只该是 ○ 或 └─：${JSON.stringify(row.prefix)}`);
  }
  assert.equal(rows.filter((row) => row.prefix.includes('◎')).length, 0, '不该再有 ◎');
  // 仍然有唯一的 tip（它只是不再体现在字形上，而是加粗 —— 纯文本这层看不出来，
  // 所以判据本身在 tui-render.test.ts 里测 `emphasizedTraceLine()`）。
  assert.equal(rows.filter((row) => row.node.id === state.trace.tipId).length, 1);
  // 回合正常说完之后 tip 就是 `turn.end`，而它现在与其它闭合点长得一模一样。
  assert.equal(state.trace.nodes[state.trace.tipId ?? '']?.kind, 'turn.end');
  const endTip = rows.find((row) => row.node.id === state.trace.tipId);
  assert.equal(endTip?.prefix, '└─ ');
});

test('每一行都带一段轨道前缀，且 `traceRows` 与 `renderTree` 是同一份画法', () => {
  const state = play(
    { type: 'user.message', text: '你好' },
    { type: 'turn.start' },
    { type: 'step.start' },
    { type: 'llm.done', message: assistantMessage([{ type: 'text', text: '好了' }], 'stop') },
  );
  const rows = traceRows(state.trace, { maxWidth: 0 });
  const rendered = renderTree(state.trace, { maxWidth: 0 });
  const body = rendered.split('\n');
  assert.equal(rows.length, body.length);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    assert.ok(row);
    assert.equal(row.text, body[i], 'renderTree 必须就是 rows 拼起来的');
    assert.ok(row.text.startsWith(row.prefix), 'text 以 prefix 开头');
  }
});

test('插话（steer）属于当前回合 —— 它来了不收口', () => {
  // 手接一棵树：user → turn → step → result，然后在**回合还开着**的时候插一条 user。
  // 两种 user 的区别就在 `meta.queued`：`steer` 是插话（属于当前回合），其余是新的一句话。
  let tree = createTraceTree('s');
  const n1 = appendNode(tree, null, 'user', { status: 'ok', label: '你好', createdAt: 0, endedAt: 0 });
  tree = n1.tree;
  const n2 = appendNode(tree, n1.node.id, 'turn.start', { status: 'pending', label: '回合 1', createdAt: 1 });
  tree = n2.tree;
  const n3 = appendNode(tree, n2.node.id, 'step.start', { status: 'pending', label: '第 1 步', createdAt: 2 });
  tree = n3.tree;
  const n4 = appendNode(tree, n3.node.id, 'llm.result', { status: 'ok', label: '我来查', createdAt: 3, endedAt: 3 });
  tree = n4.tree;
  const steer = appendNode(tree, n2.node.id, 'user', {
    status: 'ok',
    label: 'steer: 顺便看下版本',
    meta: { queued: 'steer' },
    createdAt: 4,
    endedAt: 4,
  });
  const rendered = renderTree(steer.tree, { maxWidth: 0 });
  console.log(`\n${rendered}\n`);
  // 插话那一行仍在轮/步的缩进里（它没有把括号弹掉）。它是最后一个推进 tip 的节点 ——
  // 而 tip 不再换字形，所以这里也是普通的 `○`（加粗在 `emphasizedTraceLine()` 那个判据里）。
  assert.match(rendered, /^│  │  ○  n5 user: steer: 顺便看下版本/m);
});

// ── 并行工具要走真环（工具节点是 effect 开的，reducer 造不出来） ──

test('并行工具：两个都是一层步缩进里的两行，谁也不是谁的孩子', async () => {
  const faux = createFauxRuntime();
  let calls = 0;
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    streamFn: () => {
      calls += 1;
      const message =
        calls === 1
          ? assistantMessage(
              [
                { type: 'text', text: '并行' },
                bashCall('c1', 'echo one'),
                bashCall('c2', 'exit 1'),
              ],
              'toolUse',
            )
          : assistantMessage([{ type: 'text', text: '好了' }], 'stop');
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'done', reason: message.stopReason, message } as never;
        },
      } as never;
    },
  });

  store.dispatch({ type: 'user.message', text: '查两个' });
  await waitForIdle(store, 30_000);
  const state = store.getState();
  const rendered = renderTree(state.trace, { maxWidth: 0 });
  console.log(`\n${rendered}\n`);

  // 两个 tool.call 是**兄弟**（同一个 llm.result 下的两行），缩进一样。
  const callLines = lines(rendered).filter((line) => line.includes(' tool.call: '));
  assert.equal(callLines.length, 2);
  assert.equal(indentOf(callLines[0] ?? ''), 2, `tool.call 该在步里面那一列：${callLines[0]}`);
  assert.equal(indentOf(callLines[1] ?? ''), 2, `两个 tool.call 同层：${callLines[1]}`);
  assert.notEqual(callLines[0], callLines[1]);
  // 树形没被拉坏：两个 tool.call 的父仍是那个 llm.result，各自挂着自己的结果/错误。
  for (const line of callLines) {
    const id = /n(\d+)/.exec(line)?.[0] ?? '';
    const node = state.trace.nodes[id];
    assert.equal(state.trace.nodes[node?.parentId ?? '']?.kind, 'llm.result');
    const kids = state.trace.order.filter((other) => state.trace.nodes[other]?.parentId === id);
    assert.equal(kids.length, 1, '每个 tool.call 下挂着一个结果或一个 error');
  }
  // 失败那个是 error 节点，不是 tool.result。
  assert.match(rendered, /○  n\d+ error: .*Command exited with code 1/);
});
