/**
 * `edit` 工具的 diff：把 pi 的 **展示用 diff 文本**折成可渲染的行。
 *
 * 首选走 `split-diff.ts` 的分栏视图（用结果里的 `details.patch`，标准 unified
 * patch）。这里是**退路**：有些编辑类工具（MCP / 扩展）只给 `details.diff`，
 * 那是 pi 的 `generateDiffString()` 产物，每行形如 `[+- ]<行号> <内容>`：
 *   `+` 新增、`-` 删除、空格 上下文、`...` 省略（被折叠掉的上下文）。
 * 这种没有 `@@` 头，单栏列出来最省事。
 *
 * 纯函数（不碰 lit / DOM）—— 解析对不对在浏览器里没法一眼看出来，放在这里好单测。
 * 行内容**不含**开头那个标记 —— 标记由渲染方画成一列。
 */

export type EditDiffLineKind = 'add' | 'del' | 'context' | 'skip';

export interface EditDiffLine {
  kind: EditDiffLineKind;
  /** 行内容（不含标记）。 */
  text: string;
}

/** 解析 pi `generateDiffString()` / `details.diff` 产出的 diff 文本（空行丢掉）。 */
export function parseEditDiff(diff: string): EditDiffLine[] {
  const lines: EditDiffLine[] = [];
  for (const raw of diff.split('\n')) {
    if (raw === '') continue;
    const marker = raw.charAt(0);
    const rest = raw.slice(1);
    if (marker === '+') lines.push({ kind: 'add', text: rest });
    else if (marker === '-') lines.push({ kind: 'del', text: rest });
    else if (rest.trim() === '...') lines.push({ kind: 'skip', text: '' });
    else lines.push({ kind: 'context', text: rest });
  }
  return lines;
}
