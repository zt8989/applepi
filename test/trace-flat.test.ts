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
 * 渲染的**形状**：整棵树拉平，**只有错误才画出分叉**。
 *
 * ## 为什么要改
 *
 * 一次正常对话在树里是一条长链（user → attempt → result → tool → result → attempt…），
 * 有时还并排几个工具（多个 tool.attempt 兄弟）。照 git 那样层层缩进，它是 5~7 层的
 * 阶梯，右半边全空 —— 而它**没有任何分支**，那样的缩进是纯噪声。
 *
 * 规则：**一组兄弟节点里没有失败，就整组不缩进**；出现了失败才切回树枝画法。
 * 所以并行工具**全成功时也不长树**（那不是分叉，只是列表里有几行），
 * 而重试（前面那次失败过）一定长树。
 *
 * 这组测试守的正是「什么时候该缩进」—— 它是纯展示层的约定，但一旦退回去
 * （比如有人「顺手」把 isForkGroup 删了），界面会悄悄变得又宽又空，没人立刻发现。
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
    { type: 'turn.start' },
    { type: 'step.start' },
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

test('重试：同一父下的第 2 个 step 才开始缩进', () => {
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

  // 两个 step 容器是兄弟 → 真的有分叉，树枝要画出来。
  // （第 2 个 step 是**兄弟而不是续用** —— 失败的 step 自己关掉，重试另开一个。
  // 节点号：n1 user / n2 turn / n3 step1 / n4 error / n5 step1.end / n6 step2 …）
  assert.match(rendered, /├── ✗ n3 step\.start/);
  assert.match(rendered, /└── ✓ n6 step\.start/);
  // user 只有一个孩子（那棵分叉树），所以它自己**不**缩进 —— 分叉从它下面才开始。
  assert.match(rendered, /^✓ n1 user/m);
});

test('树结构本身没变：拉平只影响画法，不影响父子关系', () => {
  // 防「为了让界面好看把树改平了」—— 那会让 tip、分叉、回放全失去意义。
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
  // 两个 step 仍是**同一个父**（git 语义的核心，见 trace.ts 的文件注释）。
  // 而那个父现在是 turn 容器 —— 新层级多了一节，但分叉语义没变。
  assert.equal(state.trace.nodes[turnNode]?.kind, 'turn.start');
  assert.equal(state.trace.nodes[turnNode]?.parentId, userNode, 'turn 挂在 user 下面');
  for (const id of steps) {
    assert.equal(state.trace.nodes[id]?.parentId, turnNode, '拉平不能动父子关系');
  }
  // 成功后才推进 tip —— 而且推进的是 `llm.result`（n7），**不是**随后的 `step.end`。
  //
  // 这条断言的意义：step/turn 是容器，容器闭合不等于「这里发生了一件事」。
  // 若 step.end 也推进 tip，工具结果与容器就会抢着当 tip，HEAD 指向一个没有内容的节点。
  assert.equal(state.trace.tipId, 'n7', 'tip 是 llm.result，不是 step.end');
  assert.equal(state.trace.nodes['n7']?.kind, 'llm.result');
  assert.equal(state.trace.nodes['n8']?.kind, 'step.end');
});

// ── 并行工具要走真环（工具节点是 effect 开的，reducer 造不出来） ──

test('并行工具：一个 llm.result 下多个 tool.attempt', async () => {
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

  // 两个都成功 → **不画分叉**。并行不是分叉：一行一个工具，顺序就是执行顺序，
  // 缩进去等于说「第二个工具依赖第一个」，那是假的结构。
  assertAllFlat(rendered, '并行工具（全成功）');
  // 树形没被拉坏：两个 tool.result 仍挂在自己的 tool.attempt 下。
  const attempts = state.trace.order.filter((id) => state.trace.nodes[id]?.kind === 'tool.attempt');
  assert.equal(attempts.length, 2);
  for (const id of attempts) {
    const kids = state.trace.order.filter(
      (other) => state.trace.nodes[other]?.parentId === id,
    );
    assert.equal(kids.length, 1, 'tool.result 仍挂在自己那个 tool.attempt 下');
    assert.equal(state.trace.nodes[kids[0] ?? '']?.kind, 'tool.result');
  }
});

