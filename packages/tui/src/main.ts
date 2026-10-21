/**
 * 入口：pi-tui 终端界面。
 *
 * 这是原来手写 ANSI 渲染的 `cli.ts`（已删）的替代品。区别在于：
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
import { findSessionFile } from '@ela/core/config-home';
import { defaultProviderSpec, providerNames } from '@ela/core/provider';
import { THINKING_LEVELS, isThinkingLevel } from '@ela/core/thinking-level';
import { createKernel, type Kernel } from '@ela/core/kernel';
import { startHerdrReporting } from '@ela/core/herdr';
import { cwdLine, gitBranch, runTui, SLASH_COMMANDS, statsLine } from './app';
import { setupTheme } from './theme';
import { keyLabel } from './keybindings';
import { WebBridge } from './web/bridge';
import { createWebApi } from './web/api';
import { startWebServer, type WebServerHandle } from './web/server';
import { modelRuntimeFor } from './model-picker';
import type { Theme } from '@earendil-works/pi-coding-agent';
// pi 的 theme 是 globalThis 上的一个 Proxy —— initTheme() 之后一直可读。
// 直接 import（不缓存）是为了「initTheme 可能被再调」时读到的是当时那个。
import { theme as piTheme } from '@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { HostUiOptions } from '@ela/core/extension-ui';

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
  /**
   * `--thinking`（与 pi 同名同义）。不认的值**告警并忽略**，而不是报错退出 —— 与 pi 一致。
   *
   * 不给就按 pi 的顺序解析（会话文件 → settings 的 per-model → 全局默认 → `medium`，
   * 再 clamp 到模型支持的那几档，见 `kernel.ts` 的注释）。
   */
  thinking?: ModelThinkingLevel | undefined;
  /**
   * `-m id:high` 那个后缀（pi 的「model pattern 的可选 `:<thinking>` 后缀」）。
   *
   * 单独一个字段而不是直接写进 `thinking`：pi 的规则是「`--thinking` **压过** `--model` 的
   * 后缀」（`main.js`：后缀先定、`--thinking` 后应用），而这里参数是**按出现顺序**解析的 ——
   * `-m x:low --thinking high` 与 `--thinking high -m x:low` 都该得 `high`。
   * 两个字段分开存，最后 `thinking ?? modelThinking` 合一次就与顺序无关了。
   */
  modelThinking?: ModelThinkingLevel | undefined;
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
  noTrace: boolean;
  /** 起浏览器界面（`--web`）。**默认不起** —— 那是一个监听端口的服务，不开就不该占端口。 */
  web: boolean;
  /** web ui 的端口（默认 30141；被占就往后试）。**给了它就隐含 `--web`**。 */
  webPort?: number | undefined;
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
                         可选后缀 :<级别>，如 -m cn:deepseek-v4.1-flash:high（--thinking 压过它）
      --thinking <lvl>   思考级别：${THINKING_LEVELS.join('/')}
                         （与 pi 同义；不给就按 pi 的顺序解析：会话 → settings → medium，再按模型支持的那几档夹）
  -s, --system <text>    覆盖 system prompt 的前言（工具规则 / AGENTS.md / cwd 仍照旧拼上）
      --append-system <t> 追加一条规则（进 <addendum>；.pi/APPEND_SYSTEM.md 优先）
      --max-turns <n>    单回合最多几轮 LLM 调用（默认不限制）
      --llm-timeout <ms> 一次 LLM 调用的超时（默认 120000）；超时按可重试错误处理
      --attempts <n>     单轮内最多几次 LLM 尝试（含首次，默认 2；超时/网络错会自动重试）
      --api-key <key>    直接给 key（否则读 DEEPSEEK_API_KEY）
      --no-trace         不把轨迹落盘到 traces/
      --no-extensions    不装 pi 扩展（settings.json 的 packages）
      --session <id>     指定会话 id（决定 sessions/ 与 traces/ 里的文件名；支持 pi 的 UUIDv7）
      --skill <path>     额外的 skill 文件或目录（可重复；默认扫 ~/.pi/agent/skills 与 <cwd>/.pi/skills）
      --cwd <dir>       工具的工作目录（文件操作边界，默认当前目录）
      --trace-dir <dir> 轨迹目录（默认 ~/.pi/agent/traces）
      --web              起浏览器界面（默认不起；只绑 127.0.0.1，无认证）
      --web-port <n>    浏览器界面的端口（默认 30141；被占就往后试；给了它就隐含 --web）
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

