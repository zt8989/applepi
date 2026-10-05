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
import path from 'node:path';
import { defaultProviderSpec, providerNames } from './provider';
import { createKernel, type Kernel } from './kernel';
import { runTui } from './tui/app';

const DEFAULT_SYSTEM_PROMPT = [
  '你是一个跑在终端里的编码助手。',
  '需要实时信息、算术或文件内容时，用提供的工具去查，不要凭空猜。',
  '回答保持简短、直给；用用户的语言回答。',
].join('\n');

interface CliArgs {
  /** 命令行没给就留空 → 走 defaultProviderSpec()（settings.json → 兜底）。 */
  provider: string;
  model?: string | undefined;
  system: string;
  maxTurns?: number | undefined;
  prompt?: string;
  apiKey?: string;
  llmTimeoutMs?: number;
  maxLlmAttempts?: number;
  help: boolean;
  demo: boolean;
  noTrace: boolean;
  sessionId?: string;
  /** 工具的工作目录（文件操作边界）。 */
  cwd: string;
  traceDir?: string;
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
      --max-turns <n>    单回合最多几轮 LLM 调用（默认不限制）
      --llm-timeout <ms> 一次 LLM 调用的超时（默认 120000）；超时按可重试错误处理
      --attempts <n>     单轮内最多几次 LLM 尝试（含首次，默认 2；超时/网络错会自动重试）
      --api-key <key>    直接给 key（否则读 DEEPSEEK_API_KEY）
      --demo             不打网络：用 pi-ai 自带的 faux provider 跑一遍完整环
      --no-trace         不把轨迹落盘到 .trace/
      --session <id>     指定会话 id（决定 .trace/<id>.jsonl 的文件名）
      --cwd <dir>       工具的工作目录（文件操作边界，默认当前目录）
      --trace-dir <dir> 轨迹目录（默认 .trace）
  -h, --help             显示本帮助

界面里:
  Ctrl+T                切换轨迹面板（git log --graph 那棵树，错误也在上面）
  Ctrl+C                环在跑时中断这一轮；空闲时退出
`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    // provider/model 留空 → 走 defaultProviderSpec()：先读 ~/.pi/agent/settings.json，
    // 再退到内置兜底 workbuddy / cn:space-bunny。命令行 -P/-m 仍然优先。
    provider: '',
    model: undefined,
    system: DEFAULT_SYSTEM_PROMPT,
    // 不给默认上限：模型要查多少轮由它自己说了算，--max-turns 留给需要兜底的人。
    maxTurns: undefined,
    help: false,
    demo: false,
    noTrace: false,
    cwd: process.cwd(),
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
      case '--cwd':
        // 工具的文件操作边界由它决定。
        args.cwd = path.resolve(next());
        break;
      case '--trace-dir':
        args.traceDir = next();
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

  // 内核：和 `npm run serve`（Web）用的是**同一个** createKernel()。
  // 两个界面只是同一个环的两个渲染层 —— 没有第二份 store，也没有第二份环。
  let kernel: Kernel;
  try {
    kernel = createKernel({
      // 没给 -P/-m 就用默认（settings.json → 兜底 workbuddy/cn:space-bunny）
      ...defaultProviderSpec(),
      ...(args.provider ? { provider: args.provider } : {}),
      ...(args.model ? { model: args.model } : {}),
      systemPrompt: args.system,
      cwd: args.cwd,
      demo: args.demo,
      maxTurns: args.maxTurns,
      llmTimeoutMs: args.llmTimeoutMs,
      maxLlmAttempts: args.maxLlmAttempts,
      ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
      traceDir: args.noTrace ? null : args.traceDir,
      onTraceError: (error) => {
        process.stderr.write(
          `轨迹落盘失败（不影响对话）：${String(error instanceof Error ? error.message : error)}\n`,
        );
      },
    });
  } catch (error) {
    process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
    process.exitCode = 2;
    return;
  }

  process.once('exit', () => kernel.dispose());

  const prompt = args.prompt ?? (args.demo ? '算一下 (3+4)*6' : undefined);
  process.exitCode = await runTui({
    store: kernel.store,
    // 把内核的「开新会话」交进去 —— TUI 只拿 store，换 id（于是换文件）要内核出手。
    newSession: () => kernel.newSession(),
    // 当前会话 id 也要给：`/clean` 删历史时得放行它（记录器正开着那个文件）。
    // 注意它是**取值**不是常量：开新会话后 id 会变。
    sessionId: () => kernel.sessionId,
    ...(prompt !== undefined ? { prompt } : {}),
  });
}

void main();
