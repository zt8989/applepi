/**
 * herdr 自报的测试（见 [herdr.ts](../src/herdr.ts)）。
 *
 * 三块：
 * 1. **纯函数**：环境变量判据、socket 的平台形式、store 的一帧 → 该报什么；
 * 2. **传输**：真的起一个 socket 服务器（Windows 上是命名管道，与 herdr 同形），
 *    验一行一个 JSON 的请求形状与 `seq` 单调；
 * 3. **接线**：`startHerdrReporting` 的订阅、去重、拆台时的 release。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createInitialState, type AgentState } from '../src/state';
import type { AgentStore } from '../src/store';
import {
  HERDR_AGENT_NAME,
  createHerdrReporter,
  herdrAgentName,
  herdrPane,
  herdrReportFor,
  herdrSocketEndpoint,
  sendHerdrRequest,
  startHerdrReporting,
  type HerdrReply,
} from '../src/herdr';

/** 等一个条件成立（上报是异步的，测试不能靠 sleep 猜时长）。 */
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等超时了');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 一份最小 state（只填 `herdrReportFor` 会读的那几样，其余用 createInitialState）。 */
function stateWith(overrides: Partial<AgentState>): AgentState {
  const base = createInitialState({
    systemPrompt: 'test',
    providerName: 'faux',
    modelId: 'fake',
    toolNames: ['ask_user_question'],
  });
  return { ...base, ...overrides };
}

interface FakeHerdr {
  /** 造 pane 时给的那个原始路径（`herdrSocketEndpoint` 之前的形状，与 `HERDR_SOCKET_PATH` 同形）。 */
  raw: string;
  requests: Record<string, unknown>[];
  close(): Promise<void>;
}

/**
 * 一个只收不干活的 herdr。
 *
 * `fail` 给了就每条回执都带 `error`（模拟 herdr 拒了这次上报）。
 * 监听地址走 `herdrSocketEndpoint`：Windows 上必须是个命名管道名，Linux 上是个临时文件。
 */
