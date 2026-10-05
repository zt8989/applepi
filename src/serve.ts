/**
 * Node 服务端入口 —— TUI 的内核和 Web 的内核是**同一个** `createKernel()`。
 *
 * 这就是「共享内核」的全部含义：没有第二份环，没有第二个 store。
 * TUI（`npm start`）和 Web（`npm run serve`）只是给同一个内核换了个渲染层。
 *
 * 用法：
 *   npm run serve                      # 默认 deepseek，读 .env
 *   npm run serve -- --demo            # faux provider，不打网络、不需要 key
 *   npm run serve -- --cwd ../other    # 工具的工作目录（决定文件操作边界）
 *   npm run serve -- --port 8080
 */
import process from 'node:process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_PORT, DEV_KERNEL_PORT, startServer } from './server';
import { renderTree } from './trace';
import { getTools } from './tools';
import { defaultProviderSpec, providerNames } from './provider';

interface Args {
  /** 不给就按 dev 决定（生产 5273 / 开发 5274）。 */
  port?: number | undefined;
  provider: string;
  model?: string;
  cwd: string;
  demo: boolean;
  /** 开发模式：让开 5273 给 vite，内核改用 5274。 */
  dev: boolean;
  noTrace: boolean;
  traceDir?: string;
  llmTimeoutMs?: number;
  maxLlmAttempts?: number;
  maxTurns?: number;
}

const USAGE = `redux-agent serve —— Node 内核 + 网页界面（同一个环）

  -p, --port <n>        端口（默认 5273；被占用会自动 +1）
      --dev             开发模式：让开 5273 给 vite，内核改用 5274，
                        由 vite 反向代理 /api 过来（配合 npm run web）
  -P, --provider <id>   provider（默认 deepseek；可用: ${providerNames().join(', ')}）
  -m, --model <id>      模型 id
      --cwd <dir>       工具的工作目录（文件操作边界，默认当前目录）
      --demo            用 faux provider，不打网络、不需要 key
      --no-trace        不把轨迹落盘
      --trace-dir <dir> 轨迹目录（默认 .trace）
      --llm-timeout <ms>  一次 LLM 调用的超时
      --attempts <n>    单轮内最多几次 LLM 尝试（含首次）
      --max-turns <n>   单回合最多几轮 LLM 调用
  -h, --help            显示本帮助

网页里：Ctrl+T 之类的快捷键由 pi-web-ui 提供；轨迹面板在底部可折叠。
`;

function parseArgs(argv: string[]): Args | { help: true } {
  const args: Args = {
    provider: '',
    cwd: process.cwd(),
    demo: false,
    dev: false,
    noTrace: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) break;
    const next = (): string => {
      i += 1;
      const value = argv[i];
      if (value === undefined) throw new Error(`${arg} 缺一个值`);
      return value;
    };
    switch (arg) {
      case '-p':
      case '--port':
        args.port = Number.parseInt(next(), 10);
        break;
      case '-P':
      case '--provider':
        args.provider = next();
        break;
      case '-m':
      case '--model':
        args.model = next();
        break;
      case '--cwd':
        args.cwd = path.resolve(next());
        break;
      case '--demo':
        args.demo = true;
        break;
      case '--dev':
        args.dev = true;
        break;
      case '--no-trace':
        args.noTrace = true;
        break;
      case '--trace-dir':
        args.traceDir = next();
        break;
      case '--llm-timeout':
        args.llmTimeoutMs = Number.parseInt(next(), 10);
        break;
      case '--attempts':
        args.maxLlmAttempts = Number.parseInt(next(), 10);
        break;
      case '--max-turns':
        args.maxTurns = Number.parseInt(next(), 10);
        break;
      case '-h':
      case '--help':
        return { help: true };
      default:
        if (arg.startsWith('-')) throw new Error(`未知选项：${arg}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  let parsed: Args | { help: true };
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
    process.exitCode = 2;
    return;
  }
  if ('help' in parsed) {
    process.stdout.write(USAGE);
    return;
  }

  const webRoot = path.resolve(parsed.cwd, 'web/dist');
  const hasWeb = existsSync(webRoot);

  const server = await startServer({
    // 开发模式让开 5273 给 vite（vite 把 /api 代理过来）。
    port: parsed.port ?? (parsed.dev ? DEV_KERNEL_PORT : DEFAULT_PORT),
    // 没给 -P/-m 就用默认（settings.json → 兜底 workbuddy/cn:space-bunny）
    ...defaultProviderSpec(),
    ...(parsed.provider ? { provider: parsed.provider } : {}),
    ...(parsed.model ? { model: parsed.model } : {}),
    cwd: parsed.cwd,
    demo: parsed.demo,
    llmTimeoutMs: parsed.llmTimeoutMs,
    maxLlmAttempts: parsed.maxLlmAttempts,
    maxTurns: parsed.maxTurns,
    traceDir: parsed.noTrace ? null : (parsed.traceDir ?? undefined),
    webRoot: hasWeb ? webRoot : undefined,
  });

  const tools = getTools(parsed.cwd);
  process.stdout.write(
    [
      `内核已启动：http://localhost:${server.port}`,
      `  provider  ${server.kernel.runtime.spec.provider} / ${server.kernel.runtime.model.id}`,
      `  cwd       ${parsed.cwd}   ← 工具的文件操作边界`,
      `  tools     ${tools.map((t) => t.name).join(', ')}`,
      `  session   ${server.kernel.sessionId}`,
      hasWeb
        ? `  页面      已从 ${webRoot} 提供`
        : `  页面      还没构建（先跑 npm run web:build）`,
      '',
      // 开发模式下要说清「浏览器该开哪个」—— 这是最容易搞错的一步。
      parsed.dev
        ? [
            '开发模式：5273 归 vite，浏览器请开 http://localhost:5273',
            `          （vite 会把 /api 代理到本进程 ${server.port}；先另开终端跑 npm run web）`,
            `          没起 vite 的话直接访问本进程 ${server.port} 也能用 API，但没有页面。`,
          ].join('\n')
        : '提示：环只在 Node 这一侧跑。浏览器通过 SSE 订阅状态树、POST 发消息。',
      '      文件工具摸的是真实文件系统；Ctrl-C 中断请用界面按钮或另开终端。',
      '',
    ].join('\n'),
  );

  const shutdown = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${String(error instanceof Error ? error.stack : error)}\n`);
  process.exitCode = 1;
});
