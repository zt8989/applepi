/**
 * Web UI 入口：pi-web-ui 的聊天界面 + 本仓库的 Redux Loop 状态树。
 *
 * 用法：
 *   npm run web            # 默认 deepseek（浏览器里弹窗填 DEEPSEEK_API_KEY）
 *   npm run web            # 打开 http://localhost:5273/?demo=1 走 faux provider，无需 key
 */
import { html, render } from 'lit';
import { Agent } from '@earendil-works/pi-agent-core';
import {
  getModel,
  getModels,
  getProviders,
  streamSimple as apiStreamSimple,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai/compat';
import {
  AgentInterface,
  ApiKeyPromptDialog,
  AppStorage,
  CustomProvidersStore,
  IndexedDBStorageBackend,
  ModelSelector,
  ProviderKeysStore,
  SessionsStore,
  SettingsStore,
  defaultConvertToLlm,
  setAppStorage,
} from '@earendil-works/pi-web-ui';
import { createAgentDrivenEffectTable } from '../../src/effects';
import { createAgentStore, type AgentStore } from '../../src/store';
import { getTools } from '../../src/tools';
import { createAgentBridge } from './bridge';
import './app.css';

const SYSTEM_PROMPT = [
  '你是一个跑在浏览器里的助手，背后是一个用 Redux Loop 组织的 Agent Loop。',
  '需要算术或时间时用工具去查，不要凭空猜。',
  '回答保持简短、直给；用用户的语言回答。',
].join('\n');

/**
 * 「环由 pi-agent-core 驱动」时的接线：四行全是空操作。
 * reducer 依然照常迁移状态，只是永远不发 Cmd。
 */
const AGENT_DRIVEN_WIRING = {
  'user.message': () => [],
  'agent.run': () => [],
  'llm.done': () => [],
  'tool.batch.done': () => [],
} as const;

const params = new URLSearchParams(window.location.search);
const DEMO = params.get('demo') === '1';
const providerId = params.get('provider') ?? 'deepseek';
const modelId = params.get('model') ?? getModels(providerId as never)[0]?.id ?? '';

// ─── 存储（pi-web-ui 的 IndexedDB；API key 也存在这里，不进代码） ───

const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();

const backend = new IndexedDBStorageBackend({
  dbName: DEMO ? 'redux-loop-agent-demo' : 'redux-loop-agent',
  version: 1,
  stores: [
    settings.getConfig(),
    providerKeys.getConfig(),
    sessions.getConfig(),
    SessionsStore.getMetadataConfig(),
    customProviders.getConfig(),
  ],
});

settings.setBackend(backend);
providerKeys.setBackend(backend);
sessions.setBackend(backend);
customProviders.setBackend(backend);
setAppStorage(new AppStorage(settings, providerKeys, sessions, customProviders, backend));

// ─── 模型与 streamFn ───

const faux = DEMO ? fauxProvider() : undefined;
if (faux) {
  faux.setResponses([
    fauxAssistantMessage([
      fauxText('我来算一下。'),
      fauxToolCall('calc', { expression: '(3+4)*6' }),
    ], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('(3+4)*6 = 42。')]),
  ]);
  await providerKeys.set('faux', 'demo');
}

const model: Model<any> = DEMO && faux ? faux.getModel() : getModel(providerId as never, modelId);

const streamFn = (
  requestModel: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
) => {
  // 演示模式：faux provider 自己发流，不打网络。
  if (faux && requestModel.provider === model.provider) {
    return faux.provider.streamSimple(requestModel, context, options);
  }
  return apiStreamSimple(requestModel, context, options);
};

// ─── Redux Loop 状态树（与 CLI 共用同一个 reducer） ───

// ─── Agent（pi-agent-core；Web 侧的环由它驱动） ───

const browserTools = getTools().filter((tool) => tool.name !== 'read_file'); // read_file 只有 Node 端有

