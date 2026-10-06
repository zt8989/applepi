/**
 * 历史浏览器 —— **左列表 / 右详情**的两栏布局。
 *
 * 「会话」和「轨迹」本来就是两件事，之前被塞进同一个控件里各占一半：
 *
 *   - 底部那条轨迹面板是**当前**这一次对话的树（长、还在长、默认折叠）；
 *   - 左边这栏是**历史**会话的列表（多、可切换、会落盘成文件）。
 *
 * 把它们放一起会有两个坏处：当前轨迹会被越推越高的历史列表挤没；历史里的某一次
 * 只能「恢复」（会**换掉**当前对话）才看得到执行过程 —— 看一眼的代价是丢掉手上的会话。
 *
 * 所以拆开：**左列表管挑哪一次，右详情管看那一次的执行过程。** 看 ≠ 恢复。
 * 恢复只在那一行上有按钮，是明确的第二个动作。
 *
 * 数据都来自内核（`/api/sessions` 与 `/api/sessions/:id/trace`），浏览器不跑环。
 */
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { formatDuration, traceStats, type TraceTree } from '../../src/trace';
import { traceRows } from './trace-rows';
import { listSessions, loadSessionTrace, type SessionSummary, type SessionTrace } from './session-client';

const STATUS_CLASS = {
  ok: 'ok',
  error: 'fail',
  aborted: 'stop-mark',
  pending: 'pending',
} as const;

@customElement('history-browser')
export class HistoryBrowser extends LitElement {
  /** 内核当前正在跑哪一段（列表里高亮它）。 */
  @property({ type: String }) currentId = '';
  /** 换成别的目录时用它整表失效（cwd 变了，列表里全是另一个项目的会话）。 */
  @property({ type: String }) cwd = '';
  /** 内核推来的当前对话轨迹（由 main.ts 塞进来）。选到「当前」那条时直接用它，省一次读盘。 */
  @property({ attribute: false }) liveTrace: TraceTree | null = null;

  @state() private sessions: SessionSummary[] = [];
  @state() private selectedId: string | null = null;
  @state() private loaded: SessionTrace | null = null;
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private loadedFor: string | null = null;
  /** 展开 detail 的节点 id（`llm.result` 的全文很长，折起来更好读）。 */
  @state() private openDetail: string | null = null;

  /** 请求序号：连点两行时，先发的那次可能后到。 */
  private requestSeq = 0;

