/**
 * 扩展的 `ctx.sessionManager` —— 它要读会话条目时会碰的那扇门，只实现只读成员：
 * `getSessionId()` / `getSessionFile()` / `getBranch()`（`pi-web-access` 与 `pi-subagents` 用到的那几个）。
 *
 * 数据源是本项目的 `state.messages`，**不是** pi 的 `SessionManager`：后者读的是盘上
 * 上一次进程留下的文件，当前这一轮的消息一个都没有 —— 症状是 `/search` 列不出刚搜的东西，
 * 而且只在同一会话里出错（重启就「好了」）。
 *
 * `custom` 条目不存：本项目不接 `pi.appendEntry`，所以 `getBranch()` 里没有它，
 * `/search` 看不到历史搜索结果（扩展自己判 `results.length === 0` 走降级）。
 *
 * 其余几十个 `SessionManager` 方法刻意不给：扩展调它们会在 undefined 上炸，
 * 比给一堆「说谎的 no-op」诚实。
 */
import type { AgentStore } from './store';
import type { Message } from '@earendil-works/pi-ai';

/** 扩展会碰到的 `ctx.sessionManager` 成员。 */
export interface ExtensionSessionManager {
  getSessionId(): string | undefined;
  /**
   * 当前会话文件的绝对路径；取不到时返回 `undefined`（不写会话文件 / 还没建落盘器）——
   * `pi-subagents` 对 `undefined` 有降级路径，不报错。
   */
  getSessionFile(): string | undefined;
  getBranch(): readonly unknown[];
}

/**
 * 造一个 `ctx.sessionManager`。
 *
 * `sessionId` / `sessionFile` 都是**取值函数**而不是常量：`/new` 换会话后 id 与文件
 * 都会变，扩展的 `getSessionId()` 得报新的那个。
 */
export function extensionSessionManager(
  store: AgentStore,
  sessionId: () => string,
  /** 当前会话文件路径。不给就是「没有文件」（不写会话文件的会话）。 */
  sessionFile: () => string | undefined = () => undefined,
): ExtensionSessionManager {
  return {
    getSessionId: () => sessionId(),
    getSessionFile: () => sessionFile(),
    /**
     * 官方的 `buildSessionContext` 期望**条目**数组（`{ type: 'message', message }`），
     * 所以要包一层；少这层包装它读不到 `.message`，「模型已经用过哪些 web 工具」就判不出来，
     * 于是每次都重复加载那些工具。
     */
    getBranch: () => store.getState().messages.map((message) => ({ type: 'message', message })),
  };
}

/** 只取消息（`buildSessionContext` 那条路的原料）。 */
export function branchMessages(store: AgentStore): readonly Message[] {
  return store.getState().messages;
}
