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
 * 界面外壳（顶栏 / 提示行）刻意很小：真正的聊天界面是 pi-web-ui 的组件。顶栏右侧那三个
 * 入口（完整历史 / 系统 / 工具）在 `context-panels.ts`。
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
import { RemoteAgent, type UiQuestionnaire, type UiRequest } from './remote-agent';
import { openModelPicker } from './model-picker';
import { openConfirmDialog, openInputDialog, openSelectDialog } from './dialogs';
import { openQuestionnaireModal, type QuestionnaireModalHandle } from './questionnaire';
import { installToolMessageView, setToolTimings } from './tool-view';
import { installCommandPalette } from './command-palette';
import { installContextPanels } from './context-panels';
import { installStatsView } from './stats';
import { installSidebar, type Sidebar } from './sidebar';
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
              : 'ela-muted';
      const detail =
        notice.detail !== undefined && notice.detail !== notice.title ? notice.detail : '';
      return html`
        <div class="px-1 text-sm leading-relaxed">
          <span class="font-medium ${cls}">${notice.title ?? ''}</span>
          ${detail === '' ? '' : html`<span class="ml-2 text-xs ela-muted">${detail}</span>`}
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

/**
 * 外壳：**左侧边栏 + 右侧主区**。主区里依次是顶栏、面板、提示行、聊天区。
 *
 * 侧边栏（`sidebar.ts`）装的是历史会话与底部那三个入口；顶栏左侧那个按钮收放它，
 * 状态存在浏览器里（与 `sidebar.ts` 同一个 key）。会话 id **不显示**：它是内部身份，
 * 而人认的是标题（侧边栏那一列）。工作目录那一行（`~/proj (main)`）在 **composer 下面
 * 那一行的左端**，右端是统计 —— 与终端底栏同形状，见 `stats.ts`。
 */
function buildShell(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('#app 不存在');
  app.innerHTML = `
    <div class="ela-layout">
      <aside id="ela-sidebar" class="ela-sidebar"></aside>
      <div class="ela-main">
        <header class="ela-main-header">
          <button id="ela-sidebar-toggle" type="button" class="ela-top-btn ela-top-icon" title="收起 / 展开侧边栏" aria-label="收起 / 展开侧边栏" aria-expanded="true">☰</button>
          <div id="ela-context-actions" class="ela-context-actions"></div>
          <span id="ela-status" class="ela-status">连接中…</span>
        </header>
        <div id="ela-context-panels" class="ela-panel-host"></div>
        <div id="ela-notices" class="px-4 text-xs shrink-0"></div>
        <div id="ela-chat" class="flex-1 min-h-0 overflow-hidden"></div>
      </div>
    </div>
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
        : 'ela-muted truncate';
  line.title = text;
  line.textContent = text;
  noticeEl().append(line);
  while (noticeEl().childElementCount > 4) noticeEl().firstElementChild?.remove();
}

function setStatus(text: string): void {
  const el = document.getElementById('ela-status');
  if (el) el.textContent = text;
}