async function fakeHerdr(fail?: string): Promise<FakeHerdr> {
  const name = `ela-herdr-test-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const raw = process.platform === 'win32' ? name : path.join(tmpdir(), `${name}.sock`);
  const requests: Record<string, unknown>[] = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const request = JSON.parse(line) as { id?: string };
        requests.push(request as Record<string, unknown>);
        const reply =
          fail === undefined
            ? { id: request.id, result: { type: 'ok' } }
            : { id: request.id, error: { code: 'invalid_request', message: fail } };
        socket.write(`${JSON.stringify(reply)}\n`);
        index = buffer.indexOf('\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(herdrSocketEndpoint(raw), resolve));
  return {
    raw,
    requests,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== 'win32') rmSync(raw, { force: true });
    },
  };
}

test('herdrAgentName：默认 pi，可覆盖，可整个关掉', () => {
  assert.equal(herdrAgentName({}), HERDR_AGENT_NAME);
  assert.equal(herdrAgentName({ ELA_HERDR_AGENT: 'claude' }), 'claude');
  for (const off of ['off', '0', '']) {
    assert.equal(herdrAgentName({ ELA_HERDR_AGENT: off }), undefined, `${off} 该关掉`);
  }
});

test('herdrPane：三个变量齐全才算在 herdr 里', () => {
  const full = { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p2', HERDR_SOCKET_PATH: '/tmp/herdr.sock' };
  assert.deepEqual(herdrPane(full), { paneId: 'w1:p2', socketPath: '/tmp/herdr.sock' });
  assert.equal(herdrPane({ ...full, HERDR_ENV: '0' }), undefined);
  assert.equal(herdrPane({ ...full, HERDR_ENV: undefined }), undefined);
  assert.equal(herdrPane({ ...full, HERDR_PANE_ID: '' }), undefined);
  assert.equal(herdrPane({ ...full, HERDR_SOCKET_PATH: undefined }), undefined);
});

test('herdrSocketEndpoint：Windows 是命名管道，加 \\\\.\\pipe\\ 前缀', () => {
  const raw = 'C:\\Users\\me\\AppData\\Roaming\\herdr\\herdr.sock';
  assert.equal(herdrSocketEndpoint(raw, 'win32'), `\\\\.\\pipe\\${raw}`);
  assert.equal(herdrSocketEndpoint('/home/me/.config/herdr/herdr.sock', 'linux'), '/home/me/.config/herdr/herdr.sock');
  assert.equal(herdrSocketEndpoint('/Users/me/.config/herdr/herdr.sock', 'darwin'), '/Users/me/.config/herdr/herdr.sock');
});

test('herdrReportFor：idle / working / blocked 三档', () => {
  assert.deepEqual(herdrReportFor(stateWith({ phase: 'idle' })), { state: 'idle' });
  assert.deepEqual(herdrReportFor(stateWith({ phase: 'thinking' })), { state: 'working' });
  assert.deepEqual(herdrReportFor(stateWith({ phase: 'calling-tools' })), { state: 'working' });

  // 问卷挂起：phase 还是 calling-tools，但该报 blocked（那才是「等你」）。
  const asking = stateWith({
    phase: 'calling-tools',
    executing: [
      {
        // 只用到 name，其余字段凑形状。
        call: { type: 'toolCall', id: 'call-1', name: 'ask_user_question', arguments: {} },
        startedAt: Date.now(),
      },
    ],
  });
  assert.deepEqual(herdrReportFor(asking), { state: 'blocked', message: '等待你回答问卷' });

  // 别的工具在跑 → 还是 working（不能把所有工具都当「等你」）。
  const running = stateWith({
    phase: 'calling-tools',
    executing: [
      { call: { type: 'toolCall', id: 'call-2', name: 'bash', arguments: {} }, startedAt: Date.now() },
    ],
  });
  assert.deepEqual(herdrReportFor(running), { state: 'working' });

  // 会话引用原样带上（不给就不带那个键）。
  const session = { path: '/tmp/s.jsonl', id: 's1', resumeArgv: ['ela', '--session', 's1'] };
  assert.deepEqual(herdrReportFor(stateWith({ phase: 'idle' }), session), { state: 'idle', session });
});

test('sendHerdrRequest：连不上只是 ok:false，不抛', async () => {
  const raw = process.platform === 'win32' ? 'ela-herdr-不存在' : path.join(tmpdir(), 'ela-herdr-不存在.sock');
  const reply = await sendHerdrRequest(herdrSocketEndpoint(raw), { id: 'x', method: 'pane.report_agent' }, 200);
  assert.equal(reply.ok, false);
});

test('上报器：request 形状、去重、seq 单调、release', async () => {
  const herdr = await fakeHerdr();
  try {
    const reporter = createHerdrReporter({ pane: { paneId: 'w1:p2', socketPath: herdr.raw }, agent: 'pi' });
    const first = { state: 'working' as const, session: { path: '/tmp/s.jsonl', id: 's1' } };

    reporter.report(first);
    await waitFor(() => herdr.requests.length === 1);

    const request = herdr.requests[0] as { id: string; method: string; params: Record<string, unknown> };
    assert.equal(request.method, 'pane.report_agent');
    assert.equal(request.id.startsWith('ela:'), true);
    assert.deepEqual(
      { ...request.params, seq: undefined },
      {
        pane_id: 'w1:p2',
        source: 'ela',
        agent: 'pi',
        state: 'working',
        agent_session_path: '/tmp/s.jsonl',
        agent_session_id: 's1',
        seq: undefined,
      },
    );
    const firstSeq = request.params.seq as number;
    assert.equal(Number.isFinite(firstSeq), true);

    // 一模一样再来一次：一条都不该发（ela 的 store 每来一个 token 都会叫我们）。
    reporter.report(first);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(herdr.requests.length, 1, '内容没变不该再发');

    // 变了才发，且 seq 必须更大（herdr 会丢掉不比上次大的）。
    reporter.report({ ...first, state: 'blocked', message: '等待你回答问卷' });
    await waitFor(() => herdr.requests.length === 2);
    const second = herdr.requests[1] as { params: Record<string, unknown> };
    assert.equal(second.params.state, 'blocked');
    assert.equal(second.params.message, '等待你回答问卷');
    assert.equal((second.params.seq as number) > firstSeq, true);

    // resume 命令：不是数组就不报（herdr 会校验形状），是数组就原样过去。
    reporter.report({
      state: 'idle',
      session: { id: 's1', resumeArgv: ['ela', '--session', 's1'] },
    });
    await waitFor(() => herdr.requests.length === 3);
    const third = herdr.requests[2] as { params: Record<string, unknown> };
    assert.deepEqual(third.params.resume_argv, ['ela', '--session', 's1']);

    reporter.release();
    await waitFor(() => herdr.requests.length === 4);
    const released = herdr.requests[3] as { method: string; params: Record<string, unknown> };
    assert.equal(released.method, 'pane.release_agent');
    assert.equal(released.params.agent, 'pi');
  } finally {
    await herdr.close();
  }
});

test('上报器：herdr 回 error 时只在第一次出声', async () => {
  const herdr = await fakeHerdr('invalid_resume_argv');
  try {
    const reasons: string[] = [];
    const reporter = createHerdrReporter({
      pane: { paneId: 'w1:p2', socketPath: herdr.raw },
      agent: 'pi',
      onError: (reason) => reasons.push(reason),
    });

    reporter.report({ state: 'working' });
    await waitFor(() => reasons.length === 1);
    assert.equal(reasons[0], 'invalid_resume_argv');

    reporter.report({ state: 'idle' });
    await waitFor(() => herdr.requests.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(reasons, ['invalid_resume_argv'], '第二次不再出声（免得刷屏）');
  } finally {
    await herdr.close();
  }
});

/**
 * 一个只给 `startHerdrReporting` 看的最小 store。
 *
 * 它只用 `getState` + `subscribe`（不 dispatch、不跑环）—— 那正是那个函数的全部接口，
 * 所以拿真的 store 反而会拖进整个 effect 表（假 provider 的流、回合状态机……），
 * 测出来的东西也不在本次改动里。
 */
function fakeStore(initial: AgentState): { store: AgentStore; set(next: AgentState): void } {
  let state = initial;
  const listeners = new Set<() => void>();
  const store = {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as AgentStore;
  return {
    store,
    set(next: AgentState): void {
      state = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

test('接线：不在 herdr 里就什么都不发', async () => {
  const { store } = fakeStore(stateWith({ phase: 'idle' }));
  const sent: unknown[] = [];
  const stop = startHerdrReporting({
    store,
    env: {},
    send: async (_endpoint, request): Promise<HerdrReply> => {
      sent.push(request);
      return { ok: true };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  stop();
  assert.deepEqual(sent, []);
});

test('接线：订阅 store、按需上报、拆台时放开 pane', async () => {
  const herdr = await fakeHerdr();
  try {
    const { store, set } = fakeStore(stateWith({ phase: 'idle' }));
    const stop = startHerdrReporting({
      store,
      env: {
        HERDR_ENV: '1',
        HERDR_PANE_ID: 'w1:p2',
        HERDR_SOCKET_PATH: herdr.raw,
      },
      session: () => ({ id: 's1', resumeArgv: ['ela', '--session', 's1'] }),
    });

    // 订阅那一刻先补一次（恢复场景下 store 里早就不是空的）。
    await waitFor(() => herdr.requests.length === 1);
    const initial = herdr.requests[0] as { params: Record<string, unknown> };
    assert.equal(initial.params.state, 'idle');
    assert.deepEqual(initial.params.resume_argv, ['ela', '--session', 's1']);

    // 进 thinking → working。
    set(stateWith({ phase: 'thinking' }));
    await waitFor(() => herdr.requests.length === 2);
    const working = herdr.requests[1] as { params: Record<string, unknown> };
    assert.equal(working.params.state, 'working');

    stop();
    await waitFor(() => herdr.requests.length === 3);
    assert.equal((herdr.requests[2] as { method: string }).method, 'pane.release_agent');

    // 拆台之后 store 再怎么动都不发了。
    set(stateWith({ phase: 'thinking' }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(herdr.requests.length, 3);
  } finally {
    await herdr.close();
  }
});
