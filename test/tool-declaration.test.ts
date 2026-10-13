/**
 * 工具集的**中途变更**与**声明增量**。
 *
 * ## 这个文件钉住的是一条不变式的替换
 *
 * 早先本项目写死「工具集装载时定死」（窗口外 `setActiveTools` 一律拒绝）。换成
 * 「中途可变」之后，安全责任从「不许改」转移到了**「改了要声明」**：
 *
 * - `tools.changed` 只更新 `state.prompt.tools`（当前能执行什么）；
 * - `agent.run` 在请求前把「能执行的」与「已声明给模型的」diff 成一条
 *   `toolsAdded` / `toolsRemoved` 消息（pi-agent-core 的 `declareToolChanges` 同一步）；
 * - **head 永远是装载时那批**（`state.prompt.headTools`）—— 它一动，前缀缓存全废。
 *
 * 少了最后一条，功能看起来是对的（模型确实拿到了新工具），代价却只有账单知道。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getCurrentTools } from '@earendil-works/pi-ai';
import type { Tool } from '@earendil-works/pi-ai';
import { createAgentStoreWith } from '../src/store';
import { createFauxRuntime, demoResponses } from '../src/provider';
import { buildPromptHead, declaredToolSchemas } from '../src/prompt-head';
import type { PromptToolDefinition } from '../src/actions';
import type { AgentState } from '../src/state';
import { _transitions } from '../src/reducer';

function tool(name: string, description = `${name} 的说明`): PromptToolDefinition {
  return {
    name,
    description,
    parameters: { type: 'object', properties: {}, required: [] } as never,
  };
}

function freshStore(): ReturnType<typeof createAgentStoreWith> {
  const faux = createFauxRuntime();
  faux.setResponses(demoResponses());
  const made = createAgentStoreWith({ runtime: faux.runtime, cwd: process.cwd() });
  // 装载：提示词 + 工具 [read, bash]（headTools 也记这一批）。
  made.store.dispatch({
    type: 'prompt.init',
    systemPrompt: '整段',
    sections: { preamble: '整段' },
    tools: [tool('read'), tool('bash')],
  } as never);
  return made;
}

/** 当前请求会看到的「已声明工具名」。 */
function declaredNames(state: AgentState): string[] {
  const head = buildPromptHead({
    systemPrompt: state.prompt.systemPrompt,
    ...(state.prompt.sections !== undefined ? { sections: state.prompt.sections } : {}),
    tools: declaredToolSchemas(state.prompt.headTools ?? state.prompt.tools),
  });
  return getCurrentTools([head, ...state.messages]).map((t: Tool) => t.name);
}

test('工具集中途可变：tools.changed 更新当前声明，但 headTools 不动', () => {
  const { store } = freshStore();
  const before = store.getState().prompt.headTools?.map((t) => t.name);
  assert.deepEqual(before, ['read', 'bash'], '装载时记下了 head 那一批');

  store.dispatch({ type: 'tools.changed', tools: [tool('read'), tool('bash'), tool('web_search')] } as never);

  assert.deepEqual(store.getState().prompt.tools.map((t) => t.name), ['read', 'bash', 'web_search']);
  assert.deepEqual(
    store.getState().prompt.headTools?.map((t) => t.name),
    ['read', 'bash'],
    'head 的原料不许跟着变（它就是前缀缓存）',
  );

  // head 的字节确实没变。
  const headOf = (): string =>
    JSON.stringify(
      buildPromptHead({
        systemPrompt: store.getState().prompt.systemPrompt,
        sections: store.getState().prompt.sections,
        tools: declaredToolSchemas(store.getState().prompt.headTools ?? []),
      }),
    );
  assert.equal(headOf(), headOf());
});

test('声明增量：工具变了，agent.run 追加一条 toolsAdded（且只追加一次）', () => {
  const { store } = freshStore();
  assert.deepEqual(declaredNames(store.getState()), ['read', 'bash'], '装载时就是这批');

  store.dispatch({ type: 'tools.changed', tools: [tool('read'), tool('bash'), tool('web_search')] } as never);
  assert.deepEqual(declaredNames(store.getState()), ['read', 'bash'], '还没发生请求，transcript 里仍是旧的');

  store.dispatch({ type: 'agent.run' } as never);
  const afterFirst = store.getState().messages.filter((m) => m.role === 'system');
  assert.equal(afterFirst.length, 1, '追加了一条声明消息');
  assert.deepEqual(
    afterFirst[0]?.role === 'system' ? afterFirst[0].toolsAdded?.map((t) => t.name) : [],
    ['web_search'],
    '只声明**新增**的那个（不是整份重发）',
  );
  assert.deepEqual(declaredNames(store.getState()), ['read', 'bash', 'web_search'], '现在模型看得见它了');

  // 再跑一轮：没变 → 一个字节都不加（否则每轮堆一条）。
  store.dispatch({ type: 'agent.run' } as never);
  assert.equal(store.getState().messages.filter((m) => m.role === 'system').length, 1);
});

