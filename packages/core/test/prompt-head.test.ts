/**
 * head（请求最前面那条 system 消息）与「请求上下文」的形状。
 *
 * ## 为什么这些断言值得单独一个文件
 *
 * 发出去的字节能不能复用前缀缓存，**全在这条 head 的形状上**：
 *
 * - head 必须是 `messages[0]`，而且**不能**同时给 `Context.systemPrompt` / `Context.tools`
 *   —— 给了的话 pi-ai 的 `normalizeContext` 会**每轮**再造一条
 *   （`createInitialSystemMessage`），prompt 改一个字整条 head 重造，缓存前缀全废；
 * - head 里必须带 `toolsAdded` —— pi-ai 的 `resolveTranscriptTools` 支持原地加工具时
 *   顶层 tools 字段**只发 head 那批**，head 不带的话模型一个工具都看不到；
 * - 同一份输入必须产出一模一样的字节（`toToolDeclaration` 的 JSON 往返 + sections 键序）。
 *
 * 这些都不是「看起来对就行」的性质：每一条坏了都只有**账单**和**命中率**会说话，
 * 界面上什么都看不出来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getCurrentSystemMessage,
  getSystemMessageText,
  normalizeContext,
  resolveTranscript,
  resolveTranscriptTools,
  type Tool,
} from '@earendil-works/pi-ai';
import { buildPromptHead, buildRequestContext } from '../src/prompt-head';
import { buildPromptParts, promptToolsFrom } from '../src/system-prompt';

/** 一份最小工具声明。 */
const READ: Tool = {
  name: 'read',
  description: '读文件',
  parameters: { type: 'object', properties: {}, required: [] } as never,
};

test('head：有分段时 content 留空，文本全在 sections 里；无分段（老会话）时走 content', () => {
  const head = buildPromptHead({
    systemPrompt: '整段文本',
    sections: { preamble: '前言', cwd: '<cwd>/tmp</cwd>' },
    tools: [READ],
  });
  assert.equal(head.role, 'system');
  assert.equal(head.content, '', '有分段时 content 必须是空的（否则 prompt 会出现两遍）');
  assert.deepEqual(head.sections, { preamble: '前言', cwd: '<cwd>/tmp</cwd>' });
  assert.deepEqual(head.toolsAdded?.map((t) => t.name), ['read']);

  // 旧轨迹的 init 段没有 sections —— 那时只有一整段可用，不能凭空造分段。
  const legacy = buildPromptHead({ systemPrompt: '整段文本', tools: [READ] });
  assert.equal(legacy.content, '整段文本');
  assert.equal(legacy.sections, undefined);
});

test('head：渲染回整段时与旧路径逐字节相同（模型看到的 prompt 一个字没变）', () => {
  // 这是这次改动的**底线**：换形状不许换字节。`buildSystemPromptText` 以前发的就是
  // 「从 sections 渲染出来的整段」，所以拿真实装配出来的 sections 渲染一遍必须相等。
  const cwd = process.cwd();
  const tools = promptToolsFrom(cwd);
  const parts = buildPromptParts({ cwd, tools });
  const head = buildPromptHead({ systemPrompt: parts.text, sections: parts.sections, tools: [] });
  assert.equal(getSystemMessageText(head), parts.text);
});

test('head：同一份输入两次构造字节全同（前缀稳定的必要条件）', () => {
  const build = (): string =>
    JSON.stringify(
      buildPromptHead({
        systemPrompt: 's',
        sections: { preamble: 'p', skills: '<skills>k</skills>', cwd: '<cwd>/x</cwd>' },
        tools: [READ],
      }),
    );
  assert.equal(build(), build());
});

test('head：工具声明洗过（typebox 的 symbol 键、undefined 字段不进字节）', () => {
  // `toToolDeclaration` 的 JSON 往返就是干这个的。不洗的话「同一份工具集」两次序列化
  // 可能不同 —— 而那正好落在前缀里。
  const withNoise = {
    name: 't',
    description: 'd',
    parameters: { type: 'object', properties: { a: { type: 'string', description: undefined } } },
    [Symbol('typebox')]: true,
  } as unknown as Tool;
  const head = buildPromptHead({ systemPrompt: 's', tools: [withNoise] });
  const serialized = JSON.stringify(head.toolsAdded?.[0]);
  assert.ok(!serialized.includes('undefined'), `字节里不该有 undefined：${serialized}`);
});

test('请求上下文：不带 systemPrompt / tools，head 在 messages[0]，对话顺序不变', () => {
  const user = { role: 'user' as const, content: '你好', timestamp: 1 };
  const context = buildRequestContext({
    systemPrompt: 's',
    sections: { preamble: 's' },
    tools: [READ],
    messages: [user],
  });
  assert.equal(context.systemPrompt, undefined, '给了它 pi-ai 会每轮再造一条 head');
  assert.equal(context.tools, undefined, '顶层工具集由 head 的 toolsAdded 决定');
  assert.equal(context.messages[0]?.role, 'system');
  assert.equal(context.messages[1], user, '对话消息原样跟在后面');

  // `normalizeContext` 不会再插一条：它只在 systemPrompt/tools 非空时才造 head。
  const normalized = normalizeContext(context);
  assert.equal(normalized.messages.length, context.messages.length, '不该凭空多一条 head');
});

test('请求上下文：pi-ai 从 head 取顶层工具集（支持原地加工具时只发初始批）', () => {
  const context = buildRequestContext({
    systemPrompt: 's',
    sections: { preamble: 's' },
    tools: [READ],
    messages: [],
  });
  const anchored = resolveTranscriptTools(context.messages, true);
  assert.deepEqual(anchored.requestTools.map((t) => t.name), ['read'], '顶层就是 head 那批');
  // 不支持原地加工具的模型：发「当前完整集」。此刻两者相同（还没中途加过工具），
  // 但那正是 prefix 稳不稳的分水岭 —— 见 `resolveTranscriptTools` 的锚点判定。
  const full = resolveTranscriptTools(context.messages, false);
  assert.deepEqual(full.requestTools.map((t) => t.name), ['read']);
});

test('不支持 mid-conv system 的模型：head 与后续 patch 被合并成一条（语义不变）', () => {
  const head = buildPromptHead({
    systemPrompt: 's',
    sections: { preamble: '前言', skills: '<skills>旧</skills>' },
    tools: [READ],
  });
  const patch = {
    role: 'system' as const,
    content: '',
    sections: { skills: '<skills>新</skills>' },
    timestamp: 1,
  };
  const collapsed = resolveTranscript(normalizeContext({ messages: [head, patch] }), false);
  assert.equal(
    collapsed.messages.filter((m) => m.role === 'system').length,
    1,
    '不支持时合成一条 head（这就是「替换 message[0]」）',
  );
  const replayed = getCurrentSystemMessage(collapsed.messages);
  assert.equal(replayed?.sections?.preamble, '前言', '没动过的段原样在');
  assert.equal(replayed?.sections?.skills, '<skills>新</skills>', 'patch 按段替换生效');
  assert.deepEqual(replayed?.toolsAdded?.map((t) => t.name), ['read'], '工具声明跟着 head 走');
});
