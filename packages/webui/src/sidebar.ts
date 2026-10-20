/**
 * 左侧边栏：**每个 cwd 的历史会话**，点一条就恢复它。
 *
 * ## 为什么它在浏览器里（而不是又给服务端加一个面板）
 *
 * 会话列表是**只读的目录快照**：服务端给一份 [WebSessionRef](@ela/core/web-protocol)
 * （`GET /api/sessions`），浏览器按 `cwd` 归堆、画出来。恢复才是动作，而那一条走
 * WebSocket（`resumeSession`）—— 因为「换会话」必须由内核出手（换 id、换文件、对齐
 * 记录器游标），浏览器只负责说「用户点了哪一条」。
 *
 * 于是分组、折叠、搜索这些**纯界面**的事全在这里：服务端不必知道侧边栏长什么样，
 * 改一次样式也不用重启内核。
 *
 * ## 为什么按 cwd 分组，而不是一个大列表
 *
 * 一个会话属于它当初的 cwd，而用户的心智是「我在哪个项目里」—— 平铺一列会混在一起
 * （且 `~/Documents/workspace/x` 这种路径铺不开）。组头显示目录名，全路径在 `title` 里。
 *
 * ## 运行中不能切
 *
 * 环在跑时换会话会把**正在写**的那个文件丢掉（消息还在往它写），所以那一整段时间
 * 列表锁上：每条都 `aria-disabled`、`cursor: not-allowed`，点了给一句提示而不是静默
 * 无反应。与服务端那条拒绝（bridge 的 `resumeSession`）是同一条规矩的两道闸。
 *
 * ## 行上的悬停动作（照 Pi Web）
 *
 * 组头右端悬停出两个：`+`（在这个项目里新建）与垃圾桶（删掉这个项目的全部会话）；
 * 会话行右端悬停出两个：归档与删除（悬停时时间那一格让位给它们）。项目名加粗、右边
 * 不再挂条数 —— 那是节标题，不是一行数据。
 *
 * 归档**不由这里记**：它是服务端的一个时刻（`@ela/core/sidebar-state`），主列表拿到
 * 的就已经是「没归档的那些」，底部那个「已归档 · N」是同一份状态的另一栏。所以这里
 * 每次动作完就 `refresh()`，不在本地猜（两份状态迟早会漂）。
 *
 * 删除是真删文件（会话 + 轨迹），所以每个入口都先弹一次确认；当前会话与服务端正在跑
 * 的那一回合都会被服务端拒绝，这里再把话原样转出来。
 */

import { elaApi } from './api';
import { pathBase, relativeTime } from './format';
import { openModal } from './modal';
import type { WebSessionRef } from '@ela/core/web-protocol';

/** 侧边栏折叠状态的记忆（每个浏览器一份）。 */
const OPEN_STORAGE_KEY = 'ela-webui:sidebar-open';
/** 折起了哪几个 cwd 的组（存 cwd 本身）。 */
const COLLAPSED_GROUPS_KEY = 'ela-webui:sidebar-collapsed-groups';

export interface SidebarHooks {
  /** 点了一条会话：交给 agent 发 `resumeSession`。 */
  onResume(id: string, cwd: string): void;
  /** 「新建」：交给 agent 发 `newSession`。 */
  onNew(): void;
  /** 一行提示（与开场诊断同一处）。 */
  notice(text: string, tone?: 'info' | 'warn' | 'error'): void;
  /** 底栏「模型」：打开模型选择器。 */
  openModelPicker(): void;
  /** 底栏「技能」：列一下进了 prompt 的 skill（与 `/skills` 同一个弹窗）。 */
  openSkills(): void;
  /** 底栏「设置」：与 `/settings` 同一个弹窗。 */
  openSettings(): void;
}

export interface Sidebar {
  /** 重新拉一次列表（连上、一轮跑完、恢复之后）。 */
  refresh(): void;
  /** 服务端状态变了：当前会话 / cwd / 在不在跑。 */
  sync(state: { sessionId: string; cwd: string; busy: boolean }): void;
  /** 收起 / 展开（顶栏那个按钮）。 */
  toggle(): void;
  isOpen(): boolean;
}

