/**
 * TUI 的「恢复历史」弹窗 —— `/resume` 打开。
 *
 * ## 为什么直接用 pi 官方的 `SessionSelectorComponent`
 *
 * 这个面板的**交互面**很宽，而每一条都要与 pi 对齐才有意义（用户已经习惯了 `tab` 换作用域、
 * `ctrl+s` 换排序、`re:` 正则搜索）：
 *
 * ```text
 *   Resume Session (Current Folder)        ⊙ Current Folder │ ○ All  Name: All  Sort: Threaded
 *   > 搜索…                                tab scope · re:<pattern> regex · "phrase" exact
 *     读 package.json 的前 3 行            ctrl+s sort · ctrl+n named · ctrl+d delete …
 *   › 现在几点？用 bash 查一下日期          6 8m
 *     (1/112)
 * ```
 *
 * 手写这套要复刻 `session-selector.js` + `session-selector-search.js`（树形前缀、
 * 分数排序、`re:`/引号查询解析、异步加载 + `Loading 7/112` 进度、删除确认态、
 * 重命名子面板…）约 350 行，而且**必然与上游漂移**。对话区那几个渲染器已经这么用了
 * （见 `app.ts`），这里同一口径。
 *
 * 所以这里是**适配层**，不是重写：
 *
 * | 官方要什么 | 我们给 |
 * | --- | --- |
 * | `currentSessionsLoader` / `allSessionsLoader`：`(onProgress, signal) => Promise<SessionInfo[]>` | `listSessions({cwd})` / `listSessions()` 适配成 `SessionInfo` |
 * | `renameSession(path, name)` | 往那个会话文件追加一条 `session_info`（与 pi 同一个 entry type） |
 * | 删除 | 官方自己删会话文件（先 `trash` 再 `unlink`）；**轨迹文件它不管**，我们从外部补 |
 * | `keybindings` | `installProjectKeybindings()`，并装到 pi-tui 全局 |
 * | `currentSessionFilePath` | 当前会话文件 —— 官方用它把「正在用的这条」染成 accent 色**并拒绝删它** |
 *
 * ## 搜索**不**扫全文（有意与 pi 不同）
 *
 * 官方 `SessionInfo.allMessagesText` 是把整个会话文件读出来拼的，`fuzzyMatch` 拿它当
 * 检索面 —— 所以「搜历史里聊过的那句话」在 pi 里能命中。
 *
 * 我们给**空字符串**：能搜 id、名字、cwd、标题（第一条 user 消息）。理由是
 * docs/architecture/sessions.md 里那条已经付出过代价的结论 —— 124 个会话 / 18MB，
 * 为了搜索而全量 parse 就是「打开面板要等一分钟」。要找回某句话，用 `rg` 搜
 * `~/.pi/agent/sessions` 比在一个 40 字符的模糊搜索框里捞更快更准。
 *
 * ## 弹窗开着时 `onInput` 必须让路（见 `app.ts` 那里的注释）
 *
 * pi-tui 的 `inputListeners` 在**聚焦组件之前**跑（`tui.js` 的 `handleInput`），而
 * `app.ts` 的 `onInput` 无条件处理轨迹页切换 / 展开工具 / 队列模式 / 中断这四个键。
 * 致命的那条是中断（默认 `ctrl+c`）：空闲时它 `process.exit(0)`，在弹窗里按一下
 * 「取消」整个界面就没了。
 */
import { existsSync, rmSync } from 'node:fs';
import {
  SessionSelectorComponent,
  type SessionInfo,
} from '@earendil-works/pi-coding-agent';
import type { SessionListProgress } from '@earendil-works/pi-coding-agent/dist/core/session-manager.js';
import type { ViewportTUI } from '@earendil-works/pi-tui';
import { listSessions, findTraceFile, type SessionSummary } from '@ela/core/config-home';
import { appendSessionName } from '@ela/core/session-file';
import { installProjectKeybindings } from './keybindings';
import { composerOverlayOptions } from './composer-overlay';
import { readSessionMessages } from '@ela/core/session-file';

