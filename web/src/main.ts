/**
 * Web UI 入口 —— 纯渲染层，**不在浏览器里跑环**。
 *
 * 内核（Redux Loop + LLM 调用 + 工具执行）只有一个，跑在 Node 里（`src/server.ts`）。
 * 浏览器这边只做三件事：
 *
 *   1. 用 SSE（`/api/events`）订阅内核的状态树
 *   2. 把用户输入 POST 回内核（`/api/message`）
 *   3. 把状态画出来（pi-web-ui 的聊天组件 + 本仓库的轨迹面板）
 *
 * 为什么必须这样：环有副作用 —— 真的调模型、真的读写文件、真的起子进程。
 * 如果浏览器里也跑一份，就会出现两边都发起 LLM 调用、消息流不一致、文件被写两次。
 *
 * 好处是工具真的能用了：`read` / `write` / `edit` / `bash` 跑在 Node 侧，
 * 摸的是**真实文件系统**（工作目录由服务端 cwd 决定，并有路径边界检查）。
 *
 * 用法：
 *   npm run serve            # 起 Node 内核 + 静态页面 → http://localhost:5273
 *   npm run serve -- --demo  # 用 faux provider，不打网络、不需要 key
 */
import { html, render } from 'lit';
// 关键：pi-web-ui 的自定义元素是靠**模块副作用**注册的（AgentInterface.js 末尾的
// `customElements.define("agent-interface", ...)`）。如果只把它当类型用、或者让 bundler
// 认定「只用了类型」，那行 define 会被 tree-shake 掉，页面就只剩一个没升级的空标签。
// 这里显式 new 一次并摸一个属性，逼 bundler 保留这个模块。
import {
  AgentInterface,
  ApiKeyPromptDialog,
  AppStorage,
  CustomProvidersStore,
  IndexedDBStorageBackend,
  ProviderKeysStore,
  SessionsStore,
  SettingsStore,
  setAppStorage,
} from '@earendil-works/pi-web-ui';
import { ensureElementsRegistered } from './ensure-elements';
import { createRemoteSession } from './remote-session';
import { registerUserMessageRenderer } from './user-message';
import { attachComposerMenu } from './composer-menu';
import { runCommand, type CommandContext } from './commands';
import { cleanAllSessions, listSessions, restoreSession } from './session-client';
import './trace-panel';
import './app.css';

