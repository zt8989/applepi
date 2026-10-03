/**
 * 当前运行的 AbortController 登记。
 *
 * AbortController 是可变命令式对象，不能放进 Redux 状态树；
 * reducer 保持纯净，Cmd 执行时在这里登记，CLI 的中断键从这里取。
 */
let current: AbortController | null = null;

/** 开始一段副作用（LLM 流或一批工具），返回本次的 signal 来源。 */
export function beginRun(): AbortController {
  current = new AbortController();
  return current;
}

/** 副作用结束（成功与否都调）。 */
export function endRun(): void {
  current = null;
}

/** 中断当前副作用；没有在跑的副作用时返回 false。 */
export function abortRun(): boolean {
  if (!current) return false;
  current.abort();
  return true;
}

export function isRunning(): boolean {
  return current !== null;
}