test('并行工具里有一个失败：这时才画出分叉（同伴一起挂进去）', async () => {
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
                // 这个会报错：工具返回 isError → 树上多一个 error 节点。
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
  const state = await waitForIdle(store);
  const rendered = renderTree(state.trace, { maxWidth: 0 });
  console.log(`\n${rendered}\n`);

  // 有失败 → 切回树枝：两个 tool.attempt 兄弟都在里面。
  assert.match(rendered, /├── (✓|✗) n\d+ tool\.attempt/);
  assert.match(rendered, /└── (✓|✗) n\d+ tool\.attempt/);
  // 失败那个下面挂着 error 节点。
  assert.match(rendered, /\n\s+✗ n\d+ error:/);
});

test('并列但全成功（不重试也不失败）不画分叉', () => {
  // 直接摆一棵「根下有多个 prompt.* 装载节点」的树：它们是并列的，根层永远平铺。
  const state = play(
    { type: 'prompt.init', systemPrompt: '你是…', tools: [] },
    { type: 'model.init', provider: 'faux', modelId: 'fake', thinkingLevel: 'off', capabilities: CAPS },
    { type: 'user.message', text: '在吗' },
  );
  assertAllFlat(renderTree(state.trace, { maxWidth: 0 }), '根层');
});

test('工具报错：error 节点落进去，那一组的兄弟一起挂成分叉', async () => {
  // 工具节点由 effect 开（`tool/start` / `tool.result`），所以直接 dispatch 这两个 action ——
  // 与真实跑环走的是**同一段 reducer 代码**，只是不花时间等子进程。
  // 那个 calls 计数**必须有**：streamFn 每次都回 toolUse 的话，环会变成死循环
  // （LLM 一直要调工具 → 工具一直跑 → 再问 LLM → 又要调工具 → …），而两次的工具 id
  // 相同，于是去重把它改名成 c1#215、c1#216…，日志刷个没完。实测这条测试因此跑了
  // 整整 10 分钟，才被 waitForIdle 的默认超时打断。第二次回 stop，环才会闭合。
  let calls = 0;
  const store = createAgentStore({
    runtime: createFauxRuntime().runtime,
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
  // 显式超时：环若不闭合（比如上面那个 streamFn 写错了），30 秒就失败并报出来，
  // 而不是让人对着一个「跑了 10 分钟」的测试猜哪里不对。
  const state = await waitForIdle(store, 30_000);
  // 造出一个「一个工具失败」的组：两次 tool/start（同一父）+
  // 第二个 tool.result 带 isError（真跑环时工具返回非 0 退出码就是这个形状）。
  store.dispatch({ type: 'tool/start', call: bashCall('t1', 'echo one') as never });
  store.dispatch({ type: 'tool/start', call: bashCall('t2', 'exit 1') as never });
  store.dispatch({
    type: 'tool.result',
    message: {
      role: 'toolResult',
      toolCallId: 't2',
      toolName: 'bash',
      content: [{ type: 'text', text: 'Command exited with code 1' }],
      isError: true,
      timestamp: 1,
    } as never,
  });

  const after = store.getState();
  const rendered = renderTree(after.trace, { maxWidth: 0 });
  console.log(`\n${rendered}\n`);

  // 失败那个是 error 节点（不是 tool.result），且 status=error。
  const failed = after.trace.order.map((id) => after.trace.nodes[id]).find((n) => n?.kind === 'error');
  assert.ok(failed, '工具失败要落一个 error 节点');
  assert.equal(failed?.status, 'error');
  // 有失败 → 切回树枝：两个 tool.attempt 兄弟都在里面。
  assert.match(rendered, /├── (✓|✗) n\d+ tool\.attempt/);
  assert.match(rendered, /└── (✓|✗) n\d+ tool\.attempt/);
  // 失败那个下面挂着 error 节点。
  assert.match(rendered, /\n\s+✗ n\d+ error:/);
  // 树本身没被拉坏：error 的父仍是那个 tool.attempt。
  assert.equal(after.trace.nodes[failed?.id ?? '']?.parentId?.startsWith('n') === true, true);
});
