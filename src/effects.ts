/**
 * Effect 表 —— 一切皆 Action 的另一半。
 *
 * reducer 是纯表：action → (state, effect)。effect 由谁来做，是**接线**的事：
 *
 *   - `createPiAiEffectTable`：effect 直接调 pi-ai（createModels/deepseekProvider +
 *     streamSimple），工具也由本仓库的 Cmd 执行，由 redux-loop 驱动 —— 环自己转。
 *
 * 这张表对 CLI 和 Web 是同一张。reducer 里没有 if (kind === 'agent')，
 * 只有「这个 action 类型的 effect 是谁」。想换执行者，注入另一张同形状的表就行 ——
 * reducer 一行都不用改。
 */
import { Cmd, type CmdType } from 'redux-loop';
import type {
  AssistantMessage,
  Context,
  JsonValue,
  Model,
  SimpleStreamOptions,
  Tool,
  ToolCall,
  ToolResultMessage,
} from '@earendil-works/pi-ai';
import type { AgentAction } from './actions';
import { classifyLlmError, type AgentState, type LlmErrorKind, type StopCause } from './state';
import { getTool, getTools } from './tools';
import { beginRun, endRun, lastAbortCause, RunAbortedError } from './run-control';
import { resolveApiKey, type StreamFn } from './provider';
import { formatDuration } from './trace';

/** effect 表：每个名字返回一个 Cmd。 */
export interface EffectTable {
  /** 跑一轮对话（= 调一次 LLM）。text 只在需要把用户输入带进这次请求的接线里才有意义。 */
  runAgent(text?: string | undefined): CmdType;
  /** 执行一批工具调用。 */
  runTools(calls: ToolCall[]): CmdType;
}

/**
 * 交给 LLM 的工具描述 —— **从 state.prompt.tools 读**，不再每次 getTools() 现算。
 *
 * `prompt.init` 已经把完整定义装进 state 了，所以这里：
 *   - 少一次工具注册表的构造（官方工具在构造时读目录、做边界计算）；
 *   - 回放时不必重新装配工具，就知道当时发给模型的是什么。
 *
 * 只留三样（name / description / parameters），因为真正进 LLM 请求的就是这三样。
 * `execute` 在 `runToolCall` 里按名字从注册表取 —— 执行用的和发给模型的不是一回事。
 */
function toolSchemas(state: AgentState): Tool[] {
  return state.prompt.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as Tool['parameters'],
  }));
}
/**
 * pi-ai 版 effect 表：LLM 与工具都自己跑（CLI 用）。
 */
export interface PiAiEffectsOptions {
  streamFn: StreamFn;
  model: Model<any>;
  /** 浏览器/宿主注入 key 的口子（node 下默认读 process.env）。 */
  resolveKey?: (provider: string) => string | undefined | Promise<string | undefined>;
}

