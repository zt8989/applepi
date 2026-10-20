/**
 * 工具调用的**折叠行**视图 —— 全部工具共用一套：默认只一行摘要，点开才看内容。
 *
 * ## 为什么是这个形状
 *
 * pi-web-ui 自带的 `ToolMessage` 把工具结果**常展开**铺在卡片里（`DefaultRenderer`
 * 甚至把参数与结果各打一段 JSON）：一轮里十几次工具调用会把对话冲走。这里照
 * **Pi Web**（github.com/agegr/pi-web）的做法重画：
 *
 *   - 默认**折叠**成一行：工具名 + 参数预览 + **耗时** + 状态 + 箭头；
 *   - 展开后也**扁平精简**：`edit` 是左右分栏 diff（`split-diff.ts`）、`bash` 是
 *     命令 + 输出、其它工具是输入 JSON + 输出文本；
 *   - 成功 / 失败的边框与底色只差一点色相（绿 / 红），不抢对话的视线。
 *
 * 耗时（`1.2s`）不在浏览器里算：工具在服务端跑，浏览器只看到「开始 / 结束」两条
 * 消息，相减得到的是传输延迟；恢复历史时更是连起点都没有。所以用内核的
 * `state.toolTimings`（见 `setToolTimings()` 的注释）。
 *
 * ## 为什么要替换 `tool-message` 的 render
 *
 * pi-web-ui 的 `renderTool()` 对**没注册**的工具回退到它自己的 `DefaultRenderer`，
 * 而它没有「兜底 renderer」这个钩子。要给**所有**工具（含扩展 / MCP 那些我们事先
 * 不知道名字的）换皮，只能把 `tool-message` 的 `render` 换掉。
 *
 * 副作用在 `installToolMessageView()` 里做，由 `main.ts` 在界面起来前调用
 * （那时 pi-web-ui 已经加载、`tool-message` 已经注册）。
 */

import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { parseEditDiff, type EditDiffLine } from './edit-diff';
import { parseUnifiedPatch, type SplitDiffCell, type SplitDiffFile } from './split-diff';

/** 工具结果的形状（只取这个视图用得到的字段）。 */
interface ToolResultLike {
  isError?: boolean;
  content?: readonly { type?: string; text?: string; data?: string; mimeType?: string }[];
  details?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 结果里的一张图：`src` 已经是能给 `<img>` 的 data URL。 */
export interface ToolResultImage {
  src: string;
  /** 给 alt / aria 用的短描述（MIME 就够：模型那边也就这点信息）。 */
  alt: string;
}

/**
 * 工具结果里的**图片块**（`read` 读图时 pi 就是这么返回的）：
 * `[{type:'text', text:'Read image file [image/png]'}, {type:'image', data, mimeType}]`。
 *
 * 也就是「附件」的另一头：`read` 把图读成 base64 给模型看，于是**浏览器里现成的
 * 那份 data 就在消息里** —— 不必再回服务端取一次（`/api/*` 也没有这条接口）。
 *
 * 空 `data` / 认不出的块跳过：宁可少画一张，也不要一个 `src="data:;base64,"` 的破图。
 */
export function resultImages(result: ToolResultLike | undefined): ToolResultImage[] {
  const out: ToolResultImage[] = [];
  for (const block of result?.content ?? []) {
    if (block.type !== 'image') continue;
    const data = block.data;
    if (typeof data !== 'string' || data === '') continue;
    const mime = typeof block.mimeType === 'string' && block.mimeType !== '' ? block.mimeType : 'image/png';
    out.push({ src: `data:${mime};base64,${data}`, alt: mime });
  }
  return out;
}

/**
 * 点缩略图 → 盖一层看原图（Esc / 点任意处关）。
 *
 * 为什么不 `window.open(src)`：`data:` 顶层导航被浏览器拦（Chrome 直接拒绝），
 * 点了会没反应。也不新写一个 pi-web-ui 的 Overlay：那是给它自己的 `Attachment`
 * （带 File、能下载）用的，工具结果这里只有一个 data URL。
 */
function openImageOverlay(image: ToolResultImage): void {
  const overlay = document.createElement('div');
  overlay.className = 'ela-image-overlay';
  const img = document.createElement('img');
  img.src = image.src;
  img.alt = image.alt;
  overlay.append(img);
  const close = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    // Esc 只关这一层：不 stopPropagation 的话，它顺手还会收掉侧边栏 / 面板。
    event.preventDefault();
    event.stopPropagation();
    close();
  }
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
}

