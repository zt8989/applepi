/**
 * 入口：pi-tui 终端界面。
 *
 * 这是原来 `src/cli.ts`（readline + 手写 ANSI 渲染）的替代品。区别在于：
 *   - 渲染交给 pi-tui 的差分引擎，流式 token 进来时不会整屏闪；
 *   - 界面里有一块**轨迹面板**（默认 Ctrl+R 切页，键位可改），画的是像 git log --graph 一样的一次尝试一节点的树，
 *     超时/失败是树上的节点而不是一行飘过去的红字；
 *   - 轨迹同时追加写进 `traces/<时间戳>_<id>.jsonl`，进程崩了也不丢。
 *
 * 环本身仍然只由本项目的 Redux Loop 驱动（`createPersistentStore`），这里只订阅状态、画界面。
 */
import process from 'node:process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { findSessionFile } from './config-home';
import { defaultProviderSpec, providerNames } from './provider';
import { createKernel, type Kernel } from './kernel';
import { runTui } from './tui/app';
import { setupTheme } from './tui/theme';
import { keyLabel } from './tui/keybindings';
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
  ela                            交互式
  ela -p "问题"                  跑一条就退出（脚本/管道友好）
  pnpm start                     完全等价的入口（在本仓库内开发时用）

选项:
  -p, --print <text>     一次性提问
  -P, --provider <id>    LLM provider（默认 settings.json → models.json 里第一个；可用: ${providerNames().join(', ')})
  -m, --model <id>       模型 id（默认取该 provider 的第一个模型）
  -s, --system <text>    覆盖 system prompt 的前言（工具规则 / AGENTS.md / cwd 仍照旧拼上）
      --append-system <t> 追加一条规则（进 <addendum>；.pi/APPEND_SYSTEM.md 优先）
      --max-turns <n>    单回合最多几轮 LLM 调用（默认不限制）
      --llm-timeout <ms> 一次 LLM 调用的超时（默认 120000）；超时按可重试错误处理
      --attempts <n>     单轮内最多几次 LLM 尝试（含首次，默认 2；超时/网络错会自动重试）
      --api-key <key>    直接给 key（否则读 DEEPSEEK_API_KEY）
      --demo             不打网络：用 pi-ai 自带的 faux provider 跑一遍完整环
      --no-trace         不把轨迹落盘到 traces/
      --no-extensions    不装 pi 扩展（settings.json 的 packages）
      --session <id>     指定会话 id（决定 sessions/ 与 traces/ 里的文件名；支持 pi 的 UUIDv7）
      --skill <path>     额外的 skill 文件或目录（可重复；默认扫 ~/.pi/agent/skills 与 <cwd>/.pi/skills）
      --cwd <dir>       工具的工作目录（文件操作边界，默认当前目录）
      --trace-dir <dir> 轨迹目录（默认 ~/.pi/agent/traces）
  -h, --help             显示本帮助

内置工具（默认 read / write / edit / bash；powershell / grep / find / ls 默认关，
在 ~/.pi/agent/settings.json 的 defaultTools 里用 "+powershell" 这样开）：
  read       - 读文件
  write      - 写文件
  edit       - 按 oldText 精确替换
  bash       - 执行 bash 命令
  powershell - 执行 PowerShell 命令
  grep       - 搜文件内容（需要 ripgrep）
  find       - 按 glob 找文件（需要 fd）
  ls         - 列目录内容

界面里（键名按当前键位解析，改过 ~/.pi/agent/keybindings.json 就会跟着变）:
  ${keyLabel('app.trace.toggle').padEnd(19)}在「对话」与「轨迹」两页之间切换（顶部有页签）
  Alt+↑/↓ 或 Ctrl+P/N   翻当前页（半页）；纯 ↑↓ 是移动光标，不拿来滚
  ${keyLabel('app.tools.expand').padEnd(19)}展开/收起工具输出的完整内容（默认只留前 12 行）
  ${keyLabel('app.thinking.toggle').padEnd(19)}展开/收起模型的思考块（与 pi 的 app.thinking.toggle 同键）
  ${keyLabel('app.queue.cycle').padEnd(19)}切换入队模式：steer（工具跑完后插进去）／followUp（说完再插）
  ${keyLabel('app.model.select').padEnd(19)}打开模型选择面板（与 pi 的 app.model.select 同键）
  ${keyLabel('app.abort').padEnd(19)}环在跑时中断这一轮；空闲时退出
  /hotkeys              列出全部键位（与 pi 的 /hotkeys 同形）
  /model [id]           换模型（不给 id 就弹面板；给了精确命中就直接切）
  /scoped-models        启用/禁用哪些模型参与 Ctrl+P 循环（Ctrl+S 存进 settings）
  /skills               列出已装载的 skill
  /skill:<名字> [问题]  把某个 skill 的正文展开后连同你的问题一起发给模型

