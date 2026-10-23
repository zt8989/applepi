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
 * 界面上两者长得一模一样：一条红字 + 「按 Ctrl+R 看轨迹树」。用户明明是自己按的停止，
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

/**
 * 挂住，abort 来了就以**真 provider 的形状**收尾。
 *
 * 「真 provider 的形状」是这一组测试的重点：signal 一 abort，pi-ai 的 provider 不是
 * 「安静结束迭代、什么都不给」，而是把累积的部分消息标成 `stopReason:'aborted'`，
 * 以 **`error` 事件**交回来（见 pi-ai `api/openai-completions.js`：catch 里
 * `output.stopReason = signal.aborted ? 'aborted' : 'error'`，然后 push 一个 error 事件）。
 * 上面那个 `abortableHangingStream` 给的是「什么都不给」的形状 —— 两种都要测：
 * 前者能过、后者过不了，就是一个只挂在假流上的假绿灯。
 */
function providerAbortStream(options: { signal?: AbortSignal | undefined }): AssistantMessageEventStream {
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
      yield {
        type: 'error',
        reason: 'aborted',
        error: {
          ...assistantMessage('我正在想'),
          stopReason: 'aborted',
          errorMessage: 'Request was aborted',
        },
      } as never;
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

test('中止的部分消息（stopReason=aborted）：记成用户停的，**不**记成「模型自己说完了」', async () => {
  // 这条盯的是另一条路：provider 把中止做成了「一条 `stopReason: 'aborted'` 的**部分消息**」
  // （pi-ai 的 openai-completions 就是这么做的，AbortError 被它换成一份中断消息交回来）。
  // 本项目的 `llm.done` 早先无论什么 stopReason 都写成 `completed`，于是界面显示
  // 「✗ 模型自己说完了：Request was aborted」+「按 Ctrl+R 看轨迹树」—— 用户自己按的停止，
  // 却像被程序报了个错，而「模型自己说完了」那句是错的。
  const faux = createFauxRuntime();
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    streamFn: () =>
      ({
        async *[Symbol.asyncIterator]() {
          const partial = {
            ...assistantMessage('我正在想'),
            stopReason: 'aborted',
            errorMessage: 'Request was aborted',
          } as unknown as AssistantMessage;
          yield { type: 'text_delta', contentIndex: 0, delta: '我正在想', partial } as never;
          yield { type: 'done', reason: 'aborted', message: partial } as never;
        },
      }) as never,
  });

  store.dispatch({ type: 'user.message', text: '慢慢想' });
  const state = await waitForIdle(store);
  assert.equal(state.phase, 'idle', '中止也是一轮的结束');
  assert.equal(state.stopReason, 'aborted', '粗分类是 aborted（UI 分红/灰用）');
  assert.equal(state.stopCause, 'user', '具体原因是「用户按了停止」');
  assert.equal(state.stopCauseDetail, '用户手动中断');
  assert.equal(state.error, null, '中止不往 error 里写 —— 中止说明属于那条消息（pi 的写法）');
  // 部分内容留着（pi 也留着：中止不该把已经流出来的话吞掉）。
  assert.equal(state.messages.length, 2);
  const last = state.messages[1] as AssistantMessage;
  assert.equal(last.stopReason, 'aborted');
  const text = Array.isArray(last.content)
    ? last.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
    : String(last.content);
  assert.equal(text, '我正在想', '已经流出来的话要留着');
});

test('中止时不接手那条消息里的工具调用（用户都喊停了，不该再跑工具）', async () => {
  const faux = createFauxRuntime();
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    streamFn: () =>
      ({
        async *[Symbol.asyncIterator]() {
          const partial = {
            ...assistantMessage('我要跑个命令'),
            content: [
              { type: 'text', text: '我要跑个命令' },
              { type: 'toolCall', id: 'call_9', name: 'bash', arguments: { command: 'rm -rf /tmp/x' } },
            ],
            stopReason: 'aborted',
          } as unknown as AssistantMessage;
          yield { type: 'done', reason: 'aborted', message: partial } as never;
        },
      }) as never,
  });

  store.dispatch({ type: 'user.message', text: '等等' });
  const state = await waitForIdle(store);
  assert.deepEqual(state.pendingToolCalls, [], '中止后不该有待跑的工具');
  assert.equal(state.phase, 'idle', '也不该进 calling-tools');
});

