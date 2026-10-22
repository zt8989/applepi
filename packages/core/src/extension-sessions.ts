/**
 * 扩展的 `ctx.sessionManager` —— 它要读会话时会碰的那扇门，只实现只读成员：
 * `getSessionId()` / `getSessionFile()` / `getBranch()` / `getEntries()` /
 * `buildSessionContext()`（`pi-web-access` 与 `pi-subagents` 用到的那几个）。
 *
 * 数据源是本项目的 `state.messages`，**不是** pi 的 `SessionManager`：后者读的是盘上
 * 上一次进程留下的文件，当前这一轮的消息一个都没有 —— 症状是 `/search` 列不出刚搜的东西，
 * 而且只在同一会话里出错（重启就「好了」）。
 *
 * `custom` 条目不存：本项目不接 `pi.appendEntry`，所以 `getEntries()` 里没有它，
 * `/search` 看不到历史搜索结果（扩展自己判 `results.length === 0` 走降级）。
 *
 * 其余几十个 `SessionManager` 方法刻意不给：扩展调它们会在 undefined 上炸，
 * 比给一堆「说谎的 no-op」诚实。
 */
import { buildSessionHead } from './prompt-head';
import type { AgentStore } from './store';
import type { AgentState } from './state';
import type { Message } from '@earendil-works/pi-ai';

/** 一个会话条目，形状照 pi 的 `SessionEntry`（`id`/`parentId` 串成会话树）。 */
export interface ExtensionSessionEntry {
  type: 'message';
  id: string;
  parentId: string | null;
  /** ISO 时间。 */
  timestamp: string;
  message: Message;
}

/** `buildSessionContext()` 的返回，与 pi 的 `SessionContext` 同形。 */
export interface ExtensionSessionContext {
  messages: Message[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}

/** 扩展会碰到的 `ctx.sessionManager` 成员。 */
export interface ExtensionSessionManager {
  getSessionId(): string | undefined;
  /**
   * 当前会话文件的绝对路径；取不到时返回 `undefined`（不写会话文件 / 还没建落盘器）——
   * `pi-subagents` 对 `undefined` 有降级路径，不报错。
   */
  getSessionFile(): string | undefined;
  getBranch(): readonly ExtensionSessionEntry[];
  getEntries(): readonly ExtensionSessionEntry[];
  buildSessionContext(): ExtensionSessionContext;
}

/**
 * 把内存里的对话摆成**条目**（`{ type: 'message', message }`），官方的
 * `buildSessionContext(entries)` 读的就是 `.message`。
 *
 * head 什么时候算「在 transcript 里」：会话**已经有消息**时。pi 的 head 与第一条消息
 * 一起落盘，而 `session_start` 事件在两者之前 —— 那一刻 transcript 是空的。扩展靠
 * `messages.length === 0` 判断「新会话」并走 eager 装载（`pi-subagents` 的 `subagent`
 * 工具就是这样在空会话里默认激活的），空会话里塞一条 head 会把它变成「有历史」。
 */
function sessionEntries(state: AgentState): ExtensionSessionEntry[] {
  const entries: ExtensionSessionEntry[] = [];
  const push = (message: Message): void => {
    entries.push({
      type: 'message',
      id: `e${entries.length + 1}`,
      parentId: entries.length === 0 ? null : `e${entries.length}`,
      // 内存状态里没有每条消息的落盘时刻（那是会话文件的职责），
      // 给一个明确的「未知」而不是编一个当前时间。
      timestamp: new Date(0).toISOString(),
      message,
    });
  };
  if (state.prompt.seeded && state.messages.length > 0) push(buildSessionHead(state));
  for (const message of state.messages) push(message);
  return entries;
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
    getBranch: () => sessionEntries(store.getState()),
    /**
     * `pi-subagents` 在 `session_start` 里读它恢复 `/命令` 的结果快照（只看
     * `custom_message` 条目 —— 本项目不存那一类，于是它走空结果那条降级路径）。
     */
    getEntries: () => sessionEntries(store.getState()),
    /**
     * 扩展读 transcript 的正式入口（`pi-subagents` 用它判断「装载时声明了哪些工具」，
     * 据此决定 `subagent` / `bg_wait` 该不该重新激活）。head 与落盘那条同形，
     * 否则它认不出已有声明，每次都当成新会话。
     */
    buildSessionContext: () => {
      const state = store.getState();
      return {
        messages: sessionEntries(state).map((entry) => entry.message),
        thinkingLevel: state.model.thinkingLevel,
        model: { provider: state.model.provider, modelId: state.model.modelId },
      };
    },
  };
}

/** 只取消息（`buildSessionContext` 那条路的原料）。 */
export function branchMessages(store: AgentStore): readonly Message[] {
  return store.getState().messages;
}
