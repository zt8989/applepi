/**
 * 把轨迹树摊成「可点的行」—— 网页上画轨迹的公共前置。
 *
 * ## 为什么不再直接渲染 renderTree 的输出
 *
 * 以前是把 `renderTree` 那几行 ASCII（`✓ n2 llm.attempt: …`）直接塞进页面，靠
 * `white-space: pre` 保住缩进。那是给**终端**看的：等宽、一行到底、没有颜色语义。
 * 搬到网页上有三个具体问题：
 *
 *   1. 满屏 `✓ n123 llm.attempt:` 这种内部 id 与 kind 名，对读者没有信息量；
 *   2. 缩进靠空格撑着，字体一变（比例字体）就错位；
 *   3. 「异常才分叉」这条规则被埋在空格里，看的人得在脑子里重建那棵树。
 *
 * 所以这里改成一个**扁平的账本**：一行一个节点，左边一枚 kind 芯片，右边一句话摘要。
 * 需要树形（重试/失败）的地方由 `indent` 单独给 —— 也就是「异常才分叉」那条规则，
 * 变成行上可见的一格缩进，而不是一串猜不出来的空格。
 *
 * 顺序仍然是**发生顺序**（tree.order），与 renderTree 完全一致 ——
 * 两者看的是同一棵树，不能一个正着一个倒着。
 */
import type { TraceNode, TraceNodeKind, TraceTree } from "../../src/trace";

/** kind → 界面上那枚芯片的中文名。 */
export const KIND_LABEL: Record<TraceNodeKind, string> = {
  user: "用户",
  "prompt.base": "提示词",
  "prompt.tools": "工具表",
  "prompt.segment": "上下文",
  "model.init": "模型",
  "llm.attempt": "尝试",
  "llm.result": "回答",
  "tool.attempt": "工具",
  "tool.result": "结果",
  error: "错误",
  stop: "收工",
};

/**
 * kind → 芯片颜色。
 *
 * 与 harness 的轨迹面板同一套语义（那边是 trajectory-colors.ts）：
 * 用户蓝、模型紫、工具橙、上下文绿、系统灰。颜色在这里集中一处，
 * 免得两处各写一份、各自漂移。
 */
export const KIND_CHIP: Record<TraceNodeKind, string> = {
  user: "sky",
  "prompt.base": "muted",
  "prompt.tools": "muted",
  "prompt.segment": "emerald",
  "model.init": "muted",
  "llm.attempt": "violet",
  "llm.result": "violet",
  "tool.attempt": "amber",
  "tool.result": "amber",
  error: "red",
  stop: "muted",
};

export interface TraceRow {
  /** 节点 id；`HEAD` 行与解析不出来的行是 null。 */
  id: string | null;
  node: TraceNode | null;
  /** kind 芯片的文案与配色。 */
  kind: string;
  chip: string;
  /** 一句话摘要：工具是「名字 参数」，其余是该 kind 的主文本。 */
  headline: string;
  /** 次要信息（耗时、provider/model 等）—— 不抢主行，只在后面跟着。 */
  meta: string;
  /** 失败态：决定图标与配色（✗ 而非 ✓）。 */
  failed: boolean;
  /**
   * 缩进层数。**只在异常/重试处 > 0** —— 正常对话恒为 0（扁平的账本），
   * 出问题的那一处才缩进，于是「哪里出的问题」一眼能扫出来。
   */
  indent: number;
  /** 有 detail 就可点开。 */
  expandable: boolean;
  detail?: string | undefined;
  /** `HEAD → n7` 那种尾行。 */
  head: string | null;
  text: string;
}

/** 一段文本的头一行，用于摘要（原文常常是整个文件或整条 JSON）。 */
function firstLine(text: string, max = 120): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** 工具节点的摘要：`名字 参数`。空格是必要的 —— `bash{"command":…}` 读起来像一个超长标识符。 */
function toolHeadline(node: TraceNode): string {
  const meta = node.meta ?? {};
  const name = meta["tool"];
  if (name === undefined) return firstLine(node.label);
  const args = /^\w+ (.*)$/.exec(node.label)?.[1] ?? node.label;
  return args === "" ? name : `${name} ${args}`;
}

