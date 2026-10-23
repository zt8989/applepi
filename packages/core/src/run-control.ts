/**
 * 当前运行的 AbortController 登记。
 *
 * AbortController 是可变命令式对象，不能进 Redux 状态树：reducer 保持纯净，
 * Cmd 执行时在这里登记，CLI 的中断键从这里取。
 *
 * 连带登记「谁喊的中断」：只 `abort()` 不带原因的话，effect 侧只能从「流断了」反推、
 * 一律记成 aborted，「用户按停止」与「内核关闭顺手 abort」就分不开。
 */
import { stopCauseText, type StopCause } from './state';

let current: AbortController | null = null;
/** 本次中断的原因；`beginRun()` 会清掉它。 */
let currentCause: StopCause = 'user';

/** 开始一段副作用（LLM 流或一批工具），返回本次的 signal 来源。 */
export function beginRun(): AbortController {
  current = new AbortController();
  // 上一段的中断理由作废；不清的话，超时后的手动停止会被记成上次的超时。
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
 * `cause` 说明谁喊停的，界面照它分色（用户自己按停止是灰的，不该弹红框）。
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

/** abort 携带的原因对象，effect 侧据此分类，不必去猜 error 文案。 */
export class RunAbortedError extends Error {
  constructor(readonly cause: StopCause) {
    // 文案与界面的停止原因同一个词源（i18n）：不然界面上「用户手动中断」后面
    // 会跟一句说法不同的「运行被用户中断」，同一件事两个名字。
    super(stopCauseText(cause));
    this.name = 'RunAbortedError';
  }
}

export function isRunning(): boolean {
  return current !== null;
}