const agent = new Agent({
  initialState: {
    systemPrompt: SYSTEM_PROMPT,
    model,
    thinkingLevel: 'off',
    messages: [],
    tools: browserTools as never,
  },
  convertToLlm: defaultConvertToLlm as never,
  getApiKey: async (provider: string) => (await providerKeys.get(provider)) ?? undefined,
  streamFn: streamFn as never,
});

// ─── Redux Loop 状态树（与 CLI 共用同一个 reducer / 状态树） ───
//
// Web 侧注入的是 agent-driven effect 表：`agent.run` 这一行的实现是「让 pi-agent-core
// 的 Agent 跑起来」，而不是自己调 pi-ai。reducer 完全不知道自己接的是哪张表 ——
// 这正是「一切皆 Action」的意思：状态机与执行者解耦。
const store: AgentStore = createAgentStore({
  runtime: {
    models: undefined as never,
    spec: { provider: model.provider, model: model.id },
    model,
  },
  systemPrompt: SYSTEM_PROMPT,
  effects: createAgentDrivenEffectTable({ agent }),
  // 接线四行全部置空：环由 pi-agent-core 的 Agent 驱动，reducer 只维护状态树。
  // 不能只置空 llm.done / tool.batch.done —— user.message 与 agent.run 的 effect
  // 会再次调用 Agent.prompt()，而那次调用正在跑 →「already processing a prompt」。
  reducerEffects: AGENT_DRIVEN_WIRING,
});


const bridge = createAgentBridge({ agent, store, onChange: () => updateHeader() });

// ─── 界面 ───

const chat = document.createElement('agent-interface') as AgentInterface;
chat.classList.add('flex-1', 'min-h-0');
chat.session = bridge.session;
chat.enableAttachments = true;
chat.enableModelSelector = true;
chat.enableThinkingSelector = true;
chat.showThemeToggle = true;
chat.onApiKeyRequired = (provider: string) => ApiKeyPromptDialog.prompt(provider);
chat.onModelSelect = () => {
  void ModelSelector.open(agent.state.model, (selected: Model<any>) => {
    agent.state.model = selected;
    store.dispatch({
      type: 'model.changed',
      provider: selected.provider,
      modelId: selected.id,
    });
    updateHeader();
  });
};

const headerStats = () => {
  const state = store.getState();
  const cost = state.totalCost > 0 ? ` · $${state.totalCost.toFixed(4)}` : '';
  return `${agent.state.model.id} · ${state.turns} 轮 · ${state.messages.length} 条消息${cost}`;
};

function updateHeader(): void {
  const label = document.getElementById('stats');
  if (label) label.textContent = headerStats();
}

function newChat(): void {
  agent.reset();
  store.dispatch({ type: 'conversation.reset' });
  updateHeader();
  chat.requestUpdate();
}

render(
  html`
    <div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
      <header class="flex items-center justify-between border-b border-border shrink-0 px-4 py-2">
        <div class="flex items-center gap-3">
          <span class="text-base font-semibold">Redux Loop Agent</span>
          <span class="text-xs text-muted-foreground">${DEMO ? 'demo（faux provider，不打网络）' : `provider: ${providerId}`}</span>
        </div>
        <div class="flex items-center gap-3">
          <span id="stats" class="text-xs text-muted-foreground">${headerStats()}</span>
          <theme-toggle></theme-toggle>
          <button
            class="px-2 py-1 text-sm rounded border border-border hover:bg-secondary transition-colors"
            @click=${newChat}
          >新对话</button>
        </div>
      </header>
      ${chat}
    </div>
  `,
  document.getElementById('app')!,
);

agent.subscribe(() => updateHeader());
updateHeader();

// 调试用：把 store 挂到 window（控制台里可以直接看状态树 / dispatch action）。
declare global {
  interface Window {
    reduxLoopAgent?: { store: AgentStore; agent: Agent; providers: string[] };
  }
}
window.reduxLoopAgent = { store, agent, providers: getProviders() };

