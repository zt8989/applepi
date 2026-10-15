/**
 * Store 装配 —— redux-loop 的 install() enhancer 负责：
 * 把 reducer 返回的 Cmd 执行掉，再把 success/fail action dispatch 回来。
 * Agent Loop 就是这个环：user.message → LLM → 工具 → LLM → … → idle。
 *
 * 装配只做一件事：选一张 effect 表。
 * - piAiEffectTable：LLM 与工具都自己跑（CLI；也是 Web 里的纯 Redux 环）。
 * - 传 effects 进来：调用方自己接线（Web 侧用 agent-driven 表）。
 */
import { createStore } from 'redux';
import type { Store } from 'redux';
import { install } from 'redux-loop';
import { createAgentReducer, loopWiring, type ReducerEffects } from './reducer';
import { createInitialState, type AgentState } from './state';
import type { AgentAction } from './actions';
import type { ThinkingBudgets } from '@earendil-works/pi-ai';
import { createPiAiEffectTable, type EffectTable, type ToolCallGate } from './effects';
import { getTools } from './tools';
import { defaultStreamFn, type AgentRuntime, type StreamFn } from './provider';
import { createTracePersistence, type TracePersistence, type TraceSink } from './trace-store';
import { decideCompaction } from './compact';

export type AgentStore = Store<AgentState, AgentAction>;

/** 一个装配好的 store + （可选的）轨迹落盘器。 */
export interface AgentStoreHandle {
  store: AgentStore;
  persistence: TracePersistence | null;
  /** 自动压缩的订阅器（dispose 时要一并退订，否则关掉内核后还在跑）。 */
  autoCompact: AutoCompact | null;
}

/**
 * 自动上下文压缩：盯住「一个回合结束」，判定超了没有，超了就发 `compact.request`。
 *
 * ## 为什么是 store 订阅器而不是接线里的一个 action
 *
 * 压缩**必须**在环彻底停下来的时候发起（`phase === 'idle'`）—— 压缩要整份换掉 messages，
 * 而在 LLM 还在流 / 工具还在跑时换，那条流回来就找不到自己的 toolCall 了。
 *
 * 而「环停下来的那一刻」在 redux-loop 里没有一个对应的 action：`llm.done`（无工具时）
 * 之后环**不是**由某条 action 闭合的，只是没有更多 Cmd 了。写一个「回合结束」action
 * 会要求所有收尾路径都记得 dispatch 它 —— 而漏掉一次的后果是压缩永远不触发。
 *
 * 订阅器盯 `phase` 从非 idle 变成 idle，**不漏路径**：环怎么停的它都看得到。
 *
 * ## 为什么不在 reducer 里判
 *
 * reducer 是纯函数，不能读时间也不能发起副作用。「要不要压」这个判定要读
 * `state.messages` 的最后一条 usage —— 那是 state，做得到。但「压」这件事要花钱打网络，
 * 必须是 Cmd。所以：判定留在 reducer/Cmd 之外（这里），执行留在 effect 里。
 */
export interface AutoCompact {
  dispose(): void;
  /** 现在开着吗（`/settings` 面板那一行读它）。 */
  enabled(): boolean;
  /** 开/关，**立即生效**（关掉之后不再自动压，手动 `/compact` 仍然能用）。 */
  setEnabled(enabled: boolean): void;
}

/**
 * 盯住「环刚停下来」那一刻判要不要压。
 *
 * @param supported 表里有没有 `runCompact` —— 没有就是不支持压缩（Web 侧自带表时可能是这样），
 *                  那时**连开关都不该给**（一个什么都压不了的开关就是谎），所以返回 `null`。
 * @param enabled   初始开关（`settings.json` 的 `compaction.enabled`，pi 的默认是 `true`）。
 */
