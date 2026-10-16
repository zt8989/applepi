/**
 * 会话记录器 —— 把对话写成 `sessions/<cwd>/<时间戳>_<id>.jsonl`，供「恢复历史」用。
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
   * 没给（新会话）或给 `false`（老会话没记过这一档）→ 写第一条消息时**回填一条**，
   * 与 pi 的 `sdk.js:279-283` 是同一件事（「Restore missing settings metadata for older
   * sessions」那段）。不给的话，恢复一个老会话之后它永远不知道自己用哪一档，
   * 而「不知道」在 pi 那里会被当成「新会话」 —— 于是 per-model 覆盖被跳过（见
   * `thinking-level.ts` 里 `resolveStartupThinkingLevel` 第 3 步）。
   *
   * ## 与 pi 的一处**时间差**（刻意）
   *
   * pi 在会话建立那一刻就把这行写下去（它的会话文件本来就一直存在）；本项目是
   * 「空会话不落盘」，所以回填推迟到**真的要写文件时**（第一条消息 / 档位真的变了）。
   * 后果只有一个：恢复一个老会话又直接退出，盘上不会多这一行 —— 而下次恢复仍然按
   * 默认解析拿到同一档，行为上看不出差别。换来的是那条硬挣来的不变式：
   * **恢复不写盘**（见 `packages/core/test/restore-perf.test.ts`「会话文件一个字节都不该变」）。
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
 * 形状与发给 provider 的 head 一模一样（`buildPromptHead`，见 `prompt-head.ts`）——
 * pi 恢复会话时正是靠它 `_restoreToolsFromTranscript()` 把工具表装回来，并回放出
 * system prompt 的各段。用**装载时**那批工具（`headTools`，不可变历史），不是「当前」那份。
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
  /**
   * 是不是**新会话**（不是恢复已有文件）。
   *
   * 只有新会话才产出开头的两样 v3 内容：`model_change` 与 head system 消息。
   * 恢复时那两样要么已经在文件里（pi/我们写的 v3），要么压根没有（v1 老文件）——
   * 无论哪种都不该在**文件末尾**补一条（head 必须是最前面那条，append 补不到那儿）。
   */
  const isNewSession = options.resumeFrom === undefined;

  /**
   * 上一次**已经写进文件**的模型（用来判断「换没换」）。
   *
   * **建表时就记成「当前那个」**（而不是 `null`）：`model_change` 的语义是
   * 「**换**成了什么」。新会话开头那条初始 `model_change` 由 `pendingInitialModel`
   * 单独负责（pi 也在开头写一条）；这里只管「后来了又换过」。
   *
   * 不去重会怎样：订阅器**每帧**都跑，一次 `/model` 能写出几百条 —— 而会话文件
   * 恰好是「打开 `/sessions` 面板要扫」的那些文件之一。
   */
  const modelKeyOf = (s: AgentState): string => `${s.model.provider}\0${s.model.modelId}`;
  let lastModelKey = modelKeyOf(store.getState());
  // 新会话开头补一条初始 `model_change`（与 pi 一样）。恢复时不补（文件里已有或本来就没有）。
  let pendingInitialModel = isNewSession;

  /**
   * 这个会话**开始时**用哪一档，以及「这条记录还没写进文件」。
   *
   * pi 在会话建立那一刻就把「这个会话用哪一档」写进文件（`core/sdk.js:279-290`），
   * 而本项目**空会话不建文件**（见 `SessionWriter.start`：header 推迟到第一条消息）。
   * 所以这里记着它、推迟到真的要写文件时再落 —— 文件内容与 pi 同形
   * （header → `model_change` → `thinking_level_change` → head → 消息），
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
    // 模型换了要记一条（与 pi 同一个 entry type，pi 恢复时也认）。
    //
    // 为什么**在**这里而不在 `onModelChange` 回调里：那个回调字段早先是声明了但
    // 没人调的（没有调用方传它），于是「换模型」这个事实**从来没进过会话文件** ——
    // 恢复历史时看到的是一串消息，却不知道中间哪一段用的哪个模型。有一条能真跑的
    // 路之后，回调字段就多余了，删掉比留一个永远不触发的钩子诚实。
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
