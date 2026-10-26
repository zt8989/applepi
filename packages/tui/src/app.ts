/**
 * 终端界面 —— pi-tui（差分渲染的 TUI 库）驱动，环仍然只由本项目的 Redux Loop 跑。
 *
 * 这个文件不含环的逻辑：只订阅 store、把状态画出来。界面是**整页切换**的两块（中间那块按 `page`
 * 换内容）：对话页（用户说了什么、LLM 答了什么、工具做了什么）与轨迹页（`Ctrl+R` 切换，键位可改；
 * 像 `git log --graph` 一样的一次尝试一节点，失败/超时也是节点）。
 *
 * 顶行是页签 + 轨迹统计合一行，底栏是 cwd / 用量 + 模型。pi-tui 的差分渲染是关键：流式 token
 * 一个个进来时只重画变化的行，不会整屏闪烁。
 */
// pi-tui 1.x：`TUI` 是共享**接口**，实例化要选具体渲染器。
// TuiAltScreen  = 真正的全屏：占满视口，终端不留回滚缓冲，界面自己管滚动。
// TuiMainScreen = 让出回滚缓冲（内容永久留在终端历史里，能往上翻）。
// 对话式 agent 用前者：输入框要钉在底部、对话区独立滚动，滚出去的内容不该污染终端回滚。
import {
  ProcessTerminal,
  Spacer,
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
import { abortRun } from '@ela/core/run-control';
import { traceRows, traceStats, formatDuration, shortId, type TraceNode, type TraceTree } from '@ela/core/trace';
import {
  deriveStream,
  streamMessages,
  type StreamEntry,
  type StreamNoticeEntry,
} from '@ela/core/stream';
import type { AgentState, QueuedInput, QueueKind } from '@ela/core/state';
import type { AgentStore } from '@ela/core/store';
import type { KernelReloadReport } from '@ela/core/kernel';
import type { AgentAction } from '@ela/core/actions';
import type { Message, ToolCall } from '@earendil-works/pi-ai';
import {
  findSessionFile,
  listSessions,
  readSessionName,
  resumeCommand,
  type SessionSummary,
} from '@ela/core/config-home';
import { appendSessionName } from '@ela/core/session-file';
import { deleteSessionTrace, loadSessionMessages, openSessionPicker } from './session-picker';
import { collectSessionStats, formatSessionCard } from './session-info';
import { FOOTER_ROWS } from './composer-overlay';
import {
  openModelPicker,
  openScopedModelsPicker,
  modelRuntimeFor,
} from './model-picker';
import { openThinkingPicker } from './thinking-picker';
import { openSettingsPicker } from './settings-picker';
import {
  DEFAULT_THINKING_LEVEL,
  clampForModel,
  isThinkingLevel,
  readAllModelThinkingLevels,
  readDefaultThinkingLevel,
  removeModelThinkingLevel,
  writeDefaultThinkingLevel,
  writeModelThinkingLevel,
} from '@ela/core/thinking-level';
import { NO_SCOPE, readScopedModels, writeDefaultModel, readHideThinkingBlock, writeHideThinkingBlock, type ModelScope, type ScopedModelItem } from '@ela/core/model-scope';
import { t } from '@ela/core/i18n';
import type { AgentRuntime } from '@ela/core/provider';
import type { Model, ModelThinkingLevel } from '@earendil-works/pi-ai';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
// ─── pi 官方的对话/工具渲染器 ───
//
// 用户蓝底、思考灰斜体、工具块的绿/红底色、write 的内容预览、edit 的彩色 diff、
// bash 的 `Took 0.5s` 与「保留尾部 5 行」的折叠 —— 这些**全部**来自 pi 自己的组件。
// 自己照着截图重画过一次，结果每个工具的折叠策略、底色边界都对不齐；
// 直接用官方组件后，形状与 pi 逐行一致（截图里深绿 rgb(37,65,49) 就是
// `theme.colors.toolSuccessBg` 的值）。
//
// 依赖内部子路径（`dist/...`）需要 pnpm patch，见 docs/architecture/provider.md。
// theme 必须先 setupTheme()，否则这里读 theme.colors 会抛（见 packages/tui/src/theme.ts）。
import { AssistantMessageComponent } from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/assistant-message.js';
import { SkillInvocationMessageComponent } from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/skill-invocation-message.js';
import { UserMessageComponent } from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/user-message.js';
import { ToolExecutionComponent } from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js';
// `ctx.ui.select/confirm/input` 的终端组件（pi 自己那两个）。深路径导入：从包根引
// 会把整个交互层（含它自己的启动器）拖进来。
import { ExtensionInputComponent, ExtensionSelectorComponent } from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/index.js';
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { getMarkdownTheme, getEditorTheme, theme, type Theme } from '@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';// pi 底栏的官方实现（靠 pnpm patch 打开的子路径）。数字格式与算法都与 pi 一致 ——
// 两边对不上会让人以为算错了。
// 见 docs/architecture/provider.md「为什么要 pnpm patch」。
import { formatCwdForFooter, formatTokens } from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js';
  // 官方那个把工作状态画进**上框线**的编辑器（`embedWorkingStatus: true`），与 pi 同一个类。
  //
  // 配色直接用 pi 的 `getEditorTheme()`：手写一份会让横线颜色分家（pi 用
  // `theme.getThinkingBorderColor(level)`，而 `dim` 是文本属性不是颜色 token），补全列表的选中色也会
  // 分家（`accent` vs `cyan`）。它内部读 pi 主题，**必须**在 `setupTheme()` 之后调。
  //
  // 形状交给 typecheck，写错时**不要**用 `as unknown as EditorTheme` 压住：那个 cast 会让
  // `this.theme.selectedText is not a function` 在渲染时才爆，而补全列表渲染失败只表现为「打 `/`
  // 什么都没弹」，极难归因。
  //
  // keybindings 也要传：`CustomEditor` 的构造签名要它，且必须与面板 / `keyLabel()` 用**同一份**，
  // 不然用户改过的键在这里不生效。
import { CustomEditor } from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-editor.js';
import {
  WorkingStatusIndicator,
  type StatusIndicator,
} from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/status-indicator.js';
import { addUsageToTotals, createUsageTotals } from '@earendil-works/pi-coding-agent/dist/core/usage-totals.js';
import { setupTheme } from './theme';
import { actionMatches, installProjectKeybindings, keyLabel } from './keybindings';
import { hotkeysMarkdown, renderHotkeys } from './hotkeys';
// 「完全复用 pi」里那几条纯逻辑（循环模型 / 循环思考级别）—— 见 pi-actions.ts 的文件头。
import { modelKey, nextCycleIndex, nextThinkingLevel, supportedThinkingLevels } from './pi-actions';
// pi 自己的外部编辑器与剪贴板实现 —— 复用它，不自己 spawn $EDITOR / 调 pbcopy。
import { editInExternalEditor } from '@earendil-works/pi-coding-agent/dist/modes/interactive/external-editor.js';
import { readClipboardFilePaths, readClipboardText, copyToClipboard } from '@earendil-works/pi-coding-agent/dist/utils/clipboard.js';
import { SettingsManager } from '@earendil-works/pi-coding-agent/dist/core/settings-manager.js';
import { piAgentDir } from '@ela/core/pi-config';
import { extensionForImageMimeType, readClipboardImage } from '@earendil-works/pi-coding-agent/dist/utils/clipboard-image.js';
import { contextLabels, extensionLabels } from './resource-labels';
import { contextFilePaths } from '@ela/core/system-prompt';
import type { DialogHost, HostUiOptions, TuiDialogs } from '@ela/core/extension-ui';
import type { QuestionnaireSession } from '@ela/core/questionnaire';
import type { ExtensionCommands } from '@ela/core/extension-commands';
import type { ExtensionEntry } from '@ela/core/extension-host';
import { expandSkillCommand, parseSkillMessage, skillCommands, skillsInPrompt, type SkillInfo } from '@ela/core/skills';
import {
  expandPromptTemplate,
  promptCommands,
  promptTemplatesInPrompt,
  type PromptTemplateInfo,
} from '@ela/core/prompts';

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

// 工具块的底色、边框色、路径色、diff 绿/红……全部由 pi 的 theme 给（见 packages/tui/src/theme.ts），
// 不在这里手写 `rgbColor(0x12, 0x26, 0x1a)` 了。
//
// 不按截图手写颜色：亮色终端上那块深绿会变成一坨脏东西，用户蓝底只能用不透明的 ANSI 34（不会铺满
// 整行），思考的斜体也没有对应色。交给 theme 之后四个 token 都**跟着终端深浅色走**，降级（真彩 →
// 256 → 16）由 pi-tui 处理。

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
    case 'model.changed':
      // 换模型 / 换档位 —— 与装载同色（都是模型上下文的事），靠 label 里的名字区分。
      return dim;
    // 生命周期注释（内核告诉了扩展什么）：与 `prompt.*` 同族 —— 背景信息，暗色。
    case 'extension.event':
      return dim;
  }
}

/**
 * 轨迹面板：**一个节点一个块**的增量渲染。
 *
 * 不能用一块 `Text` 画整棵树：每帧重算整棵树（实测单次 4~6ms，而一个长工具输出能刷几百帧），
 * 而且 `Text` 的高度就是内容高度 —— 被布局裁掉的部分**永远回不来**，面板既不滚动也没有分页，
 * 节点一多就「后面看不到、滚也滚不动」。
 *
 * 改成与对话区同构：每个节点一个 `Text`（下标与 `tree.order` 对应），只在那一个节点的内容真变了
 * 才 `setText`；外层包 `ScrollView` + `follow: 'end'`；节点变少（`/new`、恢复别的会话）就把多余
 * 的块丢掉。
 *
 * 不用 pi 的 `CollapsibleRender`：轨迹是**时间线**，关掉一个节点不该让它的子节点消失。
 */

/**
 * 把「**只有空格、没有任何转义序列**」的行折成空串。
 *
 * 对话区每个块都是 pi-tui 的 `Text`，而 `Text.render()` 会把每一行补空格到全宽 —— 官方组件里那些
 * 本来返回空串的「空隙」行（`Spacer(1)`、Markdown 空段）经它一过就成了整行空格。代价在选区上：
 * `TuiAltScreen` 按「行 + 列」算选中，宽度 > 0 的行会**整行**刷成反显，于是拖选跨过卡片间隙时
 * 会扫过一条整行高的亮条。复制出来的文本两边一样（pi-tui 逐行 `trimEnd()`），所以只对齐「看得见
 * 的那部分」。
 *
 * 判据：剥掉转义序列后没有可见字符**且不带样式**。带底色的 padding 行不能动（那是卡片的一部分）；
 * 只有 **OSC 133 区域标记**加空格的行**只剪尾部空格**、标记留着 —— 那是 `scrollToPrompt` 的锚点。
 */
const SGR_SEQUENCE = /\u001b\[[0-9;]*m/;
/**
 * 整行只由「转义序列 + 空格」组成 —— 屏幕上没有任何可见字符。
 *
 * 写成一个锚定的整体匹配（而不是先 `stripTerminalSequences()` 再 `trim()`）是为了**快**：
 * 这个函数每帧都会把整个对话区的行过一遍（历史 1200 条时上千行），而绝大多数行是内容行
 * —— 它第一个可见字符就匹配失败退出了。碰到不认识的转义形式也不怕：匹配不上就**不动**
 * 那一行（宁可不剪，也不要把带样式的行错剪成零宽）。
 */
const BLANK_ROW = /^(?:\u001b\[[0-9;]*[A-Za-z]|\u001b\][^\u0007]*\u0007|[ \t])*$/;
function collapseBlankRows(lines: string[]): string[] {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line === '') continue;
    // 有可见字符（绝大多数行在这一步就退出）。
    if (!BLANK_ROW.test(line)) continue;
    // 带样式（SGR）的空行是带底色的 padding，属于卡片本身。
    if (SGR_SEQUENCE.test(line)) continue;
    lines[i] = line.replace(/[ \t]+$/, '');
  }
  return lines;
}

export class TraceChunks implements Component {
  /** 每个节点一个 `Text`，下标与 `tree.order` 一一对应。 */
  private readonly blocks: Text[] = [];
  /** 每个块上次 `setText` 的内容 —— 「变没变」的判据。 */
  private readonly lastTexts: (string | undefined)[] = [];
  /**
   * 每个块上次渲染时那个**节点对象**。
   *
   * `TraceNode` 的字段全是 `readonly`，`patchNode()` 改一个节点时会
   * `{ ...existing, ...patch }` 造一个**新对象** —— 所以「引用没变」就等于
   * 「这个节点一个字都没动」：`lineOf()` 连算都不用算。
   *
   * 这正是旧版缺的那一步：旧版虽然也只在文本变了才 `setText`，但**每一帧都要
   * 对全部节点重算 `lineOf()`**（而里面是 `truncateToWidth` → `Intl.Segmenter`，
   * 实测 1600 节点/帧 ~15ms）。而 `refresh()` 是每个流式 token 一次的 ——
   * 于是长会话下每个 token 都在为「几百个早就不动的节点」重新分词。
   */
  private readonly lastNodes: (TraceNode | undefined)[] = [];
  /**
   * 每个节点这一行的**轨道前缀**（`│  │  ○  ` 那一段）。
   *
   * 由 `traceRows()` 算 —— 与命令行、`renderColoredTree()` 是同一个函数，
   * 所以界面里看到的树与 `ela` 退出时打到 stdout 的树是同一份画法。
   *
   * ## 为什么缓存而不是每帧算
   *
   * 轨道前缀只跟**结构**有关（容器开没关、谁是 tip），与「标签写了什么」无关：
   * 流式 token 一帧里节点只被 `patchNode()` 换了标签，轨道一个字没变。
   * 所以按 `syncLayout()` 里那个 key（会话 + 节点数 + tip）缓存，一帧只查表。
   */
  private layout: Map<string, string> = new Map();
  /** 上面那份缓存的 key（见 `syncLayout`）。 */
  private layoutKey = '';
  /** 上一条 tip —— 换人时**加粗**要从旧那行挪到新那行（见 `syncLayout`）。 */
  private lastTipId: string | null = null;
  /** 宽度变了要清折行缓存（`Text` 按宽度分桶缓存）。 */
  private lastWidth = 0;
  /** 空树时那句说明单独一块（它不是节点）。非空时这一块不出现，见 `update()`。 */
  private readonly noticeBlock = new Text('', 0, 0);
  /** 上一帧的说明文案（一样就不必 `setText`）。 */
  private lastNotice = '';
  /** 上一帧是不是空树（决定 `render()` 里要不要把说明那一块算进去）。 */
  private showingNotice = false;
  /** 空树时显示的那句（开场就空着，得说清楚「不是坏了」）。 */
  private emptyText = '';

  /**
   * 同步到最新状态。**只算变化的那几个节点。**
   *
   * 「变了」的判据是**节点对象的引用**（见 `lastNodes`）：`patchNode()` 会造新对象，
   * 所以引用没变就是内容没变，那一行的 `lineOf()`（含 `Intl.Segmenter` 分词）直接跳过。
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
      this.lastNodes.length = order.length;
    }
    this.syncLayout(tree);
    for (let i = 0; i < order.length; i += 1) {
      const id = order[i];
      const node = id === undefined ? undefined : tree.nodes[id];
      if (node === undefined) continue;
      let block = this.blocks[i];
      // ── 增量：这个节点一个字都没动，就别重算这一行 ──
      //
      // `lastNodes[i] === node`（引用相等）= 还是那个节点对象 = 内容没变。
      // 这时只需处理「只是宽度变了」（块的折行缓存按宽度分桶）。
      //
      // 但**只在块已经存在时**才能跳过：第一次见到的节点必须走下面的完整路径
      // （要建块、要算行）。
      if (block !== undefined && this.lastNodes[i] === node) {
        if (widthChanged) block.invalidate();
        continue;
      }
      const line = this.lineOf(node, tree, width);
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
      // 记下这次用的是哪个对象：下一帧引用没变就直接跳过（见循环开头）。
      this.lastNodes[i] = node;
    }
    // 空树时给一句说明，而不是留一个 0 高的块（0 高度会让整块在布局里消失，
    // 于是「按了切页键没反应」与「面板塌了」看起来一模一样）。
    //
    // 非空时这一块**完全不出现** —— 以前它是 `HEAD → <tipId>`，现在 tip 就是树上
    // 那一行（加粗），再写一行就是重复。
    this.showingNotice = order.length === 0;
    if (this.showingNotice && this.lastNotice !== emptyText) {
      this.noticeBlock.setText(dim(emptyText));
      this.lastNotice = emptyText;
    }
    this.lastWidth = width;
  }

  /**
   * 同步轨道布局缓存（只在**结构**变了时重算），并处理 tip 换人。
   *
   * ## 两件事分开算：前缀看结构，加粗看 tip
   *
   * 轨道前缀只取决于：哪棵树（会话 id）、有多少个节点（节点只增不减，所以个数就是
   * 结构版本）。tip **不改字形**（所有节点都是 `○`，见 trace.ts），它只决定哪一行
   * 加粗 —— 而加粗是 `lineOf()` 里现算的，不进这份缓存。
   *
   * 反过来说，「闭合一个容器」也不需要重算前缀：闭合点的出现本身就是**新节点**
   * （`step.end`），节点数变了，key 变了。
   */
  private syncLayout(tree: TraceTree): void {
    const key = `${tree.sessionId}|${tree.order.length}`;
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      this.layout = new Map<string, string>();
      for (const row of traceRows(tree, { maxWidth: 0 })) this.layout.set(row.node.id, row.prefix);
    }
    // tip 换人：加粗从旧那一行挪到新那一行 —— 这是**两行都变了**（一边去掉加粗、一边加上），
    // 而它们在 `lastNodes` 里的引用没变（节点本身一个字没动），所以得**主动**作废，
    // 否则增量逻辑会跳过这两行，加粗就留在原地（或者根本不上）。
    //
    // 新 tip 也要作废：多数时候它是刚追加的新节点（已经会重算），但并非总是 ——
    // 单靠「新节点引用是新的」当保证，就会得到一个「偶发不加粗」的 bug。
    if (this.lastTipId !== tree.tipId) {
      for (const id of [this.lastTipId, tree.tipId]) {
        if (id === null) continue;
        const at = tree.order.indexOf(id);
        if (at >= 0) this.lastNodes[at] = undefined;
      }
      this.lastTipId = tree.tipId;
    }
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
    if (this.showingNotice) lines.push(...this.noticeBlock.render(at));
    return collapseBlankRows(lines);
  }

  invalidate(): void {
    for (const block of this.blocks) block.invalidate();
    this.noticeBlock.invalidate();
  }

  /**
   * 一个节点那一行的**带色**文本。
   *
   * 轨道前缀从 `syncLayout()` 的缓存里取（与 `renderTree` / `renderColoredTree`
   * 出自同一个 `traceRows()`）；这里只负责把这一行**上色**。
   *
   * 刻意**不**调 `renderTree`：那个函数是「整棵树一坨字符串」的形状，而增量渲染
   * 要的是「这一行自己什么样」。两边共用轨道与颜色，所以命令行里看到的树与界面里
   * 看到的仍然是同一份画法。
   */
  private lineOf(node: TraceNode, tree: TraceTree, width: number): string {
    const color = nodeColor(node);
    const prefix = this.layout.get(node.id) ?? '';
    const elapsed = node.endedAt === null ? '' : ` ${formatDuration(node.endedAt - node.createdAt)}`;
    const meta = metaSuffixOf(node);
    const text = `${prefix}${shortId(node.id)} ${node.kind}: ${node.label}${elapsed}${meta}`;
    const line = truncateToWidth(text, width);
    // 失败与 tip 都加粗 —— 判据在 `emphasizedTraceLine()`（与 renderColoredTree 同一份）。
    return emphasizedTraceLine(node, tree) ? bold(color(line)) : color(line);
  }
}

function metaSuffixOf(node: TraceNode): string {
  if (!node.meta) return '';
  const entries = Object.entries(node.meta);
  if (entries.length === 0) return '';
  return ` (${entries.map(([k, v]) => `${k}=${v}`).join(', ')})`;
}

/**
 * 轨迹树里这一行要不要**加粗** —— 两处渲染（`TraceChunks.lineOf()` 与
 * `renderColoredTree()`）共用这一条判据。
 *
 * 两个条件：节点**失败**（视觉上更跳）、或者是当前 **tip**。
 *
 * tip 现在**只有这一个标记** —— 字形上所有节点都是 `○`，加粗由 `renderColoredTree()` 给（同一棵树
 * 上两种圆点字形读起来像画错）。判据只写这一处：写两遍的话，一次性模式与轨迹页的 tip 迟早不一致。
 *
 * 两个条件合在一个 `||` 里（而不是叠两层 bold）：加粗是同一个属性。
 */
export function emphasizedTraceLine(node: TraceNode, tree: TraceTree): boolean {
  return node.status === 'error' || tree.tipId === node.id;
}

/**
 * 把轨迹树画成带颜色的轨道树。
 *
 * 直接复用 trace.ts 的 `traceRows()`（纯函数，测试里也在用），再按节点上色 ——
 * 这样「命令行里看到的树」和「界面里看到的树」是同一份逻辑，不会各画各的。
 *
 * 上色之外还给 tip 那一行**加粗**（`tree.tipId`）：树上所有节点都是 `○`，加粗是
 * 「我现在在哪」的唯一标记。与 `TraceChunks.lineOf()` 同一口径 —— 两处分开写的话，
 * 一次性模式与界面里的 tip 迟早会不一致。
 *
 * ## 为什么不再用正则从文本里抠节点 id
 *
 * 上色靠 `traceRows()` 一起给出的节点对象，**不认文本格式**：从渲染出来的字符串里用正则回捞 kind
 * 会漏项（`turn.*` / `step.*` 那一族曾经整族不上色），而那是渲染层最难发现的一种静默退化。
 */
export function renderColoredTree(tree: TraceTree, maxWidth: number): string {
  const rows = traceRows(tree, { maxWidth });
  if (rows.length === 0) return '（轨迹为空）';
  return rows
    .map((row) => {
      const color = nodeColor(row.node);
      // 失败与 tip 都加粗 —— 与 `TraceChunks.lineOf()` 同一份判据（见 `emphasizedTraceLine`）。
      return emphasizedTraceLine(row.node, tree) ? bold(color(row.text)) : color(row.text);
    })
    .join('\n');
}

