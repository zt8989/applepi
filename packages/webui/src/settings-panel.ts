/**
 * 设置面板（`/settings`；`/scoped-models` 与 `/skills` 也打开它对应的分区）。
 *
 * ## 为什么从「一列模态框」改成分区
 *
 * 与 pi-web 的设置页对齐：顶部分区（常规 / 模型 / 技能），每个分区一页。
 *
 * 新加的「模型」分区就是 composer 模型选择器的候选集 —— `settings.json` 的
 * `enabledModels`（「可用模型」）。以前它只在 `/scoped-models` 里，与「设置」是两个
 * 入口；现在它和别的设置在同一屏、同一套键盘口径里。勾一下即保存（与 `/scoped-models`、
 * TUI 同一口径），保存失败会退回改前的状态并给一行提示 —— 界面不显示没写进
 * `settings.json` 的值。
 *
 * ## 为什么不复用 `modal.ts`
 *
 * `modal.ts` 只画「一列行」，没有分区，也没有「每个分区各自一块搜索框」。这里三页的
 * 形状差别很大（开关 / 分组勾选 / 只读清单），所以自己拼一屏；子对话框（默认思考级别、
 * skill 详情）仍然用 `modal.ts`，行样式与键盘口径照旧。
 *
 * ## 键盘
 *
 * ↑↓ 选 · Enter 切换 / 勾选 · Tab / Shift+Tab 切换分区 · Esc 关闭。
 * Tab 被整屏接管（搜索框里也一样）—— 否则在一列自绘行里没有可聚焦的下一站，
 * 分区就成了只能用鼠标点。
 */

import type {
  WebModelRef,
  WebSettingsInfo,
  WebSkillInfo,
  WebThinkingInfo,
} from '@ela/core/web-protocol';
import { elaApi } from './api';
import { openModal } from './modal';
import {
  buildScopeState,
  cloneScopeState,
  enabledCount,
  groupByProvider,
  modelRef,
  providerKeys,
  remainingEnabled,
  scopePayload,
  setAllEnabled,
  setProviderEnabled,
  toggleModel,
  type ScopeState,
} from './settings-scope';

export type SettingsTab = 'general' | 'models' | 'skills';

export interface SettingsPanelOptions {
  /** 打开时落在哪个分区（`/settings` → general，`/scoped-models` → models…）。 */
  tab?: SettingsTab | undefined;
  /** 顶部提示行（与开场诊断同一处）。 */
  notice(text: string, tone?: 'info' | 'warn' | 'error'): void;
}

/** 一行。`onPick` 没有 = 只是文本（不参与 ↑↓）。 */
interface PanelRow {
  label: string;
  hint?: string | undefined;
  mark?: string | undefined;
  /** 高亮成「当前项」。 */
  active?: boolean | undefined;
  /** 分区里的小标题（`可用模型 8/12 已启用`），不参与选择。 */
  header?: boolean | undefined;
  /** provider 那一行（整组开关）。 */
  group?: boolean | undefined;
  /** 缩进到 provider 下面（模型行）。 */
  child?: boolean | undefined;
  /** 用等宽字体（模型 id）。 */
  mono?: boolean | undefined;
  /** 悬停提示（skill 的路径 / 描述）。 */
  title?: string | undefined;
  onPick?: (() => void) | undefined;
}

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: '常规' },
  { id: 'models', label: '模型' },
  { id: 'skills', label: '技能' },
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 纯文本弹窗（skill 详情）。 */
function showText(title: string, text: string): void {
  const modal = openModal({ title, footer: 'Esc 关闭' });
  modal.setText(text === '' ? '（空）' : text);
}

