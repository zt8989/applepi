import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Message,
  ToolCall,
} from '@earendil-works/pi-ai';
import { createAgentStore, waitForIdle } from '../src/store';
import { createFauxRuntime } from '../src/provider';
import type { AgentState } from '../src/state';

/**
 * `turn.continue`（界面上是 `/continue`）—— 从停下的地方再跑一次，**不插一条「继续」**。
 *
 * 为什么需要这组测试：超时 / 轮数上限之后想接着干，以前只能再发一句「继续」。那句话会
 * 作为真实历史进 `messages`、进会话文件、进下一次请求 —— 模型每被续一次就多欠一句废话。
 * 而 `turn.continue` 的差别恰恰是「没有那条消息」，所以断言的重点不是「又跑了一次」，
 * 而是「消息流里**没有**多出一条 user」。
 */

const usage = () => ({
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function assistantMessage(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'faux',
    model: 'fake',
    usage: usage(),
    stopReason,
    timestamp: Date.now(),
  };
}

/** 一次正常的「模型说完了」。 */
function doneStream(text: string): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      const message = assistantMessage([{ type: 'text', text }], 'stop');
      yield { type: 'done', reason: 'stop', message };
    },
  } as unknown as AssistantMessageEventStream;
}

/** 按脚本吐事件（带工具调用时用）。 */
function streamOf(events: AssistantMessageEvent[]): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  } as unknown as AssistantMessageEventStream;
}

/**
 * 挂住，abort 来了就结束迭代。
 *
 * 必须真的听 signal：不听的话流会一直挂着，测试只能等超时闸（那会拖成几十秒）。
 * 这里只要「超时那一刻环能收工」，不需要模拟 provider 交回部分消息的形状 ——
 * 那个形状由 stop-cause.test.ts 另一组用例守着。
 */
function abortableHangingStream(signal: AbortSignal | undefined): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve) => {
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

function textOf(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

function countKind(state: Pick<AgentState, 'trace'>, kind: string): number {
  return state.trace.order.filter((id) => state.trace.nodes[id]?.kind === kind).length;
}

test('/continue：超时收工后接着跑，消息流里不多出一条「继续」', async () => {
  const faux = createFauxRuntime();
  let calls = 0;
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    llmTimeoutMs: 50,
    // 1 = 不自动重试：一次超时就收工，续跑这件事只可能是 /continue 干的。
    maxLlmAttempts: 1,
    streamFn: (_m, _c, o) => {
      calls += 1;
      return calls === 1 ? abortableHangingStream(o?.signal) : doneStream('这次好了');
    },
  });

  store.dispatch({ type: 'user.message', text: '在吗' });
  const timedOut = await waitForIdle(store);
  assert.equal(timedOut.stopCause, 'timeout');
  assert.equal(timedOut.messages.length, 1, '超时后只有那条用户消息');

  store.dispatch({ type: 'turn.continue' });
  const state = await waitForIdle(store);
  assert.equal(calls, 2, '续跑 = 真的又调了一次 LLM');
  assert.equal(state.messages.length, 2, '只多了模型那条；**没有**多出一条「继续」');
  assert.equal(state.messages[0]?.role, 'user');
  assert.equal(textOf(state.messages[1] as Message), '这次好了');
  assert.equal(state.stopCause, 'completed', '续跑成功后停止原因要刷新');
  assert.equal(state.error, null);
  assert.equal(state.stopCauseDetail, '模型自己说完了');
  const turns = state.trace.order.filter((id) => state.trace.nodes[id]?.kind === 'turn.start');
  assert.equal(turns.length, 2, '续跑开的是**新回合**容器，不是复用旧的那个');
});