  static override styles = css`
    :host {
      display: flex;
      min-height: 0;
      flex: 1;
      font-size: 13px;
      border-left: 1px solid var(--border);
    }
    /* ── 左：列表 ── */
    .list {
      width: 19rem;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      min-height: 0;
      border-right: 1px solid var(--border);
    }
    .list-head {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 10px 12px 8px;
      border-bottom: 1px solid var(--border);
    }
    .list-title {
      font-weight: 600;
    }
    .count {
      color: var(--muted-foreground);
      font-size: 12px;
    }
    .refresh {
      margin-left: auto;
      font-size: 12px;
      color: var(--muted-foreground);
      background: none;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 1px 6px;
      cursor: pointer;
    }
    .refresh:hover {
      background: var(--secondary);
      color: var(--foreground);
    }
    .rows {
      overflow: auto;
      min-height: 0;
      flex: 1;
    }
    .row {
      display: block;
      width: 100%;
      text-align: left;
      border: 0;
      border-bottom: 1px solid var(--border);
      background: none;
      color: inherit;
      padding: 8px 12px;
      cursor: pointer;
    }
    .row:hover {
      background: var(--secondary);
    }
    .row[aria-selected='true'] {
      background: var(--accent);
      color: var(--accent-foreground);
    }
    .row-title {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-weight: 500;
    }
    .row-meta {
      display: flex;
      gap: 6px;
      align-items: center;
      margin-top: 2px;
      font-size: 11px;
      color: var(--muted-foreground);
    }
    .row[aria-selected='true'] .row-meta {
      color: inherit;
      opacity: 0.75;
    }
    .badge {
      border: 1px solid currentColor;
      border-radius: 3px;
      padding: 0 4px;
      font-size: 10px;
    }
    .empty {
      padding: 16px 12px;
      color: var(--muted-foreground);
    }
    /* ── 右：详情 ── */
    .detail {
      flex: 1;
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    }
    .detail-head {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
    }
    .detail-title {
      font-weight: 600;
      max-width: 26rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: var(--default-font-family, system-ui, sans-serif);
      font-size: 13px;
    }
    .stat {
      color: var(--muted-foreground);
      font-size: 12px;
    }
    .stat.error {
      color: #dc2626;
      font-weight: 600;
    }
    .restore {
      margin-left: auto;
      font-size: 12px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: none;
      color: inherit;
      padding: 2px 8px;
      cursor: pointer;
    }
    .restore:hover {
      background: var(--secondary);
    }
    .tree {
      overflow: auto;
      min-height: 0;
      flex: 1;
      padding: 10px 14px 20px;
      line-height: 1.5;
    }
    .line {
      white-space: pre;
      cursor: default;
      border-radius: 3px;
    }
    .line.clickable {
      cursor: pointer;
    }
    .line.clickable:hover {
      background: var(--secondary);
    }
    .ok {
      color: #16a34a;
    }
    .fail {
      color: #dc2626;
    }
    .pending {
      color: #ca8a04;
    }
    .stop-mark {
      color: var(--muted-foreground);
    }
    .head {
      color: var(--muted-foreground);
      margin-top: 2px;
    }
    .node-head {
      margin-left: 18px;
      padding: 2px 6px;
      border-left: 2px solid var(--border);
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--muted-foreground);
      font-size: 12px;
    }
    .hint {
      color: var(--muted-foreground);
      padding: 16px 14px;
      font-family: var(--default-font-family, system-ui, sans-serif);
    }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
  }

  override updated(changed: Map<PropertyKey, unknown>): void {
    // cwd 变了（内核换目录）→ 列表整表重来。不这么做的话，里面全是上一个项目的会话，
    // 点进去详情是空的。`changed.get('cwd')` 是**旧**值，与新的不同才需要重来。
    if (!changed.has('cwd')) return;
    const previous = changed.get('cwd');
    if (previous === this.cwd) return;
    this.sessions = [];
    this.loaded = null;
    this.selectedId = null;
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      const data = await listSessions();
      this.sessions = data.sessions;
      this.error = null;
      // 选中的那条可能被 /clean 删了 —— 详情还开着就会一直显示上一条的内容。
      if (this.selectedId && !data.sessions.some((s) => s.id === this.selectedId)) {
        this.selectedId = null;
        this.loaded = null;
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  /** 换选中的会话。**只读轨迹，不碰当前对话。** */
  private async select(id: string): Promise<void> {
    this.selectedId = id;
    this.openDetail = null;
    if (this.loadedFor === id) return;
    this.loadedFor = id;
    this.loading = true;
    this.loaded = null;
    // 序号：连点两行时，先发的那次请求可能后到，别让它覆盖后选的那条。
    const seq = ++this.requestSeq;
    try {
      const trace = await loadSessionTrace(id);
      if (seq === this.requestSeq) this.loaded = trace;
    } catch (e) {
      if (seq === this.requestSeq) this.error = e instanceof Error ? e.message : String(e);
    } finally {
      if (seq === this.requestSeq) this.loading = false;
    }
  }

  /** 恢复（换 id、换文件）。走内核的 /sessions/restore，零 token。 */
  private restore(id: string): void {
    this.dispatchEvent(
      new CustomEvent('restore-session', { detail: { id }, bubbles: true, composed: true }),
    );
  }

  /** 当前这条会话的轨迹：自己那份走实时快照（更便宜、也更新），别的走落盘文件。 */
  private treeFor(session: SessionSummary): TraceTree | null {
    if (session.id === this.currentId && this.liveTrace) return this.liveTrace;
    return this.loaded?.id === session.id ? this.loaded.tree : null;
  }

  override render(): TemplateResult {
    return html`
      <aside class="list">
        <div class="list-head">
          <span class="list-title">会话</span>
          <span class="count">${this.sessions.length}</span>
          <button class="refresh" @click=${() => this.refresh()} title="重新读一次会话列表">刷新</button>
        </div>
        <div class="rows">
          ${this.error ? html`<div class="empty">读不到会话列表：${this.error}</div>` : ''}
          ${!this.error && this.sessions.length === 0 ? html`<div class="empty">还没有历史会话</div>` : ''}
          ${this.sessions.map((s) => this.renderRow(s))}
        </div>
      </aside>
      <section class="detail">${this.renderDetail()}</section>
    `;
  }

  private renderRow(session: SessionSummary): TemplateResult {
    const tree = this.treeFor(session);
    const stats = tree ? traceStats(tree) : null;
    const when = new Date(session.mtimeMs).toLocaleString();
    return html`
      <button
        class="row"
        role="option"
        aria-selected=${this.selectedId === session.id ? 'true' : 'false'}
        @click=${() => this.select(session.id)}
      >
        <div class="row-title">${session.title || session.id}</div>
        <div class="row-meta">
          <span>${session.entries} 条</span>
          <span>·</span>
          <span>${when}</span>
          ${session.id === this.currentId ? html`<span class="badge">当前</span>` : ''}
          ${session.current ? nothing : html`<span class="badge">其它目录</span>`}
          ${stats && stats.retries > 0 ? html`<span>重试 ${stats.retries}</span>` : nothing}
          ${stats && stats.errors > 0 ? html`<span class="stat error">错误 ${stats.errors}</span>` : nothing}
        </div>
      </button>
    `;
  }

  private renderDetail(): TemplateResult {
    const session = this.sessions.find((s) => s.id === this.selectedId);
    if (!session) {
      return html`<div class="hint">左边选一段会话，这里看它的执行过程。<br />（看不会换掉当前对话；要接着聊，点那一行上的「恢复」。）</div>`;
    }
    const tree = this.treeFor(session);
    const stats = tree ? traceStats(tree) : null;
    return html`
      <div class="detail-head">
        <span class="detail-title" title=${session.title}>${session.title || session.id}</span>
        <span class="stat">${session.id}</span>
        ${stats
          ? html`
              <span class="stat">节点 ${tree?.order.length ?? 0}</span>
              ${stats.turns > 0 ? html`<span class="stat">${stats.turns} 轮</span>` : nothing}
              ${stats.toolCalls > 0 ? html`<span class="stat">工具 ${stats.toolCalls}</span>` : nothing}
              ${stats.retries > 0 ? html`<span class="stat">重试 ${stats.retries}</span>` : nothing}
              ${stats.errors > 0 ? html`<span class="stat error">错误 ${stats.errors}</span>` : nothing}
              ${stats.durationMs > 0
                ? html`<span class="stat">${formatDuration(stats.durationMs)}</span>`
                : nothing}
            `
          : nothing}
        <button class="restore" @click=${() => this.restore(session.id)}>恢复这一段</button>
      </div>
      <div class="tree">
        ${this.loading ? html`<div class="hint">读轨迹…</div>` : ''}
        ${!this.loading && this.error ? html`<div class="hint">${this.error}</div>` : ''}
        ${!this.loading && tree ? this.renderTree(tree) : ''}
        ${!this.loading && !tree
          ? html`<div class="hint">这一段还没有轨迹记录（可能只建了会话、没跑过模型）。</div>`
          : nothing}
      </div>
    `;
  }

  /**
   * 逐行渲染 `renderTree` 的输出。
   *
   * 形状与 TUI 逐字相同（同一个纯函数），只是按行回树里查状态上色，并让有 detail 的行可点开。
   * 缩进是树的形状（出错才长出分叉），不是样式 —— 所以这里必须用 `white-space: pre`
   * 原样保留前缀。
   */
  private renderTree(tree: TraceTree): TemplateResult[] {
    return traceRows(tree).map((row) => {
      if (row.head !== null) return html`<div class="line head">${row.head}</div>`;
      const cls = row.node ? (STATUS_CLASS[row.node.status] ?? '') : '';
      const expandable = row.node?.detail !== undefined;
      const open = expandable && this.openDetail === row.id;
      const line = html`
        <div
          class="line ${cls} ${expandable ? 'clickable' : ''}"
          @click=${expandable ? () => (this.openDetail = open ? null : (row.id ?? null)) : undefined}
          title=${expandable ? (open ? '收起' : '展开') : ''}
        >
          ${row.text}
        </div>
        ${open
          ? html`<div class="node-head">${row.node?.detail}</div>`
          : html``}
      `;
      return line;
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'history-browser': HistoryBrowser;
  }
}
