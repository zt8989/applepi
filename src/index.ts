/**
 * 库入口：把 Agent Loop 的几个部件暴露出去，方便复用/测试。
 */
export type { AgentAction } from './actions';
export { createInitialState, type AgentState, type Phase } from './state';
export { agentReducer } from './reducer';
export { callLlmCmd, executeToolCallsCmd, setEffectDeps, clearEffectDeps } from './effects';
export { createAgentStore, waitForIdle, type AgentStore } from './store';
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
