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
  /** 模型变化时记一条（恢复历史时能看出当时用的哪个模型）。 */
  onModelChange?(entry: { provider: string; modelId: string }): void;
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

  const flush = (): void => {
    const state = store.getState();
    // 模型换了要记一条 —— 恢复历史时得知道当时用的是哪个模型。
    const last = state.messages[state.messages.length - 1];
    void last;
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
