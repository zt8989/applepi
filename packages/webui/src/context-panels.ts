/**
 * 顶栏那三个入口：**完整历史** / **系统** / **工具**。
 *
 * ## 它们回答的是同一个问题
 *
 * 「模型这一轮到底收到了什么」—— 照 Pi Web（github.com/agegr/pi-web）顶栏那三个按钮
 * 的做法搬过来：
 *
 *   - **完整历史**：整段会话记录（含被 `/compact` 压掉、内存里已经没有的早期消息），
 *     服务端渲染成一页，新标签页打开（见 `@ela/tui` 的 `web/history.ts`）；
 *   - **系统**：模型实际收到的那段 system prompt；
 *   - **工具**：模型看到的工具定义（名字 / 描述 / 参数的 JSON Schema）。
 *
 * ## 为什么是「顶栏下面盖一层」而不是弹窗、也不是内联展开
 *
 * 这些内容要能**边看边对着聊天记录**：提示词里写了什么、模型刚才为什么那么干 —— 居中
 * 的模态框一盖就看不见对话了。而**内联展开会把对话与 composer 顶下去**（读一句话就要
 * 重新找位置）。所以与 Pi Web 同形：点一下在顶栏下面**浮**出一块（绝对定位、自己滚、
 * 高度封顶），再点收起，点另一个直接换内容，点面板外面也收起。
 *
 * ## 数据一律现取，不缓存
 *
 * 三个面板都在**打开的那一刻**问服务端（`/api/*`）。缓存一份的坏处很具体：TUI 那边
 * 换了模型 / 改了工具开关，浏览器里还显示着旧的那份 —— 而这两个面板的整个意义就是
 * 「现在这一轮发给模型的是什么」。
 */

import type { WebSystemPromptInfo, WebToolDefinitionInfo } from '@ela/core/web-protocol';
import { elaApi } from './api';

/** 能展开的面板（`完整历史` 不在其中：它开新标签页）。 */
type PanelKind = 'system' | 'tools';

export interface ContextPanelsOptions {
  /** 放按钮的容器（顶栏里）。 */
  actionsHost: HTMLElement;
  /** 放面板的容器（顶栏下面，聊天区上面）。 */
  panelHost: HTMLElement;
  /** 出错时往提示行写一句（面板里也会写，但提示行更容易被看见）。 */
  notice: (text: string, tone?: 'info' | 'warn' | 'error') => void;
  /**
   * 当前会话 id —— 只给「完整历史」那个链接用。
   *
   * 为什么不省掉（服务端不带 `sessionId` 时默认就是当前会话）：这一页在**新标签页**
   * 里加载，与点击之间隔了一次导航。中间要是 TUI 那边换了会话（`/resume`、`/new`），
   * 不带 id 的链接打开的会是**另一个**会话 —— 点的是这段历史，看到的却是别处的。
   */
  sessionId?: (() => string) | undefined;
}

/** 顶栏按钮的三个图标（与 Pi Web 同形的线条图标）。 */
const ICONS: Record<PanelKind | 'history', string> = {
  history:
    '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  system:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>',
  tools:
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>',
};

