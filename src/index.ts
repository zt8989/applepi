/**
 * 库入口：把 Agent Loop 的几个部件暴露出去，方便复用/测试。
 */
export type { AgentAction, AgentActionType } from './actions';
export { createInitialState, type AgentState, type ExecutingTool, type Phase } from './state';
export {
  createAgentReducer,
  loopWiring,
  type ReducerEffects,
} from './reducer';
export {
  createAgentDrivenEffectTable,
  createPiAiEffectTable,
  type EffectTable,
  type PiAiEffectsOptions,
} from './effects';
export { createAgentStore, waitForIdle, type AgentStore, type CreateAgentStoreOptions } from './store';
export {
  createFauxRuntime,
  createRuntime,
  defaultStreamFn,
  demoResponses,
  providerNames,
  resolveApiKey,
  type AgentRuntime,
  type FauxRuntime,
  type ProviderSpec,
  type StreamFn,
} from './provider';
export { getTool, getTools } from './tools';
export type { AgentTool, AgentToolResult } from './agent-tool';
export { abortRun, isRunning } from './run-control';