export function openSettingsPanel(options: SettingsPanelOptions): () => void {
  let active: SettingsTab = options.tab ?? 'general';

  const backdrop = document.createElement('div');
  backdrop.className = 'ela-modal-backdrop';
  const panel = document.createElement('div');
  panel.className = 'ela-modal ela-settings';
  backdrop.append(panel);

  const title = document.createElement('div');
  title.className = 'ela-modal-title';
  title.textContent = '设置';

  const tabs = document.createElement('div');
  tabs.className = 'ela-settings-tabs';
  tabs.setAttribute('role', 'tablist');

  const body = document.createElement('div');
  body.className = 'ela-settings-body';

  const status = document.createElement('div');
  status.className = 'ela-settings-status';
  status.hidden = true;

  const footer = document.createElement('div');
  footer.className = 'ela-modal-hint';

  panel.append(title, tabs, body, status, footer);

  // ── 每一页的数据（开着面板时缓存一次；写入就地更新，不重新拉） ──

  let general: WebSettingsInfo | null = null;
  let generalLoading = false;
  let generalError: string | null = null;

  let scope: ScopeState | null = null;
  let modelsLoading = false;
  let modelsError: string | null = null;
  /** 模型分区的搜索词（切走再回来还在）。 */
  let searchQuery = '';

  let skills: WebSkillInfo[] | null = null;
  let skillsLoading = false;
  let skillsError: string | null = null;

  /** 一次只存一个（勾太快会让两次写盘抢同一份 settings.json）。 */
  let saving = false;

  // ── 行的选择状态 ──

  let rows: PanelRow[] = [];
  let selected = 0;
  let listHost: HTMLUListElement | null = null;
  let search: HTMLInputElement | null = null;

  function paintFooter(): void {
    footer.textContent = saving
      ? '保存中…'
      : active === 'models'
        ? '↑↓ 选择 · Enter 勾选/取消 · Tab 切换分区 · Esc 关闭（勾一下即保存）'
        : active === 'skills'
          ? '↑↓ 选择 · Enter 查看详情 · Tab 切换分区 · Esc 关闭'
          : '↑↓ 选择 · Enter 切换 · Tab 切换分区 · Esc 关闭';
  }

  function makeEmpty(text: string, tone: 'info' | 'error' = 'info'): HTMLElement {
    const empty = document.createElement('div');
    empty.className = tone === 'error' ? 'ela-settings-empty is-error' : 'ela-settings-empty';
    empty.textContent = text;
    return empty;
  }

  /**
   * 面板里的一行提示。
   *
   * `options.notice()` 那一条在**模态框后面**（顶部的提示区），盖着半透明背景时
   * 很难读；写盘失败 / 「至少留一个模型」这种不当场看到就会当成「点了没反应」的
   * 反馈，必须长在面板自己身上。
   */
  function flash(text: string, tone: 'warn' | 'error' = 'warn'): void {
    status.textContent = text;
    status.className = tone === 'error' ? 'ela-settings-status is-error' : 'ela-settings-status';
    status.hidden = false;
    options.notice(text, tone);
  }

  function clearFlash(): void {
    status.hidden = true;
    status.textContent = '';
  }

  // ── 画行 ──

  function paintRows(): void {
    const host = listHost;
    if (host === null) return;
    host.replaceChildren();
    rows.forEach((row, index) => {
      const item = document.createElement('li');
      const classes = ['ela-modal-item'];
      if (row.header === true) classes.push('is-header');
      if (row.group === true) classes.push('is-group');
      if (row.child === true) classes.push('is-child');
      if (row.active === true) classes.push('is-current');
      if (row.onPick !== undefined && index === selected) classes.push('is-selected');
      item.className = classes.join(' ');
      if (row.title !== undefined) item.title = row.title;

      if (row.mark !== undefined) {
        const mark = document.createElement('span');
        mark.className = 'ela-modal-check';
        mark.textContent = row.mark;
        item.append(mark);
      }
      const label = document.createElement('span');
      label.className = row.mono === true ? 'ela-modal-model' : 'ela-settings-label';
      label.textContent = row.label;
      item.append(label);
      if (row.hint !== undefined && row.hint !== '') {
        const hint = document.createElement('span');
        hint.className = 'ela-modal-name';
        hint.textContent = row.hint;
        item.append(hint);
      }
      if (row.onPick !== undefined) {
        const onPick = row.onPick;
        // `mousedown` 而不是 `click`：与 `model-picker.ts` 同一个口径 —— 搜索框不丢焦点，
        // 点完还能接着打字筛选。
        item.addEventListener('mousedown', (event) => {
          event.preventDefault();
          selected = index;
          onPick();
        });
        item.addEventListener('mousemove', () => {
          if (selected !== index) {
            selected = index;
            paintRows();
          }
        });
      }
      host.append(item);
    });
    host.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
  }

  /** 换一批行，并把 `selected` 落在一个**可点**的行上。 */
  function setRows(next: PanelRow[]): void {
    rows = next;
    if (selected < 0 || selected >= rows.length) selected = 0;
    if (rows.length > 0 && rows[selected]?.onPick === undefined) {
      const first = rows.findIndex((row) => row.onPick !== undefined);
      selected = first === -1 ? 0 : first;
    }
    paintRows();
  }

  // ── 常规 ──

  function paintGeneral(): void {
    listHost = null;
    search = null;
    body.replaceChildren();

    if (generalLoading) {
      body.append(makeEmpty('读取设置…'));
      return;
    }
    if (generalError !== null) {
      body.append(makeEmpty(generalError, 'error'));
      return;
    }
    if (general === null) {
      body.append(makeEmpty('读取设置…'));
      if (!generalLoading) void loadGeneral();
      return;
    }

    const info = general;
    listHost = document.createElement('ul');
    listHost.className = 'ela-modal-list';
    body.append(listHost);

    const next: PanelRow[] = [];
    if (info.autoCompact !== null) {
      next.push({
        label: '自动压缩',
        mark: info.autoCompact ? '✓' : ' ',
        hint: '上下文快满时自动摘要',
        onPick: () => void setGeneral({ autoCompact: !info.autoCompact }),
      });
    }
    next.push({
      label: '隐藏思考块',
      mark: info.hideThinking ? '✓' : ' ',
      onPick: () => void setGeneral({ hideThinking: !info.hideThinking }),
    });
    next.push({
      label: '默认思考级别',
      hint: info.defaultThinkingLevel,
      onPick: () => void chooseDefaultThinking(info.defaultThinkingLevel),
    });
    setRows(next);
  }

  async function loadGeneral(): Promise<void> {
    if (generalLoading) return;
    generalLoading = true;
    generalError = null;
    if (active === 'general') paintGeneral();
    try {
      general = await elaApi.settings();
    } catch (error) {
      generalError = `读设置失败：${errorText(error)}`;
    } finally {
      generalLoading = false;
      if (active === 'general') paintGeneral();
    }
  }

  async function setGeneral(patch: {
    autoCompact?: boolean;
    hideThinking?: boolean;
  }): Promise<void> {
    if (saving) return;
    clearFlash();
    saving = true;
    paintFooter();
    try {
      const result = await elaApi.setSettings(patch);
      if (!result.ok) {
        flash(result.message ?? '没能写进 settings.json');
        return;
      }
      if (general !== null) general = { ...general, ...patch };
      if (active === 'general') paintGeneral();
    } catch (error) {
      flash(`没能写进 settings.json：${errorText(error)}`);
    } finally {
      saving = false;
      paintFooter();
    }
  }

  /**
   * 选「默认思考级别」（写 settings.json 的 `defaultThinkingLevel`）。
   *
   * 与 TUI 的 `/settings` → Default thinking level per model 不是一回事：那边是
   * **per-model 覆盖**，这一行是**全局默认**（`/thinking` 的 `Ctrl+S` 写的也是它）。
   */
  async function chooseDefaultThinking(current: string): Promise<void> {
    let info: WebThinkingInfo;
    try {
      info = await elaApi.thinking();
    } catch (error) {
      flash(`拿不到思考级别：${errorText(error)}`);
      return;
    }
    const modal = openModal({ title: '默认思考级别', footer: '↑↓ 选择 · Enter 保存 · Esc 取消' });
    modal.setRows(
      info.levels.map((level) => ({
        label: level,
        mark: level === current ? '✓' : ' ',
        active: level === current,
        onPick: () => {
          void (async () => {
            try {
              const result = await elaApi.setSettings({ defaultThinkingLevel: level });
              modal.close();
              if (!result.ok) {
                flash(result.message ?? '没能写进 settings.json');
                return;
              }
              if (general !== null) general = { ...general, defaultThinkingLevel: level };
              options.notice(`默认思考级别 → ${level}`);
              if (active === 'general') paintGeneral();
            } catch (error) {
              modal.close();
              flash(`没能写进 settings.json：${errorText(error)}`);
            }
          })();
        },
      })),
    );
  }

  // ── 模型（可用模型 / 作用域） ──

  function isCurrent(model: WebModelRef): boolean {
    return (
      scope !== null &&
      scope.current !== null &&
      scope.current.provider === model.provider &&
      scope.current.id === model.id
    );
  }

  function modelRow(model: WebModelRef): PanelRow {
    const key = modelRef(model);
    const current = isCurrent(model);
    return {
      label: model.id,
      mark: scope?.enabled.has(key) === true ? '✓' : ' ',
      hint: current ? '当前' : model.name !== model.id ? model.name : '',
      active: current,
      child: true,
      mono: true,
      onPick: () => void toggleOne(model),
    };
  }

  function buildModelRows(): PanelRow[] {
    const state = scope;
    if (state === null) return [];
    const next: PanelRow[] = [];
    const total = enabledCount(state);
    const needle = searchQuery.trim().toLowerCase();
    const matches = (model: WebModelRef): boolean =>
      needle === '' ||
      model.id.toLowerCase().includes(needle) ||
      model.name.toLowerCase().includes(needle) ||
      model.provider.toLowerCase().includes(needle);

    if (needle !== '') {
      const filtered = state.models.filter(matches);
      next.push({
        label: filtered.length === 0 ? '没有匹配的模型' : `${filtered.length} 个匹配`,
        header: true,
      });
      for (const model of filtered) next.push(modelRow(model));
      return next;
    }

    next.push({ label: '可用模型', hint: `${total.enabled}/${total.total} 已启用`, header: true });
    if (total.enabled < total.total || state.extras.length > 0) {
      next.push({
        label: '全部开启',
        hint: state.extras.length > 0 ? '清空作用域（含对不上的旧条目）' : '不限制（清空作用域）',
        onPick: () => void turnAllOn(),
      });
    }
    for (const [provider, models] of groupByProvider(state.models)) {
      const enabled = models.filter((model) => state.enabled.has(modelRef(model))).length;
      next.push({
        label: provider,
        mark: enabled === models.length ? '✓' : enabled === 0 ? ' ' : '−',
        hint: `${enabled}/${models.length}`,
        group: true,
        title: `整个 provider：${provider}`,
        onPick: () => void toggleProvider(provider, enabled !== models.length),
      });
      for (const model of models) next.push(modelRow(model));
    }
    return next;
  }

  function paintModels(): void {
    listHost = null;
    search = null;
    body.replaceChildren();

    if (modelsLoading && scope === null) {
      body.append(makeEmpty('读取模型目录…'));
      return;
    }
    if (modelsError !== null && scope === null) {
      body.append(makeEmpty(modelsError, 'error'));
      return;
    }
    if (scope === null) {
      body.append(makeEmpty('读取模型目录…'));
      if (!modelsLoading) void loadModels();
      return;
    }
    if (scope.models.length === 0) {
      body.append(makeEmpty('内核没有列出任何模型（provider 装配降级了？）'));
      return;
    }

    search = document.createElement('input');
    search.className = 'ela-modal-search';
    search.type = 'text';
    search.placeholder = '筛选模型（id / 名字 / provider）…';
    search.spellcheck = false;
    search.value = searchQuery;
    search.addEventListener('input', () => {
      searchQuery = search?.value ?? '';
      selected = 0;
      setRows(buildModelRows());
    });
    body.append(search);

    listHost = document.createElement('ul');
    listHost.className = 'ela-modal-list';
    body.append(listHost);
    setRows(buildModelRows());
    // 切到这一页就可以直接打字筛选；点行不抢焦点（见 `paintRows`）。
    search.focus();
  }

  async function loadModels(): Promise<void> {
    if (modelsLoading) return;
    modelsLoading = true;
    modelsError = null;
    if (active === 'models') paintModels();
    try {
      scope = buildScopeState(await elaApi.models());
    } catch (error) {
      modelsError = `拿不到模型目录：${errorText(error)}`;
    } finally {
      modelsLoading = false;
      if (active === 'models') paintModels();
    }
  }

  /**
   * 改一下作用域 → 立刻存 → 失败退回。
   *
   * 先改界面再写盘（勾一下就该有反应），但 `settings.json` 是真相：写失败就把状态
   * 整个退回去，并给一行提示。不这么做的话界面会显示一个「下次打开就没了」的勾。
   */
  async function mutateScope(mutate: (state: ScopeState) => void): Promise<void> {
    if (scope === null || saving) return;
    clearFlash();
    const before = cloneScopeState(scope);
    mutate(scope);
    setRows(buildModelRows());

    saving = true;
    paintFooter();
    try {
      const result = await elaApi.setScopedModels(scopePayload(scope));
      if (!result.ok) {
        scope = before;
        setRows(buildModelRows());
        flash(result.message ?? '作用域没存住');
      }
    } catch (error) {
      scope = before;
      setRows(buildModelRows());
      flash(`作用域没存住：${errorText(error)}`);
    } finally {
      saving = false;
      paintFooter();
    }
  }

  async function turnAllOn(): Promise<void> {
    await mutateScope((state) => setAllEnabled(state));
  }

  async function toggleOne(model: WebModelRef): Promise<void> {
    if (scope === null) return;
    const key = modelRef(model);
    const on = !scope.enabled.has(key);
    if (!on && remainingEnabled(scope, [key]) === 0) {
      flash('至少要留一个模型：空作用域会变回全开');
      return;
    }
    await mutateScope((state) => toggleModel(state, key, on));
  }

  async function toggleProvider(provider: string, on: boolean): Promise<void> {
    if (scope === null) return;
    if (!on && remainingEnabled(scope, providerKeys(scope, provider)) === 0) {
      flash('至少要留一个模型：空作用域会变回全开');
      return;
    }
    await mutateScope((state) => setProviderEnabled(state, provider, on));
  }

  // ── 技能 ──

  function paintSkills(): void {
    listHost = null;
    search = null;
    body.replaceChildren();

    if (skillsLoading) {
      body.append(makeEmpty('读取 skill 清单…'));
      return;
    }
    if (skillsError !== null) {
      body.append(makeEmpty(skillsError, 'error'));
      return;
    }
    if (skills === null) {
      body.append(makeEmpty('读取 skill 清单…'));
      if (!skillsLoading) void loadSkills();
      return;
    }
    if (skills.length === 0) {
      body.append(makeEmpty('没有 skill 进了 prompt'));
      return;
    }

    listHost = document.createElement('ul');
    listHost.className = 'ela-modal-list';
    body.append(listHost);
    setRows([
      { label: `进了 prompt 的 skill（${skills.length}）`, header: true },
      ...skills.map((skill) => ({
        label: skill.name,
        hint: skill.description === '' ? skill.scope : `${skill.scope} · ${skill.description}`,
        title: `${skill.description}\n${skill.filePath}`,
        onPick: () =>
          showText(skill.name, `${skill.description}\n\n${skill.filePath}（${skill.scope}）`),
      })),
    ]);
  }

  async function loadSkills(): Promise<void> {
    if (skillsLoading) return;
    skillsLoading = true;
    skillsError = null;
    if (active === 'skills') paintSkills();
    try {
      skills = await elaApi.skills();
    } catch (error) {
      skillsError = `拿不到 skill 清单：${errorText(error)}`;
    } finally {
      skillsLoading = false;
      if (active === 'skills') paintSkills();
    }
  }

  // ── 分区切换 ──

  function paintTabs(): void {
    tabs.replaceChildren();
    for (const tab of TABS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.className = tab.id === active ? 'ela-settings-tab is-active' : 'ela-settings-tab';
      button.textContent = tab.label;
      button.setAttribute('aria-selected', tab.id === active ? 'true' : 'false');
      button.addEventListener('click', () => switchTab(tab.id));
      tabs.append(button);
    }
  }

  function renderBody(): void {
    if (active === 'general') paintGeneral();
    else if (active === 'models') paintModels();
    else paintSkills();
  }

  function switchTab(tab: SettingsTab): void {
    if (active === tab) {
      search?.focus();
      return;
    }
    active = tab;
    selected = 0;
    clearFlash();
    paintTabs();
    paintFooter();
    renderBody();
  }

  // ── 键盘 ──

  /** 叠了子对话框（`modal.ts`）时，键盘归它管。 */
  function isTopMost(): boolean {
    const all = document.querySelectorAll('.ela-modal-backdrop');
    return all[all.length - 1] === backdrop;
  }

  function move(delta: number): void {
    const pickable: number[] = [];
    rows.forEach((row, index) => {
      if (row.onPick !== undefined) pickable.push(index);
    });
    if (pickable.length === 0) return;
    const at = pickable.indexOf(selected);
    const next =
      at === -1
        ? delta > 0
          ? 0
          : pickable.length - 1
        : (at + delta + pickable.length) % pickable.length;
    selected = pickable[next] ?? 0;
    paintRows();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!isTopMost()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const at = TABS.findIndex((tab) => tab.id === active);
      const delta = event.shiftKey ? -1 : 1;
      const next = TABS[(at + delta + TABS.length) % TABS.length];
      if (next !== undefined) switchTab(next.id);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter') {
      const row = rows[selected];
      if (row?.onPick !== undefined) {
        event.preventDefault();
        row.onPick();
      }
    }
  }

  // ── 开关 ──

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown, true);
    backdrop.remove();
  }

  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop && isTopMost()) close();
  });

  paintTabs();
  paintFooter();
  renderBody();
  document.addEventListener('keydown', onKeyDown, true);
  document.body.append(backdrop);

  return close;
}