/** 结果里的文本（拿不到给空串）。 */
function resultText(result: ToolResultLike | undefined): string {
  return (result?.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('\n');
}

/** `edit` 类工具：pi 的内置名是 `edit`，MCP / 扩展常用带前后缀的名字。 */
function isEditTool(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n === 'edit' ||
    n.startsWith('edit_') ||
    n.endsWith('.edit') ||
    n.endsWith('_edit') ||
    n.includes('str_replace') ||
    n.includes('replace_editor')
  );
}

/** `bash` 类工具（含 powershell 这种同形状的）。 */
function isBashTool(name: string): boolean {
  const n = name.toLowerCase();
  return n === 'bash' || n === 'powershell' || n === 'shell' || n === 'exec';
}

/**
 * 折叠行里的参数预览：命令 / 路径 / 模式 / 查询，取到第一个就截断。
 *
 * 与 Pi Web 的 `getToolPreview()` 同一口径（120 字），认不出的就取第一个参数。
 */
function toolPreview(params: unknown): string {
  const input = asRecord(params);
  if (!input) return '';
  for (const key of ['command', 'path', 'file_path', 'pattern', 'query', 'url']) {
    const value = input[key];
    if (typeof value === 'string') return value.slice(0, 120);
  }
  const keys = Object.keys(input);
  const first = keys[0] === undefined ? undefined : input[keys[0]];
  return typeof first === 'string' ? first.slice(0, 120) : '';
}

/** bash 展开时要看完整命令（折叠行里那个是截断过的）。 */
function fullCommand(params: unknown): string {
  const input = asRecord(params);
  const command = input?.['command'];
  return typeof command === 'string' ? command : '';
}

/** 结果 `details` 里的 diff / patch（有哪个用哪个）。 */
function extractDiff(result: ToolResultLike | undefined): { kind: 'patch' | 'diff'; text: string } | null {
  const details = asRecord(result?.details);
  if (!details) return null;
  if (typeof details['patch'] === 'string' && details['patch'] !== '') {
    return { kind: 'patch', text: details['patch'] };
  }
  if (typeof details['diff'] === 'string' && details['diff'] !== '') {
    return { kind: 'diff', text: details['diff'] };
  }
  return null;
}

// ── 图标（内联 SVG：不引图标库，也就几行） ──

const CHEVRON = html`<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2 3.5 5 6.5 8 3.5" /></svg>`;
const CHECK = html`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>`;
const CROSS = html`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>`;
const SPINNER = html`<svg class="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>`;

// ── diff 渲染 ──

/**
 * 一行 diff 单元格。
 *
 * 模板**必须写成一行**：里面有 `whitespace-pre-wrap`，模板字面量里的换行与缩进会
 * 变成文本节点（`pre-wrap` 不合并它们），每行会凭空多出十几个空格。
 */
function splitCell(cell: SplitDiffCell, left: boolean): TemplateResult {
  const bg =
    cell.type === 'added'
      ? 'bg-green-500/10'
      : cell.type === 'removed'
        ? 'bg-red-500/10'
        : cell.type === 'empty'
          ? 'bg-muted'
          : '';
  const marker = cell.type === 'added' ? '+' : cell.type === 'removed' ? '-' : ' ';
  const markerColor =
    cell.type === 'added'
      ? 'text-green-500'
      : cell.type === 'removed'
        ? 'text-red-400'
        : 'text-muted-foreground';
  const weight = cell.type === 'context' || cell.type === 'empty' ? 'font-normal' : 'font-bold';
  return html`<div class="flex min-w-0 ${bg} ${left ? 'border-r border-border' : ''}"><span class="w-[42px] shrink-0 select-none border-r border-border bg-muted px-1.5 text-right text-muted-foreground">${cell.lineNo ?? ''}</span><span class="w-[18px] shrink-0 select-none px-[5px] ${weight} ${markerColor}">${marker}</span><span class="min-w-0 flex-1 whitespace-pre-wrap break-words pr-2.5 ${cell.type === 'empty' ? 'text-muted-foreground' : 'text-foreground'}">${cell.text === '' ? '\u00a0' : cell.text}</span></div>`;
}

