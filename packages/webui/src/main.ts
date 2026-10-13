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
  setAppStorage,
} from '@earendil-works/pi-web-ui';
import { RemoteAgent } from './remote-agent';
import './app.css';

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
  buildShell();

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
  });

  await chatPanel.setAgent(agent as never, {
    // 密钥在服务端。这里返回 true 只是让 pi-web-ui 的「没 key 就不发」那道闸放行。
    onApiKeyRequired: async () => true,
  });

  const chat = document.getElementById('ela-chat');
  if (!chat) throw new Error('#ela-chat 不存在');
  chat.appendChild(chatPanel);

  document.getElementById('ela-new')?.addEventListener('click', () => agent.startNewSession());

  agent.connect(wsUrl());
}

void main();