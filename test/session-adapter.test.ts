import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Type,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type ImageContent,
  type Model,
  type TextContent,
} from '@earendil-works/pi-ai/compat';
import type { Attachment } from '@earendil-works/pi-web-ui';
import { createPiAiEffectTable } from '../src/effects';
import { createAgentStore, waitForIdle, type AgentStore } from '../src/store';
import { createFauxRuntime, type FauxRuntime } from '../src/provider';
import { createSessionAdapter, type SessionAdapter, type UiEvent } from '../web/src/session-adapter';

/**
 * Web 侧现在是 Redux 驱动的：没有 pi-agent-core 的 Agent，也没有「四行置空」的特殊接线。
 * 这些测试在 node 下跑（不碰浏览器 API），验证 adapter 给 pi-web-ui 的那层翻译：
 * 状态树 → lifecycle 事件 → 界面读的那个 session 结构。
 */

/** 形状与 pi-web-ui 的 convertAttachments 一致；这里自己折，避免测试去加载 DOM 包。 */
const convertAttachments = (attachments: Attachment[]): (TextContent | ImageContent)[] =>
  attachments.map((a) =>
    a.type === 'image'
      ? { type: 'image' as const, data: a.content, mimeType: a.mimeType }
      : { type: 'text' as const, text: `\n\n[Document: ${a.fileName}]\n${a.extractedText ?? a.content}` },
  );

