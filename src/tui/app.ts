/**
 * 终端界面 —— pi-tui（差分渲染的 TUI 库）驱动，环仍然只由本项目的 Redux Loop 跑。
 *
 * 这个文件不含任何环的逻辑：它只是订阅 store，把状态画出来。
 * 界面分两块：
 *
 *   - 对话区：用户说了什么、LLM 答了什么、工具做了什么（按消息流渲染）
 *   - 轨迹面板（Ctrl+T 切换）：**像 git log --graph 一样的一次尝试一节点的树**
 *     失败/超时也在上面，是一层能展开的节点，不是飘在下面的一行红字。
 *
 * pi-tui 的好处是差分渲染：流式 token 一个个进来时只重画变化的那几行，
 * 不会整屏闪烁 —— 这对一个一直在吐 delta 的 agent 界面很关键。
 */
// pi-tui 1.x：`TUI` 是共享**接口**，实例化要选具体渲染器。
// TuiAltScreen  = 真正的全屏：占满视口，终端不留回滚缓冲，界面自己管滚动。
// TuiMainScreen = 让出回滚缓冲（内容永久留在终端历史里，能往上翻）。
// 对话式 agent 用前者：输入框要钉在底部、对话区独立滚动，滚出去的内容不该污染终端回滚。
import {
  CancellableLoader,
  Editor,
  ProcessTerminal,
  Text,
  ScrollView,
  TuiAltScreen,
  VStack,
  matchesKey,
  CombinedAutocompleteProvider,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type SlashCommand,
  type ViewportTUI,
  type EditorTheme,
  type TuiInputListener,
} from '@earendil-works/pi-tui';
import { abortRun } from '../run-control';
import { renderTree, traceStats, type TraceNode, type TraceTree } from '../trace';
import type { AgentState } from '../state';
import type { AgentStore } from '../store';
import type { AgentAction } from '../actions';
import { cleanSessionsExcept, listSessions, type SessionSummary } from '../config-home';
import { loadSessionMessages, openSessionPicker } from './session-picker';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
// ─── pi 官方的对话/工具渲染器 ───
//
// 用户蓝底、思考灰斜体、工具块的绿/红底色、write 的内容预览、edit 的彩色 diff、
// bash 的 `Took 0.5s` 与「保留尾部 5 行」的折叠 —— 这些**全部**来自 pi 自己的组件。
// 自己照着截图重画过一次，结果每个工具的折叠策略、底色边界都对不齐；
// 直接用官方组件后，形状与 pi 逐行一致（截图里深绿 rgb(37,65,49) 就是
// `theme.colors.toolSuccessBg` 的值）。
//
// 依赖内部子路径（`dist/...`）需要 pnpm patch，见 docs/architecture/provider.md。
// theme 必须先 setupTheme()，否则这里读 theme.colors 会抛（见 src/tui/theme.ts）。
import { AssistantMessageComponent } from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/assistant-message.js';
import { UserMessageComponent } from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/user-message.js';
import { ToolExecutionComponent } from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js';
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { getMarkdownTheme } from '@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';// pi 底栏的官方实现（靠 pnpm patch 打开的子路径）。数字格式与算法都与 pi 一致 ——
// 两边对不上会让人以为算错了。
// 见 docs/architecture/provider.md「为什么要 pnpm patch」。
import { formatCwdForFooter, formatTokens } from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js';
import { addUsageToTotals, createUsageTotals } from '@earendil-works/pi-coding-agent/dist/core/usage-totals.js';
import { setupTheme } from './theme';

const useColor = !process.env.NO_COLOR;
const paint = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
export const dim = (t: string) => paint('2', t);

/**
 * 底箱那种「整块变淡，但里面某几段要保留告警色」的场景。
 *
 * ## 为什么要单独一个函数
 *
 * `paint()` 用 `\x1b[0m` 收尾（重置所有属性）。直接 `dim(red(x))` 的话，内层的
 * `\x1b[0m` 会把外层的 dim 提前关掉 —— 结果是「x 之后的所有内容都不淡了」。
 *
 * 这里改成：整行包一次 dim，里面的告警色段用 **dim + 颜色**（而不是纯颜色），
 * 而告警段结束后**重新开一次 dim**。也就是把 dim 当成「默认态」，告警色当成
 * 「临时换掉又换回来」，而不是嵌套。
 *
 * @param text      整行内容
 * @param segments  哪些子串要上告警色（其余保持 dim）
 */
export function dimLine(text: string, ...segments: { find: string; paint: (s: string) => string }[]): string {
  let out = text;
  // 从后往前替换，这样前面的位置不会因长度变化而失效。
  for (const { find, paint: colorFn } of [...segments].reverse()) {
    if (find === '') continue;
    const at = out.indexOf(find);
    if (at < 0) continue;
    const repaint = colorFn(dim(find)); // dim 重新包上（因为 colorFn 内部的 0m 会关掉它）
    out = out.slice(0, at) + repaint + dim(out.slice(at + find.length));
  }
  return dim(out);
}
const red = (t: string) => paint('31', t);
const green = (t: string) => paint('32', t);
const yellow = (t: string) => paint('33', t);
const blue = (t: string) => paint('34', t);
const magenta = (t: string) => paint('35', t);
const cyan = (t: string) => paint('36', t);
const bold = (t: string) => paint('1', t);

// 工具块的底色、边框色、路径色、diff 绿/红……全部由 pi 的 theme 给（见 src/tui/theme.ts），
// 不在这里手写 `rgbColor(0x12, 0x26, 0x1a)` 了。
//
// 为什么删：早先按截图取了一个深绿当底色，看着差不多，但有三个问题：亮色终端上这块深绿
// 变成一坨脏东西；用户蓝底只能用 ANSI 34（不透明、不会铺满整行）；思考的斜体根本没有对应色。
// 统一交给 theme 之后，四个 token 都是**跟着终端深浅色走**的，而且降级（真彩 → 256 → 16）
// 由 pi-tui 处理 —— 手写 `\x1b[48;5;22m` 在不支持的终端上会出难看的色块。

/** 节点配色：一眼能看出这条线上哪段失败了。 */
function nodeColor(node: TraceNode): (t: string) => string {
  switch (node.kind) {
    case 'user':
      return cyan;
    case 'llm.attempt':
      return node.status === 'error' ? red : blue;
    case 'llm.result':
      return green;
    case 'tool.attempt':
      return node.status === 'error' ? red : yellow;
    case 'tool.result':
      return green;
    case 'error':
      return red;
    case 'stop':
      return magenta;
    // 上下文族（prompt.*）统一用暗色：它们是「背景」不是「事件」，不该抢对话的注意力。
    case 'prompt.base':
      return magenta;
    case 'prompt.tools':
      return dim;
    case 'prompt.segment':
      return blue;
    case 'model.init':
      return dim;
  }
}

/**
 * 把轨迹树画成带颜色的 ASCII 树。
 *
 * 直接复用 trace.ts 的 renderTree（纯函数，测试里也在用），再按节点 id 上色 ——
 * 这样「命令行里看到的树」和「界面里看到的树」是同一份逻辑，不会各画各的。
 */
export function renderColoredTree(tree: TraceTree, maxWidth: number): string {
  const plain = renderTree(tree, { maxWidth: 0 });
  const colorOf = new Map<string, (t: string) => string>();
  for (const id of tree.order) {
    const node = tree.nodes[id];
    if (node) colorOf.set(id, nodeColor(node));
  }
  // 逐行找出行首的节点 id（renderTree 的输出格式是固定的：`…<id> <kind>: <label>`）。
  return plain
    .split('\n')
    .map((line) => {
      // 节点 kind 的全集。**漏一个就等于那个 kind 整族不上色**（静默退化，最难发现的一种 bug）。
      const match =
        /^(.*?)(n\d+) (llm\.attempt|llm\.result|tool\.attempt|tool\.result|user|error|stop|prompt\.base|prompt\.tools|prompt\.segment|model\.init):/.exec(
          line,
        );
      if (!match) return line.startsWith('HEAD') ? bold(line) : line;
      const [, prefix, id] = match;
      const color = colorOf.get(id ?? '') ?? dim;
      const rest = line.slice((prefix ?? '').length);
      // 失败的节点加粗，视觉上更跳一点。
      const node = tree.nodes[id ?? ''];
      return `${prefix ?? ''}${node?.status === 'error' ? bold(color(rest)) : color(rest)}`;
    })
    .join('\n');
}