/** 分栏 diff：左旧右新两列对齐；多文件时带 sticky 的文件名表头。 */
function renderSplitDiff(files: readonly SplitDiffFile[], error: boolean): TemplateResult {
  const showHeaders = files.length > 1;
  return html`<div class="max-h-[560px] overflow-x-hidden overflow-y-auto border-t ${error ? 'border-red-400/30' : 'border-green-500/15'} bg-background">${files.map(
    (file) =>
      html`<div class="font-mono text-[12px] leading-[1.55]">${showHeaders ? html`<div class="sticky top-0 z-[1] grid grid-cols-2 border-b border-border bg-muted"><div class="truncate border-r border-border px-2.5 py-[5px] text-muted-foreground" title=${file.oldPath ?? ''}>${file.oldPath ?? 'before'}</div><div class="truncate px-2.5 py-[5px] text-muted-foreground" title=${file.newPath ?? ''}>${file.newPath ?? 'after'}</div></div>` : nothing}<div class="grid grid-cols-2">${file.rows.map((row) => (row.type === 'hunk' ? nothing : html`<div class="contents">${splitCell(row.left, true)}${splitCell(row.right, false)}</div>`))}</div></div>`,
  )}</div>`;
}

/** 单栏 diff（退路）：`edit-diff.ts` 解析出来的增删行。 */
function renderUnifiedDiff(lines: readonly EditDiffLine[], error: boolean): TemplateResult {
  return html`<div class="max-h-[520px] overflow-x-hidden overflow-y-auto border-t ${error ? 'border-red-400/30' : 'border-green-500/15'} bg-background font-mono text-[12px] leading-[1.55]">${lines.map(
    (line) =>
      html`<div class="flex ${line.kind === 'add' ? 'bg-green-500/10' : line.kind === 'del' ? 'bg-red-500/10' : ''}"><span class="w-[18px] shrink-0 select-none pl-[5px] ${line.kind === 'add' ? 'text-green-500' : line.kind === 'del' ? 'text-red-400' : 'text-muted-foreground'}">${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : line.kind === 'skip' ? '…' : ' '}</span><span class="min-w-0 flex-1 whitespace-pre-wrap break-words pr-2.5 text-foreground">${line.text === '' ? '\u00a0' : line.text}</span></div>`,
  )}</div>`;
}

/** 纯文本块（工具输出、认不出的 patch）。 */
function renderPre(text: string, error: boolean): TemplateResult {
  return html`<pre class="m-0 max-h-[400px] overflow-auto whitespace-pre-wrap break-all border-t ${error ? 'border-red-400/30 bg-red-400/5 text-red-400' : 'border-green-500/15 bg-muted text-muted-foreground'} px-2.5 py-2 text-[12px] leading-[1.5]">${text}</pre>`;
}

// ── 折叠状态 ──

/**
 * 哪些工具卡被展开了（按 toolCallId）。
 *
 * 放在模块级而不是组件里：流式期与定稿后工具卡可能被**重新挂载**（同一条消息
 * 重新渲染），组件内部状态会把它收回去。Pi Web 也是这么做的（见它的
 * `lib/tool-call-expansion.ts`）。
 */
const expandedToolCalls = new Set<string>();

function isToolExpanded(toolCallId: string): boolean {
  return toolCallId !== '' && expandedToolCalls.has(toolCallId);
}

function setToolExpanded(toolCallId: string, expanded: boolean): void {
  if (toolCallId === '') return;
  if (expanded) expandedToolCalls.add(toolCallId);
  else expandedToolCalls.delete(toolCallId);
}