test('声明增量：工具被摘掉时发 toolsRemoved，模型那里也真的没了', () => {
  const { store } = freshStore();
  store.dispatch({ type: 'tools.changed', tools: [tool('read')] } as never);
  store.dispatch({ type: 'agent.run' } as never);

  const message = store.getState().messages.at(-1);
  assert.equal(message?.role, 'system');
  assert.deepEqual(
    message?.role === 'system' ? message.toolsRemoved?.map((t) => t.name) : [],
    ['bash'],
  );
  assert.deepEqual(declaredNames(store.getState()), ['read']);
});

test('声明增量：定义改了 = 先删后加（同一个名字也算变）', () => {
  const { store } = freshStore();
  store.dispatch({ type: 'tools.changed', tools: [tool('read', '改过的说明'), tool('bash')] } as never);
  store.dispatch({ type: 'agent.run' } as never);

  const message = store.getState().messages.at(-1);
  assert.equal(message?.role, 'system');
  assert.deepEqual(message?.role === 'system' ? message.toolsRemoved?.map((t) => t.name) : [], ['read']);
  assert.deepEqual(message?.role === 'system' ? message.toolsAdded?.map((t) => t.name) : [], ['read']);
});

test('老轨迹回放（没有 headTools）：首次变更时把变更前那份记成 head', () => {
  // 老会话的 `state.prompt` 里没有 headTools（那时这个字段还不存在）。要是首次变更时
  // 直接拿新工具集当 head，前缀立刻作废 —— 所以必须把「变更前」那一份补记成 head。
  // 现在没有「回放出没有 headTools 的 state」的真实路径（`prompt.init` 总是会设它），
  // 但这条防御得留着：将来加一条回放路径时，漏掉它的症状只有账单看得见。
  const { store } = freshStore();
  // 解构掉这个键（`exactOptionalPropertyTypes` 下不能显式写 `undefined`）。
  const { headTools: _dropped, ...promptWithoutHead } = store.getState().prompt;
  const state: AgentState = { ...store.getState(), prompt: promptWithoutHead };
  const next = _transitions['tools.changed'](state, {
    type: 'tools.changed',
    tools: [tool('read'), tool('bash'), tool('web_search')],
  });
  assert.deepEqual(next.prompt.headTools?.map((t) => t.name), ['read', 'bash'], 'head 记的是变更**前**那一批');
  assert.deepEqual(next.prompt.tools.map((t) => t.name), ['read', 'bash', 'web_search']);
});

test('/new 换会话：工具集保留，新对话里重新声明一次', () => {
  // `/new` 只清对话、不改 `state.prompt`（工具集留下）。于是新会话的 transcript 里
  // **没有**任何声明消息 —— 下一轮请求必须把当前集重新声明一遍，否则模型以为只有
  // head 那批（`conversation.reset` 保留 prompt 的理由见 reducer.ts）。
  const { store } = freshStore();
  store.dispatch({ type: 'tools.changed', tools: [tool('read'), tool('bash'), tool('web_search')] } as never);
  store.dispatch({ type: 'agent.run' } as never);
  assert.equal(store.getState().messages.filter((m) => m.role === 'system').length, 1);

  store.dispatch({ type: 'conversation.reset', sessionId: 'next-session' } as never);
  assert.deepEqual(
    store.getState().prompt.tools.map((t) => t.name),
    ['read', 'bash', 'web_search'],
    '工具集跨会话保留（与 skill 清单同一个口径）',
  );
  assert.equal(store.getState().messages.length, 0, '对话清空了');

  store.dispatch({ type: 'agent.run' } as never);
  assert.deepEqual(declaredNames(store.getState()), ['read', 'bash', 'web_search'], '模型仍看得见那批');
  assert.equal(
    store.getState().messages.filter((m) => m.role === 'system').length,
    1,
    '重新声明一次（不是零次，也不是每轮堆）',
  );
});