export function createPiAiEffectTable(options: PiAiEffectsOptions): EffectTable {
  const { streamFn, model } = options;
  const keyOf = options.resolveKey ?? resolveApiKey;

  async function callLlm(
    dispatch: Cmd.Dispatch,
    getState: Cmd.GetState,
  ): Promise<{ message: AssistantMessage; nodeId: string | null }> {
    // 「这一轮开始流了」也是一条 action：在发出第一次请求之前就 dispatch 出去，
    // 这样 UI 的生成中动画不必等第一个 token。
    dispatch({ type: 'llm.started' });
    const state = getState<AgentState>();
    // 记住这次尝试的轨迹节点 id：失败时带着它回来，reducer 才能把 error 挂对地方。
    const nodeId = state.openLlmNodeId;
    // Context 三样全部**从 state 读**（都由 init 装好了）：
    //   systemPrompt ← prompt.init
    //   tools        ← prompt.init（完整定义）
    //   messages     ← 对话本身（含中途追加的 system/developer 片段）
    const context: Context = {
      systemPrompt: state.prompt.systemPrompt,
      messages: state.messages,
      tools: toolSchemas(state),
    };
    const controller = beginRun();
    // 超时闸：到点就 abort 掉这次流。分类是 timeout → 可重试，于是环自己会再试一次。
    // 手动中断（Ctrl-C）也走 abort，但它不是超时 —— 用 source 区分开。
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new LlmTimeoutError(state.llmTimeoutMs));
    }, state.llmTimeoutMs);
    try {
      // await 是必要的：浏览器侧 resolveKey 是 async（key 在 IndexedDB 里）。
      const apiKey = await keyOf(model.provider);
      const streamOptions: SimpleStreamOptions = { signal: controller.signal };
      if (apiKey !== undefined) streamOptions.apiKey = apiKey;
      //
      // 思考级别（reasoning effort）读 state.model —— 由 model.init 装载，thinking.changed 改。
      // 取值是 pi-ai 的 ThinkingLevel：minimal|low|medium|high|xhigh|max；'off' 不带 reasoning。
      //
      // 它是**请求参数**，不是输出格式：模型回不回馈 thinking 由它自己决定（很多模型不给）。
      // 回馈时走独立的 thinking content 块（`{type:'thinking', thinking: string}`），
      // 和正文 text 块分开 —— 所以「思考输出是文本」但**不是** assistant 正文。
      const thinkingLevel = state.model.thinkingLevel;
      if (thinkingLevel !== 'off') streamOptions.reasoning = thinkingLevel;
      const stream = streamFn(model, context, streamOptions);
      let final: AssistantMessage | undefined;
      for await (const event of stream) {
        if (event.type === 'text_delta' && event.delta) {
          dispatch({ type: 'llm.delta', delta: event.delta });
        } else if (event.type === 'thinking_delta' && event.delta) {
          dispatch({ type: 'llm.thinking', delta: event.delta });
        } else if (event.type === 'done') {
          final = event.message;
        } else if (event.type === 'error') {
          final = event.error;
        }
      }
      // 流被 abort 后就断在这里（没有 done 事件）。必须主动把原因抛出来，
      // 否则下面那句「流在 done 之前结束」会报一个跟真实原因无关的错误，超时也就不会重试。
      if (!final) {
        if (timedOut) throw new LlmTimeoutError(state.llmTimeoutMs);
        if (controller.signal.aborted) {
          const reason = abortReason(controller.signal);
          if (reason instanceof LlmTimeoutError) throw reason;
          // 手动中断：原因挂在 signal.reason 上（RunAbortedError）。拿不到就退回登记处记的
          // 那个 —— 至少能分清「用户按了停止」与「内核被关掉」。
          if (reason instanceof RunAbortedError) throw reason;
          throw new RunAbortedError(lastAbortCause());
        }
        throw new Error('LLM 流在发出 done/error 之前就结束了');
      }
      if (final.stopReason === 'error') {
        throw new Error(final.errorMessage || 'LLM 返回错误');
      }
      // 连同 attempt 的 id 一起返回：成功/失败都要靠它把节点挂到正确的父节点下。
      return { message: final, nodeId };
    } catch (error) {
      // 把 attempt 的 id 绑在异常上再抛出去：`successActionCreator` / `failActionCreator`
      // 都拿不到 Cmd.getState，只能靠异常本身把「这次失败属于哪个节点」带回去。
      throw attachNodeId(error, nodeId);
    } finally {
      clearTimeout(timer);
      endRun();
    }
  }

  /** 超时是「可重试」的失败，区别于鉴权/参数错。用一个专门的类型，分类时不必去猜文案。 */
  class LlmTimeoutError extends Error {
    readonly timeoutMs: number;

    constructor(timeoutMs: number) {
      // 复用 trace 的格式化：小于 1s 的超时（测试里很常见）显示 400ms 而不是 0s。
      super(`LLM 调用超时（${formatDuration(timeoutMs)}）`);
      this.name = 'LlmTimeoutError';
      this.timeoutMs = timeoutMs;
    }
  }
  /** 给异常挂上 attempt 的 id（非 Error 也包一个 Error，否则信息会丢）。 */
  function attachNodeId(error: unknown, nodeId: string | null): Error {
    const wrapped =
      error instanceof Error ? error : new Error(error === undefined ? '未知错误' : String(error));
    return Object.assign(wrapped, { traceNodeId: nodeId });
  }

  /** 从异常里取回 attempt 的 id（超时的 abort 原因里没有，得靠这个字段）。 */
  function nodeIdOf(error: unknown): string | null {
    if (error !== null && typeof error === 'object' && 'traceNodeId' in error) {
      const value = (error as { traceNodeId?: unknown }).traceNodeId;
      return typeof value === 'string' ? value : null;
    }
    return null;
  }

  /** abort 的原因可能是一个字符串或 AbortError，从 controller.signal.reason 里捞出来。 */
  function abortReason(signal: AbortSignal): unknown {
    return 'reason' in signal ? signal.reason : undefined;
  }

  /**
   * 把 effect 侧的异常归成 LlmErrorKind，并带上这次 attempt 的 nodeId。
   * `nodeId` 传 null 表示「这不是某次 LLM 尝试的失败」（比如工具批次整体挂掉），
   * reducer 会据此判定不重试。
   */
  function failureAction(
    error: unknown,
    nodeId: string | null,
    /** 「这不是某次 LLM 尝试」时传 'tool-error'：工具批次整体挂掉与 LLM 失败要分开记。 */
    fallbackCause: StopCause = 'llm-error',
  ): AgentAction {
    const message = error instanceof Error ? error.message : String(error);
    // 手动中断的文案是中文（「运行被用户中断」），classifyLlmError 认不出 abort ——
    // 它只按英文关键词猜。所以这里**先认异常类型**，别让文案决定事实。
    const kind: LlmErrorKind =
      error instanceof LlmTimeoutError
        ? 'timeout'
        : error instanceof RunAbortedError
          ? 'aborted'
          : classifyLlmError(message);
    const id = nodeIdOf(error) ?? nodeId;
    return {
      type: 'llm.failed',
      error: message,
      kind,
      ...(id !== null ? { nodeId: id } : {}),
      cause: stopCauseOf(error, kind, fallbackCause),
    };
  }

  /**
   * 从异常推出停止原因。
   *
   * 超时与手动中断都走 abort，但它们完全是两件事：前者是故障（可重试），后者是用户的选择。
   * 光看 kind 分不开（都可能是 aborted），所以先认 `RunAbortedError` 上挂的 cause，
   * 再退回 kind 的粗分类。
   */
  function stopCauseOf(
    error: unknown,
    kind: LlmErrorKind,
    fallback: StopCause,
  ): StopCause {
    if (error instanceof RunAbortedError) return error.cause;
    if (error instanceof LlmTimeoutError) return 'timeout';
    // aborted 不能原样当 StopCause 用：它只说明「被中断了」，没说是谁喊停的。
    // 真正的来源在 RunAbortedError 上；到这一步还没拿到，就按登记处的（默认用户）。
    if (kind === 'aborted') return lastAbortCause();
    if (kind === 'timeout' || kind === 'network' || kind === 'auth' || kind === 'model') {
      return kind;
    }
    return fallback;
  }

  function toToolResult(
    call: ToolCall,
    content: ToolResultMessage['content'],
  // pi-ai 1.x 把 details 从 unknown 收紧成 JsonValue（要能真的序列化进 JSONL / 存盘）。
  details: JsonValue,
    isError: boolean,
  ): ToolResultMessage {
    return {
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content,
      details,
      isError,
      timestamp: Date.now(),
    };
  }

  /**
   * 工具「跑完了但其实失败了」——按内容判定，不是按抛异常。
   *
   * ## 为什么必须判内容
   *
   * pi 的 `bash` 工具执行 `exit 1` 时**不抛异常**：它把
   * 「Command exited with code 1」当正常结果返回。所以只 catch 异常的话，
   * 每一个失败的工具都会走进「成功」分支，isError 永远是 false。
   *
   * 后果不是小问题：轨迹上把失败画成 ✓（分叉不画出来）、界面不标红、
   * 而模型拿到的 toolResult 里 isError=false —— 它会以为命令跑成功了。
   *
   * ## 判据
   *
   * pi 把退出码写进正文，形如 `Command exited with code <非 0>`。
   * 只认这一种形状：靠猜「输出里有没有 error 字样」会误伤（命令成功但日志里
   * 恰好有 "error"），宁可漏判也不能把成功判成失败。
   */
  function isFailure(content: ToolResultMessage['content']): boolean {
    const text = Array.isArray(content)
      ? content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
      : String(content);
    return /Command exited with code [1-9]\d*/i.test(text);
  }

  async function runToolCall(call: ToolCall, signal: AbortSignal): Promise<ToolResultMessage> {
    const tool = getTool(call.name);
    if (!tool) {
      return toToolResult(
        call,
        [{ type: 'text', text: `未知工具：${call.name}` }],
        null,
        true,
      );
    }
    try {
      const result = await tool.execute(call.id, call.arguments ?? {}, signal);
      return toToolResult(call, result.content, result.details, isFailure(result.content));
    } catch (error) {
      return toToolResult(
        call,
        [
          {
            type: 'text',
            text: `工具 ${call.name} 执行失败：${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        null,
        true,
      );
    }
  }

  async function executeToolCalls(
    dispatch: Cmd.Dispatch,
    _getState: Cmd.GetState,
    calls: ToolCall[],
  ): Promise<number> {
    const controller = beginRun();
    try {
      const results = await Promise.all(
        calls.map(async (call) => {
          dispatch({ type: 'tool/start', call });
          const message = await runToolCall(call, controller.signal);
          dispatch({ type: 'tool.result', message });
          return message;
        }),
      );
      return results.length;
    } finally {
      endRun();
    }
  }

  return {
    runAgent: () =>
      Cmd.run(callLlm, {
        args: [Cmd.dispatch, Cmd.getState],
        successActionCreator: (result: {
          message: AssistantMessage;
          nodeId: string | null;
        }): AgentAction => ({
          type: 'llm.done',
          message: result.message,
          // 把 attempt 的 id 带回 reducer：成功节点要挂在**这次**尝试下面。
          ...(result.nodeId !== null ? { nodeId: result.nodeId } : {}),
        }),
        // 失败也带上 attempt 的 id（异常身上已经有了，这里只兜底）：
        // reducer 据此挂 error 节点，并判断要不要重试。
        failActionCreator: (error: unknown): AgentAction => failureAction(error, null),
      }),

    runTools: (calls: ToolCall[]) =>
      Cmd.run(executeToolCalls, {
        args: [Cmd.dispatch, Cmd.getState, calls],
        successActionCreator: (count: number): AgentAction => ({
          type: 'tool.batch.done',
          count,
        }),
        // 工具批次整体挂掉（比如 abort）不该被当成 LLM 失败去重试，
        // 所以这里明确给 nodeId: null，让 reducer 看到「没有 LLM 尝试在跑」。
        failActionCreator: (error: unknown): AgentAction =>
          // 这里 LLM 根本没在跑（openLlmNodeId 已是 null）：不是「大模型失败」，是工具批次挂了。
          failureAction(error, null, 'tool-error'),
      }),
  };
}

