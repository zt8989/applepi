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
 */

import { elaApi } from './api';
import { pathBase, relativeTime } from './format';
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

  let sessions: WebSessionRef[] = [];
  let query = '';
  let currentSessionId = '';
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

  /** 一整行会话。`busy` ⇒ 锁上（`aria-disabled` + 一句提示）。 */
  const renderRow = (session: WebSessionRef): HTMLElement => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ela-session-row';
    row.classList.toggle('is-current', session.id === currentSessionId);
    if (busy) {
      row.classList.add('is-locked');
      row.setAttribute('aria-disabled', 'true');
      row.title = '有会话正在运行，先中断再切换';
    } else {
      row.title = `${session.title}\n${session.cwd}\n${session.messageCount} 条 · ${relativeTime(session.lastActivityMs)}`;
    }
    const title = document.createElement('span');
    title.className = 'ela-session-title';
    title.textContent = session.title;
    const meta = document.createElement('span');
    meta.className = 'ela-session-meta';
    meta.textContent = relativeTime(session.lastActivityMs);
    row.append(title, meta);
    row.addEventListener('click', () => {
      if (refuseWhileRunning('切换会话')) return;
      hooks.onResume(session.id, session.cwd);
    });
    return row;
  };

  const renderGroup = (group: SessionGroup): HTMLElement => {
    const box = document.createElement('div');
    box.className = 'ela-session-group';
    const header = document.createElement('div');
    header.className = 'ela-session-group-head';
    const toggle = button('ela-session-group-toggle', pathBase(group.cwd) || group.cwd);
    const collapsed = collapsedGroups.has(group.cwd);
    toggle.classList.toggle('is-collapsed', collapsed);
    toggle.title = `${group.cwd}\n${group.sessions.length} 个会话`;
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.addEventListener('click', () => {
      if (collapsedGroups.has(group.cwd)) collapsedGroups.delete(group.cwd);
      else collapsedGroups.add(group.cwd);
      writeCollapsedGroups(collapsedGroups);
      render();
    });
    const count = document.createElement('span');
    count.className = 'ela-session-group-count';
    count.textContent = String(group.sessions.length);
    header.append(toggle, count);
    box.append(header);
    if (!collapsed) {
      for (const session of group.sessions) box.append(renderRow(session));
    }
    return box;
  };

  function render(): void {
    // 给外层（端到端测试、调试）一个可读的当下状态：锁定与当前会话都是别人想断言的事。
    host.dataset['busy'] = busy ? '1' : '0';
    host.dataset['sessionId'] = currentSessionId;
    // 「新建」与行同一条规矩：跑着的时候锁上（点了说一句，不静默）。
    newButton.classList.toggle('is-locked', busy);
    newButton.setAttribute('aria-disabled', busy ? 'true' : 'false');
    newButton.title = busy ? '有会话正在运行，先中断再新建' : '新建会话（换一个新的会话文件）';
    list.replaceChildren();
    const visible = sessions.filter((session) => matchesQuery(session, query));
    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ela-sidebar-empty';
      empty.textContent = sessions.length === 0 ? '还没有会话' : '没有匹配的会话';
      list.append(empty);
      return;
    }
    for (const group of groupSessions(visible)) list.append(renderGroup(group));
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

  const newButton = requireIn<HTMLButtonElement>('.ela-sidebar-new');
  newButton.addEventListener('click', () => {
    if (refuseWhileRunning('新建会话')) return;
    hooks.onNew();
  });
  requireIn<HTMLButtonElement>('[data-key="model"]').addEventListener('click', () => hooks.openModelPicker());
  requireIn<HTMLButtonElement>('[data-key="skills"]').addEventListener('click', () => hooks.openSkills());
  requireIn<HTMLButtonElement>('[data-key="settings"]').addEventListener('click', () => hooks.openSettings());

  const refresh = (): void => {
    void elaApi
      .sessions()
      .then((info) => {
        sessions = info.sessions;
        render();
      })
      .catch((error: unknown) => {
        // 拉不到就说一声，别把上一次那份当真相继续显示（它会越来越旧）。
        hooks.notice(`拿不到会话列表：${error instanceof Error ? error.message : String(error)}`, 'warn');
      });
  };

  render();
  refresh();

  return {
    refresh,
    sync(state) {
      const changed =
        state.sessionId !== currentSessionId || state.busy !== busy;
      currentSessionId = state.sessionId;
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
