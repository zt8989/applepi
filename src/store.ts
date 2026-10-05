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
import { createPiAiEffectTable, type EffectTable } from './effects';
import { getTools } from './tools';
import { defaultStreamFn, type AgentRuntime, type StreamFn } from './provider';
import { createTracePersistence, type TracePersistence, type TraceSink } from './trace-store';

export type AgentStore = Store<AgentState, AgentAction>;

/** 一个装配好的 store + （可选的）轨迹落盘器。 */
export interface AgentStoreHandle {
  store: AgentStore;
  persistence: TracePersistence | null;
}

export interface CreateAgentStoreOptions {
  runtime: AgentRuntime;
  systemPrompt: string;
  maxTurns?: number | undefined;
  /** 一次 LLM 调用的超时（毫秒）；超时按可重试错误处理。 */
  llmTimeoutMs?: number | undefined;
  /** 工具的工作目录（官方工具用它做路径边界检查）。不给则用 process.cwd()。 */
  cwd?: string | undefined;
  /** 单轮内最多几次 LLM 尝试（含首次），2 = 失败后重试一次。 */
  maxLlmAttempts?: number | undefined;
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
  /** 完全自定义 reducer 接线（测试用）。 */
  reducerEffects?: Partial<ReducerEffects> | undefined;
}

/** 把一张 effect 表翻译成 reducer 要的「action type → Cmd[]」接线表。 */
export const effectTableToReducerEffects = loopWiring;

export function createAgentStore(options: CreateAgentStoreOptions): AgentStore {
  const { runtime, systemPrompt, maxTurns, streamFn, effects, reducerEffects, sessionId } = options;

  const table: EffectTable =
    effects ??
    createPiAiEffectTable({
      streamFn: streamFn ?? defaultStreamFn(runtime),
      model: runtime.model,
    });

  const initialState = createInitialState({
    systemPrompt,
    providerName: runtime.spec.provider,
    modelId: runtime.model.id,
    // 工具按 cwd 建（官方工具用它做路径边界检查）。
    toolNames: getTools(options.cwd ?? process.cwd()).map((tool) => tool.name),
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
  return store;
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
  const store = createAgentStore(options);
  if (!options.traceSink) return { store, persistence: null };
  const persistence = createTracePersistence({
    store,
    sink: options.traceSink,
    ...(options.onTraceError ? { onError: options.onTraceError } : {}),
  });
  return { store, persistence };
  return { store, persistence };
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

