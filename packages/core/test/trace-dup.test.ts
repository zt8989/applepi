import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, type AgentState } from '../src/state';
import { createAgentReducer } from '../src/reducer';
import { createTracePersistence, type TraceSink } from '../src/trace-store';
import type { AgentAction } from '../src/index';
import type { Message } from '@earendil-works/pi-ai';

/**
 * 回归测试：轨迹 JSONL 里**同一条消息不能出现两次**。
 *
 * 曾经的 bug（见 kernel.ts 的 restoreSession）：
 *   恢复历史时 `conversation.reset` 清空 messages，再逐条 `session.restored` 把 N 条灌回来。
 *   落盘器只认「messages 变长了」，认不出这些是**读回来的**而不是新产生的，于是从游标 0
 *   开始把整批历史重写一遍 —— 轨迹文件里同一批消息出现两次。
 *
 * 那次实测：smuv7mk0u.jsonl 前 426 行写了一遍完整对话（229 条消息），
 * 第 427 行起又把同样的 229 条写了一遍，而且那一段里**一条 add 记录都没有** ——
 * 因为节点游标 persistedSeq 在 state 里、跨 reset 保留着，所以第二次没有节点可写，只有消息。
 */

function userMessage(text: string): Message {
  return { role: 'user', content: text, timestamp: 1 } as unknown as Message;
}

/** 一个最小可用 store + 落盘器，返回写进 sink 的所有行。 */
function harness(): {
  dispatch: (action: AgentAction) => void;
  persistence: ReturnType<typeof createTracePersistence>;
  records: () => { op: string; message?: Message }[];
  getState: () => AgentState;
} {
  const lines: string[] = [];
  const sink: TraceSink = { append: (line) => void lines.push(line) };
  const reducer = createAgentReducer({});
  let state: AgentState = createInitialState({
    systemPrompt: 'p',
    providerName: 'p',
    modelId: 'm',
    toolNames: [],
    sessionId: 'S',
  });
  let notify: (() => void) | null = null;
  const dispatch = (action: AgentAction): void => {
    state = reducer(state, action) as AgentState;
    notify?.();
  };
  const store = {
    getState: () => state,
    subscribe: (listener: () => void) => {
      notify = listener;
      return () => {
        notify = null;
      };
    },
    dispatch,
  };
  const persistence = createTracePersistence({ store, sink });
  dispatch({ type: 'prompt.init', systemPrompt: 'p', tools: [] });
  return {
    dispatch,
    persistence,
    records: () =>
      lines
        .join('\n')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { op: string; message?: Message }),
    getState: () => state,
  };
}

test('恢复历史：灌回去的消息不会被再写一遍', () => {
  const h = harness();
  const history = Array.from({ length: 9 }, (_, i) => userMessage(`第 ${i + 1} 轮`));

  // 模拟 restoreSession：reset 清空 → skipMessages 推游标 → 逐条灌回。
  h.dispatch({ type: 'conversation.reset', sessionId: 'S2' });
  h.persistence.skipMessages(history.length);
  for (const message of history) {
    h.dispatch({ type: 'session.restored', message } as AgentAction);
  }
  h.persistence.dispose();

  const messages = h.records().filter((r) => r.op === 'message');
  // 灌回去的 9 条是「读回来的历史」，轨迹文件不该再抄一份。
  // 修复前这里会是 9（整批重写），修复后是 0。
  assert.equal(messages.length, 0, '读回来的历史不该被重写一遍');
  assert.equal(h.getState().messages.length, 9, '但它们确实回到了状态里');
});

test('恢复历史后再问一句：只有新的那一句被追加', () => {
  const h = harness();
  const history = Array.from({ length: 3 }, (_, i) => userMessage(`旧的 ${i + 1}`));

  h.dispatch({ type: 'conversation.reset', sessionId: 'S2' });
  h.persistence.skipMessages(history.length);
  for (const message of history) {
    h.dispatch({ type: 'session.restored', message } as AgentAction);
  }
  // 新问题（新会话里产生的消息，应该被写）。
  h.dispatch({ type: 'session.restored', message: userMessage('新的问题') });
  h.persistence.dispose();

  const messages = h.records().filter((r) => r.op === 'message');
  assert.equal(messages.length, 1, '只有新产生的那条该写');
  assert.equal((messages[0]?.message as { content: string }).content, '新的问题');
});