/**
 * 顶栏一行：轨迹统计（**刻意精简**）。
 *
 * ## 为什么这么少
 *
 * pi 的顶栏只有 logo + 版本 + 快捷键提示，模型/上下文用量都在**底栏**。我们反过来：
 * 原来顶栏塞了「provider/model · N 轮 · $花费 · 轨迹 节点 N」，一条顶栏混了四类信息，
 * 读起来像日志。现在顶栏只留轨迹统计（它与对话内容直接相关：节点数/重试/错误），
 * 模型与用量挪到底栏 —— 与 pi 一致。
 */
export function statusLine(state: AgentState): string {
  const stats = traceStats(state.trace);
  const traceBits = [`节点 ${state.trace.order.length}`];
  if (stats.turns > 0) traceBits.push(`${stats.turns} 轮`);
  if (stats.retries > 0) traceBits.push(`重试 ${stats.retries}`);
  if (stats.errors > 0) traceBits.push(red(`错误 ${stats.errors}`));
  const cost = state.totalCost > 0 ? ` · $${state.totalCost.toFixed(4)}` : '';
  return `${dim('轨迹')} ${traceBits.join(dim(' · '))}${cost}`;
}

/**
 * 底栏左上行：工作目录（家目录缩成 `~`）+ git 分支。
 *
 * 路径处理直接用 pi 的 `formatCwdForFooter()`：它把家目录换成 `~`（`~\Documents\…`），
 * home 之外的目录保持绝对路径。这正是截图里的形状。
 */
export function cwdLine(cwd: string, branch: string | undefined): string {
  const shown = formatCwdForFooter(cwd, homedir());
  return branch ? `${shown} (${branch})` : shown;
}

/**
 * 底栏右栏：`(provider) model` —— 与 pi 完全同形。
 *
 * 左边是「你以为自己用的是谁」，右边是「实际用的哪个模型」。分开是因为换 provider
 * （走网关）时最容易出的错就是以为还在用原厂模型。
 */
export function modelLine(state: AgentState): string {
  return `(${state.providerName}) ${state.modelId}`;
}

/**
 * 底栏左下行：token 用量 + 上下文占用。
 *
 * 形状照抄 pi：`↑6.8k ↓49 R143 CH2.1% 0.7%/1.0M`
 *
 * ## 数字格式与算法都用 pi 的
 *
 * `formatTokens` / `addUsageToTotals` / `formatCwdForFooter` 都是从
 * `pi-coding-agent/dist/...` 直接 import 的。两边显示的数字对不上会让人以为算错了，
 * 宁可完全一致也不要各写一套。
 *
 * ## 累计 vs 最近一轮
 *
 * `state.usage` 只是**最近一次** LLM 调用的用量，而底箱要的是**本次会话累计**。
 * 所以从 `state.messages` 里把所有 assistant 消息的 usage 累加。这是每帧 O(消息数) ——
 * 消息多了会略慢，但换来与 pi 一致的口径。
 */
/** 底箱第二行算出来的结果。 */
export interface StatsLine {
  /** 整行文本，**不带任何 ANSI**（颜色由调用方用 `dimLine()` 统一处理）。 */
  text: string;
  /** 要在 dim 底箱里保持告警色的子段。 */
  warnings: { find: string; paint: (s: string) => string }[];
}

export function statsLine(state: AgentState): StatsLine {
  const totals = createUsageTotals();
  let latestCacheHitRate: number | undefined;
  for (const message of state.messages) {
    if (message.role !== 'assistant' || !message.usage) continue;
    addUsageToTotals(totals, message.usage);
    // CH = 本次 prompt 里有多少 token 来自缓存（pi 的算法，见它的 footer.js）：
    // cacheRead / (input + cacheRead + cacheWrite)，取**最近一次**。
    const promptTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
    latestCacheHitRate =
      promptTokens > 0 ? (message.usage.cacheRead / promptTokens) * 100 : undefined;
  }

  const parts: string[] = [];
  const warnings: StatsLine['warnings'] = [];
  if (totals.input > 0) parts.push(`↑${formatTokens(totals.input)}`);
  if (totals.output > 0) parts.push(`↓${formatTokens(totals.output)}`);
  if (totals.cacheRead > 0) parts.push(`R${formatTokens(totals.cacheRead)}`);
  if (totals.cacheWrite > 0) parts.push(`W${formatTokens(totals.cacheWrite)}`);
  if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
    parts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
  }
  if (totals.cost > 0) parts.push(`$${totals.cost.toFixed(3)}`);

  // 上下文占用：已用 / 窗口。超过 70% 转黄、90% 转红 —— 快满时模型会开始丢东西，
  // 要提前看见而不是等它开始表现变差。
  //
  // 这里**不自己上色**，而是把告警信息一起返回（`warning`）：整行底箱会被包进 dim，
  // 而 dim 里再嵌一个 `\x1b[0m` 结尾的颜色段会把 dim 提前关掉（见 dimLine 的注释）。
  const contextWindow = state.model.contextWindow;
  if (contextWindow > 0) {
    const used = totals.input + totals.cacheRead + totals.cacheWrite;
    const percentValue = (used / contextWindow) * 100;
    const percent = percentValue < 1 ? percentValue.toFixed(1) : Math.round(percentValue);
    const display = `${percent}%/${formatTokens(contextWindow)}`;
    parts.push(display);
    if (percentValue > 70) {
      warnings.push({ find: display, paint: percentValue > 90 ? red : yellow });
    }
  }
  return { text: parts.join(' '), warnings };
}

/** 去掉 ANSI 序列，拿到可见宽度。 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

/**
 * 底栏那行：左边路径 / 右边 `(provider) model`，中间空格补齐。
 *
 * ## 为什么用 visibleWidth 而不是 stripAnsi().length
 *
 * ANSI 序列是零宽的，但**中文是双宽**。`stripAnsi().length` 会把「一个汉字」当成一个字符，
 * 于是含中文的右半边会往左飘、盖到左边。`visibleWidth`（pi-tui 自己的实现）按终端
 * 的实际列宽算，这是底栏能贴右边的前提。
 */
export function twoColumn(left: string, right: string, width: number): string {
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  if (leftWidth + rightWidth + 1 > width) {
    // 放不下就右边优先（模型名是定位信息，路径可以靠 /pwd 看）。
    return truncateToWidth(`${left} ${right}`, width);
  }
  return `${left}${' '.repeat(width - leftWidth - rightWidth)}${right}`;
}

/**
 * 顶栏补到终端全宽。
 *
 * pi-tui 是**增量**重绘：只重画变化的行。顶栏本来是变长的（`0 轮` → `1 轮`、节点数增加），
 * 变长时旧内容的尾巴不会被擦掉，于是下一帧会叠着出现 —— 看起来像「重复刷屏」。
 * 补齐宽度让这一行长度恒定，增量重绘就不留残影。
 */
function padToWidth(text: string, width: number): string {
  const visible = stripAnsi(text).length;
  return visible >= width ? text : text + ' '.repeat(width - visible);
}

/**
 * 斜杠命令表——**唯一的真相**。
 *
 * 补全（`setAutocompleteProvider`）和 `/help` 都念这一份，所以加命令只改这里一处；
 * 以前 `/help` 里手抄了一份，两边会漂移。
 */
const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'sessions',
    description: '恢复历史会话（弹窗选择，零 token 不重跑模型）',
  },
  {
    name: 'resume',
    description: '同 /sessions（方便记）',
  },
  {
    name: 'new',
    description: '开新会话（换文件；上一段仍留在 sessions/ 里）',
  },
  {
    name: 'clean',
    description: '**删除**除当前会话外的全部历史会话（不可逆）',
  },
  { name: 'wipe', description: '同 /clean' },
  { name: 'help', description: '列出全部命令' },
];

