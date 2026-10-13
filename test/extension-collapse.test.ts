/**
 * 折叠：把对话框收成一行、让用户去看背后的对话，再展开。
 *
 * ## 为什么单独一个文件
 *
 * 折叠验的不只是「组件画得对不对」，而是**按键真的能穿过我们这一层到达它** ——
 * 那要能模拟按键，于是要一个能被喂字节的 TUI（其他扩展测试只发 promise）。
 *
 * ## 形态变了：默认是 **inline**（扩展 2.13 起）
 *
 * 这份文件原来测的是「隐藏式 overlay 折叠」：`ctx.ui.custom({ overlay: true })` +
 * `handle.setHidden(true)`，收起后靠 `ctx.ui.onTerminalInput()` 那条 raw listener
 * 复原（pi-tui 不把输入发给隐藏 overlay 的 `component.handleInput`）。
 *
 * `@juicesharp/rpiv-ask-user-question` 2.13（2026-10-11）起改了默认：
 * `presentation.ts` 的 `resolvePresentation()` **优先 inline**（Pi 的 editor slot），
 * overlay 只在「输入区槽位已被另一份问卷占住」时用。于是：
 *
 * | | inline（现在的默认） | overlay（槽位被占时） |
 * | --- | --- | --- |
 * | 落点 | 换掉 composer 那一格 | 浮层 |
 * | 折叠 | 收成**一行可见提示**（仍是焦点所在） | `setHidden(true)` 收成一行 |
 * | 复原靠 | 组件自己的 `handleInput` | raw listener（`onTerminalInput`） |
 * | 收起后按 Esc | **放弃**（`routeCollapsed` 只认 cancel） | 到不了组件（焦点已被移走） |
 *
 * 所以本文件现在测 **inline** 那三件事（收得起、收起来之后还回得来、收过之后还能正常
 * 答题），并单独留一条用例盖住「第二份问卷降级成 overlay」——那是 overlay 那条路
 * 今天唯一还能走到的入口。
 *
 * ## 按键用 `\x1d`（GS）
 *
 * `Ctrl+]` 在终端里就是 0x1d。验过 pi-tui 的 `matchesKey`：0x1d、CSI 27;5;93~、
 * CSI 93;5u 都匹配 `ctrl+]`；**裸 `]` 与 CSI 93（无修饰位）不匹配** —— 所以这个测试
 * 用错一个键就会静默地什么都不发生（而那正是最难发现的失败）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { loadExtensionHost } from '../src/extension-host';
import { createAgentStoreWith } from '../src/store';
import { createFauxRuntime, demoResponses } from '../src/provider';
import { getTool, registerExtraTools } from '../src/tools';
import { initTheme, theme } from '@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import {
  Text,
  TuiAltScreen,
  VStack,
  stripTerminalSequences,
  type Component,
  type TuiInputListener,
} from '@earendil-works/pi-tui';

// ── 真配置家目录（否则 settings.json 的 packages 是空的） ──
const realAgentDir = path.join(homedir(), '.pi', 'agent');
const isolatedDir = process.env['PI_CODING_AGENT_DIR'];
const hasPackage = existsSync(
  path.join(realAgentDir, 'npm', 'node_modules', '@juicesharp', 'rpiv-ask-user-question'),
);
const skip = !hasPackage && '没装 @juicesharp/rpiv-ask-user-question（离线机器）';

/** `Ctrl+]` 的终端字节（GS）。见文件头。 */
const CTRL_BRACKET = '\x1d';
/** `Esc` —— 收起时用它收工。 */
const ESC = '\x1b';

interface FakeTui {
  tui: TuiAltScreen;
  written: string[];
  /** 输入区槽位里现在是什么（`undefined` = composer 本身）。 */
  slot: { current: (Component & { dispose?: () => void }) | undefined };
  /** 模拟「用户按了一个键」——走我们注册的 raw listener，再走 TUI 自己的分发。 */
  feed(data: string): void;
  /** 写出去的内容（去 ANSI），可以只看某个时刻之后的部分。 */
  textSince(mark: number): string;
}

