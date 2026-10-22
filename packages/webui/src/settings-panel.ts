/**
 * 设置面板（`/settings`；`/scoped-models` 与 `/skills` 也打开它对应的分区）。
 *
 * ## 形状：照 pi-web 的整页设置，而不是一个小模态框
 *
 * 顶部分区（常规 / 模型 / 技能）+ 一块撑满高度的内容区：常规是整页滚动的设置项，
 * 模型与技能是「左侧列表 + 右侧详情」的整页面板。以前这里是一列小模态框，放两个
 * 分区进去只是把同一个框塞满，看不出「一页」的形状。
 *
 * 「模型」那一页就是 composer 模型选择器的候选集 —— `settings.json` 的
 * `enabledModels`（「可用模型」）。左侧是 provider，右侧是该 provider 的模型开关：
 * 勾一下即保存（与 TUI 的 `/scoped-models` 同一个口径），保存失败会退回改前的状态
 * 并给一行提示 —— 界面不显示没写进 `settings.json` 的值。
 *
 * ## 键盘
 *
 * 这一版用**原生控件**（Tab 按钮、`role="switch"`、checkbox、搜索框），Tab / Shift+Tab
 * 交给浏览器走焦点，不再像小模态框那样整屏接管。只接管 `Esc`（关面板）；子对话框
 * （默认思考级别）打开时它自己管键盘。
 */

import type {
  WebAgentInfo,
  WebMcpInfo,
  WebModelRef,
  WebPluginInfo,
  WebPluginsInfo,
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

export type SettingsTab = 'general' | 'models' | 'skills' | 'agents' | 'plugins' | 'mcp';

export interface SettingsPanelOptions {
  /** 打开时落在哪个分区（`/settings` → general，`/scoped-models` → models…）。 */
  tab?: SettingsTab | undefined;
  /** 顶部提示行（与开场诊断同一处）。 */
  notice(text: string, tone?: 'info' | 'warn' | 'error'): void;
}

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: '常规' },
  { id: 'models', label: '模型' },
  { id: 'skills', label: '技能' },
  { id: 'agents', label: '子代理' },
  { id: 'plugins', label: '插件' },
  { id: 'mcp', label: 'MCP' },
];

