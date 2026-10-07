/**
 * 折叠：把对话框收成一行、让用户去看背后的对话，再展开。
 *
 * ## 为什么单独一个文件
 *
 * 折叠是**唯一**一条要**原始终端输入**才能走通的路（见下），所以它验的不只是
 * 「组件画得对不对」，而是**按键真的能穿过我们这一层到达它**。那要能模拟按键，
 * 于是要一个能被喂字节的 TUI —— 与其他扩展测试的「只发 promise」形状不同。
 *
 * ## 折叠的两条路（缺一不可）
 *
 * 扩展的 `ask-user-question.ts` 里 `registerCollapseKeyListener()`：
 *
 * 1. **raw listener** —— `ctx.ui.onTerminalInput(...)` 注册的，**无条件**收到终端字节。
 *    它是**唯一**能让折叠后**复原**的路：pi-tui 不把输入发给一个 `setHidden(true)`
 *    的 overlay 的 `component.handleInput`。
 * 2. **overlay 收起** —— `handle.setHidden(true)`。收成一行（`buildCollapsedRender`）
 *    而不是一个满屏的浮层，于是背后的对话看得见。
 *
 * 只做 1 不做 2：对话框还在挡；只做 2 不做 1：一旦收起来**再也回不来**，界面看着
 * 「按了没反应」而实际上它已经收到过按键了。所以下面两半都验。
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
import { TuiAltScreen, stripTerminalSequences, type TuiInputListener } from '@earendil-works/pi-tui';

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
  // 一个都看不到，扩展的 raw listener 永远不被调，症状是「Ctrl+] 收了不报、也展不开」。
  // 早先那版白测了（三个用例全挂，而真因在测试里）。
  // **必须 start()**，否则 `doRender()` 第一行就 return（`!this.altScreenActive`），
  // 于是浮层挂上了却一帧都不画。
  //
  // 症状特别容易误判：`hasOverlay()` 是 true、promise 也没 reject，看起来一切正常，
  // 而「画面是空的」这件事完全测不出来 —— 下面第一个断言就是因此先挂的。
  //
  // start() 只 `requestRender()`（走 process.nextTick），**没人等那个 tick** 的话
  // 测试会在第一帧之前就开始断言。所以紧接着手动 renderNow(true) 一帧，拿到
  // 「什么都没画」的基线；之后浮层每次变化都会再画。
  tui.start();
  tui.renderNow(true);
  // 记下起点：前面都是 enter/leave alt screen 与那一帧基线。
  written.length = 0;
  void onData;
  void onResize;
  return {
    tui,
    written,
    feed(data: string) {
      // **走 pi-tui 自己的 `handleTerminalInput`**，不自己重新实现一遍分发。
      //
      // 那里面做了四件事，缺一件就会「按了没反应」：
      //   1. 依次问所有 `addInputListener`（我们给扩展挂的 raw listener 就是这里），
      //      有人 `consume` 就停；
      //   2. 若当前焦点在**一个被 setHidden 的 overlay** 上，pi-tui 会把焦点改派到
      //      别的可见 overlay / 原处 —— 这正是「收起后按键去哪儿」的那条规则；
      //   3. 否则把按键交给 `focusedComponent.handleInput`（扩展的 session 走这条）。
      //
      // 早先这里只遍历 listeners（第 1 步），于是第 3 步从来没发生过：
      // 「收起 → 按 Esc」按不到任何人，promise 永远不 resolve。症状是 TIMEOUT，
      // 而真因是**测试的按键没有真的进 TUI**。
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

/** 装好扩展、起一个对话框，等它真的画出来。返回那张假 TUI 与提示收集器。 */
async function startDialogue(
  params: unknown,
): Promise<{
  f: FakeTui;
  notices: string[];
  pending: Promise<unknown>;
  painted: () => Promise<void>;
}> {
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
    }),
  });
  const tool = getTool('ask_user_question');
  assert.ok(tool, '扩展工具该装上了');
  const pending = tool.execute('c', params as Record<string, unknown>, undefined, undefined);
  pending.catch(() => undefined);
  // `hasOverlay()` 只说「在栈上」，不说「画出来了」。而这两件事在该死的时候是分开的：
  // pi-tui 的差分重绘是异步的（`requestRender` 走 nextTick + 16ms 节流），所以这里
  // 显式 `renderNow(true)` 强推一帧，否则断言会在第一帧之前跑。
  const painted = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 60));
    f.tui.renderNow(true);
  };
  await waitFor(() => f.tui.hasOverlay(), 20_000, '对话框浮层该出现');
  await painted();
  return { f, notices, pending, painted };
}

function restore(): void {
  registerExtraTools([]);
  if (isolatedDir !== undefined) process.env['PI_CODING_AGENT_DIR'] = isolatedDir;
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

test('折叠：Ctrl+] 收起 → 提示里点名那个键 → 再按一次展开', { skip }, async () => {
  let f: FakeTui | undefined;
  try {
    const started = await startDialogue(ONE_QUESTION);
    f = started.f;
    const { notices, painted } = started;

    // 展开态：问题本身在画面上（证明我们抓的是「真的画出来了」那一帧）。
    assert.ok(
      f.textSince(0).includes('Which approach should we take?'),
      '展开态该画出问题本身（否则下面测的不是同一个东西）',
    );

    const mark = f.written.length;
    f.feed(CTRL_BRACKET);
    await painted();

    // 扩展收起了，并且**点名了复原的键** —— 用户不知道按什么就等于没法用。
    await waitFor(
      () => notices.some((n) => /reopen/i.test(n)),
      5_000,
      '收起后扩展该 notify 一句「press … to reopen」',
    );
    assert.ok(
      notices.some((n) => /Ctrl\+\]/i.test(n)),
      `提示里该点名那个键：${notices.join(' | ')}`,
    );
    // 收起后**不该还在画整个对话框** —— 那就是 setHidden 没生效。
    assert.ok(
      !f.textSince(mark).includes('Refactor neighbours too.'),
      `收起后不该还在画整个对话框：\n${f.textSince(mark).slice(0, 300)}`,
    );

    // **再按一次要能展开** —— 这是最容易漏的一半：pi-tui 不把输入发给隐藏 overlay 的
    // handleInput，全靠那条 raw listener（我们 `onTerminalInput` 挂的那条）。
    const reopenMark = f.written.length;
    f.feed(CTRL_BRACKET);
    await waitFor(
      () => f!.textSince(reopenMark).includes('Which approach should we take?'),
      5_000,
      '第二次 Ctrl+] 该把对话框画回来（raw listener 复原这条路）',
    );
  } finally {
    f?.tui.hideOverlay();
    restore();
  }
});

