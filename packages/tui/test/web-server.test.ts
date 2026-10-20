import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentStore } from '@ela/core/store';
import { createFauxRuntime, demoResponses } from '@ela/core/provider';
import { createTraceTree } from '@ela/core/trace';
import type { Api, Model } from '@earendil-works/pi-ai';
import { WebBridge, attachmentLabel, modelRefs, promptContent, usablePromptAttachments } from '../src/web/bridge';
import { createWebApi } from '../src/web/api';
import { startWebServer, type WebServerHandle } from '../src/web/server';
import type { WebServerMessage } from '@ela/core/web-protocol';
import { WEB_PROTOCOL_VERSION } from '@ela/core/web-protocol';
import { findSessionFile } from '@ela/core/config-home';
import { QuestionnaireSession } from '@ela/core/questionnaire';

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
async function start(bridgeOptions: {
  resumeSession?: (id: string, cwd: string) => Promise<{ restored: number }>;
  cwdLabel?: (state: ReturnType<ReturnType<typeof createAgentStore>['getState']>) => string;
} = {}): Promise<{
  server: WebServerHandle;
  bridge: WebBridge;
  store: ReturnType<typeof createAgentStore>;
  dist: string;
  dispose(): Promise<void>;
}> {
  const faux = createFauxRuntime();
  faux.setResponses(demoResponses());
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    sessionId: 'web-test-session',
    cwd: '/tmp/ela-web-test',
  });

  const model = {
    id: 'fake',
    provider: 'faux',
    name: 'Faux',
    api: 'openai-completions',
    contextWindow: 1000,
    reasoning: true,
  } as unknown as Model<Api>;

  const resolveModel = (provider: string): Model<Api> | null => (provider === 'faux' ? model : null);
  const bridge = new WebBridge(
    {
      store,
      setModel: () => true,
      newSession: () => {},
      ...(bridgeOptions.resumeSession !== undefined ? { resumeSession: bridgeOptions.resumeSession } : {}),
      ...(bridgeOptions.cwdLabel !== undefined ? { cwdLabel: bridgeOptions.cwdLabel } : {}),
      resolveModel,
    },
    ['测试诊断一行'],
  );
  // 非会话数据的 HTTP 接口：命令表 / 模型目录 / settings 都从这里出。
  const api = createWebApi({
    store,
    modelCatalog: () => [model, { ...model, id: 'fake-2', name: 'Faux 2', reasoning: false }],
    resolveModel,
    setModel: () => true,
    autoCompactEnabled: () => true,
    setAutoCompactEnabled: () => {},
    commands: () => [
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
    // 工具耗时表随状态一起来（工具卡上那个 `1.2s`）；没跑过工具就是空表。
    assert.deepEqual(hello.state.toolTimings, {});

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

    // 命令表：内置的只有标了 `web` 的进，扩展的一律进（`sessions` 是会话类，不进），
    // prompt 模板插在两者之间（与 TUI 补全、pi 的顺序一致）。
    ctx.store.dispatch({
      type: 'prompt.init',
      systemPrompt: '',
      tools: [],
      promptTemplates: [
        {
          name: 'council',
          description: 'Run a council',
          content: 'Council body',
          filePath: '/tmp/council.md',
          scope: 'user',
        },
      ],
    } as never);
    const commands = (await (await fetch(`${ctx.server.url}api/commands`)).json()) as {
      name: string;
      source: string;
    }[];
    assert.deepEqual(
      commands.map((c) => c.name),
      ['model', 'council', 'ext-thing'],
    );
    assert.equal(commands[1]?.source, 'prompt');
    assert.equal(commands[2]?.source, 'extension');

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

test('bridge：会话身份（id / cwd）住在 store 里 —— 桥跟着 store 走', async () => {
  const ctx = await start();
  try {
    // 初始那份来自 `createAgentStore({ sessionId, cwd })`。
    assert.deepEqual(ctx.store.getState().session, {
      id: 'web-test-session',
      cwd: '/tmp/ela-web-test',
    });

    // 换会话（`/new` 与浏览器的「新会话」走的都是这条 action）—— 桥发出去的
    // sessionId 必须是**换过的那个**，而且 cwd 不跟着变（它在内核启动时定）。
    ctx.store.dispatch({ type: 'conversation.reset', sessionId: 'web-test-next' });
    assert.equal(ctx.store.getState().session.id, 'web-test-next');
    assert.equal(ctx.store.getState().session.cwd, '/tmp/ela-web-test');
    const hello = ctx.bridge.hello();
    if (hello.type !== 'hello') throw new Error('unreachable');
    assert.equal(hello.state.sessionId, 'web-test-next');
    assert.equal(hello.state.cwd, '/tmp/ela-web-test');

    // 不带 id 的 reset 只清对话，会话身份不动。
    ctx.store.dispatch({ type: 'conversation.reset' });
    assert.equal(ctx.store.getState().session.id, 'web-test-next');
  } finally {
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
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    sessionId: 'web-test-session',
    cwd: '/tmp/ela-web-test',
  });
  const api = createWebApi({
    store,
    modelCatalog: () => [],
    resolveModel: () => null,
    setModel: () => true,
    autoCompactEnabled: () => null,
    setAutoCompactEnabled: () => {},
    commands: () => [],
    runExtensionCommand: async () => {},
  });
  const info = api.models();
  assert.deepEqual(info.models, []);
  // `[]` 与「没配过」是同一件事（与 TUI 的 `normalizeEnabled()` 同一个口径）。
  assert.equal(info.scoped, null);
});

/**
 * 顶栏那三个入口（完整历史 / 系统 / 工具）的数据源。
 *
 * 它们守的是同一件事：**面板上显示的就是模型这一轮收到的东西**。
 * 所以断言的不是「接口能通」，而是「内容真的是 state 里那份」。
 */
test('bridge：工具耗时随状态发出去（工具卡上那个 `1.2s` 靠它）', async () => {
  const ctx = await start();
  try {
    ctx.store.dispatch({
      type: 'tool/start',
      call: { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'echo hi' } },
    });
    ctx.store.dispatch({
      type: 'tool.result',
      message: {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'hi' }],
        isError: false,
        timestamp: Date.now(),
      },
    });
    const hello = ctx.bridge.hello();
    if (hello.type !== 'hello') throw new Error('unreachable');
    // 耗时不进消息、也不进会话文件，只在这张表里（界面用）。
    const elapsed = hello.state.toolTimings['c1'];
    assert.equal(typeof elapsed, 'number', 'reducer 在 `tool.result` 那一刻记下耗时');
    assert.ok((elapsed ?? -1) >= 0);
  } finally {
    await ctx.dispose();
  }
});