const AGENT_SOURCE_LABEL: Record<WebAgentInfo['source'], string> = {
  builtin: '内置',
  package: '包',
  user: '用户',
  project: '项目',
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function div(className: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  return node;
}

function span(className: string, text: string): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function openSettingsPanel(options: SettingsPanelOptions): () => void {
  let active: SettingsTab = options.tab ?? 'general';

  const backdrop = div('ela-modal-backdrop ela-settings-backdrop');
  const surface = div('ela-settings-surface');
  const header = div('ela-settings-header');
  const title = element('div', 'ela-settings-title', '设置');
  const tabs = div('ela-settings-tabs');
  tabs.setAttribute('role', 'tablist');
  const closeButton = element('button', 'ela-settings-close', '×');
  closeButton.type = 'button';
  closeButton.title = '关闭（Esc）';
  closeButton.setAttribute('aria-label', '关闭设置');
  const main = div('ela-settings-main');
  const status = div('ela-settings-status');
  status.hidden = true;
  header.append(title, tabs, closeButton);
  surface.append(header, main, status);
  backdrop.append(surface);

  // ── 每一页的数据（开着面板时缓存；写入就地更新，不重新拉） ──

  let general: WebSettingsInfo | null = null;
  let generalLoading = false;
  let generalError: string | null = null;

  let scope: ScopeState | null = null;
  let modelsLoading = false;
  let modelsError: string | null = null;

  let skills: WebSkillInfo[] | null = null;
  let skillsLoading = false;
  let skillsError: string | null = null;

  let agentList: WebAgentInfo[] | null = null;
  let agentsLoading = false;
  let agentsError: string | null = null;
  let selectedAgent: string | null = null;

  let pluginInfo: WebPluginsInfo | null = null;
  let pluginsLoading = false;
  let pluginsError: string | null = null;
  let selectedPlugin: string | null = null;

  let mcpInfo: WebMcpInfo | null = null;
  let mcpLoading = false;
  let mcpError: string | null = null;
  let selectedServer: string | null = null;

  /** 一次只存一个（勾太快会让两次写盘抢同一份 settings.json）。 */
  let saving = false;

  // ── 提示条 ──

  /**
   * 面板底部的一行提示。
   *
   * `options.notice()` 那一条在**模态框后面**（页面顶部的提示区），写盘失败 /
   * 「至少留一个模型」这种不当场看到就会当成「点了没反应」的反馈，必须长在面板里。
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

  function makeState(text: string, isError = false): HTMLElement {
    return element('div', isError ? 'ela-settings-state is-error' : 'ela-settings-state', text);
  }

  /** `role="switch"` 的小拨杆；回调返回 `false` 时自己弹回去。 */
  function switchButton(
    checked: boolean,
    onChange: (next: boolean) => Promise<boolean>,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ela-settings-switch';
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-checked', String(checked));
    button.append(document.createElement('span'));
    button.addEventListener('click', () => {
      if (saving) return;
      const next = button.getAttribute('aria-checked') !== 'true';
      button.setAttribute('aria-checked', String(next));
      void onChange(next).then((ok) => {
        if (!ok) button.setAttribute('aria-checked', String(!next));
      });
    });
    return button;
  }

  function section(heading: string, description: string): HTMLElement {
    const node = element('section', 'ela-settings-section');
    node.append(
      element('h3', 'ela-settings-heading', heading),
      element('p', 'ela-settings-description', description),
    );
    return node;
  }

  function settingRow(label: string, hint: string, control: HTMLElement): HTMLElement {
    const row = div('ela-settings-row');
    const text = div('ela-settings-row-text');
    text.append(
      span('ela-settings-row-label', label),
      span('ela-settings-row-hint', hint),
    );
    row.append(text, control);
    return row;
  }

  function field(label: string, value: string, mono = false): HTMLElement {
    const node = div('ela-settings-field');
    const body = element('div', mono ? 'ela-settings-field-value is-path' : 'ela-settings-field-value', value);
    node.append(element('span', 'ela-settings-field-label', label), body);
    return node;
  }

  function detailHead(title: string, meta: string): HTMLElement {
    const head = div('ela-settings-detail-head');
    const info = div('ela-settings-detail-info');
    info.append(
      element('h3', 'ela-settings-detail-title', title),
      element('p', 'ela-settings-detail-meta', meta),
    );
    head.append(info);
    return head;
  }

  interface SplitEntry {
    key: string;
    label: string;
    tag: string;
  }

  /**
   * 「左侧列表 + 右侧详情」那一页的骨架（模型 / 技能 / 子代理 / 插件 / MCP 同一形状）。
   *
   * 点左侧只改高亮与右侧内容，不重建整页 —— 否则点一次会丢滚动位置。
   */
  function mountSplit(config: {
    heading: string;
    entries: readonly SplitEntry[];
    selected: () => string | null;
    select: (key: string) => void;
    paint: (host: HTMLElement) => void;
  }): void {
    const split = div('ela-settings-split');
    const side = div('ela-settings-side');
    side.append(element('div', 'ela-settings-side-head', `${config.heading}（${config.entries.length}）`));
    const list = div('ela-settings-side-list');
    const detail = div('ela-settings-detail');
    const buttons = new Map<string, HTMLButtonElement>();

    for (const entry of config.entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ela-settings-side-item';
      const active = config.selected() === entry.key;
      if (active) button.classList.add('is-active');
      button.setAttribute('aria-current', active ? 'true' : 'false');
      button.append(span('ela-settings-side-name', entry.label), span('ela-settings-tag', entry.tag));
      button.addEventListener('click', () => {
        if (config.selected() === entry.key) return;
        config.select(entry.key);
        for (const [key, item] of buttons) {
          const on = key === entry.key;
          item.classList.toggle('is-active', on);
          item.setAttribute('aria-current', on ? 'true' : 'false');
        }
        config.paint(detail);
      });
      list.append(button);
      buttons.set(entry.key, button);
    }

    side.append(list);
    split.append(side, detail);
    main.append(split);
    config.paint(detail);
  }

  // ── 常规 ──

  async function loadGeneral(): Promise<void> {
    if (generalLoading) return;
    generalLoading = true;
    generalError = null;
    if (active === 'general') renderGeneral();
    try {
      general = await elaApi.settings();
    } catch (error) {
      generalError = `读设置失败：${errorText(error)}`;
    } finally {
      generalLoading = false;
      if (active === 'general') renderGeneral();
    }
  }

  async function saveGeneral(patch: {
    autoCompact?: boolean;
    hideThinking?: boolean;
    defaultThinkingLevel?: string;
  }): Promise<boolean> {
    if (saving) return false;
    clearFlash();
    saving = true;
    try {
      const result = await elaApi.setSettings(patch);
      if (!result.ok) {
        flash(result.message ?? '没能写进 settings.json');
        return false;
      }
      if (general !== null) general = { ...general, ...patch };
      return true;
    } catch (error) {
      flash(`没能写进 settings.json：${errorText(error)}`);
      return false;
    } finally {
      saving = false;
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
            modal.close();
            if (!(await saveGeneral({ defaultThinkingLevel: level }))) return;
            options.notice(`默认思考级别 → ${level}`);
            if (active === 'general') renderGeneral();
          })();
        },
      })),
    );
  }

  function renderGeneral(): void {
    main.replaceChildren();
    if (generalLoading) {
      main.append(makeState('读取设置…'));
      return;
    }
    if (generalError !== null) {
      main.append(makeState(generalError, true));
      return;
    }
    if (general === null) {
      main.append(makeState('读取设置…'));
      if (!generalLoading) void loadGeneral();
      return;
    }

    const info = general;
    const page = div('ela-settings-page');

    const conversation = section('对话', '这些开关与终端里的 /settings 写同一份 settings.json。');
    if (info.autoCompact !== null) {
      conversation.append(
        settingRow(
          '自动压缩',
          '上下文快满时自动摘要',
          switchButton(info.autoCompact, (next) => saveGeneral({ autoCompact: next })),
        ),
      );
    }
    conversation.append(
      settingRow(
        '隐藏思考块',
        '助手回复里的 thinking 块默认折叠',
        switchButton(info.hideThinking, (next) => saveGeneral({ hideThinking: next })),
      ),
    );

    const thinking = section('思考', '新会话与换模型时用的默认档位。');
    const value = element('button', 'ela-settings-value', `${info.defaultThinkingLevel} ›`);
    value.type = 'button';
    value.title = '选择默认思考级别';
    value.addEventListener('click', () => void chooseDefaultThinking(info.defaultThinkingLevel));
    thinking.append(settingRow('默认思考级别', '全局默认（不是单模型覆盖）', value));

    page.append(conversation, thinking);
    main.append(page);
  }

  // ── 模型（可用模型 / 作用域） ──

  let selectedProvider: string | null = null;
  let query = '';
  let sideListHost: HTMLElement | null = null;
  let sideFootHost: HTMLElement | null = null;
  let detailHost: HTMLElement | null = null;
  let detailMetaEl: HTMLElement | null = null;
  let detailSwitchEl: HTMLButtonElement | null = null;
  let modelRows: { model: WebModelRef; row: HTMLElement; box: HTMLInputElement }[] = [];
  const providerCountEls = new Map<string, HTMLElement>();

  function isCurrent(model: WebModelRef): boolean {
    return (
      scope !== null &&
      scope.current !== null &&
      scope.current.provider === model.provider &&
      scope.current.id === model.id
    );
  }

  async function loadModels(): Promise<void> {
    if (modelsLoading) return;
    modelsLoading = true;
    modelsError = null;
    if (active === 'models') renderModels();
    try {
      scope = buildScopeState(await elaApi.models());
    } catch (error) {
      modelsError = `拿不到模型目录：${errorText(error)}`;
    } finally {
      modelsLoading = false;
      if (active === 'models') renderModels();
    }
  }

  /**
   * 改一下作用域 → 立刻存 → 失败退回。
   *
   * `settings.json` 是真相：写失败就把状态整个退回去，并给一行提示。不这么做的话
   * 界面会显示一个「下次打开就没了」的勾。
   */
  async function mutateScope(
    mutate: (state: ScopeState) => void,
    repaint: () => void,
  ): Promise<boolean> {
    const state = scope;
    if (state === null || saving) return false;
    clearFlash();
    const before = cloneScopeState(state);
    const next = cloneScopeState(state);
    mutate(next);
    scope = next;
    saving = true;
    try {
      const result = await elaApi.setScopedModels(scopePayload(next));
      if (!result.ok) {
        scope = before;
        flash(result.message ?? '作用域没存住');
        repaint();
        return false;
      }
      repaint();
      return true;
    } catch (error) {
      scope = before;
      flash(`作用域没存住：${errorText(error)}`);
      repaint();
      return false;
    } finally {
      saving = false;
    }
  }

  function syncModelRows(): void {
    const state = scope;
    if (state === null) return;
    for (const { model, box } of modelRows) {
      box.checked = state.enabled.has(modelRef(model));
    }
  }

  function updateModelFacts(): void {
    const state = scope;
    if (state === null) return;
    for (const [provider, models] of groupByProvider(state.models)) {
      const count = models.filter((model) => state.enabled.has(modelRef(model))).length;
      const countEl = providerCountEls.get(provider);
      if (countEl !== undefined) countEl.textContent = `${count}/${models.length}`;
    }
    if (selectedProvider !== null) {
      const models = state.models.filter((model) => model.provider === selectedProvider);
      const enabled = models.filter((model) => state.enabled.has(modelRef(model))).length;
      if (detailMetaEl !== null) detailMetaEl.textContent = `${enabled}/${models.length} 已启用`;
      if (detailSwitchEl !== null) {
        detailSwitchEl.setAttribute('aria-checked', String(enabled === models.length));
      }
    }
    paintSideFoot();
  }

  function repaintModels(): void {
    syncModelRows();
    updateModelFacts();
  }

  function paintSideFoot(): void {
    const host = sideFootHost;
    const state = scope;
    if (host === null || state === null) return;
    host.replaceChildren();
    const total = enabledCount(state);
    if (total.enabled < total.total || state.extras.length > 0) {
      const all = element('button', 'ela-settings-link', '全部开启（清空作用域）');
      all.type = 'button';
      all.addEventListener('click', () => void turnAllOn());
      host.append(all);
    }
  }

  function paintProviders(): void {
    const host = sideListHost;
    const state = scope;
    if (host === null || state === null) return;
    providerCountEls.clear();
    host.replaceChildren();
    for (const [provider, models] of groupByProvider(state.models)) {
      const enabled = models.filter((model) => state.enabled.has(modelRef(model))).length;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ela-settings-side-item';
      if (provider === selectedProvider) button.classList.add('is-active');
      button.setAttribute('aria-current', provider === selectedProvider ? 'true' : 'false');
      const count = span('ela-settings-side-count', `${enabled}/${models.length}`);
      button.append(span('ela-settings-side-name', provider), count);
      button.addEventListener('click', () => {
        if (selectedProvider === provider) return;
        selectedProvider = provider;
        query = '';
        paintProviders();
        paintModelDetail();
      });
      host.append(button);
      providerCountEls.set(provider, count);
    }
    paintSideFoot();
  }

  function applyModelFilter(): void {
    const needle = query.trim().toLowerCase();
    for (const { row } of modelRows) {
      const haystack = row.dataset['search'] ?? '';
      row.hidden = needle !== '' && !haystack.includes(needle);
    }
  }

  function paintModelDetail(): void {
    const host = detailHost;
    const state = scope;
    const provider = selectedProvider;
    if (host === null || state === null || provider === null) return;

    const models = state.models.filter((model) => model.provider === provider);
    const enabled = models.filter((model) => state.enabled.has(modelRef(model))).length;

    host.replaceChildren();

    const head = div('ela-settings-detail-head');
    const info = div('ela-settings-detail-info');
    detailMetaEl = element('p', 'ela-settings-detail-meta', `${enabled}/${models.length} 已启用`);
    info.append(element('h3', 'ela-settings-detail-title', provider), detailMetaEl);
    detailSwitchEl = switchButton(enabled === models.length, (next) =>
      toggleProvider(provider, next),
    );
    head.append(info, detailSwitchEl);
    host.append(head);

    const toolbar = div('ela-settings-toolbar');
    const enableAll = element('button', 'ela-settings-tool', '全部开启');
    enableAll.type = 'button';
    enableAll.addEventListener('click', () => void bulkProvider(provider, true));
    const disableAll = element('button', 'ela-settings-tool', '全部关闭');
    disableAll.type = 'button';
    disableAll.addEventListener('click', () => void bulkProvider(provider, false));
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'ela-settings-search';
    search.placeholder = `筛选 ${provider} 的模型（id / 名字）…`;
    search.spellcheck = false;
    search.value = query;
    search.addEventListener('input', () => {
      query = search.value;
      applyModelFilter();
    });
    toolbar.append(enableAll, disableAll, search);
    host.append(toolbar);

    const list = div('ela-settings-list');
    modelRows = [];
    for (const model of models) {
      const row = document.createElement('label');
      row.className = 'ela-settings-model-row';
      row.dataset['search'] = `${model.id} ${model.name} ${model.provider}`.toLowerCase();
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'ela-settings-box';
      box.checked = state.enabled.has(modelRef(model));
      box.addEventListener('change', () => {
        if (saving) {
          box.checked = !box.checked;
          return;
        }
        void toggleModelRow(model, box);
      });
      const names = div('ela-settings-model-names');
      if (model.name !== model.id) {
        names.append(
          span('ela-settings-model-name', model.name),
          span('ela-settings-model-id', model.id),
        );
      } else {
        // 名字与 id 一样时不再写两行（工作区的自定义模型大多这样）。
        names.append(span('ela-settings-model-name is-mono', model.id));
      }
      row.append(box, names);
      if (isCurrent(model)) row.append(span('ela-settings-tag', '当前'));
      list.append(row);
      modelRows.push({ model, row, box });
    }
    host.append(list);
    applyModelFilter();
  }

  async function toggleModelRow(model: WebModelRef, box: HTMLInputElement): Promise<void> {
    const state = scope;
    if (state === null) return;
    const key = modelRef(model);
    const on = box.checked;
    if (!on && remainingEnabled(state, [key]) === 0) {
      box.checked = true;
      flash('至少要留一个模型：空作用域会变回全开');
      return;
    }
    await mutateScope((next) => toggleModel(next, key, on), repaintModels);
  }

  async function toggleProvider(provider: string, on: boolean): Promise<boolean> {
    const state = scope;
    if (state === null) return false;
    if (!on && remainingEnabled(state, providerKeys(state, provider)) === 0) {
      flash('至少要留一个模型：空作用域会变回全开');
      return false;
    }
    return mutateScope((next) => setProviderEnabled(next, provider, on), repaintModels);
  }

  async function bulkProvider(provider: string, on: boolean): Promise<void> {
    await toggleProvider(provider, on);
  }

  async function turnAllOn(): Promise<void> {
    if (scope === null) return;
    await mutateScope(
      (next) => setAllEnabled(next),
      () => {
        paintProviders();
        paintModelDetail();
      },
    );
  }

  function renderModels(): void {
    main.replaceChildren();
    if (modelsLoading && scope === null) {
      main.append(makeState('读取模型目录…'));
      return;
    }
    if (modelsError !== null && scope === null) {
      main.append(makeState(modelsError, true));
      return;
    }
    if (scope === null) {
      main.append(makeState('读取模型目录…'));
      if (!modelsLoading) void loadModels();
      return;
    }
    if (scope.models.length === 0) {
      main.append(makeState('内核没有列出任何模型（provider 装配降级了？）'));
      return;
    }

    const groups = groupByProvider(scope.models);
    if (
      selectedProvider === null ||
      !groups.some(([provider]) => provider === selectedProvider)
    ) {
      const currentProvider = scope.current?.provider ?? null;
      selectedProvider =
        currentProvider !== null && groups.some(([provider]) => provider === currentProvider)
          ? currentProvider
          : groups[0]![0];
    }

    const split = div('ela-settings-split');
    const side = div('ela-settings-side');
    const sideHead = element('div', 'ela-settings-side-head', `Providers（${groups.length}）`);
    sideListHost = div('ela-settings-side-list');
    sideFootHost = div('ela-settings-side-foot');
    side.append(sideHead, sideListHost, sideFootHost);
    detailHost = div('ela-settings-detail');
    split.append(side, detailHost);
    main.append(split);
    paintProviders();
    paintModelDetail();
  }

  // ── 技能 ──

  let selectedSkill: string | null = null;
  let skillDetailHost: HTMLElement | null = null;
  const skillButtons = new Map<string, HTMLButtonElement>();

  async function loadSkills(): Promise<void> {
    if (skillsLoading) return;
    skillsLoading = true;
    skillsError = null;
    if (active === 'skills') renderSkills();
    try {
      skills = await elaApi.skills();
    } catch (error) {
      skillsError = `拿不到 skill 清单：${errorText(error)}`;
    } finally {
      skillsLoading = false;
      if (active === 'skills') renderSkills();
    }
  }

  function paintSkillDetail(): void {
    const host = skillDetailHost;
    if (host === null || skills === null) return;
    const skill = skills.find((item) => item.filePath === selectedSkill);
    host.replaceChildren();
    if (skill === undefined) return;

    const head = div('ela-settings-detail-head');
    const info = div('ela-settings-detail-info');
    info.append(
      element('h3', 'ela-settings-detail-title', skill.name),
      element('p', 'ela-settings-detail-meta', `${skill.scope} · 已进入 prompt`),
    );
    head.append(info);
    host.append(head);

    const fields = div('ela-settings-fields');
    fields.append(
      field('描述', skill.description === '' ? '（没有描述）' : skill.description),
      field('范围', skill.scope),
      field('文件', skill.filePath, true),
    );
    host.append(fields);

    host.append(
      element(
        'div',
        'ela-settings-note',
        '这个清单是只读的：哪些 skill 进了 prompt 由磁盘上的文件与设置决定。',
      ),
    );
  }

  function renderSkills(): void {
    main.replaceChildren();
    if (skillsLoading) {
      main.append(makeState('读取 skill 清单…'));
      return;
    }
    if (skillsError !== null) {
      main.append(makeState(skillsError, true));
      return;
    }
    if (skills === null) {
      main.append(makeState('读取 skill 清单…'));
      if (!skillsLoading) void loadSkills();
      return;
    }
    if (skills.length === 0) {
      main.append(makeState('没有 skill 进了 prompt'));
      return;
    }

    if (selectedSkill === null || !skills.some((skill) => skill.filePath === selectedSkill)) {
      selectedSkill = skills[0]!.filePath;
    }

    const split = div('ela-settings-split');
    const side = div('ela-settings-side');
    const sideHead = element('div', 'ela-settings-side-head', `Skills（${skills.length}）`);
    const list = div('ela-settings-side-list');
    skillButtons.clear();
    for (const skill of skills) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ela-settings-side-item';
      const isActive = skill.filePath === selectedSkill;
      if (isActive) button.classList.add('is-active');
      button.setAttribute('aria-current', isActive ? 'true' : 'false');
      button.title = skill.description;
      button.append(span('ela-settings-side-name', skill.name), span('ela-settings-tag', skill.scope));
      button.addEventListener('click', () => {
        if (selectedSkill === skill.filePath) return;
        selectedSkill = skill.filePath;
        for (const [path, item] of skillButtons) {
          const on = path === selectedSkill;
          item.classList.toggle('is-active', on);
          item.setAttribute('aria-current', on ? 'true' : 'false');
        }
        paintSkillDetail();
      });
      list.append(button);
      skillButtons.set(skill.filePath, button);
    }
    side.append(sideHead, list);
    skillDetailHost = div('ela-settings-detail');
    split.append(side, skillDetailHost);
    main.append(split);
    paintSkillDetail();
  }

  // ── 子代理 ──

  async function loadAgents(): Promise<void> {
    if (agentsLoading) return;
    agentsLoading = true;
    agentsError = null;
    if (active === 'agents') renderAgents();
    try {
      agentList = await elaApi.agents();
    } catch (error) {
      agentsError = `拿不到子代理清单：${errorText(error)}`;
    } finally {
      agentsLoading = false;
      if (active === 'agents') renderAgents();
    }
  }

  function paintAgentDetail(host: HTMLElement): void {
    const agent = agentList?.find((item) => item.filePath === selectedAgent);
    host.replaceChildren();
    if (agent === undefined) return;

    const source = `${AGENT_SOURCE_LABEL[agent.source]}${agent.packageName === undefined ? '' : ` · ${agent.packageName}`}${agent.enabled ? '' : ' · 已停用'}`;
    host.append(detailHead(agent.name, source));
    const fields = div('ela-settings-fields');
    fields.append(
      field('描述', agent.description === '' ? '（没有描述）' : agent.description),
      field('工具', agent.tools.length === 0 ? '默认（不限制）' : agent.tools.join(', ')),
      field('模型', agent.model ?? '继承当前会话'),
      field('思考级别', agent.thinking ?? '继承当前会话'),
      field('文件', agent.filePath, true),
    );
    host.append(fields);
    host.append(
      element(
        'div',
        'ela-settings-note',
        '只读：agent 定义来自磁盘上的 *.md（pi-subagents 的约定），改动后 /reload 或重启生效。',
      ),
    );
  }

  function renderAgents(): void {
    main.replaceChildren();
    if (agentsLoading) {
      main.append(makeState('读取子代理定义…'));
      return;
    }
    if (agentsError !== null) {
      main.append(makeState(agentsError, true));
      return;
    }
    if (agentList === null) {
      main.append(makeState('读取子代理定义…'));
      if (!agentsLoading) void loadAgents();
      return;
    }
    if (agentList.length === 0) {
      main.append(makeState('没有发现子代理定义（pi-subagents 未安装，或没有 agents 目录）'));
      return;
    }

    if (selectedAgent === null || !agentList.some((agent) => agent.filePath === selectedAgent)) {
      selectedAgent = agentList[0]!.filePath;
    }
    mountSplit({
      heading: '子代理',
      entries: agentList.map((agent) => ({
        key: agent.filePath,
        label: agent.name,
        tag: AGENT_SOURCE_LABEL[agent.source],
      })),
      selected: () => selectedAgent,
      select: (key) => {
        selectedAgent = key;
      },
      paint: paintAgentDetail,
    });
  }

  // ── 插件 ──

  async function loadPlugins(): Promise<void> {
    if (pluginsLoading) return;
    pluginsLoading = true;
    pluginsError = null;
    if (active === 'plugins') renderPlugins();
    try {
      pluginInfo = await elaApi.plugins();
    } catch (error) {
      pluginsError = `拿不到插件清单：${errorText(error)}`;
    } finally {
      pluginsLoading = false;
      if (active === 'plugins') renderPlugins();
    }
  }

  function pluginPackagesSection(info: WebPluginsInfo): HTMLElement {
    const node = section('settings.json · packages', '安装 / 删除 / 升级仍用 pi install / pi remove。');
    node.append(
      field('packages', info.packages.length === 0 ? '（没有配置 packages）' : info.packages.join('\n'), true),
    );
    if (info.errors.length > 0) node.append(field('装载诊断', info.errors.join('\n')));
    return node;
  }

  function paintPluginDetail(host: HTMLElement): void {
    const info = pluginInfo;
    if (info === null) return;
    const plugin: WebPluginInfo | undefined = info.extensions.find(
      (item) => item.path === selectedPlugin,
    );
    host.replaceChildren();
    if (plugin === undefined) return;

    const meta = `${plugin.source}${plugin.version === null ? '' : ` · ${plugin.version}`}${plugin.hidden ? ' · 隐藏' : ''}`;
    host.append(detailHead(plugin.name, meta));
    const fields = div('ela-settings-fields');
    fields.append(
      field('描述', plugin.description ?? '（没有描述）'),
      field('来源', plugin.source),
      field('入口', plugin.path, true),
      field('包目录', plugin.baseDir ?? '—', true),
      field('packages', info.packages.length === 0 ? '（没有配置）' : info.packages.join('\n'), true),
    );
    if (info.errors.length > 0) fields.append(field('装载诊断', info.errors.join('\n')));
    host.append(fields);
    host.append(
      element(
        'div',
        'ela-settings-note',
        '只读：这里显示 settings.json 的 packages 与真正装上的扩展；安装 / 删除 / 升级仍走 pi 的包管理器。',
      ),
    );
  }

  function renderPlugins(): void {
    main.replaceChildren();
    if (pluginsLoading) {
      main.append(makeState('读取插件清单…'));
      return;
    }
    if (pluginsError !== null) {
      main.append(makeState(pluginsError, true));
      return;
    }
    if (pluginInfo === null) {
      main.append(makeState('读取插件清单…'));
      if (!pluginsLoading) void loadPlugins();
      return;
    }
    if (pluginInfo.extensions.length === 0) {
      const page = div('ela-settings-page');
      page.append(pluginPackagesSection(pluginInfo));
      main.append(page);
      return;
    }

    if (
      selectedPlugin === null ||
      !pluginInfo.extensions.some((plugin) => plugin.path === selectedPlugin)
    ) {
      selectedPlugin = pluginInfo.extensions[0]!.path;
    }
    // 同一个包里可能有多个扩展入口（如 pi-background-tasks 两个），同名时补上入口文件名。
    const nameCounts = new Map<string, number>();
    for (const plugin of pluginInfo.extensions) {
      nameCounts.set(plugin.name, (nameCounts.get(plugin.name) ?? 0) + 1);
    }
    mountSplit({
      heading: '插件',
      entries: pluginInfo.extensions.map((plugin) => {
        const entryFile = plugin.path.split(/[\\/]/).pop() ?? plugin.path;
        return {
          key: plugin.path,
          label: (nameCounts.get(plugin.name) ?? 0) > 1 ? `${plugin.name} · ${entryFile}` : plugin.name,
          tag: plugin.version ?? '本地',
        };
      }),
      selected: () => selectedPlugin,
      select: (key) => {
        selectedPlugin = key;
      },
      paint: paintPluginDetail,
    });
  }

  // ── MCP ──

  async function loadMcp(): Promise<void> {
    if (mcpLoading) return;
    mcpLoading = true;
    mcpError = null;
    if (active === 'mcp') renderMcp();
    try {
      mcpInfo = await elaApi.mcp();
    } catch (error) {
      mcpError = `拿不到 MCP 配置：${errorText(error)}`;
    } finally {
      mcpLoading = false;
      if (active === 'mcp') renderMcp();
    }
  }

  function paintMcpDetail(host: HTMLElement): void {
    const info = mcpInfo;
    if (info === null) return;
    const server = info.servers.find((item) => item.name === selectedServer);
    host.replaceChildren();
    if (server === undefined) return;

    host.append(
      detailHead(
        server.name,
        `${server.scope === 'project' ? '项目' : '全局'} · ${server.exposure} · ${server.enabled ? '已启用' : '已停用'}`,
      ),
    );
    const fields = div('ela-settings-fields');
    fields.append(
      field('描述', server.description ?? '（没有描述）'),
      field('传输', server.transport, true),
    );
    if (server.envKeys.length > 0) fields.append(field('环境变量（只列名字）', server.envKeys.join(', ')));
    if (server.headerKeys.length > 0) fields.append(field('请求头（只列名字）', server.headerKeys.join(', ')));
    fields.append(field('来源文件', server.source, true));
    if (info.autoEnableCodemode !== null) {
      fields.append(field('autoEnableCodemode', String(info.autoEnableCodemode)));
    }
    if (info.errors.length > 0) fields.append(field('诊断', info.errors.join('\n')));
    host.append(fields);
    host.append(
      element(
        'div',
        'ela-settings-note',
        `只读：改 mcp.json 后 /reload 或重启生效（reload 会重连服务器），这里不会去连服务器。全局：${info.globalPath}；项目：${info.projectPath}${info.projectExists ? '' : '（不存在）'}。`,
      ),
    );
  }

  function renderMcp(): void {
    main.replaceChildren();
    if (mcpLoading) {
      main.append(makeState('读取 MCP 配置…'));
      return;
    }
    if (mcpError !== null) {
      main.append(makeState(mcpError, true));
      return;
    }
    if (mcpInfo === null) {
      main.append(makeState('读取 MCP 配置…'));
      if (!mcpLoading) void loadMcp();
      return;
    }
    if (mcpInfo.servers.length === 0) {
      const page = div('ela-settings-page');
      const node = section('MCP 服务器', '修改 mcp.json 后 /reload 或重启生效；这里不会去连服务器。');
      node.append(field('全局文件', mcpInfo.globalPath, true));
      node.append(field('项目文件', `${mcpInfo.projectPath}${mcpInfo.projectExists ? '' : '（不存在）'}`, true));
      if (mcpInfo.errors.length > 0) node.append(field('诊断', mcpInfo.errors.join('\n')));
      page.append(node);
      main.append(page);
      return;
    }

    if (selectedServer === null || !mcpInfo.servers.some((server) => server.name === selectedServer)) {
      selectedServer = mcpInfo.servers[0]!.name;
    }
    mountSplit({
      heading: 'MCP 服务器',
      entries: mcpInfo.servers.map((server) => ({
        key: server.name,
        label: server.name,
        tag: `${server.scope === 'project' ? '项目' : '全局'}${server.enabled ? '' : ' · 停用'}`,
      })),
      selected: () => selectedServer,
      select: (key) => {
        selectedServer = key;
      },
      paint: paintMcpDetail,
    });
  }

  // ── 分区切换 / 开关 ──

  function paintTabs(): void {
    tabs.replaceChildren();
    for (const tab of TABS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', tab.id === active ? 'true' : 'false');
      button.className = tab.id === active ? 'ela-settings-tab is-active' : 'ela-settings-tab';
      button.textContent = tab.label;
      button.addEventListener('click', () => switchTab(tab.id));
      tabs.append(button);
    }
  }

  function renderBody(): void {
    if (active === 'general') renderGeneral();
    else if (active === 'models') renderModels();
    else if (active === 'skills') renderSkills();
    else if (active === 'agents') renderAgents();
    else if (active === 'plugins') renderPlugins();
    else renderMcp();
  }

  function switchTab(tab: SettingsTab): void {
    if (active === tab) return;
    active = tab;
    clearFlash();
    paintTabs();
    renderBody();
  }

  // ── 键盘 / 关闭 ──

  /** 叠了子对话框（`modal.ts`）时，键盘归它管。 */
  function isTopMost(): boolean {
    const all = document.querySelectorAll('.ela-modal-backdrop');
    return all[all.length - 1] === backdrop;
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!isTopMost()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  }

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown, true);
    backdrop.remove();
  }

  closeButton.addEventListener('click', () => close());
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop && isTopMost()) close();
  });

  paintTabs();
  renderBody();
  document.addEventListener('keydown', onKeyDown, true);
  document.body.append(backdrop);

  return close;
}
