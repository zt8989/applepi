import { loop, type LoopReducer } from 'redux-loop';
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import type { AgentAction } from './actions';
import { createInitialState, type AgentState } from './state';
import { callLlmCmd, executeToolCallsCmd } from './effects';

/**
 * Agent reducer —— 纯函数。所有副作用都逃逸到返回的 Cmd 里：
 *
 *   prompt        → Cmd.run(callLlm)              开始一轮 LLM
 *   llm/delta     → 累积流式文本（无命令）
 *   llm/done      → 无工具调用：相位回 idle，环结束
 *                   有工具调用：Cmd.run(executeToolCalls)
 *   tool/start    → 记 executing（UI 显示）
 *   tool/result   → 结果并进 messages（无命令）
 *   tools/done    → Cmd.run(callLlm)              回到 LLM，环闭合
 *   llm/failed    → 记错误，相位回 idle
 */
export const agentReducer: LoopReducer<AgentState, AgentAction> = (state, action) => {
  if (state === undefined) {
    throw new Error('agentReducer 需要一个确定的初始状态');
  }

  switch (action.type) {
    case 'reset':
      return createInitialState({
        systemPrompt: state.systemPrompt,
        providerName: state.providerName,
        modelId: state.modelId,
        toolNames: state.toolNames,
        maxTurns: state.maxTurns,
      });

    case 'prompt': {
      if (state.phase !== 'idle') return state;
      const userMessage: Message = {
        role: 'user',
        content: action.text,
        timestamp: Date.now(),
      };
      const next: AgentState = {
        ...state,
        phase: 'thinking',
        error: null,
        aborted: false,
        streamingText: '',
        thinkingText: '',
        pendingToolCalls: [],
        executing: [],
        messages: [...state.messages, userMessage],
      };
      return loop(next, callLlmCmd());
    }

    case 'llm/delta': {
      if (state.phase !== 'thinking') return state;
      return { ...state, streamingText: state.streamingText + action.delta };
    }

    case 'llm/thinking': {
      if (state.phase !== 'thinking') return state;
      return { ...state, thinkingText: state.thinkingText + action.delta };
    }

    case 'llm/done': {
      if (state.phase !== 'thinking') return state;
      const message: AssistantMessage = action.message;
      const toolCalls = message.content.filter((c): c is ToolCall => c.type === 'toolCall');
      const next: AgentState = {
        ...state,
        messages: [...state.messages, message],
        streamingText: '',
        thinkingText: '',
        turns: state.turns + 1,
        usage: message.usage ?? state.usage,
        totalCost: state.totalCost + (message.usage?.cost?.total ?? 0),
        pendingToolCalls: toolCalls,
        phase: toolCalls.length > 0 ? 'calling-tools' : 'idle',
      };
      if (toolCalls.length === 0) return next;
      return loop(next, executeToolCallsCmd(toolCalls));
    }

    case 'tool/start':
      return {
        ...state,
        executing: [...state.executing, { call: action.call, startedAt: Date.now() }],
      };

    case 'tool/result': {
      const result: ToolResultMessage = action.message;
      return {
        ...state,
        executing: state.executing.filter((t) => t.call.id !== result.toolCallId),
        pendingToolCalls: state.pendingToolCalls.filter((c) => c.id !== result.toolCallId),
        messages: [...state.messages, result],
      };
    }

    case 'tools/done': {
      if (state.phase !== 'calling-tools') return state;
      if (state.turns >= state.maxTurns) {
        return {
          ...state,
          phase: 'idle',
          error: `已达单回合工具调用上限（${state.maxTurns} 轮），停止。`,
        };
      }
      const next: AgentState = {
        ...state,
        phase: 'thinking',
        streamingText: '',
        thinkingText: '',
      };
      return loop(next, callLlmCmd());
    }

    case 'llm/failed':
      return {
        ...state,
        phase: 'idle',
        error: action.error,
        streamingText: '',
        thinkingText: '',
        executing: [],
        aborted: action.error.includes('abort'),
      };

    default:
      return state;
  }
};