/** 一条会话属于哪一组（就是它的 cwd）。 */
export interface SessionGroup {
  cwd: string;
  sessions: WebSessionRef[];
}

/**
 * 按 cwd 归堆，组内按最后说话时间倒序，组间按各自最新的那条排。
 *
 * 导出是为了单测：这一段的错法都是「看着有、其实是错的」（组跑了、最新的那条不在
 * 顶上），而它在浏览器里没有便宜的眼睛看得出来。
 */
export function groupSessions(sessions: readonly WebSessionRef[]): SessionGroup[] {
  const byCwd = new Map<string, WebSessionRef[]>();
  for (const session of sessions) {
    const key = session.cwd === '' ? '（未知目录）' : session.cwd;
    const list = byCwd.get(key);
    if (list === undefined) byCwd.set(key, [session]);
    else list.push(session);
  }
  const groups: SessionGroup[] = [];
  for (const [cwd, list] of byCwd) {
    list.sort((a, b) => b.lastActivityMs - a.lastActivityMs || a.id.localeCompare(b.id));
    groups.push({ cwd, sessions: list });
  }
  // 组按「它下面最新的那条」排：列表是一份时间轴，组的顺序也该是。
  groups.sort(
    (a, b) => (b.sessions[0]?.lastActivityMs ?? 0) - (a.sessions[0]?.lastActivityMs ?? 0),
  );
  return groups;
}

/** 搜索命中：标题、cwd 或 id 里含这个词（大小写不敏感）。 */
export function matchesQuery(session: WebSessionRef, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return (
    session.title.toLowerCase().includes(needle) ||
    session.cwd.toLowerCase().includes(needle) ||
    session.id.toLowerCase().includes(needle)
  );
}

function readStoredOpen(): boolean {
  try {
    const stored = window.localStorage.getItem(OPEN_STORAGE_KEY);
    if (stored === '0') return false;
    if (stored === '1') return true;
  } catch {
    // 隐私模式：当作没存过。
  }
  // 没存过：宽屏默认开，窄屏默认收（盖上来的一层，开着就看不到对话）。
  return window.innerWidth > 768;
}

function writeStoredOpen(open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_STORAGE_KEY, open ? '1' : '0');
  } catch {
    // 隐私模式：存不下就算了，这一次会话照样用。
  }
}

function readCollapsedGroups(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_GROUPS_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeCollapsedGroups(groups: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...groups]));
  } catch {
    // 同上。
  }
}

/** 一个按钮：侧边栏里那三种（顶栏的 `+`、组头、一行会话）都长这样。 */
function button(className: string, label: string): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.textContent = label;
  return el;
}

/**
 * 一个图标按钮（组头的「+」「删除」、会话行的「归档」「删除」）。
 *
 * `aria-label` 与 `title` 都给上：这些按钮在**hover 才出现**，没有文字可读，
 * 屏幕阅读器只能靠 label（而鼠标只能靠 title）。
 */
function iconButton(className: string, label: string, svg: string): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.title = label;
  el.setAttribute('aria-label', label);
  el.innerHTML = svg;
  return el;
}

const ICON_PLUS =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>';
const ICON_TRASH =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16" /><path d="M9 7V5h6v2" /><path d="m6 7 1 13h10l1-13" /></svg>';
const ICON_ARCHIVE =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h18v4H3z" /><path d="M5 9v11h14V9" /><path d="M10 13h4" /></svg>';
const ICON_RESTORE =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h18v4H3z" /><path d="M5 9v11h14V9" /><path d="M12 18v-5" /><path d="m9.6 15.4 2.4-2.4 2.4 2.4" /></svg>';

/**
 * 真删东西之前的二次确认（模态框复用 `/skills` 那一套外观，见 `modal.ts`）。
 *
 * 为什么不是 `window.confirm`：那个弹框不属于页面、在深色主题里是一块白，而且
 * 挡不住「键盘上顺手一个 Enter」。这里的默认高亮落在**取消**上，删要再选一下。
 */