/** 一个「先调工具、再给答案」的离线脚本。 */
function fauxWithToolRoundTrip(): FauxRuntime {
  const runtime = createFauxRuntime();
  runtime.setResponses([
    fauxAssistantMessage(
      [fauxText('我来算。'), fauxToolCall('calc', { expression: '(3+4)*6' })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage([fauxText('(3+4)*6 = 42')]),
  ]);
  return runtime;
}

/**
 * 一个「一句话答完」的离线脚本。
 *
 * faux 的响应队列是**消费制**的：用掉就没了，所以「一次 prompt 只回一句话」和
 * 「工具来回」需要两份脚本。
 */
function fauxSingleTurn(...replies: string[]): FauxRuntime {
  const runtime = createFauxRuntime();
  runtime.setResponses(replies.map((text) => fauxAssistantMessage([fauxText(text)])));
  return runtime;
}

function adapterFor(runtime: FauxRuntime): { store: AgentStore; adapter: SessionAdapter } {
  const streamFn = (model: Model<any>, context: never, options?: never) =>
    runtime.runtime.models.streamSimple(model, context, options);
  const store = createAgentStore({
    runtime: runtime.runtime,
    systemPrompt: 'test',
    effects: createPiAiEffectTable({
      streamFn: streamFn as never,
      model: runtime.runtime.model,
      resolveKey: () => undefined,
    }),
  });
  const adapter = createSessionAdapter({
    store,
    model: runtime.runtime.model,
    tools: [],
    convertAttachments: convertAttachments as never,
  });
  return { store, adapter };
}

function watch(adapter: SessionAdapter): { events: UiEvent[]; stop: () => void } {
  const events: UiEvent[] = [];
  const stop = adapter.subscribe((e) => events.push(e));
  return { events, stop };
}

test('adapter：prompt 走 Redux 环，工具回合在同一条消息链上', async () => {
  const { store, adapter } = adapterFor(fauxWithToolRoundTrip());

  await adapter.prompt('算一下 (3+4)*6');
  const state = await waitForIdle(store);

  assert.equal(state.phase, 'idle');
  assert.equal(state.turns, 2);
  assert.deepEqual(
    state.messages.map((m) => m.role),
    ['user', 'assistant', 'toolResult', 'assistant'],
  );
});

test('adapter：状态变化翻译成 pi-web-ui 认识的那几个 lifecycle 事件', async () => {
  const { store, adapter } = adapterFor(fauxWithToolRoundTrip());
  const { events, stop } = watch(adapter);

  await adapter.prompt('算一下 (3+4)*6');
  await waitForIdle(store);
  stop();

  // pi-web-ui 的 AgentInterface 只 switch 这些 type（见它的 setupSessionSubscription）。
  const seen = new Set(events.map((e) => e.type));
  for (const expected of [
    'turn_start',
    'message_start',
    'message_update',
    'message_end',
    'turn_end',
    'agent_end',
  ]) {
    assert.ok(seen.has(expected as UiEvent['type']), `缺少事件：${expected}`);
  }

  // 流式必须有中间态，不能只有最终一条 message_update。
  const updates = events.filter((e) => e.type === 'message_update');
  assert.ok(updates.length >= 2, `message_update 只有 ${updates.length} 条，没有流式过程`);

  // agent_end 收尾：界面靠它关掉流式容器与生成中动画。
  assert.equal(events.at(-1)?.type, 'agent_end');
});

test('adapter：两轮 LLM 各起一次流（streamSeq 单调递增）', async () => {
  const { store, adapter } = adapterFor(fauxWithToolRoundTrip());
  const { events, stop } = watch(adapter);

  await adapter.prompt('算一下 (3+4)*6');
  await waitForIdle(store);
  stop();

  // 一次 prompt 里调了两次 LLM（工具前 + 工具后），所以是两轮流、两对 turn_start。
  const starts = events.filter((e) => e.type === 'turn_start');
  assert.equal(starts.length, 2);
  assert.equal(store.getState().streamSeq, 2);
});

test('adapter：session.state 是 pi-web-ui 要的那个形状', async () => {
  const { store, adapter } = adapterFor(fauxSingleTurn('你好。'));

  const idle = adapter.state;
  assert.equal(idle.isStreaming, false);
  assert.deepEqual(idle.messages, []);
  assert.equal(idle.thinkingLevel, 'off');
  assert.equal(idle.pendingToolCalls instanceof Set, true);
  assert.equal(idle.model.id, store.getState().modelId);

  await adapter.prompt('你好');
  const state = await waitForIdle(store);
  assert.equal(state.messages.length, 2, '一轮问答 = user + assistant');

  // 每次访问都要给新的 messages 数组：pi-web-ui 按引用判断重渲染，
  // 复用同一个引用的话「工具回合之后最后一条不显示」（原 bridge.ts 踩过这个坑）。
  assert.notEqual(adapter.state.messages, adapter.state.messages);
});

test('adapter：isStreaming 跟着相位走', async () => {
  const { store, adapter } = adapterFor(fauxWithToolRoundTrip());
  const seen: boolean[] = [];
  const stop = adapter.subscribe(() => seen.push(adapter.state.isStreaming));

  await adapter.prompt('算一下 (3+4)*6');
  await waitForIdle(store);
  stop();

  assert.ok(seen.includes(true), '生成期间 isStreaming 必须是 true');
  assert.equal(adapter.state.isStreaming, false, '跑完后必须回 false');
});

test('adapter：写 session.state.thinkingLevel 被翻成 thinking.changed', () => {
  const { store, adapter } = adapterFor(fauxWithToolRoundTrip());

  // pi-web-ui 的 MessageEditor 就是这么写的：`session.state.thinkingLevel = level`。
  adapter.state.thinkingLevel = 'high';

  assert.equal(store.getState().thinkingLevel, 'high');
  // 读回来也是状态树里的值（setter 之上还有 getter）。
  assert.equal(adapter.state.thinkingLevel, 'high');
});

test('adapter：附件折成 content 块，消息仍是标准 pi-ai user 消息', async () => {
  const { store, adapter } = adapterFor(fauxWithToolRoundTrip());

  await adapter.prompt({
    content: '看看这个',
    attachments: [
      { id: '1', type: 'image', content: 'AAA', mimeType: 'image/png', fileName: 'a.png', size: 3 },
      {
        id: '2',
        type: 'document',
        content: 'raw',
        extractedText: '正文',
        mimeType: 'text/plain',
        fileName: 'b.txt',
        size: 3,
      },
    ],
  });
  const state = await waitForIdle(store);

  const user = state.messages[0];
  assert.ok(user && user.role === 'user');
  assert.ok(Array.isArray(user.content), '带附件时 content 应该是块数组');
  const blocks = user.content as (TextContent | ImageContent)[];
  assert.equal(blocks.length, 3, '一段文本 + 两个附件');
  assert.equal(blocks[0]?.type, 'text');
  assert.equal(blocks[1]?.type, 'image');
  assert.equal(blocks[2]?.type, 'text');
  assert.match(String((blocks[2] as TextContent).text), /正文/);
});

test('adapter：空输入不触发环', async () => {
  const { store, adapter } = adapterFor(fauxWithToolRoundTrip());

  await adapter.prompt('   ');
  assert.equal(store.getState().phase, 'idle');
  assert.equal(store.getState().messages.length, 0);
});

test('adapter：conversation.reset 之后 session 变空，环还能再起', async () => {
  const { store, adapter } = adapterFor(fauxSingleTurn('第一轮的回答。', '第二轮的回答。'));
  const { stop } = watch(adapter);

  await adapter.prompt('第一轮');
  await waitForIdle(store);
  assert.equal(store.getState().messages.length, 2);

  store.dispatch({ type: 'conversation.reset' });
  assert.deepEqual(adapter.state.messages, [], 'reset 之后 session 变空');
  assert.equal(adapter.state.isStreaming, false);

  // 环还能再起：reset 把 streamSeq 归零，但新一轮照样发 turn_start。
  await adapter.prompt('第二轮');
  const state = await waitForIdle(store);
  stop();

  assert.equal(state.phase, 'idle');
  assert.equal(state.streamSeq, 1, 'reset 之后 streamSeq 从 0 重新数');
  assert.equal(state.messages.length, 2);
});

test('adapter：abort 中断当前流，相位回 idle', async () => {
  // 一个会一直吐 delta 的流，直到 signal 被 abort 才收尾（模仿真实 provider 的行为）。
  const runtime = createFauxRuntime();
  const message: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'faux',
    model: runtime.runtime.model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'aborted',
    errorMessage: 'aborted',
    timestamp: Date.now(),
  };
  /** 一直吐 delta 的流，直到 signal 被 abort 才收尾 —— 模仿真实 provider 的中断行为。 */
  const endlessStream = (signal: AbortSignal | undefined) => ({
    async *[Symbol.asyncIterator]() {
      while (!signal?.aborted) {
        yield { type: 'text_delta', contentIndex: 0, delta: 'x', partial: message } as never;
        await new Promise((r) => setTimeout(r, 5));
      }
      yield { type: 'error', reason: 'aborted', error: message } as never;
    },
  });
  // 抓住 effect 传进来的 signal：这是 abortRun 真正 abort 的那个对象。
  let captured: AbortSignal | undefined;

  const store = createAgentStore({
    runtime: runtime.runtime,
    systemPrompt: 'test',
    streamFn: ((_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
      captured = options?.signal;
      return endlessStream(captured);
    }) as never,
  });
  const adapter = createSessionAdapter({
    store,
    model: runtime.runtime.model,
    tools: [],
    convertAttachments: convertAttachments as never,
  });

  void adapter.prompt('一直说');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(adapter.state.isStreaming, true);

  assert.ok(captured, 'effect 必须把 signal 交给 streamFn');
  assert.equal(captured.aborted, false);

  adapter.abort();
  assert.equal(captured.aborted, true, 'adapter.abort 必须真的 abort 那个 signal');

  // 流收尾后相位闭合。aborted 标记由 llm.failed 的错误文本判定。
  const state = await waitForIdle(store, 2000);
  assert.equal(state.phase, 'idle');
  assert.equal(adapter.state.isStreaming, false);
});

test('adapter：工具列表原样透出（pi-web-ui 按名字挑工具卡片）', () => {
  const { store } = adapterFor(fauxWithToolRoundTrip());
  const tool = {
    name: 'calc',
    label: '计算器',
    description: '算算术',
    parameters: Type.Object({ expression: Type.String() }),
    execute: async () => ({ content: [{ type: 'text' as const, text: '42' }], details: null }),
  };
  const adapter = createSessionAdapter({
    store,
    model: createFauxRuntime().runtime.model,
    tools: [tool],
    convertAttachments: convertAttachments as never,
  });

  assert.equal(adapter.state.tools.length, 1);
  // label 是 UI 要读的：pi-web-ui 拿 tools 按名字找渲染器，找不到就退回 JSON。
  assert.equal(adapter.state.tools[0]?.label, '计算器');
  // 每次都是新数组（同一个引用会让 pi-web-ui 跳过重渲染）。
  assert.notEqual(adapter.state.tools, adapter.state.tools);
});
