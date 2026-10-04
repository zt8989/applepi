import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '@earendil-works/pi-agent-core';
import {
  Type,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/compat';
import { createAgentDrivenEffectTable } from '../src/effects';
import { createAgentStore } from '../src/store';
import { createAgentBridge } from '../web/src/bridge';

/** Web 侧的接线：四行全是空操作，环完全交给 pi-agent-core。 */
const INERT_WIRING = {
  'user.message': () => [],
  'agent.run': () => [],
  'llm.done': () => [],
  'tool.batch.done': () => [],
} as const;

/**
 * Web 侧的环：pi-agent-core 的 Agent 驱动，bridge 把事件翻译成 Redux action。
 * 全程离线（pi-ai 的 faux provider），不碰浏览器 API。
 */
test('Web 桥：Agent 事件灌进 Redux 状态树，工具回合也在里面', async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      [fauxText('我来算。'), fauxToolCall('calc', { expression: '(3+4)*6' })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage([fauxText('(3+4)*6 = 42')]),
  ]);
  const model = faux.getModel();

  const calcTool = {
    name: 'calc',
    label: '计算器',
    description: '算算术',
    parameters: Type.Object({ expression: Type.String() }),
    execute: async () => ({
      content: [{ type: 'text' as const, text: '(3+4)*6 = 42' }],
      details: null,
    }),
  };

  const streamFn = models.streamSimple.bind(models);

  const agent = new Agent({
    initialState: {
      systemPrompt: 'test',
      model,
      thinkingLevel: 'off',
      messages: [],
      tools: [calcTool] as never,
    },
    convertToLlm: (messages: readonly unknown[]) =>
      messages.filter((m) =>
        ['user', 'assistant', 'toolResult'].includes((m as { role: string }).role),
      ) as never,
    streamFn: streamFn as never,
  });

  // 和 web/src/main.ts 一样：注入 agent-driven effect 表，但把接线的四行全部置空 ——
  // 环由 pi-agent-core 驱动，reducer 不发 Cmd（否则会双跑一轮 / 重入 prompt）。
  const store = createAgentStore({
    runtime: {
      models: undefined as never,
      spec: { provider: 'faux', model: model.id },
      model,
    },
    systemPrompt: 'test',
    effects: createAgentDrivenEffectTable({ agent }),
    reducerEffects: INERT_WIRING,
  });

  const bridge = createAgentBridge({ agent, store });
  await bridge.session.prompt('算一下 (3+4)*6');

  const state = store.getState();
  console.log('  → Redux 状态树里的消息链：', state.messages.map((m) => m.role).join(' → '));

  assert.equal(state.phase, 'idle');
  assert.equal(state.turns, 2);
  assert.deepEqual(
    state.messages.map((m) => m.role),
    ['user', 'assistant', 'toolResult', 'assistant'],
  );
  const first = state.messages[0];
  assert.ok(first && first.role === 'user');
  assert.equal(first.content, '算一下 (3+4)*6');
  const toolResult = state.messages[2];
  assert.ok(toolResult && toolResult.role === 'toolResult');
  assert.equal(toolResult.isError, false);

  bridge.dispose();
});
