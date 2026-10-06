/**
 * 轨迹面板 —— 网页侧的「git log --graph」。
 *
 * 和 TUI 用的是**同一个** `renderTree`（src/trace.ts 里的纯函数），所以两个界面上
 * 看到的是同一棵树，不会各画各的、说法不一致。
 *
 * 错误（包括 LLM 超时）是树上的节点，不是飘在下面的一行红字 —— 点开就能看到
 * 它挂在哪次尝试下面、重试的那次又挂在哪。
 */
import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { renderTree, traceStats, type TraceTree } from '../../src/trace';
import { traceRows } from './trace-rows';
import type { AgentStore } from '../../src/store';

@customElement('trace-panel')
export class TracePanel extends LitElement {
  @property({ attribute: false }) store!: AgentStore;
  /** 面板是否展开。 */
  @state() private expanded = false;

  static override styles = css`
    :host {
      display: block;
      border-top: 1px solid var(--border, #ddd);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      flex-shrink: 0;
    }
    .bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 12px;
      cursor: pointer;
      user-select: none;
      background: var(--muted, #f5f5f5);
    }
    .bar:hover {
      background: var(--secondary, #eee);
    }
    .title {
      font-weight: 600;
    }
    .spacer {
      flex: 1;
    }
    .stat {
      color: var(--muted-foreground, #888);
    }
    .stat.error {
      color: #dc2626;
      font-weight: 600;
    }
    .tree {
      padding: 8px 12px;
      max-height: 40vh;
      overflow: auto;
      white-space: pre;
      line-height: 1.45;
    }
    /* 失败节点：红字 + 左边一条竖线，扫一眼就能找到。 */
    .fail {
      color: #dc2626;
    }
    .ok {
      color: #16a34a;
    }
    .pending {
      color: #ca8a04;
    }
    .head {
      color: var(--muted-foreground, #888);
    }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    this.store?.subscribe(() => this.requestUpdate());
  }

  private toggle(): void {
    this.expanded = !this.expanded;
  }

  override render() {
    const tree = this.store?.getState().trace;
    if (!tree) return html``;
    const stats = traceStats(tree);
    return html`
      <div class="bar" @click=${() => this.toggle()}>
        <span class="title">轨迹</span>
        <span class="spacer"></span>
        <span class="stat">${tree.order.length} 节点</span>
        ${stats.retries > 0 ? html`<span class="stat">重试 ${stats.retries}</span>` : ''}
        ${stats.errors > 0 ? html`<span class="stat error">错误 ${stats.errors}</span>` : ''}
        <span class="stat">${this.expanded ? '▾' : '▸'}</span>
      </div>
      ${this.expanded ? html`<div class="tree">${this.renderNodes(tree)}</div>` : ''}
    `;
  }

  /**
   * 逐行渲染 renderTree 的输出，并按节点状态上色。
   *
   * 逐行解析放在 `trace-rows.ts`（与历史浏览器共用），这里只管上色。
   */
  private renderNodes(tree: TraceTree) {
    return traceRows(tree).map((row) => {
      if (row.head !== null) {
        return html`<div class="head">${row.head}</div>`;
      }
      const node = row.node;
      const cls = !node ? '' : node.status === 'error' ? 'fail' : node.status === 'ok' ? 'ok' : 'pending';
      return html`<div class=${cls}>${row.text}</div>`;
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'trace-panel': TracePanel;
  }
}