test('超时：provider 以 error 事件交回一份 aborted 消息时，仍要记成超时（不能伪装成用户中断）', async () => {
  // 这是 2026-10-13 会话 01a1330b 的真实故障：默认超时 120s 到点，我们的闸 abort 了流，
  // provider 随即以 `error` 事件交回一份 `stopReason:'aborted'` 的部分消息。
  //
  // 旧代码只看「有没有 final」：有 final 就当「模型说完了」，压根不再问 timedOut。
  // 于是那次**真超时**被记成用户中断 —— 树上一条**空的** llm.result、step 状态是 ok、
  // `error` 是 null，既不报错也不重试。用户在会话里看到的只是「回合结束：用户中断」，
  // 而他从没按过停止。
  const faux = createFauxRuntime();
  let calls = 0;
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    llmTimeoutMs: 50,
    maxLlmAttempts: 2,
    streamFn: (_m, _c, o) => {
      calls += 1;
      return providerAbortStream({ signal: o?.signal });
    },
  });

  store.dispatch({ type: 'user.message', text: '慢慢想' });
  const state = await waitForIdle(store);

  assert.equal(calls, 2, '超时可重试：首次 + 一次重试');
  assert.equal(state.stopCause, 'timeout', '必须记成超时，不能记成用户中断');
  assert.notEqual(state.stopCause, 'user');
  assert.match(state.error ?? '', /超时/, '错误要留在 state 里（旧代码这里是 null）');
  // 树上两次超时各留一个 error 节点 —— 「错误一个字都没留下」正是这次的病。
  const errorNodes = state.trace.order
    .map((id) => state.trace.nodes[id])
    .filter((node) => node?.kind === 'error');
  assert.equal(errorNodes.length, 2, '两次超时都要在树上有 error 节点');
  assert.equal(errorNodes[0]?.meta?.['cause'], 'timeout');
  assert.equal(errorNodes[0]?.meta?.['kind'], 'timeout');
});

test('用户手动中断（同样是 provider 的 error 事件形状）：stopCause=user，不记成超时', async () => {
  // 与上一条**同一个流形状**，只把 abort 的来源从「超时闸」换成「用户按停止」。
  // 两条一起看才说明修复是按「谁喊的停」分流，而不是把 aborted 一律当超时。
  const faux = createFauxRuntime();
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    llmTimeoutMs: 60_000, // 足够长：这次停**只可能**是用户按的
    maxLlmAttempts: 2,
    streamFn: (_m, _c, o) => providerAbortStream({ signal: o?.signal }),
  });

  store.dispatch({ type: 'user.message', text: '慢慢想' });
  await new Promise((r) => setTimeout(r, 30)); // 等流真的开起来再喊停
  assert.equal(abortRun(), true, '有一次运行被打断');

  const state = await waitForIdle(store);
  assert.equal(state.stopReason, 'aborted', '粗分类仍是 aborted（UI 分红/灰的依据）');
  assert.equal(state.stopCause, 'user');
  assert.equal(state.error, null, '用户自己按的不是故障，不写 error');
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

test('慢而健康的流不被总时长误杀：每段间隔都小于空闲闸，总时长超过它也照样跑完', async () => {
  // win-ai-harness 事故的形状：104k 上下文的长生成实跑 121s，被 2 分钟**总时长**闸
  // 在流还健康时搜掉，重试同理，六次全灭。空闲语义下这样的流必须活下来：
  // 每段间隔都远小于闸，但总时长稳超闸值 —— 旧代码下这条测试必挂。
  const faux = createFauxRuntime();
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    llmTimeoutMs: 100,
    maxLlmAttempts: 1,
    streamFn: () =>
      ({
        async *[Symbol.asyncIterator]() {
          for (const d of ['一', '直', '在', '流', '…']) {
            await new Promise((r) => setTimeout(r, 25)); // 间隔 25ms ≪ 闸 100ms
            yield { type: 'text_delta', delta: d } as never;
          }
          await new Promise((r) => setTimeout(r, 25));
          const message = assistantMessage('一直在流…');
          yield { type: 'done', reason: 'stop', message } as never;
        },
      }) as never,
  });

  store.dispatch({ type: 'user.message', text: '慢慢说' });
  const state = await waitForIdle(store);
  assert.equal(state.stopCause, 'completed', '字节一直在到，跑多久都不该被搜');
  assert.equal(state.error, null);
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