function confirmAction(options: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
}): void {
  const modal = openModal({ title: options.title, message: options.message, footer: '↑↓ 选择 · Enter 确认 · Esc 取消' });
  modal.setRows([
    // 取消在前：默认高亮在它上面，顺手一个 Enter 不会删东西。
    { label: '取消', onPick: () => modal.close() },
    {
      label: options.confirmLabel,
      hint: '不可撤销',
      onPick: () => {
        modal.close();
        options.onConfirm();
      },
    },
  ]);
}

export function installSidebar(host: HTMLElement, hooks: SidebarHooks): Sidebar {
  host.innerHTML = `
    <div class="ela-sidebar-head">
      <span class="ela-sidebar-brand">ela</span>
      <span class="ela-sidebar-head-spacer"></span>
      <button type="button" class="ela-sidebar-new" title="新建会话（换一个新的会话文件）">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        <span>新建</span>
      </button>
      <button type="button" class="ela-sidebar-search-toggle" title="搜索会话" aria-label="搜索会话" aria-expanded="false">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m20 20-4.6-4.6" /></svg>
      </button>
    </div>
    <div class="ela-sidebar-search" hidden>
      <input type="search" class="ela-sidebar-search-input" placeholder="搜索标题 / 目录…" aria-label="搜索会话" maxlength="120" />
    </div>
    <div class="ela-sidebar-sessions"></div>
    <div class="ela-sidebar-archive" hidden>
      <button type="button" class="ela-sidebar-archive-toggle" title="看看归档里的会话（可恢复或删除）">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h18v4H3z" /><path d="M5 9v11h14V9" /><path d="M10 13h4" /></svg>
        <span class="ela-sidebar-archive-label">已归档 · 0</span>
      </button>
    </div>
    <div class="ela-sidebar-foot">
      <button type="button" class="ela-sidebar-key" data-key="model" title="模型">模型</button>
      <button type="button" class="ela-sidebar-key" data-key="skills" title="技能">技能</button>
      <button type="button" class="ela-sidebar-key" data-key="settings" title="设置">设置</button>
    </div>
  `;

  const requireIn = <T extends HTMLElement>(selector: string): T => {
    const el = host.querySelector<T>(selector);
    if (el === null) throw new Error(`侧边栏缺少 ${selector}`);
    return el;
  };

  const list = requireIn<HTMLElement>('.ela-sidebar-sessions');
  const searchBox = requireIn<HTMLElement>('.ela-sidebar-search');
  const searchInput = requireIn<HTMLInputElement>('.ela-sidebar-search-input');
  const searchToggle = requireIn<HTMLButtonElement>('.ela-sidebar-search-toggle');
  const archiveRow = requireIn<HTMLElement>('.ela-sidebar-archive');
  const archiveToggle = requireIn<HTMLButtonElement>('.ela-sidebar-archive-toggle');
  const archiveLabel = requireIn<HTMLElement>('.ela-sidebar-archive-label');

  let sessions: WebSessionRef[] = [];
  let archived: WebSessionRef[] = [];
  let archivedCount = 0;
  /** 现在看的是主列表还是归档那一栏（底部那个按钮切的）。 */
  let showingArchive = false;
  let query = '';
  let currentSessionId = '';
  let currentCwd = '';
  let busy = false;
  let open = readStoredOpen();
  const collapsedGroups = readCollapsedGroups();

  const applyOpen = (): void => {
    host.classList.toggle('is-collapsed', !open);
    // 折叠后宽度由 CSS 归零（见 app.css）—— 这里只改一个类，让过渡动得起来。
    // `inert`：收起时里面那些按钮不能再 Tab 得到（宽度 0 但仍在 DOM 里）。
    host.toggleAttribute('inert', !open);
  };
  applyOpen();

  /** 现在能不能换会话（环在跑就不行）：行与「新建」共用同一条判据（话不一样）。 */
  const refuseWhileRunning = (what: '切换会话' | '新建会话'): boolean => {
    if (!busy) return false;
    hooks.notice(`上一回合还没结束，先中断再${what}`, 'warn');
    return true;
  };

  const setQuery = (next: string): void => {
    query = next;
    searchBox.hidden = query === '';
    searchToggle.setAttribute('aria-expanded', query === '' ? 'false' : 'true');
    searchToggle.classList.toggle('is-active', query !== '');
    render();
  };

  /** 一句失败提示（HTTP 打不通、服务端拒绝都走这条）。 */
  const reportFailure = (error: unknown): void => {
    hooks.notice(`侧边栏操作失败：${error instanceof Error ? error.message : String(error)}`, 'warn');
  };

  /** 归档 / 恢复一批会话，然后重画（份数与列表都在服务端，别在本地猜）。 */
  const setArchived = async (ids: readonly string[], archived: boolean): Promise<void> => {
    try {
      const result = await elaApi.setArchived(ids, archived);
      if (!result.ok) {
        hooks.notice(result.message ?? (archived ? '归档失败' : '恢复失败'), 'warn');
        return;
      }
      if (archived) hooks.notice(ids.length === 1 ? '已归档（底部「已归档」里能找回）' : `已归档 ${ids.length} 个会话`);
      await refresh();
    } catch (error) {
      reportFailure(error);
    }
  };

  /** 真删一批会话（确认已经问过用户了），然后重画。 */
  const removeSessions = async (ids: readonly string[]): Promise<void> => {
    try {
      const result = await elaApi.deleteSessions(ids);
      if (result.message !== undefined && result.message !== '') hooks.notice(result.message, 'warn');
      if (result.failed.length > 0) {
        const first = result.failed[0];
        hooks.notice(
          `有 ${result.failed.length} 个没删掉：${first === undefined ? '' : first.reason}`,
          'error',
        );
      } else if (result.deleted.length > 0) {
        hooks.notice(`删掉了 ${result.deleted.length} 个会话`);
      }
      await refresh();
    } catch (error) {
      reportFailure(error);
    }
  };

  /** 一行末尾的「归档」：只是收起来，会话文件还在（底部那个入口能找回）。 */
  const archiveAction = (session: WebSessionRef): HTMLButtonElement => {
    const el = iconButton('ela-session-action', '归档（收进「已归档」）', ICON_ARCHIVE);
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      void setArchived([session.id], true);
    });
    return el;
  };

  /** 归档那一栏里的「恢复」：把标记去掉，它回到主列表。 */
  const restoreAction = (session: WebSessionRef): HTMLButtonElement => {
    const el = iconButton('ela-session-action', '恢复（放回会话列表）', ICON_RESTORE);
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      void setArchived([session.id], false);
    });
    return el;
  };

  /** 一行末尾的「删除」：真删文件，所以先问一句。 */
  const deleteAction = (session: WebSessionRef): HTMLButtonElement => {
    const el = iconButton('ela-session-action is-danger', '删除（连文件一起删）', ICON_TRASH);
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      confirmAction({
        title: '删除这个会话？',
        message: `${session.title}\n${session.cwd}\n\n会话文件与轨迹都会被删掉，不能恢复。只是不想看见它的话，用旁边的「归档」。`,
        confirmLabel: '删除',
        onConfirm: () => void removeSessions([session.id]),
      });
    });
    return el;
  };

  /**
   * 一整行会话：左边标题（点了恢复它），右边时间 —— hover 时时间让位给那两个图标按钮
   * （归档 / 删除；归档那一栏里是 恢复 / 删除）。
   *
   * 为什么是 `div` + 里层 `button`，而不是原来那个整行 `button`：按钮里不能套按钮
   * （HTML 解析器会把里层那个扔出去），而这两个图标必须长在行里。
   */
  const renderRow = (session: WebSessionRef, archivedView: boolean): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'ela-session-row';
    row.dataset['sessionId'] = session.id;
    row.classList.toggle('is-current', !archivedView && session.id === currentSessionId);

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'ela-session-main';
    if (busy) {
      row.classList.add('is-locked');
      main.setAttribute('aria-disabled', 'true');
      main.title = '有会话正在运行，先中断再切换';
    } else {
      main.title = `${session.title}\n${session.cwd}\n${session.messageCount} 条 · ${relativeTime(session.lastActivityMs)}`;
    }
    const title = document.createElement('span');
    title.className = 'ela-session-title';
    title.textContent = session.title;
    const meta = document.createElement('span');
    meta.className = 'ela-session-meta';
    // 归档那一栏说「什么时候归档的」（比最后一次说话有意思），主列表说最后说话时间。
    meta.textContent =
      archivedView && session.archivedAt !== undefined
        ? relativeTime(session.archivedAt)
        : relativeTime(session.lastActivityMs);
    main.append(title, meta);
    main.addEventListener('click', () => {
      if (refuseWhileRunning('切换会话')) return;
      hooks.onResume(session.id, session.cwd);
    });
    row.append(main);

    // 跑着的时候不画这两个按钮：归档会让正在写的那个会话从列表上消失，删更不行
    // （服务端也会拒，但按钮不该先骗人一下）。
    if (!busy) {
      const actions = document.createElement('span');
      actions.className = 'ela-session-actions';
      actions.append(archivedView ? restoreAction(session) : archiveAction(session), deleteAction(session));
      row.append(actions);
    }
    return row;
  };

  /** 组头 hover 才出来的两个：在这个项目里新建 / 删掉这个项目的全部会话。 */
  const renderGroupActions = (group: SessionGroup): HTMLElement => {
    const actions = document.createElement('span');
    actions.className = 'ela-session-group-actions';
    if (busy) return actions;

    const name = pathBase(group.cwd) || group.cwd;
    const add = iconButton('ela-session-group-action', `在 ${name} 里新建会话`, ICON_PLUS);
    add.addEventListener('click', (event) => {
      event.stopPropagation();
      // 内核的 cwd 是启动时定的（见 reducer 的 `conversation.reset`）：只有当前项目
      // 那一个能真开新会话，别的项目给一句能照做的提示，不假装做到了。
      if (group.cwd !== currentCwd) {
        hooks.notice(`只能在当前项目里新建会话：请在 ${group.cwd} 里启动 ela`, 'warn');
        return;
      }
      if (refuseWhileRunning('新建会话')) return;
      hooks.onNew();
    });

    const remove = iconButton('ela-session-group-action is-danger', `删除 ${name} 的全部会话`, ICON_TRASH);
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      const ids = group.sessions.map((session) => session.id);
      confirmAction({
        title: `删除「${name}」的全部会话？`,
        message: `${group.cwd}\n\n这个项目下的 ${ids.length} 个会话文件会被真删掉（含轨迹），不能恢复。`,
        confirmLabel: `删除 ${ids.length} 个会话`,
        onConfirm: () => void removeSessions(ids),
      });
    });

    actions.append(add, remove);
    return actions;
  };

  const renderGroup = (group: SessionGroup, archivedView: boolean): HTMLElement => {
    const box = document.createElement('div');
    box.className = 'ela-session-group';
    const header = document.createElement('div');
    header.className = 'ela-session-group-head';
    const toggle = button('ela-session-group-toggle', pathBase(group.cwd) || group.cwd);
    const collapsed = collapsedGroups.has(group.cwd);
    toggle.classList.toggle('is-collapsed', collapsed);
    toggle.title = group.cwd;
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.addEventListener('click', () => {
      if (collapsedGroups.has(group.cwd)) collapsedGroups.delete(group.cwd);
      else collapsedGroups.add(group.cwd);
      writeCollapsedGroups(collapsedGroups);
      render();
    });
    header.append(toggle);
    // 归档那一栏没有这两个快捷动作：那里是「已经收起来的」，新建/删全部都属于主列表。
    if (!archivedView) header.append(renderGroupActions(group));
    box.append(header);
    if (!collapsed) {
      for (const session of group.sessions) box.append(renderRow(session, archivedView));
    }
    return box;
  };

  function render(): void {
    // 给外层（端到端测试、调试）一个可读的当下状态：锁定与当前会话都是别人想断言的事。
    host.dataset['busy'] = busy ? '1' : '0';
    host.dataset['sessionId'] = currentSessionId;
    host.dataset['view'] = showingArchive ? 'archive' : 'sessions';
    // 「新建」与行同一条规矩：跑着的时候锁上（点了说一句，不静默）。
    newButton.classList.toggle('is-locked', busy);
    newButton.setAttribute('aria-disabled', busy ? 'true' : 'false');
    newButton.title = busy ? '有会话正在运行，先中断再新建' : '新建会话（换一个新的会话文件）';

    // 底部「已归档 · N」：一个都没归档、也不在归档那一栏时不占地方。
    archiveRow.hidden = archivedCount === 0 && !showingArchive;
    archiveToggle.classList.toggle('is-active', showingArchive);
    archiveLabel.textContent = showingArchive ? '返回会话列表' : `已归档 · ${archivedCount}`;
    archiveToggle.title = showingArchive
      ? '回到会话列表'
      : `看看归档里的 ${archivedCount} 个会话（可恢复或删除）`;

    list.replaceChildren();
    const source = showingArchive ? archived : sessions;
    const visible = source.filter((session) => matchesQuery(session, query));
    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ela-sidebar-empty';
      empty.textContent = showingArchive
        ? archived.length === 0
          ? '归档里是空的'
          : '没有匹配的会话'
        : sessions.length === 0
          ? '还没有会话'
          : '没有匹配的会话';
      list.append(empty);
      return;
    }
    for (const group of groupSessions(visible)) list.append(renderGroup(group, showingArchive));
  }

  searchToggle.addEventListener('click', () => {
    if (searchBox.hidden) {
      searchBox.hidden = false;
      searchToggle.setAttribute('aria-expanded', 'true');
      searchToggle.classList.add('is-active');
      searchInput.focus();
      return;
    }
    searchInput.value = '';
    setQuery('');
  });
  searchInput.addEventListener('input', () => setQuery(searchInput.value));
  searchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // Esc 只收搜索框：不收侧边栏（那是顶栏那个按钮的事）。
    event.stopPropagation();
    searchInput.value = '';
    setQuery('');
    searchInput.blur();
  });

  archiveToggle.addEventListener('click', () => {
    showingArchive = !showingArchive;
    // 归档那一栏的明细按需拉（主列表每次刷新都带一遍它没必要），所以这里走一次 refresh。
    void refresh();
  });

  const newButton = requireIn<HTMLButtonElement>('.ela-sidebar-new');
  newButton.addEventListener('click', () => {
    if (refuseWhileRunning('新建会话')) return;
    hooks.onNew();
  });
  requireIn<HTMLButtonElement>('[data-key="model"]').addEventListener('click', () => hooks.openModelPicker());
  requireIn<HTMLButtonElement>('[data-key="skills"]').addEventListener('click', () => hooks.openSkills());
  requireIn<HTMLButtonElement>('[data-key="settings"]').addEventListener('click', () => hooks.openSettings());

  const refresh = async (): Promise<void> => {
    try {
      const [info, archive] = await Promise.all([
        elaApi.sessions(),
        showingArchive ? elaApi.archivedSessions() : Promise.resolve(null),
      ]);
      sessions = info.sessions;
      archivedCount = info.archivedCount;
      if (archive !== null) {
        archived = archive.sessions;
        archivedCount = archive.archivedCount;
      }
      render();
    } catch (error) {
      // 拉不到就说一声，别把上一次那份当真相继续显示（它会越来越旧）。
      hooks.notice(`拿不到会话列表：${error instanceof Error ? error.message : String(error)}`, 'warn');
    }
  };

  render();
  void refresh();

  return {
    refresh: () => void refresh(),
    sync(state) {
      const changed =
        state.sessionId !== currentSessionId || state.busy !== busy || state.cwd !== currentCwd;
      currentSessionId = state.sessionId;
      currentCwd = state.cwd;
      busy = state.busy;
      if (changed) render();
    },
    toggle() {
      open = !open;
      writeStoredOpen(open);
      applyOpen();
    },
    isOpen: () => open,
  };
}