export function createAutoCompact(options: {
  store: AgentStore;
  supported: boolean;
  enabled?: boolean | undefined;
}): AutoCompact | null {
  if (!options.supported) return null;
  const { store } = options;
  //
  // 可变（而不再是构造时定死）：`/settings` 面板里的 Auto-compact 那一行能当场开关它。
  // 开关只影响**自动**压缩 —— `compact.request` 是手动路径，不该被一个「关掉自动」的
  // 开关拦住（那正是「关掉自动压缩」而不是「禁用压缩」）。
  //
  let enabled = options.enabled ?? true;

  /**
   * 上一次看到的状态是不是「在跑」。
   *
   * 订阅器是在 reducer **之后**跑的，所以它只能看到「已经停下来」的状态 ——
   * 看不到刚刚停下的那一刻。要判断「刚刚停下的那一刻」就得**记住上一次**：
   * 上一次还在跑、这一次 idle ⇒ 环刚闭合，这就是唯一需要判定的时机。
   *
   * 为什么不能每次 idle 都判：那会在压缩刚完成（也会变 idle）时又判一次，
   * 而压缩刚做完上下文已经小了 —— 虽然 `shouldCompact` 大概会返回 false，
   * 但多一次没必要的判定就是多一个「为什么压了两次」的可能性。
   */
  let wasRunning = false;
  /** 已经压过的那一轮（用 messages 长度当粗粒度标记）：压完不再对同一批历史重复压。 */
  let compactedAtLength = -1;

  const check = (): void => {
    const state = store.getState();
    const running = state.phase !== 'idle';
    const justStopped = wasRunning && !running;
    wasRunning = running;
    // 只在「刚刚停下来」的那一下判：否则每一条 delta、每一次 store 变化都会重算一遍。
    if (!justStopped) return;
    // 关掉时不做任何判定 —— `/settings` 里刚关掉的那一轮不该还压一次。
    if (!enabled) return;
    if (state.compacting) return;

    const decision = decideCompaction({ state, settings: state.compactionSettings });
    // `manual` 是「用户主动要求」，自动路径永远不该出现它（出现就是判定逻辑写错了）。
    if (!decision.should || decision.reason === null || decision.reason === 'manual') return;
    // 压过同一批历史就不再压：压完还是超说明 reserve 给少了，再压一次是同样结果、白花钱。
    if (compactedAtLength === state.messages.length) return;
    compactedAtLength = state.messages.length;
    store.dispatch({ type: 'compact.request', reason: decision.reason });
  };

  const unsubscribe = store.subscribe(check);
  return {
    dispose: unsubscribe,
    enabled: () => enabled,
    setEnabled: (next: boolean) => {
      enabled = next;
    },
  };
}

export interface CreateAgentStoreOptions {
  runtime: AgentRuntime;
  /**
   * 初始 system prompt（占位）。
   *
   * **通常不用给** —— 真的 prompt 由 `prompt.init` 装（那才是发给模型的那份，
   * 由 pi 的 `buildSystemPrompt` 拼，见 [system-prompt.ts](system-prompt.ts)）。
   * 这里给的只进 `createInitialState` 的初始值，活不过第一条 `prompt.init`。
   *
   * 只有「不 dispatch `prompt.init` 就直接跑」的测试/脚本需要它。
   */
  systemPrompt?: string | undefined;
  maxTurns?: number | undefined;
  /** 一次 LLM 调用的超时（毫秒）；超时按可重试错误处理。 */
  llmTimeoutMs?: number | undefined;
  /** 工具的工作目录（官方工具用它做路径边界检查）。不给则用 process.cwd()。 */
  cwd?: string | undefined;
  /** 单轮内最多几次 LLM 尝试（含首次），2 = 失败后重试一次。 */
  maxLlmAttempts?: number | undefined;
  /**
   * 各档思考级别的 token 预算（`settings.json` 的 `thinkingBudgets`）。
   * 开局给一次，之后每个请求原样带上（与 pi 的 Agent 同一步）—— 见 `effects.ts` 的注释。
   */
  thinkingBudgets?: ThinkingBudgets | undefined;
  /**
   * 自动压缩开局开着吗（`settings.json` 的 `compaction.enabled`，pi 的默认是 `true`）。
   * 不给就是 `true`；给 `false` 时压缩器仍然装好（`/settings` 里能再打开）。
   */
  autoCompactEnabled?: boolean | undefined;
  /** 注入会话 id（决定持久化文件名；默认按时间生成）。 */
  sessionId?: string | undefined;
  /** 测试注入假 streamFn 用；默认走 pi-ai。 */
  streamFn?: StreamFn | undefined;
  /** 轨迹落盘器（JSONL 追加写）。不给就是纯内存，不落盘。 */
  traceSink?: TraceSink | undefined;
  /** 轨迹落盘失败时的回调（磁盘满 / 权限 / localStorage 配额）。 */
  onTraceError?: ((error: unknown) => void) | undefined;
  /** 自定义 effect 表（Web 用）；不给就用 pi-ai 表。 */
  effects?: EffectTable | undefined;
  /**
   * 工具执行前的门（`tool_call`）：MCP 等服务器、权限扩展阻止调用。
   * 只在走 pi-ai 表（不给 `effects`）时生效。
   */
  onToolCall?: ToolCallGate | undefined;
  /** 完全自定义 reducer 接线（测试用）。 */
  reducerEffects?: Partial<ReducerEffects> | undefined;
}

/** 把一张 effect 表翻译成 reducer 要的「action type → Cmd[]」接线表。 */
export const effectTableToReducerEffects = loopWiring;

export function createAgentStore(options: CreateAgentStoreOptions): AgentStore {
  return createAgentStoreWith(options).store;
}

