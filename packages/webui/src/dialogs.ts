/**
 * 扩展对话框（`ctx.ui.select` / `confirm` / `input`）在浏览器里的呈现。
 *
 * 与 `modal.ts`（命令面板那种「浏览 / 选择」）分开：这里是**阻塞式提问** —— 必须给出
 * 一个答复或明确取消，答复要回送给服务端（`ui-response`）。
 *
 * 三个函数都返回一个**只拆 DOM、不答题**的 `close()`：换一个请求、或另一端先答了
 * （`ui-cancel`）时用它静默撤掉。答题那条路由 `onAnswer` 走，只会调一次。
 *
 * 样式复用 `model-picker.ts` 那套 `ela-modal-*`。
 */

/** 建一个空壳（背景 + 面板 + 标题 + 底部提示），返回面板与拆台函数。 */
function shell(
  title: string,
  footer: string,
  onEscape: () => void,
): { panel: HTMLDivElement; close: () => void } {
  const backdrop = document.createElement('div');
  backdrop.className = 'ela-modal-backdrop';
  const panel = document.createElement('div');
  panel.className = 'ela-modal';

  const heading = document.createElement('div');
  heading.className = 'ela-modal-title';
  heading.textContent = title;

  const hint = document.createElement('div');
  hint.className = 'ela-modal-hint';
  hint.textContent = footer;

  panel.append(heading, hint);
  backdrop.append(panel);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onEscape();
    }
  };
  document.addEventListener('keydown', onKeyDown, true);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) onEscape();
  });
  document.body.append(backdrop);

  let closed = false;
  return {
    panel,
    close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKeyDown, true);
      backdrop.remove();
    },
  };
}

/** 画一行可选项（`select` / `confirm` 共用）。 */
function row(label: string, selected: boolean): HTMLLIElement {
  const item = document.createElement('li');
  item.className = selected ? 'ela-modal-item is-selected' : 'ela-modal-item';
  const text = document.createElement('span');
  text.className = 'ela-modal-model';
  text.textContent = label;
  item.append(text);
  return item;
}

/** 选项列表对话框（`ctx.ui.select`）。取消给 `undefined`。 */
export function openSelectDialog(options: {
  title: string;
  choices: readonly string[];
  onAnswer: (value: string | undefined) => void;
}): () => void {
  let selected = 0;
  let answered = false;
  const answer = (value: string | undefined): void => {
    if (answered) return;
    answered = true;
    close();
    options.onAnswer(value);
  };
  const box = shell(options.title, '↑↓ 选择 · Enter 确认 · Esc 取消', () => answer(undefined));
  const close = box.close;

  const list = document.createElement('ul');
  list.className = 'ela-modal-list';
  box.panel.insertBefore(list, box.panel.querySelector('.ela-modal-hint'));

  const draw = (): void => {
    list.replaceChildren();
    options.choices.forEach((choice, index) => {
      const item = row(choice, index === selected);
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        answer(choice);
      });
      item.addEventListener('mousemove', () => {
        if (selected !== index) {
          selected = index;
          draw();
        }
      });
      list.append(item);
    });
    list.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
  };

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (options.choices.length === 0) return;
        event.preventDefault();
        selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + options.choices.length) % options.choices.length;
        draw();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        answer(options.choices[selected]);
      }
    },
    true,
  );

  draw();
  return close;
}

/** 是非题（`ctx.ui.confirm`）。取消 = `false`（与官方 `ExtensionUIContext` 同一口径）。 */
export function openConfirmDialog(options: {
  title: string;
  message: string;
  onAnswer: (value: boolean) => void;
}): () => void {
  let answered = false;
  const answer = (value: boolean): void => {
    if (answered) return;
    answered = true;
    close();
    options.onAnswer(value);
  };
  const box = shell(options.title, 'Enter 确认 · Esc 取消', () => answer(false));
  const close = box.close;

  const body = document.createElement('pre');
  body.className = 'ela-modal-pre';
  body.textContent = options.message;
  const list = document.createElement('ul');
  list.className = 'ela-modal-list';
  box.panel.insertBefore(body, box.panel.querySelector('.ela-modal-hint'));
  box.panel.insertBefore(list, box.panel.querySelector('.ela-modal-hint'));

  let selected = 0;
  const choices = ['Yes', 'No'];
  const draw = (): void => {
    list.replaceChildren();
    choices.forEach((choice, index) => {
      const item = row(choice, index === selected);
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        answer(choice === 'Yes');
      });
      list.append(item);
    });
  };
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        selected = (selected + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length;
        draw();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        answer(choices[selected] === 'Yes');
      }
    },
    true,
  );

  draw();
  return close;
}

/** 单行文本输入（`ctx.ui.input`）。取消给 `undefined`。 */
export function openInputDialog(options: {
  title: string;
  placeholder?: string | undefined;
  onAnswer: (value: string | undefined) => void;
}): () => void {
  let answered = false;
  const answer = (value: string | undefined): void => {
    if (answered) return;
    answered = true;
    close();
    options.onAnswer(value);
  };
  const box = shell(options.title, 'Enter 提交 · Esc 取消', () => answer(undefined));
  const close = box.close;

  const input = document.createElement('input');
  input.className = 'ela-modal-search';
  input.type = 'text';
  input.placeholder = options.placeholder ?? '';
  input.spellcheck = false;
  box.panel.insertBefore(input, box.panel.querySelector('.ela-modal-hint'));

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      answer(input.value);
    }
  });

  input.focus();
  return close;
}
