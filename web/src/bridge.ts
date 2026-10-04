/**
 * Redux store ⇄ pi-agent-core Agent 的桥。
 *
 * 一个环，两个驱动：
 * - CLI：redux-loop 驱动（reducer 返回 `loop(state, Cmd)`，Cmd 跑 LLM 与工具）；
 * - Web：pi-agent-core 的 `Agent` 驱动（pi-web-ui 的聊天组件直接调 `session.prompt()`），
 *   桥把 Agent 的 lifecycle 事件翻译成同一套 action，灌进同一个 reducer / 状态树。
 *
 * 方向是单向的：Agent 事件 → action → 状态树。消息流本身仍由 Agent 持有
 * （pi-web-ui 的渲染要求如此），状态树保存同一份消息的投影（统计、相位、错误）。
 */
import type { Agent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import type { AgentStore } from '../../src/store';
import type { AgentState } from '../../src/state';
import type { AgentAction } from '../../src/actions';

/** Agent.subscribe 的回调参数（避免直接依赖 pi-agent-core 的导出路径）。 */
type AgentEvent = Parameters<Parameters<Agent['subscribe']>[0]>[0];

export interface BridgeOptions {
  agent: Agent;
  store: AgentStore;
  /** 状态变化回调（UI 刷新用）。 */
  onChange?: (state: AgentState, action: AgentAction) => void;
}

export interface AgentBridge {
  /**
   * 交给 UI 组件的 session。它是个 Proxy：`prompt()` 会先 dispatch 一条
   * `user.message`，其余属性原样转发给真 Agent。
   */
  session: Agent;
  dispose(): void;
}
/** 从 prompt 的入参里取出纯文本（pi-web-ui 也可能传带附件的消息对象）。 */
function promptText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && 'content' in input) {
    const content = (input as { content?: unknown }).content;
    if (typeof content === 'string') return content;
  }
  return '';
}
export function createAgentBridge(options: BridgeOptions): AgentBridge {
  const { agent, store, onChange } = options;

  const emit = (action: AgentAction): void => {
    store.dispatch(action);
    onChange?.(store.getState(), action);
  };

  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case 'agent_start':
        // 起相位。注意 Web 的接线把这几行的 effect 都设成了空操作（见 main.ts），
        // 所以回发 agent.run / user.message 不会再次调用 Agent.prompt ——
        // 桥因此是单向的：只把 Agent 的事件翻译成 action，驱动权始终在 UI 那边。
        emit({ type: 'agent.run' });
        break;
      case 'message_update': {
        const streamEvent = event.assistantMessageEvent;
        if (streamEvent?.type === 'text_delta' && streamEvent.delta) {
          emit({ type: 'llm.delta', delta: streamEvent.delta });
        } else if (streamEvent?.type === 'thinking_delta' && streamEvent.delta) {
          emit({ type: 'llm.thinking', delta: streamEvent.delta });
        }
        break;
      }
      case 'message_end': {
        const message = event.message;
        if (message.role === 'assistant') {
          emit({ type: 'llm.done', message: message as AssistantMessage });
        } else if (message.role === 'toolResult') {
          emit({ type: 'tool.result', message: message as ToolResultMessage });
        }
        break;
      }
      case 'tool_execution_start': {
        const call: ToolCall = {
          type: 'toolCall',
          id: event.toolCallId,
          name: event.toolName,
          arguments: (event.args ?? {}) as ToolCall['arguments'],
        };
        emit({ type: 'tool/start', call });
        break;
      }
      case 'agent_end': {
        // 正常收尾时相位已由 llm.done 闭合；只有出错才需要补一条，让错误进状态树。
        const error = agent.state.errorMessage;
        if (error) emit({ type: 'llm.failed', error });
        break;
      }
      default:
        break;
    }
  });

  const session = new Proxy(agent, {
    get(target, property, receiver) {
      if (property === 'prompt') {
        // 用户消息先落进状态树（user.message 的 effect 在 Web 侧是空操作，
        // 不会二次调用 Agent），再把输入原样转给真 Agent。
        return (input: unknown, images?: unknown) => {
          const text = promptText(input);
          if (text.trim()) emit({ type: 'user.message', text });
          return (target.prompt as (...args: unknown[]) => Promise<void>)(input, images);
        };
      }
      if (property === 'state') {
        // pi-agent-core 是**就地**改 messages 数组（push），lit 拿到同一个引用就
        // 不会重渲染 —— 表现就是「工具回合之后，最后一条回答不显示」。
        // 这里每次返回一份新的 state 对象和新的 messages 数组，强制 lit 更新。
        const state = target.state;
        return { ...state, messages: state.messages.slice() };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as Agent;

  return { session, dispose: unsubscribe };
}