test('折叠：收起后按 Esc 不作答（焦点已被移走），出路是再展开一次', { skip }, async () => {
  // 这条钉的是**实测行为**，不是扩展文档里那句「While collapsed, every keystroke
  // other than cancel is ignored」。实测（本机 pi-tui 1.0.3）：
  //
  //   1. `handle.setHidden(true)` 会**把焦点移走**（pi-tui 的 `setHidden`：
  //      `if (hidden) → setFocus(topVisible ?? preFocus)`）。
  //   2. 下一帧 `handleTerminalInput` 又发现「焦点在一个**不可见**的 overlay 上」，
  //      **再改派一次**，按键从此到不了 `QuestionnaireSession.handleInput`。
  //   3. 结果：收起后按 Esc **什么也不发生**（既不放弃、也不答题）。
  //
  // 扩展的 `routeCollapsed()` 写得没错（collapsed 时只认 cancel），但在**完全隐藏**的
  // overlay 上它收不到按键。那条路只在「折叠但**仍可见**」的降级形态下可达
  // （宿主没给 raw input → `canReopenWhileHidden === false` → 扩展退回可见的一行
  // 提示而不是隐藏）。
  //
  // **这不是我们宿主的问题**：pi 自己跑同一个扩展也是这个行为（同一个 pi-tui）。
  // 记在这里是因为「收起后按 Esc 没反应」是真实的用户困惑，而真因在 pi-tui 与扩展的
  // 交界处 —— 只看现象会以为是自己的接线错了。
  let f: FakeTui | undefined;
  try {
    const { f: fake, notices, pending, painted } = await startDialogue(ONE_QUESTION);
    f = fake;
    f.feed(CTRL_BRACKET);
    await waitFor(() => notices.some((n) => /reopen/i.test(n)), 5_000, '该收起');
    await painted();

    // 收起后 overlay 真的从栈上退下来了（setHidden 生效）。
    assert.equal(f.tui.hasOverlay(), false, '收起后该看不到浮层（setHidden 生效）');

    // 按 Esc：什么都没发生 —— 既没 resolve，也没作答。
    f.feed(ESC);
    await painted();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(
      settled,
      false,
      '收起后按 Esc 不该悄悄把问答收工（焦点已被移走，按键到不了 session）',
    );

    // 真正的出路：再按一次展开。
    f.feed(CTRL_BRACKET);
    await painted();
    await waitFor(
      () => f!.textSince(0).includes('Which approach should we take?'),
      5_000,
      '再按一次 Ctrl+] 该展开回来（收起后唯一的出路）',
    );

    // 展开后 Esc 就能放弃 —— 这才是「collapsed 时只认 cancel」那句的可达形态。
    f.feed(ESC);
    const result = (await Promise.race([
      pending,
      new Promise((_, rj) => setTimeout(() => rj(new Error('TIMEOUT：展开后 Esc 没收工')), 5_000)),
    ])) as { details: unknown };
    // 错的话会「随便按个键就顺手答了一道」—— 那是最糟的：用户以为自己只是让对话框
    // 让开，结果答案已经发回模型了。
    assert.deepEqual(result.details, { answers: [], cancelled: true }, '展开后按 Esc 该是「放弃」');
  } finally {
    f?.tui.hideOverlay();
    restore();
  }
});

test('折叠：展开态下 Ctrl+] 收得起来，且不影响正常答题', { skip }, async () => {
  // 另一半：收起 → 展开 → 正常选一个 → 答案真的回来了。
  // 只验「收得起」会漏掉「展开之后控件坏了」—— 而那正好是 raw listener 与
  // handleInput 抢同一个键时的典型症状。
  let f: FakeTui | undefined;
  try {
    const { f: fake, notices, pending, painted } = await startDialogue(ONE_QUESTION);
    f = fake;
    f.feed(CTRL_BRACKET);
    await waitFor(() => notices.some((n) => /reopen/i.test(n)), 5_000, '该收起');
    f.feed(CTRL_BRACKET);
    await painted();
    await waitFor(
      () => f!.textSince(0).includes('Which approach should we take?'),
      5_000,
      '该展开回来',
    );

    // 选第一项（Enter 确认）。
    f.feed('\r');
    await painted();
    const result = (await Promise.race([
      pending,
      new Promise((_, rj) => setTimeout(() => rj(new Error('TIMEOUT：Enter 没确认')), 5_000)),
    ])) as { content: { type: string; text?: string }[]; details: { answers?: unknown[]; cancelled?: boolean } };

    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    assert.match(text, /User has answered your questions/, `该是「已回答」而不是放弃：${text}`);
    assert.match(text, /Minimal/, `该把选中的那个 label 带回模型：${text}`);
  } finally {
    f?.tui.hideOverlay();
    restore();
  }
});
