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
  backgroundAnsi,
  getTerminalColorMode,
  rgbColor,
  truncateToWidth,
  visibleWidth,
  type RgbColorValue,
  type SlashCommand,
  type ViewportTUI,
  type EditorTheme,
  type TuiInputListener,
} from '@earendil-works/pi-tui';
import { abortRun } from '../run-control';
import { renderTree, traceStats, type TraceNode, type TraceTree } from '../trace';
import type { AgentState } from '../state';
import type { AgentStore } from '../store';
import { cleanSessionsExcept, listSessions, type SessionSummary } from '../config-home';
import { loadSessionMessages, openSessionPicker } from './session-picker';
import { getTool } from '../tools';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const useColor = !process.env.NO_COLOR;
const paint = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = (t: string) => paint('2', t);
const red = (t: string) => paint('31', t);
const green = (t: string) => paint('32', t);
const yellow = (t: string) => paint('33', t);
const blue = (t: string) => paint('34', t);
const magenta = (t: string) => paint('35', t);
const cyan = (t: string) => paint('36', t);
const bold = (t: string) => paint('1', t);

/**
 * 工具调用块的底色。
 *
 * ## 为什么要底色
 *
 * pi 把工具调用渲染成**一整块带底色的矩形**（截图里是深绿），而我们原来是一行
 * `✓ 执行命令 › echo 123`。差别不只是好看：底色块有明确的左右边界，长输出被折到
 * 块里时（`... (31 earlier lines, ctrl+o to expand)`）仍然看得出「这段是工具输出」，
 * 一行式则会被误读成模型说的话。
 *
 * ## 为什么用真彩而不是 ANSI 256 色号
 *
 * `backgroundAnsi()` 接受 `#rrggbb`，pi-tui 会根据终端能力降级到 256 色或 16 色
 * （`getTerminalColorMode()` 告诉你当前是哪种）。直接写死 `\x1b[48;5;22m` 在不支持的
 * 终端上会出现难看的色块。让官方函数处理降级。
 *
 * 色值是照 pi 截图取的深绿（不是纯黑底 —— 纯黑在很多终端上与背景同色，块就“消失”了）。
 */
const TOOL_BLOCK_BG = rgbColor(0x12, 0x26, 0x1a);
const TOOL_ERROR_BLOCK_BG = rgbColor(0x2a, 0x14, 0x14);

/** 给一行文字铺底色。宽度不够时先截断，否则底色会溢出到下一行。 */
function block(text: string, bg: RgbColorValue, width: number): string {
  // width <= 0 = 不知道终端多宽（一次性模式）。这时**不能截断**：`truncateToWidth(text, 0)`
  // 返回空串，会把整段工具输出吃掉。直接返回原文，让终端自己折行。
  if (width <= 0) return text;
  const mode = getTerminalColorMode();
  const prefix = backgroundAnsi(bg, mode);
  return `${prefix}${truncateToWidth(text, width)}\x1b[0m`;
}

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
 * 底栏左：工作目录（相对 cwd）+ git 分支。
 *
 * pi 显示 `~\Documents\workspace\event-loop-agent (main)`，我们用同样的形状。
 * 路径太长时从**中间**省略（保留盘符/开头与最后两级），那两段才是定位信息。
 */
export function cwdLine(cwd: string, branch: string | undefined): string {
  let shown = cwd;
  if (shown.length > 48) {
    const parts = shown.split(/[/\\]/);
    const tail = parts.slice(-2).join('\\');
    shown = `…\\${tail}`;
  }
  return branch ? `${shown} (${branch})` : shown;
}

/**
 * 底栏右：`(provider) model` —— 与 pi 完全同形。
 *
 * 左边是「你以为自己用的是谁」，右边是「实际用的哪个模型」。分开是因为换 provider
 * （走网关）时最容易出的错就是以为还在用原厂模型。
 */
export function modelLine(state: AgentState): string {
  return `(${state.providerName}) ${state.modelId}`;
}

/**
 * 工具调用的参数摘要（给块标题行用）。
 *
 * ## 参数在 assistant 消息里，不在 toolResult 里
 *
 * `toolResult` 只有 `toolName` / `content` / `details`，而 `details` 是**工具的返回值**
 * （读文件时是文件内容），不是调用参数。参数在对应 assistant 消息的 `toolCall` 块上，
 * 靠 `toolCallId` 关联 —— 所以这里要拿整个 `state.messages` 去配对。
 *
 * 挑的是「一眼认出这次调用在干什么」的那个字段，而不是把整个 params JSON 搬上去：
 *   - read/edit/write → 文件路径
 *   - bash → 命令
 *   - 其余 → 参数数量（完整 JSON 在展开后可见）
 *
 * 为什么不全 JSON：截图里 pi 的标题就是 `read  docs/architecture/overview.md`，
 * 一个文件名。JSON 会把行占满，真正的信息（读了哪个文件）反而被挤掉。
 */
export function toolArgs(
  state: AgentState,
  message: Extract<AgentState['messages'][number], { role: 'toolResult' }>,
): string {
  // 找发出这次调用的那条 assistant 消息。
  let params: Record<string, unknown> = {};
  for (const m of state.messages) {
    if (m.role !== 'assistant') continue;
    for (const c of m.content) {
      if (c.type === 'toolCall' && c.id === message.toolCallId) {
        params = c.arguments as Record<string, unknown>;
      }
    }
  }
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = params[key];
      if (typeof value === 'string' && value.trim() !== '') return value;
    }
    return undefined;
  };
  const keys = Object.keys(params);
  const candidate =
    pick('path', 'file_path', 'filePath', 'command', 'cmd', 'pattern', 'url') ??
    (keys.length > 0 ? `${keys.length} 个参数` : '');
  return candidate.length > 90 ? `${candidate.slice(0, 90)}…` : candidate;
}