test('web api：系统提示词与工具定义就是 state 里发给模型的那两份', async () => {
  const ctx = await start();
  try {
    const prompt = (await (await fetch(`${ctx.server.url}api/system-prompt`)).json()) as {
      text: string;
      sections: Record<string, string>;
    };
    // `createAgentStore({ systemPrompt: 'test' })` —— store 里装的就是它。
    assert.equal(prompt.text, 'test');
    assert.deepEqual(prompt.sections, {}, '没装分段就是空对象（不是 undefined）');

    // 这个装配一个工具都没装 → 空表（界面显示「没有启用的工具」）。
    const tools = (await (await fetch(`${ctx.server.url}api/tools`)).json()) as unknown[];
    assert.deepEqual(tools, []);
  } finally {
    await ctx.dispose();
  }
});

test('web api：完整历史读会话文件（压缩掉的早期消息也在），没文件时退回内存', async () => {
  const ctx = await start();
  try {
    // 1) 文件还没落盘（新会话）：用内存那份兜底，页面上要写明来源。
    ctx.store.dispatch({ type: 'user.message', text: '内存里的那句话' });
    const fallback = await fetch(`${ctx.server.url}api/history`);
    assert.equal(fallback.status, 200);
    assert.match(fallback.headers.get('content-type') ?? '', /text\/html/);
    const fallbackHtml = await fallback.text();
    assert.match(fallbackHtml, /完整历史/);
    assert.match(fallbackHtml, /还没落盘/);
    assert.match(fallbackHtml, /内存里的那句话/);
    // 内存里那份 messages 不含 head：页面上要补出「模型收到的系统提示词」，
    // 否则「还没落盘」时看起来像模型压根没收到提示词与工具。
    assert.ok(fallbackHtml.includes('class="role">system'), '要有一条 system（请求头部）');
    assert.match(fallbackHtml, /test/, '就是 store 里那份 systemPrompt');

    // 2) 真有一份会话文件时以它为准 —— 三种 entry 都进时间线。
    //    （家目录由 `isolated-home.ts` 指到本次运行专属的临时目录，不会污染用户目录。）
    const file = findSessionFile('web-test-session', '/tmp/ela-web-test');
    mkdirSync(path.dirname(file), { recursive: true });
    const stamp = new Date().toISOString();
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 1, id: 'web-test-session', timestamp: stamp, cwd: '/tmp/ela-web-test' }),
        // pi v3 的请求头部：system prompt 的分段 + 工具表（这一条以前在页面上是个空壳）。
        JSON.stringify({
          type: 'message',
          id: 'e0',
          parentId: null,
          timestamp: stamp,
          message: {
            role: 'system',
            content: '',
            timestamp: Date.now(),
            sections: { rules: '不许瞎猜', docs: '<script>alert(1)</script>' },
            toolsAdded: [
              {
                name: 'read',
                description: '读文件',
                parameters: { type: 'object', properties: { path: { type: 'string' } } },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'message',
          id: 'e1',
          parentId: 'e0',
          timestamp: stamp,
          message: { role: 'user', content: '落盘的那句话', timestamp: Date.now() },
        }),
        JSON.stringify({ type: 'model_change', id: 'e2', parentId: 'e1', timestamp: stamp, provider: 'faux', modelId: 'fake-9' }),
        JSON.stringify({ type: 'thinking_level_change', id: 'e3', parentId: 'e2', timestamp: stamp, thinkingLevel: 'high' }),
      ].join('\n') + '\n',
      'utf8',
    );
    const html = await (await fetch(`${ctx.server.url}api/history`)).text();
    assert.match(html, /落盘的那句话/);
    assert.match(html, /faux\/fake-9/, '模型切换要成为一条注记');
    assert.match(html, /思考级别 → high/);
    assert.ok(html.includes(file), '页面上要写明读的是哪个文件');
    // 请求头部（系统提示词 + 工具）必须画出来 —— 以前它落到 default 分支，只剩一个空壳。
    assert.match(html, /系统提示词 2 段 · 工具 1 个/);
    assert.ok(html.includes('段 <code>rules</code>'), '每一段都要看得见段名（折叠着也搜得到）');
    assert.match(html, /不许瞎猜/);
    assert.ok(html.includes('<code>read</code>'), '工具名要看得见');
    assert.match(html, /读文件/);
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), '段正文要转义');
    assert.equal(html.includes('<script>alert(1)'), false, '不能把会话里的 HTML 直接插进页面');
  } finally {
    await ctx.dispose();
  }
});

