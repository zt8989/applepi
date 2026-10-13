/**
 * 库入口：把 Agent Loop 的几个部件暴露出去，方便复用/测试。
 */
export type { AgentAction, AgentActionType } from './actions';
export {
  createInitialState,
  type AgentState,
  type ExecutingTool,
  type Phase,
  type QueuedInput,
  type QueueKind,
  type TurnEndReason,
} from './state';
export {
  createAgentReducer,
  loopWiring,
  type ReducerEffects,
} from './reducer';
export {
  createPiAiEffectTable,
  type EffectTable,
  type PiAiEffectsOptions,
} from './effects';
export {
  createAgentStore,
  createAgentStoreWith,
  waitForIdle,
  type AgentStore,
  type CreateAgentStoreOptions,
} from './store';
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

// ─── 轨迹树（trace tree） ───
export {
  appendNode,
  childrenOf,
  createTraceTree,
  deserializeTree,
  formatDuration,
  getNode,
  headPath,
  newSessionId,
  patchNode,
  pathTo,
  renderTree,
  serializeTree,
  traceRows,
  traceStats,
  type SerializedTrace,
  type SerializedTraceNode,
  type TraceNode,
  type TraceNodeKind,
  type TraceNodeStatus,
  type TraceRow,
  type TraceStats,
  type TraceTree,
  type TreeRenderOptions,
} from './trace';
export {
  createTracePersistence,
  pendingRecords,
  replaySession,
  replayTrace,
  toJsonl,
  type TracePersistence,
  type TraceRecord,
  type TraceSink,
} from './trace-store';
export {
  createFileSink,
  listSessions,
  loadSession,
  tracePath,
} from './trace-file';
export {
  createPersistentStore,
  createAutoCompact,
  type AgentStoreHandle,
  type AutoCompact,
} from './store';
export { classifyLlmError, isRetryable, DEFAULT_LLM_TIMEOUT_MS } from './state';

// ─── 上下文压缩（compact） ───
export {
  compactionSettings,
  compactReasonText,
  buildSummaryMessage,
  decideCompaction,
  effectiveCompactionSettings,
  isCompactionSummary,
  isContextOverflow,
  lastContextTokens,
  planCut,
  runCompaction,
  shouldCompact,
  DEFAULT_COMPACTION_SETTINGS,
  type CompactDecision,
  type CompactOutcome,
  type CompactReason,
  type CompactionSettings,
  type CompactionSummaryMessage,
  type CutPlan,
} from './compact';

// ─── 装载与 middleware ───
export type { ModelCapabilities, PromptToolDefinition } from './actions';
export type { ModelState, PromptState } from './state';
export { createKernel, defaultSystemPrompt, type Kernel, type KernelOptions } from './kernel';
export {
  applyMiddleware,
  promptSegmentMiddleware,
  type ActionMiddleware,
  type MiddlewareOptions,
  type Next,
} from './middleware';
export type { InitRecord, ReplayedInit, ReplayedSession } from './trace-store';

// ─── System prompt（拼装交给 pi 的 buildSystemPrompt） ───
export {
  buildPromptOptions,
  buildSystemPromptText,
  promptFileSources,
  promptToolsFrom,
  type PromptFileSources,
  type PromptInputs,
  type PromptToolLike,
} from './system-prompt';
