/**
 * 输入框以 `/` 开头时的**命令补全下拉**。
 *
 * 命令表由服务端给（`GET /api/commands`，与 TUI 的补全同一份）。这里只做
 * 「输入 → 过滤 → 补全」：真正的执行在 `commands.ts` + HTTP 接口。
 *
 * ## 为什么用事件代理，而不是包一层自己的输入组件
 *
 * 输入框是 pi-web-ui 的 `MessageEditor` 里的 `<textarea>`（我们不改它）。所以挂
 * `document` 上的 `input` / `keydown`（捕获阶段）就够了 —— 补全下拉是**附在它旁边**
 * 的一个浮层，回车补全时 `preventDefault()` 挡下发送。
 *
 * ## 键盘口径（与 TUI 的补全对齐）
 *
 *   ↑↓ 选择 · Tab 或 Enter 补全 · Esc 关掉
 *
 * 特例：输入**已经是一个完整命令名**（`/help`）时，Enter 不再补全、直接发出去执行
 * —— 否则每个命令都要按两次回车。
 */

import type { WebCommandInfo } from '@ela/core/web-protocol';

/** 输入框里「还是一个命令词」时的样子：`/` 开头、后面没有空白。 */
const TOKEN = /^\/([^\s/]*)$/;

export function installCommandPalette(load: () => Promise<WebCommandInfo[]>): void {
  let commands: WebCommandInfo[] = [];
  let matches: WebCommandInfo[] = [];
  let selected = 0;
  let palette: HTMLElement | undefined;

  /** 只认 pi-web-ui 的那个输入框；别处的 textarea 不管。 */
  function editorFor(target: EventTarget | null): HTMLTextAreaElement | null {
    const element = target as HTMLElement | null;
    if (!(element instanceof HTMLTextAreaElement)) return null;
    return element.closest('message-editor') === null ? null : element;
  }

  function hide(): void {
    palette?.remove();
    palette = undefined;
    matches = [];
    selected = 0;
  }

  /** 过滤：先按前缀，没有前缀命中再按包含（`elp` 也能搜到 `/help`）。 */
  function filter(query: string): WebCommandInfo[] {
    const needle = query.toLowerCase();
    if (needle === '') return commands;
    const prefix = commands.filter((command) => command.name.toLowerCase().startsWith(needle));
    if (prefix.length > 0) return prefix;
    return commands.filter((command) => command.name.toLowerCase().includes(needle));
  }

  function position(editor: HTMLTextAreaElement): void {
    if (palette === undefined) return;
    const rect = editor.getBoundingClientRect();
    palette.style.left = `${Math.round(rect.left)}px`;
    palette.style.width = `${Math.round(rect.width)}px`;
    palette.style.bottom = `${Math.round(window.innerHeight - rect.top + 6)}px`;
  }

  function draw(editor: HTMLTextAreaElement): void {
    const root = palette;
    if (root === undefined) return;
    root.replaceChildren();
    matches.forEach((command, index) => {
      const item = document.createElement('div');
      item.className = index === selected ? 'ela-palette-item is-selected' : 'ela-palette-item';
      const name = document.createElement('span');
      name.className = 'ela-palette-name';
      name.textContent = `/${command.name}`;
      const description = document.createElement('span');
      description.className = 'ela-palette-desc';
      description.textContent = command.description;
      item.append(name, description);
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        complete(editor, command);
      });
      root.append(item);
    });
    root.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
    position(editor);
  }

  /** 把选中的命令补进输入框（留在输入框里，让用户加参数 / 再回车执行）。 */
  function complete(editor: HTMLTextAreaElement, command: WebCommandInfo): void {
    editor.value = `/${command.name} `;
    // 直接改 `.value` 不会触发 lit 的绑定 —— 补一个 input 事件让 MessageEditor 收下。
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    const end = editor.value.length;
    editor.setSelectionRange(end, end);
    editor.focus();
    hide();
  }

  function open(editor: HTMLTextAreaElement, query: string): void {
    const next = filter(query);
    if (next.length === 0) {
      hide();
      return;
    }
    matches = next;
    if (selected >= matches.length) selected = 0;
    if (palette === undefined) {
      palette = document.createElement('div');
      palette.className = 'ela-palette';
      document.body.append(palette);
    }
    draw(editor);
  }

  document.addEventListener(
    'input',
    (event) => {
      const editor = editorFor(event.target);
      if (editor === null) return;
      const match = TOKEN.exec(editor.value);
      if (match === null) {
        hide();
        return;
      }
      selected = 0;
      open(editor, match[1] ?? '');
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (event) => {
      if (palette === undefined) return;
      const editor = editorFor(event.target);
      if (editor === null) {
        hide();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        hide();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (matches.length === 0) return;
        event.preventDefault();
        selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
        draw(editor);
        return;
      }
      if (event.key === 'Tab') {
        const command = matches[selected];
        if (command === undefined) return;
        event.preventDefault();
        complete(editor, command);
        return;
      }
      if (event.key === 'Enter') {
        const token = TOKEN.exec(editor.value)?.[1] ?? '';
        const command = matches[selected];
        // 已经是一个完整命令名 → 让回车发出去执行；否则先补全。
        if (command !== undefined && command.name !== token) {
          event.preventDefault();
          complete(editor, command);
        } else {
          hide();
        }
      }
    },
    true,
  );

  // 命令表是懒加载的：第一次开补全之前拉一次就够（服务端加命令要刷新页面）。
  void load().then((list) => {
    commands = list;
  });
}
