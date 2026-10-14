import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentStore } from '@ela/core/store';
import { createFauxRuntime, demoResponses } from '@ela/core/provider';
import { createTraceTree } from '@ela/core/trace';
import type { Api, Model } from '@earendil-works/pi-ai';
import { WebBridge, modelRefs } from '../src/web/bridge';
import { createWebApi } from '../src/web/api';
import { startWebServer, type WebServerHandle } from '../src/web/server';
import type { WebServerMessage } from '@ela/core/web-protocol';
import { WEB_PROTOCOL_VERSION } from '@ela/core/web-protocol';

/**
 * web server + 桥的集成测试（**不打网络**）。
 *
 * ## 守的是什么
 *
 * 浏览器那一侧（pi-web-ui）只认「状态快照 + 事件」，而真相在服务端的 store 里。
 * 这条链路断在哪一段，症状都是「浏览器界面空着/不更新」，从终端看不出来：
 *
 *   1. 静态资源（`/` 与 SPA 回退）——前端根本没加载；
 *   2. `hello` 握手（版本 + 首帧状态）——连上了但什么都没有；
 *   3. 浏览器 → 服务端（`setThinking` / `prompt`）——**说不上话**；
 *   4. 服务端 → 浏览器（`state` / `message_update`）——**看不见回复**。
 *
 * 跑的是真的 store + 真的 faux provider（pi-ai 自带的假模型），所以第 4 条走的是
 * 完整的 Redux Loop，不是手造的假事件。
 */

/** 一条 WebSocket 的收发记录。 */
interface Client {
  messages: WebServerMessage[];
  send(value: unknown): void;
  close(): void;
  /** 等到某条消息满足条件（超时就抛）。 */
  waitFor(what: string, predicate: (message: WebServerMessage) => boolean): Promise<WebServerMessage>;
}

function connect(url: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const messages: WebServerMessage[] = [];
    const waiters: { predicate: (m: WebServerMessage) => boolean; resolve: (m: WebServerMessage) => void }[] = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as WebServerMessage;
      messages.push(message);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        const waiter = waiters[i];
        if (waiter && waiter.predicate(message)) {
          waiters.splice(i, 1);
          waiter.resolve(message);
        }
      }
    });
    socket.addEventListener('error', () => reject(new Error('ws 连接失败')));
    socket.addEventListener('open', () =>
      resolve({
        messages,
        send: (value) => socket.send(JSON.stringify(value)),
        close: () => socket.close(),
        waitFor: (what, predicate) =>
          new Promise((resolveWait, rejectWait) => {
            const found = messages.find(predicate);
            if (found) return resolveWait(found);
            const timer = setTimeout(() => rejectWait(new Error(`等不到：${what}`)), 8000);
            waiters.push({
              predicate,
              resolve: (message) => {
                clearTimeout(timer);
                resolveWait(message);
              },
            });
          }),
      }),
    );
  });
}

/** 起一个「内核 + 桥 + server」的最小装配。 */
async function start(): Promise<{
  server: WebServerHandle;
  bridge: WebBridge;
  store: ReturnType<typeof createAgentStore>;
  dist: string;
  /** `onPresenceChange` 收到的序列（浏览器连上 / 全断开）。 */
  presence: boolean[];
  dispose(): Promise<void>;
}> {
  const faux = createFauxRuntime();
  faux.setResponses(demoResponses());
  const store = createAgentStore({ runtime: faux.runtime, systemPrompt: 'test' });

  const model = {
    id: 'fake',
    provider: 'faux',
    name: 'Faux',
    api: 'openai-completions',
    contextWindow: 1000,
    reasoning: true,
  } as unknown as Model<Api>;

  const resolveModel = (provider: string): Model<Api> | null => (provider === 'faux' ? model : null);
  const presence: boolean[] = [];
  const bridge = new WebBridge(
    {
      store,
      cwd: '/tmp/ela-web-test',
      getSessionId: () => 'web-test-session',
      setModel: () => true,
      newSession: () => {},
      resolveModel,
      onPresenceChange: (connected) => presence.push(connected),
    },
    ['测试诊断一行'],
  );
  // 非会话数据的 HTTP 接口：命令表 / 模型目录 / settings 都从这里出。
  const api = createWebApi({
    store,
    cwd: '/tmp/ela-web-test',
    modelCatalog: () => [model, { ...model, id: 'fake-2', name: 'Faux 2', reasoning: false }],
    resolveModel,
    setModel: () => true,
    autoCompactEnabled: () => true,
    setAutoCompactEnabled: () => {},
    commands: [
      { name: 'model', description: '换模型', web: true },
      { name: 'sessions', description: '恢复历史会话' },
      { name: 'ext-thing', description: '扩展命令', source: 'extension' },
    ],
    runExtensionCommand: async () => {},
  });

  // 造一份假的 dist：一个 index.html + 一个资源，外加一个不存在的路径（验 SPA 回退）。
  const dist = mkdtempSync(path.join(tmpdir(), 'ela-web-dist-'));
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="app"></div>');
  writeFileSync(path.join(dist, 'asset.txt'), 'hello-asset');

  const server = await startWebServer({ bridge, api, port: 0, distDir: dist });
  return {
    server,
    bridge,
    store,
    dist,
    presence,
    dispose: async () => {
      await server.close();
      bridge.dispose();
      rmSync(dist, { recursive: true, force: true });
    },
  };
}

