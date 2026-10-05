import test from 'node:test';
import assert from 'node:assert/strict';
import type { AssistantMessage, AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createAgentStore, waitForIdle } from '../src/store';
import { createFauxRuntime } from '../src/provider';
import { abortRun } from '../src/run-control';
import { stopCauseText } from '../src/state';

/**
 * 停止原因（`stopCause`）—— 这一轮**到底为什么停**。
 *
 * 以前只有 `stopReason`，而它把「用户手动中断」与「大模型超时」都塞进 `aborted`/`error`，
 * 界面上两者长得一模一样：一条红字 + 「按 Ctrl+T 看轨迹树」。用户明明是自己按的停止，
 * 却像被程序报了个错。这是这组测试要守住的东西。
 */

const usage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const assistantMessage = (text: string): AssistantMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'faux',
    model: 'fake',
    usage: usage(),
    stopReason: 'stop',
    timestamp: Date.now(),
  }) as unknown as AssistantMessage;

/**
 * 一个挂住不返回的流：等 abort 把 signal 打断。
 *
 * 真的去听 signal —— 不听的话流会一直挂着，测试只能等超时闸（那是 60 秒，
 * 一条测试 60 秒，整套跑不动）。听了之后 abort 一来就收摊。
 */
function hangingStream(): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve) => {
        const signal = this as never;
        void signal;
        setTimeout(resolve, 60_000);
      });
    },
  } as unknown as AssistantMessageEventStream;
}

/** 同样挂住，但认 signal：abort 一来就结束迭代（模拟 provider 被打断）。 */
function abortableHangingStream(options: { signal?: AbortSignal | undefined }): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve) => {
        const signal = options.signal;
        if (!signal) {
          setTimeout(resolve, 60_000);
          return;
        }
        if (signal.aborted) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, 60_000);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    },
  } as unknown as AssistantMessageEventStream;
}

test('用户手动中断：stopCause=user（不是 timeout，也不是笼统的 aborted）', async () => {
  const faux = createFauxRuntime();
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    llmTimeoutMs: 60_000, // 足够长：这次停**只可能**是用户按的
    maxLlmAttempts: 2,
    streamFn: (_m, _c, o) => abortableHangingStream({ signal: o?.signal }),
  });

  store.dispatch({ type: 'user.message', text: '慢慢想' });
  // 等流真的开起来再喊停，否则 abort 打在一个还不存在的 controller 上。
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(abortRun(), true, '有一次运行被打断');

  const state = await waitForIdle(store);
  assert.equal(state.phase, 'idle');
  assert.equal(state.stopReason, 'aborted', '粗分类仍是 aborted —— 那是 UI 分红/灰的依据');
  assert.equal(state.stopCause, 'user', '但具体原因必须是「用户」');
  assert.equal(state.stopCauseDetail, '用户手动中断');
  assert.equal(state.retrying, false, '用户主动停的不该自动重试');
});

test('超时：stopCause=timeout，且**不**被记成用户中断', async () => {
  const faux = createFauxRuntime();
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    llmTimeoutMs: 50,
    // 1 = 不重试，一次超时就收工，测试快且确定。
    maxLlmAttempts: 1,
    streamFn: (_m, _c, o) => abortableHangingStream({ signal: o?.signal }),
  });

  store.dispatch({ type: 'user.message', text: '等不到' });
  const state = await waitForIdle(store);
  assert.equal(state.stopCause, 'timeout');
  assert.equal(state.stopCauseDetail, '大模型调用超时');
  assert.notEqual(state.stopCause, 'user', '这条是它自己超时的，不能赖到用户头上');
});

test('停止原因落在轨迹树的 error 节点 meta 上（回放也分得清）', async () => {
  const faux = createFauxRuntime();
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    llmTimeoutMs: 50,
    maxLlmAttempts: 1,
    streamFn: (_m, _c, o) => abortableHangingStream({ signal: o?.signal }),
  });

  store.dispatch({ type: 'user.message', text: '等不到' });
  const state = await waitForIdle(store);
  const errorNode = state.trace.order
    .map((id) => state.trace.nodes[id])
    .find((node) => node?.kind === 'error');
  assert.ok(errorNode, '错误要在树上留一个节点');
  // kind 一直是 timeout；cause 才是「谁喊停的」。二者都在才算分得清。
  assert.equal(errorNode.meta?.['cause'], 'timeout');
  assert.equal(errorNode.meta?.['kind'], 'timeout');
});

test('正常说完：stopCause=completed（不是任何一种失败）', async () => {
  const faux = createFauxRuntime();
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    streamFn: () => ({
      async *[Symbol.asyncIterator]() {
        const message = assistantMessage('好了');
        yield { type: 'done', reason: 'stop', message } as never;
      },
    }) as never,
  });

  store.dispatch({ type: 'user.message', text: '在吗' });
  const state = await waitForIdle(store);
  assert.equal(state.stopReason, 'completed');
  assert.equal(state.stopCause, 'completed');
  assert.equal(state.error, null);
});

test('新一句话把上一回合的停止原因清掉（不能留着上一轮的「超时」）', async () => {
  const faux = createFauxRuntime();
  let first = true;
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    llmTimeoutMs: 50,
    maxLlmAttempts: 1,
    streamFn: (_m, _c, _o) => {
      if (first) {
        first = false;
        return abortableHangingStream({ signal: _o?.signal });
      }
      return {
        async *[Symbol.asyncIterator]() {
          const message = assistantMessage('这次好了');
          yield { type: 'done', reason: 'stop', message } as never;
        },
      } as never;
    },
  });

  store.dispatch({ type: 'user.message', text: '等不到' });
  const timedOut = await waitForIdle(store);
  assert.equal(timedOut.stopCause, 'timeout');

  store.dispatch({ type: 'user.message', text: '再试一次' });
  const state = await waitForIdle(store);
  assert.equal(state.stopCause, 'completed', '第二轮成功，停止原因要换成 completed');
  assert.equal(state.error, null);
});

test('stopCauseText：每个原因都有一句人话', () => {
  // 这是界面直接显示的文案：一个都不能缺，否则界面会显示 undefined。
  for (const cause of [
    'user',
    'timeout',
    'network',
    'auth',
    'model',
    'llm-error',
    'tool-error',
    'maxTurns',
    'shutdown',
    'completed',
  ] as const) {
    const text = stopCauseText(cause);
    assert.ok(text.length > 0, `${cause} 要有文案`);
  }
  // 关键区分：用户中断与超时是**两句话**，不能混。
  assert.notEqual(stopCauseText('user'), stopCauseText('timeout'));
  assert.match(stopCauseText('user'), /用户/);
});
