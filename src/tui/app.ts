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
  type Component,
  type SlashCommand,
  type ViewportTUI,
  type EditorTheme,
  type TuiInputListener,
} from '@earendil-works/pi-tui';
import { abortRun } from '../run-control';
import { renderTree, traceStats, type TraceNode, type TraceTree } from '../trace';
import { compactReasonText } from '../compact';
import type { AgentState } from '../state';
import type { AgentStore } from '../store';
import type { AgentAction } from '../actions';
import type { ToolCall } from '@earendil-works/pi-ai';
import { cleanSessionsExcept, listSessions, type SessionSummary } from '../config-home';
import { loadSessionMessages, openSessionPicker } from './session-picker';
import { readFileSync, statSync } from 'node:fs';
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
import { SkillInvocationMessageComponent } from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/skill-invocation-message.js';
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
import type { HostUiOptions } from '../extension-ui';
import type { ExtensionCommands } from '../extension-commands';
import { expandSkillCommand, parseSkillMessage, skillCommands, skillsInPrompt, type SkillInfo } from '../skills';

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
    // 压缩 = 历史被换掉的那个瞬间。给 magenta（与 stop 同色，视觉上归为「会话结构变了」这一类），
    // 而 pending 时就是暗色 —— 「正在压」与「压完了」一眼能分开。
    case 'compact':
      return node.status === 'pending' ? dim : magenta;
    // 上下文族（prompt.*）统一用暗色：它们是「背景」不是「事件」，不该抢对话的注意力。
    case 'prompt.base':
      return magenta;
    case 'prompt.tools':
      return dim;
    case 'prompt.segment':
      return blue;
    // skill 与 tools 同级（都是「装了什么」），但用 cyan 与 tools 的 dim 区分开 ——
    // 两者都在树上很淡，而 skill 往往是模型能不能做对事的关键，值得一眼看到。
    case 'prompt.skills':
      return cyan;
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
        /^(.*?)(n\d+) (llm\.attempt|llm\.result|tool\.attempt|tool\.result|user|error|stop|compact|prompt\.base|prompt\.tools|prompt\.segment|prompt\.skills|model\.init):/.exec(
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
 * ## 两种口径，不要混
 *
 * - **累计**（`↑`/`↓`/`R`/`W`/`$`）：本次会话一共花了多少。从 `state.messages` 里把
 *   所有 assistant 消息的 usage 累加（每帧 O(消息数)，换来与 pi 一致的口径）。
 * - **最近一次**（上下文占用 `29.2%/1.0M`）：这一次请求占了窗口多少。**只看最后一条
 *   有效消息的 usage**，不累加 —— 累加出来的数字是天文数字（见函数体的注释）。
 *
 * 两者混用就是「把整段历史重复数了 N 次」。
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

  // 上下文占用 = **最后一次** LLM 调用占掉多少窗口。**不能拿累加值**。
  //
  // ## 为什么不能累加（这里原先就错着）
  //
  // `totals` 是**整个会话累计**的 —— `↑`/`↓`/`R`/`$` 那一排要的就是这个口径
  // （“本次会话一共花了多少”）。但上下文窗口**不是**：它是**这一次请求**能装多少。
  // 每一轮的 `input + cacheRead` 都把当轮完整的 prompt 重新数了一遍，而 prompt 里
  // 包含**前面所有轮次的内容** —— 累加起来等于「整段历史被重复数了 N 次」。
  //
  // 实测（583 次助手消息的真实会话，窗口 1.0M）：累加口径 **9536%**，
  // 正确口径 **29.2%**。所以底栏会出现「9536%/1.0M」这种一眼就知道坏了的数字。
  //
  // ## 口径与 pi 官方一致
  //
  // `agent-session.js` 的 `getContextUsage()`：取**最后一条有效**助手消息的
  // `usage.totalTokens`（`compaction.js` 的 `calculateContextTokens`：
  // `totalTokens || input+output+cacheRead+cacheWrite`），即“上一次请求的总 token”。
  //
  // 这里**不自己上色**，而是把告警信息一起返回（`warning`）：整行底箱会被包进 dim，
  // 而 dim 里再嵌一个 `\x1b[0m` 结尾的颜色段会把 dim 提前关掉（见 dimLine 的注释）。
  const contextWindow = state.model.contextWindow;
  if (contextWindow > 0) {
    const last = lastContextUsage(state.messages);
    if (last !== undefined) {
      const percentValue = (last / contextWindow) * 100;
      // 超过 100% **如实显示**，不夹到 100 —— 夹了就变成“刚好满”，而事实是
      // “目录里配的窗口小于实际能发的量，该换窗口或压缩历史”。pi 也是直接显示原值。
      const percent = percentValue < 1 ? percentValue.toFixed(1) : Math.round(percentValue);
      const display = `${percent}%/${formatTokens(contextWindow)}`;
      parts.push(display);
      if (percentValue > 70) {
        warnings.push({ find: display, paint: percentValue > 90 ? red : yellow });
      }
    } else {
      // 还没有任何一次**有效**调用（会话刚开、或全部失败/被中断）：占用**未知**。
      // pi 这里是 `?/1.0M`，不是 `0%/1.0M` —— 后者会说谎（说“没占”）。
      parts.push(`?/${formatTokens(contextWindow)}`);
    }
  }
  return { text: parts.join(' '), warnings };
}

