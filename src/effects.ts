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
  ThinkingBudgets,
  Tool,
  ToolCall,
  ToolResultMessage,
} from '@earendil-works/pi-ai';
import type { AgentAction } from './actions';
import { classifyLlmError, type AgentState, type LlmErrorKind, type StopCause } from './state';
import { getTool, getTools } from './tools';
import { beginRun, endRun, lastAbortCause, RunAbortedError } from './run-control';
import { resolveApiKey, type StreamFn } from './provider';
import {
  effectiveCompactionSettings,
  runCompaction,
  type CompactReason,
} from './compact';
import { formatDuration } from './trace';

/** `compact.done` 需要的载荷（effect 的返回值 = 成功 action 的字段）。 */
type CompactOutcomeForAction = {
  messages: AgentState['messages'];
  summary: string;
  tokensBefore: number;
  usage?: NonNullable<AgentState['usage']> | undefined;
  summarizedCount: number;
  keptCount: number;
  reason: CompactReason;
};

/** effect 表：每个名字返回一个 Cmd。 */
export interface EffectTable {
  /** 跑一轮对话（= 调一次 LLM）。text 只在需要把用户输入带进这次请求的接线里才有意义。 */
  runAgent(text?: string | undefined): CmdType;
  /** 执行一批工具调用。 */
  runTools(calls: ToolCall[]): CmdType;
  /**
   * 跑一次上下文压缩（找切点 → 调 LLM 生成摘要 → 换掉老对话）。
   *
   * **可选**：不实现就是「不支持压缩」——`compact.request` 不发任何 Cmd。
   * 那时界面的 `/compact` 会明说「未接内核」，而不是静默无反应
   * （静默无反应是最坏的一种：用户以为压了，其实历史一个字没动）。
   */
  runCompact?(): CmdType;
  /**
   * 记下「这次压缩是为什么发起的」（手动 / 超阈值 / provider 报溢出）。
   *
   * 为什么要 effect 表来记，而不是 action 里带：`failActionCreator` 只拿到异常、
   * 拿不到 action，所以「为什么压」必须在 dispatch 那一刻存到某个地方。
   * 而它是**决定**的一部分（决定压了就写着「超阈值」），不是状态 ——
   * 状态里放它等于让界面有机会改掉它，那就不可信了。
   *
   * `loopWiring` 在发 `runCompact()` **之前**调它，所以 effect 拿到的一定是这次的理由。
   */
  markCompactReason?(reason: CompactReason): void;
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
  /**
   * 按 state 里的 `model.provider` / `model.modelId` 取**当时的**模型。
   *
   * ## 为什么需要它
   *
   * 没有它时 effect 表捕获的是**建表那一刻**的 `model`（闭包变量），于是 `/model`
   * 换了模型之后底栏变了、轨迹树里也记了新模型，**实际请求仍发给旧模型** ——
   * 症状是「换了没用」，而所有可见证据都说换了。
   *
   * 给了它之后模型是**每次请求现取**的：`model.changed` + `model.init` 一 dispatch，
   * 下一个回合就用新的。`getModel` 返回 `undefined`（模型在盘上找不到了，配置坏过）时
   * 退回闭包里那个 —— 那样至少还打得出请求，而抛 `undefined` 会让整条环崩在一个
   * 「本该打网络」的位置上。
   */
  resolveModel?: ((state: AgentState) => Model<any> | undefined) | undefined;
  /**
   * 各档思考级别的 token 预算（`settings.json` 的 `thinkingBudgets`）。
   *
   * ## 为什么是「建表时给一次」而不是每请求现读
   *
   * 与 pi 同一步：它的 Agent 在构造时收下这个字段（`core/sdk.js:275`，之后每请求原样带上，
   * `pi-agent-core` 的 `agent.js:313`）。所以「聊到一半手改 settings.json」在两边都不生效，
   * 要重启 —— 这也是把 `thinkingBudgets` 放在这里（而不是每请求读盘）的理由：
   * 行为与 pi 一致，而且每请求读一次盘没有任何好处。
   *
   * 与 `resolveModel` 的「每请求现取」不矛盾：模型会通过 `/model` 在**会话内**被改
   * （有界面入口），预算没有。
   */
  thinkingBudgets?: ThinkingBudgets | undefined;
  /**
   * 工具执行前的门（官方叫 `tool_call` 事件）。
   *
   * 本项目不接全套权限体系，但这个门必须有：MCP 的 `tool_call` handler 靠它「脚本点名了
   * 但还没连上」的服务器。返回 `block: true` 时环不执行那个工具，把 `reason` 当错误结果
   * 发回模型；否则用返回的 `input`（handler 可以就地改参数）。
   */
  onToolCall?: ToolCallGate | undefined;
}