/**
 * 编辑器的配色。`selectList` 是 **`SelectListTheme`** —— 补全弹窗复用的就是它
 * （不是另一套 `selected` / `unselected` 形状）。
 *
 * 这里**不能**写 `as unknown as EditorTheme`：那个 cast 会把形状不匹配压成运行时崩溃
 * （`this.theme.selectedText is not a function`），而补全列表渲染失败在界面上只表现为
 * 「打 `/` 什么都没弹」—— tsconfig 早就想告诉我们，是 cast 捂住了它的嘴。
 */
const EDITOR_THEME: EditorTheme = {
  borderColor: (s: string) => dim(s),
  selectList: {
    selectedPrefix: (s: string) => cyan(s),
    selectedText: (s: string) => bold(s),
    description: (s: string) => dim(s),
    scrollInfo: (s: string) => dim(s),
    noMatch: (s: string) => dim(s),
  },
};

export interface TuiOptions {
  store: AgentStore;
  /** 一次性提问：给完就退出（脚本/管道友好）。 */
  prompt?: string | undefined;
  /**
   * 开新会话（换 id → 换文件）。由内核提供 —— TUI 拿不到内核，只能收回调。
   *
   * 不传就退化成「只清对话、沿用原 id」，那样之后的消者会追加进同一个文件。
   */
  newSession?: (() => { id: string }) | undefined;
  /**
   * 恢复一个历史会话（换 id → 之后的消息追加进**那个**文件 + 记录器游标接着算）。
   *
   * ## 为什么必须由内核出手
   *
   * 界面自己 dispatch 是**做不到**的：`session.restored` 只是往 `messages` 里追加，而会话
   * 记录器是 store 的订阅器，它看到「多了一条新消息」就写盘 —— 于是整段历史被当成新产生的
   * 消息，全量抄进**当前**会话的文件（真发生过：390 行会话原样复制成另一个 390 行的文件）。
   * 要挡住它必须做两件只有内核知道的事：把 `sessionId` 换掉、并用 `resumeFrom` 告诉记录器
   * 「前面那 N 条已经在文件里了」。内核的 `restoreSession(file)` 已经把两件事一起做了。
   *
   * 不传就退化成界面版的灌消息（状态对，但会复制一份，且之后的消息写错文件）。
   */
  restoreSession?: ((file: string) => { id: string; restored: number }) | undefined;
  /**
   * 当前会话 id。`/clean` 要**放行**它 —— 记录器正开着那个文件，删了等于写到虚空里。
   */
  sessionId?: (() => string) | undefined;
  /**
   * 工作目录（底栏显示用）。传了就显示，不传就 `process.cwd()`。
   */
  cwd?: string | undefined;
}

/**
 * 当前 git 分支，读不到就返回 undefined（不在仓库里 / 没装 git 都会这样）。
 *
 * 为什么每次 refresh 都重读而不在启动时算一次：分支会变（用户切了分支、或我们自己在
 * 会话里执行了 git 命令）。每帧读一次 `.git/HEAD` 便宜到可以忽略，而缓存了就意味着
 * “底栏在说谎”。
 */
function gitBranch(cwd: string): string | undefined {
  try {
    const head = readFileSync(path.join(cwd, '.git', 'HEAD'), 'utf8').trim();
    // 两种形状：`ref: refs/heads/main`（分支）或一串 sha（detached HEAD）。
    const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (match) return match[1];
    return head ? 'detached' : undefined;
  } catch {
    return undefined;
  }
}

