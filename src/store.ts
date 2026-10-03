/**
 * Store 装配 —— redux-loop 的 install() enhancer 负责：
 * 把 reducer 返回的 Cmd 执行掉，再把 success/fail action dispatch 回来。
 * Agent Loop 就是这个环：prompt → LLM Cmd → tools Cmd → LLM Cmd → … → idle。
 */
import { createStore } from 'redux';
import type { Store } from 'redux';
import { install } from 'redux-loop';
import { agentReducer } from './reducer';
import { createInitialState, type AgentState } from './state';
import type { AgentAction } from './actions';
import { setEffectDeps } from './effects';
import { getTools } from './tools';
import { defaultStreamFn, type AgentRuntime, type StreamFn } from './provider';

export type AgentStore = Store<AgentState, AgentAction>;

export interface CreateAgentStoreOptions {
  runtime: AgentRuntime;
  systemPrompt: string;
  maxTurns?: number;
  /** 测试注入假 streamFn 用；默认走 pi-ai。 */
  streamFn?: StreamFn;
}

export function createAgentStore(options: CreateAgentStoreOptions): AgentStore {
  const { runtime, systemPrompt, maxTurns, streamFn } = options;

  setEffectDeps({
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

  // redux-loop 的 install() 让 Store 认识 Loop reducer 的返回形状。
  const store = createStore(
    agentReducer as never,
    initialState as never,
    // 失败已由 Cmd.run 的 failActionCreator 转成 action（进了状态树），不必再往控制台喷。
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