test('web server：静态资源 + SPA 回退 + 不知道的路径不越界', async () => {
  const ctx = await start();
  try {
    const index = await fetch(`${ctx.server.url}`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /id="app"/);

    const asset = await fetch(`${ctx.server.url}asset.txt`);
    assert.equal(await asset.text(), 'hello-asset');

    // 没有这个文件 → 回 index.html（前端自己按路径渲染）。
    const spa = await fetch(`${ctx.server.url}some/deep/route`);
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /id="app"/);

    // 路径穿越不许把 dist 外面的文件读出去。
    const escape = await fetch(`${ctx.server.url}..%2F..%2Fpackage.json`);
    assert.match(await escape.text(), /id="app"/);

    const health = await fetch(`${ctx.server.url}healthz`);
    assert.equal(await health.text(), 'ok\n');
  } finally {
    await ctx.dispose();
  }
});

test('bridge：hello 带版本与诊断，浏览器 → 服务端 → 浏览器 双向通', async () => {
  const ctx = await start();
  const client = await connect(`${ctx.server.url.replace('http', 'ws')}ws`);
  try {
    const hello = await client.waitFor('hello', (m) => m.type === 'hello');
    assert.equal(hello.type, 'hello');
    if (hello.type !== 'hello') throw new Error('unreachable');
    assert.equal(hello.version, WEB_PROTOCOL_VERSION);
    assert.deepEqual(hello.notices, ['测试诊断一行']);
    assert.equal(hello.state.sessionId, 'web-test-session');
    assert.equal(hello.state.isStreaming, false);
    assert.equal(hello.state.model?.provider, 'faux');
    assert.deepEqual(hello.state.messages, []);

    // 模型目录 / 作用域改走 HTTP 接口（不再随 hello 来）。
    const modelsInfo = (await (await fetch(`${ctx.server.url}api/models`)).json()) as {
      models: { provider: string; id: string; name: string; reasoning: boolean }[];
      scoped: string[] | null;
      current: { provider: string; id: string } | null;
    };
    assert.deepEqual(
      modelsInfo.models.map((m) => `${m.provider}/${m.id}`),
      ['faux/fake', 'faux/fake-2'],
    );
    assert.equal(modelsInfo.models[0]?.name, 'Faux');
    assert.equal(modelsInfo.models[0]?.reasoning, true);
    // 测试环境里没写过 settings.json → 全开。
    assert.equal(modelsInfo.scoped, null);
    assert.equal(modelsInfo.current?.provider, 'faux');

    // 命令表：内置的只有标了 `web` 的进，扩展的一律进（`sessions` 是会话类，不进）。
    const commands = (await (await fetch(`${ctx.server.url}api/commands`)).json()) as {
      name: string;
      source: string;
    }[];
    assert.deepEqual(
      commands.map((c) => c.name),
      ['model', 'ext-thing'],
    );
    assert.equal(commands[1]?.source, 'extension');

    // 动作接口：不认识的模型回 `ok: false` + 一句话（不是异常）。
    const bad = (await (
      await fetch(`${ctx.server.url}api/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ arg: 'nope/nope' }),
      })
    ).json()) as { ok: boolean; message?: string };
    assert.equal(bad.ok, false);
    assert.match(bad.message ?? '', /找不到模型/);

    // 不认识的接口给 404（不能落进 SPA 回退变成一个 200 的 HTML）。
    const missing = await fetch(`${ctx.server.url}api/nope`);
    assert.equal(missing.status, 404);

    // 浏览器写状态：服务端要真的收下并回推一份新状态。
    client.send({ type: 'setThinking', level: 'high' });
    const after = await client.waitFor(
      'thinkingLevel=high 的 state',
      (m) => m.type === 'state' && m.state.thinkingLevel === 'high',
    );
    assert.equal(after.type, 'state');

    // 形状不对的消息直接忽略（不崩、也不回什么）。
    const before = client.messages.length;
    client.send({ type: 'nonsense' });
    client.send('不是 JSON');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(client.messages.length, before, '非法消息不该产生任何回推');

    // 值不认识（级别的字符串是客户端给的）→ 丢弃 + 说一声，而不是 dispatch 进去。
    client.send({ type: 'setThinking', level: 'nonsense' });
    const warn = await client.waitFor('不认识级别的 notice', (m) => m.type === 'notice');
    assert.equal(warn.type, 'notice');
    if (warn.type !== 'notice') throw new Error('unreachable');
    assert.match(warn.text, /不认识的思考级别/);
    assert.equal(ctx.store.getState().thinkingLevel, 'high', '不认识的级别不该改到状态');
  } finally {
    client.close();
    await ctx.dispose();
  }
});

test('bridge：提问后能看见流式事件与最终助手消息（走完整条环）', async () => {
  const ctx = await start();
  const client = await connect(`${ctx.server.url.replace('http', 'ws')}ws`);
  try {
    await client.waitFor('hello', (m) => m.type === 'hello');

    client.send({ type: 'prompt', text: '算一下 (3+4)*6' });

    // 开跑：isStreaming 变 true，且有 agent_start / turn_start。
    const running = await client.waitFor(
      'isStreaming=true',
      (m) => m.type === 'state' && m.state.isStreaming,
    );
    assert.equal(running.type, 'state');
    if (running.type !== 'state') throw new Error('unreachable');
    assert.equal(running.state.streamingMessage?.stopReason, 'pending');

    const started = client.messages.find((m) => m.type === 'event' && m.event.type === 'agent_start');
    assert.ok(started, '要有 agent_start（pi-web-ui 靠它重画）');

    // 流式增量（pi-web-ui 的流式容器就吃这个）。第一帧可能还是空的（刚进 thinking、
    // 一个字都没有）—— 所以等的是「有文本的那一帧」。
    const update = await client.waitFor(
      '带文本的 message_update',
      (m) =>
        m.type === 'event' &&
        m.event.type === 'message_update' &&
        m.event.message.content.some((c) => c.type === 'text' && c.text.length > 0),
    );
    assert.equal(update.type, 'event');
    if (update.type !== 'event' || update.event.type !== 'message_update') throw new Error('unreachable');
    assert.ok(
      update.event.message.content.some((c) => c.type === 'text' && c.text.length > 0),
      '流式消息里该有正在长的文本',
    );

    // 收工：助手消息落进 messages，isStreaming 回 false，且发过 agent_end。
    const idle = await client.waitFor(
      'isStreaming=false 且助手消息已落地',
      (m) =>
        m.type === 'state' &&
        !m.state.isStreaming &&
        m.state.messages.some((message) => message.role === 'assistant'),
    );
    assert.equal(idle.type, 'state');
    if (idle.type !== 'state') throw new Error('unreachable');
    assert.equal(idle.state.streamingMessage, null);
    assert.ok(
      client.messages.some((m) => m.type === 'event' && m.event.type === 'agent_end'),
      '要有 agent_end（清掉流式容器）',
    );
    // 工具结果也在（faux 的 demo 回合会调 bash）。
    assert.ok(
      idle.state.messages.some((message) => message.role === 'toolResult'),
      'demo 回合该跑一个工具，结果要进 messages',
    );
  } finally {
    client.close();
    await ctx.dispose();
  }
});
test('modelRefs：投影成紧凑条目（id / 名字 / 能不能思考）', () => {
  const models = [
    { provider: 'workbuddy', id: 'cn:deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', reasoning: true },
    { provider: 'deepseek', id: 'deepseek-flash', name: '', reasoning: false },
  ] as unknown as Parameters<typeof modelRefs>[0];
  assert.deepEqual(modelRefs(models), [
    { provider: 'workbuddy', id: 'cn:deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', reasoning: true },
    // 名字空 → 退回 id（选择器上不至于空着）。
    { provider: 'deepseek', id: 'deepseek-flash', name: 'deepseek-flash', reasoning: false },
  ]);
});

test('bridge：错误从轨迹派生成合成提示（ela-notice）进线协议的 messages', async () => {
  // 以前 WebUI 的 `errorMessage` 进了线协议，而 pi-web-ui 根本不读它 —— 界面上什么都看不到。
  // 现在错误是从轨迹派生的提示条目，作为合成消息插进 `messages`（浏览器注册的
  // renderer 把它画成卡）。
  const ctx = await start();
  try {
    ctx.store.dispatch({ type: 'user.message', text: '你好' });
    ctx.store.dispatch({
      type: 'llm.failed',
      error: 'LLM 调用超时',
      kind: 'timeout',
      cause: 'timeout',
    });
    const hello = ctx.bridge.hello();
    if (hello.type !== 'hello') throw new Error('unreachable');
    const notices = hello.state.messages.filter(
      (m) => (m as { role?: string }).role === 'ela-notice',
    ) as { tone?: string; title?: string }[];
    assert.ok(notices.length >= 1, '应当有一条合成提示');
    assert.equal(notices[0]?.tone, 'error');
    assert.ok(notices[0]?.title?.includes('超时'), `标题要能读：${notices[0]?.title}`);
  } finally {
    await ctx.dispose();
  }
});

test('web api：空目录给空列表；空作用域归一成 null（= 全开）', () => {
  const faux = createFauxRuntime();
  faux.setResponses(demoResponses());
  const store = createAgentStore({ runtime: faux.runtime, systemPrompt: 'test' });
  const api = createWebApi({
    store,
    cwd: '/tmp/ela-web-test',
    modelCatalog: () => [],
    resolveModel: () => null,
    setModel: () => true,
    autoCompactEnabled: () => null,
    setAutoCompactEnabled: () => {},
    commands: [],
    runExtensionCommand: async () => {},
  });
  const info = api.models();
  assert.deepEqual(info.models, []);
  // `[]` 与「没配过」是同一件事（与 TUI 的 `normalizeEnabled()` 同一个口径）。
  assert.equal(info.scoped, null);
});

test('bridge：`/skill:<名字>` 展开成 <skill> 块再发（文件在服务端，浏览器读不到）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ela-skill-'));
  const file = path.join(dir, 'SKILL.md');
  writeFileSync(file, '---\nname: demo\n---\n这是 skill 正文。\n');
  const skill = {
    name: 'demo',
    description: '演示用',
    filePath: file,
    baseDir: dir,
    disableModelInvocation: false,
    scope: 'user' as const,
  };
  const dispatched: { type?: string; text?: string }[] = [];
  // 桥的构造函数会 snapshot() 一次（读 trace / messages / executing …），所以
  // 假 state 也得把那些字段给全（形状照 `tui-incremental.test.ts` 的 `stateOf`）。
  const state = {
    trace: createTraceTree('t'),
    messages: [],
    prompt: { skills: [skill] },
    phase: 'idle',
    providerName: 'faux',
    modelId: 'fake',
    thinkingLevel: 'off',
    executing: [],
    toolNames: [],
    stopReason: undefined,
    stopCause: null,
    error: null,
    streamingText: '',
    thinkingText: '',
    retrying: false,
  };
  const store = {
    getState: () => state,
    dispatch: (action: { type?: string; text?: string }) => dispatched.push(action),
    subscribe: () => () => {},
  };
  const bridge = new WebBridge({
    store: store as never,
    cwd: '/tmp/ela-web-test',
    getSessionId: () => 's',
    setModel: () => true,
    newSession: () => {},
    resolveModel: () => null,
  });
  try {
    assert.deepEqual(bridge.handle({ type: 'prompt', text: '/skill:demo 帮我看下这个报错' }), []);
    assert.equal(dispatched[0]?.type, 'user.message');
    assert.match(dispatched[0]?.text ?? '', /^<skill name="demo"/);
    assert.match(dispatched[0]?.text ?? '', /这是 skill 正文/);
    assert.match(dispatched[0]?.text ?? '', /帮我看下这个报错$/);

    // 不认识的 skill：回一条警示，**不** dispatch（否则会被当成普通消息发给模型）。
    dispatched.length = 0;
    const warn = bridge.handle({ type: 'prompt', text: '/skill:nope 你好' });
    assert.equal(warn[0]?.type, 'notice');
    assert.equal(dispatched.length, 0);
  } finally {
    bridge.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bridge：扩展对话框广播给所有连接，第一个回答算数', async () => {
  const ctx = await start();
  const a = await connect(`${ctx.server.url.replace('http', 'ws')}ws`);
  const b = await connect(`${ctx.server.url.replace('http', 'ws')}ws`);
  try {
    await a.waitFor('hello', (m) => m.type === 'hello');
    await b.waitFor('hello', (m) => m.type === 'hello');
    const pending = ctx.bridge.dialogs.select('选一个', ['x', 'y'], new AbortController().signal);
    const request = await a.waitFor('ui-request', (m) => m.type === 'ui-request');
    if (request.type !== 'ui-request') throw new Error('unreachable');
    assert.equal(request.method, 'select');
    assert.deepEqual(request.options, ['x', 'y']);
    // 广播给所有连接（哪个标签页答都算）。
    await b.waitFor('ui-request', (m) => m.type === 'ui-request' && m.id === request.id);
    b.send({ type: 'ui-response', id: request.id, value: 'y' });
    assert.equal(await pending, 'y');
    // 另一个标签页收到「关掉弹窗」。
    await a.waitFor('ui-cancel', (m) => m.type === 'ui-cancel' && m.id === request.id);
  } finally {
    a.close();
    b.close();
    await ctx.dispose();
  }
});

test('bridge：对话框被 abort 时回 undefined 并发 ui-cancel（终端先答了那条路）', async () => {
  const ctx = await start();
  const client = await connect(`${ctx.server.url.replace('http', 'ws')}ws`);
  try {
    await client.waitFor('hello', (m) => m.type === 'hello');
    const controller = new AbortController();
    const pending = ctx.bridge.dialogs.input(
      '说点什么',
      '占位',
      controller.signal,
    );
    const request = await client.waitFor('ui-request', (m) => m.type === 'ui-request');
    if (request.type !== 'ui-request') throw new Error('unreachable');
    assert.equal(request.placeholder, '占位');
    controller.abort();
    assert.equal(await pending, undefined);
    await client.waitFor('ui-cancel', (m) => m.type === 'ui-cancel' && m.id === request.id);
  } finally {
    client.close();
    await ctx.dispose();
  }
});

test('bridge：第一个连接 → true、最后一个断开 → false（用来切扩展宿主模式）', async () => {
  const ctx = await start();
  const a = await connect(`${ctx.server.url.replace('http', 'ws')}ws`);
  await a.waitFor('hello', (m) => m.type === 'hello');
  const b = await connect(`${ctx.server.url.replace('http', 'ws')}ws`);
  await b.waitFor('hello', (m) => m.type === 'hello');
  assert.deepEqual(ctx.presence, [true], '第二个连接不该再叫一次 true');
  a.close();
  b.close();
  // 断开是异步的，给它一拍。
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(ctx.presence, [true, false]);
  await ctx.dispose();
});

/**
 * 只做「通知」的假 store。
 *
 * 桥关注的全是 `getState()` 的形状，不需要真的环。`reads()` 数的是 `getState()` 被调了
 * 几次 —— 「没有浏览者就不空转」这条**只能这样验**：空转时连状态都不该读（读一次就要
 * snapshot + stringify 一整份会话）。
 */
function fakeStore(state: Record<string, unknown>): {
  store: Record<string, unknown>;
  notify: () => void;
  reads: () => number;
} {
  const listeners = new Set<() => void>();
  let reads = 0;
  return {
    store: {
      getState: () => {
        reads += 1;
        return state;
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dispatch: () => {},
    },
    notify: () => {
      for (const listener of [...listeners]) listener();
    },
    reads: () => reads,
  };
}

/** 桥要读的那几项（其余字段它不碰）。 */
function fakeState(messages: unknown[]): Record<string, unknown> {
  return {
    phase: 'idle',
    messages,
    providerName: 'faux',
    modelId: 'fake',
    thinkingLevel: 'high',
    streamingText: '',
    thinkingText: '',
    executing: [],
    toolNames: ['bash'],
    stopReason: null,
    stopCause: null,
    error: null,
  };
}

function fakeModel(): unknown {
  return { id: 'fake', provider: 'faux', name: 'Faux', api: 'openai-completions' };
}

/**
 * 没有浏览者时**一个字节都不算**。
 *
 * 这是最常见的情形：终端里跑 ela、没开 web 界面。改之前桥照样每个 token 算一份
 * snapshot + stringify（O(整段会话)），白造几百 MB/s 垃圾，还把 TUI 一起拖卡 ——
 * 实测过堆尖峰 2.6GB、最后 OOM。
 */
test('bridge：没有浏览者时连状态都不读（更不 stringify）', () => {
  const state = fakeState([{ role: 'user', content: '嗨' }]);
  const fake = fakeStore(state);
  const bridge = new WebBridge({
    store: fake.store as never,
    cwd: '/tmp',
    getSessionId: () => 's',
    setModel: () => true,
    newSession: () => {},
    resolveModel: () => fakeModel() as never,
  });
  try {
    const before = fake.reads();
    for (let i = 0; i < 50; i += 1) {
      state.streamingText = `${String(state.streamingText)}x`;
      fake.notify();
    }
    assert.equal(fake.reads(), before, '没人看的时候不该读状态');

    // 接上来之后照样能用：第一个变化就发一帧，且带的是**当下**的状态。
    const seen: WebServerMessage[] = [];
    bridge.subscribe((message) => seen.push(message));
    state.phase = 'thinking';
    fake.notify();
    // 第一个变化就发一帧，而且是**先状态后事件**（`message_update` 要读 isStreaming）。
    const states = seen.filter((m) => m.type === 'state');
    assert.equal(states.length, 1, '订阅之后的第一个变化就该发一帧整份状态');
    const first = seen[0];
    if (first?.type !== 'state') throw new Error('unreachable');
    assert.equal(first.state.isStreaming, true);
    // 空转那段攒下的 50 次变化**不该补播**：`agent_start` 只出现一次（那 50 次里
    // 每一轮都会「开跑又收工」，补播就是几十个假回合）。
    assert.equal(seen.filter((m) => m.type === 'event' && m.event.type === 'agent_start').length, 1);

    // 一动没动的通知**不该引出任何帧**（落盘器回的 `trace.persisted` 就是这种）。
    const after = seen.length;
    fake.notify();
    fake.notify();
    assert.equal(seen.length, after, '状态没变就不该再发');
  } finally {
    bridge.dispose();
  }
});

/**
 * 流式期**整份状态按需发**，而 `message_update` 一条不漏。
 *
 * 这一条守的是那个把内存吃干的形状：改之前每 token 发两份整份状态（`state` +
 * `message_update` 各 stringify 一次），一段 2MB 的会话跑 200 个 token 就是 ~880MB
 * 字符串垃圾。现在整份状态只在「结构变了」时发，流式文本走只带自己那一小条的增量。
 *
 * 同时钉住「秒回的一轮也能看见流式增量」：整份状态合帧之后，一帧都没赶上的短回合
 * 不能连 `message_update` 都丢了（浏览器那侧的流式容器就吃它）。
 */
test('bridge：流式期整份状态不逐 token 发，但增量一条不漏', () => {
  const state = fakeState(
    Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: `第 ${i} 条：${'长'.repeat(200)}` })),
  );
  const fake = fakeStore(state);
  const bridge = new WebBridge({
    store: fake.store as never,
    cwd: '/tmp',
    getSessionId: () => 's',
    setModel: () => true,
    newSession: () => {},
    resolveModel: () => fakeModel() as never,
  });
  try {
    const states: WebServerMessage[] = [];
    let updates = 0;
    bridge.subscribe((message) => {
      if (message.type === 'state') states.push(message);
      else if (message.type === 'event' && message.event.type === 'message_update') updates += 1;
    });

    // 一个「秒回」的回合：开跑 → 200 个 token → 收工，全在一个 tick 里跑完。
    state.phase = 'thinking';
    fake.notify();
    for (let i = 0; i < 200; i += 1) {
      state.streamingText = `${String(state.streamingText)}模型正在思考`;
      fake.notify();
    }
    state.messages = [...(state.messages as unknown[]), { role: 'assistant', content: '好了' }];
    state.phase = 'idle';
    state.streamingText = '';
    fake.notify();

    assert.ok(states.length <= 3, `整份状态该是按需发的，实际发了 ${states.length} 帧`);
    assert.ok(updates >= 200, `流式增量不该被合帧吃掉（实际 ${updates} 条）`);
    // 收工那一帧把助手消息带上了（界面靠它落地）。
    const last = states[states.length - 1];
    if (last?.type !== 'state') throw new Error('unreachable');
    assert.equal(last.state.isStreaming, false);
    assert.ok(last.state.messages.some((message) => (message as { role?: string }).role === 'assistant'));
  } finally {
    bridge.dispose();
  }
});