export async function runTui(options: TuiOptions): Promise<number> {
  const { store, prompt, newSession, sessionId, restoreSession: restoreHook } = options;
  const cwd = options.cwd ?? process.cwd();
  // 主题**必须先于一切渲染**装上：pi 的 `theme` 是个 globalThis 上的 Proxy，
  // 没 initTheme() 时读它任何属性都抛 `Theme not initialized`。
  // 而对话区那三个官方组件（User/Assistant/ToolExecution）每一个都在 render 里读 theme。
  //
  // 为什么不能在模块顶层调：那时终端还没起来，`getTerminalTheme()` 拿不到深浅色，
  // 只能猜一个 —— 猜错就是浅色终端上出现黑底块。
  setupTheme();
  const terminal = new ProcessTerminal();
  // AltScreen 是 viewport 实现，setLayoutRoot 在 ViewportTUI 上（TUI 接口没有）。
  const tui: ViewportTUI = new TuiAltScreen(terminal, true, undefined, {
    mouse: true,
    copyOnSelect: true,
  });

  const header = new Text('', 0, 0);
  /**
   * 底栏：左边 cwd (+git 分支)，右边 `(provider) model`。
   *
   * 为什么要它：模型与用量是「我在跟谁说话」，与对话内容无关，放顶栏会干扰读对话；
   * 而它们又不能删 —— 换 provider 时最容易出的错就是以为还在用原厂模型。
   * 形状照抄 pi（`~\path (main)` …… `(workbuddy) cn:space-bunny`）。
   */
  /**
   * 底栏：**两行**（与 pi 同形）。
   *
   *     ~\Documents\workspace\event-loop-agent (main)
   *     ↑6.8k ↓49 R143 CH2.1% 0.7%/1.0M        (workbuddy) cn:space-bunny
   *
   * 为什么要它：模型与用量是「我在跟谁说话、说了多少」，与对话内容无关；堆在顶箱
   * 会干扰读对话。而它们又不能删 —— 换 provider 时最容易出的错就是以为还在用原厂模型。
   *
   * 一个 Text 组件装两行（内部用 `\n` 分行），而不是两个组件：布局里只占一个 slot，
   * 也不用管两行之间的高度分配。
   */
  const footer = new Text('', 0, 0);
  /**
   * 对话区：**按消息分块**的增量渲染（每条消息一个组件，内容没变就不重算）。
   *
   * 以前这里是 `new Text(renderTranscript(...))` 那个整段重算的形状，每帧 ~1.2 秒，
   * 而流式 token 每个都触发一次刷新 —— 详见 TranscriptChunks 的注释。
   */
  const transcript = new TranscriptChunks();
  const tracePanel = new Text('', 0, 0);
  const loader = new CancellableLoader(tui, (s) => cyan(s), (s) => dim(s), '');
  /**
   * 空闲时**不显示**转圈。
   *
   * ## 坑：setIndicator() 自己会 start()
   *
   * pi-tui 的 `Loader.setIndicator()` 实现里最后一行是 `this.start()`（见它的
   * `loader.js`），也就是**只要调一次 setIndicator，动画就开始转了**，与有没有消息无关。
   * 之前那行 `loader.setIndicator({frames: [...]})` 于是让空闲界面一直有个圈在转 ——
   * 看着像「正在处理」，其实什么都没在跑。
   *
   * `frames: []` 是官方给的「隐藏」方式（`LoaderIndicatorOptions.frames` 的注释：
   * "Use an empty array to hide the indicator"）。空闲用空数组，生成中才给真 frames。
   */
  const IDLE_FRAMES: string[] = [];
  const BUSY_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  loader.setIndicator({ frames: IDLE_FRAMES });

  const editor = new Editor(tui, EDITOR_THEME);
  // 补全：`/` 触发命令列表（带说明），路径位置触发文件补全。
  //
  // 没有它就只能盲打 —— 用户得先记住有哪些命令。装上之后打 `/` 会直接列出，
  // Tab/回车选定；打路径时也会补全（`read` 这种工具名反而不用记）。
  //
  // **`triggerCharacters` 必须自己给**：`setAutocompleteProvider` 会把它设成
  // `provider.triggerCharacters ?? []`，而 `CombinedAutocompleteProvider` 没声明这个字段
  // （它的默认触发字符是 `@` `#`，`/` 不在里面）。不给的话打 `/` 什么都不会弹，
  // 看起来就像补全根本没装上 —— 这个坑很隐蔽。
  // 类上没声明 `triggerCharacters`（接口上才有），所以用一层薄包装把它补上 ——
  // 其余方法原样转发。
  const base = new CombinedAutocompleteProvider(SLASH_COMMANDS, process.cwd());
  editor.setAutocompleteProvider({
    triggerCharacters: ['/', '@'],
    getSuggestions: (...args) => base.getSuggestions(...args),
    applyCompletion: (...args) => base.applyCompletion(...args),
    shouldTriggerFileCompletion: (...args) => base.shouldTriggerFileCompletion?.(...args) ?? false,
  });

  let showTrace = false;
  /**
   * 工具输出是否全部展开（Ctrl+O 切换）。
   *
   * 为什么需要它：工具输出动辄几百行（读个文件、跑个 grep），全部铺开会把对话区冲走。
   * 折叠时留 `... (N earlier lines, ctrl+o to expand)` —— 与 pi 同形。**不展开就没法
   * 看到完整结果**，而截断到看不见东西等于工具白跑。
   */
  let expanded = false;
  let loading = false;
  let lastLoaderMessage = '';
  /** 命令反馈：插在对话区顶部，6 秒后自动消失（不占输入区）。 */
  const notice = { text: '' };
  let noticeUntil = 0;

  const refresh = (): void => {
    const state = store.getState();
    // 补到全宽：顶栏长度变化会让 pi-tui 的增量重绘留下残影（见 padToWidth 的注释）。
    header.setText(padToWidth(statusLine(state), terminal.columns ?? 100));
    // 底栏同理：模型名 / 节点数会变，必须补齐到全宽，否则残影会叠出来。
    // 底箱两行（形状拄 pi 截图）：
    //   第一行：`~\Documents\workspace\event-loop-agent (main)`            —— 左边
    //   第二行：`↑6.8k ↓49 R143 CH2.1% 0.7%/1.0M      (workbuddy) cn:space-bunny`
    //
    // 模型那行贴在**第二行**右侧（不是第一行）—— 之前我放错了行，pi 是用量与模型并排。
    // 整块上 dim（=\x1b[2m）：底箱是背景信息，不该跟对话内容抢注意力。
    //
    // dim 要包住**整行**而不是每段单独包：`twoColumn` 靠 visibleWidth 算空白，
    // 已经上了色的那段会算错宽度。做法是先用无色文本算好对齐，再整体包 dim。
    const width = terminal.columns ?? 100;
    const stats = statsLine(state);
    const statsRow = twoColumn(stats.text, modelLine(state), width);
    footer.setText(
      dim(padToWidth(cwdLine(cwd, gitBranch(cwd)), width)) +
        '\n' +
        // dimLine 而不是 dim：上下文超 70%/90% 时那一小段要保持黄/红。
        // 直接 dim(带色文本) 的话，内层的 \x1b[0m 会把外层 dim 提前关掉。
        dimLine(padToWidth(statsRow, width), ...stats.warnings),
    );
    // 提示过期就清掉（6 秒后自动消失，不留一行孤儿文本）。
    if (notice.text !== '' && Date.now() > noticeUntil) notice.text = '';
    transcript.update(state, terminal.columns ?? 100, expanded, notice);
    if (showTrace) {
      tracePanel.setText(
        state.trace.order.length === 0
          ? dim('（还没有任何节点）')
          : renderColoredTree(state.trace, terminal.columns ?? 100),
      );
    } else {
      tracePanel.setText('');
    }
    tui.requestRender();
  };

  store.subscribe(() => {
    const state = store.getState();
    // 环跑完时把 loader 收掉。
    if (state.phase === 'idle' && loading) {
      loading = false;
      loader.stop();
      // stop() 只停动画，**不清那一行文字** —— 不置空的话「思考中…」会一直留在屏幕上转，
      // 看起来像还在跑（这是「TUI 不可用」最容易被误判的地方）。
      loader.setMessage('');
      // 还要把 frames 换回空：setIndicator() 自己会 start()，不换的话下一轮空闲时
      // 那个圈又会自己转起来。
      loader.setIndicator({ frames: IDLE_FRAMES });
      lastLoaderMessage = '';
    }
    refresh();
  });

  // 显式标出回调参数类型：1.x 的 TuiInputListener 是具名类型，不再从上下文推断。
  const onInput: TuiInputListener = (data: string) => {
    if (matchesKey(data, 'ctrl+c')) {
      if (store.getState().phase !== 'idle') {
        abortRun();
        return { consume: true };
      }
      tui.stop();
      process.exit(0);
    }
    // Ctrl+T：切换轨迹面板。底部要放哪些组件变了，布局必须跟着重设。
    if (matchesKey(data, 'ctrl+t')) {
      showTrace = !showTrace;
      applyLayout();
      refresh();
      return { consume: true };
    }
    // Ctrl+O：展开/收起工具输出的完整内容。与 pi 同键。
    if (matchesKey(data, 'ctrl+o')) {
      expanded = !expanded;
      refresh();
      return { consume: true };
    }
    return undefined;
  };
  tui.addInputListener(onInput);

  editor.onSubmit = (rawText: string) => {
    const input = rawText.trim();
    if (!input) return;
    // 斜杠命令：不发给模型。
    if (input.startsWith('/')) {
      runCommand(input.slice(1));
      return;
    }
    if (store.getState().phase !== 'idle') {
      lastLoaderMessage = `${yellow('上一回合还没结束（Ctrl-C 可中断）')}`;
      refresh();
      return;
    }
    send(input);
  };

  /**
   * 斜杠命令。不发给模型 —— 那是「跟模型说」的通道，命令是「跟界面说」的。
   * 未知命令回一行提示，不静默吞掉（否则用户以为自己已经在跟模型说了）。
   */
  const runCommand = (raw: string): void => {
    const [name = '', ...rest] = raw.trim().split(/\s+/);
    const arg = rest.join(' ');
    switch (name) {
      case 'sessions':
      case 'resume': {
        // 环在跑时不能换会话（正在写消息）。
        if (store.getState().phase !== 'idle') {
          notify(yellow('上一回合还没结束，先 Ctrl-C 中断再恢复历史'));
          return;
        }
        openSessionPicker({
          tui,
          onPick: (session) => restoreSession(session),
        });
        return;
      }
      case 'clean':
      case 'wipe': {
        // 环在跑时不能删：正在往某个会话文件里写。
        if (store.getState().phase !== 'idle') {
          notify(yellow('上一回合还没结束，先 Ctrl-C 中断再清理'));
          return;
        }
        // 当前会话放行：它的文件正被记录器开着。
        const current = sessionId?.();
        const result = current ? cleanSessionsExcept([current]) : cleanSessionsExcept([]);
        const failed = result.failed.length > 0 ? `，${result.failed.length} 条没删掉` : '';
        notify(
          dim(
            `已清理 ${result.sessions} 条历史会话（${result.removed} 个文件）${failed}` +
              (current ? '（当前这段保留）' : ''),
          ),
        );
        return;
      }
      case 'new':
      case 'forget': {
        // 环在跑时不能换会话（正在写消息）。
        if (store.getState().phase !== 'idle') {
          notify(yellow('上一回合还没结束，先 Ctrl-C 中断再开新会话'));
          return;
        }
        // 走内核的 newSession：**换 sessionId**，于是换文件。
        // 只 dispatch conversation.reset 的话 id 不变，新消息会续写进旧文件 ——
        // 界面上看着像新会话，实际上把上一段历史污染了。
        const created = newSession?.();
        if (!created) {
          // 没接内核（比如测试）：退化成只清对话，并说清差别。
          store.dispatch({ type: 'conversation.reset' });
          notify(dim('已清空对话（未接内核，沿用原会话文件）'));
          return;
        }
        notify(dim(`已开新会话 ${created.id}（上一段仍在 sessions/ 里，/sessions 可回来）`));
        return;
      }
      case 'help':
        // 念同一份 SLASH_COMMANDS —— 手抄一份迟早会和补全列表漂移。
        notify(
          SLASH_COMMANDS.map(
            (c) =>
              `${bold(`/${c.name}`)}${' '.repeat(Math.max(1, 10 - c.name.length))}${c.description ?? ''}`,
          ).join('\n'),
        );
        return;
      default:
        notify(yellow(`未知命令 /${name}（试试 /help）`));
    }
    void arg;
  };

  /** 在对话区插一行提示（命令结果、错误）。 */
  const notify = (text: string): void => {
    notice.text = text;
    noticeUntil = Date.now() + 6000;
    refresh();
  };

  /**
   * 恢复一个历史会话：把它的消息灌回 state。**零 token** —— 不重跑模型，
   * 纯粹是把 JSONL 里读到的内容搬进状态树。
   *
   * ## 两条路，优先走内核那条
   *
   * 1. `options.restoreSession`（接了内核）：内核负责换会话 id + 记录器游标对齐，
   *    不会把恢复出来的历史再写一遍盘。**这是唯一正确的那条**。
   * 2. 没接（测试、或将来另一个前端）：退化成界面版 —— 一条 `conversation.restored`
   *    灌完，仍然一次 dispatch（不是逐条），但**不换 id**、也没有记录器游标的概念，
   *    于是恢复出来的消息会被当前记录器当成新消息写盘（也就是「复制一份」那个症状）。
   *    这种情况要说出来，不然用户会以为是历史坏了。
   *
   * ## 为什么必须**一条** action 而不是逐条
   *
   * 每次 dispatch 都会让 `refresh()` 重渲染整段对话，而重渲染成本与 messages 长度成正比。
   * 逐条灌 N 条 = O(N²)：那个 390 条消息的会话实测 62 秒（用户看到的是「卡了一分钟」）。
   * 合成一条只渲染一次，O(N)。
   *
   * 轨迹**不**跟着恢复：轨迹是那一轮的产物（时间线、失败、重试），和「对话内容」是两份
   * 并行的记录，历史轨迹在 `traces/<id>.jsonl`（`/trace` 面板只看当前轮）。
   */
  const restoreSession = (session: SessionSummary): void => {
    // 先走内核那条，而且**先**判断再读文件：内核的 restoreSession(file) 自己会读，
    // 这里要是先 loadSessionMessages 就等于把 1MB 多的文件读两遍。
    if (restoreHook) {
      const result = restoreHook(session.file);
      notify(
        dim(
          `已恢复 ${result.id}（${result.restored} 条消息，未重跑模型；之后的消息继续写进它）`,
        ),
      );
      refresh();
      return;
    }
    const messages = loadSessionMessages(session);
    if (store.getState().trace.sessionId === session.id) {
      // 恢复的就是当前会话：直接一条灌回去（重复灌一遍内容相同的消息，但没有别的问题）。
      store.dispatch({
        type: 'conversation.restored',
        sessionId: session.id,
        messages,
      } as AgentAction);
      notify(dim(`已重载 ${session.id}（${messages.length} 条消息，未重跑模型）`));
      refresh();
      return;
    }
    store.dispatch({
      type: 'conversation.restored',
      sessionId: store.getState().trace.sessionId,
      messages,
    } as AgentAction);
    notify(
      yellow(
        `已载入 ${messages.length} 条消息到**当前会话**（未接内核，无法切换记录器）—— ` +
          `后续消息会写进当前会话文件，不是 ${session.id}`,
      ),
    );
    refresh();
  };

  const send = (text: string): void => {
    loading = true;
    lastLoaderMessage = '';
    // 生成中才真的转：setIndicator 内部会 start()，所以这里换 frames 就等于「开动画」。
    loader.setIndicator({ frames: BUSY_FRAMES });
    loader.setMessage(yellow('思考中…'));
    loader.start();
    store.dispatch({ type: 'user.message', text });
    refresh();
  };

  // 布局：AltScreen = 真正的全屏（占满视口、终端不留回滚缓冲）。
  // 纵向三段：顶栏一行 / 对话区（唯一可伸缩，自己滚）/ 底部输入区。
  //
  // 为什么不能用 addChild 平铺：那样每个组件各占若干行，内容一多就把输入框顶出屏幕，
  // 而且整屏重画时旧内容会留在回滚缓冲里（看起来像「重复刷屏」）。
  //
  // 为什么写成函数：Ctrl+T 切换轨迹面板会改变底部要放哪些组件，布局得跟着重设。
  const scroll = new ScrollView(transcript, { follow: 'end', primary: true });
  // 用函数声明（不是 const 箭头）：onInput 里会调它，const 有 TDZ，声明会提升。
  function applyLayout(): void {
    // 对话区是**唯一**可伸缩的（basis 0 + grow 1），其余按内容自适应。
    //
    // 下面这三个**不给 `basis`**：给了就把固有高度钉死成那个数（`layout.js` 里是
    // `typeof entry.basis === 'number' ? entry.basis : measureHeight(...)`），
    // 于是编辑器永远只有 3 行 —— 它的补全列表（自己渲染成额外行）就画不出来，
    // 打 `/` 看着像什么都没发生。不给则每帧渲染一遍量真实高度，补全展开时自然变高。
    const bottom = new VStack([
      ...(showTrace ? [{ component: tracePanel, minSize: 1 }] : []),
      { component: loader, minSize: 1 },
      { component: editor, minSize: 3 },
      { component: footer, basis: 2, grow: 0, minSize: 2 },
    ]);
    tui.setLayoutRoot(
      new VStack([
        { component: header, basis: 1, grow: 0, minSize: 1 },
        { component: scroll, basis: 0, grow: 1, minSize: 3 },
        bottom,
      ]),
    );
  }
  applyLayout();

  tui.setFocus(editor);
  // **先填内容再 start()**：header / footer 初始是空串，pi-tui 量高度时得到 0，
  // 于是那两行在布局里塌掉 —— 屏幕上只剩编辑器那两条横线，顶栏与底栏都不见了。
  // （首帧必须可见，所以这里就要有内容；不能指望「用户发一条消息后 store 变化触发
  //  refresh」—— 启动时 store 根本没变。）
  refresh();
  tui.start();

  if (prompt !== undefined) {
    // 一次性模式：TUI 的差分渲染在非交互终端里只会留下一堆转义序列，
    // 所以不走界面 —— 直接跑环，然后把**纯文本**的对话与轨迹树打到 stdout。
    // 轨迹树照样有（这才是重点），只是不经过 pi-tui 的画布。
    tui.stop();
    store.dispatch({ type: 'user.message', text: prompt });
    await waitForIdleOrExit(store);
    // 一次性模式没有终端尺寸（不走 TUI），给 0 = 不折行、不截断（truncateToWidth 的约定）。
    //
    // **必须剥掉控制序列**：这一段是管道/重定向的接收方，拿到 OSC 8 超链接（文件路径那行
    // `]8;;file:///…\…]8;;`）只会得到一团乱码。官方渲染器对文件路径默认加超链接
    // （`renderToolPath` → `linkPath`），而 `getCapabilities().hyperlinks` 在
    // 「终端没被认出来」时是 true，所以管一次输出才靠谱。
    // 注意是连 OSC 133 区域标记一起剥 —— pi-tui 的 `stripTerminalSequences` 两者都吃。
    const plain = stripTerminalSequences(renderTranscript(store.getState(), 0, 0, true));
    process.stdout.write(`${plain}\n`);
    process.stdout.write(`\n${renderColoredTree(store.getState().trace, 0)}\n`);
    return store.getState().error ? 1 : 0;
  }

  // 交互模式：Ctrl-C 退出，所以这里只是挂住。
  await new Promise<void>(() => {});
  return 0;
}

