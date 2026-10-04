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

export type AgentStore = Store<AgentState, AgentAction>;

export interface CreateAgentStoreOptions {
  runtime: AgentRuntime;
  systemPrompt: string;
  maxTurns?: number | undefined;
  /** 测试注入假 streamFn 用；默认走 pi-ai。 */
  streamFn?: StreamFn | undefined;
  /** 自定义 effect 表（Web 用 agent-driven 表）；不给就用 pi-ai 表。 */
  effects?: EffectTable | undefined;
  /** 完全自定义 reducer 接线（测试用）。 */
  reducerEffects?: Partial<ReducerEffects> | undefined;
}

/** 把一张 effect 表翻译成 reducer 要的「action type → Cmd[]」接线表。 */
export const effectTableToReducerEffects = loopWiring;

export function createAgentStore(options: CreateAgentStoreOptions): AgentStore {
  const { runtime, systemPrompt, maxTurns, streamFn, effects, reducerEffects } = options;

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
    toolNames: getTools().map((tool) => tool.name),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
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