/**
 * 缩进层数：只有「这一段出了问题」时才 > 0。
 *
 * ## 判据为什么不是「一组兄弟里有失败」
 *
 * 最初只写了后半个判据，结果两条真实轨迹缩进数是 **0**，而它们各有 2 个错误节点。
 * 原因是工具报错时的结构是：
 *
 *     tool.attempt (status=ok)  →  error 节点
 *
 * error 挂在 attempt **下面**，那一组兄弟全是 status=ok 的 attempt，「组里有失败」
 * 不成立，于是不缩进 —— 而工具报错恰恰是最该让人一眼看见的地方。
 *
 * 所以现在分两种：
 *   1. 节点**自己**失败（kind 或 status 是 error）→ 缩进一级，它下面那一串跟着缩；
 *   2. 它自己没失败，但那组兄弟里有失败的 → 也缩进，于是失败者与同伴同列，
 *      看得出它们是一起的。
 *
 * 正常对话两者都不成立 → 恒为 0，一张平铺的列表。
 */
function computeIndents(tree: TraceTree): Map<string, number> {
  const childrenOf = (id: string | null): TraceNode[] =>
    tree.order
      .map((childId) => tree.nodes[childId])
      .filter((n): n is TraceNode => n !== undefined && n.parentId === id);

  const failed = (n: TraceNode): boolean =>
    n.kind === "error" || n.status === "error";

  const indents = new Map<string, number>();

  /** 这一组里有没有失败。 */
  const groupHasFailure = (siblings: readonly TraceNode[]): boolean =>
    siblings.length > 1 && siblings.some(failed);

  const walk = (parentId: string | null, base: number): void => {
    const children = childrenOf(parentId);
    const groupForked = groupHasFailure(children);
    for (const node of children) {
      const self = failed(node) || groupForked;
      const here = self ? base + 1 : base;
      indents.set(node.id, here);
      walk(node.id, here);
    }
  };
  walk(null, 0);
  return indents;
}

/** 树 → 行。**顺序与 `renderTree` 完全一致**（含 HEAD 尾行）。 */
export function traceRows(tree: TraceTree): TraceRow[] {
  const indents = computeIndents(tree);
  const rows: TraceRow[] = [];

  for (const id of tree.order) {
    const node = tree.nodes[id];
    if (!node) continue;
    const failed = node.kind === "error" || node.status === "error";
    const kind = KIND_LABEL[node.kind];
    const headline =
      node.kind === "tool.attempt" ? toolHeadline(node) : firstLine(node.label);
    const metaBits: string[] = [];
    if (node.endedAt !== null) {
      const ms = node.endedAt - node.createdAt;
      metaBits.push(
        ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`,
      );
    }
    const provider = node.meta?.["provider"];
    if (provider !== undefined && node.kind === "llm.attempt") {
      metaBits.push(`${provider}/${node.meta?.["model"] ?? "?"}`);
    }
    const cause = node.meta?.["cause"];
    if (cause !== undefined && node.kind !== "llm.attempt")
      metaBits.push(cause);

    rows.push({
      id,
      node,
      kind,
      chip: KIND_CHIP[node.kind],
      headline,
      meta: metaBits.join(" · "),
      failed,
      indent: indents.get(id) ?? 0,
      expandable: node.detail !== undefined,
      ...(node.detail !== undefined ? { detail: node.detail } : {}),
      head: null,
      text: node.label,
    });
  }

  if (tree.tipId !== null) {
    rows.push({
      id: null,
      node: null,
      kind: "",
      chip: "muted",
      headline: "",
      meta: "",
      failed: false,
      indent: 0,
      expandable: false,
      head: `HEAD → ${tree.tipId}`,
      text: `HEAD → ${tree.tipId}`,
    });
  }
  return rows;
}