/**
 * 建 store 并把自动压缩的订阅器一起装好。
 *
 * ## 为什么自动压缩装在这里，而不是 `createPersistentStore`
 *
 * 因为它与「要不要落盘」**无关** —— 压缩是功能，落盘是持久化。
 * 早先只在 `createPersistentStore` 里装，于是直接用 `createAgentStore` 的调用方
 * （测试、以及任何只要内存 store 的人）**永远收不到自动压缩**，而症状是
 * 「长会话一直撞窗口」且没有任何地方提到过压缩 —— 极难归因。
 *
 * 落盘那条路仍然走 `createPersistentStore`，它多做一件事（挂轨迹落盘器）。
 */
export function createAgentStoreWith(options: CreateAgentStoreOptions): AgentStoreHandle {
  const { runtime, systemPrompt, maxTurns, streamFn, effects, reducerEffects, sessionId } = options;

  const table: EffectTable =
    effects ??
    createPiAiEffectTable({
      streamFn: streamFn ?? defaultStreamFn(runtime),
      model: runtime.model,
      // **每次请求现取**模型（而不是捕获建表那一个）—— /model 换了模型之后
      // 下一个回合必须真的发给新的那个。症状见 `effects.ts` 的 `resolveModel` 注释。
      resolveModel: (state) => runtime.models.getModel(state.model.provider, state.model.modelId),
      ...(options.thinkingBudgets !== undefined ? { thinkingBudgets: options.thinkingBudgets } : {}),
      ...(options.onToolCall !== undefined ? { onToolCall: options.onToolCall } : {}),
    });

  const initialState = createInitialState({
    // `prompt.init` 会立刻覆盖它（那是唯一真正发给模型的那份）。给不给都不影响行为，
    // 但走同一个字段名，免得两处各叫一个「systemPrompt」而其中一个是假的。
    systemPrompt: systemPrompt ?? '',
    providerName: runtime.spec.provider,
    modelId: runtime.model.id,
    // 工具按 cwd 建（官方工具用它做路径边界检查）。
    toolNames: getTools(options.cwd ?? process.cwd()).map((tool) => tool.name),
    // 会话身份里的 cwd 与上面建工具用的是同一个（`state.session.cwd`）——
    // 界面上显示的「工作目录」、工具的边界、`/api` 读 settings 的作用域，
    // 三者必须是同一个值。
    cwd: options.cwd ?? process.cwd(),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(options.llmTimeoutMs !== undefined ? { llmTimeoutMs: options.llmTimeoutMs } : {}),
    ...(options.maxLlmAttempts !== undefined
      ? { maxLlmAttempts: options.maxLlmAttempts }
      : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  });

  const reducer = createAgentReducer({
    ...effectTableToReducerEffects(table),
    ...(reducerEffects ?? {}),
  });

  // redux-loop 的 install() 让 Store 认识 Loop reducer 的返回形状。
  // 失败已由 failActionCreator 转成 action（进了状态树），不必再往控制台喷。
  const store = createStore(
    reducer as never,
    initialState as never,
    install<AgentState>({ DONT_LOG_ERRORS_ON_HANDLED_FAILURES: true }) as never,
  ) as unknown as AgentStore;
  // 自动压缩：只在**能**压的时候装（表里没有 runCompact 就是不支持压缩，
  // 那时装上去只会发一条没人接的 request）。
  const autoCompact = createAutoCompact({
    store,
    supported: table.runCompact !== undefined,
    ...(options.autoCompactEnabled !== undefined ? { enabled: options.autoCompactEnabled } : {}),
  });
  return { store, persistence: null, autoCompact };
}

/**
 * 装一个会**把轨迹落盘**的 store。
 *
 * `createAgentStore` 保持只返回 store（测试里要的就是 store 本身），
 * 需要持久化时用这个，它额外挂一个订阅器把新节点追加写进 sink。
 *
 * 错误节点同样会被写进去 —— 落盘器对成功与失败一视同仁。
 */
export function createPersistentStore(options: CreateAgentStoreOptions): AgentStoreHandle {
  const handle = createAgentStoreWith(options);
  if (!options.traceSink) return handle;
  const persistence = createTracePersistence({
    store: handle.store,
    sink: options.traceSink,
    ...(options.onTraceError ? { onError: options.onTraceError } : {}),
  });
  return { ...handle, persistence };
}

/**
 * 等一回合跑完（phase 回到 idle）——CLI 与测试都用它来等待环形流转结束。
 */
export function waitForIdle(store: AgentStore, timeoutMs = 10 * 60 * 1000): Promise<AgentState> {
  if (store.getState().phase === 'idle') return Promise.resolve(store.getState());
  return new Promise<AgentState>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('等待回合结束超时'));
    }, timeoutMs);
    const unsubscribe = store.subscribe(() => {
      if (store.getState().phase === 'idle') {
        clearTimeout(timer);
        unsubscribe();
        resolve(store.getState());
      }
    });
  });
}

