/**
 * 输入框的 `/` 补全层。
 *
 * ## 为什么要「挂」在别人的组件上
 *
 * 输入框是 pi-web-ui 的 `<agent-interface>` 内部渲染的（light DOM 里一个普通
 * `<textarea placeholder="Type a message...">`）。它不提供命令补全的口子，也不该
 * 为了这个去改它（那是上游组件，改了下次升级就撞）。
 *
 * 所以：找到那个 textarea，在它**上方**absolutely 定位自己的一层浮层，监听它的
 * `input` / `keydown`。弹出与否、选中哪一项都是我们自己的状态 —— 对 pi-web-ui 而言
 * 什么都没发生，它照常收 `input` 事件。
 *
 * ## 键盘的归属
 *
 * 浮层打开时我们要**抢**上下键、Tab、回车、Esc —— 这些本来该由组件处理（尤其回车是
 * 「发送」）。所以监听挂在 textarea 上并 `capture: true` + `stopPropagation`，
 * 只在自己打开时抢，关着的时候一律放行。
 */
import { matchCommands, type WebCommand } from './commands';

const MAX_VISIBLE = 6;

export interface ComposerMenuOptions {
  /** 从哪个元素找输入框（找不到就一直等）。 */
  root?: ParentNode | undefined;
  /** 被选中时回调（命令名）。 */
  onPick(command: WebCommand): void;
}

export interface ComposerMenu {
  /** 手动隐藏（比如命令执行完了）。 */
  hide(): void;
  dispose(): void;
}

/** 找 pi-web-ui 那个输入用 textarea。 */
function findTextarea(root: ParentNode): HTMLTextAreaElement | null {
  // 用 placeholder 定位最稳：class 是 tailwind 的长串，会随上游改。
  const candidates = root.querySelectorAll('textarea');
  for (const el of candidates) {
    const placeholder = el.getAttribute('placeholder') ?? '';
    if (/type a message|输入/i.test(placeholder)) return el as HTMLTextAreaElement;
  }
  return candidates[0] as HTMLTextAreaElement | undefined ?? null;
}

export function attachComposerMenu(options: ComposerMenuOptions = { onPick: () => undefined }): ComposerMenu {
  const root = options.root ?? document;
  let textarea: HTMLTextAreaElement | null = null;
  let menu: HTMLDivElement | null = null;
  let items: WebCommand[] = [];
  let selected = 0;
  let open = false;
  let disposed = false;

  const ensureMenu = (): HTMLDivElement => {
    if (menu) return menu;
    const el = document.createElement('div');
    el.className =
      'fixed z-50 hidden rounded-lg border border-border bg-background text-foreground shadow-lg overflow-hidden text-sm';
    el.setAttribute('role', 'listbox');
    // 别让浮层抢焦点（否则 textarea 失焦，继续打字会断）。
    el.addEventListener('mousedown', (event) => event.preventDefault());
    document.body.appendChild(el);
    menu = el;
    return el;
  };

  const render = (): void => {
    const el = ensureMenu();
    if (!open || items.length === 0) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    el.innerHTML = items
      .map((c, index) => {
        const active = index === selected;
        const cls = active ? 'bg-secondary' : '';
        return `<div data-index="${index}" class="px-3 py-1.5 cursor-pointer ${cls}">
          <span class="font-medium">/${escapeHtml(c.name)}</span>
          <span class="text-muted-foreground ml-3">${escapeHtml(c.description)}</span>
        </div>`;
      })
      .join('');
  };

  /** 把浮层放到 textarea 上方（底部对齐输入框顶部）。 */
  const position = (): void => {
    if (!textarea || !menu) return;
    const rect = textarea.getBoundingClientRect();
    const width = Math.min(560, Math.max(320, rect.width));
    menu.style.left = `${Math.max(8, rect.left)}px`;
    menu.style.width = `${width}px`;
    // 先放下方，装不下再翻到上方。
    menu.style.top = '0px';
    const height = menu.offsetHeight || 0;
    const below = rect.bottom + 6;
    const fitsBelow = below + height < window.innerHeight;
    menu.style.top = `${fitsBelow ? below : Math.max(8, rect.top - height - 6)}px`;
  };

  const close = (): void => {
    if (!open) return;
    open = false;
    selected = 0;
    if (menu) menu.classList.add('hidden');
  };

  const update = (): void => {
    if (!textarea) return;
    const value = textarea.value;
    // 只在**整条输入以 `/` 开头**且还没打空格（还没进参数）时弹。
    const isCommandLike = /^\/[^\s]*$/.test(value.trimStart());
    if (!isCommandLike) {
      close();
      return;
    }
    const prefix = value.trimStart();
    const matched = matchCommands(prefix);
    if (matched.length === 0) {
      close();
      return;
    }
    items = matched.slice(0, MAX_VISIBLE);
    if (selected >= items.length) selected = 0;
    open = true;
    render();
    position();
  };

  const pick = (index: number): void => {
    const command = items[index];
    if (!command || !textarea) return;
    close();
    // 清空输入框：命令不是「发给模型的话」。
    textarea.value = '';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    options.onPick(command);
  };

  const onInput = (): void => update();

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!open || items.length === 0) return;
    switch (event.key) {
      case 'ArrowDown':
        selected = (selected + 1) % items.length;
        render();
        break;
      case 'ArrowUp':
        selected = (selected - 1 + items.length) % items.length;
        render();
        break;
      case 'Tab':
      case 'Enter':
        pick(selected);
        break;
      case 'Escape':
        close();
        break;
      default:
        return; // 其他键放行
    }
    // 抢下来的键不能让组件也看见（回车会被当成「发送」）。
    event.preventDefault();
    event.stopPropagation();
  };

  const onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    const index = target?.closest('[data-index]')?.getAttribute('data-index');
    if (index !== null && index !== undefined) pick(Number(index));
  };

  const onScrollOrResize = (): void => {
    if (open) position();
  };

  // 输入框是异步渲染出来的（pi-web-ui 升级自定义元素之后），所以要等它出现。
  const attach = (): boolean => {
    if (disposed) return true;
    const found = findTextarea(root);
    if (!found) return false;
    if (textarea === found) return true;
    // 换了个 textarea（组件重渲染会换）：把旧的摘掉。
    if (textarea) {
      textarea.removeEventListener('input', onInput);
      textarea.removeEventListener('keydown', onKeyDown, true);
    }
    textarea = found;
    textarea.addEventListener('input', onInput);
    // capture：要赶在组件的 keydown 处理之前拦下回车。
    textarea.addEventListener('keydown', onKeyDown, true);
    return true;
  };

  attach();
  const timer = window.setInterval(() => {
    if (attach()) window.clearInterval(timer);
  }, 200);
  document.addEventListener('click', onClick);
  window.addEventListener('resize', onScrollOrResize);
  window.addEventListener('scroll', onScrollOrResize, true);

  return {
    hide: close,
    dispose(): void {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('click', onClick);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
      if (textarea) {
        textarea.removeEventListener('input', onInput);
        textarea.removeEventListener('keydown', onKeyDown, true);
      }
      menu?.remove();
      menu = null;
    },
  };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