/**
 * composer 下面那一行的左端（工作目录那一行）。
 *
 * 它**由服务端算**（与 `statsText` 同一个理由）：`~` 要服务端的家目录才缩得对，
 * git 分支要读 `.git/HEAD` —— 浏览器两样都碰不到。桥只负责把它上线。
 */
test('bridge：cwdText 走 cwdLabel 回调；不给就退回裸 cwd', () => {
  const faux = createFauxRuntime();
  faux.setResponses(demoResponses());
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    sessionId: 'web-test-session',
    cwd: '/tmp/ela-web-test',
  });
  const labelled = new WebBridge({
    store,
    setModel: () => true,
    newSession: () => {},
    resolveModel: () => null,
    cwdLabel: (state) => `~/proj (main) @${state.session.cwd}`,
  });
  const plain = new WebBridge({ store, setModel: () => true, newSession: () => {}, resolveModel: () => null });
  try {
    const withLabel = labelled.hello();
    const without = plain.hello();
    if (withLabel.type !== 'hello' || without.type !== 'hello') throw new Error('unreachable');
    assert.equal(withLabel.state.cwdText, '~/proj (main) @/tmp/ela-web-test');
    assert.equal(without.state.cwdText, '/tmp/ela-web-test', '没接回调就退回 state 里那个 cwd');
  } finally {
    labelled.dispose();
    plain.dispose();
  }
});

/**
 * 侧边栏那一列会话（每个 cwd 的历史会话）。
 *
 * 守的是三件事：**标题**是给人认的那句话（而不是 id）、**按 cwd 分得开**（两个目录
 * 各一条）、**子会话不单列**（它们属于父会话，单独列出来只会把列表塞满）。
 */
test('web api：/api/sessions 给每个 cwd 的历史会话（标题 / cwd / 条数）', async () => {
  const ctx = await start();
  try {
    const write = (id: string, cwd: string, firstLine: string, extra: Record<string, unknown> = {}): void => {
      const file = findSessionFile(id, cwd);
      mkdirSync(path.dirname(file), { recursive: true });
      const stamp = new Date().toISOString();
      writeFileSync(
        file,
        [
          JSON.stringify({ type: 'session', version: 1, id, timestamp: stamp, cwd, ...extra }),
          JSON.stringify({
            type: 'message',
            id: 'e1',
            parentId: null,
            timestamp: stamp,
            message: { role: 'user', content: firstLine, timestamp: Date.now() },
          }),
        ].join('\n') + '\n',
        'utf8',
      );
    };
    write('sess-alpha', '/tmp/ela-web-alpha', '看看 alpha 的那个 bug');
    write('sess-beta', '/tmp/ela-web-beta', 'beta 的部署脚本');
    // 子代理会话（`parentSession`）：不进侧边栏。
    write('sess-child', '/tmp/ela-web-alpha', '子代理的一条', { parentSession: 'sess-alpha' });

    const info = (await (await fetch(`${ctx.server.url}api/sessions`)).json()) as {
      sessions: { id: string; cwd: string; title: string; messageCount: number }[];
    };
    const byId = new Map(info.sessions.map((session) => [session.id, session]));
    assert.equal(byId.has('sess-child'), false, '子会话不单列');
    assert.equal(byId.get('sess-alpha')?.cwd, '/tmp/ela-web-alpha');
    assert.equal(byId.get('sess-alpha')?.title, '看看 alpha 的那个 bug', '标题是第一句话，不是 id');
    assert.equal(byId.get('sess-beta')?.cwd, '/tmp/ela-web-beta');
    assert.equal(byId.get('sess-beta')?.title, 'beta 的部署脚本');
    assert.equal(typeof byId.get('sess-alpha')?.messageCount, 'number');
  } finally {
    await ctx.dispose();
  }
});

/**
 * 侧边栏点一条 = 恢复它 —— 而这件事**只能由内核出手**（换 id、换文件、对齐记录器
 * 游标），所以桥只把「用户点了哪一条」转给装配它的那一方。
 */
test('bridge：resumeSession 交给内核回调；环在跑时先拒绝', async () => {
  const calls: { id: string; cwd: string }[] = [];
  const ctx = await start({
    resumeSession: async (id, cwd) => {
      calls.push({ id, cwd });
      return { restored: 3 };
    },
  });
  try {
    assert.deepEqual(ctx.bridge.handle({ type: 'resumeSession', id: 'sess-a', cwd: '/tmp/a' }), []);
    // 恢复是异步的：给那个 promise 一个落地的机会。
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, [{ id: 'sess-a', cwd: '/tmp/a' }], 'id + cwd 原样传给内核');

    // 环在跑时换会话会把正在写的那个文件丢掉：拒绝，并说一声（不静默）。
    ctx.store.dispatch({ type: 'user.message', text: '跑起来' });
    assert.notEqual(ctx.store.getState().phase, 'idle');
    const refused = ctx.bridge.handle({ type: 'resumeSession', id: 'sess-b', cwd: '/tmp/b' });
    assert.equal(refused[0]?.type, 'notice');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls.length, 1, '跑着的时候一次都没转给内核');
  } finally {
    await ctx.dispose();
  }
});