/** `SessionSelectorComponent` 的两个 loader 的第一个参数（进度回调）。 */
type Progress = SessionListProgress;

export interface SessionPickerOptions {
  tui: ViewportTUI;
  /**
   * 当前会话文件（`sessions/<cwd 编码>/<时间戳>_<id>.jsonl`）。
   *
   * 官方用它做两件事：把「正在用的这条」染成 accent 色，以及**拒绝删它**
   * （`Cannot delete the currently active session`）。后一条正是我们要的 ——
   * 当前会话文件正被记录器开着，删掉的话之后的消息无处可写。
   */
  currentSessionFile?: string | undefined;
  /** 当前进程的工作目录（决定 `Current Folder` 作用域里有哪些）。 */
  cwd: string;
  /** 选定了某个会话。 */
  onPick(session: SessionSummary): void;
  /** Esc 关闭。 */
  onCancel?(): void;
  /**
   * 官方把会话文件删掉之后调它（用来连带清 `traces/`，见文件头）。
   *
   * 为什么**不在** `renameSession` 那样挂一个 hook：删除是官方**自己**按事件绑的
   * （`sessionList.onDeleteSession`），我们只能在它跑完之后包一层。
   */
  onSessionDeleted?(session: SessionSummary): void;
}

/**
 * `SessionSummary` → 官方 `SessionInfo`。
 *
 * ## `modified` 用「最后一次说话」，不是文件 mtime
 *
 * 官方用它排「N 分钟前」并作为默认排序依据。文件 mtime 会被**任何**写入改动 ——
 * 包括追加一条 `model_change`、包括用户改名。而「我半小时前说过话」这个事实不该被
 * 一次改名改掉。所以取「最后一条 user/assistant 消息的时间」（`readJsonlTail` 算的），
 * 读不到才退回 mtime（只有 header 的空壳会话就是这种）。
 */
function toSessionInfo(session: SessionSummary, title: string): SessionInfo {
  const modifiedMs = session.lastActivityMs || session.mtimeMs;
  const createdMs = session.createdAt === undefined ? Number.NaN : Date.parse(session.createdAt);
  return {
    path: session.file,
    id: session.id,
    cwd: session.cwd,
    ...(session.name !== undefined ? { name: session.name } : {}),
    ...(session.parentSession !== undefined ? { parentSessionPath: session.parentSession } : {}),
    created: new Date(Number.isNaN(createdMs) ? modifiedMs : createdMs),
    modified: new Date(modifiedMs),
    messageCount: session.entries,
    firstMessage: title,
    // 有意给空串 —— 见文件头「搜索不扫全文」。
    allMessagesText: '',
  };
}

/**
 * 标题：会话的第一条 user 消息（就是官方的 `firstMessage`）。
 *
 * 取自 `SessionSummary.firstMessage` —— `listSessions()` 那一遍读头部 512KB 找
 * `session_info` 时顺手带出来的（见 `readSessionMeta`）。这里**不再自己扫文件**：
 * 早先按 512KB 单独扫一遍，虽然够用，但等于每个会话多读一份头部。
 */
function sessionTitleOf(session: SessionSummary): string {
  const first = session.firstMessage;
  return first === undefined || first === '' ? '(空会话)' : first;
}

/**
 * loader：`listSessions()` + 标题 → `SessionInfo[]`。
 *
 * 官方 loader 是 `async` 的（它内部流式读、并发 10、带进度）。我们是同步的 —— `listSessions()`
 * 必须在**同步路径**上算完（见 docs/architecture/sessions.md 里 124 会话 / 18MB 那段），
 * 于是这个函数只是把它包成一个已完成的 promise：弹窗当帧就有内容，不闪「Loading ...」。
 *
 * `onProgress` 仍然**如实**调一次（loaded = total）。官方用它画那一栏进度；
 * 我们是一次性的，所以进度条从不存在 —— 这比一个假进度条诚实。
 */
