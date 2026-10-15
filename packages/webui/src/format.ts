/**
 * 界面上那两类**纯格式化**：相对时间与路径末段。
 *
 * 拆出来只为一件事：它们没有便宜的肉眼检查（「3 分钟前」写成「0 分钟前」、
 * `~/a/b/` 的末段取成空串），而它们在浏览器里又碰不到 —— 于是放进单测
 * （见 `test/pure.test.ts`）。
 */

/** 数字 + 单位，末尾带「前」；拿不准就给空串（宁可什么都不显示）。 */
export function relativeTime(ms: number, now = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}

/**
 * 路径的末段（`/a/b` → `b`）。
 *
 * 尾部斜杠先去掉（`/a/b/` 的末段是 `b` 而不是空串），而根路径（`/`、`C:\`）取不到
 * 末段时**原样回**：显示一个空串比显示 `/` 更让人困惑。
 */
export function pathBase(cwd: string): string {
  const trimmed = cwd.trim().replace(/[/\\]+$/, '');
  const base = trimmed.split(/[/\\]/).pop();
  return base === undefined || base === '' ? cwd.trim() : base;
}