test('bridge：没接内核的装配拒绝恢复（说不出来为什么，也不假装成功）', () => {
  const faux = createFauxRuntime();
  faux.setResponses(demoResponses());
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    sessionId: 'web-test-session',
    cwd: '/tmp/ela-web-test',
  });
  const bridge = new WebBridge({ store, setModel: () => true, newSession: () => {}, resolveModel: () => null });
  try {
    const refused = bridge.handle({ type: 'resumeSession', id: 'sess-a', cwd: '/tmp/a' });
    assert.equal(refused[0]?.type, 'notice');
  } finally {
    bridge.dispose();
  }
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
    // 会话身份现在住在状态里（`state.session`）—— 桥的 `snapshot()` 会读它。
    session: { id: 's', cwd: '/tmp/ela-web-test' },
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

    // 不认识的 skill：**不报错**，原样当普通输入发出去（与 pi 的
    // `_expandSkillCommand()` 一致 —— 认不出就原样返回）。
    dispatched.length = 0;
    assert.deepEqual(bridge.handle({ type: 'prompt', text: '/skill:nope 你好' }), []);
    assert.equal(dispatched[0]?.type, 'user.message');
    assert.equal(dispatched[0]?.text, '/skill:nope 你好');
  } finally {
    bridge.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bridge：prompt 模板在服务端展开（正文在磁盘上，浏览器读不到）', () => {
  const dispatched: { type?: string; text?: string }[] = [];
  const state = {
    ...fakeState([]),
    trace: createTraceTree('t'),
    prompt: {
      promptTemplates: [
        {
          name: 'council',
          description: 'Run a council',
          content: 'Council on ${1:-这个问题}。',
          filePath: '/tmp/council.md',
          scope: 'user',
        },
      ],
    },
  };
  const fake = fakeStore(state);
  (fake.store as { dispatch: (action: { type?: string; text?: string }) => void }).dispatch = (action) =>
    dispatched.push(action);
  const bridge = new WebBridge({
    store: fake.store as never,
    setModel: () => true,
    newSession: () => {},
    resolveModel: () => null,
  });
  try {
    assert.deepEqual(bridge.handle({ type: 'prompt', text: '/council "要不要拆包"' }), []);
    assert.equal(dispatched[0]?.type, 'user.message');
    // 参数按 pi 的规则替换，且**不是**把 `/council` 原样发给模型。
    assert.equal(dispatched[0]?.text, 'Council on 要不要拆包。');

    // 没有同名模板的 `/xxx` 保持原样（桥只展开模板，不当命令）。
    dispatched.length = 0;
    assert.deepEqual(bridge.handle({ type: 'prompt', text: '/nope 你好' }), []);
    assert.equal(dispatched[0]?.text, '/nope 你好');
  } finally {
    bridge.dispose();
  }
});

/** 一份能过 `usablePromptAttachments()` 的图片 / 文档（后面几条测试共用）。 */
const imageAttachment = {
  id: 'a',
  type: 'image' as const,
  fileName: 'shot.png',
  mimeType: 'image/png',
  size: 3,
  content: 'AAA',
};
const documentAttachment = {
  id: 'b',
  type: 'document' as const,
  fileName: 'spec.pdf',
  mimeType: 'application/pdf',
  size: 9,
  content: '',
  extractedText: '第一页',
};

test('bridge：promptContent 把附件折成 content 块（图片带文件名标签，文档只留正文）', () => {
  assert.deepEqual(promptContent('看看这张图', [imageAttachment, documentAttachment]), [
    { type: 'text', text: '看看这张图' },
    { type: 'text', text: '[Image: shot.png]' },
    { type: 'image', data: 'AAA', mimeType: 'image/png' },
    { type: 'text', text: '\n\n[Document: spec.pdf]\n第一页' },
  ]);
  // 没有附件：返回 undefined —— 调用方走原来的纯文本路径，消息形状一个字节不变。
  assert.equal(promptContent('你好', []), undefined);
  // 只发附件：没有空的 text 块。
  assert.deepEqual(promptContent('', [imageAttachment]), [
    { type: 'text', text: '[Image: shot.png]' },
    { type: 'image', data: 'AAA', mimeType: 'image/png' },
  ]);
  assert.equal(attachmentLabel([imageAttachment, documentAttachment]), '（附件：shot.png、spec.pdf）');
  assert.equal(attachmentLabel([]), '（附件）');
});

