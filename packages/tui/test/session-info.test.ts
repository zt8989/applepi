/**
 * `/session`（pi 同名命令：Show session info and stats）的统计与排版。
 *
 * ## 为什么要钉这两件事
 *
 * 1. **口径**：那张卡上的数字必须与底栏那一排 `↑↓R$` 一致（都念 `state.messages`）。
 *    两者对不上时，用户会以为「算错了」而不去用其中任何一个 —— 而这两个数字正是回答
 *    「这个月是谁在烧钱 / 这个会话到底跑了多少」的唯一入口。
 * 2. **`Cache Re-billed` 那种行不出现**：本项目没有缓存预热、没有按模型重算的费用，
 *    pi 那张卡里对应的区块不该被照搬进来（印一个恒为 0 的数字就是噪声）。
 *
 * 纯函数测试：`formatSessionCard()` 只认两个上色函数，不必起终端。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AssistantMessage, Message, Usage } from '@earendil-works/pi-ai';
import { collectSessionStats, formatSessionCard } from '../src/session-info';

/** 不上色的 style：断言里就不用与 ANSI 序列打架。 */
const plain = { dim: (text: string) => text, bold: (text: string) => text };

function usage(overrides: Partial<Usage> = {}): Usage {
  const input = overrides.input ?? 100;
  const output = overrides.output ?? 50;
  const cacheRead = overrides.cacheRead ?? 0;
  const cacheWrite = overrides.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}

function assistant(content: AssistantMessage['content'], options: {
  usage?: Usage;
  provider?: string;
  model?: string;
  responseModel?: string;
} = {}): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: options.provider ?? 'faux',
    model: options.model ?? 'fake',
    ...(options.responseModel !== undefined ? { responseModel: options.responseModel } : {}),
    usage: options.usage ?? usage(),
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

const user = (text: string): Message => ({
  role: 'user',
  content: [{ type: 'text', text }],
  timestamp: Date.now(),
});

test('collect：消息条数按 role 分，工具调用数的是 assistant 里的 toolCall 块', () => {
  const messages: Message[] = [
    user('你好'),
    assistant([
      { type: 'text', text: '我查一下' },
      { type: 'toolCall', id: 't1', name: 'read', arguments: {} },
      { type: 'toolCall', id: 't2', name: 'grep', arguments: {} },
    ]),
    // toolResult 是**一条消息**（不是 assistant 里的块）—— 与 pi 的 `tools` 两个数同口径。
    { role: 'toolResult', toolCallId: 't1', toolName: 'read', content: [], isError: false, timestamp: Date.now() },
    { role: 'toolResult', toolCallId: 't2', toolName: 'grep', content: [], isError: false, timestamp: Date.now() },
    assistant([{ type: 'text', text: '好了' }]),
  ];

  const stats = collectSessionStats(messages);
  assert.deepEqual(stats.messages, { total: 5, user: 1, assistant: 2, toolCalls: 2, toolResults: 2 });
});

test('collect：token 的 prompt = input + cacheRead + cacheWrite（pi 的算法）', () => {
  const stats = collectSessionStats([
    user('喂'),
    assistant([{ type: 'text', text: '一' }], { usage: usage({ input: 100, output: 10, cacheRead: 300, cacheWrite: 0 }) }),
    assistant([{ type: 'text', text: '二' }], { usage: usage({ input: 100, output: 10, cacheRead: 400, cacheWrite: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } }) }),
  ]);

  // input 200 / output 20 / cacheRead 700 / cacheWrite 100 → prompt 1000，total 1020
  assert.equal(stats.tokens.input, 200);
  assert.equal(stats.tokens.output, 20);
  assert.equal(stats.tokens.cacheRead, 700);
  assert.equal(stats.tokens.cacheWrite, 100);
  assert.equal(stats.tokens.prompt, 1000);
  assert.equal(stats.tokens.total, 1020);
  // 命中率 = cacheRead / prompt：700/1000 = 70.0%
  assert.equal(stats.tokens.cacheHitRate?.toFixed(1), '70.0');
  assert.equal(stats.cost, 0.5);
});