生成中也能说话（不用等）:
  直接敲字回车     → 按当前入队模式排队，默认 steer
                    模型会在「本步工具跑完后」看到它
  ${keyLabel('app.queue.cycle')} 切到 followUp 再敲 → 等模型说完、开一个新回合才插
  底区会一直列着排队的消息（Steering: / Follow-up:），投递后自动消失
`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    // provider/model 留空 → 走 defaultProviderSpec()：先读 ~/.pi/agent/settings.json，
    // 再退到**动态**兜底（models.json 里第一个 provider，见 fallbackProviderSpec）。
    // 不写死任何 provider 名。命令行 -P/-m 仍然优先。
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
      // 没给 -P/-m 就用默认（settings.json → 动态兜底）
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

  // `--session <id>` 不只是「用这个 id 建一个新的」—— 如果那个 id 已经有会话文件，
  // 就**真的把它恢复**（读消息 + 轨迹树，零 token）。
  //
  // ## 为什么要有这一段
  //
  // 退出时我们打的那行是 `ela --session <id>`（见 config-home 的
  // `resumeCommand()`）。既然提示的是「用这个 id 恢复」，那把它交回本项目自己时
  // 就得真恢复 —— 否则那行提示就是谎话，而用户看不出区别（界面起来了、只是空空如也）。
  //
  // 用 `findSessionFile` 而不是拼路径：文件名带时间戳（与 pi 一致），只有扫目录才找得到；
  // 它同时认旧名（`<id>.jsonl`）。找不到 = 新会话，什么都不做。
  if (args.sessionId !== undefined) {
    const file = findSessionFile(args.sessionId, args.cwd);
    if (existsSync(file)) {
      try {
        await kernel.restoreSession(file);
      } catch (error) {
        // 恢复失败不该让整个界面起不来：那个 id 的文件坏了（半行、权限），
        // 就退化成「新会话用这个 id」—— 比一个打不开的界面好，且后续写入会接着那个文件。
        process.stderr.write(
          `恢复 ${args.sessionId} 失败（当成新会话继续）：${String(error instanceof Error ? error.message : error)}\n`,
        );
      }
    }
  }

  const prompt = args.prompt ?? (args.demo ? '算一下 (3+4)*6' : undefined);
  process.exitCode = await runTui({
    store: kernel.store,
    // 底栏显示工作目录（与工具的文件边界同一个）。
    cwd: args.cwd,
    // 把内核的「开新会话」交进去 —— TUI 只拿 store，换 id（于是换文件）要内核出手。
    newSession: () => kernel.newSession(),
    // 恢复历史：也必须走内核（换 id + 记录器游标对齐），界面自己做会把历史重写一遍。
    restoreSession: (file: string) => kernel.restoreSession(file),
    // 换模型：dispatch `model.changed` + `model.init`（能力与窗口随模型变），
    // 且**先查模型存在**。界面自己 dispatch 也能让底栏变，但那样绕过了那道闸。
    setModel: (provider: string, modelId: string) => kernel.setModel(provider, modelId),
    // 面板要列模型，就要有 provider 装配。**给真的 runtime**（内核持有的那个 `AgentRuntime`）——
    // 它与 `createRuntime` 装的是同一个对象，面板看到的模型目录与实际发请求的目录同源。
    runtime: kernel.runtime,
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
    //
    // `entries`（入口 + 来源）才是那一节要报的：`tools` 是工具名，报出去会让人
    // 拿着工具名去 settings 的 `packages` 里找那个扩展（见 resource-labels.ts）。
    extensions: {
      entries: kernel.extensions.entries,
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