/**
 * 工具耗时（`toolCallId` → 毫秒），由 `main.ts` 在每次状态帧到达时喂进来。
 *
 * ## 为什么走这条侧信道
 *
 * `tool-message` 是 pi-web-ui 的组件，它不认识「耗时」这个字段 —— 我们只换掉了它的
 * `render()`，能传给 `ela-tool-view` 的只有它本来就有的那几个属性（tool / toolCall /
 * result / pending）。所以要显示耗时，得从外面把表交给它：数据由服务端算好
 * （`state.toolTimings`，内核 reducer 记的 —— 见 `@ela/core/web-protocol`），
 * 组件渲染时按 id 查。
 *
 * 放在模块级而不是组件里：同一张工具卡在流式期与定稿后会**重新挂载**，
 * 组件字段会跟着丢（与 `expandedToolCalls` 同一个理由）。
 */
let toolTimings: Readonly<Record<string, number>> = {};

/** 换掉那张表（下一个渲染帧生效）。 */
export function setToolTimings(timings: Readonly<Record<string, number>>): void {
  toolTimings = timings;
}

/**
 * 耗时文案：`1.2s` / `1m 5s` / `1h 3m 2s`。
 *
 * 与 Pi Web 的 `formatToolDuration` 同一个口径（它那边也只是「给人一眼看出量级」，
 * 不需要更精确）。
 */
export function formatToolDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

/**
 * 一张折叠的工具卡。**浅 DOM**（`createRenderRoot` 返回 `this`）—— 样式走
 * pi-web-ui 那份全局 Tailwind，shadow root 里拿不到。
 */
export class ElaToolView extends LitElement {
  static properties = {
    toolName: { type: String },
    toolCallId: { type: String },
    params: { attribute: false },
    result: { attribute: false },
    running: { type: Boolean },
  };

  declare toolName: string;
  declare toolCallId: string;
  declare params: unknown;
  declare result: ToolResultLike | undefined;
  declare running: boolean;

  constructor() {
    super();
    this.toolName = '';
    this.toolCallId = '';
    this.running = false;
  }

  override createRenderRoot(): this {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // 自定义元素默认是 inline，里面那圈按钮要撑满一行 —— 与 pi-web-ui 的组件同做法。
    this.style.display = 'block';
  }

  private readonly toggle = (): void => {
    setToolExpanded(this.toolCallId, !isToolExpanded(this.toolCallId));
    this.requestUpdate();
  };

  override render(): TemplateResult {
    const name = this.toolName === '' ? 'tool' : this.toolName;
    const error = this.result?.isError === true;
    const expanded = isToolExpanded(this.toolCallId);
    const preview = toolPreview(this.params);
    // 耗时：工具跑完后才有（内核在 `tool.result` 那一刻记下）—— 跑着的就是 undefined，
    // 那一格留给状态图标自己转。
    const durationMs = toolTimings[this.toolCallId];
    const timing =
      durationMs === undefined
        ? nothing
        : html`<span class="shrink-0 font-mono text-[11px] tabular-nums ela-muted">${formatToolDuration(durationMs)}</span>`;
    // 状态图标：跑着转圈、失败打叉、成功打勾。
    const status = this.running
      ? html`<span class="shrink-0 text-muted-foreground">${SPINNER}</span>`
      : error
        ? html`<span class="shrink-0 text-red-400">${CROSS}</span>`
        : html`<span class="shrink-0 text-green-600 dark:text-green-500">${CHECK}</span>`;
    return html`<div class="overflow-hidden rounded-[7px] border text-[12px] ${error ? 'border-red-400/45 bg-red-400/5' : 'border-green-500/25 bg-green-500/5'}"><button type="button" class="flex w-full items-center gap-[7px] px-2.5 py-1.5 text-left text-muted-foreground transition-colors hover:text-foreground" @click=${this.toggle}><span class="shrink-0 font-mono text-[11px] font-semibold ${error ? 'text-red-400' : 'text-green-600 dark:text-green-500'}">${name}</span><span class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">${preview}</span>${timing}${status}<span class="shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}">${CHEVRON}</span></button>${expanded ? this.renderBody(name, error) : nothing}</div>`;
  }

