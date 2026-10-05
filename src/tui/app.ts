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
  type ViewportTUI,
  type EditorTheme,
  type TuiInputListener,
} from '@earendil-works/pi-tui';
import { abortRun } from '../run-control';
import { renderTree, traceStats, type TraceNode, type TraceTree } from '../trace';
import type { AgentState } from '../state';
import type { AgentStore } from '../store';
import type { SessionSummary } from '../config-home';
import { loadSessionMessages, openSessionPicker } from './session-picker';
import { getTool } from '../tools';

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

/** 顶栏：模型 / 轮数 / 花费 / 轨迹统计。 */
function statusLine(state: AgentState): string {
  const stats = traceStats(state.trace);
  const cost = state.totalCost > 0 ? ` · $${state.totalCost.toFixed(4)}` : '';
  const bits = [
    `${state.providerName}/${state.modelId}`,
    `${state.turns} 轮`,
    cost,
  ];
  const traceBits = [`节点 ${state.trace.order.length}`];
  if (stats.retries > 0) traceBits.push(`重试 ${stats.retries}`);
  if (stats.errors > 0) traceBits.push(red(`错误 ${stats.errors}`));
  return `${dim(bits.filter(Boolean).join(' · '))}   ${dim('轨迹')} ${traceBits.join(dim(' · '))}`;
}

/** 去掉 ANSI 序列，拿到可见宽度。 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
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

const EDITOR_THEME: EditorTheme = {
  borderColor: (s: string) => dim(s),
  selectList: {
    selected: (s: string) => cyan(s),
    unselected: (s: string) => s,
    description: (s: string) => dim(s),
  },
} as unknown as EditorTheme;

export interface TuiOptions {
  store: AgentStore;
  /** 一次性提问：给完就退出（脚本/管道友好）。 */
  prompt?: string | undefined;
}

export async function runTui(options: TuiOptions): Promise<number> {
  const { store, prompt } = options;
  const terminal = new ProcessTerminal();
  // AltScreen 是 viewport 实现，setLayoutRoot 在 ViewportTUI 上（TUI 接口没有）。
  const tui: ViewportTUI = new TuiAltScreen(terminal, true, undefined, {
    mouse: true,
    copyOnSelect: true,
  });

  const header = new Text('', 0, 0);
  const transcript = new Text('', 0, 0);
  const tracePanel = new Text('', 0, 0);
  const loader = new CancellableLoader(tui, (s) => cyan(s), (s) => dim(s), '');
  loader.setIndicator({ frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] });

  const editor = new Editor(tui, EDITOR_THEME);

  let showTrace = false;
  let loading = false;
  let lastLoaderMessage = '';
  /** 命令反馈：插在对话区顶部，6 秒后自动消失（不占输入区）。 */
  const notice = { text: '' };
  let noticeUntil = 0;

  const refresh = (): void => {
    const state = store.getState();
    // 补到全宽：顶栏长度变化会让 pi-tui 的增量重绘留下残影（见 padToWidth 的注释）。
    header.setText(padToWidth(statusLine(state), terminal.columns ?? 100));
    // 整段重渲染：ScrollView 自己管滚动与跟随，我们每次给它完整的对话文本。
    // （早前这里只渲染「新增的那几条」，靠 renderedMessages 游标 —— 那个游标每帧都被
    //  推到最新，等于永远从末尾开始渲染，于是对话区什么都不显示。ScrollView 只重画
    //  变化区域，这个 bug 才暴露出来。）
    // 提示过期就清掉（6 秒后自动消失，不留一行孤儿文本）。
    if (notice.text !== '' && Date.now() > noticeUntil) notice.text = '';
    transcript.setText(renderTranscript(state, 0, notice));
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
      case 'new':
        store.dispatch({ type: 'conversation.reset' });
        notify(dim('已开新对话（历史仍在 sessions/ 里，随时 /sessions 回来）'));
        return;
      case 'help':
        notify(
          [
            `${bold('/sessions')}  恢复历史会话（弹窗选择，零 token）`,
            `${bold('/new')}      开新对话`,
            `${bold('/help')}     这份列表`,
          ].join('\n'),
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
    // basis 给死会把对话区压扁：Editor 自己要画上下两条横线，实际占的比 basis 多。
    const bottom = new VStack([
      ...(showTrace ? [{ component: tracePanel, basis: 0, grow: 0, minSize: 1 }] : []),
      { component: loader, basis: 0, grow: 0, minSize: 1 },
      { component: editor, basis: 0, grow: 0, minSize: 3 },
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
  tui.start();

  if (prompt !== undefined) {
    // 一次性模式：TUI 的差分渲染在非交互终端里只会留下一堆转义序列，
    // 所以不走界面 —— 直接跑环，然后把**纯文本**的对话与轨迹树打到 stdout。
    // 轨迹树照样有（这才是重点），只是不经过 pi-tui 的画布。
    tui.stop();
    store.dispatch({ type: 'user.message', text: prompt });
    await waitForIdleOrExit(store);
    process.stdout.write(`${renderTranscript(store.getState(), 0)}\n`);
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
function renderTranscript(state: AgentState, from: number, notice?: { text: string }): string {
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
      const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      lines.push(`  ${mark} ${dim(`${label} ›`)} ${dim(preview)}`);
    }
  }
  // 正在流式生成的这一段也画出来。
  if (state.phase === 'thinking' && state.streamingText) {
    lines.push(`${bold('助手 ›')} ${state.streamingText}`);
  }
  if (state.retrying) {
    lines.push(dim(`  ↻ 上一次失败，正在重试（第 ${state.llmAttempts}/${state.maxLlmAttempts} 次尝试）`));
  }
  if (state.phase === 'idle' && state.error) {
    const node = state.errorNodeId ? `（轨迹节点 ${state.errorNodeId}）` : '';
    lines.push(`  ${red('✗')} ${red(state.error)} ${dim(node)}`);
    lines.push(dim('  按 Ctrl+T 看轨迹树'));
  }
  return lines.join('\n');
}
