/**
 * webui 的入口：把 pi-web-ui 的 `ChatPanel` 挂到一个**远程** agent 上。
 *
 * 这里只有三件事：
 *
 *   1. 给 pi-web-ui 铺好它需要的 `AppStorage`（IndexedDB 后端）—— 它内部的
 *      「这个 provider 有没有 key」检查会去读它，不铺就会抛（虽然密钥其实在服务端）；
 *   2. 造一个 `RemoteAgent`（见 remote-agent.ts）当 `session`；
 *   3. 连上 tui 的 `/ws`，把状态与事件交给 `ChatPanel` 渲染。
 *
 * 界面外壳（顶栏 / 提示行）刻意很小：真正的聊天界面是 pi-web-ui 的组件。
 */

import {
  AppStorage,
  ChatPanel,
  CustomProvidersStore,
  IndexedDBStorageBackend,
  ProviderKeysStore,
  SessionsStore,
  SettingsStore,
  registerMessageRenderer,
  setAppStorage,
} from '@earendil-works/pi-web-ui';
import { html } from 'lit';
import { STREAM_NOTICE_ROLE } from '@ela/core/web-protocol';
import { RemoteAgent } from './remote-agent';
import { openModelPicker } from './model-picker';
import { installToolMessageView } from './tool-view';
import { installCommandPalette } from './command-palette';
import { elaApi } from './api';
import { parseCommand, runCommand } from './commands';
import './app.css';

/**
 * 注册「提示」条目的 renderer —— 错误 / 配置切换 / 压缩。
 *
 * 这些条目由服务端**从轨迹派生**（见 `@ela/core/stream`），作为合成消息插在
 * `state.messages` 的正确位置上。pi-web-ui 的 `MessageList` 对每个消息先试
 * `renderMessage(role)`，命中就渲染它 —— 这就是「提示也在聊天流里」的实现。
 * 不注册的话那个 role 会被当成未知消息直接跳过。
 */
function registerStreamNotice(): void {
  registerMessageRenderer(STREAM_NOTICE_ROLE as never, {
    render: (message: unknown) => {
      const notice = message as { tone?: string; title?: string; detail?: string };
      const tone = notice.tone ?? 'info';
      const cls =
        tone === 'error'
          ? 'text-destructive'
          : tone === 'warn'
            ? 'text-yellow-600 dark:text-yellow-400'
            : tone === 'config'
              ? 'text-sky-600 dark:text-sky-400'
              : 'text-muted-foreground';
      const detail =
        notice.detail !== undefined && notice.detail !== notice.title ? notice.detail : '';
      return html`
        <div class="px-1 text-sm leading-relaxed">
          <span class="font-medium ${cls}">${notice.title ?? ''}</span>
          ${detail === '' ? '' : html`<span class="ml-2 text-xs text-muted-foreground">${detail}</span>`}
        </div>
      `;
    },
  } as never);
}

/** pi-web-ui 的若干组件会读全局 storage；铺一份最小可用的（sessions 我们不真的用）。 */
function installStorage(): void {
  const settings = new SettingsStore();
  const providerKeys = new ProviderKeysStore();
  const sessions = new SessionsStore();
  const customProviders = new CustomProvidersStore();
  const backend = new IndexedDBStorageBackend({
    dbName: 'ela-webui',
    version: 1,
    stores: [
      settings.getConfig(),
      providerKeys.getConfig(),
      customProviders.getConfig(),
      sessions.getConfig(),
      SessionsStore.getMetadataConfig(),
    ],
  });
  settings.setBackend(backend);
  providerKeys.setBackend(backend);
  customProviders.setBackend(backend);
  sessions.setBackend(backend);
  setAppStorage(new AppStorage(settings, providerKeys, sessions, customProviders, backend));
}

/** 顶栏 + 提示行 + 聊天区。聊天区里放 pi-web-ui 的 ChatPanel。 */
function buildShell(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('#app 不存在');
  app.innerHTML = `
    <header class="flex items-center gap-3 px-4 py-2 border-b border-border shrink-0">
      <span class="text-sm font-semibold">ela</span>
      <span id="ela-session" class="text-xs text-muted-foreground"></span>
      <span id="ela-status" class="text-xs text-muted-foreground ml-auto">连接中…</span>
      <button id="ela-new" type="button"
        class="text-xs px-2 py-1 rounded border border-border hover:bg-secondary transition-colors">
        新会话
      </button>
    </header>
    <div id="ela-notices" class="px-4 text-xs shrink-0"></div>
    <div id="ela-chat" class="flex-1 min-h-0 overflow-hidden"></div>
  `;
}