/** 取一个**已经建好**的容器（`buildShell()` 刚铺过）。null 就是铺错了，直接抛。 */
function requireElement(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} 不存在`);
  return el;
}

function wsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

async function main(): Promise<void> {
  installStorage();
  registerStreamNotice();
  // 工具卡换成折叠行视图（见 tool-view.ts）、底栏统计行（见 stats.ts）——
  // 必须在界面首次渲染前装好。
  installToolMessageView();
  installStatsView();
  buildShell();
  installContextPanels({
    actionsHost: requireElement('ela-context-actions'),
    panelHost: requireElement('ela-context-panels'),
    notice: (text, tone = 'info') => pushNotice(text, tone),
    // 完整历史那个链接要钉住「点的时候是哪个会话」（新标签页加载前可能已经换了）。
    sessionId: () => agent.state.sessionId,
  });

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
  /** 现在开着的扩展对话框（id → 只拆 DOM 的 close）。 */
  const openDialogs = new Map<string, () => void>();
  /** 开着的问卷（id → 那份弹窗的句柄）。同一份问卷会收到很多帧，所以得留着。 */
  const openQuestionnaires = new Map<string, QuestionnaireModalHandle>();
  /** 斜杠命令与底栏三个入口共用的上下文（`commands.ts`）。 */
  const commandContext = {
    notice: (text: string, tone: 'info' | 'warn' | 'error' = 'info') => pushNotice(text, tone),
    openModelPicker: () => void openModelPickerFromApi(),
  };
  /**
   * 侧边栏。先声明、后赋值：agent 的回调里要用它，而侧边栏的钩子又要用 agent
   * （两向引用 —— 先建哪一个都会撞上「used before its declaration」）。
   */
  let sidebar: Sidebar | undefined;
  /** 上一帧在不在跑：用来认出「跑完了一轮」（那时刷新一次列表最值）。 */
  let wasStreaming = false;

  const agent = new RemoteAgent({
    // pi-web-ui 只在**事件**上重画；服务端推来的整份状态不会触发它 —— 这里补一次。
    onStateApplied: () => {
      // 工具耗时表先喂再重画：工具卡渲染时按 toolCallId 查它（见 `tool-view.ts`），
      // 顺序反了这一帧就会用上一帧的耗时。
      setToolTimings(agent.state.toolTimings);
      chatPanel.agentInterface?.requestUpdate();
      sidebar?.sync({
        sessionId: agent.state.sessionId,
        cwd: agent.state.cwd,
        busy: agent.state.isStreaming,
      });
      // 一轮跑完 → 列表里那一行的标题/时间变了（第一条就是新会话的标题）。
      if (wasStreaming && !agent.state.isStreaming) sidebar?.refresh();
      wasStreaming = agent.state.isStreaming;
    },
    onNotices: (notices) => {
      for (const notice of notices) pushNotice(notice);
    },
    onNotice: (level, text) => pushNotice(text, level === 'info' ? 'info' : level === 'warn' ? 'warn' : 'error'),
    onStatus: (status) => {
      setStatus(status === 'open' ? '已连接' : status === 'connecting' ? '连接中…' : '断开，重连中…');
      // 重连 / 新开一个标签页：列表可能已经变了（终端那边开了会话）。
      if (status === 'open') sidebar?.refresh();
    },
    // 扩展的对话框（`ctx.ui.select/confirm/input`）—— 与终端**各出一份**，谁先回答
    // 谁算数（服务端 core 的 `raceDialog`）。终端那边先答了会发 `ui-cancel`，这里关掉。
    onUiRequest: (request: UiRequest) => {
      const answer = (response: { value?: string; cancelled?: boolean }): void => {
        openDialogs.delete(request.id);
        agent.respondUi(request.id, response);
      };
      // 同一个 id 重来（重连重放）→ 先撤掉旧的。
      openDialogs.get(request.id)?.();
      openDialogs.delete(request.id);
      if (request.method === 'select') {
        openDialogs.set(
          request.id,
          openSelectDialog({
            title: request.title,
            choices: request.options ?? [],
            onAnswer: (value) => answer(value === undefined ? { cancelled: true } : { value }),
          }),
        );
        return;
      }
      if (request.method === 'confirm') {
        openDialogs.set(
          request.id,
          openConfirmDialog({
            title: request.title,
            message: request.message ?? '',
            onAnswer: (value) => answer({ value: value ? 'yes' : 'no' }),
          }),
        );
        return;
      }
      openDialogs.set(
        request.id,
        openInputDialog({
          title: request.title,
          placeholder: request.placeholder,
          onAnswer: (value) => answer(value === undefined ? { cancelled: true } : { value }),
        }),
      );
    },
    onUiCancel: (id: string) => {
      openDialogs.get(id)?.();
      openDialogs.delete(id);
    },
    // 问卷（多题 tab）：同一份表会推很多帧（切题、勾选、提交），所以是"先找现存那份再 push"。
    // 服务端才是状态所有者 —— 这里只把点击变成一个意图发回去。
    onUiQuestionnaire: (update: UiQuestionnaire) => {
      const existing = openQuestionnaires.get(update.id);
      if (existing !== undefined) {
        existing.push(update.snapshot);
        return;
      }
      // 上一个 id 的没收到 close 就来了新的（服务端同时只持一份问卷）：先把旧的收掉，
      // 不然两块表单叠在一起，用户分不清在答哪一份。
      for (const [id, handle] of [...openQuestionnaires]) {
        handle.close();
        openQuestionnaires.delete(id);
      }
      openQuestionnaires.set(
        update.id,
        openQuestionnaireModal({
          snapshot: update.snapshot,
          onIntent: (intent) => agent.respondQuestionnaire(update.id, intent),
        }),
      );
    },
    onUiQuestionnaireClose: (id: string) => {
      openQuestionnaires.get(id)?.close();
      openQuestionnaires.delete(id);
    },
    // 斜杠命令：走 HTTP 接口，不发给模型（与 TUI 的 `runCommand` 同一个分工）。
    onPrompt: async (text) => {
      const parsed = parseCommand(text);
      if (parsed === null) return false;
      // `/skill:<名字>` 与 prompt 模板（`source: 'prompt'`）例外：它们不是命令，
      // 而是「把正文展开后发给模型」。展开要在服务端做（文件在磁盘上），所以
      // `runCommand()` 会返回 false —— 让它当普通消息发出去，bridge 收到后展开
      // （见 `web/bridge.ts`）。
      if (parsed.name.startsWith('skill:')) return false;
      return runCommand(parsed.name, parsed.arg, commandContext);
    },
  });

  // 输入 `/` 时的命令补全（命令表同样来自 HTTP 接口）。
  installCommandPalette(() => elaApi.commands());

  // 侧边栏（钩子要用 agent，所以到这里才建）。
  sidebar = installSidebar(requireElement('ela-sidebar'), {
    onResume: (id, cwd) => agent.resumeSession(id, cwd),
    onNew: () => agent.startNewSession(),
    ...commandContext,
    // 底栏的「技能」「设置」跑的是与 `/skills` `/settings` 同一个命令（同一个弹窗）。
    openSkills: () => void runCommand('skills', '', commandContext),
    openSettings: () => void runCommand('settings', '', commandContext),
  });
  const sidebarToggle = requireElement('ela-sidebar-toggle');
  const syncToggle = (): void =>
    sidebarToggle.setAttribute('aria-expanded', sidebar?.isOpen() === true ? 'true' : 'false');
  syncToggle();
  sidebarToggle.addEventListener('click', () => {
    sidebar?.toggle();
    syncToggle();
  });

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

  agent.connect(wsUrl());
}

void main();