function fakeTui(width = 110, height = 34): FakeTui {
  const written: string[] = [];
  // `ProcessTerminal.start()` 会把这两个回调交给 pi-tui：数据来了 / 尺寸变了。
  // 真的那个从 stdin 与 SIGWINCH 拿；这里我们**存起来**（测试用 `resize()` 调第二个），
  // 而第一个不用 —— 按键走 `feed()`，那才是我们要验的接缝。
  let onData: ((d: string) => void) | undefined;
  let onResize: (() => void) | undefined;
  const terminal = {
    columns: width,
    rows: height,
    isTTY: false,
    write: (s: string) => {
      written.push(s);
    },
    hideCursor: () => {},
    showCursor: () => {},
    start: (data: (d: string) => void, resize: () => void) => {
      onData = data;
      onResize = resize;
    },
    stop: () => {
      onData = undefined;
      onResize = undefined;
    },
    onData: (handler: (d: string) => void) => {
      onData = handler;
      return () => {
        onData = undefined;
      };
    },
    onResize: (handler: () => void) => {
      onResize = handler;
      return () => {
        onResize = undefined;
      };
    },
  } as never;
  const tui = new TuiAltScreen(terminal, true, undefined, {});
  // **不能覆盖 `addInputListener`**：pi-tui 真正的 `handleTerminalInput` 是直接读它
  // **内部那个 `inputListeners` Set**（不是调 `this.addInputListener`）。我们覆盖那个
  // 公开方法，就等于把 listener 存到了另一个 Set 里 —— 于是 `handleTerminalInput`
  // 一个都看不到，扩展的 raw listener 永远不被调，症状是「按了却什么都没发生」。
  // 早先那版白测了（三个用例全挂，而真因在测试里）。
  // **必须 start()**，否则 `doRender()` 第一行就 return（`!this.altScreenActive`），
  // 于是组件挂上了却一帧都不画。start() 只 `requestRender()`（走 process.nextTick），
  // **没人等那个 tick** 的话测试会在第一帧之前就开始断言 —— 所以紧接着手动
  // `renderNow(true)` 一帧。之后每次变化都会再画。
  tui.start();
  tui.renderNow(true);
  // 记下起点：前面都是 enter/leave alt screen 与那一帧基线。
  written.length = 0;
  void onData;
  void onResize;

  /**
   * composer 的替身 —— 真界面里那一格是 `CustomEditor`；这里只要一个「有东西」的组件。
   *
   * **把槽位真的接到布局上**（`setLayoutRoot`），而不是只记一个引用：不接的话
   * inline 的组件一帧都不会被画，`textSince()` 里的断言就变成永远为假 —— 而那种失败
   * 看起来像「扩展没渲染」，真因却在测试的假宿主里。
   */
  const composer = new Text('(composer)', 0, 0);
  const slot: FakeTui['slot'] = { current: undefined };
  const applySlot = (): void => {
    const inSlot = slot.current ?? composer;
    tui.setLayoutRoot(new VStack([{ component: inSlot, minSize: 1 }]));
    tui.setFocus(inSlot);
    tui.requestRender();
  };
  applySlot();

  return {
    tui,
    written,
    slot,
    feed(data: string) {
      // **走 pi-tui 自己的 `handleTerminalInput`**，不自己重新实现一遍分发。
      //
      // 那里面做三件事，缺一件就会「按了没反应」：
      //   1. 依次问所有 `addInputListener`（扩展给 overlay 挂的 raw listener 是这里），
      //      有人 `consume` 就停；
      //   2. 若当前焦点在**一个被 setHidden 的 overlay** 上，pi-tui 会把焦点改派到
      //      别的可见 overlay / 原处；
      //   3. 否则把按键交给 `focusedComponent.handleInput`（inline 的问卷走这条）。
      (tui as unknown as { handleTerminalInput(d: string): void }).handleTerminalInput(data);
    },
    textSince(mark: number) {
      return stripTerminalSequences(written.slice(mark).join(''));
    },
  };
}

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`${what}（等 ${ms}ms）`);
}

interface Dialogue {
  f: FakeTui;
  notices: string[];
  pending: Promise<unknown>;
  painted: () => Promise<void>;
  /** 再要一份问卷（同一个宿主）—— 用来验「槽位被占 → 降级 overlay」。 */
  askAgain: (params: unknown) => Promise<unknown>;
}

