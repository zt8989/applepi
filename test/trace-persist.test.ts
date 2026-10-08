import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentStore, createPersistentStore } from '../src/store';
import { createFauxRuntime, demoResponses } from '../src/provider';
import { createFileSink, loadTrace, tracePath } from '../src/trace-file';
import { replayTrace, toJsonl, type TraceRecord, type TraceSink } from '../src/trace-store';
import { renderTree, traceStats, type TraceTree } from '../src/trace';
import { createInitialState } from '../src/state';
import { createAgentReducer } from '../src/reducer';
import { renderColoredTree } from '../src/tui/app';
import type { AgentState } from '../src/index';

/** 收集所有写进 sink 的行。 */
function memorySink(): TraceSink & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    append(line: string) {
      lines.push(line);
    },
  };
}

test('轨迹落盘：错误节点也会被写进 JSONL（这就是「错误也要持久化」）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'trace-'));
  try {
    const faux = createFauxRuntime();
    let calls = 0;
    const sessionId = 'sess-err';
    const sink = createFileSink(tracePath(sessionId, dir));
    const { store, persistence } = createPersistentStore({
      runtime: faux.runtime,
      systemPrompt: 'test',
      sessionId,
      llmTimeoutMs: 100,
      traceSink: sink,
      streamFn: (_model, _context, options) => {
        calls += 1;
        // 第一次挂住（会被超时 abort），第二次正常返回。
        if (calls === 1) {
          return {
            async *[Symbol.asyncIterator]() {
              await new Promise<void>((resolve) => {
                const signal = options?.signal;
                if (!signal) {
                  setTimeout(resolve, 5_000);
                  return;
                }
                if (signal.aborted) {
                  resolve();
                  return;
                }
                const timer = setTimeout(resolve, 5_000);
                signal.addEventListener('abort', () => {
                  clearTimeout(timer);
                  resolve();
                }, { once: true });
              });
            },
          } as never;
        }
        return faux.runtime.models.streamSimple(faux.runtime.model, {
          systemPrompt: 'test',
          messages: store.getState().messages,
          tools: [],
        }) as never;
      },
    });

    store.dispatch({ type: 'user.message', text: '你好' });
    await new Promise<void>((resolve) => {
      const unsubscribe = store.subscribe(() => {
        if (store.getState().phase === 'idle') {
          unsubscribe();
          resolve();
        }
      });
    });
    // **等回合容器真的闭合**：`turn.end` 是在 phase 转 idle 之后才 flush 的
    // （见 reducer 里 `closeTurn()` 的注释）。不等它，落盘的树就少一个节点，
    // 而回放出来的 turns 也会是 0 —— 那不是持久化的 bug，是读取得太早。
    await new Promise((r) => setTimeout(r, 50));
    persistence?.dispose();
    await sink.close?.();

    const text = await readFile(tracePath(sessionId, dir), 'utf8');
    const records = text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as TraceRecord);
    const added = records.filter((r) => r.op === 'add').map((r) => (r.op === 'add' ? r.node : null));

    // 关键：错误节点真的落盘了。
    const errorNode = added.find((n) => n?.kind === 'error');
    assert.ok(errorNode, 'JSONL 里必须有 error 节点');
    assert.match(errorNode?.detail ?? '', /超时/);
    assert.equal(errorNode?.status, 'error');

    // 重试产生了一个新的 step 节点，且父 id 指向超时前的容器。
    const attempts = added.filter((n) => n?.kind === 'step.start');
    assert.ok(attempts.length >= 2, '至少两次尝试');
    // 多了一层 turn：重试的兄弟关系长在 **turn 容器**下面，而不是 user 下面。
    // 「父 id 指向超时前的节点」这条需求没变，只是那棵树深了一节。
    const turnNode = added.find((n) => n?.kind === 'turn.start');
    assert.ok(turnNode, '有 turn 容器');
    const userNode = added.find((n) => n?.kind === 'user');
    assert.ok(userNode);
    assert.equal(turnNode?.parentId, userNode.id, 'turn 挂在 user 下面');
    for (const attempt of attempts) {
      assert.equal(attempt?.parentId, turnNode.id, '每次尝试的父 id 都指向同一个 turn 容器');
    }

    // 从文件回放，树与内存里的一致。
    const replayed = replayTrace(text, sessionId);
    assert.equal(replayed.order.length, store.getState().trace.order.length);
    assert.equal(replayed.tipId, store.getState().trace.tipId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('从 .trace/<id>.jsonl 能把整棵树读回来（loadTrace）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'trace-'));
  try {
    const faux = createFauxRuntime();
    faux.setResponses(demoResponses());
    const sessionId = 'sess-load';
    const sink = createFileSink(tracePath(sessionId, dir));
    const { store, persistence } = createPersistentStore({
      runtime: faux.runtime,
      systemPrompt: 'test',
      sessionId,
      traceSink: sink,
    });
    store.dispatch({ type: 'user.message', text: '算一下 (3+4)*6' });
    await new Promise<void>((resolve) => {
      const unsubscribe = store.subscribe(() => {
        if (store.getState().phase === 'idle') {
          unsubscribe();
          resolve();
        }
      });
    });
    // **等 turn.end 落盘**：phase 转 idle 早于回合容器闭合（见上面那个测试的注释），
    // 直接 dispose 会丢掉 `turn.end`，回放出来的 turns 就成了 0。
    await new Promise((r) => setTimeout(r, 50));
    persistence?.dispose();
    await sink.close?.();

    const tree = await loadTrace(sessionId, dir);
    assert.ok(tree, '能从文件读回');
    const stats = traceStats(tree);
    assert.equal(stats.turns, 1, '一个回合');
    assert.equal(stats.steps, 2, '两步 = 两次 LLM 调用');
    assert.equal(stats.toolCalls, 1, '一次工具');
    assert.equal(stats.errors, 0);
    assert.ok(tree.tipId, 'HEAD 存在');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('落盘器对成功/失败一视同仁：写失败不打断环，游标不推进', async () => {
  const faux = createFauxRuntime();
  faux.setResponses(demoResponses());
  let appends = 0;
  const flaky: TraceSink = {
    append() {
      appends += 1;
      if (appends === 1) throw new Error('磁盘满了');
    },
  };
  const errors: unknown[] = [];
  const { store, persistence } = createPersistentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    sessionId: 'flaky',
    traceSink: flaky,
    onTraceError: (error) => errors.push(error),
  });
  store.dispatch({ type: 'user.message', text: '算一下' });
  // 环是异步的：等它自己跑完再断言「写盘失败没有影响它」。
  await waitForIdleState(store);
  persistence?.dispose();

  assert.ok(errors.length >= 1, '写失败被上报了');
  assert.equal(store.getState().error, null, '写盘失败没有变成对话错误');
  assert.equal(store.getState().phase, 'idle', '环照常闭合');
  assert.ok(appends > 1, '第一次失败后还继续尝试写，没有卡住');
});

/** 等环跑完（phase 回到 idle）。 */
function waitForIdleState(store: { getState(): { phase: string }; subscribe(l: () => void): () => void }): Promise<void> {
  return new Promise((resolve) => {
    if (store.getState().phase === 'idle') {
      resolve();
      return;
    }
    const unsubscribe = store.subscribe(() => {
      if (store.getState().phase === 'idle') {
        unsubscribe();
        resolve();
      }
    });
  });
}

test('回放能跳过崩溃时截断的半行', () => {
  const tree = createTraceStore();
  const good = toJsonl([
    {
      op: 'add',
      node: {
        id: 'n1',
        parentId: null,
        kind: 'user',
        status: 'ok',
        label: 'hi',
        createdAt: 1,
        endedAt: 1,
      },
    },
  ]);
  const restored = replayTrace(`${good}\n{"op":"add","node":{"id":"n2"`, 'x');
  assert.equal(restored.order.length, 1, '只恢复完整的那一行');
  assert.equal(restored.nodes['n1']?.label, 'hi');
});

function createTraceStore(): TraceTree {
  // 一个空树，用于上面的回放测试。
  const state = createInitialState({
    systemPrompt: 's',
    providerName: 'p',
    modelId: 'm',
    toolNames: [],
    sessionId: 'x',
  });
  return state.trace;
}

test('界面上渲染的树就是命令里那棵树（同一份逻辑，只是加了颜色）', () => {
  const reducer = createAgentReducer({});
  let state: AgentState = createInitialState({
    systemPrompt: 's',
    providerName: 'faux',
    modelId: 'fake',
    toolNames: [],
    sessionId: 't',
  });
  state = reducer(state, { type: 'user.message', text: '你好' }) as AgentState;
  state = reducer(state, { type: 'agent.run' }) as AgentState;
  state = reducer(state, {
    type: 'llm.failed',
    error: 'LLM 调用超时（1s）',
    kind: 'timeout',
  }) as AgentState;
  state = reducer(state, { type: 'agent.run' }) as AgentState;

  const plain = renderTree(state.trace, { maxWidth: 0 });
  const colored = renderColoredTree(state.trace, 0);
  // 去掉 ANSI 之后两者必须逐字相同 —— 证明界面没有另画一套。
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(strip(colored), plain);
  // 而且颜色是真的加上了（有转义序列）。
  assert.ok(colored.includes('\x1b['), '彩色版应当含 ANSI 序列');
});