浏览器界面（默认不起，\`--web\` 打开）:
  http://127.0.0.1:30141/   pi-web-ui 的聊天界面。环仍然是终端这一个进程里的那一份 ——
                            浏览器只是订阅它、往里发话（模型密钥与工具都在服务端）。
                            前端要先构建一次：\`pnpm build\`（没构建会显示一页说明）。
                            只绑本机、无认证：工具没有沙箱，别把它挂到局域网上。

界面里（键名按当前键位解析，改过 ~/.pi/agent/keybindings.json 就会跟着变）:
  ${keyLabel('app.trace.toggle').padEnd(19)}在「对话」与「轨迹」两页之间切换（顶部有页签）
  ${(keyLabel('tui.altScreen.pageUp') + '/' + keyLabel('tui.altScreen.pageDown')).padEnd(19)}翻当前页（整页，只滚当前那一页；半页见 /hotkeys）
  ${keyLabel('app.message.dequeue').padEnd(19)}把排队消息还回输入框（pi 的 app.message.dequeue）
  ${keyLabel('app.tools.expand').padEnd(19)}展开/收起工具输出的完整内容（默认只留前 12 行）
  ${keyLabel('app.thinking.toggle').padEnd(19)}展开/收起模型的思考块（与 pi 的 app.thinking.toggle 同键）
  ${keyLabel('app.model.select').padEnd(19)}打开模型选择面板（与 pi 的 app.model.select 同键）
  ${keyLabel('app.interrupt').padEnd(19)}中断当前回合（有排队消息时先还回输入框）
  ${keyLabel('app.clear').padEnd(19)}清空编辑器（连按两次退出）；${keyLabel('app.exit')} 直接退出
  /hotkeys              列出全部键位（与 pi 的 /hotkeys 同形）
  /model [id]           换模型（不给 id 就弹面板；给了精确命中就直接切）
  /thinking [级别]      思考级别（不给就弹面板，面板里 Ctrl+S 存默认；给了就直接切）
  /settings             设置面板（自动压缩 / 隐藏思考块 / 每个模型的默认思考级别）
  /scoped-models        启用/禁用哪些模型参与 Ctrl+P 循环（Ctrl+S 存进 settings）
  /skills               列出已装载的 skill
  /skill:<名字> [问题]  把某个 skill 的正文展开后连同你的问题一起发给模型

生成中也能说话（不用等）:
  回车             → steer：模型会在「本步工具跑完后」看到它
  ${keyLabel('app.message.followUp')}   → followUp：等模型说完、开一个新回合才插
  底区会一直列着排队的消息（Steering: / Follow-up: 加一行「怎么拿回来」），投递后消失
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
    noTrace: false,
    web: false,
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
      case '--model': {
        // pi 的「可选 `:<thinking>` 后缀」（`--model provider/id:high`）。
        //
        // 只把**最后**一个冒号后面那段当后缀，而且那段必须是一个合法档位 —— 所以
        // `-m cn:deepseek-v4.1-flash` 不会把 `flash` 当成后缀（它不在档位表里），
        // 只有 `-m cn:deepseek-v4.1-flash:high` 才会拆。与 pi 的 `parseModelPattern`
        // 同一个判据（它也是先看 `isValidThinkingLevel`）。
        const value = next();
        const colon = value.lastIndexOf(':');
        const suffix = colon < 0 ? '' : value.slice(colon + 1);
        if (colon > 0 && isThinkingLevel(suffix)) {
          args.model = value.slice(0, colon);
          args.modelThinking = suffix;
        } else {
          args.model = value;
        }
        break;
      }
      case '--thinking': {
        // 与 pi 同一条：**不认的值告警并忽略**，而不是报错退出（`dist/cli/args.js:125-135`）。
        // 忽略的后果只是「这一档没生效」，而报错退出会让整个界面起不来 —— 后者严重得多。
        const value = next();
        if (isThinkingLevel(value)) {
          args.thinking = value;
        } else {
          process.stderr.write(
            `Invalid thinking level "${value}". Valid values: ${THINKING_LEVELS.join(', ')}\n`,
          );
        }
        break;
      }
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
      case '--no-trace':
        args.noTrace = true;
        break;
      case '--web':
        args.web = true;
        break;
      case '--web-port':
        args.webPort = Number.parseInt(next(), 10);
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

  // **交互式模式** = 没有一次性要跑的东西（`-p`）也没关掉扩展。
  //
  // 它决定两件事，而且两件必须一致：
  //
  // 1. 内核 `deferExtensions`：扩展推到后台装（首帧不等它）；
  // 2. 界面拿到 `kernel.ready` 这道门：装载完成前不发消息、开场横幅要重报一次。
  //
  // 一旦只给其中一边，症状分别是「首帧没变快」与「发送了一条缺工具集的消息」。
  const oneShot = args.prompt !== undefined;
  const deferExtensions = !oneShot && !args.noExtensions;

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
      // 给了就最高优先（仍然会被 clamp 到模型支持的那几档）——
      // 不给时**不传这个键**，让内核按 pi 的顺序解析（`?? 'off'` 那种兜底已经移进内核）。
      // `-m id:high` 的后缀排在 `--thinking` 后面（pi：后缀先定、`--thinking` 后应用）。
      ...(args.thinking !== undefined
        ? { thinkingLevel: args.thinking }
        : args.modelThinking !== undefined
          ? { thinkingLevel: args.modelThinking }
          : {}),
      ...(args.skillPaths.length > 0 ? { skillPaths: args.skillPaths } : {}),
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
      // 交互式模式：扩展装载不等（首帧 ~3.6s → ~1.1s）。见上面那个 `deferExtensions`。
      ...(deferExtensions ? { deferExtensions: true } : {}),
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

  // 退出兜底：正常情况下 `main()` 末尾会 `await kernel.dispose()`（那时 MCP 的子进程
  // 已经收干净）。这一条是给「别处 `process.exit()`」或信号路径的 —— `exit` 事件里
  // 做不了异步收尾，但 stdio 传输自己的 `exit` 钩子会把还活着的服务器进程组杀掉。
  process.once('exit', () => void kernel.dispose());

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
  // 它同时认旧名（`<id>.jsonl`）。
  //
  // ## 找不到时为什么必须出声
  //
  // `findSessionFile` 只在**当前目录**对应的会话目录里找（`sessions/<cwd 编码>/`）。
  // 而 `ela --session <id>` 完全可能是**在别的目录**里跑的（那个会话其实是别的项目
  // 的）—— 此时静默降级的结果是：id 还是那个 id，但对话是空的，看上去就像「恢复了
  // 一个新会话」，而没有任何地方提到过原因（真发生过，排查了半天）。
  //
  // 所以这里把事实说清楚：文件不在这里 → 告诉用户它可能在哪个目录的会话里，
  // 以及本次会当成新会话（用同一个 id）接着写。
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
    } else {
      process.stderr.write(
        `没有在 ${args.cwd} 的会话目录里找到 ${args.sessionId} —— 当成新会话继续` +
          `（若那个会话是别的工作目录下的，进那个目录再 \`ela --session ${args.sessionId}\`，` +
          `或在本目录用 \`/resume\` 选它）\n`,
      );
    }
  }

  // ── web ui：与终端同一个环，只是第二个订阅者 ──
  //
  // 服务端起在**同一个进程**里（环只有一份，跑在内核里）。它只把 store 的状态与事件
  // 转发给浏览器，自己不碰模型、不跑工具。起不来（端口全占、权限）**不影响终端界面**，
  // 所以这里把错误降级成一行提示。
  let web: WebServerHandle | undefined;
  let bridge: WebBridge | undefined;
  let webNotice: string | undefined;
  // **默认不起**：那是一个监听端口的服务，不开就不该占端口。`--web` 打开，
  // `--web-port <n>` 隐含它（说要一个端口 = 要那个服务；否则那个值无处可用）。
  if (args.web || args.webPort !== undefined) {
    // 模型解析：`getModels()` 对未知 provider 会抛（best-effort），裹一层。
    // 桥与 HTTP 接口共用同一个 —— 否则两边对「这个模型存不存在」的判断会漂移。
    const resolveModel = (provider: string, id: string) => {
      try {
        return kernel.runtime.models.getModels(provider).find((model) => model.id === id) ?? null;
      } catch {
        return null;
      }
    };
    bridge = new WebBridge(
      {
        store: kernel.store,
        // 会话 id / cwd **不在这里递** —— 它们在 `state.session` 里（见那一块的注释）。
        setModel: (provider, id) => kernel.setModel(provider, id),
        newSession: () => kernel.newSession(),
        // 侧边栏点一条历史会话：内核换 id、换文件、对齐记录器游标（见 bridge 的注释）。
        // 路径在这里拼 —— 桥拿到的只有 id + cwd（浏览器不知道、也不需要知道磁盘布局）。
        resumeSession: async (id, cwd) => {
          const file = findSessionFile(id, cwd);
          if (!existsSync(file)) throw new Error(`找不到会话文件 ${id}`);
          return kernel.restoreSession(file);
        },
        resolveModel,
        // 这里**不再**有 `onPresenceChange`（原来拿它切扩展宿主模式到 `'rpc'`）。
        //
        // 早先那一步是为了让 `ask_user_question` 走 `ctx.ui.select/input` 的逐题回退，
        // 好让浏览器也答得上。现在问卷是本项目的**内置扩展**（带 patch，见 `patches/`）：
        // 终端那一份由扩展自己画、浏览器那一份走 `ctx.ui.externalQuestionnaire` 交给我们，
        // 两边同时开着、谁先答都算数 —— 不需要把宿主装成非终端宿主（那反而会把扩展
        // 自己那份 TUI 问卷整个关掉）。
        // 底栏那一行（与终端**逐字同形**）：`↑362k ↓310k R121M CH99.9% 52%/1.0M (auto)`。
        // 浏览器那边 pi-web-ui 自带的 `formatUsage` 只到 `R`/`W` —— 所以由服务端
        // 算好整行发过去，而不是让它再算一份（口径一漂，两端对不上）。
        // 自动压缩那个开关也在这里取（同一个 `kernel.autoCompactEnabled()`，与
        // `/settings` 面板、`/api/settings` 同源）—— 否则浏览器底栏少一段 `(auto)`。
        stats: (state) => statsLine(state, kernel.autoCompactEnabled()),
        // 底栏左端那一行（与终端底栏逐字同形）：家目录缩 `~` + git 分支。
        cwdLabel: (state) => cwdLine(state.session.cwd, gitBranch(state.session.cwd)),
        // 扩展装载完成的门：浏览器那侧发消息也要等它（与终端 `send()` 同一道门）——
        // 装载前 state 里的工具集与 system prompt 还是「没有扩展」的形状，先发出去的
        // 那条会定下一份**缺工具集**的 head（不可改的历史，见 `prompt-head.ts`）。
        // 一次性模式不给（它本来就不推迟装载）。
        ...(deferExtensions ? { ready: kernel.ready } : {}),
      },
      // 开场诊断与终端那边同一个口径：装了哪些扩展 + 装载失败。
      //
      // **取值函数**：内核 `deferExtensions` 时这两样是后台装载完才有的（见那里的
      // `ready`）—— 传数组快照就等于永远报不出装载诊断。
      () => [
        // 只报装载**诊断**：开场那条「已装扩展：…」不进浏览器 —— 侧边栏已经能看出
        // 有哪些会话在用哪些 cwd，而扩展清单是终端那边的开场信息（`[Extensions]`），
        // 它在 web 里一条盖一条只占地方。
        ...kernel.extensions.errors.map((error) => `扩展装载诊断：${error}`),
      ],
    );
    // 非会话数据 / 动作的 HTTP 接口（`/api/*`）—— 命令表、模型目录、settings 都在
    // 服务端，浏览器不抄一份。命令表 = 内置的（带 `web` 标记）+ 扩展注册的。
    const api = createWebApi({
      store: kernel.store,
      // 同上：会话身份从 store 读，不从参数递。
      // **与 TUI 的 `/model` 面板同一份**（同一个 `ModelRuntime`），否则会列出
      // pi-web-ui 自带那份 1500+ 的内置目录（本机根本没配）。
      modelCatalog: () => [...modelRuntimeFor(kernel.runtime).getAvailableSnapshot()],
      resolveModel,
      setModel: (provider, id) => kernel.setModel(provider, id),
      autoCompactEnabled: () => kernel.autoCompactEnabled(),
      setAutoCompactEnabled: (enabled) => kernel.setAutoCompactEnabled(enabled),
      // **取值函数**：扩展是后台装的（见内核的 `deferExtensions`），装载完成后
      // 它们的命令才存在 —— 快照一次就等于浏览器那边永远看不到扩展命令。
      commands: () => [
        ...SLASH_COMMANDS.map((command) => ({
          name: command.name,
          description: command.description,
          ...(command.web === true ? { web: true } : {}),
        })),
        ...kernel.extensions.commands.list().map((command) => ({
          name: command.name,
          description: command.description ?? '',
          source: 'extension' as const,
        })),
      ],
      // 扩展命令的入口：内置的（`/model` 那些）在浏览器侧有各自界面，不走这里。
      runExtensionCommand: (name, arg) => {
        if (!kernel.extensions.commands.has(name)) {
          return Promise.reject(new Error(`未知命令 /${name}（浏览器里只支持非会话类命令）`));
        }
        return kernel.extensions.commands.run(name, arg);
      },
      // 设置 › 插件 / 子代理：同样是**取值函数**，扩展后台装完之后再读才有内容。
      extensions: () => kernel.extensions.entries,
      extensionErrors: () => kernel.extensions.errors,
    });
    try {
      web = await startWebServer({
        bridge,
        api,
        ...(args.webPort !== undefined ? { port: args.webPort } : {}),
      });
      webNotice = `web ui: ${web.url}`;
    } catch (error) {
      process.stderr.write(
        `web ui 起不来（终端界面不受影响）：${String(error instanceof Error ? error.message : error)}\n`,
      );
    }
  }

  // ── herdr：**自己上报**这个 pane 里是 pi ──
  //
  // 为什么不是像 mac 上那样给进程塞 `HERDR_AGENT`：那条 hint 只在 Linux/macOS 生效
  // （见 `packages/core/src/herdr.ts` 的文件头，里面有文档与 `herdr.exe` 的证据）。
  //
  // 只在**交互式**那条路上开：一次性模式（`-p`）没有 PTY 给 herdr 显示 —— 与 herdr
  // 官方 pi 集成自己那道 `ctx.mode === 'tui'` 的门同一个理由。不在 herdr 里时它是个
  // 空壳（`startHerdrReporting` 直接返回空函数），零开销、零副作用。
  const stopHerdr =
    args.prompt === undefined
      ? startHerdrReporting({
          store: kernel.store,
          // 会话引用**每次现取**：`/new` 会同时换 id 与文件，而 herdr 要的是「现在」那一个。
          // resume 命令用本项目自己的 CLI —— herdr 服务器重启后拉回来的是 ela，而不是
          // 一个没有 ela 状态的 pi 进程（herdr 会优先用它，见其文档的 `resume_argv`）。
          session: () => {
            const id = kernel.store.getState().session.id;
            const file = kernel.session?.file;
            return {
              ...(file !== undefined ? { path: file } : {}),
              id,
              resumeArgv: ['ela', '--session', id],
            };
          },
          // 第一次失败说一声就够（herdr 在、但连不上或它拒了 —— 那是要有人知道的）。
          // 界面起来的时机在它之后（`publishUi`），所以两种路子都留着。
          onError: (reason) => {
            const text = `herdr 上报失败（这个 pane 在 herdr 里会认不出是 pi）：${reason}`;
            const ui = uiRef.current;
            if (ui !== undefined) ui.onNotice(text);
            else process.stderr.write(`${text}\n`);
          },
        })
      : () => {};

  const prompt = args.prompt;
  const exitCode = await runTui({
    store: kernel.store,
    // 扩展装载的门 + **首帧不等扩展**：交互式模式把装载推到后台（首帧 3.6s → ~1.1s），
    // 发消息、开场横幅重报都挂在 `ready` 上（见 `TuiOptions.ready`）。
    //
    // 一次性模式（`-p`）**不给**：它没有首帧可提前，而装载那一刻本身就已经是结果了
    // （那时 `kernel.ready` 早就完成，给一份「已完成」的门只会让横幅白闪一帧）。
    ...(deferExtensions ? { ready: kernel.ready } : {}),
    // 工作目录不在这里传：它从 `store.getState().session.cwd` 读（与浏览器同一个地方）。
    // 把内核的「开新会话」交进去 —— TUI 只拿 store，换 id（于是换文件）要内核出手。
    newSession: () => kernel.newSession(),
    // 恢复历史：也必须走内核（换 id + 记录器游标对齐），界面自己做会把历史重写一遍。
    restoreSession: (file: string) => kernel.restoreSession(file),
    // 浏览器侧的对话框（`ctx.ui.select/confirm/input` 的那一份）。**取值**：桥可能
    // 因为没给 `--web` 时它不存在，也可能在重连时换掉。
    dialogs: () => bridge?.dialogs,
    // 换模型：一条 `model.changed`（带全能力 / 窗口），且**先查模型存在**。
    // 第三个参数是作用域条目写死的档位（`/scoped-models` 的 `p/i:high`）——
    // pi 的 `_cycleScopedModel` 也把它传下去（`setModel` 的第二个参数）。
    setModel: (provider: string, modelId: string, modelOptions?: { thinkingLevel?: string | undefined }) =>
      kernel.setModel(provider, modelId, modelOptions),
    // 自动压缩的开关（`/settings` 面板里那一行）：内核负责写盘 + 当场生效，
    // 因为那个订阅器是内核装的（`store.ts` 的 `AutoCompact`）。
    autoCompactEnabled: () => kernel.autoCompactEnabled(),
    setAutoCompactEnabled: (enabled: boolean) => kernel.setAutoCompactEnabled(enabled),
    // 面板要列模型，就要有 provider 装配。**给真的 runtime**（内核持有的那个 `AgentRuntime`）——
    // 它与 `createRuntime` 装的是同一个对象，面板看到的模型目录与实际发请求的目录同源。
    runtime: kernel.runtime,
    // 当前会话 id 也要给：`/clean` 删历史时得放行它（记录器正开着那个文件）。
    // **从 store 读**（`state.session.id`）—— 与浏览器那边同一个地方；
    // 开新会话 / 恢复历史后它会变，所以是取值不是常量。
    sessionId: () => kernel.store.getState().session.id,
    // 扩展的 `before_agent_start`（内核持有的那个宿主）。
    beforeAgentStart: (text) => kernel.extensions.beforeAgentStart(text),
    // 扩展的斜杠命令与快捷键（补全、`runCommand` 兜底、raw input）。
    extensionCommands: () => kernel.extensions.commands,
    // 把活着的界面交给内核的扩展宿主（它在装扩展时只能拿到一个待填的引用）。
    publishUi: (options) => {
      uiRef.current = options;
      // 界面起来之前扩展设过的状态段补喂一遍（那时只有一个「没有底栏」的占位宿主，
      // 它把值存在 `pendingStatuses` 里了）。顺序保持插入序，界面那边自己按 key 排。
      for (const [key, text] of pendingStatuses) options.setStatus?.(key, text);
      pendingStatuses.clear();
      // 界面起来了才报 web ui 的地址（备用屏之前写 stdout 会被它盖掉，见文件末尾的注释）。
      if (webNotice !== undefined) options.onNotice(webNotice);
    },
    // 开场报一行装了哪些扩展 + 装载诊断（与 skill 清单同一个口径）。
    //
    // `entries`（入口 + 来源）才是那一节要报的：`tools` 是工具名，报出去会让人
    // 拿着工具名去 settings 的 `packages` 里找那个扩展（见 resource-labels.ts）。
    extensions: () => ({
      entries: kernel.extensions.entries,
      tools: kernel.extensions.tools.map((tool) => tool.name),
      errors: kernel.extensions.errors,
    }),
    ...(prompt !== undefined ? { prompt } : {}),
  }).finally(async () => {
    // herdr 那边放开这个 pane（异步，不等它 —— herdr 自己也会按「上报进程没了」清掉）。
    stopHerdr();
    // 关掉监听端口，否则事件循环上一直有活，进程退不掉（与 `kernel.dispose()` 同一个道理）。
    await web?.close();
    bridge?.dispose();
    // 关扩展宿主（含 MCP 的 stdio 子进程）—— **必须 await**：子进程握着事件循环，
    // 不等它们收掉，进程退不出去。见下面 `process.exit` 那段。
    await kernel.dispose();
  });

  // ── 显式退出（一次性模式）──
  //
  // 光靠事件循环自己排空**不够**：MCP 的 stdio 服务器是子进程，而「连到一半就被丢下」
  // 的那个（`npx -y rea-agents` 还在解析 / 下载时一次性模式已经跑完了）不会被优雅的
  // `session_shutdown` 收掉 —— 那一刻它的 client 还没挂到 connection 上，`close()`
  // 是空转，子进程的 stdio 就一直握着事件循环（实测卡到 600s 超时）。
  //
  // 官方 stdio 传输自己装了 `process.on('exit')` 钩子：进程退出时把还活着的服务器
  // **进程组**一并杀掉。所以这里等 stdout 排空后显式退出，让那个钩子收尾 ——
  // 这正是「在退出路径上显式收子进程」。
  //
  // 交互模式走不到这里（`runTui` 在 `await new Promise(() => {})` 上挂着，退出走
  // `app.ts` 的 `process.exit(0)`，同样会触发那个钩子）。
  await flushStdout();
  process.exit(exitCode);
}