test('/continue：上次停在工具调用中途，先补一条中断说明再续跑', async () => {
  const faux = createFauxRuntime();
  let seen: readonly Message[] = [];
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    streamFn: (_m, context) => {
      seen = context.messages;
      return doneStream('接着做完了');
    },
  });

  // 进程被外部超时杀掉的现场：assistant 带着 toolCall，但 toolResult 永远没回来。
  // 这个形状直接发出去会被 provider 拒（每个 toolCall 后面必须紧跟 toolResult）。
  store.dispatch({
    type: 'conversation.restored',
    sessionId: 's-repair',
    messages: [
      { role: 'user', content: '跑一个长命令', timestamp: 1 } as Message,
      assistantMessage(
        [
          { type: 'text', text: '开始跑' },
          { type: 'toolCall', id: 'call_9', name: 'bash', arguments: { command: 'sleep 600' } },
        ],
        'toolUse',
      ),
    ],
  });

  store.dispatch({ type: 'turn.continue' });
  const state = await waitForIdle(store);
  assert.equal(state.stopCause, 'completed');

  const repaired = seen.find((m) => m.role === 'toolResult' && m.toolCallId === 'call_9');
  assert.ok(repaired, '悬空的 toolCall 必须先补上结果（否则第一个请求就是非法序列）');
  if (repaired.role === 'toolResult') {
    assert.equal(repaired.toolName, 'bash');
    assert.equal(repaired.isError, true, '中断要按失败告知模型');
  }
  assert.equal(textOf(state.messages[1] as Message), '开始跑', '原消息一个字不改');
  assert.equal(
    state.messages.filter((m) => m.role === 'user').length,
    1,
    '修复不会凭空多出一句 user 消息',
  );
});

test('/continue：跑着的时候不接（不会开第二条并行的环）', async () => {
  const faux = createFauxRuntime();
  let calls = 0;
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    llmTimeoutMs: 50,
    maxLlmAttempts: 1,
    streamFn: (_m, _c, o) => {
      calls += 1;
      return abortableHangingStream(o?.signal);
    },
  });

  store.dispatch({ type: 'user.message', text: '慢慢想' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  store.dispatch({ type: 'turn.continue' });

  const state = await waitForIdle(store);
  assert.equal(calls, 1, '被相位挡住：没有第二次调用');
  assert.equal(state.stopCause, 'timeout');
  assert.equal(countKind(state, 'turn.start'), 1);
});

test('/continue：撞轮数上限后能接着跑，轮数从 0 重新数', async () => {
  const faux = createFauxRuntime();
  let calls = 0;
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    maxTurns: 1,
    streamFn: () => {
      calls += 1;
      if (calls === 1) {
        const toolCall: ToolCall = {
          type: 'toolCall',
          id: 'call_1',
          name: 'bash',
          arguments: { command: 'echo hi' },
        };
        const message = assistantMessage(
          [{ type: 'text', text: '跑一下' }, toolCall],
          'toolUse',
        );
        return streamOf([
          { type: 'text_delta', contentIndex: 0, delta: '跑一下', partial: message },
          { type: 'toolcall_end', contentIndex: 1, toolCall, partial: message },
          { type: 'done', reason: 'toolUse', message },
        ]);
      }
      return doneStream('接着做完了');
    },
  });

  store.dispatch({ type: 'user.message', text: '开始' });
  const capped = await waitForIdle(store);
  assert.equal(capped.stopCause, 'maxTurns');
  assert.equal(capped.messages.filter((m) => m.role === 'user').length, 1);

  store.dispatch({ type: 'turn.continue' });
  const state = await waitForIdle(store);
  assert.equal(calls, 2, '续跑真的又调了一次 LLM');
  assert.equal(state.stopCause, 'completed');
  assert.equal(state.turns, 1, '新回合的 turns 归零后只数到这一次');
  assert.equal(
    state.messages.filter((m) => m.role === 'user').length,
    1,
    '整段对话里仍然只有最初那一句 user',
  );
});

test('/continue：空会话不启动（没有可续的上下文）', async () => {
  const faux = createFauxRuntime();
  let calls = 0;
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    streamFn: () => {
      calls += 1;
      return doneStream('不该出现');
    },
  });

  store.dispatch({ type: 'turn.continue' });
  const state = await waitForIdle(store);
  assert.equal(calls, 0, '没有消息就不该调 LLM');
  assert.equal(state.phase, 'idle');
  assert.equal(state.messages.length, 0);
  assert.equal(countKind(state, 'turn.start'), 0, '也不该开一个空回合');
});
