/**
 * 内核 —— 整个应用**唯一**跑环的地方。
 *
 * 只有一个权威 Loop：TUI 和 Web 界面都只是它的两个渲染层。这不是洁癖，是必需的 ——
 * 如果浏览器里也跑一份环，就会出现「两边都发起 LLM 调用」「两边的消息流不一致」，
 * 而环本身是有副作用的（真的调模型、真的改文件）。
 *
 * 装配一次，得到：
 *   - store       Redux Loop 的状态树（环的收敛点）
 *   - persistence 轨迹落盘器（错误也落盘）
 *
 * 界面层只做两件事：把用户输入 dispatch 进去，以及订阅 store 把状态画出来。
 */
import {
  createFauxRuntime,
  createRuntime,
  demoResponses,
  type AgentRuntime,
} from './provider';
import { createPersistentStore } from './store';
import { createFileSink, tracePath, type TraceDir } from './trace-file';
import { newSessionId } from './trace';
import type { AgentStore } from './store';
import type { InitRecord, TracePersistence, TraceSink } from './trace-store';
import type { Message, Model, ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { AgentAction, ModelCapabilities } from './actions';
import { createSessionRecorder, type SessionRecorder } from './session-recorder';
import { readSession, readSessionMessages } from './session-file';
import path from 'node:path';
import { getTools } from './tools';
/**
 * 从 Model 对象上读我们关心的三个能力。
 *
 * 位置不一样，所以分开取：
 *   - `supportsMidConvoSystemMessages` / `supportsMidConvoToolAdditions` 在 **BaseModel** 上（顶层）；
 *   - `supportsDeveloperRole` 在 **compat** 里，而且只有 openai 一族的 compat 有这个字段。
 *
 * 读不到就当 false（保守）—— 详见 reducer.ts 里 UNKNOWN_CAPABILITIES 的理由。
 */

function readCapabilities(model: Model<any>): ModelCapabilities {
  // 这两个标志声明在 BaseModel 上，但 pi-ai 的 Model 类型没把它们带进公开面，
  // 所以这里按「运行时确实有这个字段」来读（模型目录里带就是 true）。
  const raw = model as Model<any> & {
    supportsMidConvoSystemMessages?: boolean;
    supportsMidConvoToolAdditions?: boolean;
  };
  const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
  return {
    midConvoSystemMessages: raw.supportsMidConvoSystemMessages === true,
    midConvoToolAdditions: raw.supportsMidConvoToolAdditions === true,
    developerRole: compat?.supportsDeveloperRole === true,
  };
}
export interface KernelOptions {
  provider: string;
  model?: string | undefined;
  systemPrompt: string;
  /** 工作目录：官方工具用它做路径边界检查（防止模型跑出这个目录）。 */
  cwd: string;
  /** 不打网络，用 pi-ai 的 faux provider。 */
  demo?: boolean | undefined;
  /** 初始思考级别（reasoning effort）；`off` = 不带 reasoning。 */
  thinkingLevel?: ModelThinkingLevel | undefined;
  llmTimeoutMs?: number | undefined;
  maxLlmAttempts?: number | undefined;
  maxTurns?: number | undefined;
  sessionId?: string | undefined;
  /** 传 null 就完全不落盘。 */
  traceDir?: TraceDir | null | undefined;
  onTraceError?: ((error: unknown) => void) | undefined;
  /** false = 不写会话文件（只落轨迹）。 */
  writeSession?: boolean | undefined;
  /** 恢复已有会话时传「已经灌进去多少条消息」，记录器的游标要接着算，否则会重写一遍。 */
  resumeFrom?: number | undefined;
}

export interface Kernel {
  store: AgentStore;
  runtime: AgentRuntime;
  /** 当前会话 id。**会变**（开新会话 / 恢复历史），所以是只读取值。 */
  readonly sessionId: string;
  persistence: TracePersistence | null;
  /** 当前会话记录器（写 `sessions/<cwd>/<id>.jsonl`，供「恢复历史」用）。 */
  readonly session: SessionRecorder | null;
  /** 开一个新会话：换 id（于是换文件）、清空对话。**不会**把新消息写进旧文件。 */
  newSession(): { id: string };
  /**
   * 恢复一个历史会话（读文件 + 灌回 state）。**零 token**，不重跑模型。
   * @returns 恢复的会话 id 与灌进去的消息条数。
   */
  restoreSession(file: string): { id: string; restored: number };
  /** 把已经读出来的消息灌回 state。 */
  restore(messages: Message[]): void;
  dispose(): void;
}

const DEFAULT_SYSTEM_PROMPT = [
  '你是一个编码助手，跑在一个用 Redux Loop 组织的 agent 里。',
  '需要读写文件、跑命令时用工具去查，不要凭空猜。',
  '回答保持简短、直给；用用户的语言回答。',
].join('\n');

export function defaultSystemPrompt(): string {
  return DEFAULT_SYSTEM_PROMPT;
}

export function createKernel(options: KernelOptions): Kernel {
  const runtime = options.demo
    ? (() => {
        const faux = createFauxRuntime();
        faux.setResponses(demoResponses());
        return faux.runtime;
      })()
    : createRuntime({
        provider: options.provider,
        ...(options.model ? { model: options.model } : {}),
      });

  // ── 会话级资源（可以换） ──
  //
  // 「开新会话」要换 sessionId，而轨迹 sink / 装载段 sink / 会话记录器都是**绑在 id 上**
  // 的（文件名由 id 决定），所以要能整体替换。用一个 holder 持有当前的三个，
  // 并把一个**转发 sink** 交给 store —— store 建好之后不该再被重建（那会丢状态）。
  interface SessionResources {
    sessionId: string;
    /** 轨迹 + 装载段（两者同一个文件，见 writeInit）。 */
    sink: TraceSink | undefined;
    recorder: SessionRecorder | null;
  }

  // 转发 sink：所有写入都问「当前是哪个」，这样换会话不需要重建 store。
  const delegator: TraceSink = {
    append: (line) => {
      const target = current.sink;
      return target ? target.append(line) : undefined;
    },
  };

  const openResources = (id: string, resumeFrom?: number): SessionResources => {
    const dir = options.traceDir;
    return {
      sessionId: id,
      sink: dir === null ? undefined : createFileSink(tracePath(id, dir ?? undefined)),
      recorder: null, // 由下面的 openRecorder 填（它要等 store 建好）
    };
  };

  let current: SessionResources = openResources(options.sessionId ?? newSessionId());
  const sessionId = current.sessionId;
  const cwd = path.resolve(options.cwd ?? process.cwd());

  const { store, persistence } = createPersistentStore({
    runtime,
    systemPrompt: options.systemPrompt,
    cwd,
    sessionId,
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.llmTimeoutMs !== undefined ? { llmTimeoutMs: options.llmTimeoutMs } : {}),
    ...(options.maxLlmAttempts !== undefined ? { maxLlmAttempts: options.maxLlmAttempts } : {}),
    ...(options.traceDir === null ? {} : { traceSink: delegator }),
    ...(options.onTraceError ? { onTraceError: options.onTraceError } : {}),
  });

  // ── 装载：prompt 与 model 各走一条 action 打进状态树 ──
  //
  // 为什么走 action 而不是直接写进 createInitialState：
  // 「装载」和「跑一轮对话」是同一类事（都是状态迁移），走 action 才能被落盘、被回放。
  // 回放时读到 init 段就知道当时发给模型的是什么，不必重装配工具、不必再问 provider 能力。
  //
  // 放在 store 建好之后：它们本身就是 dispatch，得走真实的 store。
  const toolList = getTools(cwd);
  store.dispatch({
    type: 'prompt.init',
    systemPrompt: options.systemPrompt,
    tools: toolList.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  });
  store.dispatch({
    type: 'model.init',
    provider: runtime.spec.provider,
    modelId: runtime.model.id,
    thinkingLevel: options.thinkingLevel ?? 'off',
    capabilities: readCapabilities(runtime.model),
  });

  // 装载段落盘：**写进同一个轨迹文件的前两行**（不再单独一个 `<id>.init.jsonl`）。
  // 有了它，回放时不必重装配工具、不必再问 provider「这个模型支持中途插 system 吗」。
  //
  // 走 delegator（同一个 sink）而不是另开一个文件：少一半文件，目录里全是 jsonl 很难翻。
  // 位置在几条 add 记录之后，这是**必然**的：`tools` 要从 store 读（那上面才有完整的工具定义），
  // 而装载动作本身（prompt.init / model.init）也会各自开出一个轨迹节点并立刻被 flush。
  // 所以 init 只能写在它们之后 —— 这没问题：回放是按 op 类型收集的，与行的先后无关。

  const writeInit = (): void => {
    const capabilities = readCapabilities(runtime.model);
    const records: InitRecord[] = [
      {
        op: 'prompt.init',
        systemPrompt: options.systemPrompt,
        tools: store.getState().prompt.tools,
      },
      {
        op: 'model.init',
        provider: runtime.spec.provider,
        modelId: runtime.model.id,
        thinkingLevel: options.thinkingLevel ?? 'off',
        capabilities,
      },
    ];
    void delegator.append(records.map((r) => JSON.stringify(r)).join('\n'));
  };

  writeInit();

  //
  // 会话记录器：把消息流写成 `sessions/<cwd>/<id>.jsonl`，供「恢复历史」用。
  // 它同样是 store 订阅器 —— 挂在 dispatch 链上，成功失败都记。
  //
  // 写成可替换的：`newSession()` 要换 id（于是换文件），而 store 不重建。
  const openRecorder = (id: string, resumeFrom?: number): SessionRecorder | null => {
    const rec = createSessionRecorder(store, {
      sessionId: id,
      cwd,
      enabled: options.writeSession !== false,
      ...(resumeFrom !== undefined ? { resumeFrom } : {}),
    });
    current = { ...current, sessionId: id, recorder: rec };
    return rec;
  };
  openRecorder(sessionId, options.resumeFrom);

  return {
    store,
    runtime,
    /** 当前会话 id。**会变**（`newSession()` / 恢复历史），所以是取值而不是常量。 */
    get sessionId(): string {
      return current.sessionId;
    },
    persistence,
    /** 当前会话记录器（换会话后指向新的那个）。 */
    get session(): SessionRecorder | null {
      return current.recorder;
    },
    /**
     * 开一个新会话：换 sessionId（于是换文件），清空对话。
     *
     * 为什么不复用 `conversation.reset`：那个默认沿用原 id，之后的消者会追加进
     * **同一个文件** —— 界面上看着像新会话，实际上把上一段历史续写了（这是之前的 bug）。
     *
     * 顺序要紧：先把旧的收掉（flush 缓冲），再换资源，最后 dispatch。反过来的话
     * `conversation.reset` 一发生，旧记录器还会把「清空」这件事当成一次状态变化去写。
     */
    newSession(): { id: string } {
      const previous = current;
      const id = newSessionId();
      const next = openResources(id);
      current = next;
      // 旧记录器先摘掉：它绑在旧 id 上，不该再往旧文件写。
      previous.recorder?.dispose();
      store.dispatch({ type: 'conversation.reset', sessionId: id } as AgentAction);
      openRecorder(id);
      writeInit();
      // 旧 sink 收尾（把缓冲 flush 掉）。
      if (previous.sink?.close) void previous.sink.close();

      return { id };
    },
    /**
     * 恢复一个历史会话：读文件、清空当前对话、把消息灌回去。
     *
     * **零 token** —— 不重跑模型。状态只能由 action 改（本项目的不变式），所以走
     * `conversation.reset` + 逐条 `session.restored`，而不是直接改 state。
     */
    restoreSession(file: string): { id: string; restored: number } {
      const messages = readSessionMessages(file);
      const header = readSession(file)?.header;
      const id = header?.id ?? '';
      // 恢复也换 id：之后的消息要追加进**那个**会话的文件，而不是当前这个。
      const previous = current;
      previous.recorder?.dispose();
      current = openResources(id);
      store.dispatch({ type: 'conversation.reset', sessionId: id } as AgentAction);
      for (const message of messages) {
        store.dispatch({ type: 'session.restored', message } as AgentAction);
      }
      // 恢复出来的消息已经在文件里，记录器游标要从这里接着算，别再写一遍。
      openRecorder(id, messages.length);
      if (previous.sink?.close) void previous.sink.close();

      return { id, restored: messages.length };
    },
    restore(messages: Message[]): void {
      for (const message of messages) {
        store.dispatch({ type: 'session.restored', message } as AgentAction);
      }
    },
    dispose(): void {
      current.recorder?.dispose();
      persistence?.dispose();
      if (current.sink?.close) void current.sink.close();
    },
  };
}
