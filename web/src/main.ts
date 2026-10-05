/**
 * Web UI 入口：pi-web-ui 的聊天组件 + 本仓库的 Redux Loop 状态树。
 *
 * 这里没有 `Agent`（pi-agent-core）。环由 `src/` 的 reducer + pi-ai effect 表驱动，
 * 和 CLI 走的是**同一条环**；pi-web-ui 只是一个把状态树画出来的渲染层。
 *
 * 用法：
 *   npm run web            # 默认 deepseek（浏览器里弹窗填 DEEPSEEK_API_KEY）
 *   npm run web            # 打开 http://localhost:5273/?demo=1 走 faux provider，无需 key
 */
import { html, render } from 'lit';
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
  convertAttachments,
  setAppStorage,
} from '@earendil-works/pi-web-ui';
import { createPiAiEffectTable } from '../../src/effects';
import { createAgentStore, type AgentStore } from '../../src/store';
import type { AgentTool } from '../../src/agent-tool';
import { createSessionAdapter, type SessionAdapter } from './session-adapter';
import './trace-panel';
import './app.css';

const SYSTEM_PROMPT = [
  '你是一个跑在浏览器里的助手，背后是一个用 Redux Loop 组织的 Agent Loop。',
  '需要算术或时间时用工具去查，不要凭空猜。',
  '回答保持简短、直给；用用户的语言回答。',
].join('\n');

const params = new URLSearchParams(window.location.search);
const DEMO = params.get('demo') === '1';
const providerId = params.get('provider') ?? 'deepseek';
const modelId = params.get('model') ?? getModels(providerId as never)[0]?.id ?? '';

// ─── 存储（pi-web-ui 的 IndexedDB；API key 也存在这里，不进代码） ───
//
// AgentInterface 只用到 settings（proxy.*）和 providerKeys；AppStorage 的构造函数
// 强制要四个 store + backend，所以 sessions / customProviders 也得给 —— 纯占位。

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
    fauxAssistantMessage(
      [fauxText('我来算一下。'), fauxToolCall('calc', { expression: '(3+4)*6' })],
      { stopReason: 'toolUse' },
    ),
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

// ─── Redux Loop 状态树（与 CLI 共用同一个 reducer / 状态树 / effect 表） ───

//
// 工具来自 @earendil-works/pi-coding-agent，它们全都直接摸真实文件系统 / 起子进程，
// 浏览器里一个都用不了。所以 Web 侧不注册任何工具 —— 环照样跑，只是模型没有手。
// （要能在浏览器里用，得另配一套基于 fetch 的实现，那是另一件事。）
const browserTools: readonly AgentTool[] = [];

const store: AgentStore = createAgentStore({
  runtime: {
    models: undefined as never,
    spec: { provider: model.provider, model: model.id },
    model,
  },
  systemPrompt: SYSTEM_PROMPT,
  // 和 CLI 一模一样的这张表：agent.run → Cmd.run(streamFn)，工具也由自己的 Cmd 跑。
  // 这里没有「置空四行」那种特殊接线 —— 因为环本来就该由 Redux 驱动。
  effects: createPiAiEffectTable({
    streamFn,
    model,
    // 浏览器里没有 process.env，key 从 IndexedDB 的 providerKeys 取（所以是 async）。
    resolveKey: async (provider) => (await providerKeys.get(provider)) ?? undefined,
  }),
});

const adapter: SessionAdapter = createSessionAdapter({
  store,
  model,
  tools: browserTools,
  convertAttachments: convertAttachments as never,
});

// ─── 界面 ───

const chat = document.createElement('agent-interface') as AgentInterface;
chat.classList.add('flex-1', 'min-h-0');
chat.session = adapter as never;
chat.enableAttachments = true;
chat.enableModelSelector = true;
chat.enableThinkingSelector = true;
chat.showThemeToggle = true;
chat.onApiKeyRequired = (provider: string) => ApiKeyPromptDialog.prompt(provider);
chat.onModelSelect = () => {
  void ModelSelector.open(adapter.currentModel, (selected: Model<any>) => {
    adapter.setModel(selected);
    updateHeader();
  });
};

const headerStats = () => {
  const state = store.getState();
  const cost = state.totalCost > 0 ? ` · $${state.totalCost.toFixed(4)}` : '';
  return `${adapter.currentModel.id} · ${state.turns} 轮 · ${state.messages.length} 条消息${cost}`;
};

function updateHeader(): void {
  const label = document.getElementById('stats');
  if (label) label.textContent = headerStats();
}

function newChat(): void {
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
      <!-- 轨迹面板：和 TUI 共用 src/trace.ts 的 renderTree，错误/超时是树上的节点。 -->
      <trace-panel .store=${store}></trace-panel>
    </div>
  `,
  document.getElementById('app')!,
);

store.subscribe(() => updateHeader());
updateHeader();

// 调试用：把 store 挂到 window（控制台里可以直接看状态树 / dispatch action）。
declare global {
  interface Window {
    reduxLoopAgent?: { store: AgentStore; adapter: SessionAdapter; providers: string[] };
  }
}
window.reduxLoopAgent = { store, adapter, providers: getProviders() };