const params = new URLSearchParams(window.location.search);
const DEMO = params.get('demo') === '1';
// pi-web-ui 要求的全局存储：会话历史、设置、provider key 都走 IndexedDB。
// 不 setAppStorage() 的话，AgentInterface.sendMessage() 第一件事就是 getAppStorage() → 抛。
const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();
const backend = new IndexedDBStorageBackend({
  dbName: 'redux-loop-agent',
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
// 与内核的连接。环在服务端，这里只是一个镜像。
const remote = createRemoteSession({
  // 斜杠命令：**在这里拦下**，不发 `/api/message`。
  // 返回 true 表示「已处理」，prompt() 就不再 POST。
  onCommand: async (text) => {
    const result = await runCommand(text, commandContext);
    if (result.message) notify(result.message);
    return result.handled;
  },
  // 发消息被内核挡下（409 上一回合没完 / 400 附件不合法 / 超限）时，
  // pi-web-ui 不会把 promise 往外抛，只能走这里才能让用户看见原因。
  onError: notify,
});
const session = remote;

/**
 * 命令的上下文：命令要动界面/内核时走这里，而不是自己去摸 DOM 或 fetch。
 *
 * `openSessionPicker` 在 main.ts 下面定义（它要碰 DOM），所以这里用函数声明式的
 * 延迟引用 —— 命令执行发生在用户交互时，那时整份模块早已求值完。
 */
const commandContext: CommandContext = {
  newSession: async () => {
    const res = await fetch('/api/reset', { method: 'POST' });
    const body = (await res.json()) as { id?: string };
    updateHeader();
    return { id: body.id ?? '?' };
  },
  restoreSession: async (target) => {
    await restoreRemoteSession(target.id);
    updateHeader();
  },
  openSessionPicker: () => openSessions(),
  cleanSessions: () => confirmAndCleanSessions(),
  notify,
};

/**
 * 清理历史会话 —— **不可逆**，所以先弹确认框。
 *
 * 为什么用 confirm 而不是直接删：这个按钮清的是磁盘上真实的历史文件，
 * 误触一次的代价是用户没法找回的一段对话。一个 confirm 的成本可以忽略。
 *
 * 报数要说清楚「删了多少条」，以及有没有删不掉的（Windows 上文件偶尔被索引器占着）。
 * 只回一句「清理完成」的话，用户没法判断是不是真删了。
 */
async function confirmAndCleanSessions(): Promise<string> {
  let data: Awaited<ReturnType<typeof listSessions>>;
  try {
    data = await listSessions();
  } catch (error) {
    return `取会话列表失败：${error instanceof Error ? error.message : String(error)}`;
  }
  const others = data.sessions.filter((s) => s.id !== data.current).length;
  if (others === 0) return '没有可清理的历史会话（只有当前这一段）';
  if (
    !window.confirm(
      `将删除 ${others} 条历史会话（当前这一段保留）。不可撤销，确定吗？`,
    )
  ) {
    return '已取消';
  }
  try {
    const result = await cleanAllSessions();
    updateHeader();
    const failed = result.failed.length > 0 ? `，${result.failed.length} 条没删掉` : '';
    return `已清理 ${result.sessions} 条历史会话（${result.removed} 个文件）${failed}`;
  } catch (error) {
    return `清理失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

// 先确保元素注册，再 createElement —— 顺序反了拿到的是一个没升级的空标签。
ensureElementsRegistered();
//
// 补上「标准 pi-ai user 消息里的图片」渲染（见 user-message.ts 的说明）。
// **必须在这里调**：pi-web-ui 的 renderer 是**渲染那一刻**才问注册表的，已经画出来的
// 消息不会因为事后注册而重画。放在 createElement 之后，聊天区第一帧就是缺图的。
registerUserMessageRenderer(remote.images);
const chat = document.createElement('agent-interface') as AgentInterface;
chat.classList.add('flex-1', 'min-h-0');
chat.session = session as never;
chat.enableAttachments = true;
chat.enableModelSelector = false; // 模型在内核侧换，避免两处状态
chat.enableThinkingSelector = false;
chat.showThemeToggle = true;
//
// key 由 Node 内核从环境变量读，浏览器这边**永远不该**弹 key 对话框。
// 但 pi-web-ui 的 sendMessage() 会先查 providerKeys，查不到就调 onApiKeyRequired，
// 于是 demo 模式（压根不需要 key）也会被弹窗挡住，消息根本发不出去。
//
// 办法：把服务端告诉我们的 provider 都塞一个占位 key 进去。真正的鉴权在 Node 侧，
// 这个值只是用来骗过前端的「有没有 key」检查，不会离开浏览器。
chat.onApiKeyRequired = async (provider: string) => {
  await providerKeys.set(provider, 'managed-by-node-kernel');
  return true;
};

// 首帧到达后按服务端给的 provider 列表预置占位 key。
remote.onChange(() => {
  const snapshot = remote.snapshot;
  if (snapshot) void seedPlaceholderKeys(snapshot.providers);
});

/** 已经预置过的 provider，避免每帧都写 IndexedDB。 */
const seeded = new Set<string>();
async function seedPlaceholderKeys(providers: readonly string[]): Promise<void> {
  for (const provider of providers) {
    if (seeded.has(provider)) continue;
    seeded.add(provider);
    try {
      if ((await providerKeys.get(provider)) === undefined) {
        await providerKeys.set(provider, 'managed-by-node-kernel');
      }
    } catch {
      // IndexedDB 不可用（隐私模式等）：忽略，onApiKeyRequired 兜底。
    }
  }
}

const headerStats = (): string => {
  const s = remote.snapshot;
  if (!s) return '连接中…';
  const cost = s.totalCost > 0 ? ` · $${s.totalCost.toFixed(4)}` : '';
  const bits = [`${s.providerName}/${s.modelId}`, `${s.turns} 轮`, cost].filter(Boolean);
  const traceBits: string[] = [`节点 ${Object.keys((s.trace as { nodes?: object })?.nodes ?? {}).length}`];
  const stats = s.stats as { retries?: number; errors?: number } | null;
  if (stats?.retries) traceBits.push(`重试 ${stats.retries}`);
  if (stats?.errors) traceBits.push(`错误 ${stats.errors}`);
  return `${bits.join(' · ')}   轨迹 ${traceBits.join(' · ')}`;
};

const headerNote = (): string => {
  const s = remote.snapshot;
  if (!s) return '连接内核中…';
  return remote.isConnected()
    ? `内核 cwd: ${s.cwd}${DEMO ? '（demo，不打网络）' : ''}`
    : '与内核断开，正在重连…';
};

function updateHeader(): void {
  const stats = document.getElementById('stats');
  if (stats) stats.textContent = headerStats();
  const note = document.getElementById('kernel-note');
  if (note) note.textContent = headerNote();
}

function newChat(): void {
  void remote.reset().then(updateHeader);
}

/**
 * 顶栏「清理历史」按钮：走命令层那套清理（先确认、再报数），结果弹成横幅。
 *
 * 不直接调 cleanAllSessions() 是为了**只有一份确认与提示文案** —— 顶栏按钮与
 * `/cleanup` 命令要给出完全一样的行为与措辞。
 */
function cleanFromHeader(): void {
  void confirmAndCleanSessions().then(notify);
}

/**
 * 历史会话选择器。
 *
 * 用 `window.prompt` 之外的原生弹窗没有更好的选择（不引 UI 库），所以用
 * `<dialog>` + 列表：能滚动、能点、能 Esc 关，够用且零依赖。
 *
 * 「只列当前 cwd」的会话在前面（内核标了 `current`）—— 别的目录的历史恢复进来，
 * 工具的文件边界会和对话内容对不上。
 */
/**
 * 在界面下方弹一行提示（命令结果、错误）。
 *
 * 不用 alert：那是模态的，会把「刚发的命令」的上下文打断。几秒后自动消失的横幅够了。
 */
function notify(text: string): void {
  let bar = document.getElementById('notice-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'notice-bar';
    bar.className =
      'fixed left-1/2 -translate-x-1/2 bottom-24 z-40 max-w-[80vw] rounded-lg border border-border bg-background px-3 py-2 text-sm whitespace-pre-wrap shadow-lg';
    document.body.appendChild(bar);
  }
  bar.textContent = text;
  bar.style.display = 'block';
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    bar.style.display = 'none';
  }, 5000);
}
let noticeTimer = 0;

/** 恢复一个历史会话（零 token，不重跑模型）。 */
async function restoreRemoteSession(id: string): Promise<void> {
  try {
    const result = await restoreSession(id);
    notify(`已恢复 ${result.id}（${result.restored} 条消息，未重跑模型）`);
  } catch (error) {
    notify(`恢复失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function openSessions(): Promise<void> {
  const data = await listSessions();

  const dialog = document.createElement('dialog');
  dialog.className = 'rounded-lg border border-border p-0 w-[32rem] max-w-[90vw] bg-background text-foreground';
  const rows = data.sessions
    .map((s) => {
      const when = new Date(s.mtimeMs).toLocaleString();
      const badge = s.current ? '' : '<span class="text-amber-600">（其它目录）</span>';
      return `<li><button data-id="${s.id}" class="w-full text-left px-3 py-2 hover:bg-secondary transition-colors">
        <div class="text-sm truncate">${escapeHtml(s.title)} ${badge}</div>
        <div class="text-xs text-muted-foreground">${escapeHtml(s.id)} · ${s.entries} 条 · ${when}</div>
      </button></li>`;
    })
    .join('');
  dialog.innerHTML = `
    <div class="px-3 py-2 border-b border-border text-sm font-semibold">恢复历史会话</div>
    <ul class="max-h-[60vh] overflow-auto m-0 p-0 list-none">
      ${rows || '<li class="px-3 py-4 text-sm text-muted-foreground">还没有历史会话</li>'}
    </ul>
    <div class="px-3 py-2 border-t border-border text-right">
      <button data-close class="px-2 py-1 text-sm rounded border border-border hover:bg-secondary">关闭</button>
    </div>`;

  dialog.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-close]') || target === dialog) {
      dialog.close();
      return;
    }
    const id = target.closest('button[data-id]')?.getAttribute('data-id');
    if (!id) return;
    void restoreRemoteSession(id).then(() => dialog.close());
  });

  document.body.appendChild(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}

/** 列表里的标题来自会话内容，要转义（不能把用户输入当 HTML 插进去）。 */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

render(
  html`
    <div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
      <header class="flex items-center justify-between border-b border-border shrink-0 px-4 py-2">
        <div class="flex items-center gap-3">
          <span class="text-base font-semibold">Redux Loop Agent</span>
          <span id="kernel-note" class="text-xs text-muted-foreground">连接内核中…</span>
        </div>
        <div class="flex items-center gap-3">
          <span id="stats" class="text-xs text-muted-foreground">连接中…</span>
          <theme-toggle></theme-toggle>
          <button
            class="px-2 py-1 text-sm rounded border border-border hover:bg-secondary transition-colors"
            @click=${openSessions}
          >
            历史会话
          </button>
          <button
            class="px-2 py-1 text-sm rounded border border-border hover:bg-secondary transition-colors"
            @click=${newChat}
          >
            新对话
          </button>
          <button
            class="px-2 py-1 text-sm rounded border border-border text-muted-foreground hover:bg-secondary transition-colors"
            title="删除除当前会话外的全部历史会话（不可撤销）"
            @click=${cleanFromHeader}
          >
            清理历史
          </button>
        </div>
      </header>
      ${chat}
      <trace-panel .store=${traceStoreForPanel()}></trace-panel>
    </div>
  `,
  document.getElementById('app')!,
);

/**
 * 轨迹面板要一个「有 getState().trace 的 store」。
 *
 * 浏览器里没有真的 store，但面板只读 `trace` —— 给它一个只会返回最新快照的
 * 假 store 即可，面板的订阅靠 remote 自己驱动（见 trace-panel 的说明）。
 */
function traceStoreForPanel(): { getState(): { trace: unknown }; subscribe(l: () => void): () => void } {
  return {
    getState: () => ({ trace: remote.snapshot?.trace }),
    subscribe: (listener: () => void) => {
      const wrapped = (): void => {
        listener();
        updateHeader();
      };
      // 借 onChange：它每次收到 SSE 帧就会通知（不关心事件类型）。
      const off = remote.onChange(wrapped);
      updateHeader();
      return off;
    },
  };
}
// 用 onChange 而不是 subscribe：后者收的是 lifecycle 事件（pi-web-ui 的契约），
// 而顶栏只关心「状态变了」。
//
// 另外别顺手调 chat.requestUpdate()：AgentInterface 是 define() 升级的自定义元素，
// 升级完成前这个方法不存在，而订阅那一刻会**同步**回调一次 → TypeError。
// pi-web-ui 自己会处理重渲染，我们只管顶栏。
remote.onChange(() => {
  updateHeader();
});
updateHeader();

window.addEventListener('beforeunload', () => remote.dispose());

// 调试用。
declare global {
  interface Window {
    reduxLoopAgent?: { remote: typeof remote };
  }
}
window.reduxLoopAgent = { remote };

// `/` 补全层：挂在 pi-web-ui 渲染出来的那个 textarea 上（它自己不提供命令口子）。
// 选中命令后走同一条 runCommand —— 与「输入 /sessions 回车」是同一个效果。
attachComposerMenu({
  onPick(command) {
    void runCommand(`/${command.name}`, commandContext).then((result) => {
      if (result.message) notify(result.message);
    });
  },
});
