/**
 * 模型选择器（浏览器侧）。
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
 * ## 对齐 TUI 的哪些行为
 *
 * | TUI（`ModelSelectorComponent`） | 这里 |
 * | --- | --- |
 * | 列表 = 已配置 provider 的可用模型 | 同一份（服务端在 `hello` 里给） |
 * | 有作用域时默认 `Scope: scoped` | 有作用域时默认「只看已启用」 |
 * | `tab` 切 all / scoped | `Tab` 同一个意思 |
 * | 当前模型置顶 + 打勾 | 同 |
 * | 搜索按 id / 名字 | 同（外加 provider） |
 *
 * 刻意**没有**做的：`Ctrl+S` 存默认、后台刷新目录、`default` 前缀直达。它们是
 * pi 那套 settings/catalog 的入口，本项目没接（说明写在 `docs/architecture/webui.md`）。
 */

import type { WebModelRef } from '@ela/core/web-protocol';

export interface ModelPickerOptions {
  models: readonly WebModelRef[];
  /** 当前模型（置顶 + 打勾）。拿不到就给 `null`。 */
  current: { provider: string; id: string } | null;
  /** 作用域：`null` = 全开；非空 = 默认只看这些（与 TUI 同一个默认）。 */
  scopedModelIds: readonly string[] | null;
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
 * 开一个模态选择器。返回关闭函数。
 *
 * 纯 DOM（不用 Lit）：这里没有响应式状态要维护，而 Lit 的装饰器要给本项目再配一套
 * 编译开关。pi-web-ui 自己的组件照旧是 Lit，互不影响。
 */
export function openModelPicker(options: ModelPickerOptions): () => void {
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

  const backdrop = document.createElement('div');
  backdrop.className = 'ela-modal-backdrop';
  const panel = document.createElement('div');
  panel.className = 'ela-modal';
  backdrop.append(panel);

  const search = document.createElement('input');
  search.className = 'ela-modal-search';
  search.type = 'text';
  search.placeholder = '搜索模型（id / 名字 / provider）…';
  search.spellcheck = false;

  const scopeLabel = document.createElement('label');
  scopeLabel.className = 'ela-modal-scope';
  const scopeBox = document.createElement('input');
  scopeBox.type = 'checkbox';
  scopeBox.checked = onlyScoped;
  // 计数用**原始条目数**，不用 `scoped.size` —— 带级别后缀的那条会展开成两个 key，
  // 拿它当计数会显示「只看已启用（2）」而 `settings.json` 里只有一条。
  scopeLabel.append(
    scopeBox,
    document.createTextNode(` 只看已启用（${options.scopedModelIds?.length ?? 0}）`),
  );

  const list = document.createElement('ul');
  list.className = 'ela-modal-list';

  const hint = document.createElement('div');
  hint.className = 'ela-modal-hint';
  hint.textContent =
    scoped === null
      ? '↑↓ 选择 · Enter 确认 · Esc 取消'
      : '↑↓ 选择 · Enter 确认 · Tab 切换 all/scoped · Esc 取消';

  panel.append(search, list);
  if (scoped !== null) panel.append(scopeLabel);
  panel.append(hint);

  /** 当前筛选结果（顺序：当前模型置顶，其余按 provider 再 id）。 */
  function visible(): WebModelRef[] {
    const needle = query.trim().toLowerCase();
    const models = all.filter((model) => {
      if (onlyScoped && scoped !== null && !scoped.has(`${model.provider}/${model.id}`)) {
        return false;
      }
      if (needle === '') return true;
      return (
        model.id.toLowerCase().includes(needle) ||
        model.name.toLowerCase().includes(needle) ||
        model.provider.toLowerCase().includes(needle)
      );
    });
    return models.sort((a, b) => {
      const aCurrent = isCurrent(a, options.current) ? 0 : 1;
      const bCurrent = isCurrent(b, options.current) ? 0 : 1;
      if (aCurrent !== bCurrent) return aCurrent - bCurrent;
      if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  function render(): void {
    const models = visible();
    if (selected >= models.length) selected = models.length === 0 ? 0 : models.length - 1;
    list.replaceChildren();
    if (models.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'ela-modal-empty';
      empty.textContent = all.length === 0 ? '内核没有列出任何模型（provider 装配降级了？）' : '没有匹配的模型';
      list.append(empty);
      return;
    }
    models.forEach((model, index) => {
      const item = document.createElement('li');
      item.className = index === selected ? 'ela-modal-item is-selected' : 'ela-modal-item';
      const check = document.createElement('span');
      check.className = 'ela-modal-check';
      check.textContent = isCurrent(model, options.current) ? '✓' : '';
      const id = document.createElement('span');
      id.className = 'ela-modal-model';
      id.textContent = `${model.id} [${model.provider}]`;
      item.append(check, id);
      if (model.name !== model.id) {
        const name = document.createElement('span');
        name.className = 'ela-modal-name';
        name.textContent = model.name;
        item.append(name);
      }
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        selected = index;
        choose(model);
      });
      item.addEventListener('mousemove', () => {
        if (selected !== index) {
          selected = index;
          render();
        }
      });
      list.append(item);
    });
    list.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
  }

  function choose(model: WebModelRef): void {
    close();
    options.onSelect(model);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' || (event.key === 'c' && event.ctrlKey)) {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selected += 1;
      if (selected >= visible().length) selected = 0;
      render();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      selected -= 1;
      if (selected < 0) selected = Math.max(0, visible().length - 1);
      render();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const model = visible()[selected];
      if (model) choose(model);
      return;
    }
    if (event.key === 'Tab' && scoped !== null) {
      event.preventDefault();
      onlyScoped = !onlyScoped;
      scopeBox.checked = onlyScoped;
      selected = 0;
      render();
    }
  }

  search.addEventListener('input', () => {
    query = search.value;
    selected = 0;
    render();
  });
  // 注意：键盘**不在这里**再挂一份 —— `onKeyDown` 挂在 `document` 的捕获阶段上
  // （见文件末尾），它覆盖整个弹窗（含复选框）。再在输入框上挂一次，一次按键会跑两遍：
  // 副作用翻倍的那种当场看得出来（Tab 切两次 = 没切），而 `close()` 那种幂等的则静静重复。
  scopeBox.addEventListener('change', () => {
    onlyScoped = scopeBox.checked;
    selected = 0;
    render();
  });
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown, true);
    backdrop.remove();
  }

  document.addEventListener('keydown', onKeyDown, true);
  render();
  document.body.append(backdrop);
  search.focus();
  return close;
}