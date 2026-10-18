/**
 * `before_agent_start` 的**段补丁**：扩展写回的 `sections` 怎么变成一条消息。
 *
 * ## 要钉住的三件事
 *
 * 1. **只发真的变了的段**。扩展（MCP）每轮都会把 `mcp_servers` 整段重写一遍 ——
 *    要是每轮都当成「变了」，对话里会以每轮一条的速度堆出一模一样的 system 消息，
 *    token 白花、前缀缓存也白瞎。
 * 2. **head 一动不动**。补丁是**新**消息，装载时那条（`state.prompt`）不许改 ——
 *    前缀缓存就是靠这个。
 * 3. **删段要能表达**（`null`）。handler 不再写某个段 = 那一段该消失。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getCurrentSystemMessage } from '@earendil-works/pi-ai';
import { createAgentStoreWith } from '../src/store';
import { createFauxRuntime, demoResponses } from '../src/provider';
import { buildRequestContext } from '../src/prompt-head';
import { notifyBeforeAgentStart } from '../src/extension-prompt';

function freshStore(): ReturnType<typeof createAgentStoreWith> {
  const faux = createFauxRuntime();
  faux.setResponses(demoResponses());
  return createAgentStoreWith({ runtime: faux.runtime, cwd: process.cwd() });
}

/** 装载一次 prompt（内核那一步的缩影），带上分段。 */
function seedPrompt(store: ReturnType<typeof createAgentStoreWith>['store']): void {
  store.dispatch({
    type: 'prompt.init',
    systemPrompt: '整段 prompt',
    sections: { preamble: '前言', cwd: '<cwd>/tmp</cwd>' },
    tools: [],
  } as never);
}

/** 跑一轮 `before_agent_start`，把扩展写回的东西交给补丁计算。 */
async function run(
  store: ReturnType<typeof createAgentStoreWith>['store'],
  handler: (event: { systemPromptOptions: { sections: Record<string, string> } }) => void,
): Promise<Record<string, string | null> | undefined> {
  return notifyBeforeAgentStart({
    handlers: [handler as never],
    store,
    text: 'hi',
    cwd: process.cwd(),
    ctx: {} as never,
    selectedTools: [],
  });
}

test('段补丁：扩展新写的段只发一次，第二轮同样内容不再追加', async () => {
  const { store } = freshStore();
  seedPrompt(store);

  const write = (event: { systemPromptOptions: { sections: Record<string, string> } }): void => {
    event.systemPromptOptions.sections.mcp_servers = '<mcp>1</mcp>';
  };

  const first = await run(store, write);
  assert.deepEqual(first, { mcp_servers: '<mcp>1</mcp>' }, '只有新段进补丁');
  store.dispatch({
    type: 'prompt.segment.added',
    role: 'system',
    text: '',
    sections: first ?? {},
    source: 'before_agent_start',
  } as never);

  const second = await run(store, write);
  assert.equal(second, undefined, '同样的内容不许再追加一条（否则每轮堆一条）');
});

test('段补丁：扩展不再写某个段 = 删掉它（补丁里是 null），且只删一次', async () => {
  const { store } = freshStore();
  seedPrompt(store);
  // 先让 `mcp_servers` 通过一次补丁存在。
  const first = await run(store, (event) => {
    event.systemPromptOptions.sections.mcp_servers = '<mcp>1</mcp>';
  });
  store.dispatch({
    type: 'prompt.segment.added',
    role: 'system',
    text: '',
    sections: first ?? {},
    source: 'before_agent_start',
  } as never);

  // 这一轮它只碰 preamble（内容照旧）—— 等于「不要 mcp_servers 了」。
  const removal = await run(store, () => {});
  assert.deepEqual(removal, { mcp_servers: null }, '消失的段表达成 null');
  store.dispatch({
    type: 'prompt.segment.added',
    role: 'system',
    text: '',
    sections: removal ?? {},
    source: 'before_agent_start',
  } as never);

  assert.equal(await run(store, () => {}), undefined, '删过之后就别再删了');
});

test('段补丁：head 一动不动，补丁是新消息，回放出来的 prompt 却是最新的', async () => {
  const { store } = freshStore();
  seedPrompt(store);
  const patch = await run(store, (event) => {
    event.systemPromptOptions.sections.skills = '<skills>新</skills>';
  });
  store.dispatch({
    type: 'prompt.segment.added',
    role: 'system',
    text: '',
    sections: patch ?? {},
    source: 'before_agent_start',
  } as never);

  // head 的原料没变（前缀缓存的全部依据）。
  assert.equal(store.getState().prompt.systemPrompt, '整段 prompt');
  assert.deepEqual(store.getState().prompt.sections, { preamble: '前言', cwd: '<cwd>/tmp</cwd>' });

  // 请求里是 head + 一条补丁，而回放出来的 sections 已经是最新的。
  const context = buildRequestContext({
    systemPrompt: store.getState().prompt.systemPrompt,
    sections: store.getState().prompt.sections,
    tools: [],
    messages: store.getState().messages,
  });
  assert.equal(context.messages.filter((m) => m.role === 'system').length, 2);
  assert.deepEqual(getCurrentSystemMessage(context.messages)?.sections, {
    preamble: '前言',
    cwd: '<cwd>/tmp</cwd>',
    skills: '<skills>新</skills>',
  });
});

test('事件形状：`systemPrompt` 是官方必填的字符串（缺了 pi-background-tasks 会抛）', async () => {
  const { store } = freshStore();
  seedPrompt(store);
  // `pi-background-tasks` 的 shell 策略 handler 就是这么开头的：先把事件当一个
  // `{ systemPrompt: unknown }` 看，不是 string / string[] 就直接抛
  // `pi_bg_shell_prompt_unsupported`（症状是启动时一条诊断，而那段 shell 指引永远
  // 进不了 prompt）。这里钉住：给出去的那份是**装载时整段**，且是字符串。
  let seen: unknown;
  const patch = await run(store, (event) => {
    seen = (event as unknown as { systemPrompt: unknown }).systemPrompt;
  });
  assert.equal(seen, '整段 prompt', '`systemPrompt` 必须是当时生效的整段');
  assert.equal(patch, undefined, '只读事实不该顺手制造一条补丁');
});

test('段补丁：环在跑的时候不发（返回 undefined，不追加）', async () => {
  const { store } = freshStore();
  seedPrompt(store);
  store.dispatch({ type: 'user.message', text: '先说一句' } as never);
  const patch = await run(store, (event) => {
    event.systemPromptOptions.sections.mcp_servers = '<mcp>1</mcp>';
  });
  assert.equal(patch, undefined, '环在跑时那个事件没有对应的一轮语义');
});
