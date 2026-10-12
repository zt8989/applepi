/**
 * 终端界面 —— pi-tui（差分渲染的 TUI 库）驱动，环仍然只由本项目的 Redux Loop 跑。
 *
 * 这个文件不含任何环的逻辑：它只是订阅 store，把状态画出来。
 * 界面是**整页切换**的两块（中间那块按 `page` 换内容）：
 *
 *   - 对话页：用户说了什么、LLM 答了什么、工具做了什么（按消息流渲染）
 *   - 轨迹页（默认 Ctrl+R 切换，键位可改）：**像 git log --graph 一样的一次尝试一节点的树**
 *     失败/超时也在上面，是一层能展开的节点，不是飘在下面的一行红字。
 *
 * 顶行是**页签 + 轨迹统计合一行**（`tabLine`），底栏两行是 cwd / 用量 + 模型。
 *
 * pi-tui 的好处是差分渲染：流式 token 一个个进来时只重画变化的那几行，
 * 不会整屏闪烁 —— 这对一个一直在吐 delta 的 agent 界面很关键。
 */
// pi-tui 1.x：`TUI` 是共享**接口**，实例化要选具体渲染器。
// TuiAltScreen  = 真正的全屏：占满视口，终端不留回滚缓冲，界面自己管滚动。
// TuiMainScreen = 让出回滚缓冲（内容永久留在终端历史里，能往上翻）。
// 对话式 agent 用前者：输入框要钉在底部、对话区独立滚动，滚出去的内容不该污染终端回滚。
import {
  ProcessTerminal,
  Text,
  ScrollView,
  TuiAltScreen,
  VStack,
  matchesKey,
  isKeyRelease,
  CombinedAutocompleteProvider,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
  type SlashCommand,
  type ViewportTUI,
  type TuiInputListener,
} from '@earendil-works/pi-tui';
import { abortRun } from '../run-control';
import { renderTree, traceStats, formatDuration, type TraceNode, type TraceTree } from '../trace';
import { compactReasonText } from '../compact';
import type { AgentState, QueuedInput, QueueKind } from '../state';
import type { AgentStore } from '../store';
import type { AgentAction } from '../actions';
import type { ToolCall } from '@earendil-works/pi-ai';
import { cleanSessionsExcept, listSessions, findSessionFile, resumeCommand, type SessionSummary } from '../config-home';
import { deleteSessionTrace, loadSessionMessages, openSessionPicker } from './session-picker';
import { FOOTER_ROWS } from './composer-overlay';
import {
  openModelPicker,
  openScopedModelsPicker,
  modelRuntimeFor,
} from './model-picker';
import { NO_SCOPE, readScopedModels, writeDefaultModel, type ModelScope, type ScopedModelItem } from '../model-scope';
import type { AgentRuntime } from '../provider';
import type { Model } from '@earendil-works/pi-ai';
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
import { getMarkdownTheme, getEditorTheme } from '@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';// pi 底栏的官方实现（靠 pnpm patch 打开的子路径）。数字格式与算法都与 pi 一致 ——
// 两边对不上会让人以为算错了。
// 见 docs/architecture/provider.md「为什么要 pnpm patch」。
import { formatCwdForFooter, formatTokens } from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js';
// composer 直接用官方那个会把工作状态画进**上框线**的编辑器（与 pi 同形）。
// 为什么不是自己给 pi-tui 的 `Editor` 加个 setter：那段边框排版（状态 + 滚动指示
// `↑ N more` 抢位置、窄终端退化成只画转圈）是 pi 踩过的，复刻必然漂移。
import { CustomEditor } from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-editor.js';
import {
  WorkingStatusIndicator,
  type StatusIndicator,
} from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/status-indicator.js';
import { addUsageToTotals, createUsageTotals } from '@earendil-works/pi-coding-agent/dist/core/usage-totals.js';
import { setupTheme } from './theme';
import { actionMatches, installProjectKeybindings, keyLabel } from './keybindings';
import { hotkeysMarkdown, renderHotkeys } from './hotkeys';
import { contextLabels, extensionLabels } from './resource-labels';
import { contextFilePaths } from '../system-prompt';
import type { HostUiOptions } from '../extension-ui';
import type { ExtensionCommands } from '../extension-commands';
import type { ExtensionEntry } from '../extension-host';
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
    // turn 与 step 都是**容器**（它们不推进 tip，里面才是发生的事）。
    // 都给暗色：容器是结构，不是事件 —— 给亮色会在树上凭空多出几条抢注意力的大块。
    // pending 时也还是暗色：容器开着不代表出错，闭合状态由它里面的 result/error 表达。
    case 'turn.start':
      return dim;
    case 'turn.end':
      return dim;
    case 'step.start':
      return node.status === 'error' ? red : dim;
    case 'step.end':
      return node.status === 'error' ? red : dim;
    case 'llm.result':
      return green;
    case 'tool.call':
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
 * 轨迹面板：**一个节点一个块**的增量渲染。
 *
 * ## 为什么不用一块 `Text` 画整棵树
 *
 * 早先 `tracePanel` 是 `new Text('', 0, 0)`，每帧 `setText(renderColoredTree(整个树))`。
 * 两个后果，第二个是用户直接抱怨的那个：
 *
 * 1. **每帧重算整棵树**。流式 token 每来一个就触发一次 `refresh()`，于是 200 个节点
 *    的树每秒重算几十次（实测单次 4~6ms，而一个长工具输出能刷几百帧）。
 * 2. **节点多了看不见后面的**。`Text` 高度就是内容高度，被布局裁掉的部分**永远回不来** ——
 *    面板既不滚动也没有分页，于是「一开始只能看到最前面的，后面就看不到，滚也滚不动」。
 *
 * 这里改成与对话区**同构**的形状（`TranscriptChunks` 就是这个套路）：
 *
 * - 每个节点一个 `Text`，下标与 `tree.order` 一一对应；
 * - 只在**那个节点的**内容真变了才 `setText`（追加式：新节点只算自己那几个）；
 * - 外层包 `ScrollView`，`follow: 'end'` —— 新节点往下追加，视口自动贴底；
 * - 节点变少（`/new`、恢复别的会话）就把多余的块丢掉，否则旧节点还画在屏幕上。
 *
 * ## 为什么不能用 pi 官方的 `CollapsibleRender`
 *
 * 轨迹是**时间线**，不是可折叠的树：关掉一个节点不该让它的子节点消失（那是 pi 渲染
 * `entry_appended` 那类内容的形状）。这里要的只是「按块增量 + 可滚动」。
 */
export class TraceChunks implements Component {
  /** 每个节点一个 `Text`，下标与 `tree.order` 一一对应。 */
  private readonly blocks: Text[] = [];
  /** 每个块上次 `setText` 的内容 —— 「变没变」的判据。 */
  private readonly lastTexts: (string | undefined)[] = [];
  /** 宽度变了要清折行缓存（`Text` 按宽度分桶缓存）。 */
  private lastWidth = 0;
  /** HEAD 那一行（树的落点）单独一块：它不是节点，但每次 tip 变都要更新。 */
  private readonly headBlock = new Text('', 0, 0);
  private lastHead = '';
  /** 空树时显示的那句（开场就空着，得说清楚「不是坏了」）。 */
  private emptyText = '';

  /**
   * 同步到最新状态。**只算变化的那几个节点。**
   *
   * @param emptyText 树还是空的时候显示什么（开场那句「发送第一条消息后…」）
   */
  update(tree: TraceTree, width: number, emptyText: string): void {
    const widthChanged = width !== this.lastWidth;
    this.emptyText = emptyText;
    const order = tree.order;
    // 节点变少（/new、恢复别的会话、树被重建）：把多余的块**丢掉**。
    //
    // 为什么不能只跳过：`render()` 遍历的是 `this.blocks` 全部元素，而它与 order 等长
    // 只在「节点只增不减」时成立。留着的话 /new 之后旧节点还画在屏幕上。
    if (this.blocks.length > order.length) {
      this.blocks.length = order.length;
      this.lastTexts.length = order.length;
    }
    for (let i = 0; i < order.length; i += 1) {
      const id = order[i];
      const node = id === undefined ? undefined : tree.nodes[id];
      if (node === undefined) continue;
      const line = this.lineOf(node, tree, width);
      let block = this.blocks[i];
      if (block === undefined) {
        // **必须新建而不是复用**：pi-tui 的布局按「组件对象 + 宽度」缓存
        // （layout.js 的 renderCached），复用旧对象才能让历史块在后续帧里跳过重算。
        block = new Text('', 0, 0);
        this.blocks[i] = block;
        this.lastTexts[i] = undefined;
      }
      if (this.lastTexts[i] !== line) {
        block.setText(line);
        this.lastTexts[i] = line;
      } else if (widthChanged) {
        // 只变宽：**不能 setText**（内容没变，setText 是白做），但块里按宽度分桶的
        // 折行缓存要清掉。用 invalidate() 而不是 setText(同一份)：后者会让下一帧
        // 看起来「内容变了」，多一次无谓的重建。
        block.invalidate();
      }
    }
    // 空树时给一句说明，而不是留一个 0 高的块（0 高度会让整块在布局里消失，
    // 于是「按了切页键没反应」与「面板塌了」看起来一模一样）。
    if (order.length === 0) {
      if (this.lastHead !== emptyText) {
        this.headBlock.setText(dim(emptyText));
        this.lastHead = emptyText;
      }
    } else {
      const tip = tree.tipId === null ? '' : `${bold('HEAD')} → ${tree.tipId}`;
      if (this.lastHead !== tip) {
        this.headBlock.setText(tip);
        this.lastHead = tip;
      }
    }
    this.lastWidth = width;
  }

  /**
   * 给布局用的 `Component` 实现（`ScrollView` 吃的就是它）。
   *
   * ## 为什么用 `lastWidth` 而不是传入的 `width`
   *
   * 每一行的 `Text` 是在 `update()` 时**按那个宽度** `setText` 的。拿另一个宽度去
   * `render()` 就会把按 40 列排好的行按 120 列再折一次 —— 结果是每行后面挂着一截
   * 空白，行数凭空翻倍（与 `TranscriptChunks` 同一个坑）。
   */
  render(width: number): string[] {
    const at = this.lastWidth > 0 ? this.lastWidth : width;
    const lines: string[] = [];
    for (const block of this.blocks) lines.push(...block.render(at));
    lines.push(...this.headBlock.render(at));
    return lines;
  }

  invalidate(): void {
    for (const block of this.blocks) block.invalidate();
    this.headBlock.invalidate();
  }

