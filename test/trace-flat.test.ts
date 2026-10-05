import test from 'node:test';
import assert from 'node:assert/strict';
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai';
import { createAgentStore, waitForIdle } from '../src/store';
import { createFauxRuntime } from '../src/provider';
import { createInitialState } from '../src/state';
import { createAgentReducer } from '../src/reducer';
import { renderTree, type AgentState } from '../src/index';
import type { AgentAction } from '../src/actions';

/**
 * 渲染的**形状**：单链拉平，只在真有分叉时画树。
 *
 * ## 为什么要改
 *
 * 一次正常对话在树里是一条长链（user → attempt → result → tool → result → attempt…）。
 * 照 git 那样层层缩进，它渲染出来是 5~7 层的阶梯，右半边全空 —— 而它**没有任何分支**，
 * 那样的缩进是纯噪声，害得人往右看也看不出什么。
 *
 * 规则：**父节点只有一个孩子时这一层不缩进**（就是列表里的一行）；出现第二个孩子
 * （重试分叉 / 并行工具）才切回树枝画法。树本身没变，只是不再把单链画成阶梯。
 *
 * 这组测试守的正是「什么时候该缩进」—— 它是纯展示层的约定，但一旦退回去
 * （比如有人「顺手」把 flat 判断删了），界面会悄悄变得又宽又空，没人立刻发现。
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

/** 除了 HEAD 行，每一行都必须以状态符开头 —— 那就是「没有缩进」。 */
function assertAllFlat(rendered: string, what: string): void {
  for (const line of rendered.split('\n')) {
    if (line === '' || line.startsWith('HEAD')) continue;
    assert.match(line, /^[✓✗⊘·] n\d+ /, `${what}不该有缩进，但这一行有：${JSON.stringify(line)}`);
  }
}

// ── 纯 reducer 的形状（不需要真跑环） ──

test('正常对话：一条链 = 一张平铺的列表，一行缩进都没有', () => {
  const state = play(
    { type: 'user.message', text: '算一下' },
    { type: 'agent.run' },
    { type: 'llm.done', message: assistantMessage([{ type: 'text', text: '42' }], 'stop') },
  );
  assertAllFlat(renderTree(state.trace, { maxWidth: 0 }), '单链');
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
  assertAllFlat(renderTree(state.trace, { maxWidth: 0 }), '根层的节点');
});

test('重试：同一父下的第 2 个 attempt 才开始缩进', () => {
  const state = play(
    { type: 'user.message', text: '你好' },
    { type: 'agent.run' },
    { type: 'llm.failed', error: 'LLM 调用超时', kind: 'timeout' },
    { type: 'agent.run' },
    { type: 'llm.done', message: assistantMessage([{ type: 'text', text: '好了' }], 'stop') },
  );
  const rendered = renderTree(state.trace, { maxWidth: 0 });
  console.log(`\n${rendered}\n`);

  // 两个 attempt 是兄弟 → 真的有分叉，树枝要画出来。
  assert.match(rendered, /├── ✗ n2 llm\.attempt/);
  assert.match(rendered, /└── ✓ n4 llm\.attempt/);
  // user 只有一个孩子（那棵分叉树），所以它自己**不**缩进 —— 分叉从它下面才开始。
  assert.match(rendered, /^✓ n1 user/m);
});

test('树结构本身没变：拉平只影响画法，不影响父子关系', () => {
  // 防「为了让界面好看把树改平了」—— 那会让 tip、分叉、回放全失去意义。
  const state = play(
    { type: 'user.message', text: '你好' },
    { type: 'agent.run' },
    { type: 'llm.failed', error: '超时', kind: 'timeout' },
    { type: 'agent.run' },
    { type: 'llm.done', message: assistantMessage([{ type: 'text', text: '好了' }], 'stop') },
  );
  const attempts = state.trace.order.filter((id) => state.trace.nodes[id]?.kind === 'llm.attempt');
  const userNode = state.trace.order[0];
  assert.equal(attempts.length, 2);
  // 两个 attempt 仍是**同一个父**（git 语义的核心，见 trace.ts 的文件注释）。
  for (const id of attempts) {
    assert.equal(state.trace.nodes[id]?.parentId, userNode, '拉平不能动父子关系');
  }
  // 成功后才推进 tip。
  assert.equal(state.trace.tipId, state.trace.order[state.trace.order.length - 1]);
});

// ── 并行工具要走真环（工具节点是 effect 开的，reducer 造不出来） ──

test('并行工具：一个 llm.result 下多个 tool.attempt 才缩进', async () => {
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
                bashCall('c2', 'echo two'),
              ],
              'toolUse',
            )
          : assistantMessage([{ type: 'text', text: '两个都拿到了' }], 'stop');
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'done', reason: message.stopReason, message } as never;
        },
      } as never;
    },
  });

  store.dispatch({ type: 'user.message', text: '查两个' });
  const state = await waitForIdle(store);
  const rendered = renderTree(state.trace, { maxWidth: 0 });
  console.log(`\n${rendered}\n`);

  // 两个 tool.attempt 是兄弟 → 缩进。
  assert.match(rendered, /├── ✓ n\d+ tool\.attempt/);
  assert.match(rendered, /└── ✓ n\d+ tool\.attempt/);
  // 上游的 user / attempt / result 都是单孩子 → 平铺。
  assert.match(rendered, /^✓ n1 user/m);
  assert.match(rendered, /^✓ n\d+ llm\.result/m);
  // 第二个 tool.result 挂在自己的 tool.attempt 下（不推进 tip），树形没被拉坏。
  assert.match(rendered, /^\s+✓ n\d+ tool\.result/m);
});