function waitForIdleOrExit(store: AgentStore): Promise<void> {
  return new Promise((resolve) => {
    if (store.getState().phase === 'idle') {
      resolve();
      return;
    }
    const unsubscribe = store.subscribe(() => {
      if (store.getState().phase === 'idle') {
        unsubscribe();
        resolve();
      }
    });
  });
}

// ══════════════════════════ 对话区的四类渲染 ══════════════════════════
//
// 四个函数都返回**已上好色、已铺好底色**的行数组。分成四个而不是写在一个 switch 里，
// 是因为它们各自要处理的边界完全不同：用户块要铺满整行蓝底，思考块要斜体，
// 工具块要按成败切绿/红底色，而普通助手文字什么都不用做。

/**
 * 宽度兜底。
 *
 * 官方组件都拿 `width` 去折行与补底色，传 0 会算出「宽度 -1」那类怪值
 * （`Text.render` 里 `Math.max(1, width - paddingX*2)` 还能活，但 Box 补底色那步会错位）。
 *
 * 一次性模式（`npm run agent -- "提问"`）走的就是这条路：那里根本没启动 TUI，
 * 也就没有终端尺寸。给个够大的宽度让终端自己折行，比「猜一个宽度」安全 ——
 * 猜窄了会截断内容，猜宽了底色会超出屏幕。
 */
const FALLBACK_WIDTH = 200;

function usableWidth(width: number): number {
  return width > 0 ? width : FALLBACK_WIDTH;
}

