/**
 * 当前运行的 AbortController 登记。
 *
 * AbortController 是可变命令式对象，不能放进 Redux 状态树；
 * reducer 保持纯净，Cmd 执行时在这里登记，CLI 的中断键从这里取。
 *
 * 登记的**不止是 controller**：还有「谁喊的中断」。这一点以前是缺的 ——
 * `abortRun()` 只是 `current.abort()`，不带任何原因，于是 effect 侧只能从
 * 「流断了」反推，最后一律记成 aborted。界面上「你自己按了停止」和
 * 「内核被关掉顺手 abort 的」因此长得一模一样。
 */
import type { StopCause } from './state';

let current: AbortController | null = null;
/** 本次中断的原因；`beginRun()` 会清掉它。 */
let currentCause: StopCause = 'user';

/** 开始一段副作用（LLM 流或一批工具），返回本次的 signal 来源。 */
export function beginRun(): AbortController {
  current = new AbortController();
  // 新的一段 = 之前的中断理由作废。漏清的话，超时后紧跟着的一次手动停止会被记成上次的超时。
  currentCause = 'user';
  return current;
}

/** 副作用结束（成功与否都调）。 */
export function endRun(): void {
  current = null;
}

/**
 * 中断当前副作用；没有在跑的副作用时返回 false。
 *
 * `cause` 说明**谁**喊停的，界面照它决定分色（用户自己按停止是灰的，不该弹红框）。
 * 省略时按 `user` 处理 —— 现有调用点只有 Ctrl-C 与 Web 的停止按钮，都是用户。
 */
export function abortRun(cause: StopCause = 'user'): boolean {
  if (!current) return false;
  currentCause = cause;
  current.abort(new RunAbortedError(cause));
  return true;
}

/** 本次（或最近一次）中断的原因；没在跑时读到的值不保证有意义。 */
export function lastAbortCause(): StopCause {
  return currentCause;
}

/** 手动中断时 abort 携带的原因对象 —— effect 侧据此分类，不必去猜 error 文案。 */
export class RunAbortedError extends Error {
  constructor(readonly cause: StopCause) {
    super(cause === 'user' ? '运行被用户中断' : `运行被中断（${cause}）`);
    this.name = 'RunAbortedError';
  }
}

export function isRunning(): boolean {
  return current !== null;
}