/**
 * 最后一次**有效** LLM 调用占掉的上下文 token 数；没有就 undefined。
 *
 * ## 三个过滤条件（照抄 pi 的 `getAssistantUsage`）
 *
 * 1. token 数 > 0 —— 没 usage 的消息（比如恢复出来的历史消息）不算。
 * 2. 不是 aborted —— 用户中断的那一轮 usage 残缺。
 * 3. 不是 error —— 失败的那轮没真正装进去。
 *
 * 从**后往前**找：最后一条有效的就是「当前上下文里有多少」。
 */
function lastContextUsage(messages: AgentState['messages']): number | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    // pi-ai 的 Message 联合里 system 消息没有 usage / stopReason 字段。
    if (!message || message.role !== 'assistant') continue;
    const usage = message.usage;
    if (!usage) continue;
    if (message.stopReason === 'aborted' || message.stopReason === 'error') continue;
    const tokens =
      usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    if (tokens > 0) return tokens;
  }
  return undefined;
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
  {
    name: 'compact',
    description: '把老对话换成一段摘要（上下文快满了时用；与 pi 同名）',
  },
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
   * 扩展的斜杠命令与快捷键（`extension-commands.ts` 造，界面读）。
   *
   * 不给 = 没装扩展：补全里没有它们，`runCommand` 不会问。
   */
  extensionCommands?: ExtensionCommands | undefined;
  /**
   * 装了哪些 pi 扩展（工具名 + 装载诊断）。
   *
   * ## 为什么也要开场报
   *
   * 与 skill 同一个道理：扩展的 prompt 片段（`promptSnippet`）在 system prompt 里，
   * 用户**看不见**。不报出来的话，一个装坏的扩展（加载失败、或工具没有
   * `promptSnippet` 因而**模型根本看不到**）就是彻底静默的 —— 而「模型静默少了
   * 能力」是最难归因的一类问题。
   *
   * 诊断**刻意显眼**（黄字）：那不是「没装某个可选功能」，而是「你以为装上了」。
   */
  extensions?: {
    tools: readonly string[];
    errors: readonly string[];
  } | undefined;
  /**
   * 扩展的 `ctx.ui` 由界面层造（它要活着的 tui 实例）。
   *
   * 内核装扩展时比这更早 —— 那时界面还没起来。所以它拿到的是**一个待填的引用**，
   * 由本函数在 tui 建好之后填上；扩展工具真被调用时读它。
   */
  publishUi?: ((options: HostUiOptions) => void) | undefined;
  /**
   * 扩展的 `before_agent_start`（可选）。
   *
   * 每轮之前调一次，让扩展有机会调工具集（第一个扩展在会话中途改不了东西，所以
   * 实际是 no-op，见 `extension-prompt.ts`）。不给就**不发**这个事件 ——
   * 本项目没有扩展时装，就不该有扩展的回调。
   */
  beforeAgentStart?: ((text?: string | undefined) => Promise<void>) | undefined;
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
 *
 * ## `.git` 有两种形状
 *
 * - **目录** —— 普通 checkout，HEAD 就在 `<cwd>/.git/HEAD`。
 * - **文件** —— linked worktree 与 submodule。里面是一行 `gitdir: <真正的 git 目录>`：
 *
 *     gitdir: C:/repo/.git/worktrees/rpiv-compat
 *
 *   HEAD 在**那个**目录里。直接把 `.git` 当目录读会抛 ENOTDIR，于是 catch 掉、
 *   返回 undefined —— 症状是底栏只剩路径、括号里的分支名**静默消失**。
 *   （实测：在 worktree 里跑 `pnpm test` 会因此挂掉两条底栏断言，而它们看起来像
 *   “界面坏了”，与真因隔了三层。）
 *
 * 读文件时必须剥掉换行再拼路径，否则拼出来的是 `...\rpiv-compat\rHEAD`。
 * git 的 `gitdir:` 指针用正斜杠（Windows 上也是），`path.resolve` 能接。
 */