/** 装好扩展、起一个对话框，等它真的画出来。返回那张假 TUI 与提示收集器。 */
async function startDialogue(params: unknown): Promise<Dialogue> {
  delete process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = realAgentDir;
  initTheme('dark', false);
  const f = fakeTui();
  const faux = createFauxRuntime();
  faux.setResponses(demoResponses());
  const { store } = createAgentStoreWith({ runtime: faux.runtime, cwd: process.cwd() });
  const notices: string[] = [];
  await loadExtensionHost({
    store,
    cwd: process.cwd(),
    uiOptions: () => ({
      tui: f.tui,
      theme,
      addInputListener: (l: TuiInputListener) => f.tui.addInputListener(l),
      onNotice: (text) => notices.push(text),
      // 真界面的 `mountEditorSlot`（`tui/app.ts`）：换掉 composer 那一格、给焦点、
      // 重排布局、还回来时把焦点交回 composer。这里照抄同一套动作。
      mountEditorSlot: (component) => {
        f.slot.current = component;
        const inSlot = component ?? new Text('(composer)', 0, 0);
        f.tui.setLayoutRoot(new VStack([{ component: inSlot, minSize: 1 }]));
        f.tui.setFocus(inSlot);
        f.tui.requestRender();
      },
    }),
  });
  const tool = getTool('ask_user_question');
  assert.ok(tool, '扩展工具该装上了');
  const pending = tool.execute('c', params as Record<string, unknown>, undefined, undefined);
  pending.catch(() => undefined);
  // 组件挂上了，但「挂上」不等于「画出来了」：pi-tui 的差分重绘是异步的
  // （`requestRender` 走 nextTick + 16ms 节流），所以这里显式 `renderNow(true)`
  // 强推一帧，否则断言会在第一帧之前跑。
  const painted = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 60));
    f.tui.renderNow(true);
  };
  await waitFor(() => f.slot.current !== undefined, 20_000, '问卷该挂进输入区槽位');
  await painted();
  return {
    f,
    notices,
    pending,
    painted,
    askAgain: async (p: unknown) => {
      const again = tool.execute('c2', p as Record<string, unknown>, undefined, undefined);
      again.catch(() => undefined);
      return again;
    },
  };
}

function restore(): void {
  registerExtraTools([]);
  if (isolatedDir !== undefined) process.env['PI_CODING_AGENT_DIR'] = isolatedDir;
}

/**
 * 收工：`Esc` 取消掉还没答的问卷。
 *
 * **每个用例都必须收**：扩展那边用模块级变量守着「输入区槽位被谁占着」
 * （`presentation.ts` 的 `claimInlineSlot()`），不收的话它会一直抱着 —— 同一进程里
 * 后面的用例就全部降级成 overlay，而「后面突然变了个形态」最难查。
 */
async function cancel(pending: Promise<unknown>): Promise<void> {
  const result = (await Promise.race([
    pending,
    new Promise((_, rj) => setTimeout(() => rj(new Error('TIMEOUT：Esc 没收工')), 5_000)),
  ])) as { details?: unknown };
  assert.deepEqual(result.details, { answers: [], cancelled: true }, 'Esc 该是「放弃」');
}

const ONE_QUESTION = {
  questions: [
    {
      question: 'Which approach should we take?',
      header: 'Approach',
      options: [
        { label: 'Minimal (Recommended)', description: 'Only what was asked.' },
        { label: 'Thorough', description: 'Refactor neighbours too.' },
      ],
    },
  ],
};

test('折叠（inline）：Ctrl+] 收成一行 → 那一行点名复原的键 → 再按一次展开', { skip }, async () => {
  let pending: Promise<unknown> | undefined;
  try {
    const started = await startDialogue(ONE_QUESTION);
    pending = started.pending;
    const { f, painted } = started;

    // 展开态：问题本身在画面上（证明我们抓的是「真的画出来了」那一帧）。
    assert.ok(
      f.textSince(0).includes('Which approach should we take?'),
      '展开态该画出问题本身（否则下面测的不是同一个东西）',
    );

    const mark = f.written.length;
    f.feed(CTRL_BRACKET);
    await painted();

    const collapsed = f.textSince(mark);
    // 收起后：整个对话框不见了……
    assert.ok(
      !collapsed.includes('Refactor neighbours too.'),
      `收起后不该还在画整个对话框：\n${collapsed.slice(0, 300)}`,
    );
    // ……但**留了一行**，而且那行点名了复原的键。用户不知道按什么就等于没法用。
    assert.match(collapsed, /to expand/i, `收起后该留一行可复原的提示：\n${collapsed.slice(0, 300)}`);
    assert.match(collapsed, /Ctrl\+\]/, `那行该点名 Ctrl+]：\n${collapsed.slice(0, 300)}`);

    // 槽位**没被还回去** —— inline 的折叠只是换个画法，组件还在、焦点还在
    // （这与 overlay 的 `setHidden` 是两回事：那条路要 raw listener 才回得来）。
    assert.ok(f.slot.current !== undefined, 'inline 折叠不该把组件从槽位里摘掉');

    // 再按一次要能展开 —— 这一半最容易漏（「收得起来、展不回去」）。
    const reopenMark = f.written.length;
    f.feed(CTRL_BRACKET);
    await painted();
    assert.ok(
      f.textSince(reopenMark).includes('Which approach should we take?'),
      '第二次 Ctrl+] 该把对话框画回来',
    );
  } finally {
    if (pending) await cancel(pending).catch(() => undefined);
    restore();
  }
});