/**
 * 顶行：页签 + 轨迹统计（**兼两职**，刻意压成一行）：
 *
 * ```
 * 对话 │ 轨迹 3轮2步  工具5  重试1  错误1 (Ctrl+R)
 * ```
 *
 * 页签旁边的切换键来自 `app.trace.toggle`（可改），所以改名后这一行跟着变 —— 手写 `'Ctrl+R'`
 * 迟早会开始骗人。统计里回合与步数合成 `x轮x步`（都是「事件次数」的口径），工具/重试/错误非 0
 * 才出现，且**始终显示**（跑到哪了是读对话时就想要的信息）。
 *
 * 不再有独立顶栏：原来顶栏与页签各占一行、都在讲「我在哪页 / 这轮跑到哪了」，而界面真正缺的是
 * 对话高度。节点数也删了（`trace.order.length`，开一轮就 +5，跳得快又不 actionable），花费 `$`
 * 一并删掉（底栏 statsLine 已有同口径的会话累计）。
 *
 * `padToWidth` 用 `visibleWidth` 而不是 `stripAnsi().length`：pi-tui 是**增量**重绘，这一行长度随
 * 统计变化，不补齐的话旧内容的尾巴不会被擦掉、下一帧叠着出现（看着像重复刷屏）；而汉字是双宽，
 * 按字符数算会少补。
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
 *
 * ## 思考级别（`• high` / `• thinking off`）
 *
 * **只有 reasoning 模型才画** —— 与 pi 的 `footer.js` 同一条件（`state.model?.reasoning`）。
 * 形状也逐字一致：级别是 `off` 时写 `• thinking off`（而不是 `• off`），其余写 `• <级别>`。
 * 为什么 `off` 要加 `thinking` 前缀：`model • off` 读起来像「模型被关了」，而它说的是
 * 「这个模型能思考，但这次没开」。
 */
export function modelLine(state: AgentState): string {
  const base = `(${state.providerName}) ${state.modelId}`;
  // `?.` 与 pi 的 `state.model?.reasoning` 一致：测试或半装载状态下 model 块可能缺席。
  if (!state.model?.reasoning) return base;
  const level = state.thinkingLevel || 'off';
  return level === 'off' ? `${base} • thinking off` : `${base} • ${level}`;
}

/**
 * 底栏左下行：token 用量 + 上下文占用。形状照抄 pi：`↑6.8k ↓49 R143 CH2.1% 0.7%/1.0M (auto)`。
 *
 * 格式化与累加都直接用 pi 的实现（`formatTokens` / `addUsageToTotals` / `formatCwdForFooter`）——
 * 两边数字对不上会让人以为算错了。两种口径**不要混**：**累计**（`↑`/`↓`/`R`/`W`/`$`）从
 * `state.messages` 把所有 assistant 消息的 usage 加起来；**最近一次**（上下文占用）只看最后一条
 * 有效消息的 usage，累加出来的会是天文数字。
 *
 * `(auto)` 是自动压缩的指示灯（pi 的 `footer.js` 同样在占用段后面跟这 6 个字符）：它说的是「快满了
 * 会自动压，不用自己动手」。判定用**真的开关**（`options.autoCompactEnabled()` → 内核的
 * `AutoCompact`），`/settings` 里翻一下就变、`refresh()` 下一帧跟上；`null`（这个装配不支持压缩）
 * **不画** —— 不知道的事不替它打保票。
 */
/** 底箱第二行算出来的结果。 */
export interface StatsLine {
  /** 整行文本，**不带任何 ANSI**（颜色由调用方用 `dimLine()` 统一处理）。 */
  text: string;
  /** 要在 dim 底箱里保持告警色的子段。 */
  warnings: { find: string; paint: (s: string) => string }[];
  /**
   * 告警级别（上下文占用超 70% = `warn`、超 90% = `error`）。
   *
   * 单独一个字段是给**浏览器**那一侧用的：它拿不到 `warnings` 里的 `paint` 函数（那是
   * 终端上色的东西），但要能把整行染成黄/红 —— 见 `web/bridge.ts` 的 `statsText`。
   */
  level: 'none' | 'warn' | 'error';
}

/**
 * 排队中的用户输入面板。空队列时返回空串（面板自己不占高度）。形状与 pi 的
 * `updatePendingMessagesDisplay()` 一致。
 *
 * steer 与 followUp 用**不同的标记**：两者投递给模型的时机不同、用户预期也不同（steer 打断现在
 * 这条线，followUp 等它说完）。都显示成同一行的话，用户无法判断自己的话什么时候会被看见。
 */
// 键位**不自己造**：翻页用 pi 的 `tui.altScreen.pageUp/pageDown`（`PgUp`/`PgDn`），
// `Alt+↑` 与 `Ctrl+P` 归还 pi 的 `app.message.dequeue` / `app.model.cycleForward`。
//
// 不能自己维护字节序列表：`Alt+↑` / `Ctrl+P` 在 pi 里有语义，抢走之后两边共用的 `keybindings.json`
// 再也表达不出「我要 pi 那个动作」；而裸 `\x1b[A` 其实就是普通 ↑（不支持 Kitty 协议的终端发的
// 正是这一串），于是所有 ↑↓ 都被吃成翻页，编辑器里改不了光标、扩展的对话框收不到方向键。
// pi-tui 的 `TuiAltScreen` 本来就有整套翻页（还能改键、`/hotkeys` 里列得出来），它滚的是当前页的
// primary ScrollView，正好。半页默认没有键（与 pi 一致），想用就在 `keybindings.json` 里绑。
const ESC = String.fromCharCode(27);

/**
 * 这条按键要不要**忽略**（mac 上「快捷键触发两次」的根因）。
 *
 * pi-tui 请求 Kitty 键盘协议时带了 flag 2（报告事件类型），于是**一次按键产生两个序列**：press
 * （`:1u`）与 release（`:3u`）。而 release 序列**也能匹配 `matchesKey()`**（parseKey 读的是
 * `<code>;<mod>`，第三段不参与匹配）—— 于是轨迹页切两次再切回来、`Ctrl+O` 展开两次，看着「完全
 * 没反应」。
 *
 * pi-tui 自己有这层过滤，但只对**聚焦组件**生效；本项目的全局开关与滚轮都挂在 input listener 上，
 * 官方那层管不到（扩展的 `ctx.ui.onTerminalInput()` 更是直接透传到 `addInputListener`）。
 *
 * 不关掉 flag 2：那要改 `terminal.js`，而且要的 repeat 态正是长按的语义。在**自己这层**过滤掉
 * release 就够。用的是同一个 `isKeyRelease()`（pi-tui 导出），两层判断不会漂移。粘贴内容在它里面
 * 被显式排除 —— 而滚轮判断是**前缀**匹配，粘贴里撞上开头就会被误判成翻页，所以粘贴必须更早放行。
 */
export function shouldIgnoreKey(data: string): boolean {
  // 粘贴 / 输入框里的普通文本：不可能是快捷键，一律放行。
  if (data.includes(`${ESC}[200~`)) return false;
  return isKeyRelease(data);
}

/**
 * 全局输入监听器要不要**整个让路**（不消费，交给聚焦组件）。
 *
 * 两种「有人占着键盘」的形态：**overlay 栈非空**（`/model`、`/resume` 那些面板，以及扩展的
 * `custom({ overlay: true })`）；**输入区槽位被扩展组件占着**（扩展的非 overlay `custom()`，
 * `mountEditorSlot` 那一格，`ctx.ui.select/confirm/input` 也在那儿）。后者**不在 overlay 栈上**，
 * 只判 `hasOverlay()` 会漏掉 —— 症状是 `ask_user_question` 的对话框只有 Tab 能用、↑/↓ 在滚对话区，
 * 以及对话框开着的同时按 `Ctrl+R` / `Ctrl+O` / `Shift+Tab` 背后的主界面会跟着变。
 *
 * 让路 = `return undefined`，**不**消费。
 */
export function shouldYieldInput(
  tui: { hasOverlay(): boolean },
  inputSlotOccupied: boolean,
): boolean {
  return tui.hasOverlay() || inputSlotOccupied;
}

/**
 * 排队中的用户输入卡片（在输入框**之上**，一直挂着直到投递出去）。
 *
 * 形状与 pi 的 `updatePendingMessagesDisplay()` 逐行同构（提示行里的键名是
 * **实时解析**的，这只是 macOS 上的样子；Windows 上那行会是 `Alt+Q`）：
 *
 * ```
 *  ↳ Option+Up to edit all queued messages
 *  Steering: 顺便看下版本
 *  Follow-up: 待会儿再说
 * ```
 *
 * - 首行空行 = pi 的 `Spacer(1)`（与对话区隔开）；每行缩进一格 = pi 的
 *   `TruncatedText(text, 1, 0)`；
 * - 末行提示「怎么把它们拿回来」—— 没有它，这两条看着像**已经发给模型了**，
 *   而它们其实还在本地；
 * - **空队列时一行都不占**（返回空串 → `Text` 渲染成 `[]` → 布局里高度 0）。
 */
export function renderQueuePanel(state: AgentState, width: number): string {
  if (state.steerQueue.length === 0 && state.followUpQueue.length === 0) return '';
  const rows: string[] = [''];
  for (const item of state.steerQueue) rows.push(queueRow('Steering: ', item.text, width));
  for (const item of state.followUpQueue) rows.push(queueRow('Follow-up: ', item.text, width));
  rows.push(dim(` ↳ ${keyLabel('app.message.dequeue')} to edit all queued messages`));
  return rows.join('\n');
}

/** 一行排队消息：`<前缀>文本`，缩进一格，超宽后面省略号（前缀自己占的宽度要扣掉）。 */
function queueRow(prefix: string, text: string, width: number): string {
  const room = Math.max(8, width - 1 - prefix.length);
  return dim(` ${prefix}${truncateToWidth(singleLine(text), room)}`);
}

/** 队列里那句话压成一行：**一条消息一行**，多行会把输入框顶下去（pi 的 `TruncatedText` 同理）。 */
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

export function statsLine(state: AgentState, autoCompact: boolean | null = null): StatsLine {
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
  let level: StatsLine['level'] = 'none';
  if (totals.input > 0) parts.push(`↑${formatTokens(totals.input)}`);
  if (totals.output > 0) parts.push(`↓${formatTokens(totals.output)}`);
  if (totals.cacheRead > 0) parts.push(`R${formatTokens(totals.cacheRead)}`);
  if (totals.cacheWrite > 0) parts.push(`W${formatTokens(totals.cacheWrite)}`);
  if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
    parts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
  }
  if (totals.cost > 0) parts.push(`$${totals.cost.toFixed(3)}`);

  // 上下文占用 = **最后一次** LLM 调用占掉多少窗口，**不能拿累加值**。
  //
  // `totals` 是整个会话累计的（`↑`/`↓`/`R`/`$` 要的是那个口径），而窗口不是：每一轮的
  // `input + cacheRead` 都把当轮完整 prompt 重新数了一遍，而 prompt 里含前面所有轮次的内容 ——
  // 累加等于「整段历史被重复数了 N 次」（实测 583 条助手消息、1.0M 窗口：9536% vs 正确 29.2%）。
  //
  // 口径与 pi 一致：取**最后一条有效**助手消息的 `usage.totalTokens`（即上一次请求的总 token）。
  //
  // 这里**不自己上色**而是把告警信息一起返回：整行底箱会被包进 dim，而 dim 里再嵌一个 `\x1b[0m`
  // 结尾的颜色段会把 dim 提前关掉（见 dimLine）。
  const autoSuffix = autoCompact === true ? ' (auto)' : '';
  const contextWindow = state.model.contextWindow;
  if (contextWindow > 0) {
    const last = lastContextUsage(state.messages);
    if (last !== undefined) {
      const percentValue = (last / contextWindow) * 100;
      // 超过 100% **如实显示**，不夹到 100 —— 夹了就变成“刚好满”，而事实是
      // “目录里配的窗口小于实际能发的量，该换窗口或压缩历史”。pi 也是直接显示原值。
      const percent = percentValue < 1 ? percentValue.toFixed(1) : Math.round(percentValue);
      const display = `${percent}%/${formatTokens(contextWindow)}`;
      // 告警段只包数字那半截（`autoSuffix` 留在 dim 里）—— `find` 是前缀匹配，
      // 所以带上后缀也不会找错，但没有必要让它跟着变色。
      parts.push(display + autoSuffix);
      if (percentValue > 70) {
        warnings.push({ find: display, paint: percentValue > 90 ? red : yellow });
        level = percentValue > 90 ? 'error' : 'warn';
      }
    } else {
      // 还没有任何一次**有效**调用（会话刚开、或全部失败/被中断）：占用**未知**。
      // pi 这里是 `?/1.0M`，不是 `0%/1.0M` —— 后者会说谎（说“没占”）。
      parts.push(`?/${formatTokens(contextWindow)}${autoSuffix}`);
    }
  }
  return { text: parts.join(' '), warnings, level };
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
 * 底栏**第一行**：cwd 在左，扩展的状态段贴在右（`ctx.ui.setStatus`）。
 *
 * 状态段放这儿而不像 pi 那样另起一行：本项目底栏是**固定两行**的（`FOOTER_ROWS` 同时被
 * `composer-overlay.ts` 拿去做面板行预算，两边必须相等），多一行会挤掉一格对话区，而第一行右半边
 * 本来就空着。
 *
 * **dim 只包左段**：状态段是扩展自己上的色，整体包 dim 的话它收尾的 `\x1b[0m` 会把 dim 提前关掉，
 * 右段之后到行尾会突然变亮。
 *
 * 两个分支都要把行补齐到全宽：pi-tui 是增量重绘，行变短时旧字的尾巴不会被擦掉。
 *
 * @param cwdText   左边那段（不带颜色）
 * @param statusText 右边那段（已排序、已单行化，**可能带颜色**；空串 = 没有状态段）
 */