/**
 * 工具输出的折叠。
 *
 * 形状照抄 pi：`... (31 earlier lines, ctrl+o to expand)` —— 关键是**告知有省略**并
 * 告知怎么展开。早先的实现是硬截 200 字加个 `…`，用户不知道后面还有内容、也不知道
 * 能不能看到，于是只能去翻会话文件。
 *
 * `expanded`（Ctrl+O）时返回全文，同时把总行数报出来，好知道到底有多长。
 */
const FOLD_AFTER_LINES = 12;
export function foldOutput(text: string, expanded: boolean): string {
  const rows = text.split('\n');
  if (expanded) {
    return rows.length > FOLD_AFTER_LINES ? `${text}\n  （共 ${rows.length} 行）` : text;
  }
  if (rows.length <= FOLD_AFTER_LINES) return text;
  const hidden = rows.length - FOLD_AFTER_LINES;
  return `${rows.slice(0, FOLD_AFTER_LINES).join('\n')}\n... (${hidden} earlier lines, ctrl+o to expand)`;
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
  const { store, prompt, newSession, sessionId } = options;
  const cwd = options.cwd ?? process.cwd();
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
  const footer = new Text('', 0, 0);
  const transcript = new Text('', 0, 0);
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
    footer.setText(
      padToWidth(
        twoColumn(
          cwdLine(cwd, gitBranch(cwd)),
          modelLine(state),
          terminal.columns ?? 100,
        ),
        terminal.columns ?? 100,
      ),
    );
    // 整段重渲染：ScrollView 自己管滚动与跟随，我们每次给它完整的对话文本。
    // （早前这里只渲染「新增的那几条」，靠 renderedMessages 游标 —— 那个游标每帧都被
    //  推到最新，等于永远从末尾开始渲染，于是对话区什么都不显示。ScrollView 只重画
    //  变化区域，这个 bug 才暴露出来。）
    // 提示过期就清掉（6 秒后自动消失，不留一行孤儿文本）。
    if (notice.text !== '' && Date.now() > noticeUntil) notice.text = '';
    transcript.setText(renderTranscript(state, 0, terminal.columns ?? 100, expanded, notice));
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
   * 轨迹**不**跟着恢复：轨迹是那一轮的产物（时间线、失败、重试），和「对话内容」是两份
   * 并行的记录，历史轨迹在 `~/.redux-agent/traces/<id>.jsonl`（`/trace` 面板只看当前轮）。
   */
  const restoreSession = (session: SessionSummary): void => {
    const messages = loadSessionMessages(session);
    store.dispatch({ type: 'conversation.reset' });
    for (const message of messages) {
      store.dispatch({ type: 'session.restored', message });
    }
    notify(dim(`已恢复 ${session.id}（${messages.length} 条消息，未重跑模型）`));
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
      { component: footer, basis: 1, grow: 0, minSize: 1 },
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
    const plain = renderTranscript(store.getState(), 0, 0, true);
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

/** 把整段对话渲染成文本块（`from` 恒为 0：滚动交给 ScrollView）。 */
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
    // pi-ai 1.x：Message 联合多了 system，且 content 可能是纯字符串 ——
    // 先按 role 收窄，再把 content 归一成「文本片段数组」再渲染。
    if (message.role === 'system') {
      const text = typeof message.content === 'string' ? message.content : '';
      if (text) lines.push(`${dim('系统 ›')} ${dim(text)}`);
    } else if (message.role === 'user') {
      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .map((c) => (c.type === 'text' ? c.text : '[image]'))
              .join(' ');
      lines.push(`${cyan('你 ›')} ${text}`);
    } else if (message.role === 'assistant') {
      const text = message.content
        .map((c) => (c.type === 'text' ? c.text : c.type === 'toolCall' ? `[调用 ${c.name}]` : ''))
        .join(' ')
        .trim();
      if (text) lines.push(`${bold('助手 ›')} ${text}`);
    } else {
      const text = message.content
        .map((c) => (c.type === 'text' ? c.text : '[image]'))
        .join(' ')
        .replace(/\s+/g, ' ');
      const label = getTool(message.toolName)?.label ?? message.toolName;
      const mark = message.isError ? red('✗') : green('✓');
      // 工具块：标题行 + 输出行，都铺底色（形状照抄 pi）。
      // 标题只给 `工具名 参数` —— 参数是定位信息，而截图里 pi 恰恰把**文件名/命令**
      // 显示在标题行（`read  docs/architecture/overview.md`），参数太长就截断。
      const args = toolArgs(state, message);
      const title = `${mark} ${bold(label)} ${dim(args)}`;
      // 输出：超长时折成「... (N earlier lines, ctrl+o to expand)」，与 pi 同形。
      const body = foldOutput(text, expanded);
      const bg = message.isError ? TOOL_ERROR_BLOCK_BG : TOOL_BLOCK_BG;
      lines.push(block(title, bg, width));
      if (body) {
        for (const row of body.split('\n')) lines.push(block(`  ${row}`, bg, width));
      }
    }
  }
  // 正在流式生成的这一段也画出来。
  if (state.phase === 'thinking' && state.streamingText) {
    lines.push(`${bold('助手 ›')} ${state.streamingText}`);
  }
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
  return lines.join('\n');
}