test('bridge：附件逐项验（空图片 / 非图片 MIME / 无正文文档 / 超过 10 份都跳过）', () => {
  const usable = usablePromptAttachments([
    imageAttachment,
    { ...imageAttachment, id: 'empty', fileName: 'empty.png', content: '' },
    { ...imageAttachment, id: 'wrong-mime', fileName: 'a.txt', mimeType: 'text/plain' },
    { ...documentAttachment, id: 'no-text', fileName: 'empty.pdf', extractedText: '   ' },
    documentAttachment,
    { ...imageAttachment, id: 'video', type: 'video' as never, fileName: 'a.mp4', mimeType: 'video/mp4' },
  ]);
  assert.deepEqual(usable.map((attachment) => attachment.fileName), ['shot.png', 'spec.pdf']);

  const many = Array.from({ length: 12 }, (_, index) => ({
    ...documentAttachment,
    id: `d${index}`,
    fileName: `${index}.txt`,
  }));
  assert.equal(usablePromptAttachments(many).length, 10, '一次最多 10 份（与 pi-web-ui 的编辑器同口径）');
});

test('bridge：带附件的 prompt 走 user.message 的 content（不是只发文字）', () => {
  const dispatched: { type?: string; text?: string; content?: unknown[]; as?: string }[] = [];
  const state = { ...fakeState([]), trace: createTraceTree('t'), prompt: {} };
  const fake = fakeStore(state);
  (fake.store as { dispatch: (action: { type?: string; text?: string; content?: unknown[] }) => void }).dispatch = (
    action,
  ) => dispatched.push(action);
  const bridge = new WebBridge({
    store: fake.store as never,
    setModel: () => true,
    newSession: () => {},
    resolveModel: () => fakeModel() as never,
  });
  try {
    assert.deepEqual(
      bridge.handle({ type: 'prompt', text: '看图', attachments: [imageAttachment, documentAttachment] }),
      [],
    );
    assert.equal(dispatched[0]?.type, 'user.message');
    assert.equal(dispatched[0]?.text, '看图');
    assert.equal(dispatched[0]?.content?.length, 4, '一条正文 + 图片标签 + 图片块 + 文档块');

    // 只有附件：轨迹 / 队列那一行要有字可显示（用文件名顶上）。
    dispatched.length = 0;
    assert.deepEqual(bridge.handle({ type: 'prompt', text: '', attachments: [imageAttachment] }), []);
    assert.equal(dispatched[0]?.text, '（附件：shot.png）');
    assert.equal(dispatched[0]?.content?.length, 2);

    // 一份都用不了：文字照发，但要报一句（不然用户只看到附件没了）。
    dispatched.length = 0;
    const warnings = bridge.handle({
      type: 'prompt',
      text: '你好',
      attachments: [{ ...imageAttachment, content: '' }],
    });
    assert.equal(warnings[0]?.type, 'notice');
    assert.equal(dispatched[0]?.text, '你好');
    assert.equal(dispatched[0]?.content, undefined, '没有可用附件就还是纯文本消息');
  } finally {
    bridge.dispose();
  }
});

test('bridge：附件进了内核的消息流，快照里仍是 content 块（界面靠它画附件）', async () => {
  const ctx = await start();
  try {
    assert.deepEqual(
      ctx.bridge.handle({ type: 'prompt', text: '看图', attachments: [imageAttachment, documentAttachment] }),
      [],
    );
    const hello = ctx.bridge.hello();
    if (hello.type !== 'hello') throw new Error('unreachable');
    // 轨迹派生出来的那条 user 消息带着 content 块 —— 浏览器侧才还原得出附件格子。
    const message = hello.state.messages.find(
      (item) => item.role === 'user' && Array.isArray((item as { content?: unknown }).content),
    ) as { content: { type: string }[] } | undefined;
    assert.ok(message, '快照里要有那条带附件的 user 消息');
    assert.deepEqual(
      message.content.map((block) => block.type),
      ['text', 'text', 'image', 'text'],
    );
  } finally {
    await ctx.dispose();
  }
});

