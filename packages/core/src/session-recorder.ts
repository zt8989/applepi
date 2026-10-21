/**
 * 会话记录器 —— 把对话写成 `sessions/<cwd>/<时间戳>_<id>.jsonl`，供「恢复历史」用。
 *
 * 与轨迹是**并行的两份记录**，不是一份的两种视图：轨迹一次尝试一节点（排查「为什么慢/错了」，
 * 能重建轨迹树），会话是消息流（「上次聊到哪了」，能零 token 重建 messages）。分开是因为
 * 轨迹落盘频繁，混在一起的话「读一个会话」得先跳过一堆无关的 attempt 记录。
 *
 * 写入时机：订阅 store。**每条消息只在第一次出现时写一次**（用已写条数做游标），
 * 否则流式更新会把同一条 message 写几十遍。
 */
import { createSessionHeader, SessionWriter } from './session-file';
import { buildPromptHead, declaredToolSchemas } from './prompt-head';
import type { Message, SystemMessage } from '@earendil-works/pi-ai';
import type { AgentState } from './state';
import type { AgentAction } from './actions';

export interface SessionRecorderOptions {
  sessionId: string;
  cwd: string;
  /** 传 null 就不写会话文件（只落轨迹）。 */
  enabled: boolean;
  /**
   * 恢复会话时：这个文件里**已经有** `thinking_level_change` 条目吗。
   *
   * 没给（新会话）或给 `false`（老会话没记过这一档）→ 写第一条消息时**回填一条**，否则
   * 恢复出来的会话不知道自己用哪一档，而「不知道」在 pi 那里等于「新会话」—— per-model
   * 覆盖会被跳过（见 `thinking-level.ts`）。
   *
   * 与 pi 的一处**时间差**（刻意）：pi 在会话建立那一刻就写这行，本项目「空会话不落盘」，
   * 所以回填推迟到**真要写文件时**。代价只是「恢复老会话又直接退出」时盘上少这一行，
   * 换来的是那条不变式：**恢复不写盘**（见 `restore-perf.test.ts`）。
   */
  hasThinkingEntry?: boolean | undefined;
}

export interface SessionRecorder {
  readonly file: string;
  /** 已写入的消息条数。 */
  written(): number;
  dispose(): void;
}

/**
 * pi v3 会话开头那条 **system 消息**：system prompt（`sections`）+ 工具（`toolsAdded`）。
 *
 * 形状与发给 provider 的 head 一模一样，pi 恢复会话时正是靠它把工具表与各段 prompt 装回来。
 * 用**装载时**那批工具（`headTools`，不可变历史），不是「当前」那份。
 */
function sessionHead(state: AgentState): SystemMessage {
  const head = buildPromptHead({
    systemPrompt: state.prompt.systemPrompt,
    ...(state.prompt.sections !== undefined ? { sections: state.prompt.sections } : {}),
    tools: declaredToolSchemas(state.prompt.headTools ?? state.prompt.tools),
  });
  return { ...head, timestamp: Date.now() };
}

/**
 * 挂一个会话记录器到 store 上。
 *
 * 恢复已有会话时传 `resumeFrom`（文件里已有几条消息）：游标要接着算，
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
  /**
   * 是不是**新会话**（不是恢复已有文件）。只有新会话才产出开头的 `model_change` 与 head
   * system 消息：恢复时那两样要么已在文件里，要么本来就没有 —— 无论哪种都不该补在**文件
   * 末尾**（head 必须是最前面那条，append 补不到那儿）。
   */
  const isNewSession = options.resumeFrom === undefined;

  /**
   * 上一次**已经写进文件**的模型（用来判断「换没换」）。
   *
   * 建表时就记成「当前那个」而不是 `null`：`model_change` 的语义是「**换**成了什么」，
   * 新会话开头那条由 `pendingInitialModel` 单独负责。不去重的话订阅器**每帧**都跑，
   * 一次 `/model` 能写出几百条 —— 而这个文件正是 `/resume` 面板要扫的。
   */
  const modelKeyOf = (s: AgentState): string => `${s.model.provider}\0${s.model.modelId}`;
  let lastModelKey = modelKeyOf(store.getState());
  // 新会话开头补一条初始 `model_change`（与 pi 一样）。恢复时不补（文件里已有或本来就没有）。
  let pendingInitialModel = isNewSession;

  /**
   * 这个会话**开始时**用哪一档，以及「这条记录还没写进文件」。
   *
   * pi 在会话建立那一刻就写进文件，而本项目**空会话不建文件**，所以推迟到真要写文件时再落
   * —— 文件内容与 pi 同形（header → `model_change` → `thinking_level_change` → head → 消息），
   * 而「进来看一眼就退出」仍然不留垃圾文件。
   */
  let lastThinkingLevel = store.getState().model.thinkingLevel;
  const initialThinkingLevel = lastThinkingLevel;
  let pendingInitialThinking = options.hasThinkingEntry !== true;
  // 新会话开头补一条 head（system prompt + tools）—— pi 的 v3 形状。恢复时不补（见 isNewSession）。
  let pendingHead = isNewSession;

  const flush = (): void => {
    const state = store.getState();
    const thinkingLevel = state.model.thinkingLevel;
    const thinkingChanged = thinkingLevel !== lastThinkingLevel;
    const pendingMessages = state.messages.length > written;
    const modelKey = modelKeyOf(state);
    const modelChanged = modelKey !== lastModelKey;

    // 初始化段（model_change / 回填档位 / head）只在「反正要写文件」时一次写全 ——
    // 马上要写消息、或档位/模型真的变了。都不是就不写：纯空会话不建文件
    // （恢复一个老会话也不动它，见 `hasThinkingEntry` 里那条「恢复不写盘」）。
    //
    // 顺序与 pi 一致：`model_change` → `thinking_level_change` → head。
    if (pendingMessages || thinkingChanged || modelChanged) {
      if (pendingInitialModel) {
        writer.appendModelChange(state.model.provider, state.model.modelId);
        lastModelKey = modelKey;
        pendingInitialModel = false;
      }
      if (pendingInitialThinking) {
        writer.appendThinkingChange(initialThinkingLevel);
        pendingInitialThinking = false;
      }
      if (pendingHead) {
        writer.appendMessage(sessionHead(state));
        pendingHead = false;
      }
    }
    // 级别变了要记一条（与 pi 同一个 entry type，pi 恢复时也认）。
    // 为什么在**这里**而不在键盘处理里：`thinking.changed` 有四个入口（Shift+Tab、
    // `/thinking` 面板、换模型时的重新解析、恢复会话），在各处各写一遍必然会漏一个 ——
    // 而漏掉的那一个的症状是「换了档位、恢复时又变回去了」。
    if (thinkingChanged) {
      writer.appendThinkingChange(thinkingLevel);
      lastThinkingLevel = thinkingLevel;
    }
    // 模型换了要记一条（与 pi 同一个 entry type）。为什么在**这里**而不在
    // 某个回调里：换模型有多个入口（`/model` 面板、换 provider、恢复会话），只有「盯着 state
    // 里那一刻的 model」才不会漏一个 —— 漏掉的那条就是「恢复时不知道中间用了什么模型」。
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
    file: writer.path,
    written: () => written,
    dispose(): void {
      unsubscribe();
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
