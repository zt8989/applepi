/**
 * 扩展的 `ctx.sessionManager` —— 它要读会话条目时会碰的那扇门。
 *
 * ## 它要什么
 *
 * `pi-web-access` 用三处，全部是**读**：
 *
 * | 成员 | 干什么 |
 * | --- | --- |
 * | `getSessionId()` | 算 opencode 的 `x-opencode-session` 请求头（只对 opencode provider） |
 * | `getBranch()` | 恢复「上一轮存下来的搜索结果」（`/search` 那个命令列的就是它们） |
 * | `buildSessionContext(branch)` | 重建对话，判「这次请求里模型已经用过哪些 web 工具」 |
 *
 * `pi-subagents` 另外要一个 `getSessionFile()`（会话文件的绝对路径）：它用这个路径算
 * 「本会话的 subagent 产物放哪」。**两处都会读**，所以少它就不是「某个命令不可用」，
 * 而是 `session_start` 与每轮 `before_agent_start` 各一条
 * `sessionManager.getSessionFile is not a function`。
 *
 * ## 为什么用**本项目**的会话，而不是 pi 的 SessionManager
 *
 * pi 那边是 `SessionManager` **类**，它的条目来自 pi 自己的 `sessions/*.jsonl`。本项目的
 * 会话是**另一份**：`state.messages` + 自己的落盘器（见 [sessions](sessions.md)）。
 * 两边指向同一个目录却**不是同一份内存** —— 拿 pi 的来读，读到的是**上一次进程**留下的
 * 文件，而当前这一轮的消息一个都没有。
 *
 * 那症状是：「`/search` 列不出刚才搜的东西」，而且**只在同一个会话里出错**（重启就
 * 「好了」，因为那时文件里的内容恰好等于内存里的）。极难归因。
 *
 * 所以这里只实现上面那几个只读成员，数据源是本项目的 `state.messages`（`getSessionFile`
 * 例外 —— 它读落盘器，那就是文件本身的真相）。
 *
 * ## `custom` 条目怎么办：不存，于是它们「不存在」
 *
 * `pi-web-access` 存搜索结果走 `pi.appendEntry('web-search-results', …)`，而本项目
 * **不接** `appendEntry`（那是 pi 会话层的能力，见 extensions.md）。所以 `getBranch()`
 * 里不会有任何 `type: 'custom'` 的条目。
 *
 * 后果要说清：**`/search` 在本项目里看不到历史搜索结果**（它会回一句「No stored search
 * results」）。那不是崩溃，是诚实的降级 —— 扩展自己判 `results.length === 0` 走那条路。
 * 要真让 `/search` 有历史，得给 `appendEntry` 存一份（见 extensions.md 的「不接」清单）。
 *
 * ## 刻意**不**实现的
 *
 * pi 的 `SessionManager` 有几十个方法（`addEntry` / `fork` / `navigateTree` / …）。那些是
 * pi 的**会话层**，本项目刻意不接。这里只给上面那几个 —— 扩展去调别的会在 undefined 上炸，
 * 那比给一堆「说谎的 no-op」诚实（后者会让扩展以为操作成功了）。
 */
import type { AgentStore } from './store';
import type { Message } from '@earendil-works/pi-ai';

/** 扩展会碰到的 `ctx.sessionManager` 成员（只有这几个是读）。 */
export interface ExtensionSessionManager {
  getSessionId(): string | undefined;
  /**
   * 当前会话文件的绝对路径。
   *
   * 取不到时返回 `undefined`（不写会话文件 / 还没建落盘器）—— `pi-subagents` 对
   * `undefined` 有降级路径（回退到 sessionId 当身份），不报错。
   */
  getSessionFile(): string | undefined;
  getBranch(): readonly unknown[];
}

/**
 * 造一个 `ctx.sessionManager`。
 *
 * @param store      本项目的 store（`state.messages` 是数据源）
 * @param sessionId  取**当前**会话 id —— 扩展注册时拿到的是一个**取值的函数**，
 *                   不是常量：`/new` 换会话后 id 会变，而扩展的 `getSessionId()`
 *                   得报新的那个（见 kernel.ts 的 `newSession`）。
 */
export function extensionSessionManager(
  store: AgentStore,
  sessionId: () => string,
  /**
   * 当前会话文件路径。同样是**取值函数**：`/new` 换会话后文件也换（与 `sessionId`
   * 同一个理由）。不给就是「没有文件」（不写会话文件的会话）。
   */
  sessionFile: () => string | undefined = () => undefined,
): ExtensionSessionManager {
  return {
    getSessionId: () => sessionId(),
    getSessionFile: () => sessionFile(),
    /**
     * 官方那条路是 `buildSessionContext(branch).messages`，而 `branch` 是**条目数组**
     * （`{type:'message', message}` 那种）。本项目直接给 `state.messages` ——
     * 那已经是**消息**数组了，不需要再转一次。
     *
     * 扩展的用法是 `buildSessionContext(ctx.sessionManager.getBranch())` ——
     * `buildSessionContext` 是它自己 import 的（从 pi-coding-agent），它对 `branch`
     * 的期望是条目数组。
     *
     * 所以这里给**条目形状**（把每条消息包成 `{ type: 'message', message }`），
     * 让官方的 `buildSessionContext` 能用。少这层包装的话它会把消息当成条目、
     * 读不到 `.message`，于是「模型已经用过哪些 web 工具」判不出来 → 每次都重复加载
     * 那些工具（症状：明明刚搜过，又被要求 `web_enable` 一次）。
     */
    getBranch: () => store.getState().messages.map((message) => ({ type: 'message', message })),
  };
}

/** 只取消息（`buildSessionContext` 那条路的原料）。 */
export function branchMessages(store: AgentStore): readonly Message[] {
  return store.getState().messages;
}