test('collect：没有 usage 的助手消息不参与 token 统计（但不影响条数）', () => {
  // 手写一份：`assistant()` 的默认值会补一个 usage，表达不了「这条就是没有」。
  // 真出现这种消息的地方是**回放**：老版本写下的 assistant 消息里没有 usage。
  const noUsage = {
    role: 'assistant',
    content: [{ type: 'text', text: '没有用量' }],
    api: 'openai-completions',
    provider: 'faux',
    model: 'fake',
    stopReason: 'stop',
    timestamp: Date.now(),
  } as unknown as Message;
  const stats = collectSessionStats([user('喂'), noUsage]);
  assert.equal(stats.messages.assistant, 1);
  assert.equal(stats.tokens.prompt, 0);
  assert.equal(stats.tokens.cacheHitRate, undefined, '一次请求都没有就别算命中率（会除零）');
});

test('collect：费用按模型分组，贵的在前（与 pi 的 getUsageCostBreakdown 同一排序）', () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const stats = collectSessionStats([
    assistant([{ type: 'text', text: '便宜' }], {
      model: 'cheap',
      usage: usage({ input: 1000, output: 100, cost: { ...zero, total: 0.001 } }),
    }),
    assistant([{ type: 'text', text: '贵' }], {
      model: 'pricey',
      usage: usage({ input: 1000, output: 100, cost: { ...zero, total: 0.9 } }),
    }),
    assistant([{ type: 'text', text: '还是贵的' }], {
      model: 'pricey',
      usage: usage({ input: 1000, output: 100, cost: { ...zero, total: 0.1 } }),
    }),
  ]);

  assert.deepEqual(
    stats.costByModel.map((entry) => entry.key),
    ['faux/pricey', 'faux/cheap'],
  );
  assert.equal(stats.costByModel[0]?.cost.toFixed(3), '1.000');
  // `responseModel` 优先（provider 回给的真实模型名），与 pi 同一口径。
  assert.equal(
    collectSessionStats([assistant([{ type: 'text', text: 'x' }], { model: 'req', responseModel: 'real' })]).costByModel[0]?.key,
    'faux/real',
  );
});

test('format：四节齐全，且不带 pi 那张卡里的 Cache Warming', () => {
  const card = formatSessionCard(
    collectSessionStats([
      user('你好'),
      assistant([{ type: 'text', text: '在' }], { usage: usage({ input: 100, output: 20, cacheRead: 900 }) }),
    ]),
    { file: '/home/u/.pi/agent/sessions/--x--/1_x.jsonl', id: '019abc', name: '修 bug' },
    plain,
  );

  assert.match(card, /^会话信息$/m);
  assert.match(card, /名称: 修 bug/);
  assert.match(card, /文件: \/home\/u\/\.pi\/agent\/sessions/);
  assert.match(card, /ID: 019abc/);
  assert.match(card, /^消息$/m);
  assert.match(card, /总计: 2/);
  assert.match(card, /工具: 0 次调用，0 个结果/);
  assert.match(card, /^令牌$/m);
  // prompt = 100 + 900 = 1000，缓存命中 900（90.0%），未缓存 100
  assert.match(card, /输入: 1,000/);
  assert.match(card, /缓存: 900 \(90\.0%\)/);
  assert.match(card, /未缓存: 100/);
  assert.match(card, /输出: 20/);
  assert.match(card, /总计: 1,020/);
  assert.doesNotMatch(card, /Cache Warming|费用/, '没有费用时不印那一节（pi 同条件）');
});

test('format：没落盘 / 没起名的会话不编造', () => {
  const card = formatSessionCard(collectSessionStats([]), { id: 'abc' }, plain);
  assert.match(card, /文件: （还没落盘/);
  assert.doesNotMatch(card, /名称:/, '没名字就不印那一行（与 pi 一致）');
  assert.match(card, /总计: 0/);
});

test('format：多个模型才拆开费用（一行与总计重复时是噪声）', () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const single = formatSessionCard(
    collectSessionStats([
      assistant([{ type: 'text', text: 'x' }], { usage: usage({ cost: { ...zero, total: 0.25 } }) }),
    ]),
    { id: 'a' },
    plain,
  );
  assert.match(single, /总计: \$0\.250/);
  assert.doesNotMatch(single, /faux\/fake:/);

  const multi = formatSessionCard(
    collectSessionStats([
      assistant([{ type: 'text', text: 'x' }], { model: 'one', usage: usage({ cost: { ...zero, total: 0.2 } }) }),
      assistant([{ type: 'text', text: 'y' }], { model: 'two', usage: usage({ cost: { ...zero, total: 0.1 } }) }),
    ]),
    { id: 'a' },
    plain,
  );
  assert.match(multi, /faux\/one: \$0\.200/);
  assert.match(multi, /faux\/two: \$0\.100/);
});