/**
 * 工具渲染器表。**按官方工具名索引**。
 *
 * ## 为什么用 `create*ToolDefinition()` 而不是 `createAllToolRenderers()`
 *
 * 后者返回的表里 `edit` 的 `renderShell` 是 `undefined`，而工具**定义**上是 `"self"`。
 * `ToolExecutionComponent` 靠这个字段决定外壳：非 `"self"` 时它用自己的 `Box` 给整块
 * 铺底色，而 `edit` 的渲染器**自己**已经铺了一层（`getEditHeaderBg`）。
 *
 * 漏掉的后果很隐蔽：edit 块**底色被套了两层**（`48;2;37;65;49` 出现两次），
 * 在大多数终端上看不出来，但在浅色/高对比主题下边界会错位；而 `renderShell` 错了
 * 还会让 `edit` 走错代码路径（`selfRenderContainer` vs `contentBox`），将来官方改形状时
 * 我们跟错还不报错。
 *
 * 顺带一说：为什么标题是英文工具名 —— 官方 `label` 字段本身就是 `"edit"`/`"read"`
 * （见 `createEditToolDefinition` 的 `label: "edit"`），pi 界面显示的就是它。
 * 我们另起了一套中文 label（`读文件`/`执行命令`），那是**二次翻译**：既多一层维护，
 * 也让界面与 pi 对不上。现在直接显示工具名。
 */
const TOOL_RENDERERS: Record<string, unknown> = Object.fromEntries(
  [
    ['read', createReadToolDefinition(process.cwd())],
    ['write', createWriteToolDefinition(process.cwd())],
    ['edit', createEditToolDefinition(process.cwd())],
    ['bash', createBashToolDefinition(process.cwd())],
  ].map(([name, definition]) => [name, definition]),
);

/**
 * 官方 `ToolExecutionComponent` 只需要一个能收下 `requestRender()` 的对象。
 *
 * 为什么不把真的 `tui` 传进去：它只在 bash 块跑流式计时器时用来发重绘请求
 * （`renderResult` 里那个每秒一次的 `setInterval`）。我们是一次性渲染整段文本
 * （`renderTranscript` 的输出直接进 `Text.setText`），没有帧循环可言，
 * 所以一个空实现就够了。传 null 会在执行到 `ui.requestRender()` 时崩。
 */
const TOOL_UI = { requestRender: () => {}, invalidate: () => {} };

/** system 消息：pi 没有专门的样式，用淡色表示「这不是谁在说话」。 */
function renderPlain(text: string): string[] {
  if (text.trim() === '') return [];
  // 直接按 \n 拆行而不走 Markdown：system 提示是配置里的一段话（常带路径与代码），
  // 走 Markdown 会把缩进代码块、标题符号全吃掉，反而看不清。
  return text.split('\n').map((row) => dim(row));
}

/** 用户消息：整块蓝底铺满。 */
function renderUser(text: string, width: number): string[] {
  if (text.trim() === '') return [];
  return new UserMessageComponent(text, getMarkdownTheme(), 1).render(usableWidth(width));
}

/**
 * 助手消息：文字 + 灰色斜体的思考。
 *
 * ## 为什么必须把 thinking 块原样交给官方组件
 *
 * `state.thinkingText` 只在**流式过程中**有值，一轮结束 `llm.done` 就把它清空了；
 * 真正的思考内容在 `message.content` 里的 `type: 'thinking'` 块。早先的渲染只认
 * `type: 'text'`，于是**所有思考都丢了** —— 而思考是这类界面里最该被看见的一部分
 * （它告诉你模型为什么这么干）。
 *
 * `AssistantMessageComponent` 另外还处理两件事，都不能自己重写：连续多个 thinking 块
 * 合并成一段；后面没有可见内容时不多插空行。截图里「思考段落之间有间隔，
 * 但工具块之前没有多余空行」就是这个逻辑的结果。
 */
function renderAssistant(
  content: readonly unknown[],
  width: number,
  isStreaming = false,
): string[] {
  // 先筛掉空的：Markdown 对空白文本返回 []，而 toolCall 块在这里不画
  // （它由紧接着的 toolResult 消息负责）—— 不筛的话每条纯工具调用消息会多出空行。
  const visible = content.filter((raw) => {
    const c = raw as { type?: string; text?: string; thinking?: string };
    if (c.type === 'text') return (c.text ?? '').trim() !== '';
    if (c.type === 'thinking') return (c.thinking ?? '').trim() !== '';
    return false;
  });
  if (visible.length === 0) return [];
  const message = { role: 'assistant', content: visible } as never;
  const component = new AssistantMessageComponent(message, false, getMarkdownTheme(), 'Thinking…', 1);
  // 构造器已经渲染过一次；显式再调一次是为了把「是否还在流式」告诉它 ——
  // 官方用它决定列表编号等细节要不要稳定。
  component.updateContent(message, isStreaming);
  return component.render(usableWidth(width));
}

/**
 * 工具块。
 *
 * ## `Took 0.5s` 的时间从哪来
 *
 * pi 的 bash 块底部那行耗时，是**渲染器自己记的**：`ToolExecutionComponent.markExecutionStarted()`
 * 在 `rendererState.startedAt` 打点，拿到结果时补 `endedAt`。我们执行工具走自己的 effect，
 * 不会去调 `markExecutionStarted()`，所以耗时得从 `state.toolTimings`（reducer 记的）取，
 * 再手动塞进 `rendererState`。
 *
 * 直接改 `rendererState` 是伸手进了官方组件的私有字段 —— 但这是唯一能拿到那行 `Took`
 * 的办法：它是**纯展示**的（只影响那一行文字），错了也只错在显示上。
 * 替代方案是自己重写整个 bash 渲染器，那要重新对上一堆底色/折行细节，不划算。
 *
 * 注意 `endedAt` 要在 `updateResult()` **之前**写：否则渲染器会自己取 `Date.now()`，
 * 那算的是「渲染时刻」而不是「命令跑完时刻」—— 差值虽小，但反复重绘时那个数字会一直跳。
 */
function renderTool(
  state: AgentState,
  message: Extract<AgentState['messages'][number], { role: 'toolResult' }>,
  width: number,
  expanded: boolean,
): string[] {
  const args = toolCallArgs(state, message.toolCallId);
  // 找不到对应的 toolCall（会话被裁剪/恢复后可能配不上）就**什么都不画**，
  // 也不要编一个标题：工具块的全部信息都在参数里（`read <path>`、`$ <command>`），
  // 没参数的块只会是一行空底色，看着像程序坏了。
  if (args === null) return [];
  const component = new ToolExecutionComponent(
    message.toolName,
    message.toolCallId,
    args,
    { showImages: false, imageWidthCells: usableWidth(width) },
    TOOL_RENDERERS[message.toolName] as never,
    TOOL_UI as never,
    process.cwd(),
  );
  const elapsed = state.toolTimings[message.toolCallId];
  if (elapsed !== undefined) {
    // 用「结束时刻 = 开始时刻 + 耗时」反推：官方渲染器只认绝对时刻，而 reducer
    // 存的是时长（那样不依赖两端时刻是否都拿得到）。
    const endedAt = message.timestamp;
    const startedAt = endedAt - elapsed;
    component.markExecutionStarted();
    (component as unknown as { rendererState: Record<string, unknown> }).rendererState.startedAt = startedAt;
    (component as unknown as { rendererState: Record<string, unknown> }).rendererState.endedAt = endedAt;
  }
  component.setArgsComplete();
  // 组件是每次重建的，不显式设就是默认折叠 —— Ctrl+O 会永远不生效。
  component.setExpanded(expanded);
  component.updateResult(
    {
      content: message.content.map((c) =>
        c.type === 'text'
          ? { type: 'text', text: c.text }
          : { type: 'image', data: c.data, mimeType: c.mimeType },
      ),
      details: message.details ?? undefined,
      isError: message.isError,
    },
    false,
  );
  return component.render(usableWidth(width));
}

/** 把 toolCallId 配到那条 assistant 消息的调用参数上。配不上就返回 null。 */
function toolCallArgs(state: AgentState, toolCallId: string): Record<string, unknown> | null {
  for (const m of state.messages) {
    if (m.role !== 'assistant') continue;
    for (const c of m.content) {
      if (c.type === 'toolCall' && c.id === toolCallId) {
        return c.arguments as Record<string, unknown>;
      }
    }
  }
  return null;
}

