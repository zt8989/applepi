import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentStore } from '@ela/core/store';
import { createFauxRuntime, demoResponses } from '@ela/core/provider';
import type { Api, Model } from '@earendil-works/pi-ai';
import { WebBridge, modelRefs } from '../src/web/bridge';
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

  const bridge = new WebBridge(
    {
      store,
      cwd: '/tmp/ela-web-test',
      getSessionId: () => 'web-test-session',
      setModel: () => true,
      newSession: () => {},
      resolveModel: (provider) => (provider === 'faux' ? model : null),
      // 模型目录与服务端同一条路：调用方喂的是 `modelRefs(getAvailableSnapshot())`。
      modelCatalog: [
        { provider: 'faux', id: 'fake', name: 'Faux', reasoning: true },
        { provider: 'faux', id: 'fake-2', name: 'Faux 2', reasoning: false },
      ],
      scopedModelIds: () => ['faux/fake'],
    },
    ['测试诊断一行'],
  );

  // 造一份假的 dist：一个 index.html + 一个资源，外加一个不存在的路径（验 SPA 回退）。
  const dist = mkdtempSync(path.join(tmpdir(), 'ela-web-dist-'));
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="app"></div>');
  writeFileSync(path.join(dist, 'asset.txt'), 'hello-asset');

  const server = await startWebServer({ bridge, port: 0, distDir: dist });
  return {
    server,
    bridge,
    store,
    dist,
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
    // 模型目录与作用域随 hello 一起来（浏览器侧选择器就吃它）。
    assert.deepEqual(
      hello.models.map((m) => `${m.provider}/${m.id}`),
      ['faux/fake', 'faux/fake-2'],
    );
    assert.equal(hello.models[0]?.name, 'Faux');
    assert.equal(hello.models[0]?.reasoning, true);
    assert.deepEqual(hello.scopedModelIds, ['faux/fake']);

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

test('bridge：没给目录时 hello 给空列表；空作用域归一成 null（= 全开）', () => {
  const faux = createFauxRuntime();
  faux.setResponses(demoResponses());
  const store = createAgentStore({ runtime: faux.runtime, systemPrompt: 'test' });
  const bridge = new WebBridge({
    store,
    cwd: '/tmp/ela-web-test',
    getSessionId: () => 's',
    setModel: () => true,
    newSession: () => {},
    resolveModel: () => null,
    scopedModelIds: () => [],
  });
  try {
    const hello = bridge.hello();
    assert.equal(hello.type, 'hello');
    if (hello.type !== 'hello') throw new Error('unreachable');
    assert.deepEqual(hello.models, []);
    // `[]` 与「没配过」是同一件事（与 TUI 的 `normalizeEnabled()` 同一个口径）。
    assert.equal(hello.scopedModelIds, null);
  } finally {
    bridge.dispose();
  }
});