export function gitBranch(cwd: string): string | undefined {
  const gitPath = path.join(cwd, '.git');
  let gitDir: string;
  try {
    const st = statSync(gitPath);
    if (st.isDirectory()) {
      gitDir = gitPath;
    } else if (st.isFile()) {
      // `gitdir: <path>`（可能带尾随换行，也可能没有）。
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitPath, 'utf8'));
      const target = m?.[1]?.trim();
      if (!target) return undefined;
      // 相对指针（子模块常见）按 `.git` 文件所在目录解；绝对路径直接用。
      gitDir = path.resolve(cwd, target);
    } else {
      return undefined;
    }
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
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
  const beforeAgentStartHook = options.beforeAgentStart;
  const cwd = options.cwd ?? process.cwd();
  // 主题**必须先于一切渲染**装上：pi 的 `theme` 是个 globalThis 上的 Proxy，
  // 没 initTheme() 时读它任何属性都抛 `Theme not initialized`。
  // 而对话区那三个官方组件（User/Assistant/ToolExecution）每一个都在 render 里读 theme。
  //
  // 为什么不能在模块顶层调：那时终端还没起来，`getTerminalTheme()` 拿不到深浅色，
  // 只能猜一个 —— 猜错就是浅色终端上出现黑底块。
  // setupTheme() 返回活着的 theme 对象（`globalThis` 上那个 Proxy）。
  // **接住返回值**（而不是另去 import `theme`）：扩展的 `ctx.ui.custom()` 要把它传给
  // 扩展自己的组件（那些组件直接调 `theme.fg(...)`），拿到 undefined 会在**渲染那一帧**
  // 抛 “cannot read property of undefined” —— 症状出现在扩展内部，与真因隔了两层。
  const theme = setupTheme();
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
  /**
   * 补全用的命令表 = 固定命令 + **skill 命令**。
   *
   * 写成函数而不是常量：skill 是装载时才有的，而补全 provider 在编辑器建好时就装上了。
   * 每次 `getSuggestions()` 现取 —— 那时读的是最新的 state（`/new` 之后换了会话也准）。
   *
   * 形状与 pi 一致：skill 叫 `skill:<name>`，描述就是它的 description（`skillCommands()`）。
   */
  const commandTable = (): SlashCommand[] => [
    ...SLASH_COMMANDS,
    ...skillCommands(stateSkills()).map(
      (c): SlashCommand => ({ name: c.name, description: c.description }),
    ),
    // 扩展的命令**追在最后**：本项目的与 skill 的排前面，扩展的排后面。
    //
    // 为什么不用 `SLASH_COMMANDS` 那份常量：扩展的命令要等 `loadExtensions()` 装载完
    // 才知道，而那可能发生在编辑器建好**之后**。所以这里现取（与 skill 同一种情况）。
    ...(options.extensionCommands?.list() ?? []),
  ];

  const base = new CombinedAutocompleteProvider(SLASH_COMMANDS, process.cwd());
  // provider 装上之后 skill 可能才被装载（或者 /new 换了会话），所以每次取建议都重建表。
  const withFreshCommands = {
    triggerCharacters: ['/', '@'],
    getSuggestions: (...args: Parameters<typeof base.getSuggestions>) =>
      new CombinedAutocompleteProvider(commandTable(), process.cwd()).getSuggestions(...args),
    applyCompletion: (...args: Parameters<typeof base.applyCompletion>) =>
      base.applyCompletion(...args),
    shouldTriggerFileCompletion: (...args: Parameters<typeof base.shouldTriggerFileCompletion>) =>
      base.shouldTriggerFileCompletion?.(...args) ?? false,
  };
  editor.setAutocompleteProvider(withFreshCommands);

  /**
   * 扩展 widget 的当前集合（key → 组件）。
   *
   * 刻意是一个**活着的 Map** 而不是一个组件：官方那套 widget 可以按 key 增删换，
   * 而我们布局里要的是「当前有哪些」。用 Map 才不用在每次 setWidget 时重建整个布局对象
   * —— 而 `applyLayout()` 每帧可能被 Ctrl+T 调，它读这个 Map 就够。
   */
  const widgetSlots = new Map<string, Component>();

  let showTrace = false;
  /**
   * 这一轮真的进了 system prompt 的 skill 清单。
   *
   * 读 `state.prompt.skills` 而不是重新扫目录：prompt 是 `prompt.init` 时定下的，
   * 之后目录变了（新增了 skill）也不会自动生效 —— 重新扫会得到一个**模型看不到**的清单，
   * 于是 `/skill:x` 展开过去模型却不认识它。
   */
  const stateSkills = (): SkillInfo[] => skillsInPrompt(store.getState());
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
  /**
   * 开场那一节（已装载的 skill 名单 / 警告）—— **常驻，永不消失**。
   *
   * 与 `notice` 分开是因为两者寿命不同：`notice` 是命令反馈（6 秒），而这一节是
   * 「本次会话装了什么」，应该像 pi 的 `loadedResourcesContainer` 那样一直在对话区顶部。
   *
   * 早先它走 `notify()` + 30 秒 —— 结果用户滚上去找刚才那条提示时它已经没了，而
   * 「我装了哪些 skill」正是需要反复对照的东西（打 `/skill:x` 时要对着名字打）。
   */
  const banner = { text: '' };
  /**
   * 已经报过一次的那次压缩（避免每帧都报一遍）。
   *
   * 为什么要单独记：`lastCompaction` 是**粘在 state 上的**（不会自动清），
   * 而这个订阅器每次 store 变化都会跑 —— 不记就变成「每次刷新都插一行」。
   */
  let lastNoticedCompaction: AgentState['lastCompaction'] = null;

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
    // banner 不过期（常驻）。
    if (notice.text !== '' && Date.now() > noticeUntil) notice.text = '';
    transcript.update(state, terminal.columns ?? 100, expanded, notice, banner);
    if (showTrace) {
      tracePanel.setText(
        state.trace.order.length === 0
          ? // 开场树是空的（**故意**的：装载节点要等第一句话才建，见 reducer 的 beginTrace），
            // 所以这句话得说清楚「不是坏了」，否则用户以为 Ctrl+T 没生效。
            dim(state.prompt.seeded ? '（发送第一条消息后这里开始记轨迹）' : '（还没有任何节点）')
          : renderColoredTree(state.trace, terminal.columns ?? 100),
      );
    } else {
      tracePanel.setText('');
    }
    tui.requestRender();
  };

  store.subscribe(() => {
    const state = store.getState();
    // 压缩中：把 loader 换成「压缩中…」—— 摘要要打一次网络，可能好几秒，
    // 而环的相位这段时间是 idle（压缩不是一轮对话），所以上面那个「环跑完收 loader」
    // 的分支根本不会触发。不给它一个指示，用户会以为按了 /compact 没反应。
    if (state.compacting && !loading) {
      loading = true;
      lastLoaderMessage = 'compact';
      loader.setIndicator({ frames: BUSY_FRAMES });
      loader.setMessage(yellow('压缩中…'));
      loader.start();
    } else if (!state.compacting && loading && lastLoaderMessage === 'compact') {
      // 压完了（或失败了）：把 loader 收掉，剩下的提示交给下面的 lastCompaction 分支。
      loading = false;
      loader.stop();
      loader.setMessage('');
      loader.setIndicator({ frames: IDLE_FRAMES });
      lastLoaderMessage = '';
    }
    // 环跑完时把 loader 收掉。
    if (state.phase === 'idle' && loading && lastLoaderMessage !== 'compact') {
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
    // 压缩跑完（或失败）：在对话区留一条**常驻**的说明。
    //
    // 为什么必须显眼：压缩是唯一会静默改写对话内容的操作——屏幕上那些用户消息
    // 并没有消失，但它们已经不在模型的上下文里了。不说出来，用户看到的下一句回答
    // 就会「凭空忘了」前面聊过的内容，而那正是最难归因的一类问题。
    const compacted = state.lastCompaction;
    if (compacted !== null && compacted !== lastNoticedCompaction) {
      lastNoticedCompaction = compacted;
      if (compacted.summarizedCount > 0) {
        banner.text =
          banner.text === ''
            ? dim(
                `[已压缩上下文] ${compactReasonText(compacted.reason)}：` +
                  `${compacted.summarizedCount} 条老对话 → 一段摘要 + ${compacted.keptCount} 条最近消息` +
                  `（之前的 ${formatTokens(compacted.tokensBefore)} 上下文已不在模型上下文里）`,
              )
            : banner.text;
      } else {
        notify(dim('没什么可压的（老对话还在保留窗口里）'));
      }
    }
    refresh();
  });

  // 显式标出回调参数类型：1.x 的 TuiInputListener 是具名类型，不再从上下文推断。
  const onInput: TuiInputListener = (data: string) => {
    /** 内置的三个开关键。返回 true = 已消费。 */
    const builtins = (): boolean => {
      if (matchesKey(data, 'ctrl+c')) {
        if (store.getState().phase !== 'idle') {
          abortRun();
          return true;
        }
        tui.stop();
        process.exit(0);
      }
      // Ctrl+T：切换轨迹面板。底部要放哪些组件变了，布局必须跟着重设。
      if (matchesKey(data, 'ctrl+t')) {
        showTrace = !showTrace;
        applyLayout();
        refresh();
        return true;
      }
      // Ctrl+O：展开/收起工具输出的完整内容。与 pi 同键。
      if (matchesKey(data, 'ctrl+o')) {
        expanded = !expanded;
        refresh();
        return true;
      }
      return false;
    };

    // **顺序即优先级**：内置的先跑，扩展的键只在它们**没**消费时才算。
    //
    // 为什么内置优先：它们是本项目的开关（轨迹面板 / 工具输出 / 中断），被扩展抢走
    // 的话界面看着「按了没反应」，而那比「扩展的键偶尔不生效」难查得多。
    //
    // 为什么扩展的**先问**（而不是内置消费掉就完全不问）：`handleKey` 内部也会调
    // `builtins()` —— 那样就会跑两遍，于是 `Ctrl+T` 切换**两次**（等于没切）。
    // 所以这里先自己跑一遍，**已经消费就不再问扩展**。
    if (builtins()) return { consume: true };

    if (options.extensionCommands) {
      // 扩展的 handler 可能是 async（它会弹对话框），而输入监听器是**同步**回调 ——
      // 在这里 await 就是等一个要人来点的窗口，会把输入队列堵住。
      // 所以不消费这个键（返回 undefined，让按键继续往编辑器走），只把 handler 排出去。
      void options.extensionCommands
        .handleKey(data, () => false)
        .catch((error: unknown) => {
          notify(yellow(`扩展快捷键出错：${error instanceof Error ? error.message : String(error)}`));
        });
    }
    return undefined;
  };
  tui.addInputListener(onInput);

  editor.onSubmit = (rawText: string) => {
    const input = rawText.trim();
    if (!input) return;
    // 斜杠命令：不发给模型。
    if (input.startsWith('/')) {
      // **`/skill:name` 不是命令**，它要展开成 `<skill>` 块发给模型 ——
      // 与 pi 一致（它的 `_expandSkillCommand()` 在 prompt 里展开，不走命令表）。
      // 所以先问一句「是不是 skill」，不是才当命令处理。
      if (expandSkillCommand(input, stateSkills()).startsWith('<skill ')) {
        if (store.getState().phase !== 'idle') {
          notify(yellow('上一回合还没结束（Ctrl-C 可中断）'));
          return;
        }
        send(expandSkillCommand(input, stateSkills()));
        return;
      }
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
      case 'skills': {
        // 列出这一轮真的进了 prompt 的 skill（不是磁盘上全部）。
        //
        // 为什么只报「进了 prompt 的」：`/skill:x` 展开后模型能不能用，取决于清单里有没有它。
        // 报磁盘上的全集会骗人 —— 那些被 `disable-model-invocation` 挡住的、或者 prompt
        // 还没重装的，看着能调用，实际模型不知道它们存在。
        const skills = stateSkills();
        if (skills.length === 0) {
          notify(
            dim(
              '没找到 skill。放 ~/.pi/agent/skills/<名字>/SKILL.md 或 <工作目录>/.pi/skills/…，' +
                '然后 /new 换个会话（system prompt 在装载时定下，重开一卷才生效）。',
            ),
          );
          return;
        }
        notify(
          skills
            .map(
              (s) =>
                `${cyan(s.name)}${dim(`（${s.scope}）`)} ${dim(s.description)}\n${dim('  ' + s.filePath)}`,
            )
            .join('\n') +
            `\n${dim(`用 /skill:${skills[0]?.name ?? '<名字>'} [你的问题] 调用；清单已进 system prompt。`)}`,
        );
        return;
      }
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
      case 'compact': {
        // 压缩要**整份换掉** messages，所以环在跑时绝不能做：
        // 那条还在等 token 的流回来时会认不出自己的上下文，而正在跑的
        // toolResult 会找不到它的 toolCall（消息序列直接变成非法的）。
        if (store.getState().phase !== 'idle') {
          notify(yellow('上一回合还没结束，等它跑完再压缩'));
          return;
        }
        if (store.getState().compacting) {
          notify(yellow('正在压缩中（摘要要打一次网络）'));
          return;
        }
        store.dispatch({ type: 'compact.request', reason: 'manual' } as AgentAction);
        // 不在这里报「已开始」：结果由 `compact.done` / `compact.failed` 回到状态里，
        // 那时才说「压掉了多少」。先报一句「开始了」再报一句「压了多少」是重复，
        // 而且失败时用户会同时看到两条矛盾的话。
        refresh();
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
        // 念同一份命令表 —— 手抄一份迟早会和补全列表漂移。
        notify(
          commandTable().map(
            (c) =>
              `${bold(`/${c.name}`)}${' '.repeat(Math.max(1, 10 - c.name.length))}${c.description ?? ''}`,
          ).join('\n'),
        );
        return;
      default:
        // 扩展的命令在**最后**试：内置的与 skill 的优先（skill 走上面的分支）。
        if (options.extensionCommands?.has(name)) {
          void options.extensionCommands.run(name, arg).catch((error: unknown) => {
            notify(yellow(`/${name} 出错：${error instanceof Error ? error.message : String(error)}`));
          });
          return;
        }
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
    // `before_agent_start` 在**发出去之前**调（与 pi 同序）：扩展看到的是「用户刚说了
    // 什么、即将开跑」这个时刻。
    //
    // **不 await**：那个事件在本项目里是 no-op（工具集不中途变），而 await 会把
    // 「敲回车」到「界面开始转圈」之间插入一段不可中断的等待。将来真要采信它的时候
    // 改成 `void (async () => { await …; store.dispatch(...) })()` —— 注意那时
    // `user.message` 必须**在** await 之后，否则时序反了。
    void beforeAgentStartHook?.(text);
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
      // 扩展的 widget（`pi-web-access` 的活动面板用它）。**不给 basis** ——
      // 给了就把高度钉死，面板里的内容一变就错位（同上面那三个的理由）。
      ...[...widgetSlots.values()].map((component) => ({ component, minSize: 1 })),
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

  // 把活着的界面交给扩展宿主：内核装扩展时界面还没起来（那时只拿到一个待填的引用），
  // 现在 tui / theme / raw input 都有了，扩展的 `ctx.ui.custom()` 才能真的画出东西。
  //
  // **必须在 `tui.start()` 之后**：`showOverlay` 要一个正在跑的 TUI（它会写终端转义
  // 序列、重画栈）。之前填就等于扩展一开对话框就崩。
  options.publishUi?.({
    tui,
    theme,
    addInputListener: (listener) => tui.addInputListener(listener),
    onNotice: (text: string) => notify(text),
    /**
     * 扩展的 widget 槽（`setWidget` 的落点）。
     *
     * 位置：**输入区上方**（官方默认的 `aboveEditor`）。那里本来就是底部 VStack 的
     * 一格，不需要新机制 —— 难的是**布局要跟着重设**：VStack 的 children 是建的时候
     * 定下的，所以增删一个 widget 就得重新 `setLayoutRoot`（`applyLayout` 干这个）。
     *
     * 按 key 存：同一个 key 重复 set 就是替换（官方的语义），不同 key 叠成多块。
     * 换掉旧的要 `dispose()` 旧的 —— 否则扩展的 widget 里的定时器/监听器会一直活着。
     */
    setWidget: (key, component, opts) => {
      const previous = widgetSlots.get(key);
      if (previous && previous !== component) {
        try {
          (previous as { dispose?: () => void }).dispose?.();
        } catch {
          // 旧 widget 的 dispose 失败不该挡住新 widget 上场。
        }
      }
      if (component === undefined) widgetSlots.delete(key);
      else widgetSlots.set(key, component);
      void opts;
      // 布局的 children 变了 —— 必须重设，否则新 widget 不出现/旧的赖着不走。
      applyLayout();
      refresh();
    },
  });

  // 开场报一下装了哪些 skill —— 与 pi 同形（`[Skills]` 一节，逗号分隔的名字）。
  //
  // 为什么值得占这几行：skill 的全部意义在于「模型知道自己能做什么」，而清单在
  // prompt 里是**看不见的**。不报出来，用户既不知道有哪些 skill 可用，也不会想到打
  // `/skill:<名字>` —— 于是这功能等于没装。
  //
  // 形状照 pi：折叠成一逗号分隔的名字（55 个 skill 铺开会把对话区冲走）；Ctrl+O
  // 已经是「展开工具输出」，这里不复用它 —— 名字一行本来就不长。
  const startupSkills = stateSkills();
  const startupDiagnostics = store.getState().prompt.skillDiagnostics ?? [];
  const extensionNames = (options.extensions?.tools ?? []).slice().sort((a, b) => a.localeCompare(b));
  const extensionErrors = options.extensions?.errors ?? [];
  // 护栏要把扩展也算进去：只装了扩展没装 skill（或反过来）时，这一节**照样**要出。
  // 早先写成只看 skill，于是「一个 skill 都没装」的用户永远看不到扩展清单 ——
  // 而那恰好是最需要看到的人（他们不靠 skill，只靠扩展）。
  if (
    startupSkills.length > 0 ||
    startupDiagnostics.length > 0 ||
    extensionNames.length > 0 ||
    extensionErrors.length > 0
  ) {
    const lines: string[] = [];
    if (startupSkills.length > 0) {
      // 形状照 pi 的 `formatCompactList()`：**排序**后逗号连排，剩下交给终端折行。
      // 不排序的话清单顺序取决于目录遍历，每次启动都不一样。
      // 55 个名字折成十几行是正常的（pi 的截图里也是 6 行）—— 不截断：
      // 名字列表的价值就在于能扫到某一个。
      const names = startupSkills.map((s) => s.name).sort((a, b) => a.localeCompare(b));
      lines.push(`${dim('[Skills]')}\n${dim(names.join(', '))}`);
    }
    // 与 pi 同形（截图里的 `[Skill conflicts]`）：加载不上的 skill 要看得见 ——
    // 否则就是「模型静默少了能力」，而用户与界面都不知道为什么。
    if (startupDiagnostics.length > 0) {
      lines.push(
        `${yellow('[Skill 警告]')}\n` +
          startupDiagnostics.map((d) => yellow(`  ${d}`)).join('\n'),
      );
    }
    // **常驻**（不靠 notify）：pi 的开场那一节也是 `loadedResourcesContainer` 里的
    // 常驻组件，永不消失。skill 名单要反复对照着打 `/skill:x`，30 秒后就没了等于没有。
    if (extensionNames.length > 0) {
      // 与 `[Skills]` 同一个形状：逗号分隔的名字。
      lines.push(`${dim('[扩展]')}\n${dim(extensionNames.join(', '))}`);
    }
    if (extensionErrors.length > 0) {
      lines.push(
        `${yellow('[扩展警告]')}\n` + extensionErrors.map((e) => yellow(`  ${e}`)).join('\n'),
      );
    }
    banner.text = lines.join('\n\n');
    refresh();
  }
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

/**
 * Skill 块：`/skill:<name>` 展开出来的那一段 `<skill …>…</skill>`。
 *
 * 用 pi 官方的 `SkillInvocationMessageComponent`（与 `parseSkillBlock()` 同源）——
 * 折叠态是「[skill] name」一行，Ctrl+O 展开是全文。形状与官方一致，不自己画。
 *
 * 认不出来就画普通用户消息（不是 `[]`）：宁可多显示一点，也不要把内容吞掉。
 */
function renderSkillBlock(text: string, width: number, expanded: boolean): string[] {
  const block = parseSkillMessage(text.trim());
  if (!block) return renderUser(text, width);
  const component = new SkillInvocationMessageComponent(block, getMarkdownTheme());
  component.setExpanded(expanded);
  return component.render(usableWidth(width));
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
 * 用户消息**上面**那一行空隙（非首条时才有）。
 *
 * ## 为什么必须自己插
 *
 * `UserMessageComponent` 的 `paddingY=1` 确实会产生两行空白，但它们是**带蓝底**的
 * （pi-tui 的 `Markdown.render` 里 `emptyLines` 走 `applyBackgroundToLine`）——
 * 蓝块往上多出一行同色边，而上面那行本身是满宽的，于是蓝块与上一条内容之间
 * 看不到任何空隙。实测就是「工具调用之间都有间隔，用户的蓝块却直接贴上来」。
 *
 * 助手块 / 工具块的空行是**无底色**的，所以那些地方本来就是真空隙 —— 不一致就在这里。
 *
 * ## 与 pi 一致
 *
 * `interactive-mode.js` 的 `addMessageToChat`：
 *
 *     case "user":
 *         if (this.chatContainer.children.length > 0) this.chatContainer.addChild(new Spacer(1));
 *         this.chatContainer.addChild(new UserMessageComponent(...));
 *
 * 即非首条才插。我们没有 `children.length` 可看，用「已经有内容画上去了」（`at > 0`）
 * 等价 —— 首条消息前面不需要空隙。
 *
 * @param at 这条消息之前已经画了多少行（用来判断是不是首条）
 */
function userSpacer(message: { role: string }, at: number): string[] {
  return message.role === 'user' && at > 0 ? [''] : [];
}

/**
 * 渲染**正在跑**的工具（`toolResult` 消息还没有，但工具已经开跑了）。
 *
 * ## 为什么这里有东西可画
 *
 * 一个长命令（`npm install`、带 sleep 的脚本、编译）在跑的时候：
 *   - `state.messages` 里**还没有** `toolResult`（那要等它跑完）；
 *   - `state.executing` 里有那条调用，`state.toolProgress` 里有官方工具边跑边送出来的输出。
 *
 * 早先只看 `messages`，于是工具一开跑就**什么都不显示** —— 用户看到光标在那儿闪，
 * 而工具块要等命令结束才突然出现。几十秒的空白与「卡死了」在屏幕上没有区别。
 *
 * ## `isPartial: true` 让官方渲染器接管「进行中」的样子
 *
 * 不自己画半成品：pi 的 bash 渲染器拿到 `isPartial` 就会
 *   - 把底色换成 `toolPendingBg`（而不是成功/失败色）；
 *   - 把底部那行从 `Took` 换成 `Elapsed`，并起一个 1s 定时器让秒数跳；
 *   - 接受**不完整**的输出（末尾不会被当成「截断」）。
 *
 * 这些细节手写要对齐一堆，所以直接用它的（见 `renderTool` 的同类注释）。
 *
 * @returns 行；工具没在跑（还没有任何输出）时返回空数组。
 */
function renderRunningTool(
  state: AgentState,
  call: ToolCall,
  width: number,
  expanded: boolean,
): string[] {
  const progress = state.toolProgress?.[call.id];
  if (progress === undefined) return [];
  const component = new ToolExecutionComponent(
    call.name,
    call.id,
    (call.arguments ?? {}) as Record<string, unknown>,
    { showImages: false, imageWidthCells: usableWidth(width) },
    TOOL_RENDERERS[call.name] as never,
    TOOL_UI as never,
    process.cwd(),
  );
  // markExecutionStarted 必须在 updateResult **之前**：官方 bash 渲染器的
  // `renderResult` 靠它记下的 startedAt 才能起那个计秒定时器（否则 `Elapsed` 永远是 0s）。
  component.markExecutionStarted();
  component.setArgsComplete();
  component.setExpanded(expanded);
  // isPartial = true → 官方切到「进行中」渲染：pending 底色、接受不完整的输出。
  // `isError: false`（还不知道结果），content 是当前已有的那部分输出。
  component.updateResult(
    {
      content: progress.content.map((c) =>
        c.type === 'text'
          ? { type: 'text', text: c.text }
          : { type: 'image', data: c.data, mimeType: c.mimeType },
      ),
      details: undefined,
      isError: false,
    },
    true,
  );
  const lines = component.render(usableWidth(width));
  // **收尾：停掉官方渲染器的计秒定时器。**
  //
  // 官方 bash 渲染器看到 `isPartial` 会 `setInterval(..., 1000)` 让 `Elapsed` 自己跳，
  // 而它只在**同一个组件**收到非 partial 的 `updateResult` 时才 clearInterval。
  // 我们每帧新建一个用完就扔的组件，于是没有任何一次「收尾」到来 ——
  // 每渲染过一个正在跑的工具块就留下一个永久 interval，事件循环永远不空。
  // 实测：进程渲染过一次就不会退出（得 timeout 才杀得掉）。这正是加这行的原因。
  //
  // **代价**：`Elapsed` 不再每秒自己跳，而是**跟着输出更新**。对「边跑边有输出」的
  // 命令（`npm install`、`ls -R`、带 sleep 的脚本）没差别；对「长时间完全没有输出」
  // 的命令，那几十秒里秒数会停着不动 —— 而那种命令屏幕上本来什么也不变，
  // 用户要判断的也正是「它还有没有在动」（屏幕上仍然挂着命令与已有的输出）。
  //
  // 想把跳秒也拿回来，就得让组件跨帧活着（pi 自己的做法），而那要求对话区不再按
  // 「字符串块」缓存 —— 那是 O(N²) → O(N) 那个优化的倒退，不划算。
  stopRendererTimers(component);
  return lines;
}

/**
 * 停掉官方渲染器在 `rendererState` 里留下的定时器。
 *
 * ## 判据为什么用 `unref`
 *
 * `setInterval` 在 Node 里返回 `Timeout` 对象，在浏览器里返回数字；两边都能安全
 * `clearInterval`，但 `instanceof` 只认 Node 那个类。而「有 `unref` 方法」恰好是
 * Node 定时器的标志 —— 一个普通对象恰好也有 `unref` 方法的概率低到可以忽略，
 * 所以这个判据比认类可靠。
 *
 * ## 为什么还要置回 undefined
 *
 * 官方渲染器靠这个字段判断「定时器已经在了」（`!state.interval` 才起新的）。
 * 清掉 interval 却留着真值的话，下一帧会以为不用再起 —— 而那个已经不存在了。
 */
function stopRendererTimers(component: ToolExecutionComponent): void {
  const state = (component as unknown as { rendererState?: Record<string, unknown> })
    .rendererState;
  if (state === undefined) return;
  for (const [key, value] of Object.entries(state)) {
    if (value === null || typeof value !== 'object') continue;
    const handle = value as { unref?: () => void };
    if (typeof handle.unref !== 'function') continue;
    clearInterval(value as Parameters<typeof clearInterval>[0]);
    handle.unref();
    state[key] = undefined;
  }
}

/**
 * 某条消息之后要额外画的**正在跑的工具块**。
 *
 * ## 为什么要跟着某条消息画，而不是单独一块
 *
 * 工具块在对话流里**位置固定**：紧跟在发起它的那条 assistant 消息后面（协议要求
 * 每个 toolCall 后紧跟它的 toolResult）。所以把它算作那条消息的一部分 ——
 * 于是增量渲染的缓存仍然有效（历史块命中缓存），而不是每帧重建整个工具区。
 *
 * 只画 `executing` 里的那些：工具结束后 `tool.result` 会把终值写进 `messages`，
 * `executing` 里就不再有它，于是不会与最终的 toolResult 块重复。
 */
function runningToolsAfter(state: AgentState, message: { role: string }): ToolCall[] {
  if (message.role !== 'assistant') return [];
  // `executing` 理论上总是数组（createInitialState 会给），但测试里手造的 state 可能没填。
  // 不写成 `state.executing.length === 0` 而是在这里兜 —— 这个函数会在**每一帧**对
  // 每条消息调一次，一个 undefined 就是整个界面崩。
  const executing = state.executing ?? [];
  if (executing.length === 0) return [];
  const ids = new Set(toolCallIdsOf(message as unknown as { content: unknown[] }));
  return executing.filter((t) => ids.has(t.call.id)).map((t) => t.call);
}

/** 从一条 assistant 消息里取 toolCallId（给上面的位置判断用）。 */
function toolCallIdsOf(message: { content: unknown[] }): string[] {
  const ids: string[] = [];
  for (const block of message.content) {
    const c = block as { type?: string; id?: string };
    if (c.type === 'toolCall' && typeof c.id === 'string') ids.push(c.id);
  }
  return ids;
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
    // **`/skill:x` 展开出来的那一段**画成可折叠的 skill 块，而不是蓝底用户消息 ——
    // 它是「参考资料」而不是「人说的话」。形状与 pi 一致（同一个 SkillInvocationMessageComponent）。
    if (text.startsWith('<skill ')) return renderSkillBlock(text, width, expanded);
    return renderUser(text, width);
  }
  if (message.role === 'assistant') {
    // 助手消息：**只有可见内容才占行**。一条纯 toolCall 的消息如果硬渲染会得到
    // 一段空白（Markdown 组件对空文本返回 []），而它紧跟着就有工具块要画。
    //
    // 后面接上「正在跑的工具」：那些工具还没产出 toolResult，所以它们的块
    // 只能在这里画（位置也正好：紧跟发起它的那条消息）。
    const running = runningToolsAfter(state, message);
    const lines = renderAssistant(message.content, width);
    for (const call of running) {
      lines.push(...renderRunningTool(state, call, width, expanded));
    }
    return lines;
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
  /** 开场那节（常驻，永不消失）—— 与 6 秒的 notice 分开。 */
  private readonly bannerBlock: Text;
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
  private lastBanner = '';
  private lastStream = '';
  private lastTail = '';

  constructor() {
    this.noticeBlock = new Text('', 0, 0);
    this.bannerBlock = new Text('', 0, 0);
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
  update(
    state: AgentState,
    width: number,
    expanded: boolean,
    notice: { text: string },
    banner?: { text: string },
  ): void {
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
      this.bannerBlock,
      'banner',
      banner?.text === '' || banner === undefined ? '' : `${banner.text}\n`,
      banner?.text ?? '',
    );
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
  private setIfChanged(block: Text, slot: 'notice' | 'banner' | 'stream' | 'tail', text: string, identity: string): void {
    if (this.lastOf(slot) === identity) return;
    this.remember(slot, identity);
    block.setText(text);
  }

  private lastOf(slot: 'notice' | 'banner' | 'stream' | 'tail'): string {
    return slot === 'notice' ? this.lastNotice : slot === 'banner' ? this.lastBanner : slot === 'stream' ? this.lastStream : this.lastTail;
  }

  private remember(slot: 'notice' | 'banner' | 'stream' | 'tail', value: string): void {
    if (slot === 'notice') this.lastNotice = value;
    else if (slot === 'banner') this.lastBanner = value;
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
    // 带「正在跑的工具」的那个块**不进缓存**。
    //
    // 缓存键是消息对象（+ 宽度与折叠），而正在跑的工具输出在变、发它的那条 assistant
    // 消息却**不变**（它早就进 messages 了）—— 于是缓存会一直命中，流式输出永远不更新，
    // 症状就是「命令在跑但屏幕不动，跑完突然全部出现」。
    //
    // 不缓存的成本可以忽略：这样的块**至多一个**（一轮里在跑的工具都跟着同一条消息），
    // 而它本来就在每帧重算。
    const isLive = runningToolsAfter(state, message).length > 0;
    const cached = isLive
      ? [
          ...userSpacer(message, index),
          ...renderMessage(state, message, width, expanded),
        ]
      : this.chunkLines(message, key, () => [
          ...userSpacer(message, index),
          ...renderMessage(state, message, width, expanded),
        ]);
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
    lines.push(...this.bannerBlock.render(at));
    for (const block of this.blocks) lines.push(...block.render(at));
    lines.push(...this.streamBlock.render(at));
    lines.push(...this.tail.render(at));
    return lines;
  }

  invalidate(): void {
    for (const block of this.blocks) block.invalidate();
    this.noticeBlock.invalidate();
    this.bannerBlock.invalidate();
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
  // `offset` 跟着实际插进去的行数走 —— 用户消息前面多了一行空隙，下标才不会错位。
  let offset = lines.length;
  for (let i = from; i < state.messages.length; i += 1) {
    const message = state.messages[i];
    if (!message) continue;
    lines.push(...userSpacer(message, offset));
    lines.push(...renderMessage(state, message, width, expanded));
    offset = lines.length;
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