test('折叠（inline）：收起后按 Esc = 放弃（collapsed 时只认 cancel）', { skip }, async () => {
  let pending: Promise<unknown> | undefined;
  try {
    const started = await startDialogue(ONE_QUESTION);
    pending = started.pending;
    const { f, painted } = started;

    f.feed(CTRL_BRACKET);
    await painted();

    // 收起态下按键仍然到得了组件（它还握着焦点），而扩展的 `routeCollapsed()`
    // 明确「收起时只认 cancel」—— 所以 Esc 就是放弃。
    f.feed(ESC);
    // 断言「随便按一个键不会顺手答一道」：下面的 Enter 必须仍然什么都不发生。
    f.feed('\r');
    await painted();

    const result = (await Promise.race([
      pending,
      new Promise((_, rj) => setTimeout(() => rj(new Error('TIMEOUT：收起后 Esc 没收工')), 5_000)),
    ])) as { details?: unknown };
    assert.deepEqual(result.details, { answers: [], cancelled: true }, '收起后 Esc 该是「放弃」');
    assert.equal(f.slot.current, undefined, '答完该把 composer 还回去');
  } finally {
    if (pending) await cancel(pending).catch(() => undefined);
    restore();
  }
});

test('折叠（inline）：收起 → 展开 → 正常答题（收起过之后控件没坏）', { skip }, async () => {
  // 另一半：收起 → 展开 → 正常选一个 → 答案真的回来了。
  // 只验「收得起」会漏掉「展开之后控件坏了」—— 而那正好是折叠键与答题键抢同一个
  // 路由时的典型症状。
  let pending: Promise<unknown> | undefined;
  try {
    const started = await startDialogue(ONE_QUESTION);
    pending = started.pending;
    const { f, painted } = started;

    f.feed(CTRL_BRACKET);
    await painted();
    f.feed(CTRL_BRACKET);
    await painted();
    await waitFor(
      () => f.textSince(0).includes('Which approach should we take?'),
      5_000,
      '该展开回来',
    );

    // 选第一项（Enter 确认）。
    f.feed('\r');
    await painted();
    const result = (await Promise.race([
      pending,
      new Promise((_, rj) => setTimeout(() => rj(new Error('TIMEOUT：Enter 没确认')), 5_000)),
    ])) as {
      content: { type: string; text?: string }[];
      details: { answers?: unknown[]; cancelled?: boolean };
    };

    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    assert.match(text, /User has answered your questions/, `该是「已回答」而不是放弃：${text}`);
    assert.match(text, /Minimal/, `该把选中的那个 label 带回模型：${text}`);
  } finally {
    if (pending) await cancel(pending).catch(() => undefined);
    restore();
  }
});

test('折叠（overlay）：槽位被第一份问卷占住时，第二份降级成浮层', { skip }, async () => {
  // 这是 overlay 形态**今天唯一还能走到的入口**（扩展的 `claimInlineSlot()` 抢不到
  // 槽位就降级），也是我们宿主里 `{ overlay: true }` 那条路唯一的真实用例 ——
  // 所以它值得一条测试：宿主必须能同时撑住「一内一外」两份问卷。
  let first: Promise<unknown> | undefined;
  let second: Promise<unknown> | undefined;
  try {
    const started = await startDialogue(ONE_QUESTION);
    first = started.pending;
    second = started.askAgain(ONE_QUESTION);

    // 第二份进了浮层栈，而第一份还在槽位里。
    await waitFor(() => started.f.tui.hasOverlay(), 20_000, '第二份问卷该降级成浮层');
    assert.ok(started.f.slot.current !== undefined, '第一份仍该占着输入区槽位');

    started.f.tui.hideOverlay();
  } finally {
    if (second) second.catch(() => undefined);
    if (first) await cancel(first).catch(() => undefined);
    restore();
  }
});