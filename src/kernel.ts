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
import { createFileSink, initPath, tracePath, type TraceDir } from './trace-file';
import { newSessionId } from './trace';
import type { AgentStore } from './store';
import type { InitRecord, TracePersistence } from './trace-store';
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
  sessionId: string;
  persistence: TracePersistence | null;
  /** 会话文件记录器（写 `sessions/<cwd>/<id>.jsonl`，供「恢复历史」用）。 */
  session: SessionRecorder | null;
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

  const sessionId = options.sessionId ?? newSessionId();
  // 两个 sink：轨迹（对话级，追加频繁）与装载段（会话级，只写一次）。
  // 分开两个文件是因为生命周期不同 —— 回放一段对话不必先跳过一堆装载记录。
  const sink =
    options.traceDir === null
      ? undefined
      : createFileSink(tracePath(sessionId, options.traceDir ?? undefined));
  const initSink =
    options.traceDir === null
      ? undefined
      : createFileSink(initPath(sessionId, options.traceDir ?? undefined));
  const cwd = path.resolve(options.cwd ?? process.cwd());

  const { store, persistence } = createPersistentStore({
    runtime,
    systemPrompt: options.systemPrompt,
    cwd,
    sessionId,
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.llmTimeoutMs !== undefined ? { llmTimeoutMs: options.llmTimeoutMs } : {}),
    ...(options.maxLlmAttempts !== undefined ? { maxLlmAttempts: options.maxLlmAttempts } : {}),
    ...(sink ? { traceSink: sink } : {}),
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

  // 装载段落盘：与轨迹分开一个文件（会话级 vs 对话级）。
  // 有了它，回放时不必重装配工具、不必再问 provider「这个模型支持中途插 system 吗」。
  if (initSink) {
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
    void initSink.append(records.map((r) => JSON.stringify(r)).join('\n'));
  }

  // 会话记录器：把消息流写成 `sessions/<cwd>/<id>.jsonl`，供「恢复历史」用。
  // 和轨迹落盘器一样是 store 订阅器 —— 挂在 dispatch 链上，成功失败都记。
  const recorder = createSessionRecorder(store, {
    sessionId,
    cwd,
    enabled: options.writeSession !== false,
    ...(options.resumeFrom !== undefined ? { resumeFrom: options.resumeFrom } : {}),
  });

  return {
    store,
    runtime,
    sessionId,
    persistence,
    session: recorder,
    /**
     * 恢复一个历史会话：读文件、清空当前对话、把消息灌回去。
     *
     * **零 token** —— 不重跑模型。状态只能由 action 改（本项目的不变式），所以走
     * `conversation.reset` + 逐条 `session.restored`，而不是直接改 state。
     */
    restoreSession(file: string): { id: string; restored: number } {
      const messages = readSessionMessages(file);
      const id = readSession(file)?.header.id ?? '';
      store.dispatch({ type: 'conversation.reset' } as AgentAction);
      for (const message of messages) {
        store.dispatch({ type: 'session.restored', message } as AgentAction);
      }
      return { id, restored: messages.length };
    },
    restore(messages: Message[]): void {
      for (const message of messages) {
        store.dispatch({ type: 'session.restored', message } as AgentAction);
      }
    },
    dispose(): void {
      recorder?.dispose();
      persistence?.dispose();
      if (sink?.close) void sink.close();
      if (initSink?.close) void initSink.close();
    },
  };
}
