/**
 * 入口：pi-tui 终端界面。
 *
 * 这是原来 `src/cli.ts`（readline + 手写 ANSI 渲染）的替代品。区别在于：
 *   - 渲染交给 pi-tui 的差分引擎，流式 token 进来时不会整屏闪；
 *   - 界面里有一块**轨迹面板**（Ctrl+T），画的是像 git log --graph 一样的一次尝试一节点的树，
 *     超时/失败是树上的节点而不是一行飘过去的红字；
 *   - 轨迹同时追加写进 `.trace/<sessionId>.jsonl`，进程崩了也不丢。
 *
 * 环本身仍然只由本项目的 Redux Loop 驱动（`createPersistentStore`），这里只订阅状态、画界面。
 */
import process from 'node:process';
import {
  createFauxRuntime,
  createRuntime,
  demoResponses,
  providerNames,
  type AgentRuntime,
} from './provider';
import { createPersistentStore } from './store';
import { createFileSink, tracePath } from './trace-file';
import { newSessionId } from './trace';
import { runTui } from './tui/app';

const DEFAULT_SYSTEM_PROMPT = [
  '你是一个跑在终端里的编码助手。',
  '需要实时信息、算术或文件内容时，用提供的工具去查，不要凭空猜。',
  '回答保持简短、直给；用用户的语言回答。',
].join('\n');

interface CliArgs {
  provider: string;
  model?: string;
  system: string;
  maxTurns: number;
  prompt?: string;
  apiKey?: string;
  llmTimeoutMs?: number;
  maxLlmAttempts?: number;
  help: boolean;
  demo: boolean;
  noTrace: boolean;
  sessionId?: string;
}

const USAGE = `redux-agent —— Redux Loop 驱动的 Agent Loop（pi-tui 界面）

用法:
  redux-agent                      交互式
  redux-agent -p "问题"            跑一条就退出（脚本/管道友好）

选项:
  -p, --print <text>     一次性提问
  -P, --provider <id>    LLM provider（默认 deepseek；可用: ${providerNames().join(', ')}）
  -m, --model <id>       模型 id（默认取该 provider 的第一个模型）
  -s, --system <text>    覆盖 system prompt
      --max-turns <n>    单回合最多几轮 LLM 调用（默认 25）
      --llm-timeout <ms> 一次 LLM 调用的超时（默认 120000）；超时按可重试错误处理
      --attempts <n>     单轮内最多几次 LLM 尝试（含首次，默认 2；超时/网络错会自动重试）
      --api-key <key>    直接给 key（否则读 DEEPSEEK_API_KEY）
      --demo             不打网络：用 pi-ai 自带的 faux provider 跑一遍完整环
      --no-trace         不把轨迹落盘到 .trace/
      --session <id>     指定会话 id（决定 .trace/<id>.jsonl 的文件名）
  -h, --help             显示本帮助

界面里:
  Ctrl+T                切换轨迹面板（git log --graph 那棵树，错误也在上面）
  Ctrl+C                环在跑时中断这一轮；空闲时退出
`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    provider: 'deepseek',
    system: DEFAULT_SYSTEM_PROMPT,
    maxTurns: 25,
    help: false,
    demo: false,
    noTrace: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) break;
    const next = () => {
      i += 1;
      const value = argv[i];
      if (value === undefined) throw new Error(`${arg} 缺一个值`);
      return value;
    };
    switch (arg) {
      case '-p':
      case '--print':
        args.prompt = next();
        break;
      case '-P':
      case '--provider':
        args.provider = next();
        break;
      case '-m':
      case '--model':
        args.model = next();
        break;
      case '-s':
      case '--system':
        args.system = next();
        break;
      case '--max-turns':
        args.maxTurns = Number.parseInt(next(), 10);
        break;
      case '--llm-timeout':
        args.llmTimeoutMs = Number.parseInt(next(), 10);
        break;
      case '--attempts':
        args.maxLlmAttempts = Number.parseInt(next(), 10);
        break;
      case '--api-key':
        args.apiKey = next();
        break;
      case '--session':
        args.sessionId = next();
        break;
      case '--demo':
        args.demo = true;
        break;
      case '--no-trace':
        args.noTrace = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`未知选项：${arg}`);
        args.prompt = args.prompt ? `${args.prompt} ${arg}` : arg;
    }
  }
  return args;
}

function buildRuntime(args: CliArgs): AgentRuntime {
  if (args.demo) {
    const faux = createFauxRuntime();
    faux.setResponses(demoResponses());
    return faux.runtime;
  }
  return createRuntime({
    provider: args.provider,
    ...(args.model ? { model: args.model } : {}),
  });
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (args.apiKey) {
    process.env[`${args.provider.toUpperCase().replace(/-/g, '_')}_API_KEY`] = args.apiKey;
  }

  let runtime: AgentRuntime;
  try {
    runtime = buildRuntime(args);
  } catch (error) {
    process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
    process.exitCode = 2;
    return;
  }

  const sessionId = args.sessionId ?? newSessionId();
  // 落盘：追加写 JSONL。错误节点同样会被写进去（落盘器对成功/失败一视同仁）。
  const sink = args.noTrace ? undefined : createFileSink(tracePath(sessionId));

  const { store, persistence } = createPersistentStore({
    runtime,
    systemPrompt: args.system,
    maxTurns: args.maxTurns,
    sessionId,
    ...(args.llmTimeoutMs !== undefined ? { llmTimeoutMs: args.llmTimeoutMs } : {}),
    ...(args.maxLlmAttempts !== undefined ? { maxLlmAttempts: args.maxLlmAttempts } : {}),
    ...(sink ? { traceSink: sink } : {}),
    onTraceError: (error) => {
      process.stderr.write(
        `轨迹落盘失败（不影响对话）：${String(error instanceof Error ? error.message : error)}\n`,
      );
    },
  });

  // 退出前把 pending 的写入刷完，否则最后几行可能还在缓冲里。
  const shutdown = (): void => {
    persistence?.dispose();
    if (sink && 'close' in sink) void sink.close?.();
  };
  process.once('exit', shutdown);

  const prompt = args.prompt ?? (args.demo ? '算一下 (3+4)*6' : undefined);
  process.exitCode = await runTui({ store, ...(prompt !== undefined ? { prompt } : {}) });
}

void main();
