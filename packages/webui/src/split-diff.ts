/**
 * 统一 diff（unified patch）→ **分栏**（左旧 / 右新）的行。
 *
 * pi 的 `edit` 工具在结果 `details.patch` 里回一份标准 unified patch
 * （`--- a` / `+++ b` / `@@ -x,y +m,n @@`）。展开时按左右两列对齐渲染，比单栏
 * diff 省高度 —— 这也是 Pi Web（github.com/agegr/pi-web，MIT）的做法，本文件是它
 * `lib/patch.ts` 的移植（逻辑照搬，注释与类型按本项目改写）。
 */

export type SplitDiffCellType = 'context' | 'removed' | 'added' | 'empty';

export interface SplitDiffCell {
  /** 这一侧的**行号**（旧文件用旧号、新文件用新号）；空位是 `null`。 */
  lineNo: number | null;
  text: string;
  type: SplitDiffCellType;
}

export type SplitDiffRow =
  | { type: 'hunk'; text: string }
  | { type: 'line'; left: SplitDiffCell; right: SplitDiffCell };

export interface SplitDiffFile {
  oldPath?: string | undefined;
  newPath?: string | undefined;
  rows: SplitDiffRow[];
}

interface PendingChangeLine {
  lineNo: number;
  text: string;
}

/** 解析 unified patch；没有可渲染的行（不是 patch）时给 `null`。 */
export function parseUnifiedPatch(text: string): SplitDiffFile[] | null {
  const files: SplitDiffFile[] = [];
  let current: SplitDiffFile | null = null;
  let pendingOldPath: string | undefined;
  let oldLineNo = 0;
  let newLineNo = 0;
  // `@@` 头里还剩多少行没消费 —— 大于 0 就还在 hunk 体内。体内以 `--- `/`+++ `
  // 开头的行是**内容**（比如删掉了一行 `-- x`），不是文件头；在那儿认文件头会把
  // 一个文件拆成好几个。
  let hunkOldRemaining = 0;
  let hunkNewRemaining = 0;
  let removed: PendingChangeLine[] = [];
  let added: PendingChangeLine[] = [];

  const emptyCell = (): SplitDiffCell => ({ lineNo: null, text: '', type: 'empty' });
  // 把攒下的「删」「增」按序配对成一行 —— 左右对齐，一边多出来的就填空位。
  const flushChanges = (): void => {
    if (!current) {
      removed = [];
      added = [];
      return;
    }
    const count = Math.max(removed.length, added.length);
    for (let i = 0; i < count; i += 1) {
      const rem = removed[i];
      const add = added[i];
      const left: SplitDiffCell = rem
        ? { lineNo: rem.lineNo, text: rem.text, type: 'removed' }
        : emptyCell();
      const right: SplitDiffCell = add
        ? { lineNo: add.lineNo, text: add.text, type: 'added' }
        : emptyCell();
      current.rows.push({ type: 'line', left, right });
    }
    removed = [];
    added = [];
  };

  for (const line of text.split(/\r?\n/)) {
    const insideHunk = hunkOldRemaining > 0 || hunkNewRemaining > 0;

    if (!insideHunk) {
      if (line.startsWith('--- ')) {
        flushChanges();
        pendingOldPath = cleanPatchPath(line.slice(4));
        continue;
      }
      if (line.startsWith('+++ ')) {
        flushChanges();
        current = { oldPath: pendingOldPath, newPath: cleanPatchPath(line.slice(4)), rows: [] };
        files.push(current);
        continue;
      }
    }

    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      if (!current) {
        current = { rows: [] };
        files.push(current);
      }
      flushChanges();
      oldLineNo = Number(hunk[1] ?? 0);
      newLineNo = Number(hunk[3] ?? 0);
      hunkOldRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
      hunkNewRemaining = hunk[4] === undefined ? 1 : Number(hunk[4]);
      current.rows.push({ type: 'hunk', text: line });
      continue;
    }

    if (!current) continue;

    // `\ No newline at end of file` —— 不配对，原样当一条分隔提示。
    if (line.startsWith('\\ ')) {
      flushChanges();
      current.rows.push({ type: 'hunk', text: line });
      continue;
    }

    const prefix = line.charAt(0);
    const content = line.slice(1);

    if (prefix === ' ') {
      flushChanges();
      current.rows.push({
        type: 'line',
        left: { lineNo: oldLineNo, text: content, type: 'context' },
        right: { lineNo: newLineNo, text: content, type: 'context' },
      });
      oldLineNo += 1;
      newLineNo += 1;
      if (hunkOldRemaining > 0) hunkOldRemaining -= 1;
      if (hunkNewRemaining > 0) hunkNewRemaining -= 1;
    } else if (prefix === '-') {
      removed.push({ lineNo: oldLineNo, text: content });
      oldLineNo += 1;
      if (hunkOldRemaining > 0) hunkOldRemaining -= 1;
    } else if (prefix === '+') {
      added.push({ lineNo: newLineNo, text: content });
      newLineNo += 1;
      if (hunkNewRemaining > 0) hunkNewRemaining -= 1;
    } else if (line !== '') {
      // 认不出的行（比如把 `@@` 写错）当一条普通提示，别丢。
      flushChanges();
      current.rows.push({ type: 'hunk', text: line });
    }
  }

  flushChanges();

  const parsed = files.filter((file) => file.rows.some((row) => row.type === 'line'));
  return parsed.length > 0 ? parsed : null;
}

function cleanPatchPath(path: string): string {
  // `createTwoFilesPatch` 会在路径后跟一个 TAB + 时间戳；去掉它。
  return path.split('\t')[0]?.trim() ?? path.trim();
}