export function extensionFooterRow(cwdText: string, statusText: string, width: number): string {
  if (statusText === '') return dim(padToWidth(cwdText, width));
  const cwdWidth = visibleWidth(cwdText);
  const statusWidth = visibleWidth(statusText);
  // 放不下时与 `twoColumn` 同一口径：拼起来截断（路径可以靠 /pwd 看，
  // 但两条信息都不能丢到界面外）。
  if (cwdWidth + statusWidth + 1 > width) {
    return truncateToWidth(`${dim(cwdText)} ${statusText}`, width, dim('...'));
  }
  return dim(cwdText) + ' '.repeat(width - cwdWidth - statusWidth) + statusText;
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
 * 斜杠命令表里的一行。
 *
 * `SlashCommand`（pi-tui 的）的 `description` / `argumentHint` 都原样透传（补全用）；
 * 多出来的 `web` 是给 webui 用的：那个命令在浏览器里也能跑（非会话类）。不标 = 终端专有。
 * 接口在 `web/api.ts`，驱动它的 HTTP 路由在 `web/server.ts`。
 */
export interface ElaSlashCommand {
  name: string;
  description: string;
  /**
   * 参数提示（`/model <provider/model>` 里那个尖括号）。与 pi 同一字段。
   *
   * 故意**不写** `| undefined`（与本文件其他可选字段不同）：pi-tui 的 `SlashCommand`
   * 是 `argumentHint?: string`，而 tsconfig 开了 `exactOptionalPropertyTypes` —— 多写那个
   * `| undefined` 就整张表不能当 `SlashCommand[]` 传给补全 provider 了。
   */
  argumentHint?: string;
  web?: boolean | undefined;
}

/**
 * 斜杠命令表 —— **唯一的真相**（补全、webui 的 `/` 下拉、`runCommand` 都念这一份）。
 *
 * 名字、**英文原文描述**、`argumentHint` 都抄 pi 的 `core/slash-commands.js`，顺序也按 pi 排：
 * 两个界面里看到同一句话，缺的那些一眼能看出是**没做**而不是被挪了位置。
 *
 * pi 有、这里**不列**的（不是忘，是不做）：`tree` / `fork` / `clone`（本项目的轨迹树是只读的
 * 执行历史，没有「在消息树上换分支」）、`export` / `import`（会话文件本身就是 JSONL，`cp` 就是那个
 * 动作）、`share`（没有账号体系）、`bug`（上报给 pi 的开发者 —— 会寄错人）、`changelog`、
 * `trust`（本项目没有「项目级、需信任才加载」的资源）、`login` / `logout`（鉴权在 pi 那边配）。
 *
 * 本项目有、pi **没有**的只剩两条：
 *
 * - `/skills`：`disable-model-invocation` 与重装 prompt 都能让「磁盘上有、模型不知道」，
 *   会话中途能查一次是必要的诊断。
 * - `/continue`：超时 / 网络错误 / 轮数上限停下后接着跑，**不插一条「继续」**。
 *   恢复会话（`/resume` / `ela --session`）后接着跑被打断的那一轮也用它 —— 不然用户只能
 *   再发一句「继续」，而那句话会被当成真实对话历史写进会话文件。
 */
export const SLASH_COMMANDS: ElaSlashCommand[] = [
  { name: 'settings', description: 'Open settings menu', web: true },
  {
    name: 'model',
    description: 'Select model (opens selector UI)',
    argumentHint: '<provider/model>',
    web: true,
  },
  {
    name: 'thinking',
    description: 'Set thinking level',
    argumentHint: '<level>',
    web: true,
  },
  {
    name: 'scoped-models',
    description: 'Enable/disable models for Ctrl+P cycling',
    web: true,
  },
  { name: 'skills', description: 'List the skills that entered this prompt', web: true },
  { name: 'copy', description: 'Copy last agent message to clipboard' },
  { name: 'name', description: 'Set session display name' },
  { name: 'session', description: 'Show session info and stats' },
  { name: 'hotkeys', description: 'Show all keyboard shortcuts' },
  { name: 'new', description: 'Start a new session' },
  { name: 'compact', description: 'Manually compact the session context', web: true },
  { name: 'resume', description: 'Resume a different session' },
  {
    name: 'reload',
    description: 'Reload keybindings, extensions, skills, prompts, themes, and context files',
    web: true,
  },
  {
    name: 'continue',
    description: 'Continue the interrupted turn without a new user message',
    web: true,
  },
  { name: 'quit', description: 'Quit ela' },
];

/**
 * 回车时一条 `/xxx` 该走哪条路 —— 与 pi 的分工一致：**skill**（`/skill:name` 展开成 `<skill>` 块）
 * → **真命令**（内置与扩展命令）→ **prompt 模板**（展开成正文）→ 剩下的**原样当用户输入发送**。
 *
 * 与 pi 的唯一差别是第 1/2 步的先后（pi 把扩展命令放最前）：`skill:` 是保留前缀，只有「扩展恰好
 * 叫 `skill:xxx`」这种病态命名才分得出来。
 *
 * 未命中是 `message` 而不是错误：`/etc/hosts`、`/文件名` 这类输入很自然，**不能报错也不能吞掉**
 * —— pi 对认不出的 `/xxx` 就是原样发给模型。这一层只负责分类。
 *
 * 导出成纯函数是为了能测：`onSubmit` 闭在 `runTui()` 里，单测够不到。
 */
export type SlashInputRoute =
  | { kind: 'skill'; text: string }
  | { kind: 'template'; text: string }
  | { kind: 'command' }
  | { kind: 'message' };

export function routeSlashInput(
  input: string,
  skills: readonly SkillInfo[],
  prompts: readonly PromptTemplateInfo[],
  isCommand: (name: string) => boolean,
): SlashInputRoute {
  // 1. skill：与 pi 同一个展开函数，认不出就原样返回。
  const expandedSkill = expandSkillCommand(input, skills);
  if (expandedSkill.startsWith('<skill ')) return { kind: 'skill', text: expandedSkill };

  // 2. 真命令（内置 / 扩展）：名字命中就不展开模板 —— 命令有可执行行为。
  const name = input.slice(1).split(/\s+/, 1)[0] ?? '';
  if (isCommand(name)) return { kind: 'command' };

  // 3. prompt 模板：`/council <问题>` → 模板正文。
  const expandedTemplate = expandPromptTemplate(input, prompts);
  if (expandedTemplate !== input) return { kind: 'template', text: expandedTemplate };

  // 4. 未命中：当普通用户输入发送（**不是错误**）。
  return { kind: 'message' };
}

export interface TuiOptions {
  store: AgentStore;
  /** 一次性提问：给完就退出（脚本/管道友好）。 */
  prompt?: string | undefined;
  /**
   * 扩展的斜杠命令与快捷键（`extension-commands.ts` 造，界面读）。
   *
   * ## 为什么是**取值函数**，不是那个对象
   *
   * 内核 `deferExtensions` 时（TUI 现在不走这条，见 `kernel.ts`）扩展是**后台装的**：
   * 这里存一个对象就等于把「装载前那个空命令表」钉死，症状是扩展的斜杠命令
   * （`/websearch` 那种）**永远**不出现，而没有任何报错。取值是每次现取，
   * 于是装载完成后补全、`runCommand`、`/hotkeys` 都看得到它们。
   *
   * 不给 = 没装扩展：补全里没有它们，`runCommand` 不会问。
   */
  extensionCommands?: (() => ExtensionCommands | undefined) | undefined;
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
  extensions?: (() => {
    /**
     * 装上的扩展（入口文件 + 来源）。
     *
     * **不是工具名**：给 `tools` 的话界面上会写着 `[扩展] ask_user_question` —— 一个**工具**的
     * 名字被当成扩展名报了出去，用户照着它去 `settings.json` 的 `packages` 里找、找不到，于是以为
     * 扩展没装上。
     * 形状与 pi 的开场一致（`pi-web-access:dist` / `orca-agent-status.ts`），
     * 见 [resource-labels.ts](resource-labels.ts)。
     *
     * `tools` 仍然留着：诊断信息（工具没有 `promptSnippet` 那些）由内核出，
     * 而它要说清是**哪个扩展**的哪个工具。
     */
    entries: readonly ExtensionEntry[];
    tools: readonly string[];
    errors: readonly string[];
  } | undefined) | undefined;
  /**
   * 扩展装载完成的门（`deferExtensions` 时才有意义，见 `kernel.ts` 的 `ready`）。
   *
   * 两件事靠它：
   *
   * 1. **发消息**要在它之后（`send()`）—— 装载前 state 里的工具集与 system prompt
   *    还是「没有扩展」的形状，先发出去的那条会把一份缺工具集的 head 写进会话。
   * 2. **开场横幅**要在它之后再报一次：`[Skills]` / `[Extensions]` 这两节的内容
   *    （skill 清单、扩展清单与装载诊断）都是装载那一刻才有的。
   */
  ready?: Promise<void> | undefined;
  /**
   * 扩展的 `ctx.ui` 由界面层造（它要活着的 tui 实例）。
   *
   * 内核装扩展时比这更早 —— 那时界面还没起来。所以它拿到的是**一个待填的引用**，
   * 由本函数在 tui 建好之后填上；扩展工具真被调用时读它。
   */
  publishUi?: ((options: HostUiOptions) => void) | undefined;
  /**
   * 浏览器侧的对话框宿主（`web/bridge.ts`）。**取值而不是常量** —— 桥在 main.ts 里
   * 建得比这里早，但调 `runTui` 时传进来的是个 getter，所以总是最新的那个。
   */
  dialogs?: (() => DialogHost | undefined) | undefined;
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
   * 恢复一个历史会话：把它的消息灌回 state（零 token）。
   *
   * 优先走内核那条（`options.restoreSession`）：它换会话 id + 对齐记录器游标，不会把恢复出来的历史
   * 再写一遍盘。没接就退化成一条 `conversation.restored`，但**不换 id**、没有游标概念 —— 恢复出来的
   * 消息会被当前记录器当成新消息写盘，要说出来，不然用户以为是历史坏了。
   *
   * 必须**一条** action：每次 dispatch 都重渲染整段对话，逐条灌是 O(N²)（390 条实测 62 秒）。
   * 轨迹不跟着恢复（它是那一轮的产物，历史轨迹在 `traces/<id>.jsonl`）。
   */
  restoreSession?: ((file: string) => Promise<{ id: string; restored: number }>) | undefined;
  /**
   * 重载（`/reload`）：重新读 settings / 扩展 / skill / prompt 模板 / 上下文文件。
   *
   * 与 pi 的 `/reload` 同一个语义，但**内核那一半**由内核做（重装扩展 = 新实例、
   * `session_shutdown{reload}` + `session_start{reload}`、重拼 prompt）。TUI 自己再补
   * 三样只在界面侧的：键位表、`hideThinkingBlock`、主题（见 `runCommand` 的 `reload`）。
   *
   * 不传 = 未接内核（测试），`/reload` 会明说「没有重载入口」而不假装做了。
   */
  reload?: (() => Promise<KernelReloadReport>) | undefined;
  /**
   * 换模型（`/model`）。**必须由内核出手** —— 与 `restoreSession` 同一类原因：
   * 换模型是内核的一条 `model.changed`（带全能力 / 窗口），
   * 而 effect 表读的模型是**每次请求现取**的（`store.ts` 的 `resolveModel`）。
   * 界面自己 dispatch 也能让底栏变，但那样就绕过了内核那道「先查模型存在再换」的闸。
   *
   * 不传 = `/model` 面板仍能开（能列、能搜），选完会**明说没接内核**而不是假装换了。
   */
  setModel?: ((provider: string, modelId: string, options?: { thinkingLevel?: string | undefined }) => boolean) | undefined;
  /**
   * 自动压缩现在开着吗；`null` = 这个装配不支持压缩（`/settings` 那一行不显示）。
   *
   * 不给就是 `null`：不编一个「支持但关着」（那样面板上会出现一个永远压不了的开关）。
   */
  autoCompactEnabled?: (() => boolean | null) | undefined;
  /** 开/关自动压缩（写 `compaction.enabled` 并当场生效）。 */
  setAutoCompactEnabled?: ((enabled: boolean) => void) | undefined;
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
}

/**
 * 当前 git 分支，读不到就返回 undefined（不在仓库里 / 没装 git）。
 *
 * 每次 refresh 都重读而不在启动时算一次：分支会变（用户切了分支、或我们在会话里跑了 git 命令），
 * 缓存了就意味着「底栏在说谎」；读一次 `.git/HEAD` 便宜到可以忽略。
 *
 * `.git` 有两种形状：**目录**（HEAD 在 `<cwd>/.git/HEAD`）与**文件**（linked worktree 与 submodule，
 * 内容是 `gitdir: <真正的 git 目录>`，HEAD 在那个目录里）。把 `.git` 当目录读会抛 ENOTDIR，症状是
 * 括号里的分支名静默消失。读文件时必须剥掉换行再拼路径。`gitdir:` 用正斜杠，`path.resolve` 能接。
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

/**
 * 视口往上翻之后那条「回到最新」的提示（pi 的 `scrollToEndIndicator`）。
 *
 * 对话区的 ScrollView 是 `follow: 'end'`，但用户往上翻之后 `follow` 让位、视口停在历史里，这时新
 * 消息还在下面长而屏幕上没有任何东西说「下面还有」—— 症状不是报错，而是「等流式输出时以为卡住了」。
 *
 * 文案与 pi 逐字同形（`↓ Jump to latest message · Ctrl+End`），键名**走键位表**
 * （`keyLabel('tui.altScreen.bottom')`）：用户改了键位，这条提示跟着变。
 *
 * 首尾各留一个空格、配色用 `selectedBg` + `text`：它是被 `compositeTuiLine` **压进**视口最后一行
 * 已有内容的，不留空格会与那一行原来的字连成一片。
 */
export function jumpToLatestHint(theme: Theme): string {
  // `keyLabel` 解析不出键时返回空串（动作 id 写错=编程错误，见 keybindings.ts）—— 那时
  // **不带** `· `，而不是留一个悬空的点。pi 也是这么判的（`shortcut ? ... : ''`）。
  const shortcut = keyLabel('tui.altScreen.bottom');
  const label = ` ↓ Jump to latest message${shortcut ? ` · ${shortcut}` : ''} `;
  return theme.bg('selectedBg', theme.fg('text', label));
}

export async function runTui(options: TuiOptions): Promise<number> {
  const { store, prompt, newSession, sessionId, restoreSession: restoreHook } = options;
  const beforeAgentStartHook = options.beforeAgentStart;
  /** 扩展的命令表（**每次现取**，见 `TuiOptions.extensionCommands`）。 */
  const extensionCommands = (): ExtensionCommands | undefined => options.extensionCommands?.();
  /**
   * 扩展装载完成了吗（同步的那一面）。
   *
   * `TuiOptions.ready` 是一个 promise，而 `send()` 里那句「现在能不能发」需要**同步**
   * 判断（不能 await 完了再决定要不要提示用户）。所以另存一个布尔，由那个 promise 翻。
   */
  let extensionsReady = options.ready === undefined;
  /**
   * 扩展装载完成的门（`TuiOptions.ready`；没给就是一个**已经完成**的门）。
   *
   * `send()` 要 `await` 它：`deferExtensions`（内核把扩展推到后台装）下，装载完成前
   * state 里的工具集与 system prompt 还是「没有扩展」的形状 —— 先发出去的那条会定下
   * 一份**缺工具集**的 head，而 head 是不可改的历史（见 `prompt-head.ts`）。
   */
  const ready = options.ready ?? Promise.resolve();
  // 工作目录**从 store 读**（`state.session.cwd`）—— 与浏览器那边（桥、`/api/*`）
  // 是同一个地方。它不是一个「界面的选项」：内核启动时就定了，换会话也不变
  // （见 docs/architecture/kernel.md 的「会话身份住在状态里」）。
  const cwd = store.getState().session.cwd;
  /**
   * 当前会话**文件路径**（picker 用它把「正在用的这条」标出来并拒绝删除）。
   *
   * `sessionId` 是取值函数（`/new` 之后会变），所以每次开面板现算 —— 别缓存，
   * 否则 `/new` 之后打开 `/resume` 会去保护一个已经不存在的文件。
   */
  const currentSessionFile = (): string | undefined => {
    const id = sessionId?.();
    return id === undefined || id === '' ? undefined : findSessionFile(id, cwd);
  };
  /**
   * 当前会话**真的在盘上**的文件。
   *
   * 与 `currentSessionFile()` 的差别不是润色：`findSessionFile()` 找不到就**拼一个
   * 将来才会用的路径**（它也会给不存在的文件返回一个看着很真的路径）。空会话不落盘
   * （见 `SessionWriter.start`），所以「有路径」与「真落过盘」是两件事：
   *
   * - `/name` 要往文件里 append 一条 `session_info`。在一条**不存在**的文件上 append，
   *   会造出一个**没有 header 的半残会话文件**（`readSession` 直接返回 null、列表里
   *   一条 cwd 为空的幽灵记录）—— 所以那里必须问「真在盘上没」。
   * - `/session` 要如实报「文件在哪」。报一个还不存在的路径，会让用户拿着 `rg` 去搜一个
   *   搜不到的文件。
   */
  const currentSessionFileOnDisk = (): string | undefined => {
    const file = currentSessionFile();
    return file !== undefined && existsSync(file) ? file : undefined;
  };
  /**
   * 当前会话的显示名（`session_info`）。名字落在会话文件里，这里只是进程内的那份缓存。
   *
   * ## 为什么要缓存，而不是每次去读文件
   *
   * `config-home.readSessionName()` 只扫文件**前 512KB**（那条已知限制写在那边），
   * 而改名是往**文件末尾**追加的 —— 一个很长的会话刚 `/name` 完再去读，会读到旧名字。
   * 所以 mem 里记住自己刚设的那个；恢复历史时从被选中的那条带过来，`/new` 清掉。
   *
   * `sessionNameLoaded` 单独一个布尔：`undefined` 同时是「没名字」与「还没读」两个意思，
   * 不分就得每次重读一遍。
   */
  let sessionName: string | undefined;
  let sessionNameLoaded = false;
  const currentSessionName = (): string | undefined => {
    if (!sessionNameLoaded) {
      sessionName = readSessionName(currentSessionFileOnDisk());
      sessionNameLoaded = true;
    }
    return sessionName;
  };
  /**
   * 退出前打印一行「怎么恢复这次会话」。形状与 pi 一样（`To resume this session: <命令>`），命令是
   * 本项目的 `ela --session <id>`；判断与文案都在 config-home 的 `resumeCommand()`。
   *
   * **必须在 `tui.stop()` 之后调**：界面跑在备用屏（`\x1b[?1049h`）上，`tui.stop()` 才回到主屏，
   * 而备用屏那整块内容退出时被终端丢掉 —— 在那之前写的行会跟着一起没（症状正是「退出时不显示
   * resume 提示」）。所以调用方**只能**是 `tui.stop(); printResumeOnExit();`。
   *
   * 用 `process.stdout.write` 而不是界面里的 notify：这一刻界面已经停了。
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
    /**
     * 拖选松开时写剪贴板 —— **用 pi 那一份**（同一个函数、同一种传法，见 pi 的
     * `modes/interactive/tui-renderer.js`）。
     *
     * 为什么不能不传（不传就只剩 pi-tui 的 OSC 52）：
     * OSC 52 是「发出去就算成功」，对方收不收得到它自己也不知道 —— macOS 的 Terminal.app、
     * tmux 未开 `set-clipboard` 时，屏幕上照样会闪一句 `Copied!`，剪贴板里却什么都没有。
     * 传了这个回调，pi-tui 会改用回调的返回值判成败（原生剪贴板 → 平台命令 → OSC 52
     * 的整条兜底链都在 `copyToClipboard` 里），失败时提示的是真实原因而不是 `Copied!`。
     *
     * 返回 `true` / 报错文本是 pi-tui 的契约：`string` 会被当成「失败」显示出来。
     */
    copySelection: async (text: string) => {
      try {
        await copyToClipboard(text);
        return true;
      } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    // 往上翻之后，视口最后一行压一条「回到最新」的提示（与 pi 同一条，见 jumpToLatestHint）。
    // pi-tui 只在 **primary** 那个 ScrollView 离开末尾时画它 —— 本项目切页时会重建
    // ScrollView 并让当前页当 primary（见 applyLayout），所以对话页与轨迹页各管各的，
    // 不需要在这里判当前在哪一页。
    scrollToEndIndicator: () => jumpToLatestHint(theme),
  });

  /**
   * 顶行：页签 + 轨迹统计（**两职合一**，见 tabLine）。
   *
   * **只有一个**顶行组件：统计与页签讲的是同一件事（「我在哪页 / 这轮跑到哪了」），分两行等于
   * 白占一行，而对话区最缺高度。
   */
  const tabs = new Text('', 0, 0);
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
   *     ↑6.8k ↓49 R143 CH2.1% 0.7%/1.0M (auto)   (workbuddy) cn:space-bunny
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
   * 会话区与输入区之间的那一行空隙 —— pi 的 `Spacer(1)`。
   *
   * pi 里这行空隙在**编辑器上面那个 widget 容器**里，没有 widget 时容器里就只有一个 `Spacer(1)`，
   * 于是「输入框上面永远空一行」由容器保证。本项目的扩展 widget 直接摊在 `bottom` 这个 VStack 里，
   * 没有那个容器，所以这里显式补回来（队列卡非空时它自己还有前导空行，于是「卡与对话区一行、
   * 卡与输入框一行」，与 pi 逐行一样）。
   *
   * `basis: 1, grow: 0, minSize: 1`：缺口恰好一行 —— 给 grow 会在高窗口时撑开，能被 shrink 就
   * 会在矮窗口时让输入框又贴上去。
   */
  const dockGap = new Spacer(1);

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

  // 官方那个把工作状态画进**上框线**的编辑器（`embedWorkingStatus: true`），与 pi 同一个类。
  //
  // 配色直接用 pi 的 `getEditorTheme()`：手写一份会让横线颜色分家（pi 用
  // `theme.getThinkingBorderColor(level)`，而 `dim` 是文本属性不是颜色 token），补全列表的选中色也会
  // 分家（`accent` vs `cyan`）。它内部读 pi 主题，**必须**在 `setupTheme()` 之后调。
  //
  // 形状交给 typecheck，写错时**不要**用 `as unknown as EditorTheme` 压住：那个 cast 会让
  // `this.theme.selectedText is not a function` 在渲染时才爆，而补全列表渲染失败只表现为「打 `/`
  // 什么都没弹」。
  //
  // keybindings 也要传（`CustomEditor` 的签名要它），且必须与面板 / `keyLabel()` 用**同一份**，
  // 不然用户改过的键在这里不生效。
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
    // prompt 模板紧跟内置命令（与 pi 的 `templateCommands` 同一个位置）：它们是最像
    // 「命令」的一层 —— 名字短、有 argumentHint、回车就发。
    ...promptCommands(statePrompts()).map(
      (c): SlashCommand => ({
        name: c.name,
        description: c.description,
        ...(c.argumentHint !== undefined ? { argumentHint: c.argumentHint } : {}),
      }),
    ),
    // 扩展的命令**追在模板后面**：本项目的与模板的排前面，扩展的排后面。
    //
    // 为什么不用 `SLASH_COMMANDS` 那份常量：扩展的命令要等 `loadExtensions()` 装载完
    // 才知道，而那可能发生在编辑器建好**之后**。所以这里现取（与模板、skill 同一种情况）。
    ...(extensionCommands()?.list() ?? []),
    // skill 放最后：与 pi 的 `[...slashCommands, ...templateCommands, ...extensionCommands,
    // ...skillCommandList]` 同一个顺序，名字长（`skill:<name>`）的天然该在最后。
    ...skillCommands(stateSkills()).map(
      (c): SlashCommand => ({ name: c.name, description: c.description }),
    ),
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
   * 扩展的**底栏状态段**（`ctx.ui.setStatus(key, text)`）：key → 已清洗的单行文本。
   *
   * ## 为什么是第一行的右半边
   *
   * pi 把状态段画在底栏**多出来的一行**上（`footer.js` 的 `lines.push(statusLine)`）。
   * 本项目不能这么干：底栏行数是**固定**的（`FOOTER_ROWS`，见 `composer-overlay.ts`），
   * 多一行会把对话区挤掉一格。而第一行右半边正好空着（左边只有 cwd + 分支），
   * 状态段本来就是「顺带看一眼」的东西，放那儿不多占一行。
   *
   * ## 为什么是一个活着的 Map
   *
   * 与 `widgetSlots` 同一理由：`refresh()` 每帧都可能跑，它读当前集合就行；
   * 状态段是**按 key 替换/删除**的（官方语义），用 Map 才不用每次重建布局。
   */
  const extensionStatuses = new Map<string, string>();

  /**
   * 当前所有状态段拼成一行（空集合 = 空串）。
   *
   * 按 key 排序 —— 与 pi 的 `footer.js` 一致（它 `sort(([a],[b]) => a.localeCompare(b))`）：
   * 两边显示顺序相同，盯同一个扩展时才不会以为「换了位置 = 换了东西」。
   * 单行化已经在 `@ela/core` 的 `ctx.ui.setStatus` 里做过了（底栏是固定行数）。
   */
  const extensionStatusText = (): string =>
    [...extensionStatuses.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) => text)
      .filter((text) => text !== '')
      .join(' ');

  /**
   * 扩展的**输入区槽位**（pi 的 `editorContainer` 语义）：非空时 composer 那一格显示它而不显示
   * `editor`。
   *
   * 不复用 overlay：本项目自己的面板是用 overlay **复刻** composer 矩形的，而扩展的 inline
   * `custom()` 要的不只是矩形 —— 它按 `tui.terminal.rows` 自己算行预算、自己决定折叠、把对话区留在
   * 上面，那只能由布局**真的把那一格换掉**才能得到。
   *
   * 只存一个（与 pi 同）：第二个 inline `custom()` 会顶掉第一个，但顺手把旧的 `dispose()` 掉（pi 不
   * dispose，旧组件里的定时器/监听器会一直活着）。并发不会真的发生：`ask_user_question` 自己用
   * `claimInlineSlot()` 守着，抢不到就降级成 overlay。
   */
  let editorSlotComponent: (Component & { dispose?: () => void }) | undefined;
  /**
   * 进槽位之前 composer 里那一行字。
   *
   * 存/还都在界面这边做（pi 在自己的 `showExtensionCustom()` 里也是这么干的）：
   * 出槽位时**还原** —— 扩展在槽位期间改了输入框（将来若接 `setEditorText`）也不会把
   * 它的文字留在 composer 里。今天没人改它，所以这是照着 pi 留的一道防线。
   */
  let editorTextBeforeSlot: string | undefined;

  /**
   * 当前在哪个**整页**。
   *
   * 「不分屏」是刻意的：上下排的话轨迹一多就把对话区挤没，而它自己又不可滚 —— 两败俱伤。整页切换
   * 之后每页都能占满中间那块，ScrollView 的 `primary` 跟着当前页走（见 applyLayout）。
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
   * 这一轮装载的 prompt 模板（`/名字` 展开用）。
   *
   * 与 `stateSkills()` 同一个口径：读 state 而不是重扫目录 —— 模板清单是 `prompt.init`
   * 那一刻定下的，重扫会得到一个**与界面/补全不一致**的清单。
   */
  const statePrompts = (): PromptTemplateInfo[] => promptTemplatesInPrompt(store.getState());
  /**
   * 工具输出是否全部展开（Ctrl+O 切换）。
   *
   * 为什么需要它：工具输出动辄几百行（读个文件、跑个 grep），全部铺开会把对话区冲走。
   * 折叠时留 `... (N earlier lines, ctrl+o to expand)` —— 与 pi 同形。**不展开就没法
   * 看到完整结果**，而截断到看不见东西等于工具白跑。
   */
  let expanded = false;
  /**
   * 思考块是否折叠（`Ctrl+T` 切换，pi 的 `app.thinking.toggle`）。
   *
   * `true` = 只留一行斜体的 `Thinking…`；`false` = 展开整段思考（默认，与 pi 的
   * `hideThinkingBlock ?? false` 一致）。
   *
   * 为什么需要有这个开关：思考动辄几百上千字，展开着会与正文抢注意力；而
   * 「模型为什么这么干」恰是排查时最想看的东西 —— 所以两个需求都真实，
   * 交给用户一个键自己选（与 pi 同一行为、同一个键）。
   *
   * 初值从 `settings.json` 的 `hideThinkingBlock` 读（与 pi **同一个键、同一个文件**）——
   * 在 pi 那边设过之后，本项目的默认行为跟着走。
   */
  let hideThinking = readHideThinkingBlock();
  /**
   * 命令反馈：**钉进对话流的卡片**（对齐 pi 的 `showStatus`）。
   *
   * ## 与 pi 同形的三条规则
   *
   * 1. **卡是会话里的一节**（`at` = 当时的消息条数，渲染时 splice 在那儿），
   *    所以之后的对话会把它往上顶、随会话一起滚 —— 不是贴顶 6 秒后消失。
   * 2. **尾部还是这张卡就覆盖**：连续改配置（换模型 → 切思考级别）时
   *    `messages.length` 没变，`notify` 就地改 `text`，不新开一行、不刷屏。
   * 3. **中间插过东西就另起一张**：一旦有了新消息，`messages.length` 变了，
   *    下一句反馈会 push 一张新卡（旧卡留在历史里）。
   *
   * pi 判定的是「`chatContainer` 末尾两项还是不是自己那对 spacer+text」，
   * 这里用「锚点是否还等于当前消息条数」等价地表达同一件事。
   */
  const statusCards: { text: string; at: number }[] = [];
  /**
   * 开场那一节（已装载的 skill 名单 / 警告）—— **常驻，永不消失**。
   *
   * 与 `statusCards` 分开是因为两者位置不同：状态卡钉在对话流里（会随会话滚走），
   * 而这一节是「本次会话装了什么」，应该像 pi 的 `loadedResourcesContainer` 那样一直在对话区顶部。
   *
   * 不走 `notify()`（30 秒就消失）：「我装了哪些 skill」是要反复对照的东西 —— 打 `/skill:x` 时得
   * 对着名字打。
   */
  const banner = { text: '' };
  /**
   * `/hotkeys` 的 markdown 源码（`undefined` = 没显示过）。
   *
   * 存**源码**而不是渲染好的行：终端改宽度之后要重排（表格框线是按宽度画的），
   * 而宽度只有 `refresh()` 知道。渲染结果的缓存也放在那里（`hotkeysLines()`）。
   */
  let hotkeysSource: string | undefined;
  /**
   * 键位表当时插在第几条消息之后（`state.messages` 的下标）。
   *
   * 敲 `/hotkeys` 的那一刻定下，之后新消息排在它下面（见 `TranscriptChunks.hotkeysAtIndex`）。
   * `undefined` = 没显示过。
   */
  let hotkeysAtMessageIndex: number | undefined;
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
      hotkeysLinesCache = { width, lines: renderHotkeys(width, extensionCommands()?.shortcuts() ?? []) };
    }
    return hotkeysLinesCache.lines;
  };
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
    //   第二行：`↑6.8k ↓49 R143 CH2.1% 0.7%/1.0M (auto)  (workbuddy) cn:space-bunny`
    //
    // 模型那行贴在**第二行**右侧（不是第一行）—— 之前我放错了行，pi 是用量与模型并排。
    // 整块上 dim（=\x1b[2m）：底箱是背景信息，不该跟对话内容抢注意力。
    //
    // dim 要包住**整行**而不是每段单独包：`twoColumn` 靠 visibleWidth 算空白，
    // 已经上了色的那段会算错宽度。做法是先用无色文本算好对齐，再整体包 dim。
    const width = terminal.columns ?? 100;
    // 队列面板同样要补到全宽（否则少一行时残影会留在屏幕上）。
    queuePanel.setText(padToWidth(renderQueuePanel(state, width), width));
    // 第二个参数是**真的**自动压缩开关（`/settings` 里翻一下就变）—— 底栏那一格
    // 因此能显示 pi 同款 `(auto)`，而不是写死一个「应该开着吧」。
    const stats = statsLine(state, options.autoCompactEnabled?.() ?? null);
    const statsRow = twoColumn(stats.text, modelLine(state), width);
    // 第一行：左边 cwd + 分支，右边是扩展的状态段（`ctx.ui.setStatus`）。
    // 没有状态段时就是原来那一行（补到全宽后整体 dim）。
    const cwdText = cwdLine(cwd, gitBranch(cwd));
    const statusText = extensionStatusText();
    footer.setText(
      extensionFooterRow(cwdText, statusText, width) +
        '\n' +
        // dimLine 而不是 dim：上下文超 70%/90% 时那一小段要保持黄/红。
        // 直接 dim(带色文本) 的话，内层的 \x1b[0m 会把外层 dim 提前关掉。
        dimLine(padToWidth(statsRow, width), ...stats.warnings),
    );
    // 状态卡**不过期**（与 pi 一致）：它是会话里的一节，随对话滚走，而不是到点消失。
    // banner 同样常驻。
    // 时间线从轨迹树派生（见 `@ela/core/stream`）：对话消息与提示（错误 / 配置切换 /
    // 压缩）都从 `state.trace` 出来。`state.messages` 只当旧轨迹的退路（节点上
    // 还没带 message 时），不再是界面的真相。
    const entries = sessionEntries(state);
    const streamMsgs = streamMessages(entries);
    // 轨迹派生的卡与命令反馈卡合并后一起渲染：两者同形、各自的锚点各自算。
    const cards = [...traceNoticeCards(entries), ...statusCards];
    transcript.update(
      state,
      width,
      expanded,
      cards,
      banner,
      hotkeysLines(width),
      hotkeysAtMessageIndex ?? -1,
      hideThinking,
      streamMsgs,
    );
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
    // state 现推（见 `workingStatusText()`）：手工维护 `lastLoaderMessage` 那种写法要三处各自记得
    // 收尾，漏一处就是「圈一直转」；现推幂等。
    // 压缩不再走 banner：`compact` 节点会在派生的会话流里出一条提示，
    // 随会话滚走（这就是「以 trace 为基准」：同一件事只有一个来源）。
    refresh();
  });

  // 显式标出回调参数类型：1.x 的 TuiInputListener 是具名类型，不再从上下文推断。
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
     * **有弹窗 / 输入区被扩展占着时，本监听器整个让路。**
     *
     * pi-tui 的 `inputListeners` 在**聚焦组件之前**跑，没被 `consume` 的按键继续往聚焦组件走 ——
     * 所以 `return undefined` 就是「我不处理，交给弹窗」。
     *
     * 必须要：这个监听器无条件处理几个全局开关，其中中断键（默认 `ctrl+c`）在空闲时
     * `process.exit(0)`，而在弹窗里 `Ctrl+C` 的语义是**取消面板** —— 「打开 /resume 然后想退出」
     * 会直接杀掉整个界面（没有堆栈、没有日志，用户只觉得「崩了」）。其余几个（切轨迹页 / 展开工具 /
     * 换队列模式）会让弹窗开着的**同时**背后的主界面也变，看着像面板没盖住背景。
     *
     * 两种形态都要判：本项目的面板在 overlay 栈上（`hasOverlay()`），而 `ctx.ui.custom()` 默认走
     * **输入区槽位**、`ctx.ui.select/confirm/input` 也在同一格 —— 只判 `hasOverlay()` 漏掉的正是
     * 这一批（`ask_user_question` 最常用，症状见 `shouldYieldInput()`）。
     */
    if (shouldYieldInput(tui, editorSlotComponent !== undefined)) return undefined;
    /**
     * 翻页**不在这里**。
     *
     * `PgUp`/`PgDn` 由 pi-tui 的 `TuiAltScreen` 在它自己那个 input listener 里处理
     * （构造时就注册了，比本监听器还早），滚的是 **primary** ScrollView —— 而本项目
     * 切页时让 primary 跟着当前页走（见 `applyLayout`），于是「只滚当前页」这个效果
     * 本来就是白得的。`Alt+↑` / `Ctrl+P` / 裸 ↑↓ 也全部归还给各自的语义
     * （取回排队消息 / 换下一个模型 / 编辑光标）。字节序列不能让这里自己抢 —— 抢过两次真问题，
     * 见 `const ESC` 上方那片注释。
     */
    /** 内置的几个开关键。返回 true = 已消费。 */
    const builtins = (): boolean => {
      // `Ctrl+L` = `app.model.select`（打开 /model 面板）—— **用 pi 的动作 id**，
      // 不自己编一个：用户的 `keybindings.json` 里改了这个 id，pi 与本项目同时生效。
      //
      // 判断也走 `actionMatches` 而不是裸的 `matchesKey(data, 'ctrl+l')`：后者写死了
      // 默认键，用户改过就不生效（而提示行那边会显示新键 —— 两边说法不一致）。
      if (actionMatches(data, 'app.model.select')) {
        if (store.getState().phase !== 'idle') {
          notify(yellow(`上一回合还没结束，先按 ${keyLabel('app.interrupt')} 中断再换模型`));
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
            // 不再当场 `notify`：换模型作为一条配置提示由**轨迹派生**（`model.init`
            // 节点带 `changed` 标记，下一次发话前落下）—— TUI 与 WebUI 同一份。
          },
          onSelectAsDefault: (model) => {
            if (!writeDefaultModel(model.provider, model.id, cwd)) {
              notify(yellow('没能写进 settings.json，默认模型没变'));
              return;
            }
            if (options.setModel?.(model.provider, model.id)) {
              refresh();
              // 存默认也要先换到它；切换本身不再当场 `notify`（由轨迹派生的配置提示给）。
            } else {
              notify(yellow(`已存为默认，但换不了 ${model.id}（配置里没它）`));
            }
          },
        });
        return true;
      }
      if (actionMatches(data, 'app.abort')) {
        // 本项目的「一键中断 / 空闲退出」合体动作。**默认不绑**（`keybindings.json` 里
        // 显式写 `"app.abort": "ctrl+c"` 才会走到这里），因为 `ctrl+c` 已归 pi 的
        // `app.clear`。见 `keybindings.ts`。
        if (store.getState().phase !== 'idle') {
          abortRun();
          return true;
        }
        // **顺序不能反**：`tui.stop()` 先离开备用屏，提示才落在主屏上看得见。
        // 反过来写的话那行会被备用屏的退出一起丢掉（见 `printResumeOnExit` 的注释）。
        exitApp();
        return true;
      }
      // pi 的 `app.model.cycleForward/Backward`（`Ctrl+P` / `Shift+Ctrl+P`）：
      // 在作用域内循环换模型。用 pi 的 id，所以用户改过键这边跟着变。
      if (actionMatches(data, 'app.model.cycleForward')) {
        cycleModel('forward');
        return true;
      }
      if (actionMatches(data, 'app.model.cycleBackward')) {
        cycleModel('backward');
        return true;
      }
      // pi 的 `app.thinking.cycle`（`Shift+Tab`）：循环 thinking 级别。
      if (actionMatches(data, 'app.thinking.cycle')) {
        cycleThinking();
        return true;
      }
      // pi 的 `app.message.followUp`（macOS/Linux 是 `Option+Enter`，Windows 上是
      // `Ctrl+Q` —— 见 `keybindings.ts` 文件头）：**这一条**排成 followUp。
      //
      // 必须挂在这个全局监听器上，不能等编辑器：编辑器只认「提交」一个动作，而
      // 「提交到哪一列」是应用层的事（pi 也是把它当 `app.*` 键处理的）。见 `queue()`。
      if (actionMatches(data, 'app.message.followUp')) {
        followUp();
        return true;
      }
      // pi 的 `app.message.dequeue`（macOS/Linux 是 `Alt+Up`，Windows 上是 `Alt+Q`）：
      // 把排队消息还回编辑器。
      if (actionMatches(data, 'app.message.dequeue')) {
        if (restoreQueuedToEditor() === 0) notify(dim('没有排队的消息可还回'));
        refresh();
        return true;
      }
      // pi 的 `app.editor.external`（`Ctrl+G`）：交给 `$EDITOR` 改。
      if (actionMatches(data, 'app.editor.external')) {
        openExternalEditor();
        return true;
      }
      // pi 的 `app.message.copy`（`Ctrl+X`）：复制最后一条助手消息。
      if (actionMatches(data, 'app.message.copy')) {
        copyLastMessage();
        return true;
      }
      // pi 的 `app.clipboard.pasteImage`（`Ctrl+V`）：文件路径 / 图片 / 文本。
      if (actionMatches(data, 'app.clipboard.pasteImage')) {
        pasteFromClipboard();
        return true;
      }
      // pi 的 `app.suspend`（`Ctrl+Z`）：挂到后台（再 fg 回来）。
      if (actionMatches(data, 'app.suspend')) {
        suspendToBackground();
        return true;
      }
      // `app.trace.toggle`（默认 Ctrl+R）：**切到轨迹页 / 切回对话页**。
      //
      // 整页切换要重设布局（中间那块换了组件，primary ScrollView 也跟着换）—— 贴一块面板在对话区
      // 上面那种写法有两个毛病：轨迹一多把对话区挤没，而它自己不可滚。
      //
      // **轨迹页仍在 `ctrl+r`**：`ctrl+t` 是 `app.thinking.toggle`（展开/收起思考块），
      // 而两边共用一份 `~/.pi/agent/keybindings.json` —— 同一个键在两个应用里含义不同时，
      // 写覆盖的人没法表达「我想要哪个」。详情见 `keybindings.ts` 的文件头。
      // （`ctrl+t` 现在由下面那个 `app.thinking.toggle` 分支接，语义与 pi 一致。）
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
        // 与 pi 同一句（它的 `toggleToolOutputExpansion()`）：折叠要出声，否则用户不知道按到了。
        notify(t(expanded ? 'notify.toolOutput.expanded' : 'notify.toolOutput.collapsed'));
        return true;
      }
      // `app.thinking.toggle`（默认 Ctrl+T）：展开/收起思考块。**与 pi 同 id 同键**。
      //
      // `ctrl+t` 与 pi 含义一致（切思考块），所以共用一份 keybindings.json 没有歧义 —— 空着反而
      // 是一类静默退化（「按了没反应」）。
      //
      // 切换后写进 `settings.json` 的 `hideThinkingBlock`（与 pi 同一个键）——
      // 一个偏好不该只活到进程退出。
      if (actionMatches(data, 'app.thinking.toggle')) {
        hideThinking = !hideThinking;
        refresh();
        notify(t(hideThinking ? 'notify.thinkingBlocks.hidden' : 'notify.thinkingBlocks.visible'));
        // 落盘是**尽力而为**：内存里那个值已经是权威（界面当然立刻跟着变），
        // 写不进去（没权限）只影响「下次启动的默认值」—— 那种情况下说一句，别静默。
        void writeHideThinkingBlock(hideThinking, cwd).then((ok) => {
          if (!ok) notify(yellow('思考块已切换（这次生效），但没能写进 settings.json（写权限？）'));
        });
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

    if (extensionCommands() !== undefined) {
      // 扩展的 handler 可能是 async（它会弹对话框），而输入监听器是**同步**回调 ——
      // 在这里 await 就是等一个要人来点的窗口，会把输入队列堵住。
      // 所以不消费这个键（返回 undefined，让按键继续往编辑器走），只把 handler 排出去。
      const commands = extensionCommands();
      void commands
        ?.handleKey(data, () => false)
        .catch((error: unknown) => {
          notify(yellow(`扩展快捷键出错：${error instanceof Error ? error.message : String(error)}`));
        });
    }
    return undefined;
  };
  tui.addInputListener(onInput);

  // ─── 编辑器自己的 app 动作（pi 的 `CustomEditor.handleInput` 认这几个） ───
  //
  // 这一批**必须在编辑器上挂**（而不是像上面那几个全局开关挂在 input listener 上）：
  //
  //   1. 它们要改编**辑器自己的状态**（文字 / 光标）—— `Escape` 还要先给「取消补全」，
  //      所以必须经过 `CustomEditor.handleInput` 那一层判「补全在不在」。
  //   2. 它们**只在编辑器聚焦时才生效**：弹窗开着时不改编辑器（而全局开关那条路
  //      靠 `tui.hasOverlay()` 挡，两者刚好互补）。
  //
  // 这就是 pi 的分法（`interactive-mode.js` 的 `setupKeyHandlers()`）—— 照搬过来。
  editor.onAction('app.clear', () => clearEditorAndMaybeExit());
  editor.onAction('app.interrupt', () => interrupt());
  editor.onCtrlD = () => exitApp();
  editor.onPasteImage = () => pasteFromClipboard();

  editor.onSubmit = (rawText: string) => {
    const input = rawText.trim();
    if (!input) return;
    // 斜杠命令：不发给模型。
    if (input.startsWith('/')) {
      // 分类整个交给 `routeSlashInput()`（与 pi 同序）：skill → 模板 → 命令 → 普通输入。
      // 未命中的 `/xxx` **不是错误** —— 当普通用户输入发给模型（`/etc/hosts`、`/文件名`
      // 这类输入不该被命令层报错或吞掉，pi 也是认不出就原样发）。
      const route = routeSlashInput(input, stateSkills(), statePrompts(), (name) =>
        SLASH_COMMANDS.some((c) => c.name === name) || (extensionCommands()?.has(name) ?? false),
      );
      if (route.kind === 'skill' || route.kind === 'template') {
        if (store.getState().phase !== 'idle') {
          notify(yellow(`上一回合还没结束（按 ${keyLabel('app.interrupt')} 可中断）`));
          return;
        }
        send(route.text);
        return;
      }
      if (route.kind === 'command') {
        runCommand(input.slice(1));
        return;
      }
      // `message`：未命中，走下面普通输入的路径（排队 / 发送）。
    }
    if (store.getState().phase !== 'idle') {
      // **环在跑：入队，而不是拒绝。**
      //
      // 早期版本直接回一句「上一回合还没结束（Ctrl-C 可中断）」，于是用户想问
      // 「顺便查下版本」时唯一的选择是等——或者中断（丢掉模型已经跑出来的东西）。
      // 真正的做法与 pi 一样：**排进队列**，看它什么时候插进去。
      //
      // 回车 = **steer**（当前 step 的工具跑完后、下一次 LLM 调用前插进去）。
      // 要「等它说完再插」（followUp）按 `app.message.followUp`（mac 是 `Option+Enter`、
      // Windows 是 `Ctrl+Q`）—— 与 pi 同一套键位。
      queue(queuedInput(input), 'steer');
      return;
    }
    send(input);
  };

  /**
   * 把一句排队的输入送进内核。
   *
   * **入队不等于立刻插进去** —— 投递时机由 reducer 决定（见 queue.input 的注释）：
   * steer 在「工具跑完、下一次 LLM 调用前」，followUp 在「回合收工时」。
   *
   * ## 走哪一列由**按哪个键**定，不是一个模式开关
   *
   * pi 把这两件事分成两个键：回车 = `steer`，`app.message.followUp` = `followUp`
   * （mac 是 `Option+Enter`、Windows 是 `Ctrl+Q`）。
   * 不能做成一个 `Ctrl+Q` 切的**模式**：模式是**状态**，切过之后每条都按新列走，而屏幕上看不出
   * 自己在哪个模式里 —— 症状是「我明明按的回车，怎么排到 followUp 去了」。按键决定就没有这笔账。
   *
   * ## 为什么不在这里 `notify` 一句「已排队」
   *
   * 底部的队列卡片（`renderQueuePanel`）就是它的显示，而且**一直都在**（那一句
   * 「排了什么」本来就在那儿，还是全宽、还是每帧同步的）。再往对话流里插一张
   * `Steering: …` 的卡 = 同一件事说两遍，还多一行随对话滚走 —— pi 也不插。
   */
  const queue = (item: QueuedInput, as: QueueKind): void => {
    store.dispatch({ type: 'queue.input', text: item.text, content: item.content, as });
    refresh();
  };

  // ══════════════ 「完全复用 pi」的那几个动作 ══════════════
  //
  // 这一段是 `feat/pi-keybindings-parity` 的主体：把 pi 键位表里那些**表里有、行为没有**
  // 的 id 逐个接上。每个都尽量复用 pi 自己的实现（剪贴板 / 外部编辑器 / thinking 档位），
  // 只在「本项目内核长什么样」这一层自己写接线。

  /**
   * 当前模型对象（pi-ai 的 `Model`）。
   *
   * `state.model` 是**本项目的 `ModelState`**（provider / reasoning / capabilities /
   * contextWindow 那几项），不是 pi-ai 的 `Model` —— 所以不能直接当 `Model` 用。
   *
   * 拿不到就 `undefined`：需要模型能力（`reasoning`、支持的 thinking 档位）的地方
   * 只能退到「不支持」。**不编一个假 Model**：`getSupportedThinkingLevels` 会读它的
   * `api` / `reasoning` 等字段，假对象只会让症状出现在更靠里的地方。
   */
  const currentModelObject = (): Model<any> | undefined => {
    if (!options.runtime) return undefined;
    const state = store.getState();
    return modelRuntimeFor(options.runtime).getModel(state.providerName, state.modelId) as
      | Model<any>
      | undefined;
  };

  /**
   * 当前 thinking 级别该轮到的下一个（pi 的 `app.thinking.cycle`，`Shift+Tab`）。
   *
   * 与 pi 的 `cycleThinkingLevel()` 同口径：级别集合来自**模型支持的那几档**
   * （`getSupportedThinkingLevels`），缺 `reasoning` 的模型返回空 -> 提示「不支持」。
   *
   * **不落盘**：与 pi 一致 —— `cycleThinkingLevel()` 调 `setThinkingLevel(next)` 时没带
   * `{ persist: true }`，只有 `/thinking` 面板里的 `Ctrl+S` 才存成默认，`/settings` 里改的是
   * per-model 覆盖。（Shift+Tab 只改本次会话，不写 settings —— 写盘的是 `/thinking` 的 `Ctrl+S`。）
   *
   * 落点：`thinking.changed`（reducer 改 `state.thinkingLevel`），随后内核在下一轮
   * LLM 请求里带上新级别（`effects.ts` 从 `state.model.thinkingLevel` 读），
   * 会话记录器把这次变化写进会话文件（`session-recorder.ts`）。
   */
  const cycleThinking = (): void => {
    const before = store.getState().thinkingLevel;
    const model = currentModelObject();
    const next = nextThinkingLevel(model, before);
    if (next === undefined) {
      // pi 的文案（`Current model does not support thinking`）——说的是「没得切」，
      // 而不是「你敲错了键」。
      notify(t('notify.thinking.unsupported'));
      return;
    }
    store.dispatch({ type: 'thinking.changed', level: next as typeof before });
    // 不再当场 `notify`：换档位也由轨迹派生的配置提示给（`model.init` 带 `changed`）。
    refresh();
  };

  /**
   * 在作用域内循环换模型（pi 的 `app.model.cycleForward/Backward`，`Ctrl+P` / `Shift+Ctrl+P`）。
   *
   * ## 候选集：作用域非空就用作用域，否则用「当前 provider 的可用模型」
   *
   * 与 pi 的 `cycleModel()` 分歧一致（`_cycleScopedModel` vs `_cycleAvailableModel`）：
   * 配过 `/scoped-models` 的人显然只想在那几个里转。
   *
   * 换模型走 `options.setModel()`（内核的 `setModel`）—— 它会发 `model.changed` +
   * `model.init`，所以级别 / 能力 / 窗口都跟着一起重置，不需要这里手动改 state。
   */
  const cycleModel = (direction: 'forward' | 'backward'): void => {
    if (!options.runtime) {
      notify(yellow('未接内核（没有 provider 装配），换不了模型'));
      return;
    }
    if (!options.setModel) {
      notify(yellow('未接内核，换不了模型'));
      return;
    }
    const available = [...modelRuntimeFor(options.runtime).getAvailableSnapshot()];
    // 作用域里有模型就只用它们；作用域空（全开）就用**当前 provider** 的全部模型 ——
    // 把全 provider 的 1500 条拿来循环没意义（Ctrl+P 会跨到别的厂商去）。
    const scopedItems = currentScope.models;
    const scoped = scopedItems.map((item) => item.model);
    const candidates =
      scoped.length > 0
        ? scoped.filter((model) => available.some((m) => m.provider === model.provider && m.id === model.id))
        : available.filter((m) => m.provider === store.getState().providerName);
    const current = store.getState();
    const currentIndex = candidates.findIndex(
      (m) => modelKey(m) === `${current.providerName}\0${current.modelId}`,
    );
    const nextIndex = nextCycleIndex(candidates.length, currentIndex, direction);
    const next = nextIndex === undefined ? undefined : candidates[nextIndex];
    if (next === undefined) {
      notify(yellow(scoped.length > 0 ? '作用域里没有可切的模型' : '这个 provider 下没有可切的模型'));
      return;
    }
    if (nextIndex === currentIndex) {
      // pi 的两句（`cycleModel()`）：作用域里只有一个 vs 整个 provider 下只有一个。
      notify(t(scoped.length > 0 ? 'notify.model.onlyOneInScope' : 'notify.model.onlyOneAvailable'));
      return;
    }
    if (!options.setModel(next.provider, next.id, {
      // 作用域条目写死的档位（`/scoped-models` 里的 `p/i:high`）跟着一起传 —— pi 的
      // `_cycleScopedModel` 也把它当 `explicitLevel` 传给 `_getThinkingLevelForModelSwitch`。
      thinkingLevel: scopedItems.find((item) => modelKey(item.model) === modelKey(next))?.thinkingLevel,
    })) {
      notify(yellow(`换不了 ${next.provider}/${next.id}（配置里没它）`));
      return;
    }
    refresh();
    // 切换的反馈不在这里 `notify`：由轨迹派生的配置提示统一给（见 `model.init` 的
    // `changed` 标记）。这里只 `refresh()` 让底栏立刻跟上。
  };

  /** 最后一条 assistant 消息里的可见文本（`app.message.copy` 用它，与 pi 的 `getLastAssistantText` 同口径）。 */
  const lastAssistantText = (): string => {
    const messages = store.getState().messages;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role !== 'assistant') continue;
      return message.content
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
    }
    return '';
  };

  /** pi 的 `app.message.copy`（`Ctrl+X`）：复制选区或最后一条 assistant 消息。 */
  const copyLastMessage = (): void => {
    // 有选区的优选区（与 pi 的 `preferSelection` 一致）—— 但本项目是 AltScreen，
    // 选区复制由 `copyOnSelect` 自己处理，这里只管「最后一条消息」。
    const text = lastAssistantText();
    if (!text) {
      notify(yellow('还没有助手消息可复制'));
      return;
    }
    void copyToClipboard(text).then(
      () => notify(dim('已复制最后一条助手消息')),
      (error: unknown) =>
        notify(yellow(`复制失败：${error instanceof Error ? error.message : String(error)}`)),
    );
  };

  /** pi 的 `app.editor.external`（`Ctrl+G`）：把当前输入交给 `$EDITOR` 改完再收回来。 */
  const openExternalEditor = (): void => {
    const content = editor.getText();
    // 读 settings 的 `externalEditor`（与 pi 同一个键）。读不到就用 pi 的默认
    // （`editInExternalEditor` 内部同一条兜底链：`$VISUAL` / `$EDITOR` / vi）。
    let command = 'vi';
    try {
      command = SettingsManager.create(cwd, piAgentDir()).getExternalEditorCommand();
    } catch {
      command = 'vi';
    }
    // 先离开备用屏（不然外部编辑器会画在备用屏里、退出后一起消失）。
    tui.stop();
    void editInExternalEditor({ command, content })
      .then((result) => {
        if (result.status === 'complete') editor.setText(result.content);
      })
      .catch((error: unknown) => {
        // 回来之后再报 —— 这时 tui.start() 已把备用屏接回来。
        pendingNotice = yellow(`外部编辑器出错：${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        tui.start();
        refresh();
        if (pendingNotice !== undefined) {
          const text = pendingNotice;
          pendingNotice = undefined;
          notify(text);
        }
      });
  };
  /** `openExternalEditor` 在 tui 停摆期间攒下的一句话，回来后再报（内部用，不对外）。 */
  let pendingNotice: string | undefined;

  /** pi 的 `app.clipboard.pasteImage`（`Ctrl+V`）：文件路径 / 图片 / 文本三档兜底。 */
  const pasteFromClipboard = (): void => {
    void (async () => {
      try {
        const filePaths = await readClipboardFilePaths();
        if (filePaths && filePaths.length > 0) {
          // 文件路径：多行输入里一行一个（与 pi 非 bash 模式一致）。
          // 路径里带控制字符是异常（可能是剪贴板投毒），拒绝并说清楚。
          if (filePaths.some((p) => /\p{Cc}/u.test(p))) {
            notify(yellow('剪贴板里的文件路径含控制字符，已忽略'));
            return;
          }
          editor.insertTextAtCursor?.(filePaths.join('\n'));
          refresh();
          return;
        }
        const image = await readClipboardImage();
        if (image) {
          const ext = extensionForImageMimeType(image.mimeType) ?? 'png';
          const file = path.join(tmpdir(), `ela-clipboard-${randomUUID()}.${ext}`);
          writeFileSync(file, Buffer.from(image.bytes));
          editor.insertTextAtCursor?.(file);
          refresh();
          return;
        }
        const text = await readClipboardText();
        if (text) {
          editor.insertTextAtCursor?.(text);
          refresh();
        }
      } catch (error: unknown) {
        notify(yellow(`粘贴失败：${error instanceof Error ? error.message : String(error)}`));
      }
    })();
  };

  /** 编辑器被清空 / 退出时的反馈（pi 的 `app.clear` / `app.exit`，见下方 `onAction` 接线）。 */
  const clearEditorAndMaybeExit = (): void => {
    // pi 的 `handleCtrlC()`：500ms 内第二次才退出，否则只清空编辑器。
    const now = Date.now();
    if (now - lastCtrlC < 500) {
      tui.stop();
      printResumeOnExit();
      process.exit(0);
    }
    lastCtrlC = now;
    editor.setText('');
    refresh();
  };
  /** 上一次 `app.clear` 的时刻（两次之内退出，与 pi 的 `lastSigintTime` 同口径）。 */
  let lastCtrlC = 0;

  /** pi 的 `app.exit`（`Ctrl+D`，编辑器为空）：退出。 */
  const exitApp = (): void => {
    tui.stop();
    printResumeOnExit();
    process.exit(0);
  };

  /**
   * pi 的 `app.suspend`（`Ctrl+Z`）：挂到后台，`fg` 回来时恢复界面。
   *
   * ## 与 pi 的 `handleCtrlZ()` 逐条对齐
   *
   * - **`setInterval` 抱一个 handle 不让事件循环结束**：停掉 TUI 后 Node 可能没有
   *   活着的 handle，进程会在 `fg` 回来前就退出（那比「挂起」坏得多）。
   * - **挂起期间忽略 `SIGINT`**：后台进程收到终端发给整个进程组的 Ctrl+C 时不该被杀。
   * - **`kill(0, 'SIGTSTP')`**：`0` = 整个进程组，与本进程一起安静。
   * - `SIGCONT` 里 `tui.start()` 把备用屏接回来。
   *
   * Windows 没有 SIGTSTP，与控制台挂起也不是同一回事 —— 照 pi 的做法给一句提示就好。
   */
  const suspendToBackground = (): void => {
    if (process.platform === 'win32') {
      notify(yellow('Windows 不支持挂起到后台'));
      return;
    }
    const keepAlive = setInterval(() => {}, 2 ** 30);
    const ignoreSigint = (): void => {};
    process.on('SIGINT', ignoreSigint);
    process.once('SIGCONT', () => {
      clearInterval(keepAlive);
      process.removeListener('SIGINT', ignoreSigint);
      tui.start();
      refresh();
    });
    try {
      tui.stop();
      process.kill(0, 'SIGTSTP');
    } catch (error) {
      clearInterval(keepAlive);
      process.removeListener('SIGINT', ignoreSigint);
      throw error;
    }
  };

  /** pi 的 `app.interrupt`（`Escape`）：跑着就中断；有队列就把队列还回编辑器。 */
  const interrupt = (): void => {
    if (store.getState().phase !== 'idle') {
      restoreQueuedToEditor();
      abortRun();
      refresh();
      return;
    }
    // 空闲且没有队列：什么也不做（与 pi 的 double-escape 动作无关，本项目没那两个）。
    const restored = restoreQueuedToEditor();
    if (restored > 0) refresh();
  };

  /**
   * 把两条队列里的内容**拼回编辑器**（pi 的 `restoreQueuedMessagesToEditor`）。
   *
   * ## 为什么要清队列
   *
   * 还回编辑器意味着「这些我先不发了」。不清的话它们会在下一次投递点又插进去 ——
   * 于是编辑器里有一份、对话里也会冒出一份，看着像说重了。
   *
   * @returns 还了几条（0 = 队列本来就空）。
   */
  const restoreQueuedToEditor = (): number => {
    const state = store.getState();
    const all = [...state.steerQueue, ...state.followUpQueue];
    if (all.length === 0) return 0;
    const queued = all.map((item) => item.text).join('\n\n');
    const current = editor.getText();
    editor.setText([queued, current].filter((t) => t.trim() !== '').join('\n\n'));
    store.dispatch({ type: 'queue.clear' });
    notify(dim(`已把 ${all.length} 条排队消息还回输入框`));
    return all.length;
  };

  /**
   * pi 的 `app.message.followUp`（mac 是 `Option+Enter`、Windows 是 `Ctrl+Q`）：流式时按
   * followUp 入队；空闲时等同回车。
   *
   * 与 pi 的 `handleFollowUp()` 同口径：空闲时**等同回车**（这时候没有「等它说完」可言，
   * 直接发就是最贴意图的事），跑着才排队。
   *
   * 排队时不 `notify` —— 与 `queue()` 同一个理由：底部卡片就是它的显示。
   */
  const followUp = (): void => {
    const text = editor.getText().trim();
    if (!text) return;
    if (store.getState().phase === 'idle') {
      editor.setText('');
      editor.onSubmit?.(text);
      return;
    }
    editor.setText('');
    queue(queuedInput(text), 'followUp');
  };

  /**
   * 撤掉旧扩展画的界面（pi 的 `resetExtensionUI()`）：widget、底欄状态段、输入区槽位。
   *
   * `/reload` 在重装宿主**之前**调它：扩展实例换了之后，旧的 widget 组件没人会再移除
   * （新实例只知道自己的 key），不撤就会一直赖在那里；底欄状态段也会与新的叠在一起。
   */
  const clearExtensionUi = (): void => {
    for (const component of widgetSlots.values()) {
      try {
        (component as { dispose?: () => void }).dispose?.();
      } catch {
        // 旧 widget 的 dispose 失败不该挡住重装。
      }
    }
    widgetSlots.clear();
    extensionStatuses.clear();
    // 非 overlay 的 `custom()` 也属于旧激活：拆掉并把焦点/输入区还给 composer。
    mountEditorSlot(undefined);
    applyLayout();
    refresh();
  };

  /**
   * 斜杠命令。不发给模型 —— 那是「跟模型说」的通道，命令是「跟界面说」的。
   *
   * **只处理确实命中的命令**：未命中的 `/xxx` 在 `editor.onSubmit` 那里就分流去当
   * 普通输入发送了（与 pi 一致，见那里的注释）。所以 `default` 里那句提示只剩下
   * 「`SLASH_COMMANDS` 里有、switch 里没实现」这种内部不一致的场合。
   */
  const runCommand = (raw: string): void => {
    const [name = '', ...rest] = raw.trim().split(/\s+/);
    const arg = rest.join(' ');
    switch (name) {
      case 'skills': {
        // 表里唯一一条 pi 没有的命令（理由见 `SLASH_COMMANDS` 的注释）。
        //
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
                '然后 /reload（重读 skill / prompt / 上下文文件，不用重开会话）。',
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
      case 'copy': {
        // pi 的 `/copy`（`Copy last agent message to clipboard`）：与 `Ctrl+X` 同一条路
        // （`app.message.copy`），不另写一份「取最后一条助手消息」的逻辑。
        copyLastMessage();
        return;
      }
      case 'name': {
        // pi 的 `/name`：起名 / 不带参数看当前名字。
        //
        // 名字落在会话文件的 `session_info` entry 里（与 pi 同一个 entry type，
        // 所以 pi 的 `/resume` 面板、我们的恢复面板读的是同一个名字）。
        const file = currentSessionFileOnDisk();
        const wanted = arg.trim();
        if (wanted === '') {
          const current = currentSessionName();
          notify(
            current === undefined
              ? dim('这个会话还没有名字。用法：/name <名字>')
              : `${dim('会话名:')} ${current}`,
          );
          return;
        }
        if (file === undefined) {
          // 空会话不落盘（见 `SessionWriter.start`）：没有文件可追加，直接说清。
          // 注意用的是 `currentSessionFileOnDisk()` —— 在一条还不存在的文件上 append
          // 会造出一个没有 header 的半残会话文件。
          notify(yellow('这个会话还没落盘（一条消息都没发过），先聊一句再起名'));
          return;
        }
        appendSessionName(file, wanted);
        // 自己刚设的那个记在内存里：`readSessionName()` 只扫文件前 512KB，
        // 而这条 entry 在文件**末尾**（长会话里回读会读到旧名字）。
        sessionName = wanted.replace(/[\r\n]+/g, ' ').trim();
        sessionNameLoaded = true;
        notify(dim(`会话名已设为 ${sessionName}（写进 ${path.basename(file)}）`));
        return;
      }
      case 'session': {
        // pi 的 `/session`（`Show session info and stats`）：“这是个哪个文件 / 花了多少”。
        //
        // 数字全部念 `state.messages`（= 当前上下文），与底栏那一排 `↑↓R$` **同一口径**；
        // 为什么不念会话文件：那要连整个文件解开（18MB 的会话就要等），而且压缩之后
        // 两个数字对不上会让人以为算错了 —— 见 `session-info.ts` 头部的表。
        const file = currentSessionFileOnDisk();
        const name = currentSessionName();
        notify(
          formatSessionCard(
            collectSessionStats(store.getState().messages),
            {
              ...(file !== undefined ? { file } : {}),
              id: store.getState().session.id,
              ...(name !== undefined ? { name } : {}),
            },
            { dim, bold },
          ),
        );
        return;
      }
      case 'resume': {
        // pi 的 `/resume`（`Resume a different session`）。以前的 `/sessions` 已并入这里。
        //
        // 环在跑时不能换会话（正在写消息）。
        if (store.getState().phase !== 'idle') {
          notify(yellow(`上一回合还没结束，先按 ${keyLabel('app.interrupt')} 中断再恢复历史`));
          return;
        }
        openSessionPicker({
          tui,
          cwd,
          ...(currentSessionFile() !== undefined ? { currentSessionFile: currentSessionFile() } : {}),
          onPick: (session) => {
            // 名字跟着被选中的那条走（否则 `/name` 会显示上一个会话的名字）。
            sessionName = session.name;
            sessionNameLoaded = true;
            restoreSession(session);
          },
          // 官方只删会话文件，轨迹那份要我们自己补 —— 见 session-picker 的注释。
          onSessionDeleted: (session) => {
            if (!deleteSessionTrace(session)) {
              notify(
                dim(
                  `已删会话 ${session.id}（traces/ 里那份 ${path.basename(session.file)} 没删掉，可手动删）`,
                ),
              );
            }
          },
        });
        return;
      }
      case 'model': {
        // 环在跑时不能换：那条流正在等 token，而它的请求已经发出去了 ——
        // 中途换模型会让这一轮的模型与下一轮不同，而对话里看不出这个断点。
        if (store.getState().phase !== 'idle') {
          notify(yellow(`上一回合还没结束，先按 ${keyLabel('app.interrupt')} 中断再换模型`));
          return;
        }
        if (!options.runtime) {
          notify(yellow('未接内核（没有 provider 装配），换不了模型'));
          return;
        }
        // 选了模型之后要**真的**换：内核 setModel() 发一条 `model.changed`。
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
          // 切换本身不再当场 `notify`（由轨迹派生的配置提示给）；
          // 只失败的那几条（写盘 / 未接内核 / 换不了）在上面各自说。
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
      case 'thinking': {
        // 与 `/model` 同一句：环在跑时不能换 —— 那条流的请求已经按旧档位发出去了，
        // 中途改会让这一轮与下一轮的档位不同，而对话里看不出这个断点。
        if (store.getState().phase !== 'idle') {
          notify(yellow(`上一回合还没结束，先按 ${keyLabel('app.interrupt')} 中断再改思考级别`));
          return;
        }
        // 支持的档位由**模型**决定（`getSupportedThinkingLevels`）—— 与 Shift+Tab、
        // 与内核启动时的 clamp 是同一个来源。
        const levels = supportedThinkingLevels(currentModelObject());
        if (levels.length === 0) {
          notify(t('notify.thinking.unsupported'));
          return;
        }
        /** 真的换一档。`persist` = `Ctrl+S`（写 `settings.json` 的 `defaultThinkingLevel`）。 */
        const applyThinking = (level: ModelThinkingLevel, persist: boolean): void => {
          store.dispatch({ type: 'thinking.changed', level });
          refresh();
          if (!persist) {
            // 选中档位不再当场 `notify`：由轨迹派生的配置提示给（`model.init` 带 `changed`）。
            return;
          }
          // 写盘是异步的（pi 的 `save()` 是入队写），所以提示放在 `.then` 里 ——
          // 先报「已存」再报失败的话，用户看到的最后一行是矛盾的。
          void writeDefaultThinkingLevel(level, cwd).then((ok) => {
            notify(
              ok
                ? `Default thinking level: ${level}`
                : yellow('没能写进 settings.json（写权限？），默认思考级别没变'),
            );
          });
        };
        // `/thinking <级别>`：与 pi 的 `handleThinkingCommand` 同一形状 —— 在**这个模型
        // 支持的档位**里大小写不敏感地匹配，命中就直接切（不开面板）；不命中就报可选值
        // （文案也照 pi：「Unknown thinking level …」，因为那是从 pi 那边搜过的人记得的）。
        if (arg !== '') {
          const wanted = arg.trim().toLowerCase();
          const level = levels.find((candidate) => candidate.toLowerCase() === wanted);
          if (!level) {
            notify(yellow(`Unknown thinking level "${arg}". Available levels: ${levels.join(', ')}.`));
            return;
          }
          applyThinking(level as ModelThinkingLevel, false);
          return;
        }
        openThinkingPicker({
          tui,
          current: store.getState().thinkingLevel,
          levels,
          // `· default` 标的就是 settings 里的那一档（没有就到内置 medium —— 与 pi 的
          // `getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL` 同一句）。
          defaultLevel: readDefaultThinkingLevel(cwd) ?? DEFAULT_THINKING_LEVEL,
          onSelect: (level) => applyThinking(level, false),
          onSelectAsDefault: (level) => applyThinking(level, true),
        });
        return;
      }
      case 'settings': {
        // 与 `/model` / `/thinking` 同一句：环在跑时不能改 —— 面板里那几行都会立刻作用到
        // 正在跑的这一轮（自动压缩开关、当前模型的档位）。
        if (store.getState().phase !== 'idle') {
          notify(yellow(`上一回合还没结束，先按 ${keyLabel('app.interrupt')} 中断再改设置`));
          return;
        }
        if (!options.runtime) {
          notify(yellow('未接内核（没有 provider 装配），改不了设置'));
          return;
        }
        /** 当前模型的档位就地同步（pi 的 `onModelThinkingLevelChange` 也这么做）。 */
        const syncCurrentModel = (provider: string, modelId: string, level: string): void => {
          const state = store.getState();
          if (state.providerName !== provider || state.modelId !== modelId) return;
          store.dispatch({
            type: 'thinking.changed',
            level: clampForModel(currentModelObject(), isThinkingLevel(level) ? level : DEFAULT_THINKING_LEVEL),
          });
          refresh();
        };
        openSettingsPicker({
          tui,
          currentModel: currentModelObject(),
          models: [...modelRuntimeFor(options.runtime).getAvailableSnapshot()],
          defaultThinkingLevel: readDefaultThinkingLevel(cwd) ?? DEFAULT_THINKING_LEVEL,
          modelThinkingLevels: readAllModelThinkingLevels(cwd),
          onModelThinkingLevelChange: (provider, modelId, level) => {
            if (!isThinkingLevel(level)) return;
            void writeModelThinkingLevel(provider, modelId, level, cwd).then((ok) => {
              if (!ok) {
                notify(yellow('没能写进 settings.json（写权限？），这个模型的覆盖没存住'));
              }
            });
            syncCurrentModel(provider, modelId, level);
          },
          onModelThinkingLevelRemove: (provider, modelId) => {
            void removeModelThinkingLevel(provider, modelId, cwd).then((ok) => {
              if (!ok) notify(yellow('没能写进 settings.json（写权限？），覆盖没清掉'));
            });
            // 清掉 = 回到**全局默认**（pi：`setThinkingLevel(getDefaultThinkingLevel() ?? DEFAULT)`）。
            const global = readDefaultThinkingLevel(cwd);
            syncCurrentModel(provider, modelId, isThinkingLevel(global) ? global : DEFAULT_THINKING_LEVEL);
          },
          hideThinkingBlock: hideThinking,
          onHideThinkingBlockChange: (hidden) => {
            // 与 `Ctrl+T` 同一条路：就地改 + 写盘 + 重画（两处各写一份必然会漂移，
            // 而漂移的症状是「面板里改了、按 Ctrl+T 又回到旧值」）。
            hideThinking = hidden;
            refresh();
            void writeHideThinkingBlock(hidden, cwd).then((ok) => {
              if (!ok) notify(yellow('没能写进 settings.json（写权限？），下次启动还是旧的'));
            });
          },
          autoCompact: options.autoCompactEnabled?.() ?? null,
          onAutoCompactChange: (enabled) => {
            // 与 pi 一样**不报状态**：面板里那一行的右值当场就变了（`true` → `false`），
            // 再插一张卡是重复 —— pi 的 `onAutoCompactChange` 也只改值 + 刷底栏。
            options.setAutoCompactEnabled?.(enabled);
            refresh();
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
      case 'continue': {
        // 从「停下的地方再跑一次」：**不插 user 消息**（理由见 core 的 `turn.continue`）。
        //
        // 三种情况不续：跑着（会开第二条并行的环）、压缩中（messages 正要整份换掉）、
        // 一条消息都没有（没有可续的上下文）。
        const snapshot = store.getState();
        if (snapshot.phase !== 'idle') {
          notify(yellow(`上一回合还在跑，先按 ${keyLabel('app.interrupt')} 中断再续跑`));
          return;
        }
        if (snapshot.compacting) {
          notify(yellow('正在压缩上下文，压完再续跑'));
          return;
        }
        if (snapshot.messages.length === 0) {
          notify(dim('这个会话还没有消息 —— 先聊一句，/continue 才有可续的回合'));
          return;
        }
        // 与 send() 同一个门：扩展还没装载完就开跑，这一轮会用「没有扩展」的工具集与
        // prompt —— 而那正是恢复会话后最不该发生的一次请求。
        if (sending) return;
        sending = true;
        void (async () => {
          try {
            await ready;
          } finally {
            sending = false;
          }
          store.dispatch({ type: 'turn.continue' });
          refresh();
        })();
        return;
      }
      case 'new': {
        // 环在跑时不能换会话（正在写消息）。
        if (store.getState().phase !== 'idle') {
          notify(yellow(`上一回合还没结束，先按 ${keyLabel('app.interrupt')} 中断再开新会话`));
          return;
        }
        // 上一段的卡/键位表属于旧会话（消息已清空），不能跟着漂到新会话里 ——
        // pi 换会话时也是 `chatContainer.clear()`。
        statusCards.length = 0;
        hotkeysSource = undefined;
        hotkeysAtMessageIndex = undefined;
        hotkeysLinesCache = undefined;
        // 新会话没名字（旧名字挂在旧文件上）。不标 `loaded` 的话，`/name` 会去读刚建的
        // 那份空文件 —— 读出来也是 undefined，但少一个凭空的磁盘读。
        sessionName = undefined;
        sessionNameLoaded = true;
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
        notify(dim(`已开新会话 ${created.id}（上一段仍在 sessions/ 里，/resume 可回来）`));
        return;
      }
      case 'reload': {
        // pi 的 `/reload`：重读 settings / 扩展 / skill / prompt 模板 / 上下文文件，
        // 并重装扩展（新实例）。环在跑时不能做 —— 那一刻重装会把正在等的流 / 工具
        // 交给一个已经 shutdown 的宿主。
        if (store.getState().phase !== 'idle') {
          notify(yellow('上一回合还没结束，等它跑完再重载'));
          return;
        }
        const reload = options.reload;
        if (reload === undefined) {
          notify(yellow('未接内核（没有重载入口）'));
          return;
        }
        // 旧激活画的界面先撤（pi 在 reload 前也调 `resetExtensionUI()`）。
        clearExtensionUi();
        notify(dim('Reloading keybindings, extensions, skills, prompts, themes, and context files…'));
        void reload()
          .then((report) => {
            // 这三样在 TUI 侧（内核不知道）：键位表、`hideThinkingBlock`、主题。
            // 与 pi 的 `handleReloadCommand()` 同一组收尾动作。
            installProjectKeybindings();
            hideThinking = readHideThinkingBlock();
            setupTheme();
            // 扩展的快捷键可能换了：已经展开的键位表跟着重算（不重算就一直是旧表）。
            hotkeysLinesCache = undefined;
            if (hotkeysSource !== undefined) {
              hotkeysSource = hotkeysMarkdown(extensionCommands()?.shortcuts() ?? []);
            }
            // skill / prompt / 扩展清单与诊断是这一刻才有的 —— 用与启动同一个横幅重报
            // （pi 的 `showLoadedResources()`）。
            buildStartupBanner();
            refresh();
            if (!report.ok) {
              notify(yellow(report.message ?? '重载失败'));
              return;
            }
            const lines = [
              'Reloaded keybindings, extensions, skills, prompts, themes, and context files',
            ];
            // 诊断按 pi 的 `showDiagnosticsWhenQuiet: true` 口径一起报：重载是「重新读
            // 一遍」，读坏了（skill 重名 / 扩展装不上）必须在这一次就说。
            lines.push(...report.diagnostics.map((diagnostic) => yellow(diagnostic)));
            notify(lines.join('\n'));
          })
          .catch((error: unknown) => {
            notify(yellow(`重载失败：${error instanceof Error ? error.message : String(error)}`));
          });
        return;
      }
      case 'quit': {
        // pi 的 `/quit`（`Quit ela`）：走与 `Ctrl+D` 同一条退出路径
        // （`exitApp()` 会先离开备用屏，再打那行 `To resume this session:`）。
        exitApp();
        return;
      }
      case 'hotkeys': {
        // 与 pi 的 `/hotkeys` 同形：一张键位表，插进对话流里。
        //
        // **不弹面板**是刻意的：pi 也是把它 append 进对话区。理由是这样能一边看表
        // 一边往下翻自己的对话，而弹窗会盖住上下文、关掉之后表也没了。
        //
        // 表里的键名是**实时解析**的（`keyLabel()` → `getKeybindings()`），所以用户改过
        // `~/.pi/agent/keybindings.json` 之后这里显示的就是新键 —— 与顶行那个 `(Ctrl+R)`、
        // 与面板底部的提示行同一个来源。
        hotkeysSource = hotkeysMarkdown(extensionCommands()?.shortcuts() ?? []);
        hotkeysLinesCache = undefined;
        // 插在**当前对话末尾**（= 派生消息数）。之后的对话排在这张表下面，于是它会被
        // 往上顶开 —— 与 pi 把键位表 `addChild` 进对话区同一效果（见 hotkeysAtMessageIndex）。
        // 用派生条数（不是 `state.messages.length`）：块的下标是派生列表的下标。
        hotkeysAtMessageIndex = sessionMessageCount(store.getState());
        notify(dim('键位表已插进对话（改键位：~/.pi/agent/keybindings.json）'));
        refresh();
        return;
      }
      default:
        // 扩展的命令在**最后**试：内置的与 skill 的优先（skill 走上面的分支）。
        const commands = extensionCommands();
        if (commands?.has(name)) {
          void commands.run(name, arg).catch((error: unknown) => {
            notify(yellow(`/${name} 出错：${error instanceof Error ? error.message : String(error)}`));
          });
          return;
        }
        // 走到这里说明命令表与 switch 不一致（正常的未命中在 onSubmit 就分流了）。
        // 提示改成「打 `/` 看补全」：`/help` 已经删了（pi 也没有它，补全就是那个入口）。
        notify(yellow(`未知命令 /${name}（打 / 看补全）`));
    }
    void arg;
  };

  /**
   * 往对话流里插一张命令反馈卡（命令结果、错误）。
   *
   * 规则见 `statusCards` 的注释：尾部还是这张卡就**覆盖**，中间插过东西就**另起一张**。
   * `at` 取「当前消息条数」，渲染时按它 splice —— 于是新消息排在卡**下面**，
   * 卡被往上顶开、随会话滚走（`ScrollView` 的 `follow:'end'` 盯的是底部）。
   */
  const notify = (text: string): void => {
    const at = sessionMessageCount(store.getState());
    const last = statusCards[statusCards.length - 1];
    if (last && last.at === at) {
      // 尾部仍是这张卡（之后没插过任何东西）→ 就地覆盖，不新开一行。
      last.text = text;
    } else {
      statusCards.push({ text, at });
    }
    refresh();
  };

  /**
   * 恢复一个历史会话：把它的消息灌回 state（零 token）。
   *
   * 优先走内核那条：它换会话 id + 对齐记录器游标，不会把恢复出来的历史再写一遍盘。没接就退化成一条
   * `conversation.restored`，但**不换 id**、没有游标概念 —— 恢复出来的消息会被当前记录器当成新消息
   * 写盘，要说出来，不然用户以为是历史坏了。
   *
   * 必须**一条** action：每次 dispatch 都重渲染整段对话，逐条灌是 O(N²)（390 条实测 62 秒）。
   * 轨迹不跟着恢复（它是那一轮的产物，历史轨迹在 `traces/<id>.jsonl`）。
   */
  const restoreSession = (session: SessionSummary): void => {
    // 恢复的是**另一段历史**：上一段留下的卡/键位表归位（它们的锚点是旧会话的下标），
    // 否则会在新灌进来的对话里插到莫名位置。
    statusCards.length = 0;
    hotkeysSource = undefined;
    hotkeysAtMessageIndex = undefined;
    hotkeysLinesCache = undefined;
    // 先走内核那条，而且**先**判断再读文件：内核的 restoreSession(file) 自己会读，
    // 这里要是先 loadSessionMessages 就等于把 1MB 多的文件读两遍。
    if (restoreHook) {
      // **要等**：内核要读 `traces/<id>.jsonl` 才能把轨迹树带回来，
      // 不等就 refresh 的话，症状是「界面重渲染了，轨迹面板却还是空的」。
      // 恢复成功不弹提示：恢复了哪一段，自己点的自己清楚。
      void restoreHook(session.file).then(() => {
        refresh();
      });
      return;
    }
    const messages = loadSessionMessages(session);
    // 会话身份读 `state.session.id`（与桥 / TUI 别处同一个地方）。
    if (store.getState().session.id === session.id) {
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
      sessionId: store.getState().session.id,
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
    //
    // `before_agent_start` 在**发出去之前**调（与 pi 同序）：扩展看到的是「用户刚说了什么、即将开跑」
    // 这个时刻。
    //
    // **必须 await**：扩展可以改 prompt 段（写回 `systemPromptOptions.sections`，我们把它 diff 成一条
    // `prompt.segment.added`），那条补丁得在 `user.message` **之前**就位，否则本轮请求已经把
    // `state.messages` 读走了。改回 `void` 的症状很轻：首轮拿不到扩展的段，看不出哪里错。
    //
    // 期间用 `sending` 门钉住重复发送：`await` 打开了「连按两下」的窗口。
    //
    // 还要等**扩展装载完成**（`deferExtensions`）：装载前 state 里的工具集与 prompt 还是「没有扩展」
    // 的形状，先发出去的那条会把一份**缺工具集**的 head 写进会话与轨迹，而 head 是不可改的历史。
    // 是「等」而不是「拒」—— 用户的输入一句都不丢，只是晚一两秒出去（并说一声为什么）。
    if (sending) return;
    sending = true;
    if (!extensionsReady) {
      notify(dim('扩展还在后台装载 —— 装载完就把它发出去'));
    }
    void (async () => {
      try {
        await ready;
        await beforeAgentStartHook?.(text);
      } finally {
        sending = false;
      }
      store.dispatch({ type: 'user.message', text });
      refresh();
    })();
  };
  let sending = false;

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
    // 不分屏（轨迹不贴在对话区上面）：那样轨迹一多就把对话区挤没，而它自己又不可滚。
    //
    // 现在：顶部一行**页面标签 + 统计**（tabLine），中间那块的**内容**按 `page` 换掉，
    // 谁在中间谁就是 `primary`（pi-tui 的 key 处理只发给 primary
    // ScrollView —— 见 layout.js 的 `node.state.primary || !context.primaryScrollView`）。
    // 所以「滚轮 / PgUp / PgDn 在轨迹页滚轨迹、在对话页滚对话」是白得的，不用自己判。
    //
    // 不做分屏也就不用调两块的高度：中间那块永远 basis 0 + grow 1（唯一可伸缩的）。
    const bottom = new VStack([
      // 扩展的 widget（`pi-web-access` 的活动面板用它）。**不给 basis** ——
      // 给了就把高度钉死，面板里的内容一变就错位（同下面队列面板的理由）。
      ...[...widgetSlots.values()].map((component) => ({ component, minSize: 1 })),
      // 队列面板在输入框**之上** —— 用户敲完字、回车之前就该看到刚才排了什么。
      //
      // `minSize: 0`：**空队列时一行都不占**（`renderQueuePanel` 返回空串 → `Text` 渲染成
      // `[]`）。pi 那边也是 `minSize: 0`（`chat-viewport.js` 的 pendingMessages）——
      // 写 1 会常年留一条空行，看着像「底区坏了」。非空时它自己的高度就是内容高度。
      { component: queuePanel, minSize: 0 },
      // 会话区与输入区之间的空隙 —— pi 的 `widgetContainerAbove` 里那个 `Spacer(1)`。
      // 必须在这里（输入区**正上方**）而不是 widget 之前：pi 那边给空隙的是紧贴
      // 编辑器的那个容器，所以排队卡与输入框之间也有这一行。理由见 `dockGap`。
      { component: dockGap, basis: 1, grow: 0, minSize: 1 },
      // **输入区那一格**：默认是 composer；扩展的 inline `custom()` 挂上来时换成它的
      // 组件（pi 的 `editorContainer.clear(); addChild(component)`）。
      //
      // 只给 `minSize: 1` 而不给 basis：扩展的组件**自己**决定高度（问卷按
      // `tui.terminal.rows` 算 inline 预算），钉一个 basis 就会把它截短或留白。
      // composer 那边仍然是 3（上/下框线 + 一行输入）。
      editorSlotComponent === undefined
        ? { component: editor, minSize: 3 }
        : { component: editorSlotComponent, minSize: 1 },
      // 底栏行数 = `FOOTER_ROWS`，与 `/model`、`/resume` 那些面板的
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

  /**
   * 扩展的**输入区槽位** —— 非 overlay 的 `custom()` 与三个原生对话框都落在这一格。
   *
   * 焦点与文本的存/还都在这里做（pi 在自己的 `showExtensionCustom()` 里也是这么做的）：
   * 进槽位时把焦点交给扩展组件、记住 composer 里那行字；出槽位时把焦点**还回**
   * composer，并把那行字还原。
   *
   * 为什么焦点必须在这里还：`tui.setFocus()` 是 pi-tui 的进程级状态，而扩展只会在
   * 自己的 `done` 里 resolve —— 它不知道 composer 是谁。界面是**唯一**知道的那个。
   */
  const mountEditorSlot = (component: (Component & { dispose?: () => void }) | undefined): void => {
    const previous = editorSlotComponent;
    if (previous !== undefined && previous !== component) {
      // pi 是直接 `clear()` 掉旧的（它那个 `custom()` 的 promise 就永远不 resolve）；
      // 这里顺手 dispose，别把旧组件的定时器/监听器留在进程里。
      try {
        previous.dispose?.();
      } catch {
        // 旧组件的 dispose 失败不该挡住新的上场。
      }
    }
    editorSlotComponent = component;
    if (component === undefined) {
      if (editorTextBeforeSlot !== undefined) {
        editor.setText(editorTextBeforeSlot);
        editorTextBeforeSlot = undefined;
      }
      tui.setFocus(editor);
    } else {
      editorTextBeforeSlot = editor.getText();
      tui.setFocus(component);
    }
    // children 变了 —— 必须重设布局（同 setWidget：VStack 的 children 是建的时候定下的）。
    applyLayout();
    refresh();
  };

  /** 挂一个对话框组件，返回拆台函数（先 dispose，再还回 composer）。 */
  const mountDialog = (component: Component & { dispose?: () => void }): (() => void) => {
    mountEditorSlot(component);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      try {
        component.dispose?.();
      } catch {
        // 与槽位那边同一句：收尾失败不该把用户的答复丢掉。
      }
      mountEditorSlot(undefined);
    };
  };

  /**
   * 终端侧的 `ctx.ui.select/confirm/input`（与浏览器那一份在 core 的 `raceDialog` 里并起来）。
   *
   * 用 pi 自己那两个组件、挂在**同一个输入区槽位**里 —— 与 `custom()` 的非 overlay 那条路
   * 同一个位置，扩展看到的布局形态不会因为「走哪条路」而变。
   */
  const tuiDialogs: TuiDialogs = {
    select: (title, choices, done) =>
      mountDialog(
        new ExtensionSelectorComponent(title, [...choices], (option) => done(option), () => done(undefined), {
          tui,
        }),
      ),
    confirm: (title, message, done) =>
      mountDialog(
        new ExtensionSelectorComponent(
          `${title}\n${message}`,
          ['Yes', 'No'],
          (option) => done(option === 'Yes'),
          () => done(false),
          { tui },
        ),
      ),
    input: (title, placeholder, done) =>
      mountDialog(
        new ExtensionInputComponent(title, placeholder, (value) => done(value), () => done(undefined), {
          tui,
        }),
      ),
  };

  /**
   * 开一份**问卷的浏览器那一份**（终端那一份由扩展自己的组件画 —— 见
   * `@ela/core/questionnaire` 的文件头）。
   *
   * 这里只做三件事：把桥当渲染器开起来、把状态机的每一帧推过去、把桥回来的意图交回状态机。
   * 没有浏览器连着时 `open()` 仍然返回句柄（帧先广播给零个订阅者，浏览器一接上就补发当前
   * 那一帧）—— 终端那边照常能答完，谁先答都算数。
   *
   * 拆台由内核调：提交/取消之后它已经拿到答案；终端先答完（或工具结束）时它也会叫我们。
   */
  const openQuestionnaire = (session: QuestionnaireSession): (() => void) => {
    const handle = options.dialogs?.()?.questionnaire?.open(session.snapshot(), (intent) => {
      session.apply(intent);
    });
    if (handle === undefined) return () => {};
    const unsubscribe = session.subscribe((snapshot) => handle.push(snapshot));
    return () => {
      unsubscribe();
      handle.close();
    };
  };

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
    /**
     * 扩展的**输入区槽位** —— 非 overlay 的 `custom()` 落在这一格（见 `editorSlotComponent`
     * 的注释）。
     *
     * 焦点与文本的存/还都在这里做（pi 在自己的 `showExtensionCustom()` 里也是这么做的）：
     * 进槽位时把焦点交给扩展组件、记住 composer 里那行字；出槽位时把焦点**还回**
     * composer，并把那行字还原。
     *
     * 为什么焦点必须在这里还：`tui.setFocus()` 是 pi-tui 的进程级状态，而扩展只会在
     * 自己的 `done` 里 resolve —— 它不知道 composer 是谁。界面是**唯一**知道的那个。
     */
    mountEditorSlot,
    // 扩展的 `ctx.ui.setEditorText`（Orca 的 prefill 扩展用它把提示词填进 composer）。
    // `setText` 会重画，不需要我们自己 refresh。
    setEditorText: (text: string) => {
      editor.setText(text);
    },
    /**
     * 扩展的底栏状态段（`ctx.ui.setStatus(key, text)`）。
     *
     * `undefined`（或空串）就是清掉那一格 —— 与官方语义逐字一致。这里必须
     * `refresh()`：底栏那两行是我们每帧自己拼的文本，不重算就一直是旧的那行。
     *
     * 渲染位置在 `refresh()` 里（`extensionFooterRow`）：第一行右半边。
     */
    setStatus: (key: string, text: string | undefined) => {
      if (text === undefined) extensionStatuses.delete(key);
      else extensionStatuses.set(key, text);
      refresh();
    },
    /**
     * 工具输出是否全部展开（pi 的 `ctx.ui.getToolsExpanded` / `setToolsExpanded`）。
     *
     * 与 `app.tools.expand`（Ctrl+O）是**同一个** `expanded` 变量 —— 这是故意的：
     * `pi-subagents` 在跑 subagent 前会 `setToolsExpanded(false)`（「把主转录收起来，
     * 别把整个屏幕刷满」）—— 让那个开关跟我们自己的键位指向两个不同的状态的话，
     * 用户按 Ctrl+O 看到的东西就与扩展以为的不一致。
     */
    getToolsExpanded: () => expanded,
    setToolsExpanded: (value: boolean) => {
      expanded = value;
      refresh();
    },
    tuiDialogs,
    questionnaire: openQuestionnaire,
    ...(options.dialogs !== undefined ? { dialogs: options.dialogs } : {}),
  });

  /**
   * 开场横幅 —— **写成函数是因为它在 `deferExtensions` 下要报两次**。
   *
   * `deferExtensions`（TUI 现在不走这条）下扩展是后台装的，而这几节的内容
   * （skill 清单、prompt 清单、扩展清单与装载诊断）恰恰就是装载那一刻才有的：首帧那次
   * 只能报到「正在装载」，装载完成后再报一次才是**真的**。写成一次性的话，症状是
   * 「装了扩展，但开场横幅上永远看不到它」—— 而那条横幅的全部意义就是让人看见。
   */
  const buildStartupBanner = (): void => {
    const startupSkills = stateSkills();
    const startupDiagnostics = store.getState().prompt.skillDiagnostics ?? [];
    // prompt 模板清单与诊断：与 skill 同一次 `prompt.init` 装载，同一种「装载完成需重报」
    // 的时机（`deferExtensions` 下也是 `ready` 之后才有）。
    const startupPrompts = statePrompts();
    const startupPromptDiagnostics = store.getState().prompt.promptDiagnostics ?? [];
    // **每次现取**：装载完成后 `entries` / `errors` 才有内容（见 `TuiOptions.extensions`）。
    const extensionInfo = options.extensions?.();
    const extensionEntries = (extensionInfo?.entries ?? []).filter((e) => !e.hidden);
    const extensionErrors = extensionInfo?.errors ?? [];
    // 扩展还在后台装：横幅里说清这件事 —— 那几秒里发消息会被按住（见 `send()`），
    // 而「按了回车没反应」必须有解释。
    const loadingExtensions = options.ready !== undefined && !extensionsReady;
    // `[Context]` 那一节：进了 prompt 的上下文文件（`SYSTEM.md` / `APPEND_SYSTEM.md` /
    // `AGENTS.md` …）。清单由 `contextFilePaths()` 给，与 `buildPromptOptions()` **同一个来源** ——
    // 界面报的和模型收到的必须是同一批文件（理由见 `system-prompt.ts` 那个函数的注释）。
    const contextFiles = contextFilePaths(cwd);
    // 护栏要把上下文与扩展也算进去：只装了扩展没装 skill（或反过来）时，这几节**照样**要出。
    // 早先写成只看 skill，于是「一个 skill 都没装」的用户永远看不到扩展清单 ——
    // 而那恰好是最需要看到的人（他们不靠 skill，只靠扩展）。装载中那一行同一个道理：
    // 一节点东西都还没有的时候，正是最需要说明「为什么现在什么都没有」的时候。
    if (
      contextFiles.length === 0 &&
      startupSkills.length === 0 &&
      startupDiagnostics.length === 0 &&
      startupPrompts.length === 0 &&
      startupPromptDiagnostics.length === 0 &&
      extensionEntries.length === 0 &&
      extensionErrors.length === 0 &&
      !loadingExtensions
    ) {
      // 一段可报的都没有（`ready` 之后再报一次时可能变成这样）：清空 ——
      // 不清的话「正在装载…」那一行会永远赖在横幅上。
      banner.text = '';
      refresh();
      return;
    }
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
    // 与 pi 同形：`[Prompts]` 列 `/名字`（排序后逗号连排，剩下交给终端折行）。
    // 位置在 `[Skills]` 之后、`[Extensions]` 之前 —— pi 的顺序是 Context / Skills /
    // Prompts / Extensions，终端里扫一眼就知道这轮有哪些 `/` 命令可用。
    if (startupPrompts.length > 0) {
      const names = startupPrompts.map((p) => `/${p.name}`).sort((a, b) => a.localeCompare(b));
      lines.push(`${yellow('[Prompts]')}\n${dim(names.join(', '))}`);
    }
    // **常驻**（不靠 notify）：pi 的开场那一节也是 `loadedResourcesContainer` 里的
    // 常驻组件，永不消失。skill 名单要反复对照着打 `/skill:x`，30 秒后就没了等于没有。
    //
    // 这一节报的是**扩展**（入口 + 来源），不是它注册的工具名 —— 见
    // `resource-labels.ts` 的文件头：报工具名会让用户拿着工具名去 `packages` 里找扩展。
    if (extensionEntries.length > 0) {
      lines.push(`${yellow('[Extensions]')}\n${dim(extensionLabels(extensionEntries).join(', '))}`);
    }
    // 诊断统一排在清单之后（与 pi 的 `showLoadedResources` 同序）：
    // Skill conflicts → Prompt conflicts → Extension issues。
    //
    // 加载不上的 skill / 模板要看得见 —— 否则就是「模型静默少了能力」或「命令凭空消失」，
    // 而用户与界面都不知道为什么。
    if (startupDiagnostics.length > 0) {
      lines.push(
        `${yellow('[Skill conflicts]')}\n` +
          startupDiagnostics.map((d) => yellow(`  ${d}`)).join('\n'),
      );
    }
    if (startupPromptDiagnostics.length > 0) {
      lines.push(
        `${yellow('[Prompt conflicts]')}\n` +
          startupPromptDiagnostics.map((d) => yellow(`  ${d}`)).join('\n'),
      );
    }
    if (extensionErrors.length > 0) {
      lines.push(
        `${yellow('[Extension issues]')}\n` + extensionErrors.map((e) => yellow(`  ${e}`)).join('\n'),
      );
    }
    // 装载中：说清「为什么现在一节点东西都没有」，以及为什么按回车没反应（见 `send()`）。
    // 这一行在 `ready` 那次重报里自然消失（那时报的是真的清单）。
    if (loadingExtensions) {
      lines.push(
        `${yellow('[Extensions]')}\n${dim('正在后台装载（`settings.json` 的 packages）—— 装载完成前发不出消息')}`,
      );
    }
    banner.text = lines.join('\n\n');
    refresh();
  };
  buildStartupBanner();
  if (options.ready !== undefined) {
    // 装载完成：`extensionsReady` 翻真（之后 `send()` 不再等），并把横幅**重报一次** ——
    // skill 清单、prompt 模板清单、扩展清单、装载诊断都是这一刻才有的。
    void options.ready.then(() => {
      extensionsReady = true;
      buildStartupBanner();
    });
  }
  if (prompt !== undefined) {
    // 一次性模式：TUI 的差分渲染在非交互终端里只会留下一堆转义序列，
    // 所以不走界面 —— 直接跑环，然后把**纯文本**的对话与轨迹树打到 stdout。
    // 轨迹树照样有（这才是重点），只是不经过 pi-tui 的画布。
    tui.stop();
    // 万一装载是推后的（`main.ts` 那边正常不会给这种组合，但门是免费的）：
    // 一次性模式没有「等一下」的余地 —— 等够再发，否则这一条会把一份缺工具集的 head
    // 写进会话与轨迹（见 `TuiOptions.ready`）。
    await ready;
    store.dispatch({ type: 'user.message', text: prompt });
    await waitForIdleOrExit(store);
    // 一次性模式没有终端尺寸（不走 TUI），给 0 = 不折行、不截断（truncateToWidth 的约定）。
    //
    // **必须剥掉控制序列**：这一段是管道/重定向的接收方，拿到 OSC 8 超链接（文件路径那行
    // `]8;;file:///…\…]8;;`）只会得到一团乱码。官方渲染器对文件路径加超链接
    // （`renderToolPath` → `linkPath`），而那是按**终端能力**自动判的 —— 在 iTerm2 / VSCode /
    // Warp / Windows Terminal 这些被认出来的终端里为真，所以不能指望它关着。
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
 * 用 `create*ToolDefinition()` 而不是 `createAllToolRenderers()`：后者返回的表里 `edit` 的
 * `renderShell` 是 `undefined`，而定义上是 `"self"`。漏掉的后果很隐蔽 —— `edit` 块底色被套两层
 * （`48;2;37;65;49` 出现两次，浅色/高对比主题下边界会错位），而且 `edit` 会走错代码路径
 * （`selfRenderContainer` vs `contentBox`），将来官方改形状时我们跟错还不报错。
 *
 * 标题就是英文工具名（官方 `label` 本来就是 `edit`/`read`）：另起一套中文 label 是**二次翻译**，
 * 多一层维护还让界面与 pi 对不上。
 *
 * 表里没有的工具（扩展工具）交给 `toolDefinitionFor()` 兜底。
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
 * 一个工具的**渲染定义** —— 表里有就用它，没有就给一个只有 `label` 的兜底。
 *
 * **不能**对扩展工具传 `undefined`：`ToolExecutionComponent` 会走它自己的
 * `formatToolExecution()`（工具名 + 参数 + **整段**输出），那条路**完全不看 `expanded`** ——
 * 于是 Ctrl+O 折叠了，扩展工具的块还是全铺开。pi 那边扩展工具有定义（只是不带 `renderCall` /
 * `renderResult`），组件于是走 fallback，而 fallback 认 `expanded`。
 *
 * 分岔点是有没有**定义**（`hasRendererDefinition()`）而不是有没有渲染器，所以 `{ label: name }`
 * 就够；写上 `label` 是为了让这个对象诚实（它确实是个工具定义）。
 */
function toolDefinitionFor(name: string): unknown {
  return TOOL_RENDERERS[name] ?? { label: name };
}

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
 * 必须推迟到微任务并加重入护栏：官方 `ToolExecutionComponent` 在**我们的渲染过程中**就调
 * `ui.requestRender()`，同步接上 `refresh` 就是「refresh → … → renderTool → requestRender →
 * refresh」的无限递归（`RangeError: Maximum call stack size exceeded`）。
 *
 * 推迟就够：`context.invalidate()` 才是官方的重画入口，它已经清了组件自己的 `render()` 缓存 ——
 * 官方要的是「下一帧被重画」，状态变化本身由 `store.subscribe` → `refresh` 覆盖。
 *
 * 两道闸缺一不可，且**都必须在入口判**：`queued` 合并一帧内的多次请求；`rendering` 把渲染途中
 * 发来的请求直接丢掉。若 `rendering` 只在微任务里判，得到的是**自激循环而不是爆栈** —— 每轮排一个
 * 新微任务，栈一直浅、堆一直涨，症状是跑几分钟后 `FATAL ERROR: heap out of memory`。
 * 丢弃是安全的：此刻这次 `fn` 正在把新内容带上，再画一帧只是白做一倍工作。
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
 * ## 块后面那句话要**单独再画一条用户消息**
 *
 * 官方组件的类注释就写着「Only renders the skill block itself - user message is
 * rendered separately」，pi 的 `addMessageToChat()` 也在那一支里补了 `Spacer(1)` +
 * `UserMessageComponent(skillBlock.userMessage)`。本项目早先只画了卡片，症状是
 * `/skill:x 帮我看下这个报错` 里**人问的那句话整个不见了** —— 而模型明明收到了它，
 * 于是「模型在回答哪句话」在界面上无从对照。
 *
 * 认不出来就画普通用户消息（不是 `[]`）：宁可多显示一点，也不要把内容吞掉。
 */
function renderSkillBlock(text: string, width: number, expanded: boolean): string[] {
  const block = parseSkillMessage(text.trim());
  if (!block) return renderUser(text, width);
  const component = new SkillInvocationMessageComponent(block, getMarkdownTheme());
  component.setExpanded(expanded);
  const lines = component.render(usableWidth(width));
  if (block.userMessage) {
    // 一行空隙：与 pi 的 `Spacer(1)` 同一处，也是为了别让蓝块贴着卡片的下框线。
    lines.push('');
    lines.push(...renderUser(block.userMessage, width));
  }
  return lines;
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
  /** 思考块是否折叠（`Ctrl+T`）。折叠时官方组件只留一行斜体的思考占位行。 */
  hideThinking = false,
  /**
   * 这条消息是怎么停的（`message.stopReason` / `message.errorMessage`）。
   *
   * ## 收尾说明为什么不交给官方组件画
   *
   * pi 的 `AssistantMessageComponent` 会自己在末尾补那几种收尾：
   *
   * | `stopReason` | 它画什么 |
   * | --- | --- |
   * | `aborted`（且没有工具调用） | 空一行 + `Operation aborted` |
   * | `length` | 空一行 + `Response was truncated before completion.` |
   * | `error`（且没有工具调用） | 空一行 + `Error: <原因>` |
   *
   * 那三句是它**硬编码的英文**，改不了 —— 界面其它文案都是中文，唯独收尾是英文。
   * 所以这里不把 `stopReason` 传给它（它就不画），收尾由下面自己画，形状与它
   * 一致（空一行 + 一行错误色），句子走 i18n；`aborted` 时 provider 给了具体
   * 原因就带上（与 pi 同一个选择：具体原因比一句统一文案有用）。
   */
  stop?: { stopReason?: string | undefined; errorMessage?: string | undefined } | undefined,
): string[] {
  // 先筛掉空的：Markdown 对空白文本返回 []，而 toolCall 块在这里不画
  // （它由紧接着的 toolResult 消息负责）—— 不筛的话每条纯工具调用消息会多出空行。
  const visible = content.filter((raw) => {
    const c = raw as { type?: string; text?: string; thinking?: string };
    if (c.type === 'text') return (c.text ?? '').trim() !== '';
    if (c.type === 'thinking') return (c.thinking ?? '').trim() !== '';
    return false;
  });
  if (visible.length === 0) {
    // 纯工具调用消息：工具块自己显示错误，但 `length`（截断）仍要在这条消息上
    // 说一句（与 pi 一致：截断可能发生在工具调用完成之前）。
    // 有收尾说明时 pi 是无条件 `Spacer(1)` + 文字 —— 消息本身没画东西也一样，
    // 空行不能省：否则「操作已中止」会顶在前一块（工具卡/用户消息）正下面。
    const tail = stopNoticeLine(content, stop);
    return tail !== undefined ? ['', ...tail] : [];
  }
  const message = {
    role: 'assistant',
    content: visible,
    // 收尾说明自己画（见上），stopReason/errorMessage 不给官方组件 ——
    // 给了它会再画一遍英文的那三句。
  } as never;
  // 第二个参数就是官方的 `hideThinkingBlock` —— 折叠的渲染（那一行思考占位）由
  // 它自己负责，我们只管把开关与占位文案传对。
  const component = new AssistantMessageComponent(
    message,
    hideThinking,
    getMarkdownTheme(),
    t('thinking.label'),
    1,
  );
  // 构造器已经渲染过一次；显式再调一次是为了把「是否还在流式」告诉它 ——
  // 官方用它决定列表编号等细节要不要稳定。
  component.updateContent(message, isStreaming);
  const lines = component.render(usableWidth(width));
  const tail = stopNoticeLine(content, stop);
  if (tail !== undefined && lines.length > 0) {
    lines.push('', ...tail);
  }
  return lines;
}

/**
 * 中止时 provider 侧的占位原文（无信息量，不当成「具体原因」透传，见 `stopNoticeLine`）。
 */
const ABORT_PLACEHOLDER_RE = /^Request( was)? aborted\.?$/;

/**
 * 助手消息的收尾行（空行由调用方补）。形状照抄 pi 的组件：`length` 一句、
 * `aborted` / `error` 各一句（都没有工具调用时才画 —— 工具的错误由工具块显示）。
 */
function stopNoticeLine(
  content: readonly unknown[],
  stop?: { stopReason?: string | undefined; errorMessage?: string | undefined } | undefined,
): string[] | undefined {
  const reason = stop?.stopReason;
  if (reason !== 'length' && reason !== 'aborted' && reason !== 'error') return undefined;
  const hasToolCalls = content.some((raw) => (raw as { type?: string }).type === 'toolCall');
  if (reason !== 'length' && hasToolCalls) return undefined;
  const errorMessage = stop?.errorMessage;
  if (reason === 'length') return [theme.fg('error', t('assistant.truncated'))];
  if (reason === 'aborted') {
    // 与 pi 同一个判断：provider 的占位原文不算「具体原因」。pi 只排了
    // `Request was aborted` 一种，但中止占位原文实际有三种 —— pi-ai 自建的
    // `createAbortError()` 是 `Request aborted`（provider-retry），部分 provider
    // 路径是 `Request was aborted`，OpenAI SDK 的默认中止错误还带句号。都是
    // 「被喊停了」，没有信息量，不该当成原因透传。
    const specific =
      errorMessage !== undefined &&
      errorMessage !== '' &&
      !ABORT_PLACEHOLDER_RE.test(errorMessage)
        ? t('assistant.abortedWithReason', { reason: errorMessage })
        : t('assistant.aborted');
    return [theme.fg('error', specific)];
  }
  return [theme.fg('error', t('assistant.error', { message: errorMessage || t('assistant.unknownError') }))];
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
    toolDefinitionFor(message.toolName) as never,
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
 * 必须自己插：`UserMessageComponent` 的 `paddingY=1` 产生的那两行是**带蓝底**的，蓝块往上多出一行
 * 同色边，看起来就是「工具调用之间都有间隔，用户的蓝块却直接贴上来」（助手块/工具块的空行无底色，
 * 所以那边本来就是真空隙）。
 *
 * 与 pi 的 `addMessageToChat` 一致：`case "user"` 时 `children.length > 0` 才插 `Spacer(1)`。
 * 这里用「已经有内容画上去了」（`at > 0`）等价。
 *
 * @param at 这条消息之前已经画了多少行（用来判断是不是首条）
 */
function userSpacer(message: { role: string }, at: number): string[] {
  return message.role === 'user' && at > 0 ? [''] : [];
}

/**
 * 渲染**正在跑**的工具（`toolResult` 消息还没有，但工具已经开跑了）。
 *
 * 一个长命令在跑的时候 `state.messages` 里还没有 `toolResult`，但 `state.executing` 有那条调用、
 * `state.toolProgress` 有边跑边送出来的输出。只看 `messages` 的话工具一开跑就什么都不显示 ——
 * 几十秒的空白与「卡死了」在屏幕上没有区别。
 *
 * `isPartial: true` 让官方渲染器接管「进行中」的样子：底色换成 `toolPendingBg`、底部那行从
 * `Took` 换成 `Elapsed` 并起定时器跳秒、接受**不完整**的输出。这些细节手写要对齐一堆。
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
 * 必须有它：官方 bash 渲染器在 `renderResult` 看到 `isPartial` 时会 `setInterval(…, 1000)` 让
 * `Elapsed` 每秒重画，而它只在**同一个组件**收到非 partial 的 `updateResult` 时才 clear —— 每帧 new
 * 一个的话那些 interval 永久留着，事件循环永远不空。反过来每帧 `stopRendererTimers()` 能避开泄漏，
 * 但 `Elapsed` 再也不跳（跑几十秒仍显示 `0.0s`）。
 *
 * 泄漏收口：组件只在工具**真的在跑**时留在表里，`pruneLiveTools` 每帧按 `executing` 清掉已结束的
 * （同时停掉它的计时器），所以生命周期 = 工具执行时长。
 *
 * 不拖累增量渲染：带运行中工具的那个块**本来就不进缓存**，且一轮里至多一个这样的块。
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
    toolDefinitionFor(call.name) as never,
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
 * 渲染**一条**消息（`from` 恒为 0：滚动交给 ScrollView）。
 *
 * 单独抽出来是因为对话区是**增量**渲染的：每条消息各自成为一个组件，内容没变就不重算；整段渲染只有
 * 一次性模式与测试才需要。
 *
 * **不加「你 ›」「助手 ›」这类前缀**：pi 靠**底色与字体形状**区分角色（用户整块蓝底、助手默认前景色、
 * 思考灰斜体）。加前缀会把蓝底变成「`你 ›` + 白字」，模型说的话与提示挤在同一行、斜体失效。
 *
 * 直接用 pi 的组件（`UserMessageComponent` / `AssistantMessageComponent` /
 * `ToolExecutionComponent` + `createAllToolRenderers()`）而不是照着截图重画：里面有一堆眼睛看不出但
 * 错了很难受的细节（bash 折叠保留**尾部** 5 行而 read/write 保留头部 10 行、write 的块里是文件内容、
 * edit 渲染彩色 diff、每个工具块用 `Box` 把底色补到整行）。各自都不难，**一起对**才一致。
 */
export function renderMessage(
  state: AgentState,
  message: Extract<AgentState['messages'][number], { role: string }>,
  width: number,
  expanded: boolean,
  /**
   * 思考块是否折叠（`Ctrl+T`，pi 的 `hideThinkingBlock`）。
   *
   * 默认 `false`（展开）—— 一次性模式与老调用方不需要知道这个开关。
   */
  hideThinking = false,
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
    const lines = renderAssistant(message.content, width, false, hideThinking, {
      stopReason: message.stopReason,
      errorMessage: message.errorMessage,
    });
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
 * 流式块的**时间预算**：两次重排至少隔多久、最多隔多久（ms）。
 *
 * ## 为什么光有增量排版还不够
 *
 * 增量排版（`StreamingLines`）把每 token 的成本从 O(整段回答) 降到 O(当前那一段)，
 * 但「一段」本身可以长得没法看：模型写长段落、或一大段代码围栏在流式里，
 * 那一段就是几十 KB —— 每 token 重排它仍然要几十毫秒（实测 60K 字 ≈ 25ms/次），
 * 主线程照样被吃满。
 *
 * 所以再加一道闸：**上一次花了多久，下一次就至少等多倍**（见 `streamIntervalMs`），
 * 让流式重排最多占掉主线程的三分之一。丢几帧中间态不影响正确性：
 * 下一个 token 一定会再来问一次，而收工时那块会被整条消息替掉。
 */
const STREAM_MIN_RENDER_MS = 40;
const STREAM_MAX_RENDER_MS = 300;

/**
 * 官方组件给首行/末行加的那两个 OSC 133 标记。
 *
 * `assistant-message.js` 的 `render()` 把 `133;A` 拼在第一行前面、`133;B`+`133;C`
 * 拼在最后一行前面（终端靠它们做「跳到上一个提问」）。整段一次渲染时它们只出现在
 * 最外两端；**增量拼出来的行列表里，中间那几段的末标记必须去掉**，否则会凭空多出
 * 一个「提问结束」边界（pi-tui 自己也是这么剥的，见 `layout.js` 的 `OSC133_ZONE_PREFIX`）。
 */
const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

/**
 * 增量切分器的扫面状态。
 *
 * 跨帧复用：每个 token 只扫**新追加的**那几个字符。不这么做的话，每 token 重扫
 * 整段又是 O(整段回答) —— 等于把增量排版省下的钱又花回去。
 */
interface StreamScan {
  /** 已经扫到哪儿了。 */
  pos: number;
  /** 围栏代码块：`` ` `` / `~`；空字符串 = 不在围栏里。 */
  fence: string;
  /** 围栏至少多长（≥ 这个数才算闭合）。 */
  fenceLen: number;
  /** 在 `$$` / `\[` 公式块里。 */
  latex: boolean;
  /** 上一行是缩进代码（4 空格或 tab）—— 那种空行不断代码块，不能拿它切。 */
  prevIndented: boolean;
  /** 刚看到的那个空行切点（还没定），下一行到了才知道它安不安全。 */
  pending: number;
}

function blankScan(): StreamScan {
  return { pos: 0, fence: '', fenceLen: 0, latex: false, prevIndented: false, pending: -1 };
}

/** 一行是不是围栏的开/闭（`\u0060\u0060\u0060` 或 `~~~`，前导空格 ≤ 3）。 */
function fenceOf(line: string, char: string): number {
  const trimmed = line.replace(/^ {0,3}/, '');
  let n = 0;
  while (n < trimmed.length && trimmed[n] === char) n += 1;
  return n >= 3 ? n : 0;
}

/**
 * 从 `state.pos` 往后扫，返回「最后一个可以安全切开的偏移」（切点之后是新段的开头）；
 * 没有新的就返回 -1。
 *
 * ## 什么算「安全」
 *
 * 切点必须落在一个**段边界**（空行）之后，且**不在围栏代码块 / 公式块里**；
 * 空行前一行不能是缩进代码（那种空行不断代码块），后一行也不能以空白开头
 * （否则那段会以缩进开头，而官方组件会 `trim()` 掉缩进 —— 缩进代码、列表续行就这么变形）。
 * 因为 markdown 里只有段边界处「分开渲染再拼起来」才与「整段一次渲染」等价 ——
 * 这条等价性是拼接的地基，它错了症状就是流式时看着好好的、一转向下就变了形。
 */
function advanceStreamSplit(text: string, state: StreamScan): number {
  let cut = -1;
  let i = state.pos;
  while (i < text.length) {
    const nl = text.indexOf('\n', i);
    if (nl === -1) break; // 这一行还没写完：停在行首，下次连它一起重扫
    const line = text.slice(i, nl);
    const trimmed = line.trim();
    const after = nl + 1;

    if (state.fence !== '') {
      // 围栏里：只看闭围栏
      const n = fenceOf(line, state.fence);
      if (n >= state.fenceLen && trimmed === state.fence.repeat(n)) {
        state.fence = '';
        state.fenceLen = 0;
      }
      state.pending = -1;
    } else if (state.latex) {
      if (trimmed.endsWith('$$') || trimmed.endsWith('\\]')) state.latex = false;
      state.pending = -1;
    } else if (trimmed === '') {
      // 段边界（候选）。上一行是缩进代码就不算 —— 那种空行不断代码块。
      if (!state.prevIndented) state.pending = after;
    } else {
      // 空行能不能当切点，由**这一行**定：以空白开头的行（缩进代码、列表续行）
      // 排在段首会被官方组件的 `text.trim()` 吃掉缩进，于是渲染成另一样东西。
      if (state.pending !== -1) {
        if (!/^[ \t]/.test(line)) cut = state.pending;
        state.pending = -1;
      }
      const backtick = fenceOf(line, '`');
      if (backtick > 0) {
        state.fence = '`';
        state.fenceLen = backtick;
      } else {
        const tilde = fenceOf(line, '~');
        if (tilde > 0) {
          state.fence = '~';
          state.fenceLen = tilde;
        } else if (trimmed === '$$' || trimmed === '\\[') {
          state.latex = true;
        }
      }
    }
    state.prevIndented = /^(?: {4}|\t)/.test(line);
    state.pos = after;
    i = after;
  }
  return cut;
}

/**
 * 把一段拼到已有行后面（见 `OSC133_ZONE_PREFIX` 与 `StreamingLines`）。
 *
 * - 第一段原样用（它自带首尾两个标记，与整段一次渲染的第一段逐字相同）；
 * - 后面的段去掉自己的开头空行（那是 `Spacer(1)` 的痕迹）与末行标记；
 * - 段与段之间补**一个整宽空行** —— 与整段一次渲染时两段之间的那一行逐字相同（实测）。
 */
function joinStreamPart(lines: string[], part: string[], width: number, isLast: boolean): string[] {
  if (part.length === 0) return lines;
  const stripTail = (rows: string[]): string[] => {
    if (rows.length === 0) return rows;
    const out = [...rows];
    out[out.length - 1] = out[out.length - 1]!.replace(OSC133_ZONE_PREFIX, '');
    return out;
  };
  if (lines.length === 0) return isLast ? part : stripTail(part);
  const body = part.slice(1);
  if (body.length === 0) return lines;
  return [
    ...stripTail(lines),
    ' '.repeat(width),
    ...(isLast ? body : stripTail(body)),
  ];
}

/**
 * 流式文字的**增量排版**。
 *
 * 病根：官方组件的形状是「给一段文字，让 markdown 从头排一遍」，而流式是**追加** —— 每个 token 都
 * 把整段回答重新 lex 一次（profile 里 lexer 那个 LaTeX 扩展正则就占了 19% self time）、行也全部重
 * 折一遍。实测每 token：10K 字 2.4ms、60K 字 24.9ms，累起来是 O(n²)，主线程被吃满。
 *
 * 做法：按**段边界**把长回答切成「定稿的段落」与「正在长的尾巴」—— 定稿的只排一次并连行一起缓存
 * （`settled` / `lines`），每帧只重排尾巴（尾巴在下一个空行到来前一直很短），拼接用
 * `joinStreamPart`（等价性由「段边界处分开渲染 = 整段渲染」保证）。于是每 token 的成本从 O(整段) 变成
 * O(当前段)，只剩「模型不写空行」那种情形退化，由 `STREAM_MAX_RENDER_MS` 的预算兜着。
 *
 * 导出是为了测：能把「增量结果 == 整段一次渲染」逐行比出来。
 */
export class StreamingLines {
  /** 缓存键（宽度 / 折叠 / 展开）—— 变了就全部重排。 */
  private key = '';
  /** 已经定稿并拼进 `lines` 的源文本长度。 */
  private settled = 0;
  /** 定稿段拼出来的行。 */
  private lines: string[] = [];
  /** 切分扫描的游标（只扫新追加的字符）。 */
  private scan: StreamScan = blankScan();
  /** 上一次算出来的源文本与结果（一模一样就直接回缓存的）。 */
  private lastSource = '';
  private lastLines: string[] = [];

  /** 换一轮回答（或收工）：把上一轮的缓存丢掉。 */
  reset(): void {
    this.settled = 0;
    this.lines = [];
    this.scan = blankScan();
    this.lastSource = '';
    this.lastLines = [];
  }

  render(text: string, width: number, expanded: boolean, hideThinking: boolean): string[] {
    const key = `${width}:${expanded}:${hideThinking}`;
    if (key !== this.key) {
      this.key = key;
      this.reset();
    }
    if (text === this.lastSource) return this.lastLines;
    // 文本变短（不是追加）—— 游标与缓存全部作废，从头来。
    // 正常路径不会走到这儿（reducer 只会 `+=`，换轮会先经过 `reset()`），
    // 但万一走了，带着旧游标算出来的切点就是错的。
    if (text.length < this.settled) this.reset();

    // 1）把新到手的段边界都推成「定稿」：每段只排一次。
    for (let cut = advanceStreamSplit(text, this.scan); cut > this.settled; cut = advanceStreamSplit(text, this.scan)) {
      this.lines = joinStreamPart(
        this.lines,
        renderAssistant([{ type: 'text', text: text.slice(this.settled, cut) }], width, true, hideThinking),
        width,
        false,
      );
      this.settled = cut;
    }

    // 2）尾巴每帧重排（它短，而且每帧都在变）。
    const tail = text.slice(this.settled);
    const result =
      tail === ''
        ? this.lines
        : joinStreamPart(
            this.lines,
            renderAssistant([{ type: 'text', text: tail }], width, true, hideThinking),
            width,
            true,
          );
    this.lastSource = text;
    this.lastLines = result;
    return result;
  }
}

/**
 * 对话区：**按消息分块**的增量渲染。
 *
 * 不能整段一个 `Text`：每次状态变化都重渲整段 + 重新折行，而流式 token 每来一个就触发一次
 * `refresh()` —— 实测约 1.2 秒一帧（官方 `MIN_RENDER_INTERVAL_MS` 只有 16ms），而且是**同步**的，
 * 直接占住事件循环连输入都收不到。改成每条消息一个组件（pi 的 `interactive-mode.js` 就是这么做的，
 * 流式那条原地 `updateContent`），没变的块不重算：实测 1208 条消息的会话从 291.9ms/帧降到
 * 0.30ms/帧。
 *
 * 缓存键是「宽度 + 折叠 + 思考可见性」而不是只有消息本身：同一份 `message` 在终端宽度变了、Ctrl+O
 * 切了 `expanded`、Ctrl+T 切了 `hideThinking` 之后渲染结果不同。用 `WeakMap` 而不是 `Map`：
 * `/new` 清空会话后旧消息能被回收。
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
  /**
   * 命令反馈卡（`notify` 插的那些）—— **钉在对话流里**，不是贴顶一行。
   *
   * 每张卡对应一个 `Text`，与 `update()` 收到的 `statusCards` 一一对应；
   * 位置由卡自己的 `at`（锚点消息条数）决定，见 `render()`。
   * 为什么是数组而不是一个块：连续反馈要能各自留在历史里（对齐 pi 的
   * `chatContainer.addChild`）—— 只有一个块的话旧反馈会被新反馈冲掉。
   */
  private readonly statusBlocks: Text[] = [];
  /** `statusBlocks[i]` 上一次 `setText` 的内容，避免每帧重设让折行缓存失效。 */
  private readonly lastStatus: string[] = [];
  /** `statusBlocks[i]` 的锚点（第几条消息之后）—— 渲染时据此 splice。 */
  private readonly statusAnchors: number[] = [];
  /** 开场那节（常驻，永不消失）—— 与状态卡分开。 */
  private readonly bannerBlock: Text;
  /** 正在流式生成的文字：每帧都在变，**只渲染这一条**。 */
  private readonly streamBlock: Text;
  /** 流式那一块的增量排版（定稿段只排一次，每帧只重排尾巴）。 */
  private readonly streamLines = new StreamingLines();
  /** 上一次**真的**排过的那段流式文本（被时间预算跳过的那些不更新它）。 */
  private lastStreamSource = '';
  /** 上一次 `setText` 进去的那份行（内容一样就不碰组件，否则会把它自己的折行缓存打掉）。 */
  private lastStreamText = '';
  /** 上一帧的宽度 / 折叠键：变了要无条件重排（不能等时间预算）。 */
  private lastStreamKey = '';
  /** 上一次流式重排花了多久（ms）—— 下一次隔多久由它推（见 `streamIntervalMs`）。 */
  private streamCostMs = 0;
  /** 上一次流式重排的时刻。 */
  private streamRenderedAt = 0;
  /** 流式重排的次数（被预算挡掉的不算）。给测试与诊断看 —— 不是界面状态。 */
  private streamRenders = 0;
  /**
   * 按消息缓存渲染结果。`WeakMap<object, Map<string, string[]>>`：
   * 外层按消息对象，内层按 `${width}:${expanded}:${hideThinking}` 键。
   */
  private readonly cache = new WeakMap<object, Map<string, string[]>>();
  /** 上一帧的宽度：变了就得让 pi-tui 重新折行（`Text` 自己会重算）。 */
  private lastWidth = 0;
  /**
   * 开场那节（banner）上一次的内容，避免每帧都 `setText`
   * （那会让它自己的折行缓存失效）。流式那一块走自己的路径，见 `updateStream`。
   */
  private lastBanner = '';
  /**
   * `/hotkeys` 那一块。
   *
   * ## 位置：**插在当时的消息边界**，不是永远贴在最后
   *
   * pi 的做法是 `chatContainer.addChild(markdown)` —— 键位表成为对话流里的一个节点，
   * 之后的对话（`addChild`）排在**它下面**，所以新消息一来它就往上滚。
   *
   * 我们把它做成一个单独的长生命块（不是一条消息），所以必须自己记住
   * 「当时插在第几条消息之后」（`hotkeysAtIndex`），`render()` 时把它的行 splice 进
   * 那两条消息之间。不这样做的话它会**永远贴在消息末尾**：新消息追加在它**上面**，
   * 而 `ScrollView` 的 `follow:'end'` 盯的是底部 —— 于是视口永远停在键位表的尾部，
   * 用户看到的就是「打 /hotkeys 之后会话区冻在键位表，最新消息看不见」。
   *
   * 按**数组引用**判断变没变：调用方（`refresh`）按宽度缓存了渲染结果，所以宽度不变
   * 时引用也不变。用「拼成一个字符串再比」也行，但那要每帧 join 一次整张表 —— 而这张表
   * 有二十来行、带表格框线，而对话区的铁律是「没变的块不重算」。
   */
  private readonly hotkeysBlock: Text;
  private lastHotkeysLines: readonly string[] | undefined;
  /**
   * 键位表插在第几条消息之后（`state.messages` 的下标）。
   *
   * `-1` = 不显示。0 表示「插在第一条消息之前」（用户在说第一句话之前敲了 `/hotkeys`）。
   */
  private hotkeysAtIndex = -1;

  constructor() {
    this.bannerBlock = new Text('', 0, 0);
    this.streamBlock = new Text('', 0, 0);
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
    /**
     * 命令反馈卡（`notify` 插的那些）。每张带一个锚点 `at`：
     * 渲染时 splice 在「第 `at` 条消息之后」，于是它是对话流里的一节，
     * 新消息排在它下面、把它往上顶。**不过期**（与 pi 一致）。
     */
    statusCards: readonly { text: string; at: number }[],
    banner?: { text: string },
    /**
     * `/hotkeys` 的行（不给 = 不显示）。
     *
     * 为什么是**渲染好的行**而不是原始 markdown：宽度一变就要重排，而宽度只有调用方
     * 知道（它还顺便按宽度缓了那份结果）。组件这一侧只负责「内容变了就 setText」。
     *
     * @param hotkeysAt 键位表插在第几条消息之后。见 `hotkeysAtIndex`。
     *   与 `hotkeys` 一起传：两者是同一个事实（「表在这儿」）的两个部分。
     */
    hotkeys?: readonly string[],
    hotkeysAt: number = -1,
    /**
     * 思考块是否折叠（`Ctrl+T`，pi 的 `app.thinking.toggle`）。见 `blockLines` 的缓存键注释。
     *
     * 排在**最后**且默认为 `false`：一次性模式与老调用方不需要知道这个开关，
     * 而把它插在中间会让所有现有调用点一起改。
     */
    hideThinking = false,
    /**
     * 要渲染的消息列表 —— **从轨迹派生的那份**（见 `sessionEntries`）。
     *
     * 不给就退回 `state.messages`（老调用方与测试）。界面正常路径一定要给，
     * 因为那才是「以 trace 为基准」；`state.messages` 只是旧轨迹的退路。
     */
    derivedMessages?: readonly Message[],
  ): void {
    // 回收已结束的工具组件（**在渲染任何块之前**：工具刚跑完时 reducer 已把它移出
    // `executing`，于是这一帧就该把它的组件与 interval 一起清掉）。
    // 每帧一次，而不是每条消息一次。
    pruneLiveTools(state);
    const key = `${width}:${expanded}:${hideThinking}`;
    const widthChanged = width !== this.lastWidth;
    const messages = derivedMessages ?? state.messages;
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
      this.blockLines(message, i, key, state, width, expanded, hideThinking, widthChanged);
    }
    // 状态卡：张数变了就增减 `Text`（每张一块，独立缓存），内容变了才 setText。
    // 与消息块同一个道理 —— 没变的卡一帧都不重算。
    if (this.statusBlocks.length > statusCards.length) {
      this.statusBlocks.length = statusCards.length;
      this.lastStatus.length = statusCards.length;
      this.statusAnchors.length = statusCards.length;
    }
    for (let i = 0; i < statusCards.length; i += 1) {
      const card = statusCards[i]!;
      let block = this.statusBlocks[i];
      if (!block) {
        // `paddingX = 1` + 前面一行空行 —— 与 pi 的 `showStatus()` 逐字同形：
        // 它建的是 `new Spacer(1)` + `new ThemedText(..., 1, 0)`（空行在上、左边留一格）。
        // 早先是 `(0, 0)` + 尾随换行，于是卡贴着左边缘、且与上一行内容之间没有空隙。
        block = new Text('', 1, 0);
        this.statusBlocks[i] = block;
      }
      this.statusAnchors[i] = card.at;
      const text = card.text === '' ? '' : `\n${card.text}`;
      if (this.lastStatus[i] !== card.text) {
        this.lastStatus[i] = card.text;
        block.setText(text);
      }
    }
    this.setIfChanged(
      this.bannerBlock,
      'banner',
      banner?.text === '' || banner === undefined ? '' : `${banner.text}\n`,
      banner?.text ?? '',
    );
    this.updateStream(state, width, hideThinking);
    // 引用比对（见字段注释）：同一份行数组就不碰组件，重排与 markdown 解析都省了。
    if (hotkeys !== this.lastHotkeysLines) {
      this.lastHotkeysLines = hotkeys;
      this.hotkeysBlock.setText(
        hotkeys === undefined || hotkeys.length === 0 ? '' : `${hotkeys.join('\n')}\n`,
      );
    }
    // 插入位置只跟「什么时候敲的」有关，与内容无关，所以单独存。
    // `hotkeys` 为空（没显示过 / 已清掉）时归 -1（= 不显示）；合法位置为 0..N，
    // 负数（调用方没给）当成「插在末尾」。
    this.hotkeysAtIndex = hotkeys === undefined || hotkeys.length === 0
      ? -1
      : hotkeysAt < 0
        ? Number.MAX_SAFE_INTEGER
        : hotkeysAt;
    this.lastWidth = width;
  }

  /** 内容真变了才 `setText`（它会清掉块自己的折行缓存）。 */
  private setIfChanged(block: Text, slot: 'banner', text: string, identity: string): void {
    if (this.lastOf(slot) === identity) return;
    this.remember(slot, identity);
    block.setText(text);
  }

  /**
   * 流式那一块：**增量排版 + 时间预算**。
   *
   * 这是整条流式路径上最贵的一处（实测每 token 可到 25ms，而 token 间隔只有几十毫秒），
   * 两道闸都在这儿：
   *
   *   1. `StreamingLines` 把「重排整段回答」变成「只重排当前这一段」；
   *   2. 时间预算（`streamIntervalMs`）把「上一次花了多久」翻倍成下一次的最小间隔，
   *      应付「模型不写空行」那种退化（尾巴本身就是整段）。
   *
   * 被预算挡掉时**什么都不动**：`lastStreamSource` 不推进，所以下一个 token 会再来问一次，
   * 而收工（`streamingText` 变空）时无条件清空 —— 丢掉的那几帧中间态不会变成脏数据，
   * 最终的全文本来就落在紧跟其后的那条助手消息里。
   */
  private updateStream(state: AgentState, width: number, hideThinking: boolean): void {
    const text = state.phase === 'thinking' ? state.streamingText : '';
    if (text === '') {
      // 收工（或本来就空闲）：立刻清空并丢掉这一轮的排版缓存。
      if (this.lastStreamSource !== '' || this.lastStreamText !== '') {
        this.lastStreamSource = '';
        this.lastStreamText = '';
        this.streamLines.reset();
        this.streamBlock.setText('');
      }
      return;
    }
    if (text === this.lastStreamSource) return;

    const key = `${width}:${hideThinking}`;
    const forced = key !== this.lastStreamKey;
    const now = performance.now();
    if (!forced && now - this.streamRenderedAt < this.streamIntervalMs()) return;

    const t0 = performance.now();
    const lines = this.streamLines.render(text, width, false, hideThinking);
    this.streamCostMs = performance.now() - t0;
    this.streamRenderedAt = performance.now();
    this.streamRenders += 1;
    this.lastStreamSource = text;
    this.lastStreamKey = key;

    const joined = lines.join('\n');
    if (joined !== this.lastStreamText) {
      this.lastStreamText = joined;
      this.streamBlock.setText(joined);
    }
  }

  /**
   * 下一次流式重排的**最小间隔**：上一次花了多久的 3 倍（上下限兜住极端值）。
   *
   * 为什么是倍率而不是固定值：一道固定 100ms 的闸挡不住「一次重排就要 200ms」那种文本，
   * 主线程照样被吃满。跟着实测耗时走，流式重排就最多占掉主线程的三分之一。
   */
  private streamIntervalMs(): number {
    return Math.min(STREAM_MAX_RENDER_MS, Math.max(STREAM_MIN_RENDER_MS, this.streamCostMs * 3));
  }

  /** 流式重排过几次（诊断/测试用）。 */
  get streamRenderCount(): number {
    return this.streamRenders;
  }

  private lastOf(slot: 'banner'): string {
    return this.lastBanner;
  }

  private remember(slot: 'banner', value: string): void {
    this.lastBanner = value;
  }

  /** 一条消息的块：命中缓存就不碰组件，否则重算并 `setText`。 */
  private blockLines(
    message: Extract<AgentState['messages'][number], { role: string }>,
    index: number,
    key: string,
    state: AgentState,
    width: number,
    expanded: boolean,
    hideThinking: boolean,
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
          ...renderMessage(state, message, width, expanded, hideThinking),
        ]
      : this.chunkLines(message, key, () => [
          ...userSpacer(message, index),
          ...renderMessage(state, message, width, expanded, hideThinking),
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
    // 卡**上面**那行空隙由卡自带（前导 `\n`，对齐 pi 的 `Spacer(1)`）；**下面**那行
    // 由紧跟它的那个块补 —— 卡自己不知道后面跟的是什么。
    //
    // 为什么不能只靠下一块自带的空行：用户消息块首行是 `UserMessageComponent` 的
    // `paddingY`（**带底色**，看着是蓝块的一部分，不算空隙），所以卡与用户消息之间
    // 会「贴着」。这里按「上一行 / 下一块首行是不是**无底色**空行」判断，是才不重复补。
    // 带底色的 padding 行含转义序列，`trim()` 不为空 —— 于是这里认得出它、照补一行。
    let pendingBlankBelow = false;
    // 「无底色的空行」要与 `collapseBlankRows` 同一判据：pi 的助手消息块自带前导空行
    // （`Spacer(1)`），首行上还挂着 OSC133 区域标记 —— 只 `trim()` 的话它看起来是
    // 非空行，于是这里又补一行，卡与下一条消息之间就成了两个空行。
    // 带底色的 padding 行含 SGR，不算空行（那是卡片的一部分，得照补隔行）。
    const isBlank = (line: string | undefined): boolean =>
      line === undefined || (BLANK_ROW.test(line) && !SGR_SEQUENCE.test(line));
    const pushBlock = (blockLines: readonly string[]): void => {
      if (pendingBlankBelow && blockLines.length > 0) {
        if (!isBlank(lines[lines.length - 1]) && !isBlank(blockLines[0])) lines.push('');
        pendingBlankBelow = false;
      }
      lines.push(...blockLines);
    };
    const pushCard = (blockLines: readonly string[]): void => {
      if (blockLines.length === 0) return;
      // 卡自带前导空行；上一块已经留下**无底色**空行（如 banner 的尾随空行）时
      // 去掉自己那行，免得叠成两行。
      pendingBlankBelow = false;
      lines.push(
        ...(lines.length > 0 && isBlank(lines[lines.length - 1]) && isBlank(blockLines[0])
          ? blockLines.slice(1)
          : blockLines),
      );
      pendingBlankBelow = true;
    };
    pushBlock(this.bannerBlock.render(at));
    // 状态卡与键位表都**钉在当时的消息边界**上（各自的 `at`）：这样它后面的对话会把它
    // 往上顶、随会话一起滚，而不是永远贴在屏幕底部。
    //
    // 同一锚点上键位表排前面：它是用户主动拉出来看的一张长表，先看到；
    // 命令反馈是刚发生的事，紧跟其后。
    const hotkeysAt = this.hotkeysAtIndex;
    const cardsAt = (index: number): void => {
      for (let k = 0; k < this.statusBlocks.length; k += 1) {
        if ((this.statusAnchors[k] ?? -1) === index) pushCard(this.statusBlocks[k]!.render(at));
      }
    };
    /** 锚点在末尾或更后（如 `/new` 截短了消息）的卡一律排在最后。 */
    const cardsAtEnd = (): void => {
      for (let k = 0; k < this.statusBlocks.length; k += 1) {
        if ((this.statusAnchors[k] ?? -1) >= this.blocks.length) pushCard(this.statusBlocks[k]!.render(at));
      }
    };
    for (let i = 0; i < this.blocks.length; i += 1) {
      cardsAt(i);
      if (i === hotkeysAt) pushBlock(this.hotkeysBlock.render(at));
      const block = this.blocks[i];
      if (block) pushBlock(block.render(at));
    }
    // 锚点落在末尾（`at >= blocks.length`）或一条消息都没有时。
    cardsAtEnd();
    if (hotkeysAt >= this.blocks.length) pushBlock(this.hotkeysBlock.render(at));
    pushBlock(this.streamBlock.render(at));
    return collapseBlankRows(lines);
  }

  invalidate(): void {
    for (const block of this.blocks) block.invalidate();
    for (const block of this.statusBlocks) block.invalidate();
    this.bannerBlock.invalidate();
    this.streamBlock.invalidate();
    this.hotkeysBlock.invalidate();
  }
}

/**
 * composer **上框线**上该显示的工作状态（`undefined` = 空闲，什么都不画）。
 *
 * 在这里现推而不是维护 `lastMessage`：三个状态（思考中 / 压缩中 / 重试）**交错**（重试在一轮之内、
 * 压缩在一轮之外，那段时间 `phase` 还是 idle），手工收尾漏一处就是「圈一直转」或「文案洇在那儿」。
 * 现推幂等 —— 同一份 state 永远推出同一个结果。
 *
 * 优先级：重试 > 压缩 > 生成（重试那句带「第 N/M 次」，是当前最该知道的一件事）。所以「重试中」
 * 只在这里报，`renderTail` 里那条删了 —— 放两处会同一件事报两遍。
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
 * 会话流派生结果的缓存。
 *
 * ## 为什么可以按 `(tree, messages)` 的**引用**缓存
 *
 * 流式 token（`llm.delta`）只改 `state.streamingText`，`state.trace` 与 `state.messages`
 * 两个引用都不变 —— 于是那几百次 `refresh()` 全部命中缓存，派生的 O(节点数) 成本一点
 * 不落在流式路径上（对话区的「没变的块不重算」铁律，这里也适用）。
 * 真正会改 tree 的那些事件（开节点 / 闭合 / 工具结果）本来就该重算一遍。
 */
const streamCache = new WeakMap<object, { messages: readonly Message[]; entries: StreamEntry[] }>();

/** 从状态派生当前会话流（带缓存，见 `streamCache`）。 */
export function sessionEntries(state: AgentState): StreamEntry[] {
  const tree = state.trace as object | undefined;
  if (tree === undefined) return deriveStream(state.trace, state.messages);
  const cached = streamCache.get(tree);
  if (cached !== undefined && cached.messages === state.messages) return cached.entries;
  const entries = deriveStream(state.trace, state.messages);
  streamCache.set(tree, { messages: state.messages, entries });
  return entries;
}

/** 派生消息的条数 —— 命令反馈卡的锚点用它（**不是** `state.messages.length`）。 */
export function sessionMessageCount(state: AgentState): number {
  return streamMessages(sessionEntries(state)).length;
}

/** 一条提示卡的文字（上色；左边一格缩进与上面空行由卡自己的 `Text` 负责）。 */
export function noticeCardText(entry: StreamNoticeEntry): string {
  const mark =
    entry.tone === 'error'
      ? red('✗')
      : entry.tone === 'warn'
        ? yellow('■')
        : entry.tone === 'config'
          ? cyan('•')
          : dim('·');
  const title =
    entry.tone === 'error'
      ? red(entry.title)
      : entry.tone === 'warn'
        ? yellow(entry.title)
        : entry.tone === 'config'
          ? cyan(entry.title)
          : dim(entry.title);
  const detail =
    entry.detail !== undefined && entry.detail !== entry.title ? ` ${dim(entry.detail)}` : '';
  // 提示去看轨迹树只在真失败时给 —— 用户自己按的停止不该被推去排查。
  const hint =
    entry.tone === 'error' ? `\n${dim(`  按 ${keyLabel('app.trace.toggle')} 看轨迹树`)}` : '';
  return `${mark} ${title}${detail}${hint}`;
}

/**
 * 把派生的提示条目转成「钉进对话流」的卡（与 `notify` 的 statusCards 同一形状）。
 *
 * 锚点 = 「它前面有几条消息」。于是配置切换 / 错误就插在**当时那个位置**，
 * 后面的对话会把它往上顶、随会话一起滚 —— 与命令反馈卡同一套渲染。
 */
export function traceNoticeCards(entries: readonly StreamEntry[]): { text: string; at: number }[] {
  const cards: { text: string; at: number }[] = [];
  let messages = 0;
  for (const entry of entries) {
    if (entry.kind === 'message') {
      messages += 1;
      continue;
    }
    cards.push({ text: noticeCardText(entry), at: messages });
  }
  return cards;
}

/**
 * 把整段会话流渲染成文本（一次性模式与测试走它）。
 *
 * 与 `TranscriptChunks` 共用同一套「从轨迹派生」的条目：消息从节点带的 pi 消息渲染，
 * 提示直接画成卡。这样 `-p` 管道输出与界面里看到的是同一个东西。
 */
export function renderTranscript(
  state: AgentState,
  from: number,
  width: number,
  expanded: boolean,
  /**
   * 命令反馈卡（与 `TranscriptChunks.update` 同一形状）：每张带锚点 `at`，
   * 渲染时 splice 在那条消息边界上。一次性模式（管道输出/测试）走这条。
   */
  statusCards?: readonly { text: string; at: number }[],
  /** 思考块是否折叠（`Ctrl+T`）。排在最后且默认 `false`，老调用方不受影响。 */
  hideThinking = false,
): string {
  const lines: string[] = [];
  // 卡按其锚点 splice。空行在卡**上面** + 左边一格缩进 —— 与 pi 的
  // `showStatus()`（`Spacer(1)` + `paddingX=1`）同形。
  const cardsAt = (index: number): void => {
    for (const card of statusCards ?? []) {
      if (card.at === index && card.text !== '') {
        lines.push('', ...card.text.split('\n').map((row) => ` ${row}`));
      }
    }
  };
  cardsAt(from);
  // `offset` 跟着实际插进去的行数走 —— 用户消息前面多了一行空隙，下标才不会错位。
  let offset = lines.length;
  let msgIndex = 0;
  for (const entry of sessionEntries(state)) {
    if (entry.kind === 'notice') {
      const text = noticeCardText(entry);
      if (text !== '') lines.push('', ...text.split('\n').map((row) => ` ${row}`));
      continue;
    }
    const message = entry.message;
    lines.push(...userSpacer(message, offset));
    lines.push(...renderMessage(state, message, width, expanded, hideThinking));
    offset = lines.length;
    msgIndex += 1;
    cardsAt(msgIndex);
  }
  // 正在流式生成的这一段：`TranscriptChunks` 里由独立的一块负责，
  // 一次性模式不走它，所以这里必须补上，否则管道输出会丢掉模型正在说的话。
  if (state.phase === 'thinking' && state.streamingText) {
    lines.push(...renderAssistant([{ type: 'text', text: state.streamingText }], width, true, hideThinking));
  }
  return lines.join('\n');
}
