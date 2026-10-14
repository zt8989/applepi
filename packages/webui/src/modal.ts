/**
 * 一个通用的模态框：**只读文本**（`/help` `/skills`）或**可选项列表**
 * （`/thinking` `/settings` `/scoped-models`）。
 *
 * 复用 `model-picker.ts` 那套 `ela-modal-*` 样式（同一个外观），键盘口径也一致：
 * ↑↓ 选 · Enter 确认 · Esc 取消。点击也认。
 *
 * 为什么不抽成一个「组件框架」：这里只有两种内容（纯文本 / 一行一项），而选项列表
 * 的每项行为差别很大（单选、勾选、切换后原地重画）。所以模态只负责**画与导航**，
 * 点下去做什么由调用方给 `onPick`；要改行就再 `setRows()`。
 */

export interface ModalRow {
  label: string;
  /** 右侧的淡字（描述、当前值…）。 */
  hint?: string | undefined;
  /** 左侧的标记（`✓` / 空格）；不选填。 */
  mark?: string | undefined;
  /** 高亮成「当前项」。 */
  active?: boolean | undefined;
  /** 点它 / 回车。不给 = 这一行只是文本（不参与键盘选择）。 */
  onPick?: (() => void) | undefined;
}

export interface ModalHandle {
  close(): void;
  /** 换掉行（单选勾选那种「原地重画」）。 */
  setRows(rows: readonly ModalRow[]): void;
  /** 显示纯文本（显了它就没有列表）。 */
  setText(text: string): void;
  /** 底部提示行。 */
  setFooter(text: string): void;
}

export interface ModalOptions {
  title: string;
  /** 搜索框的 placeholder；不给就没有搜索框。 */
  searchPlaceholder?: string | undefined;
  onSearch?: ((query: string) => void) | undefined;
  footer?: string | undefined;
}

/**
 * 打开的模态框（后开的在上）。
 *
 * 键盘监听挂在 `document` 的捕获阶段 —— 不记一份栈的话，叠起来的两个模态
 * （`/settings` → 选默认思考级别）会被一次 Esc 一起关掉。
 */
const openModals: { token: symbol; close: () => void }[] = [];

/** 只有**最上面**那个模态响应键盘 / 点背景关闭。 */
function isTopMost(token: symbol): boolean {
  return openModals[openModals.length - 1]?.token === token;
}

export function openModal(options: ModalOptions): ModalHandle {
  const token = Symbol('ela-modal');
  const backdrop = document.createElement('div');
  backdrop.className = 'ela-modal-backdrop';
  const panel = document.createElement('div');
  panel.className = 'ela-modal';
  backdrop.append(panel);

  const title = document.createElement('div');
  title.className = 'ela-modal-title';
  title.textContent = options.title;
  panel.append(title);

  let search: HTMLInputElement | undefined;
  if (options.searchPlaceholder !== undefined) {
    search = document.createElement('input');
    search.className = 'ela-modal-search';
    search.type = 'text';
    search.placeholder = options.searchPlaceholder;
    search.spellcheck = false;
    panel.append(search);
  }

  const list = document.createElement('ul');
  list.className = 'ela-modal-list';
  const pre = document.createElement('pre');
  pre.className = 'ela-modal-pre';
  pre.hidden = true;
  panel.append(list, pre);

  const footer = document.createElement('div');
  footer.className = 'ela-modal-hint';
  footer.textContent = options.footer ?? '↑↓ 选择 · Enter 确认 · Esc 取消';
  panel.append(footer);

  let rows: ModalRow[] = [];
  /** 当前高亮的**可选项**在 `rows` 里的下标（-1 = 没有可选项）。 */
  let selected = -1;

  /** 只在「可选项」之间移动。 */
  function pickable(): number[] {
    const out: number[] = [];
    rows.forEach((row, index) => {
      if (row.onPick !== undefined) out.push(index);
    });
    return out;
  }

  function move(delta: number): void {
    const indices = pickable();
    if (indices.length === 0) return;
    const at = indices.indexOf(selected);
    const next = at === -1 ? (delta > 0 ? 0 : indices.length - 1) : (at + delta + indices.length) % indices.length;
    selected = indices[next] ?? -1;
    render();
  }

  function render(): void {
    list.replaceChildren();
    if (rows.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'ela-modal-empty';
      empty.textContent = '（空）';
      list.append(empty);
      return;
    }
    rows.forEach((row, index) => {
      const item = document.createElement('li');
      const classes = ['ela-modal-item'];
      if (row.active === true) classes.push('is-current');
      if (index === selected) classes.push('is-selected');
      item.className = classes.join(' ');
      if (row.mark !== undefined) {
        const mark = document.createElement('span');
        mark.className = 'ela-modal-check';
        mark.textContent = row.mark;
        item.append(mark);
      }
      const label = document.createElement('span');
      label.className = 'ela-modal-model';
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
        item.addEventListener('mousedown', (event) => {
          event.preventDefault();
          selected = index;
          onPick();
        });
        item.addEventListener('mousemove', () => {
          if (selected !== index) {
            selected = index;
            render();
          }
        });
      }
      list.append(item);
    });
    list.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!isTopMost(token)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
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

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown, true);
    const at = openModals.findIndex((entry) => entry.token === token);
    if (at >= 0) openModals.splice(at, 1);
    backdrop.remove();
  }

  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop && isTopMost(token)) close();
  });
  openModals.push({ token, close });
  search?.addEventListener('input', () => options.onSearch?.(search?.value ?? ''));
  document.addEventListener('keydown', onKeyDown, true);

  render();
  document.body.append(backdrop);
  search?.focus();

  return {
    close,
    setRows(next) {
      rows = [...next];
      if (!pickable().includes(selected)) selected = pickable()[0] ?? -1;
      pre.hidden = true;
      list.hidden = false;
      render();
    },
    setText(text) {
      pre.textContent = text;
      pre.hidden = false;
      list.hidden = true;
      rows = [];
      selected = -1;
    },
    setFooter(text) {
      footer.textContent = text;
    },
  };
}
