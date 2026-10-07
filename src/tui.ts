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
import { setupTheme } from './tui/theme';
import type { Theme } from '@earendil-works/pi-coding-agent';
// pi 的 theme 是 globalThis 上的一个 Proxy —— initTheme() 之后一直可读。
// 直接 import（不缓存）是为了「initTheme 可能被再调」时读到的是当时那个。
import { theme as piTheme } from '@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import type { HostUiOptions } from './extension-ui';

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
  /** 完全不装 pi 扩展（调试用：jiti 装载那一跳有开销）。 */
  noExtensions: boolean;
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
      --no-extensions    不装 pi 扩展（settings.json 的 packages）
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
    noExtensions: false,
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
      case '--no-extensions':
        args.noExtensions = true;
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
  //
  // **扩展的 UI 宿主必须在内核之前造好** —— 内核 `prompt.init` 那一刻就要知道有哪些
  // 工具进 prompt，而扩展工具的装载要一个 `ui` 形状（虽然那只在工具**被调用**时才
  // 真的用到）。见 `runTui()` 里怎么拿到 tui 实例。
  //
  // 为什么不让内核自己造：它没有界面（一次性模式根本没有界面），而 `ui.custom()`
  // 要的是**活着的** pi-tui 实例（浮层栈、raw input、焦点）。
  let kernel: Kernel;
  // pi-tui 的实例在 runTui() 里才有（主题要先 setup、终端要起来）。内核在它之前
  // 就要装好扩展，所以这里用一个**间接**：`uiRef.current` 由 runTui 填上，扩展的
  // 工具真被调用时读它。
  const uiRef: { current: HostUiOptions | undefined } = { current: undefined };
  // 主题先装一次 —— `ctx.ui.theme` 在**装载期**就要给（见 requireUi 的注释）。
  // `runTui()` 里面会再调一次，那时终端起来了、颜色更准，并把真的那份填进 uiRef。
  setupTheme();
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
      // 一次性模式**不给** uiOptions → 不绑 UI → 官方 `hasUI` 为 false → 扩展把自己的
      // 交互式工具从清单里摘掉。这比「给个空 UI」对：空 UI 的 tui 是 undefined，
      // 扩展一调 `custom()` 就崩在自己的渲染里（实测过）。
      //
      // 交互模式给的是**工厂**：内核装扩展时界面还没起来（`runTui` 里才有 tui），
      // 而扩展工具真被调用时（可能在第一轮之后）读那个引用。
      ...(args.prompt === undefined ? { uiOptions: () => requireUi(uiRef) } : {}),
      ...(args.noExtensions ? { noExtensions: true } : {}),
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
    // 扩展的 `before_agent_start`（内核持有的那个宿主）。
    beforeAgentStart: (text) => kernel.extensions.beforeAgentStart(text),
    // 扩展的斜杠命令与快捷键（补全、`runCommand` 兜底、raw input）。
    extensionCommands: kernel.extensions.commands,
    // 把活着的界面交给内核的扩展宿主（它在装扩展时只能拿到一个待填的引用）。
    publishUi: (options) => {
      uiRef.current = options;
    },
    // 开场报一行装了哪些扩展 + 装载诊断（与 skill 清单同一个口径）。
    extensions: {
      tools: kernel.extensions.tools.map((tool) => tool.name),
      errors: kernel.extensions.errors,
    },
    ...(prompt !== undefined ? { prompt } : {}),
  });
}

/**
 * 取出界面层的 UI 宿主（扩展的 `ctx.ui` 由它造）。
 *
 * ## 拿不到就**抛**，不是给空实现
 *
 * 交互模式下内核已经绑了 UI（`uiOptions` 给了），所以 `hasUI` 是 true —— 扩展会真的
 * 去开对话框。那时如果界面还没起来（理论上不该发生：`publishUi` 在 `tui.start()` 之后
 * 就调了，而用户在首帧之前敲不出字），给一个 `tui: undefined` 会让扩展崩在自己的
 * `requestRender()` 上 —— 那个堆栈与真因隔了三层。
 *
 * 所以这里明说「界面还没起来」。那是一个真 bug，不该被伪装成「没界面」。
 */
/**
 * 扩展的 UI 宿主。**一直都有**（内核装扩展时它已经存在），只是里面的 `tui` 要等
 * 界面起来才填上。
 *
 * ## 为什么不填一个空实现
 *
 * 空实现看着无害，实际有两个后果：
 *
 * 1. 扩展在**装载期**就碰 `ctx.ui.theme`（`bindCore` 在内核装配时调了 `setUIContext`），
 *    那时 `uiRef.current` 还是空的 → `requireUi` 抛 → **整个界面起不来**
 *    （症状：首帧空白、顶栏底栏全没了，而真因在一条日志里）。
 * 2. 「tui 未就绪」这个抛错本身是**对的**（真有方法要一个还不存在的 TUI），
 *    但它不该在「只读个 theme」时被触发。
 *
 * 所以拆开：`theme` 现在就给真的（`setupTheme()` 的返回值，界面起来之前就有），
 * `tui` / `addInputListener` 那几个在界面起来之前调用会**明说「还没就绪」**。
 */
function requireUi(ref: { current: HostUiOptions | undefined }): HostUiOptions {
  const ui = ref.current;
  if (ui) return ui;
  // 界面还没起来。`theme` 仍然给真的（`initTheme` 在内核装配之前就调了）——
  // 扩展在装载期就会碰它。
  return {
    tui: undefined as never,
    theme: preTheme(),
    addInputListener: () => () => {},
    onNotice: (text: string) => {
      // 界面还没起来时扩展的提示无处可去 —— 落到 stderr（那时用户看得到终端）。
      process.stderr.write(`${text}\n`);
    },
    setWidget: () => {},
  };
}

/**
 * 读当前的 theme（**不要求界面已起来**）。
 *
 * pi 的 `theme` 是 globalThis 上的一个 Proxy，`initTheme()` 之后一直可读。
 * 每次现读而不是存一份常量：`initTheme()` 可以被再调（换主题名），而扩展拿到的
 * 引用得是**当时**那个。
 */
function preTheme(): Theme {
  return piTheme;
}

void main();
