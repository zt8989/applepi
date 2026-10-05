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
import { CancellableLoader, Editor, ProcessTerminal, TUI, Text, matchesKey } from '@earendil-works/pi-tui';
import type { EditorTheme } from '@earendil-works/pi-tui';
import { abortRun } from '../run-control';
import { renderTree, traceStats, type TraceNode, type TraceTree } from '../trace';
import type { AgentState } from '../state';
import type { AgentStore } from '../store';
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
      const match = /^(.*?)(n\d+) (llm\.attempt|llm\.result|tool\.attempt|tool\.result|user|error|stop):/.exec(
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
  const tui = new TUI(terminal);

  const header = new Text('', 0, 0);
  const transcript = new Text('', 0, 0);
  const tracePanel = new Text('', 0, 0);
  const loader = new CancellableLoader(tui, (s) => cyan(s), (s) => dim(s), '');
  loader.setIndicator({ frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] });

  const editor = new Editor(tui, EDITOR_THEME);

  let showTrace = false;
  let loading = false;
  let lastLoaderMessage = '';
  // 已经画过的消息条数：只渲染新增的那些。
  let renderedMessages = 0;

  const refresh = (): void => {
    const state = store.getState();
    header.setText(statusLine(state));
    transcript.setText(renderTranscript(state, renderedMessages));
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
      lastLoaderMessage = '';
    }
    // 状态里已有的消息补渲染（重绘时不会漏）。
    renderedMessages = Math.max(renderedMessages, state.messages.length);
    refresh();
  });

  // Ctrl-C：环在跑就中断这一轮，闲时就退出。
  tui.addInputListener((data) => {
    if (matchesKey(data, 'ctrl+c')) {
      if (store.getState().phase !== 'idle') {
        abortRun();
        return { consume: true };
      }
      tui.stop();
      process.exit(0);
    }
    // Ctrl+T：切换轨迹面板。
    if (matchesKey(data, 'ctrl+t')) {
      showTrace = !showTrace;
      refresh();
      return { consume: true };
    }
    return undefined;
  });

  editor.onSubmit = (text: string) => {
    const input = text.trim();
    if (!input) return;
    if (store.getState().phase !== 'idle') {
      lastLoaderMessage = `${yellow('上一回合还没结束（Ctrl-C 可中断）')}`;
      refresh();
      return;
    }
    send(input);
  };

  const send = (text: string): void => {
    loading = true;
    lastLoaderMessage = '';
    loader.setMessage(yellow('思考中…'));
    loader.start();
    renderedMessages = store.getState().messages.length;
    store.dispatch({ type: 'user.message', text });
    refresh();
  };

  tui.addChild(header);
  tui.addChild(transcript);
  tui.addChild(tracePanel);
  tui.addChild(loader);
  tui.addChild(editor);
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

/** 把新增的消息渲染成文本块。 */
function renderTranscript(state: AgentState, from: number): string {
  const lines: string[] = [];
  for (let i = from; i < state.messages.length; i += 1) {
    const message = state.messages[i];
    if (!message) continue;
    if (message.role === 'user') {
      lines.push(`${cyan('你 ›')} ${String(message.content)}`);
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