/** `tool_call` 门的形状（`extension-host.ts` 的 `beforeToolCall` 就是它）。 */
export type ToolCallGate = (
  toolCallId: string,
  name: string,
  input: Record<string, unknown>,
) => Promise<{ block?: boolean; reason?: string | undefined; input: Record<string, unknown> }>;

export function createPiAiEffectTable(options: PiAiEffectsOptions): EffectTable {
  const { streamFn, model: initialModel } = options;
  const keyOf = options.resolveKey ?? resolveApiKey;

  /**
   * 这一轮该用哪个模型。
   *
   * 读 state（`model.init` 装、`model.changed` 改），没有 `resolveModel` 时就是初始那个。
   */
  const modelOf = (state: AgentState): Model<any> =>
    options.resolveModel?.(state) ?? initialModel;

  /**
   * 最近一次 `compact.request` 带的理由。
   *
   * 为什么存在 effect 表的闭包里而不是 state 里：
   * `failActionCreator` 只拿到异常、拿不到 action，所以「为什么压」必须在
   * dispatch 那一刻就存到某个**不可被界面改写**的地方。放 state 里等于留了一个
   * 「界面能改掉判定依据」的口子，而理由要显示给用户、可不能被人随手改掉。
   *
   * 为什么用 `let` 而不是 state：它不是状态 —— 压缩一结束就没意义了，
   * 而把它写进 state 会让 `conversation.reset` / `restored` 多一件要记得带上的事。
   *
   * **声明必须在 return 之前**：`markCompactReason` 是箭头函数（在 return 的对象里），
   * 闭包引用的是下面这个 `let`；若声明在 return 之后，`markCompactReason` 被调用时
   * 它还在 TDZ 里（ReferenceError）。
   */
  let lastRequestedReason: CompactReason = 'manual';

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
      const model = modelOf(state);
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
      //
      // 各档的 token 预算（`settings.json` 的 `thinkingBudgets`）—— 与 pi 同一步：读一次、
      // 每个请求原样带上（pi 的 Agent 也是这么做的）。pi-ai 的 provider 自己决定要不要用：
      // Anthropic / Bedrock 拿它当 `thinking.budget_tokens`，而 OpenAI 兼容端点要靠模型目录里
      // 的 `compat.thinkingTokenBudgetField` 才发（`thinking_token_budget` / `thinking_budget` /
      // `thinking_budget_tokens` 分别对应 vLLM / Qwen / llama.cpp）。
      //
      // 不设时不传这个键：pi-ai 会在内部用它的内置预算（minimal 1k … high 16k），
      // 传一个空对象反而是「显式要求空预算」。
      if (options.thinkingBudgets !== undefined) {
        streamOptions.thinkingBudgets = options.thinkingBudgets;
      }
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
      //
      // **超时闸的判定必须在看 `final` 之前**。
      //
      // 先前的写法是「先看 `!final`，再在里面问 timedOut」—— 那只有在流被 abort 之后
      // 「安静收尾、什么都不给」时才成立。**真实 provider 不这样**：signal 一 abort，
      // 它就补一份 `stopReason:'aborted'` 的部分消息，以 `error` 事件交回来
      // （见 pi-ai `api/openai-completions.js`：catch 里 `output.stopReason = signal.aborted
      // ? 'aborted' : 'error'`，然后 push 一个 error 事件）。于是 `final` 有值，
      // 「是不是超时了」这一问永远走不到，那份**被我们自己掐断**的消息就被当成
      // 模型正常说完，一路走到 `llm.succeeded`。
      //
      // 症状（2026-10-13 的会话 01a1330b，两次）：一个整整 120s 的 step 记成 `ok`、
      // 树上一条**空的** llm.result、`step.end`/`turn.end` 写成「用户中断」，
      // `error` 是 null —— 错误一个字都没留下，重试也不会发生（超时本来是可重试的）。
      //
      // 判据用消息自己的 `stopReason`，不用「收到的是 done 还是 error」：
      // 前者对任何 provider 都成立，后者是 pi-ai 当前的实现细节。
      // 唯一让超时**不**生效的情形是「真的收到了一次正常完成」—— 计时器与流收尾
      // 赛跑到同一瞬间时，一份完整答案比一个可重试的超时错误更有价值。
      const interrupted = final === undefined || final.stopReason === 'aborted';
      if (timedOut && interrupted) {
        throw new LlmTimeoutError(state.llmTimeoutMs);
      }
      // 流被 abort 后就断在这里（没有 done/error 事件）。必须主动把原因抛出来，
      // 否则下面那句「流在 done/error 之前结束」会报一个跟真实原因无关的错误。
      if (!final) {
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

  async function runToolCall(
    call: ToolCall,
    signal: AbortSignal,
    dispatch: Cmd.Dispatch,
  ): Promise<ToolResultMessage> {
    // `tool_call` 门：MCP 在这里等服务器，权限类扩展在这里阻止调用。
    // 门抛错由调用方（`extension-host.ts` 的 beforeToolCall）自己吞成诊断，所以这里不 catch。
    const gate =
      options.onToolCall === undefined
        ? { input: (call.arguments ?? {}) as Record<string, unknown> }
        : await options.onToolCall(call.id, call.name, (call.arguments ?? {}) as Record<string, unknown>);
    if (gate.block === true) {
      return toToolResult(
        call,
        [
          {
            type: 'text',
            text: gate.reason ?? `工具 ${call.name} 被阻止执行`,
          },
        ],
        null,
        true,
      );
    }
    const args = gate.input;
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
      const result = await tool.execute(call.id, args, signal, (partial) => {
        // 流式增量 → `tool.progress` → reducer 存进 state.toolProgress。
        //
        // **为什么每一块都 dispatch**：界面就是靠这个动作重画的（diff 渲染只重画变化的行）。
        // 官方的 bash 工具内部已经有节流（BASH_UPDATE_THROTTLE_MS），所以这里的频率是可控的；
        // 而且即便节流失效，`TranscriptChunks` 那层还有缓存（只重画正在跑的那一块）。
        //
        // 这里只 dispatch，不改任何本地状态 —— 本项目的不变式：**状态只能由 action 改**。
        dispatch({ type: 'tool.progress', toolCallId: call.id, content: partial.content });
      });
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
          const message = await runToolCall(call, controller.signal, dispatch);
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

    /**
     * 压缩上下文：一条 `compact.request` → 真的找切点、真的调 LLM 写摘要。
     *
     * **为什么摘要失败要走 failActionCreator 而不是吞掉**：
     * 压缩失败时对话原样保留（reducer 的 `compact.failed` 保证），但用户必须知道 ——
     * 否则「为什么上下文一直超」这个问题没有答案，而症状是「模型莫名其妙忘了前面说过什么」，
     * 那是最难查的一类。
     */
    runCompact: () =>
      Cmd.run(compactContext, {
        args: [Cmd.dispatch, Cmd.getState],
        successActionCreator: (outcome: CompactOutcomeForAction): AgentAction => ({
          type: 'compact.done',
          ...outcome,
        }),
        failActionCreator: (error: unknown): AgentAction => ({
          type: 'compact.failed',
          error: error instanceof Error ? error.message : String(error),
          // 原因从 effect 的局部变量拿（是它定的，不在这里重新猜一遍 ——
          // 两个地方各判一次必然漂移）。
          reason: lastRequestedReason,
        }),
      }),

    markCompactReason: (reason: CompactReason): void => {
      lastRequestedReason = reason;
    },
  };

  /**
   * 压缩的真正干活处：读状态 → 找切点 → 生成摘要 → 把结果交给 reducer。
   *
   * **不直接改 state**（本项目的不变式）：返回结果，由 successActionCreator
   * 变成一条 `compact.done` 回去。
   */
  async function compactContext(
    _dispatch: Cmd.Dispatch,
    getState: Cmd.GetState,
  ): Promise<CompactOutcomeForAction> {
    const state = getState<AgentState>();
    // 窗口小的模型要夹紧 reserve/keepRecent，否则「阈值」会变成永远成立。
    const settings = effectiveCompactionSettings(
      state.compactionSettings,
      state.model.contextWindow,
    );
    const apiKey = await keyOf(state.model.provider);
    const outcome = await runCompaction({
      messages: state.messages,
      model: modelOf(state),
      streamFn,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(state.model.thinkingLevel !== 'off' ? { thinkingLevel: state.model.thinkingLevel } : {}),
      settings,
      contextWindow: state.model.contextWindow,
    });
    // 没有可压的内容（切点找不到 / 整段都还在保留窗口里）。
    // 这**不是错误** —— 但也不能静默：回一条结果，让界面显示
    // 「0 条 → N 条」，用户据此知道「现在压还太早」。静默才最坏：
    // 用户以为压了，实际历史一个字没动。
    return outcome === null
      ? {
          messages: state.messages,
          summary: '',
          tokensBefore: 0,
          summarizedCount: 0,
          keptCount: state.messages.length,
          reason: lastRequestedReason,
        }
      : {
          messages: outcome.messages,
          summary: outcome.summary,
          tokensBefore: outcome.tokensBefore,
          ...(outcome.usage ? { usage: outcome.usage } : {}),
          summarizedCount: outcome.summarizedCount,
          keptCount: outcome.keptCount,
          reason: lastRequestedReason,
        };
  }
}