function loadSessions(filter: { cwd?: string } | undefined, onProgress?: Progress): Promise<SessionInfo[]> {
  const sessions = listSessions(filter);
  const out = sessions.map((s) => toSessionInfo(s, sessionTitleOf(s)));
  onProgress?.(out.length, out.length, out);
  return Promise.resolve(out);
}


/**
 * 官方 `SessionList` 的那一个字段（`onDeleteSession`）。
 *
 * 它在 `.d.ts` 里是 `private`，但**运行时是普通字段**（TS 的 `private` 不影响 JS 对象）。
 * 所以这里按形状取，不 cast 成官方类型 —— 官方改了字段名我们就会看到（`in` 判 false，
 * 于是只是不补轨迹清理，不崩）。
 */
interface DeletableSessionList {
  onDeleteSession?: ((sessionPath: string) => Promise<void>) | undefined;
  setSessions?(sessions: SessionInfo[], showCwd: boolean): void;
}

/**
 * 打开历史会话选择弹窗。
 *
 * @returns 弹窗的关闭函数（调用方可提前关掉，比如恢复完成后重建界面）。
 */
export function openSessionPicker(options: SessionPickerOptions): () => void {
  const { tui } = options;
  const cwd = options.cwd || process.cwd();

  // 装键位表到 pi-tui 全局。
  //
  // **为什么必须做**：`SessionList` / `Input` 判键走的是 pi-tui 的 `getKeybindings()`，
  // 它默认只含 `TUI_KEYBINDINGS`。而 `app.session.*`（toggleSort / rename / delete…）
  // 是 **pi 应用层**定义的 —— 不装的话 `kb.matches(data, 'app.session.rename')` 恒为
  // false，于是 `ctrl+r` **静默失效**（连那行提示都会一起消失 —— 它也是用同一个
  // keybindings 渲染的，于是症状是「面板里没写有 rename」而不是「按了没反应」）。
  //
  // 用 `installProjectKeybindings()`（= pi 的全套 + 本项目自己的动作）而不是 pi 的
  // `KeybindingsManager.create()`：两者都读同一份 `~/.pi/agent/keybindings.json`，
  // 但后者**不含** `app.trace.toggle` 那一组 —— 装上去之后顶行那块 `(Ctrl+R)`
  // 会变成 `()`（查不到这个动作），而这是开着面板时才出现的症状。
  //
  // 与 pi 一样**不做** `ctrl+r` 在面板内（重命名）与面板外（轨迹页）的冲突检查：
  // 面板打开时本项目那四个全局键整个让路（`onInput` 开头的 `hasOverlay()` 早返回），
  // 两者不会同时生效。
  //
  // 返回值继续往下传：官方组件的构造参数要它（`SessionSelectorComponent` 的
  // `keybindings`），它内部的 `Input` / `SessionList` 用同一份判键。
  const keybindings = installProjectKeybindings();

  /** 当前 scope 下已加载的摘要（`onPick` 按**文件路径**回查用）。 */
  let listed: SessionSummary[] = listSessions();
  const byPath = (file: string): SessionSummary | undefined => listed.find((s) => s.file === file);

  let closed = false;
  let handle: { hide(): void } | undefined;
  const close = (): void => {
    if (closed) return;
    closed = true;
    handle?.hide();
  };

  // 首帧：**同步**给一份当前 scope 的内容。
  //
  // 官方组件从空列表起步、自己 `void this.loadScope('current')`，那一次 load 要走完
  // 一个 promise 才出内容 —— 于是首帧是「Loading ...」然后才跳出来。这里先把同步那份
  // 塞进去，省掉那次跳。官方随后的 load 会用**同样的**数据覆盖（幂等）。
  const currentSessions = listed.map((s) => toSessionInfo(s, sessionTitleOf(s)));

  const selector = new SessionSelectorComponent(
    // scope = current：只有 cwd 是当前进程那个目录的会话。
    (onProgress, signal) => {
      signal?.throwIfAborted();
      listed = listSessions({ cwd });
      return loadSessions({ cwd }, onProgress);
    },
    // scope = all：sessions/ 下**所有** `--<cwd>--` 目录（别的项目的会话）。
    (onProgress, signal) => {
      signal?.throwIfAborted();
      listed = listSessions();
      return loadSessions(undefined, onProgress);
    },
    (path) => {
      const session = byPath(path);
      close();
      if (session) options.onPick(session);
    },
    () => {
      close();
      options.onCancel?.();
    },
    // `onExit`：官方只用它在「自己的输入框被清空」时收尾，我们没有那套编辑器语义。
    () => {},
    () => {
      tui.requestRender();
    },
    {
      renameSession: async (path, nextName) => {
        const sanitized = (nextName ?? '').trim();
        appendSessionName(path, sanitized);
        // 重命名之后官方会 `refreshSessionsAfterMutation()`（重新 load 一次 scope），
        // 所以这里**不用**自己刷 —— 但本地缓存要更新，否则 `Name: Named` 那一档在下一次
        // scope 切换之前还按旧名字过滤。
        const target = byPath(path);
        if (target) target.name = sanitized === '' ? undefined : sanitized;
      },
      showRenameHint: true,
      keybindings,
    },
    options.currentSessionFile,
  );

  // 删完的收尾：官方**自己**按事件绑了 `onDeleteSession`（先 `trash` 再 `unlink` 会话文件），
  // 我们在外面包一层，拿到「被删的是哪一条」之后补删 `traces/<时间戳>_<id>.jsonl`。
  //
  // **为什么必须连带删轨迹**：一个会话在盘上落两处（`sessions/…` 与 `traces/<时间戳>_<id>.jsonl`），
  // 而轨迹那份才是真正占空间的。只删前者的话 `traces/` 会一直攒着几万个小文件 ——
  // `packages/core/test/clean-sessions.test.ts` 钉的就是这条不变量。
  //
  // 顺带把 `listed` 里那条摘掉：否则用户在同一次弹窗里删两次同一个会话时，
  // `onSessionDeleted` 会被调第二次（`rmSync(force: true)` 不抛，于是**误删轨迹**）。
  const list = (selector as unknown as { sessionList?: DeletableSessionList }).sessionList;
  const originalDelete = list?.onDeleteSession;
  if (list && originalDelete) {
    list.onDeleteSession = async (path) => {
      const deleted = byPath(path);
      await originalDelete.call(list, path);
      if (deleted) {
        listed = listed.filter((s) => s.file !== path);
        options.onSessionDeleted?.(deleted);
      }
    };
  }

  // 首帧内容（官方随后自己 load 一遍，幂等覆盖）。
  try {
    list?.setSessions?.(currentSessions, false);
  } catch {
    // 官方改了内部形状就算了 —— 它自己会 load，代价只是闪一下「Loading」。
  }

  // 覆盖层：**盖住 composer**（不是居中浮窗）—— 满宽、底边与 composer 底边齐平，
  // 与 pi 的 `showSelector()` 换掉 `editorContainer` 内容同一形状。
  // 为什么这么摆、`margin.bottom` 为什么跟着底栏走，见 `composer-overlay.ts`。
  handle = tui.showOverlay(selector, composerOverlayOptions());

  return close;
}

/** 删掉一条会话的轨迹文件（`traces/<时间戳>_<id>.jsonl`）。删不掉不算失败 —— 清理是尽力而为。 */
export function deleteSessionTrace(session: SessionSummary): boolean {
  const file = findTraceFile(session.id);
  if (!existsSync(file)) return true;
  try {
    rmSync(file, { force: true });
    return true;
  } catch {
    // Windows 上文件可能被索引器/编辑器短暂占着。留着比让整个删除流程炸掉好 ——
    // 用户看到的是「会话删了」，轨迹那份留着占几百 KB（下次它自己能删时再说）。
    return false;
  }
}

/** 读一个会话的消息（供调用方恢复）。 */
export function loadSessionMessages(session: SessionSummary) {
  return readSessionMessages(session.file);
}
