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
import type { TracePersistence } from './trace-store';

export interface KernelOptions {
  provider: string;
  model?: string | undefined;
  systemPrompt: string;
  /** 工作目录：官方工具用它做路径边界检查（防止模型跑出这个目录）。 */
  cwd: string;
  /** 不打网络，用 pi-ai 的 faux provider。 */
  demo?: boolean | undefined;
  llmTimeoutMs?: number | undefined;
  maxLlmAttempts?: number | undefined;
  maxTurns?: number | undefined;
  sessionId?: string | undefined;
  /** 传 null 就完全不落盘。 */
  traceDir?: TraceDir | null | undefined;
  onTraceError?: ((error: unknown) => void) | undefined;
}

export interface Kernel {
  store: AgentStore;
  runtime: AgentRuntime;
  sessionId: string;
  persistence: TracePersistence | null;
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
  // 工具：官方的 read/write/edit/bash，cwd 限定在 options.cwd。
  const sink =
    options.traceDir === null
      ? undefined
      : createFileSink(tracePath(sessionId, options.traceDir ?? undefined));

  const { store, persistence } = createPersistentStore({
    runtime,
    systemPrompt: options.systemPrompt,
    cwd: options.cwd,
    sessionId,
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.llmTimeoutMs !== undefined ? { llmTimeoutMs: options.llmTimeoutMs } : {}),
    ...(options.maxLlmAttempts !== undefined ? { maxLlmAttempts: options.maxLlmAttempts } : {}),
    ...(sink ? { traceSink: sink } : {}),
    ...(options.onTraceError ? { onTraceError: options.onTraceError } : {}),
  });

  return {
    store,
    runtime,
    sessionId,
    persistence,
    dispose(): void {
      persistence?.dispose();
      if (sink?.close) void sink.close();
    },
  };
}