  /**
   * 一个节点那一行的**带色**文本。
   *
   * 刻意**不**调 `renderTree`：那个函数是「整棵树一坨字符串」的形状（它要算全树的缩进），
   * 而这里要的是「这一行自己什么样」。两者共用 `nodeColor` 与节点标签，
   * 所以命令行里看到的树与界面里看到的仍然是同一份逻辑。
   */
  private lineOf(node: TraceNode, tree: TraceTree, width: number): string {
    const mark = statusMarkOf(node);
    const color = nodeColor(node);
    const elapsed = node.endedAt === null ? '' : ` ${formatDuration(node.endedAt - node.createdAt)}`;
    const meta = metaSuffixOf(node);
    const text = `${mark} ${node.id} ${node.kind}: ${node.label}${elapsed}${meta}`;
    const line = truncateToWidth(text, width);
    // 失败的节点加粗，视觉上更跳一点（与 renderColoredTree 同一口径）。
    return node.status === 'error' ? bold(color(line)) : color(line);
  }
}

function statusMarkOf(node: TraceNode): string {
  switch (node.status) {
    case 'ok':
      return '✓';
    case 'error':
      return '✗';
    case 'aborted':
      return '⊘';
    case 'pending':
      return '·';
  }
}

function metaSuffixOf(node: TraceNode): string {
  if (!node.meta) return '';
  const entries = Object.entries(node.meta);
  if (entries.length === 0) return '';
  return ` (${entries.map(([k, v]) => `${k}=${v}`).join(', ')})`;
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
        /^(.*?)(n\d+) (llm\.attempt|llm\.result|tool\.call|tool\.result|user|error|stop|compact|prompt\.base|prompt\.tools|prompt\.segment|prompt\.skills|model\.init):/.exec(
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
 * 顶行：页签 + 轨迹统计（**兼两职**，刻意压成一行）。
 *
 * ## 形状
 *
 * ```
 * 对话 │ 轨迹 3轮2步  工具5  重试1  错误1 (Ctrl+R)
 * ```
 *
 * - 「对话 / 轨迹」当前页加粗高亮，旁边写切换键（否则得另找地方说「按哪个键能切」）。
 *   那个键名来自 `app.trace.toggle`（可用 `~/.pi/agent/keybindings.json` 改），
 *   所以改名之后这一行跟着变 —— 手写 `'Ctrl+R'` 迟早会开始骗人。
 * - 统计是**精简后的**：回合与步数合成 `x轮x步`（两个都是「事件次数」的口径，
 *   连读不歧义 —— 「3 轮 2 步」= 三次用户输入、两次 LLM 往返），工具/重试/错误
 *   非 0 才出现。
 * - 统计**始终显示**（不管在对话页还是轨迹页）：这轮跑到哪了是「读对话」时就想要的信息，
 *   不该逼用户切页才看得到。
 *
 * ## 为什么不再有独立顶栏
 *
 * 原来顶栏独占一行（轨迹统计），紧跟着下面还有一行页签 —— 两行都在讲同一件事
 * （「我在哪页 / 这轮跑到哪了」），纵向各白占一行，而界面真正缺的是对话的高度。
 * 合成一行后：那行要么讲页签要么讲统计，不讲别的。
 *
 * 节点数也删了：它是 `trace.order.length`，**开一轮就 +5**（user / turn.start /
 * step.start / llm.attempt / …），跳得又快又不 actionable —— 要看节点数切到轨迹页。
 * 花费 `$` 一并删掉：底栏 statsLine 里已有一个**同口径**的会话累计 `$`，两个 `$`
 * 摆在两行里只会让人怀疑「这俩为什么不一样」。
 *
 * ## 为什么回合/步数要分开报过、现在又合起来了
 *
 * 早先报的是 `节点 N · 回合 N · 步 N · 工具 N · 重试 N · 错误 N`，六个数挤一行像日志。
 * `回合 3 · 步 8` 与 `3轮8步` 说的是同一件事，写法不同而已；真正需要区分的是
 * 「工具调用数」（模型自己发起的动作，与前两者不同口径），那个仍然单独报。
 *
 * ## 为什么 padToWidth 用 visibleWidth 而不是 stripAnsi().length
 *
 * pi-tui 是**增量**重绘：只重画变化的行。这一行的长度随统计变化（`3轮2步` → `3轮3步`），
 * 不补齐的话旧内容的尾巴不会被擦掉，下一帧会叠着出现 —— 看起来像「重复刷屏」。
 * 补齐长度让这一行恒定，增量重绘就不留残影。而汉字是双宽、`stripAnsi().length`
 * 会把「一个汉字」当一个字符，所以按可见列宽算（padToWidth 的注释）。
 */
export function tabLine(state: AgentState, page: 'chat' | 'trace'): string {
  const stats = traceStats(state.trace);
  // `x轮x步` 一个就够：两者都是「事件次数」，0 就整个不出现（`0轮0步` 是噪声）。
  // 注意与「工具」分开 —— 那是模型发起的动作数，不是时间维度。
  const bits: string[] = [];
  if (stats.turns > 0 || stats.steps > 0) bits.push(`${stats.turns}轮${stats.steps}步`);
  if (stats.toolCalls > 0) bits.push(dim(`工具${stats.toolCalls}`));
  if (stats.retries > 0) bits.push(dim(`重试${stats.retries}`));
  if (stats.errors > 0) bits.push(red(`错误${stats.errors}`));
  // 统计与切换键之间固定两个空格：既分开又不至于空出一大段。
  //
  // `keyLabel` 而不是字面量：用户改了 `app.trace.toggle` 之后这一行说的是新键
  // （空串只在动作 id 写错时出现 —— 那是编程错误，`()` 比一个看着对的过期键名更该被发现）。
  const traceKey = keyLabel('app.trace.toggle');
  const tail = [bits.join('  '), dim(`(${traceKey})`)].filter((s) => s !== '').join('  ');
  const tabs =
    page === 'chat'
      ? `${bold(cyan('对话'))} ${dim('│ 轨迹')}`
      : `${dim('对话')} ${bold(cyan('│ 轨迹'))}`;
  return tail === '' ? tabs : `${tabs} ${tail}`;
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

/**
 * 排队中的用户输入面板。空队列时返回空串（面板自己不占高度）。
 *
 * 与 pi 的 `updatePendingMessagesDisplay()` 同一形状与同一口径：
 *
 * ```
 * Steering: 顺便看下版本
 * Follow-up: 待会儿再说
 * ⏎ <key> to edit all queued messages
 * ```
 *
 * ## 为什么 steer 与 followUp 要用**不同的标记
 *
 * 两者投递给模型的时机不同，用户对它们的预期也不同：steer 是「打断现在这条线」，
 * followUp 是「等它说完」。若都显示成同一行「已排队」，用户就无法判断自己的话
 * 到底什么时候会被看见——而这正是使用这两个键的全部意义。
 */
/**
 * 滚轮键的字节序列 → 滚轮动作。
 *
 * ## 为什么不用 `matchesKey(data, 'up')`
 *
 * 方向键要先给编辑器：多行提示词里 `↑`/`↓` 是**移动光标**（editor.js 的默认行为），
 * 而在 ScrollView 上只滚一格（且官方没给它默认键）。两者抢同一个键的结果是
 * 「有时滚有时不滚」—— 取决于光标在哪一行，而那是最难复现的一类 bug。
 *
 * 所以用 **Alt+方向键 / Ctrl+P / Ctrl+N**：编辑器不碰它们，而用户按 `Alt+↑`
 * 的直觉仍然是「往上翻」。
 *
 * ## 为什么列字节序列而不是一个 helper
 *
 * pi-tui 的输入回调拿的是**原始序列**，而 Alt+↑ 在不同终端发的变体不少
 * （`\x1b[1;3A` / `\x1b[1;5A` / `\x1bOa` …）。列全它们比调一个只会匹配其中
 * 一种的 helper 可靠 —— 少列一种的症状是「在某个终端上 Alt+↑ 没反应」，
 * 而那只有换终端才复现得到。
 */
const ESC = String.fromCharCode(27);
const SCROLL_UP_SEQUENCES: readonly string[] = [
  `${ESC}[A`, // Alt+↑（xterm 常见）
  `${ESC}[1;3A`,
  `${ESC}Oa`, // Alt+↑（application cursor 模式）
  String.fromCharCode(16), // Ctrl+P
];
const SCROLL_DOWN_SEQUENCES: readonly string[] = [
  `${ESC}[B`,
  `${ESC}[1;3B`,
  `${ESC}Ob`,
  String.fromCharCode(14), // Ctrl+N
];

/** 这一串输入是不是「往上翻」（Alt+↑ 或 Ctrl+P）。 */
export function isScrollUp(data: string): boolean {
  return SCROLL_UP_SEQUENCES.includes(data);
}

/** 这一串输入是不是「往下翻」（Alt+↓ 或 Ctrl+N）。 */
export function isScrollDown(data: string): boolean {
  return SCROLL_DOWN_SEQUENCES.includes(data);
}

/**
 * 这条按键要不要**忽略**。
 *
 * ## 为什么需要它（mac 上「快捷键触发两次」的根因）
 *
 * pi-tui 的 Kitty 键盘协议请求里带了 flag 2（`terminal.js` 的 `1|2|4`），
 * flag 2 的语义是「报告事件类型」—— 于是**一次按键产生两个序列**：一个 press
 * （`:1u`）和一个 release（`:3u`）。macOS 上的 iTerm2 / Ghostty / kitty /
 * WezTerm 都支持这套协议，所以按一下切页键（默认 `Ctrl+R`）收到两条。
 *
 * 而 release 序列**也能匹配 `matchesKey()`**（`keys.js` 的 parseKey 读的是
 * `<code>;<mod>`，事件类型那第三段不参与匹配）。于是轨迹页被切换两次 ——
 * 切到轨迹页再切回对话页，按键看起来「完全没反应」。`Ctrl+O` 展开两次、
 * `Ctrl+Q` 换两次模式也是同样的症状。
 *
 * pi-tui 自己**有**这层过滤，但只对**聚焦组件**生效：
 *
 * ```js
 * // tui.js —— inputListeners 在前，过滤在后，且只查 focusedComponent
 * for (const listener of this.inputListeners) { … }        // ← 我们的快捷键在这里
 * …
 * if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) return;
 * ```
 *
 * 本项目的几个全局开关（轨迹页 / 展开工具 / 队列模式 / 中断 / 模型面板）与滚轮全部挂在
 * **input listener** 上（不是聚焦组件），
 * 所以官方那层过滤管不到它们。扩展的 `ctx.ui.onTerminalInput()` 更是直接透传到
 * `tui.addInputListener()`，同一个坑。
 *
 * ## 为什么不「关掉 flag 2」
 *
 * 那要在 `terminal.js` 里改（且它给的是 press/repeat/release 三态，repeat 是
 * 长按的正确语义）。而我们在**自己这层**过滤掉 release 已经够了：release 本来
 * 就不该有任何动作，重复也是因为没人过滤它。
 *
 * ## 与官方的口径一致
 *
 * 用的是同一个 `isKeyRelease()`（pi-tui 从 `index` 导出），所以两层判断不会漂移。
 * 粘贴内容（`\x1b[200~…\x1b[201~`）在 `isKeyRelease()` 里被显式排除 ——
 * 而我们的滚轮判断是**前缀**匹配（`data.startsWith(ESC + '[A')`），粘贴里只要
 * 开头撞上就会误判成翻页，所以粘贴必须在更早的地方就放行。
 */
export function shouldIgnoreKey(data: string): boolean {
  // 粘贴 / 输入框里的普通文本：不可能是快捷键，一律放行。
  if (data.includes(`${ESC}[200~`)) return false;
  return isKeyRelease(data);
}

export function renderQueuePanel(state: AgentState, width: number): string {
  const rows: string[] = [];
  for (const item of state.steerQueue) {
    rows.push(dim(`Steering: ${truncateToWidth(singleLine(item.text), Math.max(8, width - 12))}`));
  }
  for (const item of state.followUpQueue) {
    rows.push(dim(`Follow-up: ${truncateToWidth(singleLine(item.text), Math.max(8, width - 12))}`));
  }
  if (rows.length === 0) return '';
  return rows.join('\n');
}

/** 队列里那句话压成一行（队列面板只有一行高，多行会把输入框顶下去）。 */
function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 造一条排队输入。附件（图片）一并带过去 —— 与 `user.message` 同一个形状，
 * 所以「在生成中附了张图」也能排队。
 */
function queuedInput(text: string): QueuedInput {
  return { text, content: [{ type: 'text', text }], at: Date.now() };
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
 * 一行补到终端全宽（可见列宽，不计 ANSI）。
 *
 * pi-tui 是**增量**重绘：只重画变化的行。页签行是变长的（`3轮2步` → `3轮3步`、
 * 多了个错误数），变长时旧内容的尾巴不会被擦掉，于是下一帧会叠着出现 ——
 * 看起来像「重复刷屏」。补齐宽度让这一行长度恒定，增量重绘就不留残影。
 *
 * 用 `visibleWidth` 而不是 `stripAnsi().length`：**汉字是双宽**，后者把一个汉字
 * 当一个字符，补出来的空白会少一截（这一行固定含「对话」两个汉字）。
 */
function padToWidth(text: string, width: number): string {
  const visible = visibleWidth(text);
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
    name: 'model',
    description: '换模型（弹窗选择；`/model <id>` 精确命中时直接切；与 pi 同名）',
  },
  {
    name: 'scoped-models',
    description: '启用/禁用哪些模型参与 Ctrl+P 循环（Ctrl+S 存进 settings）',
  },
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
  {
    name: 'hotkeys',
    description: '列出全部键位（键名实时解析，与 pi 的 /hotkeys 同形）',
  },
  { name: 'help', description: '列出全部命令' },
];

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
   * 装了哪些 pi 扩展（入口 + 装载诊断）。
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
    /**
     * 装上的扩展（入口文件 + 来源）。
     *
     * **不是工具名**：早先这里给的是 `tools`（扩展注册的工具名），于是界面上写着
     * `[扩展] ask_user_question` —— 一个**工具**的名字被当成扩展名报了出去。用户照着
     * 那一行去 `settings.json` 的 `packages` 里找，找不到，于是以为扩展没装上。
     * 形状与 pi 的开场一致（`pi-web-access:dist` / `orca-agent-status.ts`），
     * 见 [resource-labels.ts](resource-labels.ts)。
     *
     * `tools` 仍然留着：诊断信息（工具没有 `promptSnippet` 那些）由内核出，
     * 而它要说清是**哪个扩展**的哪个工具。
     */
    entries: readonly ExtensionEntry[];
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
  restoreSession?: ((file: string) => Promise<{ id: string; restored: number }>) | undefined;
  /**
   * 换模型（`/model`）。**必须由内核出手** —— 与 `restoreSession` 同一类原因：
   * 换模型要 dispatch `model.changed` + `model.init`（能力与窗口随模型变），
   * 而 effect 表读的模型是**每次请求现取**的（`store.ts` 的 `resolveModel`）。
   * 界面自己 dispatch 也能让底栏变，但那样就绕过了内核那道「先查模型存在再换」的闸。
   *
   * 不传 = `/model` 面板仍能开（能列、能搜），选完会**明说没接内核**而不是假装换了。
   */
  setModel?: ((provider: string, modelId: string) => boolean) | undefined;
  /**
   * 拿 provider 装配（模型目录的来源）。`/model` 面板要它列模型。
   *
   * 不给就退化成一个只有「当前模型」的面板（与 pi 的 `AgentSession` 缺 `modelRuntime`
   * 时的行为一致）—— 但本项目正常路径下**一定**给得出来。
   */
  runtime?: AgentRuntime | undefined;
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

/**
 * 启用列表 → 面板要用的作用域条目。
 *
 * ## 为什么自己解析而不用官方的 `resolveModelScopeFromModels`
 *
 * 官方那个（`core/model-resolver.js`）还兼三件事，而这里只缺得起的只有一件：
 *
 * - 解析 `provider/id:high` 里那个**思考级别**（`:high`）——我们要，那部分直接用官方的结果形状；
 * - **判重 / 报诊断**（`no-match`）——那要给用户看，而 `/model` 面板里没有报诊断的地方
 *   （它自己会列「没有匹配的模型」）。真要报，应该报在 `/scoped-models` 那一侧。
 * - **降级路径**（`runtime` 是 undefined）——面板得**能开**。官方的解析器要
 *   `ModelRuntime`，我们降级时没有，于是不能只靠它。
 *
 * 所以这里的策略是：**拿得到官方结果就用它**（解析规则逐字复用，不自己写 `:level` 解析），
 * 拿不到就只按 `provider/id` 精确匹配 —— 并把「解析不出来」**如实**表现为「列表短了」，
 * 而不是编一条假条目去凑数。
 *
 * `null`（= 全开）不解析成条目：官方的「全开」语义是「面板列全部可用」，由组件自己算。
 */
export function scopeFrom(
  enabledIds: readonly string[] | null,
  runtime: AgentRuntime | undefined,
): ModelScope {
  if (enabledIds === null) return NO_SCOPE;
  const available = runtime ? [...modelRuntimeFor(runtime).getAvailableSnapshot()] : [];
  const items: ScopedModelItem[] = [];
  for (const ref of enabledIds) {
    // `provider/id:high`：级别是**末尾**的 `:片段`（`:` 在 model id 里的情形靠 split 判前缀匹配）。
    const slash = ref.lastIndexOf('/');
    const provider = slash > 0 ? ref.slice(0, slash) : undefined;
    let idAndLevel = slash > 0 ? ref.slice(slash + 1) : ref;
    let level: string | undefined;
    const colon = idAndLevel.lastIndexOf(':');
    if (colon > 0) {
      const tail = idAndLevel.slice(colon + 1);
      // 只认**已知的级别名**：model id 里带冒号（OpenRouter 的 `x:exacto`）很常见，
      // 把它们当级别剥掉会得到一个找不到的 id —— 而那条配置本来是好的。
      if (['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(tail)) {
        level = tail;
        idAndLevel = idAndLevel.slice(0, colon);
      }
    }
    const model = available.find(
      (m) => (provider ? m.provider === provider && m.id === idAndLevel : m.id === idAndLevel),
    );
    if (model) items.push(level === undefined ? { model } : { model, thinkingLevel: level });
  }
  return { enabledModelIds: [...enabledIds], models: items };
}

export async function runTui(options: TuiOptions): Promise<number> {
  const { store, prompt, newSession, sessionId, restoreSession: restoreHook } = options;
  const beforeAgentStartHook = options.beforeAgentStart;
  const cwd = options.cwd ?? process.cwd();
  /**
   * 当前会话**文件路径**（picker 用它把「正在用的这条」标出来并拒绝删除）。
   *
   * `sessionId` 是取值函数（`/new` 之后会变），所以每次开面板现算 —— 别缓存，
   * 否则 `/new` 之后打开 `/sessions` 会去保护一个已经不存在的文件。
   */
  const currentSessionFile = (): string | undefined => {
    const id = sessionId?.();
    return id === undefined || id === '' ? undefined : findSessionFile(id, cwd);
  };
  /**
   * 退出前打印一行「怎么恢复这次会话」。
   *
   * 形状与 pi 的退出提示一样（`To resume this session: <命令>`，前缀暗色），
   * 只是命令是本项目的 `ela --session <id>`。
   * 用 `process.stdout.write` 而不是界面里的 notify：这一刻 TUI 已经停了（`tui.stop()`），
   * 往终端写一行才是用户看得到的地方 —— 也是 pi 的做法。
   *
   * 判断与文案都在 config-home 的 `resumeCommand()`（那儿才有「真落过盘没」的事实）。
   */
  const printResumeOnExit = (): void => {
    const command = resumeCommand(sessionId?.(), cwd);
    // 暗色与 pi 一致（chalk.dim）；这里手写 ANSI，避免为一行提示引依赖。
    if (command) process.stdout.write(`\u001b[2mTo resume this session:\u001b[0m ${command}\n`);
  };
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
  // 键位表必须在**任何会读键名的地方之前**装好：`keyDisplayText()` 与 pi-tui 的
  // Editor / SelectList 都从 `getKeybindings()` 这个进程级全局取键名 —— 没装的话
  // 提示行整行消失（不是「按了没反应」），而那种症状很难往键位表上想。
  //
  // 这里装的是 **pi 的全套 + 本项目自己的几个**（`app.trace.toggle` 等），
  // 并读 `~/.pi/agent/keybindings.json` 里用户自己的覆盖。见 `keybindings.ts`。
  //
  // **接住返回值**：下面 composer 的 `CustomEditor` 要的也是这一份（它内部会认
  // `app.interrupt` 之类的动作）。再调一次会再读一遍那个文件，多一份不同步的机会。
  const keybindings = installProjectKeybindings();
  const terminal = new ProcessTerminal();
  // AltScreen 是 viewport 实现，setLayoutRoot 在 ViewportTUI 上（TUI 接口没有）。
  const tui: ViewportTUI = new TuiAltScreen(terminal, true, undefined, {
    mouse: true,
    copyOnSelect: true,
  });

  /**
   * 顶行：页签 + 轨迹统计（**两职合一**，见 tabLine）。
   *
   * 为什么**只有一个**顶行组件：早先是 header（统计）+ tabs（页签）两行，两行讲的是
   * 同一件事（「我在哪页 / 这轮跑到哪了」），纵向白占一行，而对话区最缺高度。
   */
  const tabs = new Text('', 0, 0);
  /**
   * 对话区：**按消息分块**的增量渲染（每条消息一个组件，内容没变就不重算）。
   *
   * 以前这里是 `new Text(renderTranscript(...))` 那个整段重算的形状，每帧 ~1.2 秒，
   * 而流式 token 每个都触发一次刷新 —— 详见 TranscriptChunks 的注释。
   */
  const transcript = new TranscriptChunks();
  /**
   * 轨迹区：**按节点分块**的增量渲染 + 可滚动。
   *
   * 与对话区同构（`TraceChunks` 就是 `TranscriptChunks` 的翻版），而外面包一个
   * `ScrollView` 且 `follow: 'end'` —— 新节点往下追加、视口自动贴底，
   * 用户往上翻时 `follow` 自动让位（ScrollView 自带这个行为）。
   *
   * `primary: true` 只在「当前页是轨迹」时才给（见 `applyLayout`），于是滚轮与
   * PgUp/PgDn 在两个页里各自滚自己的内容。
   */
  const traceChunks = new TraceChunks();
  /**
   * 轨迹区的容器：把 `TraceChunks` 装进 VStack，外面再包 ScrollView。
   *
   * `follow: 'end'` = 新节点往下追加时视口自动贴底（用户往上翻时它会让位，
   * 这是 ScrollView 自带的行为）。`scrollbar: 'auto'` 只在内容超出时才出现。
   *
   * ## 为什么是 `let` 而不是 `const`
   *
   * `ScrollView.primary` 是 **readonly**（构造时定）—— 而「哪个是 primary」正是
   * 整页切换的核心：pi-tui 的 key 处理（滚轮 / PgUp / PgDn）只发给 primary 那个。
   * 不跟着当前页走的话，在轨迹页里滚会滚到对话区（症状：轨迹页怎么滚都不动）。
   *
   * 所以切页时**重建**这两个 ScrollView。重建代价很小：块（`traceChunks` /
   * `transcript`）是长生命的对象，被新 ScrollView 重新包一层而已，已渲染的内容
   * 与滚动位置都在那些块里，不丢。
   */
  let traceScroll = new ScrollView(new VStack([{ component: traceChunks, minSize: 1 }]), {
    follow: 'end',
    primary: false,
    scrollbar: 'auto',
  });
  let scroll = new ScrollView(transcript, { follow: 'end', primary: true });
  /**
   * 底栏：**两行**（与 pi 同形）。
   *
   *     ~\Documents\workspace\event-loop-agent (main)
   *     ↑6.8k ↓49 R143 CH2.1% 0.7%/1.0M        (workbuddy) cn:space-bunny
   *
   * 为什么要它：模型与用量是「我在跟谁说话、说了多少」，与对话内容无关；堆在顶行
   * 会干扰读对话。而它们又不能删 —— 换 provider 时最容易出的错就是以为还在用原厂模型。
   *
   * 一个 Text 组件装两行（内部用 `\n` 分行），而不是两个组件：布局里只占一个 slot，
   * 也不用管两行之间的高度分配。
   */
  const footer = new Text('', 0, 0);
  /**
   * 排队中的用户输入（steer / followUp）—— 与 pi 的 `pendingMessagesContainer` 同一形状：
   * 一行一条，前面标出它去哪一列。
   *
   * ## 为什么**常驻**在底区而不是 notify 一下就没
   *
   * 排队的消息在真正插进去之前，模型**完全不知道它存在**。用户如果看不到队列，
   * 打完字就不知道「它到底收没收到」—— 而这个反馈缺失会让人重复打一遍
   * （于是模型收到两条几乎相同的话）。
   *
   * ## 为什么用 `setText` 而不是函数形式
   *
   * pi-tui 的 `Text` 构造器只吃字符串（官方内部那个 `ThemedText` 才吃函数，
   * 两者不是同一个东西）。队列长度会变，所以每次 `refresh()` 里重算一遍再 setText ——
   * 一共三五行的字符串，重算成本可以忽略，而增删子节点要处理很多状态。
   */
  const queuePanel = new Text('', 0, 0);

  /**
   * 当前作用域（`Ctrl+P` 循环的候选集）——`/scoped-models` 改的就是它。
   *
   * ## 为什么在 `runTui` 的闭包里而不是 state 里
   *
   * 三个理由，与 `model-scope.ts` 的文件头同源：
   *
   * 1. 它**不是**「这次对话的事实」——`/new` / 恢复历史都不该动它。
   * 2. state 里的东西要进 `reducer.ts` 的 `restoredConversationState` 清单（漏一项的症状
   *    是「`/new` 之后循环集莫名变了」）。
   * 3. 界面**重建**时（换会话时我们重建 transcript）闭包变量天然还在，而 state 要额外
   *    一条 `conversation.reset` 的分支去保住它。
   *
   * 启动时从 `settings.json` 的 `enabledModels` 读一次（与 pi 同键）——
   * 所以「上次设的」在下次启动仍然有效。
   */
  let currentScope: ModelScope = scopeFrom(readScopedModels(cwd), options.runtime);

  // 官方那个会把工作状态画进**上框线**的编辑器（`embedWorkingStatus: true`）——
  // 与 pi 同一个类、同一个形状。
  //
  // ## 配色直接用 pi 那份（`getEditorTheme()`），不再手写
  //
  // 手写一份会有两个问题：
  //
  // 1. **横线颜色会分家**。pi 的 composer 横线是 `theme.getThinkingBorderColor(level)`
  //    （默认级别 'off' → 主题 token `thinkingOff`），而不是凭感觉的 `dim`（那是**文本
  //    属性** `\x1b[2m`，不是颜色 token）。手写那份在浅色终端上与 pi 不一致。
  // 2. **补全列表的选中文也会分家**：pi 用 `accent`，手写的用 `cyan`。
  //
  // 它内部读的是 pi 主题，所以**必须**在 `setupTheme()` 之后调 —— 不能在模块顶层求值。
  // 形状（`borderColor` 是函数、`selectList` 是一整块 `SelectListTheme`）交给 typecheck；
  // 写错时不要用 `as unknown as EditorTheme` 压住 —— 那个 cast 会让
  // `this.theme.selectedText is not a function` 在**渲染时**才爆，而补全列表渲染失败
  // 在界面上只表现为「打 `/` 什么都没弹」，极难归因。
  //
  // ## 为什么 keybindings 也要传
  //
  // `CustomEditor` 的构造签名要它（它内部会认 `app.interrupt` / `app.exit` 等）。
  // 传上面那份（= pi 全套 + 本项目自己的动作），与面板 / `keyLabel()` 用的是**同一份**
  // —— 不然用户改过的键在这里不生效。
  const editor = new CustomEditor(tui, getEditorTheme(), keybindings, {
    // 把「思考中 / 压缩中 / 重试中」画在**上框线**里（而不是单独占一行）。
    // 这正是 pi 的行为：状态与 composer 共用一个边框，不多吃一行。
    embedWorkingStatus: true,
  });

  /**
   * 当前挂在 composer 上框线上的工作状态（`undefined` = 空闲，不画）。
   *
   * 为什么要留着引用：它内部是个 `Loader`（自带 `setInterval` 转圈）。换状态时
   * 不 `dispose()` 旧的，那个定时器会一直转下去 —— 重试时每轮换一次文案，几轮下来
   * 屏上虽然只看得到最新那个，进程里却积了一堆永不停止的定时器。
   * 这与 pi 的 `showStatusIndicator()`（先 `dispose()` 旧的）同一个道理。
   */
  let activeStatus: StatusIndicator | undefined;
  /**
   * 把状态设进 composer 的上框线。
   *
   * 颜色用**边框自己的颜色**（与 pi 嵌入时的做法一致：`(text) => editor.borderColor(text)`）。
   * 为什么不是写死的 `accent` / `warning`：边框颜色跟着思考级别变，状态文字却是固定色
   * 时会看起来像两套东西拼在一起。跟着边框走就天然一致。
   */
  const setWorkingStatus = (message: string | undefined): void => {
    activeStatus?.dispose();
    if (message === undefined) {
      activeStatus = undefined;
      editor.setWorkingStatusIndicator(undefined);
      return;
    }
    const indicator = new WorkingStatusIndicator(tui, message, undefined, (text) =>
      editor.borderColor(text),
    );
    activeStatus = indicator;
    editor.setWorkingStatusIndicator(indicator);
  };
  /** 上一次设的状态文案 —— 只在**变色**时才重建那个 `Loader`。 */
  let currentStatusText: string | undefined;
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
   * —— 而 `applyLayout()` 每帧可能被切页键调，它读这个 Map 就够。
   */
  const widgetSlots = new Map<string, Component>();

  /**
   * 当前在哪个**整页**。
   *
   * 「不分屏」是刻意的：早先轨迹面板与对话区上下排，结果是轨迹一多就把对话区挤没，
   * 而它自己又不可滚 —— 于是两败俱伤。改成整页切换后，每页都能占满中间那块，
   * 并且 ScrollView 的 `primary` 跟着它走（见 applyLayout）。
   */
  let page: 'chat' | 'trace' = 'chat';
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
  /**
   * 入队模式：生成中提交的话，默认走哪一列。
   *
   * 默认 **steer**（对齐 pi）：它是最常见的意图（「等等，改用这个」），而且
   * followUp 的语义在「说完再插」这个场景下更接近默认值。
   *
   * 用 `cycleQueueMode()` 切。为什么不做成「回车两次 = 先 steer 再升级成 followUp」：
   * 那需要在队列里记住「它本来想干什么」，而实际结果往往是用户改主意了 ——
   * 显式一个键位切换更清楚，也与 pi 的两个独立键位一致。
   */
  let queueMode: QueueKind = 'steer';
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
   * `/hotkeys` 的 markdown 源码（`undefined` = 没显示过）。
   *
   * 存**源码**而不是渲染好的行：终端改宽度之后要重排（表格框线是按宽度画的），
   * 而宽度只有 `refresh()` 知道。渲染结果的缓存也放在那里（`hotkeysLines()`）。
   */
  let hotkeysSource: string | undefined;
  /** 上面那份源码渲染成的行；按宽度缓存（同一宽度下每帧复用同一个数组引用）。 */
  let hotkeysLinesCache: { width: number; lines: readonly string[] } | undefined;
  /**
   * `/hotkeys` 当前该显示的行。
   *
   * 「按宽度缓存」不是优化而是**必需**：`TranscriptChunks.update()` 靠**数组引用**
   * 判断这一块变没变，每帧新造一个数组就等于每帧都重排整张表（还把它自己的折行缓存
   * 打掉）。宽度没变时返回同一个数组，那一块就一帧都不重算。
   */
  const hotkeysLines = (width: number): readonly string[] | undefined => {
    if (hotkeysSource === undefined) return undefined;
    if (hotkeysLinesCache?.width !== width) {
      hotkeysLinesCache = { width, lines: renderHotkeys(width, options.extensionCommands?.shortcuts() ?? []) };
    }
    return hotkeysLinesCache.lines;
  };
  /**
   * 已经报过一次的那次压缩（避免每帧都报一遍）。
   *
   * 为什么要单独记：`lastCompaction` 是**粘在 state 上的**（不会自动清），
   * 而这个订阅器每次 store 变化都会跑 —— 不记就变成「每次刷新都插一行」。
   */
  let lastNoticedCompaction: AgentState['lastCompaction'] = null;

  const refresh = (): void => {
    const state = store.getState();
    // composer 上/下框线的颜色跟**思考级别**走 —— 与 pi 的 `updateEditorBorderColor()`
    // 同一套（`theme.getThinkingBorderColor(level)`，级别 'off' 时是 `thinkingOff`）。
    // 放在 refresh 而不是构造时定死：切模型 / 切级别都会改 `state.thinkingLevel`，
    // 写在这里下一帧就跟上。
    editor.borderColor = theme.getThinkingBorderColor(state.thinkingLevel);
    // 工作状态（思考中 / 压缩中 / 重试）画在**上框线**里（见 editor 构造处的注释）。
    // 只在文案**真的变了**时才重建那个 `Loader`（重建 = 重启转圈动画）。
    const nextStatus = workingStatusText(state);
    if (nextStatus !== currentStatusText) {
      currentStatusText = nextStatus;
      setWorkingStatus(nextStatus);
    }
    // 底栏：模型名 / 用量数会变，必须补齐到全宽，否则残影会叠出来。
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
    // 队列面板同样要补到全宽（否则少一行时残影会留在屏幕上）。
    queuePanel.setText(padToWidth(renderQueuePanel(state, width), width));
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
    transcript.update(state, terminal.columns ?? 100, expanded, notice, banner, hotkeysLines(width));
    // 轨迹：**每帧都同步**（即使不在轨迹页）—— 否则切过去的第一帧看到的是
    // 上一次 refresh 的快照，而那时可能已经落后好几步（症状：切过去先看到一棵
    // 少了几步的树，然后才突然补齐）。同步是增量的，成本与节点数无关。
    traceChunks.update(
      state.trace,
      terminal.columns ?? 100,
      // 开场树是空的（**故意**的：装载节点要等第一句话才建，见 reducer 的 beginTrace），
      // 所以这句话得说清楚「不是坏了」，否则用户以为没记上。
      state.prompt.seeded ? '（发送第一条消息后这里开始记轨迹）' : '（还没有任何节点）',
    );
    // 页签 + 统计：合在一行（见 tabLine）。当前页高亮，统计紧凑成 `x轮x步`。
    // **补到全宽**：这一行长度随统计变化，不补齐的话增量重绘会叠出残影。
    tabs.setText(padToWidth(tabLine(state, page), width));
    tui.requestRender();
  };

  store.subscribe(() => {
    const state = store.getState();
    // 工作状态（思考中 / 压缩中 / 重试）**不在这里**维护 —— 它在 `refresh()` 里从
    // state 现推（见 `workingStatusText()`）。早先这里是一串 if/else 加一个
    // `lastLoaderMessage` 变量，三处各自记得收尾；漏一处的症状是「圈一直转」。
    // 现推就没有这笔账。
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
  /** 当前页的 ScrollView —— 滚轮只滚它（另一个不滚，免得「在轨迹页却滚动了对话区」）。 */
  const activeScroll = (): ScrollView => (page === 'trace' ? traceScroll : scroll);
  const onInput: TuiInputListener = (data: string) => {
    /**
     * **先扔掉「松开」事件。**
     *
     * Kitty 键盘协议 flag 2（pi 主动请求的）让一次按键产生 press + release 两个序列，
     * 而 release 同样能匹配 `matchesKey()` —— 所以不扔的话每个快捷键都会触发两次，
     * 等于没切。这是 macOS（iTerm2/Ghostty/kitty/WezTerm 支持那套协议）上
     * 「快捷键触发两次」的根因。详见 `shouldIgnoreKey()` 的注释。
     *
     * pi-tui 自己有这层过滤，但**只对聚焦组件生效**（`tui.js` 里它在
     * inputListeners 之后才跑，且只查 `focusedComponent`）—— 而本项目的快捷键全挂在
     * input listener 上，官方那层管不到。粘贴不受影响（`shouldIgnoreKey` 显式放行）。
     */
    if (shouldIgnoreKey(data)) return undefined;
    /**
     * **有弹窗时，本监听器整个让路。**
     *
     * pi-tui 的 `inputListeners` 在**聚焦组件之前**跑（`tui.js` 的 `handleInput`）：
     * 没被 `consume` 的按键继续往聚焦组件走，而弹窗聚焦的正是它自己。所以这里
     * `return undefined`（不消费）就是「我不处理，交给弹窗」。
     *
     * ## 为什么必须要
     *
     * 这个监听器无条件处理那几个全局开关，其中一个是致命的：中断键（默认 `ctrl+c`）
     * 在空闲时 `process.exit(0)`。弹窗里 `Ctrl+C` 的语义是**取消面板**，于是
     * 「打开 /sessions 然后想退出」会直接杀掉整个界面 —— 而且没有堆栈、没有日志，
     * 用户只会觉得「崩了」。
     * 另外几个（切轨迹页 / 展开工具 / 换队列模式）会让弹窗
     * 开着的**同时**背后的主界面也变了，看着像面板没盖住背景。
     *
     * ## 为什么判「弹窗栈非空」而不是「picker 是否开着」
     *
     * 后者要 app 持一份状态，而前者白得一个连带好处：扩展用 `ctx.ui.custom()` /
     * `ctx.ui.select()` 弹的对话框**也自动**拿到同样的让路（它们内部同样把 `Ctrl+C`
     * 当取消）。那些面板各有自己的 `handleInput`，所以顺序仍然是「面板先、这里后」。
     */
    if (tui.hasOverlay()) return undefined;
    /**
     * 滚轮：**必须在编辑器之前**。
     *
     * Alt+↑ / Ctrl+P 这些键编辑器不碰，但它们的兄弟（纯 ↑↓）要碰 ——
     * 所以只要不冲突，就没必要让它晚一步。
     *
     * 半页而不是一行：轨迹一行就是**一个节点**，一行一行翻太慢；而对话区
     * 半页刚好是「一屏的一半」，两边都不别扭。
     */
    if (isScrollUp(data)) {
      const view = activeScroll();
      view.scrollBy(-Math.max(1, Math.floor(view.viewportHeight / 2)));
      refresh();
      return { consume: true };
    }
    if (isScrollDown(data)) {
      const view = activeScroll();
      view.scrollBy(Math.max(1, Math.floor(view.viewportHeight / 2)));
      refresh();
      return { consume: true };
    }
    /** 内置的几个开关键。返回 true = 已消费。 */
    const builtins = (): boolean => {
      // `Ctrl+L` = `app.model.select`（打开 /model 面板）—— **用 pi 的动作 id**，
      // 不自己编一个：用户的 `keybindings.json` 里改了这个 id，pi 与本项目同时生效。
      //
      // 判断也走 `actionMatches` 而不是裸的 `matchesKey(data, 'ctrl+l')`：后者写死了
      // 默认键，用户改过就不生效（而提示行那边会显示新键 —— 两边说法不一致）。
      if (actionMatches(data, 'app.model.select')) {
        if (store.getState().phase !== 'idle') {
          notify(yellow('上一回合还没结束，先 Ctrl-C 中断再换模型'));
          return true;
        }
        if (!options.runtime) {
          notify(yellow('未接内核（没有 provider 装配），换不了模型'));
          return true;
        }
        openModelPicker({
          tui,
          runtime: options.runtime,
          current: {
            provider: store.getState().providerName,
            modelId: store.getState().modelId,
          },
          cwd,
          scope: currentScope,
          onSelect: (model) => {
            if (!options.setModel?.(model.provider, model.id)) {
              notify(yellow(`换不了 ${model.provider}/${model.id}（未接内核或配置里没它）`));
              return;
            }
            refresh();
            notify(dim(`已切到 ${model.id}（${model.provider}）`));
          },
          onSelectAsDefault: (model) => {
            if (!writeDefaultModel(model.provider, model.id, cwd)) {
              notify(yellow('没能写进 settings.json，默认模型没变'));
              return;
            }
            if (options.setModel?.(model.provider, model.id)) {
              refresh();
              notify(dim(`已存为默认并切到 ${model.id}（${model.provider}）`));
            } else {
              notify(yellow(`已存为默认，但换不了 ${model.id}（配置里没它）`));
            }
          },
        });
        return true;
      }
      if (actionMatches(data, 'app.abort')) {
        if (store.getState().phase !== 'idle') {
          abortRun();
          return true;
        }
        printResumeOnExit();
        tui.stop();
        process.exit(0);
      }
      // `app.trace.toggle`（默认 Ctrl+R）：**切到轨迹页 / 切回对话页**。
      //
      // 早先是「显示/隐藏一块贴在对话区上面的面板」，两个毛病：轨迹一多把对话区挤没，
      // 而它自己不可滚（只看得到最早那几行）。现在是整页切换，布局要重设
      // （中间那块换了组件，primary ScrollView 也跟着换）。
      //
      // **不再用 `ctrl+t`**：那是 pi 的 `app.thinking.toggle`，而两边共用一份
      // `~/.pi/agent/keybindings.json` —— 同一个键在两个应用里含义不同时，写覆盖的
      // 人没法表达「我想要哪个」。详情见 `keybindings.ts` 的文件头。
      if (actionMatches(data, 'app.trace.toggle')) {
        page = page === 'trace' ? 'chat' : 'trace';
        applyLayout();
        refresh();
        return true;
      }
      // `app.tools.expand`（Ctrl+O）：展开/收起工具输出的完整内容。与 pi 同 id 同键。
      if (actionMatches(data, 'app.tools.expand')) {
        expanded = !expanded;
        refresh();
        return true;
      }
      // `app.queue.cycle`（Ctrl+Q）：切换入队模式（steer ↔ followUp）。
      //
      // **不用 Ctrl+S / Ctrl+U**：它们在某些终端里会被流控吃掉（Ctrl+S 是 XOFF），
      // 按下去「什么反应都没有」—— 而那正好是最需要反馈的时刻。
      if (actionMatches(data, 'app.queue.cycle')) {
        cycleQueueMode();
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
    // `builtins()` —— 那样就会跑两遍，于是轨迹页切换**两次**（等于没切）。
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
      // **环在跑：入队，而不是拒绝。**
      //
      // 早期版本直接回一句「上一回合还没结束（Ctrl-C 可中断）」，于是用户想问
      // 「顺便查下版本」时唯一的选择是等——或者中断（丢掉模型已经跑出来的东西）。
      // 真正的做法与 pi 一样：**排进队列**，看它什么时候插进去。
      //
      // 用哪一列由**模式键**决定（默认 steer）：
      // - steer：当前 step 的工具跑完后、下一次 LLM 调用前插进去（会打断延续）。
      // - followUp：等模型说完、开一个新回合才插（不打断）。
      // 见 `queueMode` 的注释。
      queue(queuedInput(input));
      return;
    }
    send(input);
  };

  /**
   * 把一句排队的输入送进内核。
   *
   * **入队不等于立刻插进去** —— 投递时机由 reducer 决定（见 queue.input 的注释）：
   * steer 在「工具跑完、下一次 LLM 调用前」，followUp 在「回合收工时」。
   */
  const queue = (item: QueuedInput): void => {
    store.dispatch({ type: 'queue.input', text: item.text, content: item.content, as: queueMode });
    // 提示一句去了哪一列：用户得知道「我现在说的话会不会打断它」。
    notify(dim(`${queueMode === 'steer' ? 'Steering' : 'Follow-up'}: ${item.text}`));
    refresh();
  };

  /** 在 steer 与 followUp 之间切模式（对应 pi 的 `app.message.steer` / `followUp` 两个键位）。 */
  const cycleQueueMode = (): void => {
    queueMode = queueMode === 'steer' ? 'followUp' : 'steer';
    notify(dim(`入队模式：${queueMode === 'steer' ? 'steer（工具跑完后插进去）' : 'followUp（说完再插）'}`));
    refresh();
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
          cwd,
          ...(currentSessionFile() !== undefined ? { currentSessionFile: currentSessionFile() } : {}),
          onPick: (session) => restoreSession(session),
          // 官方只删会话文件，轨迹那份要我们自己补 —— 见 session-picker 的注释。
          onSessionDeleted: (session) => {
            if (!deleteSessionTrace(session)) {
              notify(dim(`已删会话 ${session.id}（轨迹文件 ${path.basename(session.file)} 旁边的 traces/ 那份没删掉，下次 /clean 会扫掉）`));
            }
          },
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
      case 'model': {
        // 环在跑时不能换：那条流正在等 token，而它的请求已经发出去了 ——
        // 中途换模型会让这一轮的模型与下一轮不同，而对话里看不出这个断点。
        if (store.getState().phase !== 'idle') {
          notify(yellow('上一回合还没结束，先 Ctrl-C 中断再换模型'));
          return;
        }
        if (!options.runtime) {
          notify(yellow('未接内核（没有 provider 装配），换不了模型'));
          return;
        }
        // 选了模型之后要**真的**换：内核 setModel() 发 `model.changed` + `model.init`。
        const apply = (model: Model<any>, persist: boolean): void => {
          if (persist && !writeDefaultModel(model.provider, model.id, cwd)) {
            notify(yellow(`没能写进 settings.json（写权限？），默认模型没变；这一轮仍用 ${model.id}`));
            return;
          }
          if (!options.setModel) {
            notify(yellow(`未接内核，${model.id} 没换成（面板只是列了模型）`));
            return;
          }
          if (!options.setModel(model.provider, model.id)) {
            notify(yellow(`换不了 ${model.provider}/${model.id}：当前配置里没这个模型`));
            return;
          }
          refresh();
          notify(
            dim(
              persist
                ? `已存为默认并切到 ${model.id}（${model.provider}）`
                : `已切到 ${model.id}（${model.provider}）`,
            ),
          );
        };
        // `/model <词>`：精确命中就直接切（与 pi 的 `findExactModelMatch` 同一形状），
        // 否则带词开面板（官方组件拿它当 `initialSearchInput`）。
        //
        // 为什么要区分：`/model cn:space-bunny` 每次都开一次弹窗会很烦 —— 而精确命中是
        // 可验证的（列表里真有这个 id），不存在「弹窗里翻半天才找到」的风险。
        if (arg !== '') {
          const snapshot = modelRuntimeFor(options.runtime).getAvailableSnapshot();
          const exact = snapshot.find(
            (m) => m.id === arg || `${m.provider}/${m.id}` === arg,
          );
          if (exact) {
            apply(exact, false);
            return;
          }
        }
        openModelPicker({
          tui,
          runtime: options.runtime,
          current: {
            provider: store.getState().providerName,
            modelId: store.getState().modelId,
          },
          cwd,
          scope: currentScope,
          onSelect: (model) => {
            apply(model, false);
          },
          onSelectAsDefault: (model) => {
            apply(model, true);
          },
        });
        return;
      }
      case 'scoped-models': {
        if (store.getState().phase !== 'idle') {
          notify(yellow('上一回合还没结束，等它跑完再改作用域'));
          return;
        }
        if (!options.runtime) {
          notify(yellow('未接内核（没有 provider 装配），改不了作用域'));
          return;
        }
        openScopedModelsPicker({
          tui,
          runtime: options.runtime,
          cwd,
          currentScope,
          onChange: (ids) => {
            // **当场生效**：解析成条目，下次开 /model 面板与 Ctrl+P 循环都用它。
            currentScope = scopeFrom(ids, options.runtime);
            notify(dim(`作用域已改（${ids === null ? '全部' : `${ids.length} 个`}），Ctrl+S 存进 settings`));
            refresh();
          },
          onPersist: (ids, written) => {
            const count = ids === null ? '全部' : `${ids.length} 个`;
            // 写失败**必须**说出来：用户以为存下了，下次启动发现没了，而那无处可查。
            notify(written ? dim(`已写进 settings.json（${count}）`) : yellow('没能写进 settings.json（写权限？）'));
          },
        });
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
      case 'hotkeys': {
        // 与 pi 的 `/hotkeys` 同形：一张键位表，贴在这轮对话之后。
        //
        // **不弹面板**是刻意的：pi 也是把它 append 进对话区。理由是这样能一边看表
        // 一边往下翻自己的对话，而弹窗会盖住上下文、关掉之后表也没了。
        //
        // 表里的键名是**实时解析**的（`keyLabel()` → `getKeybindings()`），所以用户改过
        // `~/.pi/agent/keybindings.json` 之后这里显示的就是新键 —— 与顶行那个 `(Ctrl+R)`、
        // 与面板底部的提示行同一个来源。
        hotkeysSource = hotkeysMarkdown(options.extensionCommands?.shortcuts() ?? []);
        hotkeysLinesCache = undefined;
        notify(dim('键位表已插到对话末尾（改键位：~/.pi/agent/keybindings.json）'));
        refresh();
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
      // **要等**：内核要读 `traces/<id>.jsonl` 才能把轨迹树带回来。
      // 不等的话 notify 会先弹「已恢复」，而那棵树还没灌进 state ——
      // 症状是「提示说恢复了，轨迹面板却还是空的」。
      void restoreHook(session.file).then((result) => {
        notify(
          dim(
            `已恢复 ${result.id}（${result.restored} 条消息，未重跑模型；之后的消息继续写进它）`,
          ),
        );
        refresh();
      });
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
    // 工作状态（上框线那个「思考中…」）不在这里手动开 —— `refresh()` 从 state 现推。
    // `user.message` 会把 `phase` 拉到 `thinking`，下面那行 `dispatch` 之后紧接着的
    // `refresh()` 就把状态画上了。（dispatch 是同步的，所以不存在「先渲染一帧空边框」的窗口。）
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
  // 纵向三段：顶行一行（页签 + 统计）/ 中间那块（当前页，唯一可伸缩）/ 底部输入区。
  //
  // 为什么不能用 addChild 平铺：那样每个组件各占若干行，内容一多就把输入框顶出屏幕，
  // 而且整屏重画时旧内容会留在回滚缓冲里（看起来像「重复刷屏」）。
  //
  // 为什么写成函数：切轨迹页会改变中间那块是哪个组件（primary 也跟着变），
  // 布局得跟着重设。
  //
  // 用函数声明（不是 const 箭头）：onInput 里会调它，const 有 TDZ，声明会提升。
  function applyLayout(): void {
    // 重建两个 ScrollView，让 **primary** 跟着当前页走（见 traceScroll 的注释）。
    //
    // 顺序要点：先定 `scroll` / `traceScroll`，再读它们排布局。
    const wantTracePrimary = page === 'trace';
    if (wantTracePrimary !== traceScroll.primary) {
      traceScroll = new ScrollView(new VStack([{ component: traceChunks, minSize: 1 }]), {
        follow: 'end',
        primary: wantTracePrimary,
        scrollbar: 'auto',
      });
      scroll = new ScrollView(transcript, { follow: 'end', primary: !wantTracePrimary });
    }
    // **两个整页切换，不分屏。**
    //
    // 早先的形状是「轨迹面板贴在对话区上面」（同一个 VStack 里两个可伸缩区），
    // 后果有两个：轨迹一多就把对话区挤没；而它自己又不可滚，于是只剩最早那几行。
    //
    // 现在：顶部放一行**页面标签 + 统计**（tabLine，两职合一），中间那块的**内容**
    // 按 `page` 换掉，谁在中间谁就是 `primary`（pi-tui 的 key 处理只发给 primary
    // ScrollView —— 见 layout.js 的 `node.state.primary || !context.primaryScrollView`）。
    // 所以「滚轮 / PgUp / PgDn 在轨迹页滚轨迹、在对话页滚对话」是白得的，不用自己判。
    //
    // 不做分屏也就不用调两块的高度：中间那块永远 basis 0 + grow 1（唯一可伸缩的）。
    const bottom = new VStack([
      // 扩展的 widget（`pi-web-access` 的活动面板用它）。**不给 basis** ——
      // 给了就把高度钉死，面板里的内容一变就错位（同下面队列面板的理由）。
      ...[...widgetSlots.values()].map((component) => ({ component, minSize: 1 })),
      // 队列面板在输入框**之上** —— 用户敲完字、回车之前就该看到刚才排了什么。
      { component: queuePanel, minSize: 1 },
      // **没有单独的 loader 那行**：工作状态（思考中 / 压缩中 / 重试）画在 editor 的
      // 上框线里（`embedWorkingStatus`，与 pi 同形）。所以 editor 直接坐在队列面板与
      // 底栏之间，不多吃一行。
      { component: editor, minSize: 3 },
      // 底栏行数 = `FOOTER_ROWS`，与 `/model`、`/sessions` 那些面板的
      // `margin.bottom` **同一个来源** —— 面板底边要落在 composer 的底边上，
      // 而那个位置就是「底栏几行」决定的。两处各写一个数字就会漂移：
      // 底栏改成三行时面板会悬空一行，且症状很难归因。见 `composer-overlay.ts`。
      { component: footer, basis: FOOTER_ROWS, grow: 0, minSize: FOOTER_ROWS },
    ]);
    tui.setLayoutRoot(
      new VStack([
        // 顶行：页签 + 统计（**一行顶行**，不是两行 —— 见 tabs 的注释）。
        // 写清当前在哪个页、这轮跑到哪了、以及怎么切（**不写在别处**，否则得记两处）。
        { component: tabs, basis: 1, grow: 0, minSize: 1 },
        // 中间那块 = 当前页。primary 跟着 page 走。
        { component: page === 'trace' ? traceScroll : scroll, basis: 0, grow: 1, minSize: 3 },
        bottom,
      ]),
    );
  }
  applyLayout();

  tui.setFocus(editor);
  // **先填内容再 start()**：tabs / footer 初始是空串，pi-tui 量高度时得到 0，
  // 于是那两行在布局里塌掉 —— 屏幕上只剩编辑器那两条横线，顶行与底栏都不见了。
  // （首帧必须可见，所以这里就要有内容；不能指望「用户发一条消息后 store 变化触发
  //  refresh」—— 启动时 store 根本没变。）
  refresh();
  tui.start();

  // 让官方渲染器的计时器能真的推动重绘：bash 块跑着时它每秒发一次
  // `requestRender()`（为了跳 `Elapsed` 那行）。不装就是 no-op，计时器空转、屏幕不重画。
  // 推迟执行与重入护栏在 `setRendererRenderRequest` 内部（理由见那里的注释）——
  // 护栏必须放在**所有**调用方都躲不掉的地方，不能只在这一处记得。
  setRendererRenderRequest(() => {
    refresh();
    tui.requestRender();
  });

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
  const extensionEntries = (options.extensions?.entries ?? []).filter((e) => !e.hidden);
  const extensionErrors = options.extensions?.errors ?? [];
  // `[Context]` 那一节：进了 prompt 的上下文文件（`SYSTEM.md` / `APPEND_SYSTEM.md` /
  // `AGENTS.md` …）。清单由 `contextFilePaths()` 给，与 `buildPromptOptions()` **同一个来源** ——
  // 界面报的和模型收到的必须是同一批文件（理由见 `system-prompt.ts` 那个函数的注释）。
  const contextFiles = contextFilePaths(cwd);
  // 护栏要把上下文与扩展也算进去：只装了扩展没装 skill（或反过来）时，这几节**照样**要出。
  // 早先写成只看 skill，于是「一个 skill 都没装」的用户永远看不到扩展清单 ——
  // 而那恰好是最需要看到的人（他们不靠 skill，只靠扩展）。
  if (
    contextFiles.length > 0 ||
    startupSkills.length > 0 ||
    startupDiagnostics.length > 0 ||
    extensionEntries.length > 0 ||
    extensionErrors.length > 0
  ) {
    const lines: string[] = [];
    // 与 pi 同形：家目录缩 `~`，在 cwd 下的保持相对。
    if (contextFiles.length > 0) {
      lines.push(
        `${yellow('[Context]')}\n${dim(contextLabels(contextFiles.map((p) => ({ path: p })), cwd, homedir()).join(', '))}`,
      );
    }
    if (startupSkills.length > 0) {
      // 形状照 pi 的 `formatCompactList()`：**排序**后逗号连排，剩下交给终端折行。
      // 不排序的话清单顺序取决于目录遍历，每次启动都不一样。
      // 55 个名字折成十几行是正常的（pi 的截图里也是 6 行）—— 不截断：
      // 名字列表的价值就在于能扫到某一个。
      const names = startupSkills.map((s) => s.name).sort((a, b) => a.localeCompare(b));
      lines.push(`${yellow('[Skills]')}\n${dim(names.join(', '))}`);
    }
    // 与 pi 同形：`[Skill conflicts]`。加载不上的 skill 要看得见 ——
    // 否则就是「模型静默少了能力」，而用户与界面都不知道为什么。
    if (startupDiagnostics.length > 0) {
      lines.push(
        `${yellow('[Skill conflicts]')}\n` +
          startupDiagnostics.map((d) => yellow(`  ${d}`)).join('\n'),
      );
    }
    // **常驻**（不靠 notify）：pi 的开场那一节也是 `loadedResourcesContainer` 里的
    // 常驻组件，永不消失。skill 名单要反复对照着打 `/skill:x`，30 秒后就没了等于没有。
    //
    // 这一节报的是**扩展**（入口 + 来源），不是它注册的工具名 —— 见
    // `resource-labels.ts` 的文件头：报工具名会让用户拿着工具名去 `packages` 里找扩展。
    if (extensionEntries.length > 0) {
      lines.push(`${yellow('[Extensions]')}\n${dim(extensionLabels(extensionEntries).join(', '))}`);
    }
    if (extensionErrors.length > 0) {
      lines.push(
        `${yellow('[Extension issues]')}\n` + extensionErrors.map((e) => yellow(`  ${e}`)).join('\n'),
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
 * `requestRender` **必须真的去请求重绘**：官方 bash 渲染器靠它每秒刷新一次
 * `Elapsed`（`renderResult` 里那个 `setInterval(() => context.invalidate(), 1000)`）。
 * 给一个 no-op 的话计时器照跑，但屏幕不重画 —— 秒数还是不会跳。
 *
 * 默认是 no-op（管道一次性模式没有帧循环）；`runTui` 启动时把自己装上，
 * 见 `setRendererRenderRequest`。
 */
const TOOL_UI = {
  requestRender: () => {
    requestRenderFromRenderer();
  },
  invalidate: () => {},
};

/** `TOOL_UI.requestRender` 实际的落点。默认 no-op，见上面 `TOOL_UI` 的注释。 */
let requestRenderFromRenderer: () => void = () => {};

/**
 * 已排了一个微任务：官方组件每帧能发好几次请求，只要一次重画就够。
 * @see setRendererRenderRequest
 */
let rendererRenderQueued = false;
/** 正在跑回调：真正的递归路径（渲染途中又发请求）靠它挡住。@see setRendererRenderRequest */
let rendererRendering = false;

/**
 * `runTui` 装上自己的重绘入口；管道/一次性模式不调，于是保持 no-op。
 *
 * ## 为什么这里必须推迟到微任务 + 重入护栏
 *
 * 官方 `ToolExecutionComponent` 在**我们自己的渲染过程中**就会调 `ui.requestRender()`：
 * `markExecutionStarted()` 与 `setArgsComplete()` 的实现就是 `updateDisplay();
 * ui.requestRender();`，而 `renderTool` 每渲染一个工具块都要走这两步。
 *
 * 同步接上 `refresh` 就是无限递归：
 *
 *     refresh → transcript.update → blockLines → renderMessage → renderTool
 *            → component.markExecutionStarted → ui.requestRender → refresh → …
 *
 * 症状是 `RangeError: Maximum call stack size exceeded`，栈帧正好是上面这条链。
 * `TOOL_UI.requestRender` 早先是空实现，链是断的，所以这条路径一直没暴露过。
 *
 * ## 为什么推迟就够
 *
 * `context.invalidate()` 才是官方的重画入口（`getRenderContext` 里绑的），而它已经
 * 顺手清了组件自己的 `render()` 缓存 —— 官方要的是「下一帧被重画」，不是「此刻同步
 * 重画」。状态变化本身由 `store.subscribe` → `refresh` 覆盖，不依赖这条路。
 * 所以改成微任务后行为不变，只是不再递归。
 *
 * 两道闸缺一不可，而且**都必须在入口处判**：
 *
 *   - `queued`：合并一帧内的多次请求（官方组件一帧能发好几次）。
 *   - `rendering`：渲染途中发来的请求**直接丢掉**。
 *
 * ## 为什么 `rendering` 一定要在入口判
 *
 * 这一点很反直觉，值得钉住：只把请求推迟到微任务、而 `rendering` 只在微任务里判，
 * 得到的是**自激循环而不是爆栈**——
 *
 *     微任务: rendering=false → 进 fn → fn 里渲染 → 发请求 → 排队 → fn 返回
 *     → rendering=false → 下一个微任务又进 fn → …
 *
 * 每轮都排一个新微任务，而微任务队列会一直有新任务，V8 根本没有机会走
 * “栈太深”，于是栈一直是浅的、堆一直涨 —— 症状是跑几分钟后
 * `FATAL ERROR: heap out of memory`，而不是 `Maximum call stack size exceeded`。
 * （本仓库第一版修复就是这么翻车的：测试直接 OOM。）
 *
 * 入口处先看 `rendering` 就断了环：渲染途中来的请求一律丢弃。
 * 丢弃是安全的 —— 此刻这一次 `fn` 正在把组件的新内容带上（官方组件的
 * `context.invalidate()` 已经清了它自己的 `render()` 缓存），再画一帧只是白做一倍工作。
 */
export function setRendererRenderRequest(fn: () => void): void {
  requestRenderFromRenderer = () => {
    // **两道闸都在入口判**：渲染途中发来的请求直接丢掉（否则自激到 OOM），
    // 同一帧内已排过微任务就不再排第二个。
    if (rendererRendering || rendererRenderQueued) return;
    rendererRenderQueued = true;
    queueMicrotask(() => {
      rendererRenderQueued = false;
      // 排队期间可能已经进了另一次渲染（同步路径也走 fn），那就让那一次带上。
      if (rendererRendering) return;
      rendererRendering = true;
      try {
        fn();
      } finally {
        rendererRendering = false;
      }
    });
  };
}

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
  // **组件跨帧复用**（而不是每帧新建一个）—— 这样官方渲染器自己的
  // `setInterval(..., 1000)` 能一直在，`Elapsed` 才会每秒自己跳。
  const component = liveToolComponent(call, width);
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
  // 组件是跨帧复用的，interval 会一直留着 —— unref 一下，让它不阻止进程退出
  // （见 unrefRendererTimers 的注释：为什么与 pruneLiveTools 是两件不同的事）。
  unrefRendererTimers(component);
  return component.render(usableWidth(width));
}

/**
 * 正在跑的工具的**长生命周期**组件，按 toolCallId 缓存。
 *
 * ## 为什么必须有它（而不是每帧 new 一个）
 *
 * 官方 bash 渲染器在 `renderResult` 里看到 `isPartial` 时会
 * `setInterval(() => context.invalidate(), 1000)`，让 `Elapsed` 那一行每秒重画一次。
 * 而它只在**同一个组件**收到非 partial 的 `updateResult` 时才 clearInterval ——
 * 中间没有「收尾」的话，每个 interval 都永久留着，事件循环永远不空。
 *
 * 每帧 new 一个 + 每帧 `stopRendererTimers()` 能避开泄漏，代价是 `Elapsed` 再也不跳
 * （计时器刚起就被我们自己清了）：命令跑几十秒而中间没输出时，那行永远显示 `0.0s`。
 * 组件跨帧活着，官方自己的定时器就能正常跑完整个生命周期 —— 与 pi 一致。
 *
 * ## 泄漏怎么收口
 *
 * 组件只在工具**真的在跑**时留在表里；`pruneLiveTools` 每帧按 state 里的
 * `executing` 清掉已结束的，所以时长生命周期 = 工具执行时长，不是会话时长。
 * 计时器在清掉时也被 `stopRendererTimers` 停掉（官方组件自己的
 * `invalidate` 链路已经不适用了，所以由我们代劳）。
 *
 * ## 会不会拖累增量渲染
 *
 * 不会。带运行中工具的那个消息块**本来就不进缓存**（`TranscriptChunks.blockLines`
 * 的 `isLive` 分支每帧重算），而且一轮里在跑的工具都挂在同一条 assistant 消息上，
 * 这样的块至多一个。所以让组件活着不增加任何缓存失效 —— 保护长会话的那套
 * 增量优化（O(N²) → O(N)）只作用于历史块，与这块无关。
 */
const liveTools = new Map<string, ToolExecutionComponent>();
/** 建组件时的终端宽度 —— 变了要重建（官方组件按建时宽度折行）。 */
const liveToolWidths = new Map<string, number>();

/** 取（或建）某个正在跑的工具的组件。宽度变了要重建——官方组件按建时的宽度折行。 */
function liveToolComponent(call: ToolCall, width: number): ToolExecutionComponent {
  const existing = liveTools.get(call.id);
  // `imageWidthCells` 是建时烤进去的，宽度变了不复用会被按旧宽度折行（行数凭空变化）。
  if (existing !== undefined && liveToolWidths.get(call.id) === width) return existing;
  if (existing !== undefined) stopRendererTimers(existing);
  const component = new ToolExecutionComponent(
    call.name,
    call.id,
    (call.arguments ?? {}) as Record<string, unknown>,
    { showImages: false, imageWidthCells: usableWidth(width) },
    TOOL_RENDERERS[call.name] as never,
    TOOL_UI as never,
    process.cwd(),
  );
  // markExecutionStarted 必须在第一次 updateResult **之前**：官方渲染器的
  // `renderResult` 靠它记下的 startedAt 才能算出准的 Elapsed。
  component.markExecutionStarted();
  component.setArgsComplete();
  liveTools.set(call.id, component);
  liveToolWidths.set(call.id, width);
  return component;
}

/**
 * 丢掉已经不在跑的工具的组件（并停掉它们的定时器）。
 *
 * 每帧调用。判据是 `state.executing` —— 工具结束时 reducer 已经把它移出那里，
 * 于是下一帧就被回收。**必须每帧调**：否则已结束的工具会永远留在表里，
 * 而组件里的 interval 也永远不清 —— 症状是「跑过一次工具的进程退不出来」。
 */
function pruneLiveTools(state: AgentState): void {
  if (liveTools.size === 0) return;
  const running = new Set((state.executing ?? []).map((t) => t.call.id));
  for (const [id, component] of liveTools) {
    if (running.has(id)) continue;
    stopRendererTimers(component);
    liveTools.delete(id);
    liveToolWidths.delete(id);
  }
}

/**
 * 让官方渲染器的计秒定时器**不阻止进程退出**（`unref`）。
 *
 * ## 为什么要这个
 *
 * 组件跳 `Elapsed` 靠官方的 `setInterval(..., 1000)`，而那个 interval 默认是 **ref'd**：
 * 只要它在，Node 的事件循环就非空，进程就退不出来。而它的作用仅仅是「每秒叫醒一次
 * 重画」—— 它不是任何待完成的工作。于是它完全不该成为进程退出的障碍。
 *
 * 这个坑的实际症状：任何跑过一次流式工具的进程（含全部测试）都会挂住不退出，
 * 只能靠 `timeout` 杀掉 —— 症状与「组件每帧新建、interval 从不回收」那个旧 bug 一模
 * 一样，但成因不同（一个是泄漏，一个是 ref）。所以**回收（`pruneLiveTools`）与
 * `unref` 两道都要有**：
 *   - `unref` 管「别卡住退出」（interval 继续跑、秒照跳）；
 *   - `pruneLiveTools` 管「别无限堆积」（工具结束后组件与 interval 一起释放）。
 *
 * 只 `unref` 不回收 → 会话跑几百个工具就攒几百个组件（内存泄漏）。
 * 只回收不 `unref` → 进程退不出来。
 */
function unrefRendererTimers(component: ToolExecutionComponent): void {
  const state = (component as unknown as { rendererState?: Record<string, unknown> })
    .rendererState;
  if (state === undefined) return;
  for (const value of Object.values(state)) {
    if (value === null || typeof value !== 'object') continue;
    const handle = value as { unref?: () => void };
    if (typeof handle.unref === 'function') handle.unref();
  }
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
  /**
   * `/hotkeys` 那一块（贴在这轮对话**之后**，与 pi 把键位表 append 进 chat 一致）。
   *
   * 按**数组引用**判断变没变：调用方（`refresh`）按宽度缓存了渲染结果，所以宽度不变
   * 时引用也不变。用「拼成一个字符串再比」也行，但那要每帧 join 一次整张表 —— 而这张表
   * 有二十来行、带表格框线，而对话区的铁律是「没变的块不重算」。
   */
  private readonly hotkeysBlock: Text;
  private lastHotkeysLines: readonly string[] | undefined;

  constructor() {
    this.noticeBlock = new Text('', 0, 0);
    this.bannerBlock = new Text('', 0, 0);
    this.streamBlock = new Text('', 0, 0);
    this.tail = new Text('', 0, 0);
    this.hotkeysBlock = new Text('', 0, 0);
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
    /**
     * `/hotkeys` 的行（不给 = 不显示）。
     *
     * 为什么是**渲染好的行**而不是原始 markdown：宽度一变就要重排，而宽度只有调用方
     * 知道（它还顺便按宽度缓了那份结果）。组件这一侧只负责「内容变了就 setText」。
     */
    hotkeys?: readonly string[],
  ): void {
    // 回收已结束的工具组件（**在渲染任何块之前**：工具刚跑完时 reducer 已把它移出
    // `executing`，于是这一帧就该把它的组件与 interval 一起清掉）。
    // 每帧一次，而不是每条消息一次。
    pruneLiveTools(state);
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
    // 引用比对（见字段注释）：同一份行数组就不碰组件，重排与 markdown 解析都省了。
    if (hotkeys !== this.lastHotkeysLines) {
      this.lastHotkeysLines = hotkeys;
      this.hotkeysBlock.setText(
        hotkeys === undefined || hotkeys.length === 0 ? '' : `${hotkeys.join('\n')}\n`,
      );
    }
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
    lines.push(...this.hotkeysBlock.render(at));
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
    this.hotkeysBlock.invalidate();
  }
}

/**
 * composer **上框线**上该显示的工作状态（`undefined` = 空闲，什么都不画）。
 *
 * ## 为什么在这里现推，而不是维护一个 `lastMessage` 变量
 *
 * 三个状态（思考中 / 压缩中 / 重试）各自有进入与退出条件，而且**交错**：重试发生在
 * 一轮之内、压缩发生在一轮之外（那段时间 `phase` 还是 idle）。早先是用一串 if/else
 * 加一个 `lastLoaderMessage` 变量手工收尾，漏一处的症状是「圈一直转」或「文案洇在那儿」。
 * 现推就没有这笔账 —— 同一份 state 永远推出同一个结果，幂等。
 *
 * ## 优先级
 *
 * 重试 > 压缩 > 生成。重试看着像「还在跑」，但它带的是「第 N/M 次」那个更有信息的
 * 文案，而且它确实是当前最该知道的一件事。
 *
 * ## 为什么重试那句从 `renderTail` 搬到这里
 *
 * pi 把工作状态放在上框线上，而「重试中」就是一个工作状态。放两处（尾巴一行 +
 * 上框线一行）会同一件事报两遍。所以 `renderTail` 里那条删了，只剩上框线这份。
 */
export function workingStatusText(state: AgentState): string | undefined {
  if (state.retrying) {
    return `↻ 正在重试（第 ${state.llmAttempts}/${state.maxLlmAttempts} 次尝试）`;
  }
  if (state.compacting) return '压缩中…';
  if (state.phase !== 'idle') return '思考中…';
  return undefined;
}

/**
 * 对话区**尾部**那些不属于任何单条消息的行：正在流式生成的文字、收工原因。
 *
 * 从 `renderTranscript` 里原样搬出来的，所以两处画出来的东西一致。
 *
 * 注意**不含**正在流式生成的文字：那一段由 `TranscriptChunks` 单独一个块负责
 * （它每帧都变，必须独立才能只重画它）。`renderTranscript` 里仍然拼上它，
 * 因为那是一趟性渲染，形状必须与界面一致。
 *
 * 也**不含**重试那行：它与「思考中 / 压缩中」一样是工作状态，画在 composer 的
 * 上框线里（见 `workingStatusText()`）—— 那是 pi 的位置。
 */
export function renderTail(state: AgentState, width: number): string[] {
  const lines: string[] = [];
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
      lines.push(dim(`  按 ${keyLabel('app.trace.toggle')} 看轨迹树`));
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