/** 提示行：开场诊断 + 运行中的即时提示。淡黄，最多留最近几条。 */
function noticeEl(): HTMLElement {
  const el = document.getElementById('ela-notices');
  if (!el) throw new Error('#ela-notices 不存在');
  return el;
}

function pushNotice(text: string, tone: 'info' | 'warn' | 'error' = 'info'): void {
  const line = document.createElement('div');
  line.className =
    tone === 'error'
      ? 'text-destructive truncate'
      : tone === 'warn'
        ? 'text-yellow-600 dark:text-yellow-400 truncate'
        : 'text-muted-foreground truncate';
  line.title = text;
  line.textContent = text;
  noticeEl().append(line);
  while (noticeEl().childElementCount > 4) noticeEl().firstElementChild?.remove();
}

function setStatus(text: string): void {
  const el = document.getElementById('ela-status');
  if (el) el.textContent = text;
}

function setSession(id: string, cwd: string): void {
  const el = document.getElementById('ela-session');
  if (el) el.textContent = id === '' ? '' : `${id} · ${cwd}`;
}

function wsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

async function main(): Promise<void> {
  installStorage();
  registerStreamNotice();
  // 工具卡换成折叠行视图（见 tool-view.ts）—— 必须在界面首次渲染前装好。
  installToolMessageView();
  buildShell();

  /**
   * 打开模型选择器：目录 / 作用域从 HTTP 接口现取。
   *
   * 不再随 `hello` 来 —— 那些是「非会话数据」，改成接口后由前端按需取（也更新鲜：
   * TUI 里刚改过作用域，这里再开就是新的）。
   */
  async function openModelPickerFromApi(): Promise<void> {
    try {
      const info = await elaApi.models();
      openModelPicker({
        models: info.models,
        current: info.current,
        scopedModelIds: info.scoped,
        onSelect: (model) => {
          // 走接口换（服务端才是真相）——它会推一份新状态回来。
          void elaApi.setModel(`${model.provider}/${model.id}`).then((result) => {
            if (!result.ok) pushNotice(result.message ?? '换模型失败', 'warn');
          });
        },
      });
    } catch (error) {
      pushNotice(`拿不到模型目录：${error instanceof Error ? error.message : String(error)}`, 'warn');
    }
  }

  const chatPanel = new ChatPanel();
  const agent = new RemoteAgent({
    // pi-web-ui 只在**事件**上重画；服务端推来的整份状态不会触发它 —— 这里补一次。
    onStateApplied: () => {
      chatPanel.agentInterface?.requestUpdate();
      setSession(agent.state.sessionId, agent.state.cwd);
    },
    onNotices: (notices) => {
      for (const notice of notices) pushNotice(notice);
    },
    onNotice: (level, text) => pushNotice(text, level === 'info' ? 'info' : level === 'warn' ? 'warn' : 'error'),
    onStatus: (status) => {
      setStatus(status === 'open' ? '已连接' : status === 'connecting' ? '连接中…' : '断开，重连中…');
    },
    // 斜杠命令：走 HTTP 接口，不发给模型（与 TUI 的 `runCommand` 同一个分工）。
    onPrompt: async (text) => {
      const parsed = parseCommand(text);
      if (parsed === null) return false;
      // `/skill:<名字>` 例外：它不是命令，而是「把 SKILL.md 展开成 `<skill>` 块发给模型」。
      // 展开要在服务端做（文件在磁盘上），所以**不拦**——让它当普通消息发出去，
      // bridge 收到后展开（见 `web/bridge.ts`）。
      if (parsed.name.startsWith('skill:')) return false;
      await runCommand(parsed.name, parsed.arg, {
        notice: (notice, tone = 'info') => pushNotice(notice, tone),
        openModelPicker: () => void openModelPickerFromApi(),
      });
      return true;
    },
  });

  // 输入 `/` 时的命令补全（命令表同样来自 HTTP 接口）。
  installCommandPalette(() => elaApi.commands());

  await chatPanel.setAgent(agent as never, {
    // 密钥在服务端。这里返回 true 只是让 pi-web-ui 的「没 key 就不发」那道闸放行。
    onApiKeyRequired: async () => true,
    // 换模型：**接管**掉 pi-web-ui 自带的 selector（它列的是它打包那一代 pi-ai 的内置
    // 目录），改成服务端接口给的那份 —— 与 TUI 的 `/model` 面板同一份。
    onModelSelect: () => void openModelPickerFromApi(),
  });

  const chat = document.getElementById('ela-chat');
  if (!chat) throw new Error('#ela-chat 不存在');
  chat.appendChild(chatPanel);

  document.getElementById('ela-new')?.addEventListener('click', () => agent.startNewSession());

  agent.connect(wsUrl());
}

void main();