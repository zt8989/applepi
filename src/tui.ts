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

/**
 * **没有手写的 default system prompt。**
 *
 * 早先这里硬编码了三行中文（"你是编码助手 / 用工具查 / 简短直给"）。现在整份 prompt 由
 * pi 的 `buildSystemPrompt` 拼（工具规则、`edit` 的坑、`AGENTS.md` 项目上下文、cwd、
 * skill 清单），见 [system-prompt.ts](system-prompt.ts)。
 *
 * `--system` 变成**可选**的覆盖：给了它顶掉 pi 的 preamble（"你是 pi 里的编码助手"），
 * 其余各段（tools / rules / project_context / cwd / skills）照旧拼上 ——
 * 「我是这个项目的专用助手」不该顺带丢掉工具怎么用。
 */

interface CliArgs {
  /** 命令行没给就留空 → 走 defaultProviderSpec()（settings.json → 兜底）。 */
  provider: string;
  model?: string | undefined;
  /** 不给 → 走 pi 的 buildSystemPrompt（见上）。 */
  system?: string | undefined;
  /** 追加规则（进 <addendum>）；文件 `.pi/APPEND_SYSTEM.md` 优先。 */
  appendSystem?: string | undefined;
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
  /** 额外的 skill 路径（文件或目录），可重复。 */
  skillPaths: string[];
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
  -s, --system <text>    覆盖 system prompt 的前言（工具规则 / AGENTS.md / cwd 仍照旧拼上）
      --append-system <t> 追加一条规则（进 <addendum>；.pi/APPEND_SYSTEM.md 优先）
      --max-turns <n>    单回合最多几轮 LLM 调用（默认不限制）
      --llm-timeout <ms> 一次 LLM 调用的超时（默认 120000）；超时按可重试错误处理
      --attempts <n>     单轮内最多几次 LLM 尝试（含首次，默认 2；超时/网络错会自动重试）
      --api-key <key>    直接给 key（否则读 DEEPSEEK_API_KEY）
      --demo             不打网络：用 pi-ai 自带的 faux provider 跑一遍完整环
      --no-trace         不把轨迹落盘到 .trace/
      --session <id>     指定会话 id（决定 .trace/<id>.jsonl 的文件名）
      --skill <path>     额外的 skill 文件或目录（可重复；默认扫 ~/.pi/agent/skills 与 <cwd>/.pi/skills）
      --cwd <dir>       工具的工作目录（文件操作边界，默认当前目录）
      --trace-dir <dir> 轨迹目录（默认 .trace）
  -h, --help             显示本帮助

界面里:
  Ctrl+T                切换轨迹面板（git log --graph 那棵树，错误也在上面）
  Ctrl+O                展开/收起工具输出的完整内容（默认只留前 12 行）
  Ctrl+C                环在跑时中断这一轮；空闲时退出
  /skills               列出已装载的 skill
  /skill:<名字> [问题]  把某个 skill 的正文展开后连同你的问题一起发给模型
`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    // provider/model 留空 → 走 defaultProviderSpec()：先读 ~/.pi/agent/settings.json，
    // 再退到内置兜底 workbuddy / cn:space-bunny。命令行 -P/-m 仍然优先。
    provider: '',
    model: undefined,
    // **不给 system**：用 pi 拼的那份（工具规则 / AGENTS.md / cwd / skill）。
    system: undefined,
    appendSystem: undefined,
    // 不给默认上限：模型要查多少轮由它自己说了算，--max-turns 留给需要兜底的人。
    maxTurns: undefined,
    help: false,
    demo: false,
    noTrace: false,
    cwd: process.cwd(),
    skillPaths: [],
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
        // 覆盖 pi 的 preamble，其余段不变。
        args.system = next();
        break;
      case '--append-system':
        // 追加规则（<addendum> 段）；`.pi/APPEND_SYSTEM.md` 存在时那个优先。
        args.appendSystem = next();
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
      case '--skill':
        // 可重复：--skill a --skill b
        args.skillPaths.push(next());
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

  // 内核：整个应用里唯一的一次 createKernel() 装配，界面只拿到它的 store。
  // 没有第二份 store，也没有第二份环。
  let kernel: Kernel;
  try {
    kernel = await createKernel({
      // 没给 -P/-m 就用默认（settings.json → 兜底 workbuddy/cn:space-bunny）
      ...defaultProviderSpec(),
      ...(args.provider ? { provider: args.provider } : {}),
      ...(args.model ? { model: args.model } : {}),
      systemPrompt: args.system,
      appendSystemPrompt: args.appendSystem,
      cwd: args.cwd,
      ...(args.skillPaths.length > 0 ? { skillPaths: args.skillPaths } : {}),
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
    // 底栏显示工作目录（与工具的文件边界同一个）。
    cwd: args.cwd,
    // 把内核的「开新会话」交进去 —— TUI 只拿 store，换 id（于是换文件）要内核出手。
    newSession: () => kernel.newSession(),
    // 恢复历史：也必须走内核（换 id + 记录器游标对齐），界面自己做会把历史重写一遍。
    restoreSession: (file: string) => kernel.restoreSession(file),
    // 当前会话 id 也要给：`/clean` 删历史时得放行它（记录器正开着那个文件）。
    // 注意它是**取值**不是常量：开新会话后 id 会变。
    sessionId: () => kernel.sessionId,
    ...(prompt !== undefined ? { prompt } : {}),
  });
}

void main();
