import test from 'node:test';
import assert from 'node:assert/strict';
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai';
import { createAgentStore, waitForIdle } from '@ela/core/store';
import { createFauxRuntime } from '@ela/core/provider';
import { renderTree } from '@ela/core';
import { renderColoredTree } from '../src/app';

/**
 * 渲染顺序：**必须等于事情发生的顺序**。
 *
 * ## 曾经的 bug
 *
 * `renderTree` 原来用递归 walk，是深度优先的：某个节点有两个孩子（并行工具）时，
 * 第一个孩子的**整条下游**会全部先打印完 —— 下一轮 LLM、下一批工具、再下一轮……
 * 一直到会话末尾 —— 第二个孩子才轮得到。
 *
 * 真实后果（用户报的那个）：一条 209 个节点的长会话里，
 * **最新的 n209 出现在中间，最早的 n9 反而在底部**。整张图是一份时间倒流的记录，
 * 而界面没有任何提示，用户只能自己发现。
 *
 * 树的父子关系一直是��的（它本来就是一棵树），错的只是**打印顺序**。
 */

const msg = (content: unknown, stopReason: string): AssistantMessage =>
  ({
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'faux',
    model: 'fake',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: 1,
  }) as unknown as AssistantMessage;

const bashCall = (id: string, command: string): ToolCall => ({
  type: 'toolCall',
  id,
  name: 'bash',
  arguments: { command },
});

/** 从渲染结果里取出节点 id 的数字序列。 */
function renderedIds(rendered: string): number[] {
  return rendered
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => /^[^n]*n(\d+)/.exec(line)?.[1])
    .filter((x): x is string => x !== undefined)
    .map(Number);
}

test('并行工具之后：节点仍按发生顺序排列（不倒流）', async () => {
  const faux = createFauxRuntime();
  let calls = 0;
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    streamFn: () => {
      calls += 1;
      // 第一轮：两个工具并行（这正是会把遍历带偏的那个形状）。
      // 第二轮：再来一次「单工具」，确保后面还有很长的下游。
      const message =
        calls === 1
          ? msg([{ type: 'text', text: '并行' }, bashCall('c1', 'echo one'), bashCall('c2', 'echo two')], 'toolUse')
          : msg([{ type: 'text', text: '好了' }], 'stop');
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'done', reason: message.stopReason, message } as never;
        },
      } as never;
    },
  });

  store.dispatch({ type: 'user.message', text: '查两个' });
  const state = await waitForIdle(store, 30_000);
  const rendered = renderTree(state.trace, { maxWidth: 0 });
  const ids = renderedIds(rendered);

  // 一个都不能少。
  assert.equal(ids.length, state.trace.order.length, '渲染的行数要与节点数一致');

  // **核心断言**：id 单调自增，所以递增 == 发生顺序。
  const sorted = [...ids].sort((a, b) => a - b);
  assert.deepEqual(
    ids,
    sorted,
    `渲染顺序必须等于发生顺序，但拿到的是：\n${rendered}`,
  );

  // 最后一个节点就该是最后一个发生的（不是最早那个）。
  assert.equal(ids[ids.length - 1], state.trace.order.length, '最后一行是最后发生的节点');
});

test('工具失败：isError 真的被置上（pi 的 bash 失败不抛异常）', async () => {
  // 这条单独立着，因为它守的是**另一层**：失败的事实要能进到轨迹里。
  //
  // pi 的 bash 工具执行 `exit 1` 时不抛异常，把「Command exited with code 1」
  // 当正常结果返回。只 catch 异常的话 isError 永远 false，失败会被画成 ✓。
  const faux = createFauxRuntime();
  let calls = 0;
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    streamFn: () => {
      calls += 1;
      const message =
        calls === 1
          ? msg([{ type: 'text', text: '并行' }, bashCall('c1', 'echo one'), bashCall('c2', 'exit 1')], 'toolUse')
          : msg([{ type: 'text', text: '好了' }], 'stop');
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'done', reason: message.stopReason, message } as never;
        },
      } as never;
    },
  });

  store.dispatch({ type: 'user.message', text: '查两个' });
  const state = await waitForIdle(store, 30_000);
  const rendered = renderTree(state.trace, { maxWidth: 0 });
  console.log(`\n${rendered}\n`);

  // 失败的工具在轨迹上是一个 `error` 子节点；成功那个是 `tool.result`。
  //
  // 成败现在画在**颜色**上（红加粗 / 绿），不再有 `✗` / `✓` 字符 ——
  // 所以纯文本这一份只能断言「行在不在」，红绿另拿带色那份下来比。
  assert.match(rendered, /○  n\d+ error: .*Command exited with code 1/);
  assert.match(rendered, /n\d+ tool\.result: one/);
  assert.match(rendered, /n\d+ tool\.call: bash \{"command":"exit 1"\}/);

  // 带色那份：失败那一行是**红 + 加粗**，成功那个不是。
  const colored = renderColoredTree(state.trace, 0);
  const lineOf = (pattern: RegExp): string =>
    colored.split('\n').find((line) => pattern.test(line)) ?? '';
  const failedLine = lineOf(/Command exited with code 1/);
  const okLine = lineOf(/tool\.result: one/);
  assert.ok(failedLine.includes('\u001b[1;31m') || failedLine.includes('\u001b[31m'), `失败那行该是红的：${JSON.stringify(failedLine)}`);
  assert.ok(!okLine.includes('\u001b[31m'), `成功那行不该是红的：${JSON.stringify(okLine)}`);
});