test('web server：附件经 WS 进来仍带着 content 块（parseClientMessage 不能吞掉 attachments）', async () => {
  const ctx = await start();
  const client = await connect(`${ctx.server.url.replace('http', 'ws')}ws`);
  try {
    await client.waitFor('hello', (m) => m.type === 'hello');
    // 走真的 WebSocket + `parseClientMessage()` —— 桥的单测绕不过那道校形门。
    client.send({ type: 'prompt', text: '看图', attachments: [imageAttachment, documentAttachment] });
    const landed = await client.waitFor(
      '带附件的 user 消息',
      (m) =>
        m.type === 'state' &&
        m.state.messages.some((item) => {
          const record = item as { role?: unknown; content?: unknown };
          return (
            record.role === 'user' &&
            Array.isArray(record.content) &&
            record.content.some((block) => (block as { type?: unknown }).type === 'image')
          );
        }),
    );
    if (landed.type !== 'state') throw new Error('unreachable');
    const message = landed.state.messages.find((item) => {
      const record = item as { role?: unknown; content?: unknown };
      return record.role === 'user' && Array.isArray(record.content);
    }) as { content: { type: string }[] };
    assert.deepEqual(
      message.content.map((block) => block.type),
      ['text', 'text', 'image', 'text'],
    );
  } finally {
    client.close();
    await ctx.dispose();
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

test('bridge：问卷整份广播、意图回同一个会话、新连接补发当前那一帧', async () => {
  const ctx = await start();
  const a = await connect(`${ctx.server.url.replace('http', 'ws')}ws`);
  try {
    await a.waitFor('hello', (m) => m.type === 'hello');
    const session = new QuestionnaireSession([
      {
        question: '用哪个库？',
        header: '库',
        multiSelect: false,
        options: [
          { label: 'sqlite', description: '单文件' },
          { label: 'postgres', description: '要一台服务器' },
        ],
      },
      {
        question: '要哪些能力？',
        header: '能力',
        multiSelect: true,
        options: [
          { label: '缓存', description: '内存缓存' },
          { label: '日志', description: '结构化日志' },
        ],
      },
    ]);
    // 真界面上这些是 `tui/app.ts` 的 `openQuestionnaire` 做的：收到意图推进状态、
    // 再把新快照 push 给浏览器。
    const view = ctx.bridge.dialogs.questionnaire;
    assert.ok(view, '桥该提供问卷那一档');
    const intents: string[] = [];
    const handle = view.open(session.snapshot(), (intent) => {
      intents.push(intent.kind);
      session.apply(intent);
      handle.push(session.snapshot());
    });

    const first = await a.waitFor('ui-questionnaire', (m) => m.type === 'ui-questionnaire');
    if (first.type !== 'ui-questionnaire') throw new Error('unreachable');
    assert.equal(first.snapshot.questions.length, 2, '整份问卷一次发过去（不是一问一帧）');
    assert.deepEqual(first.snapshot.answers, [null, null]);

    // 浏览器点了一下 → 服务端状态推进 → 推回一帧。
    a.send({ type: 'ui-questionnaire-intent', id: first.id, intent: { kind: 'pick', index: 1 } });
    const next = await a.waitFor(
      'ui-questionnaire',
      (m) => m.type === 'ui-questionnaire' && m.snapshot.active === 1,
    );
    if (next.type !== 'ui-questionnaire') throw new Error('unreachable');
    assert.deepEqual(intents, ['pick']);
    assert.deepEqual(next.snapshot.answers[0], { kind: 'option', index: 1 });

    // 后开的标签页：补发当前那一帧（否则它什么都看不到，而服务端还在等人答）。
    const b = await connect(`${ctx.server.url.replace('http', 'ws')}ws`);
    try {
      const replay = await b.waitFor('ui-questionnaire', (m) => m.type === 'ui-questionnaire');
      if (replay.type !== 'ui-questionnaire') throw new Error('unreachable');
      assert.equal(replay.id, first.id);
      assert.deepEqual(replay.snapshot.answers[0], { kind: 'option', index: 1 });
    } finally {
      b.close();
    }

    // 旧 id 上晚到的意图该被丢掉（已经关掉的那份问卷不能再改状态）。
    handle.close();
    await a.waitFor('ui-questionnaire-close', (m) => m.type === 'ui-questionnaire-close');
    a.send({ type: 'ui-questionnaire-intent', id: first.id, intent: { kind: 'submit' } });
    a.send({ type: 'ui-questionnaire-intent', id: first.id, intent: { kind: 'submit' } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(intents, ['pick'], '关掉之后的意图不该再进状态机');
  } finally {
    a.close();
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
    session: { id: 's', cwd: '/tmp' },
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

/**
 * 扩展还在后台装载时，浏览器发来的那条**不能现在就发**。
 *
 * 内核 `deferExtensions`（交互式启动，见 `kernel.ts`）把扩展装载推到后台，于是
 * 「`ready` 之前」是一个真实存在的时间窗：那一刻 state 里的工具集与 system prompt
 * 还是「没有扩展」的形状，先发出去的那条会定下一份**缺工具集**的 head ——
 * 而 head 是不可改的历史（见 `prompt-head.ts`），后面补不回来。
 *
 * 终端那边靠 `app.ts` 的 `send()` 等这道门，浏览器这边靠桥的同一个 `ready`
 * （见 `WebBridgeOptions.ready`）。这条测试钉住：等，而且**不丢**用户的输入。
 */
test('bridge：ready 之前发来的消息要等装载完成（并说一声为什么）', async () => {
  const faux = createFauxRuntime();
  faux.setResponses(demoResponses());
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    sessionId: 'ready-gate',
    cwd: '/tmp/ela-web-test',
  });

  let release: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bridge = new WebBridge({
    store,
    setModel: () => true,
    newSession: () => {},
    resolveModel: () => null,
    ready,
  });
  try {
    const replies = bridge.handle({ type: 'prompt', text: '你好' });
    assert.equal(store.getState().messages.length, 0, '装载完成前不该把消息放进 state');
    assert.ok(
      replies.some((message) => message.type === 'notice'),
      '该回一条「为什么还没发出去」',
    );

    release?.();
    // `ready.then` 里那一句 dispatch 在微任务里 —— 等一轮就够（这一轮里环还没跑完，
    // 所以不数总条数：head 与助手回复都是随后才进的）。
    await new Promise((resolve) => setImmediate(resolve));
    const messages = store.getState().messages;
    assert.ok(
      messages.some((message) => (message as { role?: string }).role === 'user'),
      '装载完成后那条消息要**补发**（不能丢）',
    );
    assert.equal(
      messages.filter((message) => (message as { role?: string }).role === 'user').length,
      1,
      '一次发送只能补一条（不是两条）',
    );
  } finally {
    bridge.dispose();
  }
});

/**
 * 侧边栏行末那几个按钮（归档 / 删除 + 项目「删全部」）的服务端那一半。
 *
 * 守的是三件在界面上看不出对错的事：归档的**真的**不在主列表里（而份数对得上）、
 * 恢复能回来、删除**真的**把文件删掉（并且不删当前正在用的那个会话）。
 */
test('web api：归档 / 恢复 / 删除会话（行末那几个按钮的服务端那一半）', async () => {
  const ctx = await start();
  const post = async (pathname: string, body: unknown): Promise<Record<string, unknown>> =>
    (await (
      await fetch(`${ctx.server.url}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json()) as Record<string, unknown>;
  interface ListInfo {
    sessions: { id: string; archivedAt?: number }[];
    archivedCount: number;
  }
  const list = async (pathname: string): Promise<ListInfo> =>
    (await (await fetch(`${ctx.server.url}${pathname}`)).json()) as ListInfo;
  const write = (id: string, cwd: string, firstLine: string): void => {
    const file = findSessionFile(id, cwd);
    mkdirSync(path.dirname(file), { recursive: true });
    const stamp = new Date().toISOString();
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 1, id, timestamp: stamp, cwd }),
        JSON.stringify({
          type: 'message',
          id: 'e1',
          parentId: null,
          timestamp: stamp,
          message: { role: 'user', content: firstLine, timestamp: Date.now() },
        }),
      ].join('\n') + '\n',
      'utf8',
    );
  };

  try {
    write('sess-keep', '/tmp/ela-archive-a', '留着的那条');
    write('sess-arch', '/tmp/ela-archive-a', '要归档的那条');
    write('sess-gone', '/tmp/ela-archive-b', '要删掉的那条');

    assert.equal((await list('api/sessions')).archivedCount, 0, '一开始没人归档');

    const archived = await post('api/sessions/archive', { ids: ['sess-arch'], archived: true });
    assert.equal(archived['ok'], true);

    const main = await list('api/sessions');
    assert.equal(
      main.sessions.some((session) => session.id === 'sess-arch'),
      false,
      '归档的不在主列表里',
    );
    assert.equal(main.archivedCount, 1, '份数是给底部「已归档 · N」的');

    const archiveView = await list('api/sessions/archived');
    const entry = archiveView.sessions.find((session) => session.id === 'sess-arch');
    assert.ok(entry, '归档那一栏能看到它');
    assert.equal(typeof entry.archivedAt, 'number', '归档那一行要显示「什么时候归档的」');

    await post('api/sessions/archive', { ids: ['sess-arch'], archived: false });
    const restored = await list('api/sessions');
    assert.equal(restored.archivedCount, 0, '恢复后份数归零');
    assert.ok(
      restored.sessions.some((session) => session.id === 'sess-arch'),
      '恢复的要回到主列表',
    );

    const removed = await post('api/sessions/delete', { ids: ['sess-gone'] });
    assert.deepEqual(removed['deleted'], ['sess-gone']);
    assert.equal(
      existsSync(findSessionFile('sess-gone', '/tmp/ela-archive-b')),
      false,
      '删除是真删文件，不是只从列表里藏起来',
    );

    // 当前会话不删：它正被记录器拿着（下一次说话会写进一个已删掉的文件）。
    const current = await post('api/sessions/delete', { ids: ['web-test-session'] });
    assert.equal(current['ok'], false);
    assert.equal(typeof current['message'], 'string', '拒绝要有话说，不静默');
  } finally {
    await post('api/sessions/delete', { ids: ['sess-keep', 'sess-arch'] });
    await ctx.dispose();
  }
});

/**
 * `GET /api/history?sessionId=<id>`：有个 id 就能打开那一段。
 *
 * 这条能力是为「会话不在当前 cwd 里」准备的：`resume` 别的项目的会话时内核 cwd 不变
 * （恢复不换工作目录），按 `(id, cwd)` 拼出来的路径是空的 —— 只按 id 跨目录找才对。
 */
test('web api：/api/history?sessionId= 开任意一个会话；找不到给 404', async () => {
  const ctx = await start();
  const write = (id: string, cwd: string, firstLine: string): void => {
    const file = findSessionFile(id, cwd);
    mkdirSync(path.dirname(file), { recursive: true });
    const stamp = new Date().toISOString();
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id, timestamp: stamp, cwd }),
        JSON.stringify({
          type: 'message',
          id: 'e1',
          parentId: null,
          timestamp: stamp,
          message: {
            role: 'system',
            content: '',
            timestamp: Date.now(),
            sections: { rules: '别猜' },
            toolsAdded: [{ name: 'read', description: '读文件', parameters: { type: 'object' } }],
          },
        }),
        JSON.stringify({
          type: 'message',
          id: 'e2',
          parentId: 'e1',
          timestamp: stamp,
          message: { role: 'user', content: firstLine, timestamp: Date.now() },
        }),
      ].join('\n') + '\n',
      'utf8',
    );
  };

  try {
    // 在**别的** cwd 里的一份会话（内核的 cwd 是 /tmp/ela-web-test）。
    write('sess-elsewhere', '/tmp/ela-web-elsewhere', '别处的那个会话');
    const found = await fetch(`${ctx.server.url}api/history?sessionId=sess-elsewhere`);
    assert.equal(found.status, 200);
    const html = await found.text();
    assert.match(html, /别处的那个会话/, '按 id 找到的是那一份会话文件');
    assert.match(html, /ela-web-elsewhere/, '页面上写明它自己的工作目录');
    assert.match(html, /系统提示词 1 段 · 工具 1 个/, '头部照常画出来');
    assert.match(html, /段 <code>rules<\/code>/);

    // 不存在的 id：404 + 说得清楚（不是「还没落盘」，那会让人以为会话还在内存里）。
    const missing = await fetch(`${ctx.server.url}api/history?sessionId=nobody-here`);
    assert.equal(missing.status, 404);
    const missingHtml = await missing.text();
    assert.match(missingHtml, /找不到这个会话/);
    assert.match(missingHtml, /nobody-here/);

    // 形状不像 id 的一律当没有（这串字符会去与文件名比对）。
    const odd = await fetch(`${ctx.server.url}api/history?sessionId=${encodeURIComponent('../etc/passwd')}`);
    assert.equal(odd.status, 404);
    assert.match(await odd.text(), /找不到这个会话/);
  } finally {
    await ctx.dispose();
  }
});

/**
 * 完整历史里的**图片预览**。
 *
 * 图片是会话文件里本来就有的东西（`read` 读图把 base64 塞进工具结果，用户发的附件
 * 也一样），早先那两处只画一个 `[图片]` 占位 —— 而「完整历史」要回答的正是
 * 「当时到底看了什么」。这条钉住：图块要变成 `<img>`（data URL）、文字块不被吞掉。
 */
test('web api：完整历史把图像块画成 <img>（用户附件与工具结果都算）', async () => {
  const ctx = await start();
  // 1x1 像素的透明 PNG —— 内容不重要，重要的是它被原样拼进 data URL。
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  try {
    const file = findSessionFile('web-test-session', '/tmp/ela-web-test');
    mkdirSync(path.dirname(file), { recursive: true });
    const stamp = new Date().toISOString();
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id: 'web-test-session', timestamp: stamp, cwd: '/tmp/ela-web-test' }),
        JSON.stringify({
          type: 'message',
          id: 'e1',
          parentId: null,
          timestamp: stamp,
          message: {
            role: 'user',
            content: [
              { type: 'text', text: '看看这张截图' },
              { type: 'image', data: png, mimeType: 'image/png' },
            ],
            timestamp: Date.now(),
          },
        }),
        JSON.stringify({
          type: 'message',
          id: 'e2',
          parentId: 'e1',
          timestamp: stamp,
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'shot.png' } }],
            api: 'openai-completions',
            provider: 'faux',
            model: 'fake',
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'toolUse',
            timestamp: Date.now(),
          },
        }),
        JSON.stringify({
          type: 'message',
          id: 'e3',
          parentId: 'e2',
          timestamp: stamp,
          message: {
            role: 'toolResult',
            toolCallId: 'call-1',
            toolName: 'read',
            content: [
              { type: 'text', text: 'Read image file [image/png]' },
              { type: 'image', data: png, mimeType: 'image/png' },
            ],
            isError: false,
            timestamp: Date.now(),
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const html = await (await fetch(`${ctx.server.url}api/history`)).text();
    const images = html.match(/<img class="shot"[^>]*>/g) ?? [];
    assert.equal(images.length, 2, '用户消息里一张、工具结果里一张');
    for (const image of images) {
      assert.ok(image.includes(`src="data:image/png;base64,${png}"`), 'data URL 原样拼好（含 MIME 与 base64）');
    }
    assert.match(html, /看看这张截图/, '图片旁边的文字不能被吞掉');
    assert.match(html, /Read image file \[image\/png\]/);
    assert.equal(html.includes('[图片]'), false, '画了图就不再留那个占位文字');
  } finally {
    await ctx.dispose();
  }
});

/**
 * 侧边栏标题：head（system prompt 分段 + 工具表）很大时，仍然是用户的第一句话。
 *
 * 这条是现象驱动的回归：`/api/sessions` 的标题早先自己按 64KB 扫文件头找第一句话，
 * 而 pi v3 的 head 本身就有 ~64KB —— 于是**新会话全显示成一串 uuid**，老会话（head 小）
 * 才碰巧有标题。现在那句由 `listSessions()` 的 512KB 读顺手带出来（`firstMessage`）。
 */
test('web api：/api/sessions 的标题是 head 之后的第一句话，不是 uuid', async () => {
  const ctx = await start();
  try {
    const id = 'sess-big-head';
    const cwd = '/tmp/ela-web-bighead';
    const file = findSessionFile(id, cwd);
    mkdirSync(path.dirname(file), { recursive: true });
    const stamp = new Date().toISOString();
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id, timestamp: stamp, cwd }),
        JSON.stringify({
          type: 'message',
          id: 'e1',
          parentId: null,
          timestamp: stamp,
          message: { role: 'system', content: '', timestamp: 1, sections: { rules: 'x'.repeat(70_000) } },
        }),
        JSON.stringify({
          type: 'message',
          id: 'e2',
          parentId: 'e1',
          timestamp: stamp,
          message: { role: 'user', content: 'head 之后的第一句话', timestamp: 2 },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const info = (await (await fetch(`${ctx.server.url}api/sessions`)).json()) as {
      sessions: { id: string; title: string }[];
    };
    const row = info.sessions.find((session) => session.id === id);
    assert.equal(row?.title, 'head 之后的第一句话');
  } finally {
    await ctx.dispose();
  }
});