  private renderBody(name: string, error: boolean): TemplateResult | typeof nothing {
    // 图片（`read` 读图）与文字是**并列**的两块：文字按工具类型各有各的排版，图统一
    // 铺一排缩略图。空结果时 `nothing` 也能直接被包住（Lit 认它）。
    const images = resultImages(this.result);
    const body = this.renderTextBody(name, error);
    if (images.length === 0) return body;
    return html`${body}<div class="ela-tool-images">${images.map(
      (image) =>
        html`<img
          class="ela-tool-image"
          src=${image.src}
          alt=${image.alt}
          title="点开看大图"
          loading="lazy"
          @click=${() => openImageOverlay(image)}
        />`,
    )}</div>`;
  }

  private renderTextBody(name: string, error: boolean): TemplateResult | typeof nothing {
    const text = resultText(this.result);
    if (isEditTool(name)) {
      const diff = extractDiff(this.result);
      if (diff?.kind === 'patch') {
        const files = parseUnifiedPatch(diff.text);
        if (files !== null) return renderSplitDiff(files, error);
        return renderPre(diff.text, error);
      }
      if (diff !== null) return renderUnifiedDiff(parseEditDiff(diff.text), error);
      // 还没结果（流式中）或空改动：不铺输入 JSON —— 折叠行里的路径已经说明了目标。
      return text.trim() === '' ? nothing : renderPre(text, error);
    }
    if (isBashTool(name)) {
      const command = fullCommand(this.params);
      const combined = command === '' ? text : text.trim() === '' ? `$ ${command}` : `$ ${command}\n\n${text}`;
      return combined.trim() === '' ? nothing : renderPre(combined, error);
    }
    // 其它工具：输入 JSON + 输出文本（与 pi-web-ui 的 DefaultRenderer 同信息量，
    // 只是塞进折叠体里）。
    const input = this.params === undefined ? '' : JSON.stringify(this.params, null, 2);
    return html`<div class="border-t ${error ? 'border-red-400/30' : 'border-green-500/15'}">${input === '' ? nothing : html`<pre class="m-0 max-h-[400px] overflow-auto whitespace-pre-wrap break-all bg-muted px-2.5 py-2 text-[12px] leading-[1.5] text-muted-foreground">${input}</pre>`}${text.trim() === '' ? nothing : renderPre(text, error)}</div>`;
  }
}

/** `tool-message` 实例上我们会用到的字段（pi-web-ui 的类，只能按形状描述）。 */
interface ToolMessageLike extends HTMLElement {
  tool?: { name?: string } | undefined;
  toolCall: { id?: string; name: string; arguments?: unknown };
  result?: ToolResultLike | undefined;
  pending?: boolean;
  aborted?: boolean;
  isStreaming?: boolean;
  render(): unknown;
}

/**
 * 用折叠行视图接管**所有**工具卡。
 *
 * 必须在 pi-web-ui 加载之后、界面首次渲染之前调用（`main()` 里第一件事）。
 */
export function installToolMessageView(): void {
  if (!customElements.get('ela-tool-view')) customElements.define('ela-tool-view', ElaToolView);
  const ctor = customElements.get('tool-message') as
    | (CustomElementConstructor & { prototype: ToolMessageLike })
    | undefined;
  if (ctor === undefined) return;
  ctor.prototype.render = function render(this: ToolMessageLike): TemplateResult {
    const toolName = this.tool?.name ?? this.toolCall.name;
    // 中止（没有结果）时合成一个 error 结果 —— 与 pi-web-ui 原本的处理一致。
    const result: ToolResultLike | undefined = this.aborted
      ? {
          isError: true,
          content: [],
          details: undefined,
        }
      : this.result;
    return html`<ela-tool-view
      .toolName=${toolName}
      .toolCallId=${this.toolCall.id ?? ''}
      .params=${this.toolCall.arguments}
      .result=${result}
      .running=${!this.aborted && (this.isStreaming === true || this.pending === true)}
    ></ela-tool-view>`;
  };
}