/**
 * 把整段对话渲染成文本块（`from` 恒为 0：滚动交给 ScrollView）。
 *
 * ## 不加「你 ›」「助手 ›」这类前缀
 *
 * 这是与 pi 最早的一处形状分歧：我们在每条消息前面加了一个带颜色的角色名，
 * pi 没有任何前缀 —— 角色靠**底色与字体形状**区分：
 *
 *   - 用户：整块蓝底（`userMessageBg`）铺满整行
 *   - 助手：默认前景色、无底色
 *   - 思考：灰色**斜体**（`thinkingText`）
 *
 * 加前缀的代价不只是「多了两个字」：用户那块蓝底（截图中一整条深蓝带）会变成
 * 「`你 ›` + 白字」，而模型说的话（白字无底）与提示（灰斜体）挤在同一行里，
 * 斜体失效。一句话能认出是模型说的还是你自己说的，底色比前缀准。
 *
 * ## 直接用 pi 的组件，而不是照着截图重画
 *
 * `UserMessageComponent` / `AssistantMessageComponent` / `ToolExecutionComponent`
 * 加上 `createAllToolRenderers()` 是 pi 官方那套渲染器（靠 pnpm patch 打开的子路径）。
 * 用它们而不是手写，是因为里面有一堆「眼睛看不出来但错了很难受」的细节：
 * bash 折叠**保留尾部** 5 行（头部是命令，尾部才是报错）而 read/write 保留头部 10 行；
 * write 的块里是**文件内容**而不是工具输出；edit 渲染的是**彩色 diff**；
 * 每个工具块用 `Box` 把底色补到整行（手写时宽度差一列底色就断一截）。
 * 这些各自都不难，但**一起对**才和截图一致。
 */
/**
 * 渲染**一条**消息。
 *
 * ## 为什么要单独抽出来
 *
 * 对话区是**增量**渲染的（见 `TranscriptChunks`）：每条消息各自成为一个组件，
 * 内容没变就不重算。整段渲染只有在一次性模式（管道输出）和测试里才需要，
 * 那是同一套循环拼起来的。
 */
export function renderMessage(
  state: AgentState,
  message: Extract<AgentState['messages'][number], { role: string }>,
  width: number,
  expanded: boolean,
): string[] {
  // pi-ai 1.x：Message 联合多了 system，且 content 可能是纯字符串 ——
  // 先按 role 收窄，再把 content 归一成「文本片段数组」再渲染。
  if (message.role === 'system') {
    const text = typeof message.content === 'string' ? message.content : '';
    return text ? renderPlain(text) : [];
  }
  if (message.role === 'user') {
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .map((c) => (c.type === 'text' ? c.text : '[image]'))
            .join(' ');
    return renderUser(text, width);
  }
  if (message.role === 'assistant') {
    // 助手消息：**只有可见内容才占行**。一条纯 toolCall 的消息如果硬渲染会得到
    // 一段空白（Markdown 组件对空文本返回 []），而它紧跟着就有工具块要画。
    return renderAssistant(message.content, width);
  }
  return renderTool(
    state,
    message as Extract<AgentState['messages'][number], { role: 'toolResult' }>,
    width,
    expanded,
  );
}

// ══════════════════════════ 对话区：增量渲染 ══════════════════════════

/**
 * 对话区：**按消息分块**的增量渲染。
 *
 * ## 为什么不是「整段一个 Text」
 *
 * 原来的做法是 `transcript.setText(renderTranscript(...))`：每次状态变化都把**整段**
 * 对话重新渲染成一个字符串，再让 `Text.render()` 折行。而流式 token 每来一个就触发一次
 * `store.subscribe` → `refresh()`，于是每帧都要：
 *
 *   1. `renderTranscript`：重建 N 个官方组件（Markdown 解析、diff、底色）—— 实测 887ms
 *   2. `Text.render`：重新折行 14890 行 / 1.9MB 文本 —— 实测 313ms
 *
 * 合计约 **1.2 秒一帧**，而 pi-tui 的 `MIN_RENDER_INTERVAL_MS` 只有 16ms。渲染永远追不上
 * 流式速度，症状就是「界面卡住、token 刷不出来」。而且这是**同步**的：它直接占住事件
 * 循环，连输入都收不到 —— 越长的会话越卡。
 *
 * ## 照抄 pi 官方的结构
 *
 * pi 的 `interactive-mode.js` 就是每个消息一个组件（`chatContainer.addChild(...)`），
 * 流式那一条原地 `updateContent`。`Text` 组件自己缓存 `render()` 的结果，只在
 * `setText()` 时失效 —— 所以「没变的块不重算」这件事官方组件已经帮我们做好了，
 * 缺的只是别把 1208 条消息塞进**同一个** `Text` 里。
 *
 * 实测（1208 条消息的真实会话）：整段 291.9ms/帧 → 分块 **0.30ms/帧**（≈160×）。
 *
 * ## 缓存键为什么是「宽度 + 折叠」而不是只有消息本身
 *
 * 同一个 `message` 对象在两种情况下渲染结果不同：终端宽度变了（要重新折行），
 * Ctrl+O 切了 `expanded`（工具块展开/折叠）。这两个都进了键，所以宽度变化或
 * 切换折叠后不会读到过期的行。
 *
 * 用 `WeakMap` 而不是 `Map`：键是消息对象，会话被 `/new` 清空后旧消息就能被回收 ——
 * 用 `Map` 的话整段历史会一直被钉在内存里。
 */
export class TranscriptChunks {
  /** 每条消息一个 `Text`，下标与 `state.messages` 一一对应。 */
  private readonly blocks: Text[] = [];
  /**
   * 每个块上一次 `setText` 的内容。
   *
   * 为什么不能读 `block.text` 而不是自己存：pi-tui 的 `Text.text` 在类型上是 `private`
   * （编译不过），而 `setText` 之后「有没有变」正是要判断的事。自己存一份等价，
   * 而且这份数组还能顺手当「哪些块需要重画」的依据。
   */
  private readonly lastTexts: string[] = [];
  /** 命令反馈（`/clean` 的结果、恢复会话的提示）—— 形状是**贴在对话区顶部**。 */
  private readonly noticeBlock: Text;
  /** 正在流式生成的文字：每帧都在变，**只渲染这一条**。 */
  private readonly streamBlock: Text;
  /** 重试提示 + 收工原因 + 错误提示。 */
  private readonly tail: Text;
  /**
   * 按消息缓存渲染结果。`WeakMap<object, Map<string, string[]>>`：
   * 外层按消息对象，内层按 `${width}:${expanded}` 键。
   */
  private readonly cache = new WeakMap<object, Map<string, string[]>>();
  /** 上一帧的宽度：变了就得让 pi-tui 重新折行（`Text` 自己会重算）。 */
  private lastWidth = 0;
  /** 三个尾块上一次的内容，避免每帧都 `setText`（那会让它们的缓存失效）。 */
  private lastNotice = '';
  private lastStream = '';
  private lastTail = '';

  constructor() {
    this.noticeBlock = new Text('', 0, 0);
    this.streamBlock = new Text('', 0, 0);
    this.tail = new Text('', 0, 0);
  }

  private chunkLines(
    message: Extract<AgentState['messages'][number], { role: string }>,
    key: string,
    build: () => string[],
  ): string[] {
    let perKey = this.cache.get(message as object);
    if (!perKey) {
      perKey = new Map();
      this.cache.set(message as object, perKey);
    }
    const hit = perKey.get(key);
    if (hit !== undefined) return hit;
    const lines = build();
    perKey.set(key, lines);
    return lines;
  }

