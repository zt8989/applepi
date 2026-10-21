/**
 * 模型选择器（浏览器侧）—— composer 右下角那个模型按钮的**下拉菜单**。
 *
 * ## 为什么不用 pi-web-ui 自带的 `ModelSelector`
 *
 * 因为它列的是**它打包进去那一代 pi-ai 的内置目录**（1500+ 条，含大量本机根本没配的
 * provider），而内核能真发出去的只有 `ModelRuntime.getAvailableSnapshot()` 那些
 * —— 与 TUI 的 `/model` 面板同一份。两边列表不一致时，用户在浏览器里挑一个本机没有的
 * 模型，症状是发出去报错，且只能在服务端日志里看到原因。
 *
 * `AgentInterface` 留了口子：设了 `onModelSelect` 就**不弹**它自己的 selector
 * （见 pi-web-ui `components/AgentInterface.js` 的 `onModelSelect` 分支）。
 *
 * ## 形状：贴着按钮开的下拉，不是整屏模态框
 *
 * 与 pi-web 的 `ModelSelector` 同一个交互：点 composer 上那个模型按钮，菜单在按钮
 * **正上方**弹出来（下面空间不够时才往下），宽度固定、右侧对齐；点外面 / `Esc` 关掉。
 * 列表按 provider 分组，当前模型打勾并自动滚到它；目录有 500+ 条，所以顶部常驻搜索框。
 *
 * ## 对齐 TUI 的哪些行为
 *
 * | TUI（`ModelSelectorComponent`） | 这里 |
 * | --- | --- |
 * | 列表 = 已配置 provider 的可用模型 | 同一份（服务端 `/api/models`） |
 * | 有作用域时默认 `Scope: scoped` | 有作用域时默认「只看已启用」 |
 * | `tab` 切 all / scoped | `Tab` 同一个意思 |
 * | 当前模型打勾 | 同（并自动滚到它） |
 * | 搜索按 id / 名字 | 同（外加 provider） |
 *
 * 刻意**没有**做的：`Ctrl+S` 存默认、后台刷新目录、`default` 前缀直达。它们是
 * pi 那套 settings/catalog 的入口，本项目没接（说明写在 `docs/architecture/webui.md`）。
 */

import type { WebModelRef } from '@ela/core/web-protocol';

export interface ModelPickerOptions {
  models: readonly WebModelRef[];
  /** 当前模型（打勾 + 打开时滚到它）。拿不到就给 `null`。 */
  current: { provider: string; id: string } | null;
  /** 作用域：`null` = 全开；非空 = 默认只看这些（与 TUI 同一个默认）。 */
  scopedModelIds: readonly string[] | null;
  /**
   * 贴着哪个元素开 —— composer 上那个模型按钮（`composerModelButton()` 找）。
   * `null` = 找不到锚点，退化成视口底部居中。
   */
  anchor?: HTMLElement | null | undefined;
  onSelect(model: WebModelRef): void;
}

/** 作用域里的一条 —— 与 `WebModelRef` 同一形状，只在列表里加标记用。 */
const isCurrent = (model: WebModelRef, current: ModelPickerOptions['current']): boolean =>
  current !== null && model.provider === current.provider && model.id === current.id;

/**
 * 合法思考档位。
 *
 * **故意写死**：真相在 `@ela/core/thinking-level.ts` 的 `THINKING_LEVELS`，但那个模块
 * （经由 `pi-config` / `settings-manager`）引了 Node 与 pi-coding-agent 的东西，
 * 浏览器包里引不起。这里只用来「认不认得这个后缀」，多一个少一个的后果是
 * 「某个带后缀的作用域条目没被识别」—— 不会报错，只是那一行不生效。
 */
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * 作用域条目 → 去掉思考级别后缀的模型 key。
 *
 * `settings.json` 的 `enabledModels` 存的是 `provider/id`，也可以带思考级别后缀
 * （`provider/id:high`）—— 而**模型 id 本身就可能带冒号**（`cn:deepseek-v4.1-flash`）。
 * 所以不能简单地按冒号切：只有**最后**一段是合法档位时它才是后缀（与 CLI 的
 * `-m provider/id:high` 同一个判据）。
 *
 * 没有合法后缀时原样返回 —— 设置面板要拿它去比对目录里的 `provider/id`。
 */
export function scopePatternKey(pattern: string): string {
  const slash = pattern.indexOf('/');
  if (slash === -1) return pattern;
  const colon = pattern.lastIndexOf(':');
  if (colon > slash && THINKING_LEVELS.has(pattern.slice(colon + 1))) {
    return pattern.slice(0, colon);
  }
  return pattern;
}

/** 作用域条目 → 可比较的 key 集合（原样与去掉后缀的两种都留着）。 */
export function scopedKeys(patterns: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const pattern of patterns) {
    keys.add(pattern);
    keys.add(scopePatternKey(pattern));
  }
  return keys;
}