/**
 * 等 `process.stdout` 把缓冲写出去。
 *
 * 一次性模式的输出是管道 / 重定向的接收方，而 macOS 上管道写是异步的 ——
 * 紧接着 `process.exit()` 会把还没落地的字节丢掉（与测试里 `firstFrame` 的注释同一个坑）。
 * 平时 `writableLength` 就是 0（直写终端 / 小输出），只有大输出或慢消费者才需要等。
 * 给一个上限，免得 stdout 卡住时反过来把退出挂死。
 */
function flushStdout(timeoutMs = 1000): Promise<void> {
  if (process.stdout.writableLength === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(done, timeoutMs);
    process.stdout.once('drain', done);
  });
}

/**
 * 界面起来**之前**扩展设过的底栏状态段（`ctx.ui.setStatus`）。
 *
 * 界面一 publish 就补喂一遍。为什么不能直接丢：`pi-background-tasks` 在装载期就会
 * 设一条（版本提示 / 「1 running」），之后**只有任务真的变化时**才重设 —— 丢掉的话
 * 那条就永远不出现（而它正是「现在有几个后台任务在跑」的唯一线索）。
 */
const pendingStatuses = new Map<string, string>();

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
    // 底栏还没有（界面未起）：先**存着**，`publishUi` 那一刻补喂给真界面。
    // 这个函数本身不能缺：`pi-background-tasks` 在装载期就会调它，缺失的话它拿到
    // `undefined` 而不是函数，又回到「`ctx.ui.setStatus is not a function`」那个报错。
    setStatus: (key: string, text: string | undefined) => {
      if (text === undefined) pendingStatuses.delete(key);
      else pendingStatuses.set(key, text);
    },
    // 界面未起时没有工具输出展开状态：按 pi 的默认给 `false`，设了就丢掉（不抛）。
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
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