  /**
   * 同步到最新状态。
   *
   * 成本：**只有变了的块会重算**。流式 token 只碰 `streamBlock`，历史块全部命中缓存。
   *
   * @param width 终端宽度。变了会让**每个**块重新折行（一次性代价，不在流式路径上）。
   */
  update(state: AgentState, width: number, expanded: boolean, notice: { text: string }): void {
    const key = `${width}:${expanded}`;
    const widthChanged = width !== this.lastWidth;
    const messages = state.messages;
    const count = messages.length;
    // 消息变少（/new、恢复别的会话）：把多余的块**丢掉**。
    //
    // 为什么不能只跳过：`render()` 是遍历 `this.blocks` 全部元素，而 blocks 与
    // messages 等长只在「消息只增不减」时成立。留着的话 `/new` 之后旧消息还画在屏幕上
    // （这个测试就是钉它的）。
    if (this.blocks.length > count) {
      this.blocks.length = count;
      this.lastTexts.length = count;
    }
    for (let i = 0; i < count; i += 1) {
      const message = messages[i];
      if (!message) continue;
      this.blockLines(message, i, key, state, width, expanded, widthChanged);
    }
    // 三个尾块各自独立，不合成一个 —— 合起来每帧就要 join 一次 1.9MB 字符串，
    // 那正是本次要消掉的开销（而且会把整段对话重复画一遍，见下面的注释）。
    this.setIfChanged(this.noticeBlock, 'notice', notice.text === '' ? '' : `${notice.text}\n`, notice.text);
    this.setIfChanged(
      this.streamBlock,
      'stream',
      state.phase === 'thinking' && state.streamingText
        ? renderAssistant([{ type: 'text', text: state.streamingText }], width, true).join('\n')
        : '',
      state.streamingText,
    );
    this.setIfChanged(this.tail, 'tail', renderTail(state, width).join('\n'), state.error ?? '');
    this.lastWidth = width;
  }

  /** 内容真变了才 `setText`（它会清掉块自己的折行缓存）。 */
  private setIfChanged(block: Text, slot: 'notice' | 'stream' | 'tail', text: string, identity: string): void {
    if (this.lastOf(slot) === identity) return;
    this.remember(slot, identity);
    block.setText(text);
  }

  private lastOf(slot: 'notice' | 'stream' | 'tail'): string {
    return slot === 'notice' ? this.lastNotice : slot === 'stream' ? this.lastStream : this.lastTail;
  }

  private remember(slot: 'notice' | 'stream' | 'tail', value: string): void {
    if (slot === 'notice') this.lastNotice = value;
    else if (slot === 'stream') this.lastStream = value;
    else this.lastTail = value;
  }

  /** 一条消息的块：命中缓存就不碰组件，否则重算并 `setText`。 */
  private blockLines(
    message: Extract<AgentState['messages'][number], { role: string }>,
    index: number,
    key: string,
    state: AgentState,
    width: number,
    expanded: boolean,
    widthChanged: boolean,
  ): string[] {
    const cached = this.chunkLines(message, key, () =>
      renderMessage(state, message, width, expanded),
    );
    let block = this.blocks[index];
    if (!block) {
      // **必须新建而不是复用**：pi-tui 的布局按「组件对象 + 宽度」缓存（layout.js 的
      // `renderCached`），复用旧对象才能让历史块在后续帧里跳过重算。
      block = new Text('', 0, 0);
      this.blocks[index] = block;
    }
    const text = cached.join('\n');
    // 内容变了才 `setText`（它会清掉块自己的折行缓存）。
    if (this.lastTexts[index] !== text) {
      block.setText(text);
      this.lastTexts[index] = text;
    } else if (widthChanged) {
      // 只变宽：**不能 setText**（内容没变，setText 是白做），但块里按宽度分桶的折行
      // 缓存要清掉。用 `invalidate()` 而不是 `setText(同一份文本)`：后者会让下一帧
      // 看起来「内容变了」，多一次无谓的重建。
      block.invalidate();
    }
    return cached;
  }

  /**
   * 给布局用的组件（`ScrollView` 吃的就是它）。
   *
   * ## 为什么用 `lastWidth` 而不是传入的 `width`
   *
   * 块里的行是 `update()` 时**按那个宽度**渲染的（官方组件已经折行、铺好底色、补齐到全宽）。
   * 拿另一个宽度去 `render()` 就会把按 40 列排好的行按 120 列再折一次 —— 结果是每行
   * 后面挂着一截空白，行数凭空翻倍（实测 15 行变 36 行）。
   *
   * 所以宽度以 `update()` 为准。正常调用顺序本来就是 `update()` → `requestRender()`
   * → 布局来 `render()`，两者同宽；但万一顺序反了，这里也不会画出乱掉的东西。
   */
  render(width: number): string[] {
    const at = this.lastWidth > 0 ? this.lastWidth : width;
    const lines: string[] = [];
    lines.push(...this.noticeBlock.render(at));
    for (const block of this.blocks) lines.push(...block.render(at));
    lines.push(...this.streamBlock.render(at));
    lines.push(...this.tail.render(at));
    return lines;
  }

  invalidate(): void {
    for (const block of this.blocks) block.invalidate();
    this.noticeBlock.invalidate();
    this.streamBlock.invalidate();
    this.tail.invalidate();
  }
}

/**
 * 对话区**尾部**那些不属于任何单条消息的行：正在流式生成的文字、重试提示、收工原因。
 *
 * 从 `renderTranscript` 里原样搬出来的，所以两处画出来的东西一致。
 *
 * 注意**不含**正在流式生成的文字：那一段由 `TranscriptChunks` 单独一个块负责
 * （它每帧都变，必须独立才能只重画它）。`renderTranscript` 里仍然拼上它，
 * 因为那是一趟性渲染，形状必须与界面一致。
 */
export function renderTail(state: AgentState, width: number): string[] {
  const lines: string[] = [];
  if (state.retrying) {
    lines.push(dim(`  ↻ 上一次失败，正在重试（第 ${state.llmAttempts}/${state.maxLlmAttempts} 次尝试）`));
  }
  // 收工原因。maxTurns 用「停」而不是「✗」：那是上限收工，不是出错，别吓唬人。
  if (state.phase === 'idle' && state.error) {
    const capped = state.stopReason === 'maxTurns';
    // **用户自己按了停止**不是故障：以前与真错误同一条红字，看上去像程序崩了。
    // 这里单独走灰色「已停止」，不吓人，也不必让人以为要去看轨迹排查。
    const stoppedByUser = state.stopCause === 'user';
    const node = state.errorNodeId ? `（轨迹节点 ${state.errorNodeId}）` : '';
    // 停止原因写在前面：光看 error 那句技术文案（'LLM 调用已中断'）没人知道发生了什么。
    const cause = state.stopCauseDetail ? `${state.stopCauseDetail}：` : '';
    if (stoppedByUser) {
      lines.push(`  ${dim('■')} ${dim(`${cause}${state.error}`)} ${dim(node)}`);
      lines.push(dim('  已按你的要求停下，模型没写完 —— 追问即可继续。'));
    } else if (capped) {
      lines.push(`  ${yellow('■')} ${yellow(state.error)} ${dim(node)}`);
      lines.push(dim('  这是上限收工，不是出错 —— 继续追问即可，或用 /new 换个会话。'));
    } else {
      // 真失败：带上原因（超时 / 鉴权 / 网络…），免得只看到一句干巴巴的英文。
      lines.push(`  ${red('✗')} ${red(`${cause}${state.error}`)} ${dim(node)}`);
      lines.push(dim('  按 Ctrl+T 看轨迹树'));
    }
  }
  return lines;
}

export function renderTranscript(
  state: AgentState,
  from: number,
  width: number,
  expanded: boolean,
  notice?: { text: string },
): string {
  const lines: string[] = [];
  // 命令反馈贴在最上面，6 秒后自动消失。
  if (notice && notice.text !== '') lines.push(notice.text, '');
  for (let i = from; i < state.messages.length; i += 1) {
    const message = state.messages[i];
    if (!message) continue;
    lines.push(...renderMessage(state, message, width, expanded));
  }
  // 正在流式生成的这一段。**`renderTail` 里刻意不含它**（那边由独立的一块负责，
  // 合成一个就会画两遍）—— 一次性模式不走 TranscriptChunks，所以要在这里补上，
  if (state.phase === 'thinking' && state.streamingText) {
    lines.push(...renderAssistant([{ type: 'text', text: state.streamingText }], width, true));
  }
  // 否则管道输出会丢掉模型正在说的话。
  lines.push(...renderTail(state, width));
  return lines.join('\n');
}