/**
 * 在 composer 里找「显示当前模型」的那个按钮 —— 下拉贴着它开。
 *
 * `message-editor` 的按钮顺序是 附件 / 思考级别（`role="combobox"`）/ 模型 / 发送；
 * 模型那个的文字就是当前 id。找不到 id（刚换模型、还没重画）时退化成「文字非空的
 * 最后一个非 combobox 按钮」—— 附件与发送都只有图标，所以这一条也是稳的。
 */
export function composerModelButton(
  root: ParentNode,
  modelId: string | null,
): HTMLElement | null {
  const editor = root.querySelector('message-editor');
  if (editor === null) return null;
  const buttons = [...editor.querySelectorAll('button')];
  if (modelId !== null) {
    const hit = buttons.find((button) => (button.textContent ?? '').trim().includes(modelId));
    if (hit !== undefined) return hit;
  }
  const labeled = buttons.filter(
    (button) =>
      (button.textContent ?? '').trim() !== '' && button.getAttribute('role') !== 'combobox',
  );
  return labeled[labeled.length - 1] ?? null;
}

/** 同时只开一个（再点一次按钮 / `/model` 时先把旧的收掉）。 */
let activePicker: (() => void) | null = null;

/**
 * 打开模型下拉。返回关闭函数。
 *
 * 纯 DOM（不用 Lit）：这里没有响应式状态要维护，而 Lit 的装饰器要给本项目再配一套
 * 编译开关。pi-web-ui 自己的组件照旧是 Lit，互不影响。
 */
