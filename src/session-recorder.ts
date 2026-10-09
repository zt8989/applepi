/**
 * 会话记录器 —— 把对话写成 `sessions/<cwd>/<id>.jsonl`，供「恢复历史」用。
 *
 * ## 与轨迹的分工
 *
 * | | 轨迹（traces/） | 会话（sessions/） |
 * | --- | --- | --- |
 * | 记什么 | 一次尝试一节点（含失败/超时） | 消息流（user / assistant / toolResult） |
 * | 给谁看 | 排查「为什么慢/错了」 | 「上次聊到哪了」 |
 * | 恢复 | 重建轨迹树 | 重建 messages，零 token |
 *
 * 两者是**并行的两份记录**，不是一份的两种视图：轨迹里有节点但没有完整消息正文
 * （错误节点的 detail 是错误信息），会话里有消息但没有 attempt 的时间线。
 *
 * ## 为什么不放到一起
 *
 * 轨迹是每次对话的产物、落盘频繁；会话是给人读的历史。混在一个文件里的话，
 * 「读一个会话」得先跳过一堆与它无关的 attempt 记录。
 *
 * ## 写入时机
 *
 * 订阅 store —— 和轨迹落盘器一样的形状。**每条消息只在第一次出现时写一次**
 * （用已写条数做游标），否则流式更新会把同一条 message 写几十遍。
 */
import { createSessionHeader, resetEntrySeq, entrySeqValue, SessionWriter } from './session-file';
import { sessionPath } from './config-home';
import type { Message } from '@earendil-works/pi-ai';
import type { AgentState } from './state';
import type { AgentAction } from './actions';

export interface SessionRecorderOptions {
  sessionId: string;
  cwd: string;
  /** 传 null 就不写会话文件（只落轨迹）。 */
  enabled: boolean;
}

export interface SessionRecorder {
  readonly file: string;
  /** 已写入的消息条数。 */
  written(): number;
  dispose(): void;
}

/**
 * 挂一个会话记录器到 store 上。
 *
 * 恢复已有会话时传 `resumeFrom`：那之后的旧消息已经在文件里，游标要接着算，
 * 否则会把恢复出来的消息**再写一遍**。
 */
export function createSessionRecorder(
  store: {
    getState(): AgentState;
    subscribe(listener: () => void): () => void;
  },
  options: SessionRecorderOptions & { resumeFrom?: number },
): SessionRecorder | null {
  if (!options.enabled) return null;

  const writer = new SessionWriter(options.sessionId, options.cwd);
  writer.start(createSessionHeader({ id: options.sessionId, cwd: options.cwd }));

  let written = options.resumeFrom ?? 0;
  // 恢复的会话接着往下编 entry id，不能从头再来（会和文件里已有的撞）。
  if (options.resumeFrom !== undefined && options.resumeFrom > 0) {
    resetEntrySeq(options.resumeFrom);
  }

  /**
   * 已在盘上的「上一次模型」是什么。
   *
   * **建表时就记成「当前那个」**（而不是 `null`）：`model_change` 的语义是
   * 「**换**成了什么」，而不是「这个会话用的是什���」。开机那个模型从来没换过，
   * 写一条等于谎报。恢复场景（`resumeFrom > 0`）同样如此 —— 那一段的
   * `model_change` 已经在文件里了。
   *
   * 不去重会怎样：订阅器**每帧**都跑，一次 `/model` 能写出几百条 —— 而会话文件
   * 恰好是「打开 `/sessions` 面板要扫」的那些文件之一。
   */
  const modelKeyOf = (s: AgentState): string => `${s.model.provider}\0${s.model.modelId}`;
  let lastModelKey = modelKeyOf(store.getState());

  const flush = (): void => {
    const state = store.getState();
    // 模型换了要记一条（与 pi 同一个 entry type，pi 恢复时也认）。
    //
    // 为什么**在**这里而不在 `onModelChange` 回调里：那个回调字段早先是声明了但
    // 没人调的（没有调用方传它），于是「换模型」这个事实**从来没进过会话文件** ——
    // 恢复历史时看到的是一串消息，却不知道中间哪一段用的哪个模型。有一条能真跑的
    // 路之后，回调字段就多余了，删掉比留一个永远不触发的钩子诚实。
    const modelKey = modelKeyOf(state);
    if (modelKey !== lastModelKey) {
      writer.appendModelChange(state.model.provider, state.model.modelId);
      lastModelKey = modelKey;
    }
    for (let i = written; i < state.messages.length; i += 1) {
      const message = state.messages[i];
      if (!message) continue;
      writer.appendMessage(message);
      written = i + 1;
    }
  };

  const unsubscribe = store.subscribe(flush);
  // 建表时可能已经有消息（恢复场景），先补一次。
  flush();

  return {
    file: sessionPath(options.sessionId, options.cwd),
    written: () => written,
    dispose(): void {
      unsubscribe();
      // 结束时把 entry 游标对齐到实际写入数（resumeFrom 时尤其重要）。
      resetEntrySeq(Math.max(entrySeqValue(), written));
    },
  };
}

/** 从 state 里挑出「用户说过的话」，用来在列表里显示会话标题。 */
export function firstUserText(messages: readonly Message[], maxLength = 40): string {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const text =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((c) => ('text' in c ? c.text : '[image]')).join(' ')
          : '';
    const line = text.trim().split('\n')[0] ?? '';
    return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
  }
  return '(空会话)';
}

export type { AgentAction };
