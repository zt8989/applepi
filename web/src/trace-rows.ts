/**
 * 把轨迹树拆成「可点的行」——网页上画轨迹的公共前置。
 *
 * 网页有两种地方要画同一棵树：
 *   - 底部那条**当前**对话的轨迹面板（`trace-panel.ts`）；
 *   - 右边历史浏览器的**某一次**对话的轨迹（`history-browser.ts`）。
 *
 * 两边都基于 `renderTree`（src/trace.ts 的纯函数，与 TUI 共用）那几行固定格式的输出，
 * 但都需要「行 → 节点」的回查（按状态上色、点开看 detail）。抽在这里，
 * 免得两处各写一份正则 —— 正则漏一个 kind 就等于那一族静默不上色。
 */
import { renderTree, type TraceNode, type TraceTree } from '../../src/trace';

/** 节点 kind 的全集。**漏一个就等于那个 kind 整族不上色**（静默退化，最难发现的一种 bug）。 */
const NODE_LINE =
  /^(.*?)(n\d+) (llm\.attempt|llm\.result|tool\.attempt|tool\.result|user|error|stop|prompt\.base|prompt\.tools|prompt\.segment|model\.init):/;

export interface TraceRow {
  /** `HEAD → n7` 那种尾行（没有节点）。 */
  head: string | null;
  /** 行首的缩进/树枝前缀（原样保留，画的时候不能丢）。 */
  prefix: string;
  /** 节点 id；`HEAD` 行与无法解析的行是 null。 */
  id: string | null;
  /** 节点本体（回树里查的，不是从行里解析的 —— 树的权威在 tree.nodes）。 */
  node: TraceNode | null;
  /** 整行的文本。 */
  text: string;
}

/** 树 → 行。**顺序与 `renderTree` 完全一致**（含 HEAD 尾行）。 */
export function traceRows(tree: TraceTree): TraceRow[] {
  return renderTree(tree, { maxWidth: 0 })
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      if (line.startsWith('HEAD')) {
        return { head: line, prefix: '', id: null, node: null, text: line };
      }
      const match = NODE_LINE.exec(line);
      const id = match?.[2] ?? null;
      return {
        head: null,
        prefix: match?.[1] ?? '',
        id,
        node: id ? (tree.nodes[id] ?? null) : null,
        text: line,
      };
    });
}