export function openModelPicker(options: ModelPickerOptions): () => void {
  activePicker?.();

  const scoped =
    options.scopedModelIds !== null && options.scopedModelIds.length > 0
      ? scopedKeys(options.scopedModelIds)
      : null;

  // 当前模型不在目录里（换过模型 / 目录降级）时也让它看得见、也能选回自己。
  const all: WebModelRef[] = [...options.models];
  if (options.current !== null && !all.some((model) => isCurrent(model, options.current))) {
    all.unshift({
      provider: options.current.provider,
      id: options.current.id,
      name: options.current.id,
      reasoning: false,
    });
  }

  let query = '';
  let onlyScoped = scoped !== null;
  let selected = 0;

  const popover = document.createElement('div');
  popover.className = 'ela-select-popover';

  const search = document.createElement('input');
  search.className = 'ela-select-search';
  search.type = 'text';
  search.placeholder = '搜索模型（id / 名字 / provider）…';
  search.spellcheck = false;

  const list = document.createElement('ul');
  list.className = 'ela-select-list';

  const foot = document.createElement('div');
  foot.className = 'ela-select-foot';

  let scopeBox: HTMLInputElement | null = null;
  if (scoped !== null) {
    const label = document.createElement('label');
    label.className = 'ela-select-scope';
    scopeBox = document.createElement('input');
    scopeBox.type = 'checkbox';
    scopeBox.checked = onlyScoped;
    // 计数用**原始条目数**，不用 `scoped.size` —— 带级别后缀的那条会展开成两个 key，
    // 拿它当计数会显示「只看已启用（2）」而 `settings.json` 里只有一条。
    label.append(
      scopeBox,
      document.createTextNode(` 只看已启用（${options.scopedModelIds?.length ?? 0}）`),
    );
    scopeBox.addEventListener('change', () => {
      onlyScoped = scopeBox?.checked === true;
      selected = 0;
      render();
    });
    foot.append(label);
  }
  const hint = document.createElement('span');
  hint.className = 'ela-select-hint';
  hint.textContent = scoped === null ? '↑↓ · Enter · Esc' : '↑↓ · Enter · Tab all/scoped · Esc';
  foot.append(hint);

  popover.append(search, list, foot);
  document.body.append(popover);

  /** 当前筛选结果：按 provider 归堆（保持服务端给的顺序，不重排）。 */
  function visibleGroups(): [provider: string, models: WebModelRef[]][] {
    const needle = query.trim().toLowerCase();
    const groups = new Map<string, WebModelRef[]>();
    for (const model of all) {
      if (onlyScoped && scoped !== null && !scoped.has(`${model.provider}/${model.id}`)) continue;
      if (needle !== '') {
        const hit =
          model.id.toLowerCase().includes(needle) ||
          model.name.toLowerCase().includes(needle) ||
          model.provider.toLowerCase().includes(needle);
        if (!hit) continue;
      }
      const group = groups.get(model.provider);
      if (group === undefined) groups.set(model.provider, [model]);
      else group.push(model);
    }
    return [...groups];
  }

  function visibleModels(groups: [string, WebModelRef[]][]): WebModelRef[] {
    return groups.flatMap(([, models]) => models);
  }

  function render(): void {
    const groups = visibleGroups();
    const models = visibleModels(groups);
    if (selected >= models.length) selected = models.length === 0 ? 0 : models.length - 1;
    list.replaceChildren();
    if (models.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'ela-select-empty';
      empty.textContent = all.length === 0 ? '内核没有列出任何模型（provider 装配降级了？）' : '没有匹配的模型';
      list.append(empty);
      return;
    }

    let index = 0;
    for (const [provider, group] of groups) {
      const header = document.createElement('li');
      header.className = 'ela-select-group';
      header.textContent = provider;
      list.append(header);
      for (const model of group) {
        const at = index;
        index += 1;
        const item = document.createElement('li');
        const classes = ['ela-select-item'];
        if (at === selected) classes.push('is-selected');
        if (isCurrent(model, options.current)) classes.push('is-current');
        item.className = classes.join(' ');

        const check = document.createElement('span');
        check.className = 'ela-select-check';
        check.textContent = isCurrent(model, options.current) ? '✓' : '';

        const names = document.createElement('span');
        names.className = 'ela-select-names';
        if (model.name !== model.id) {
          const name = document.createElement('span');
          name.className = 'ela-select-name';
          name.textContent = model.name;
          const id = document.createElement('span');
          id.className = 'ela-select-id';
          id.textContent = model.id;
          names.append(name, id);
        } else {
          const name = document.createElement('span');
          name.className = 'ela-select-name is-mono';
          name.textContent = model.id;
          names.append(name);
        }

        item.append(check, names);
        item.addEventListener('mousedown', (event) => {
          event.preventDefault();
          selected = at;
          choose(model);
        });
        item.addEventListener('mousemove', () => {
          if (selected !== at) {
            selected = at;
            render();
          }
        });
        list.append(item);
      }
    }
    list.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
  }

  function choose(model: WebModelRef): void {
    close(false);
    options.onSelect(model);
    const textarea = options.anchor?.closest('message-editor')?.querySelector('textarea');
    textarea?.focus();
  }

  function place(): void {
    const margin = 8;
    const width = Math.min(360, window.innerWidth - margin * 2);
    popover.style.width = `${width}px`;

    const anchor = options.anchor;
    if (anchor === null || anchor === undefined || !anchor.isConnected) {
      popover.style.left = `${Math.round((window.innerWidth - width) / 2)}px`;
      popover.style.top = 'auto';
      popover.style.bottom = '96px';
      popover.style.maxHeight = 'min(60vh, 440px)';
      return;
    }

    const rect = anchor.getBoundingClientRect();
    const spaceAbove = rect.top - margin;
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const up = spaceAbove >= 240 || spaceAbove >= spaceBelow;
    const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin));
    popover.style.left = `${Math.round(left)}px`;
    popover.style.maxHeight = `${Math.round(Math.max(180, Math.min(up ? spaceAbove : spaceBelow, 440)))}px`;
    if (up) {
      popover.style.top = 'auto';
      popover.style.bottom = `${Math.round(window.innerHeight - rect.top + 6)}px`;
    } else {
      popover.style.top = `${Math.round(rect.bottom + 6)}px`;
      popover.style.bottom = 'auto';
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === 'Tab' && scoped !== null) {
      event.preventDefault();
      onlyScoped = !onlyScoped;
      if (scopeBox !== null) scopeBox.checked = onlyScoped;
      selected = 0;
      render();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const models = visibleModels(visibleGroups());
      if (models.length === 0) return;
      selected =
        event.key === 'ArrowDown'
          ? (selected + 1) % models.length
          : (selected - 1 + models.length) % models.length;
      render();
      return;
    }
    if (event.key === 'Enter') {
      const model = visibleModels(visibleGroups())[selected];
      if (model !== undefined) {
        event.preventDefault();
        choose(model);
      }
    }
  }

  function onPointerDown(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (popover.contains(target)) return;
    if (options.anchor?.contains(target) === true) return;
    close(false);
  }

  function onWindowChange(): void {
    close(false);
  }

  function onScroll(event: Event): void {
    const target = event.target;
    if (target instanceof Node && popover.contains(target)) return;
    close(false);
  }

  let closed = false;
  function close(restoreFocus: boolean): void {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('mousedown', onPointerDown, true);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onWindowChange);
    popover.remove();
    if (activePicker === closeRef) activePicker = null;
    if (restoreFocus) options.anchor?.focus();
  }

  const closeRef = (): void => close(true);
  activePicker = closeRef;

  search.addEventListener('input', () => {
    query = search.value;
    selected = 0;
    render();
  });

  // 打开时把选中项落在**当前模型**上，并滚到它 —— 目录有 500+ 条，不这么做每次都要找。
  const initial = visibleModels(visibleGroups());
  const currentIndex = initial.findIndex((model) => isCurrent(model, options.current));
  selected = currentIndex === -1 ? 0 : currentIndex;

  place();
  render();
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('mousedown', onPointerDown, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onWindowChange);
  search.focus();

  return closeRef;
}