function buttonHtml(kind: PanelKind | 'history', label: string, title: string): string {
  return (
    `<button type="button" class="ela-top-btn" data-ela-panel="${kind}" aria-pressed="false" title="${title}">` +
    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[kind]}</svg>` +
    `<span>${label}</span></button>`
  );
}

function div(className?: string): HTMLDivElement {
  const element = document.createElement('div');
  if (className !== undefined) element.className = className;
  return element;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** 工具参数表里的一行。 */
export interface ToolParameterField {
  name: string;
  /** 归一后的类型名（`string` / `string | number` / `string[]` …）。 */
  type: string;
  description?: string | undefined;
  required: boolean;
  /** `enum` 里的可选值，拼成一行。 */
  allowedValues?: string | undefined;
  defaultValue?: string | undefined;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** JSON Schema 的类型名（`anyOf` / `oneOf` 合成联合类型，`array` 带上方括号）。 */
function schemaType(schema: Record<string, unknown>): string {
  const variants = Array.isArray(schema['anyOf'])
    ? schema['anyOf']
    : Array.isArray(schema['oneOf'])
      ? schema['oneOf']
      : null;
  if (variants !== null) {
    const types = variants
      .map((variant) => schemaType(asRecord(variant) ?? {}))
      .filter((value, index, values) => values.indexOf(value) === index);
    return types.length > 0 ? types.join(' | ') : 'unknown';
  }

  if (schema['const'] !== undefined) return formatValue(schema['const']);

  const raw = schema['type'];
  const type = Array.isArray(raw)
    ? raw.filter(isString).join(' | ')
    : typeof raw === 'string'
      ? raw
      : typeof schema['$ref'] === 'string'
        ? (schema['$ref'].split('/').pop() ?? 'object')
        : 'unknown';

  if (type === 'array') {
    const items = asRecord(schema['items']);
    return `${items === null ? 'unknown' : schemaType(items)}[]`;
  }
  return type;
}

/**
 * 把一份 JSON Schema 摊成参数表（工具面板右侧那一段）。
 *
 * 纯函数，不认识的结构一律降级成 `unknown` 而不是抛 —— 工具的 schema 来自扩展
 * （typebox / zod 各种写法都有），一个解析不出来不该让整个面板空白。
 */
export function toolParameterFields(parameters: unknown): ToolParameterField[] {
  const record = asRecord(parameters);
  const properties = record === null ? null : asRecord(record['properties']);
  if (record === null || properties === null) return [];
  const requiredRaw = record['required'];
  const required = new Set(
    Array.isArray(requiredRaw) ? requiredRaw.filter(isString) : [],
  );
  return Object.entries(properties).map(([name, value]) => {
    const schema = asRecord(value) ?? {};
    const enumValues = Array.isArray(schema['enum']) ? schema['enum'].map(formatValue).join(', ') : undefined;
    return {
      name,
      type: schemaType(schema),
      ...(typeof schema['description'] === 'string' ? { description: schema['description'] } : {}),
      required: required.has(name),
      ...(enumValues !== undefined ? { allowedValues: enumValues } : {}),
      ...(schema['default'] !== undefined ? { defaultValue: formatValue(schema['default']) } : {}),
    };
  });
}

/** 面板外壳：一块能自己滚的区域。 */
function panelShell(ariaLabel: string): HTMLDivElement {
  const panel = div('ela-panel');
  panel.setAttribute('aria-label', ariaLabel);
  return panel;
}

function emptyBox(text: string): HTMLDivElement {
  const box = div('ela-panel-empty');
  box.textContent = text;
  return box;
}

/** 「系统」面板：整段提示词。 */
function renderSystemPanel(info: WebSystemPromptInfo): HTMLDivElement {
  const panel = panelShell('系统提示词');
  const scroll = div('ela-panel-scroll');
  if (info.text === '') {
    scroll.append(emptyBox('系统提示词为空（工具已禁用）'));
  } else {
    const pre = document.createElement('pre');
    pre.className = 'ela-panel-text';
    pre.textContent = info.text;
    scroll.append(pre);
  }
  panel.append(scroll);
  return panel;
}

/** 工具详情里的一小节。 */
function toolSection(label: string, trailing: string): { section: HTMLDivElement; body: HTMLDivElement } {
  const section = div('ela-tool-section');
  const head = div('ela-tool-section-label');
  const name = document.createElement('span');
  name.textContent = label;
  head.append(name);
  if (trailing !== '') {
    const extra = document.createElement('span');
    extra.textContent = trailing;
    head.append(extra);
  }
  const body = div('ela-tool-section-body');
  section.append(head, body);
  return { section, body };
}

function renderToolDetail(tool: WebToolDefinitionInfo): HTMLElement {
  const detail = document.createElement('section');
  detail.className = 'ela-tool-detail';
  const scroll = div('ela-panel-scroll');

  if (tool.description !== '') {
    const description = toolSection('描述', '');
    const text = div('ela-tool-description');
    text.textContent = tool.description;
    description.body.append(text);
    scroll.append(description.section);
  }

  const fields = toolParameterFields(tool.parameters);
  const parameters = toolSection('参数', `${fields.length} 个参数`);
  if (fields.length === 0) {
    parameters.body.append(emptyBox('无参数'));
  } else {
    const list = div('ela-tool-fields');
    for (const field of fields) {
      const row = div('ela-tool-field');
      const nameCell = div('ela-tool-field-name');
      const code = document.createElement('code');
      code.textContent = field.name;
      const badge = document.createElement('span');
      badge.className = field.required ? 'required' : '';
      badge.textContent = field.required ? '必填' : '可选';
      nameCell.append(code, badge);

      const valueCell = div('ela-tool-field-value');
      const type = document.createElement('code');
      type.className = 'ela-tool-type';
      type.textContent = field.type;
      valueCell.append(type);
      if (field.description !== undefined) {
        const text = div();
        text.textContent = field.description;
        valueCell.append(text);
      }
      if (field.allowedValues !== undefined) {
        const meta = div('ela-tool-meta');
        meta.textContent = `可选值：${field.allowedValues}`;
        valueCell.append(meta);
      }
      if (field.defaultValue !== undefined) {
        const meta = div('ela-tool-meta');
        meta.textContent = `默认值：${field.defaultValue}`;
        valueCell.append(meta);
      }

      row.append(nameCell, valueCell);
      list.append(row);
    }
    parameters.body.append(list);
  }
  scroll.append(parameters.section);
  detail.append(scroll);
  return detail;
}

/** 「工具」面板：左列表 + 右详情（与 Pi Web 同形）。 */
function renderToolsPanel(tools: readonly WebToolDefinitionInfo[]): HTMLDivElement {
  const panel = panelShell('工具定义');
  panel.classList.add('ela-panel-tools');
  // 左列表。语义上的导航靠 `panelShell()` 给的那句 `aria-label` —— 这里不再套一层
  // `<nav>`：那个元素在 TS 的 DOM 类型下与 `append` 的参数类型对不上，得不偿失。
  const list = div('ela-tools-list');

  if (tools.length === 0) {
    list.append(emptyBox('没有启用的工具'));
    panel.append(list, emptyBox('没有启用的工具'));
    return panel;
  }

  const detailHost = div('ela-tools-detail');
  let selected = tools[0]!.name;
  const draw = (): void => {
    list.replaceChildren();
    for (const tool of tools) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `ela-tools-item${tool.name === selected ? ' selected' : ''}`;
      item.setAttribute('aria-pressed', tool.name === selected ? 'true' : 'false');
      const code = document.createElement('code');
      code.textContent = tool.name;
      item.append(code);
      item.addEventListener('click', () => {
        selected = tool.name;
        draw();
      });
      list.append(item);
    }
    const tool = tools.find((candidate) => candidate.name === selected) ?? tools[0]!;
    detailHost.replaceChildren(renderToolDetail(tool));
  };
  draw();
  panel.append(list, detailHost);
  return panel;
}

/**
 * 装上三个按钮与它们的面板。
 *
 * 只在第一次调用时挂按钮；之后由内部状态决定面板开关。
 */
export function installContextPanels(options: ContextPanelsOptions): void {
  const { actionsHost, panelHost } = options;
  actionsHost.innerHTML =
    buttonHtml('history', '完整历史', '打开这次会话的完整记录（含被压缩掉的早期消息）') +
    buttonHtml('system', '系统', '模型实际收到的系统提示词') +
    buttonHtml('tools', '工具', '模型看到的工具定义');

  panelHost.hidden = true;
  let open: PanelKind | null = null;
  /** 每次打开都换一个 token：慢的那次回来时若已经切走，就别再往 DOM 里塞。 */
  let token = 0;

  const setPressed = (kind: PanelKind, pressed: boolean): void => {
    const button = actionsHost.querySelector(`[data-ela-panel="${kind}"]`);
    button?.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  };

  /**
   * 面板是**叠加层**（`.ela-panel-host` 绝对定位在顶栏下面）：展开不改变对话区与
   * composer 的布局，只是盖在它们上面 —— 与 Pi Web 的顶栏面板同一手法。
   */
  const close = (): void => {
    if (open !== null) setPressed(open, false);
    open = null;
    token += 1;
    panelHost.replaceChildren();
    panelHost.hidden = true;
  };

  const show = (kind: PanelKind, content: HTMLElement): void => {
    panelHost.replaceChildren(content);
    panelHost.hidden = false;
  };

  const openPanel = async (kind: PanelKind): Promise<void> => {
    if (open === kind) {
      close();
      return;
    }
    if (open !== null) setPressed(open, false);
    open = kind;
    setPressed(kind, true);
    token += 1;
    const mine = token;

    show(kind, (() => {
      const loading = panelShell(kind === 'system' ? '系统提示词' : '工具定义');
      const scroll = div('ela-panel-scroll');
      scroll.append(emptyBox(kind === 'system' ? '正在加载系统提示词…' : '正在加载工具定义…'));
      loading.append(scroll);
      return loading;
    })());

    try {
      if (kind === 'system') {
        const info = await elaApi.systemPrompt();
        if (mine !== token) return;
        show(kind, renderSystemPanel(info));
        return;
      }
      const tools = await elaApi.tools();
      if (mine !== token) return;
      show(kind, renderToolsPanel(tools));
    } catch (error) {
      if (mine !== token) return;
      const message = error instanceof Error ? error.message : String(error);
      options.notice(`拿不到${kind === 'system' ? '系统提示词' : '工具定义'}：${message}`, 'warn');
      const failed = panelShell(kind === 'system' ? '系统提示词' : '工具定义');
      const scroll = div('ela-panel-scroll');
      scroll.append(emptyBox(`拿不到${kind === 'system' ? '系统提示词' : '工具定义'}：${message}`));
      failed.append(scroll);
      show(kind, failed);
    }
  };

  actionsHost.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement | null)?.closest('[data-ela-panel]');
    if (!(button instanceof HTMLElement)) return;
    const kind = button.dataset['elaPanel'];
    if (kind === 'history') {
      // 完整历史是**服务端渲染的一页**：新标签页打开，好让它能自己滚、能 Ctrl-F、
      // 能打印 —— 也能和当前的聊天界面并排看。
      //
      // 带上 `sessionId`：这一页在导航之后才加载，中间换了会话就不该跟着变（见
      // `ContextPanelsOptions.sessionId`）。
      const id = options.sessionId?.() ?? '';
      const url = id === '' ? '/api/history' : `/api/history?sessionId=${encodeURIComponent(id)}`;
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (kind === 'system' || kind === 'tools') void openPanel(kind);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || open === null) return;
    // 模态框（`modal.ts`）自己也认 Escape，且它是最上面那一层 —— 别抢它的事。
    if (document.querySelector('.ela-modal-backdrop') !== null) return;
    close();
  });

  // 点面板外面收起（它是一层浮在上面的东西，点穿过去就等于认了它「弹出来」的语义）。
  // 点在面板里或那两个按钮上不算：按钮自己要切面板（点同一个就是收起）。
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (open === null) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelHost.contains(target)) return;
      if (actionsHost.contains(target)) return;
      close();
    },
    true,
  );
}
