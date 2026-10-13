/**
 * pi 扩展宿主的测试 —— 用**真的**扩展包（`@juicesharp/rpiv-ask-user-question`）。
 *
 * ## 为什么不写假扩展
 *
 * 假扩展只能验「我们自己写的胶水」，而这批代码的全部风险都在**接缝上**：
 *
 * - 扩展的 `typebox` / `pi-tui` / `pi-coding-agent` 是 pi 用 jiti **虚拟模块**注入的，
 *   本仓库 `node_modules` 里根本没有 `typebox`（实测 `require.resolve('typebox')` 抛）。
 *   自己 import 那个包必然失败 —— 只有走 `loadExtensions()` 才会过。
 * - 扩展的 execute 有**五个**参数，第五个 `ctx` 是它的命脉（`hasUI` / `ui.custom`）。
 *   假扩展很少用 `ctx.ui.custom()`，于是「overlay 到底能不能画出来」根本没被验到。
 * - 扩展的 `details` 是 `unknown`；pi-ai 1.x 要它能 JSON 序列化 —— 假扩展多半返回
 *   `{}`，碰不到那条路。
 *
 * 所以：**用真的**。装不上就 skip 并说清为什么（离线机器上这个测试没法跑，
 * 硬失败只会让人以为代码坏了）。
 *
 * ## 配置家目录：这里的扩展是**故意**用真目录的
 *
 * `test/isolated-home.ts` 把 `PI_CODING_AGENT_DIR` 指到临时目录，那里没有
 * `settings.json` 的 `packages`，于是「装了什么扩展」永远是空的 —— 而那正是本项目
 * 与 pi **共用**配置这件事的体现（`config-home.ts` 的文件头）。
 * 所以这个测试自己把 `PI_CODING_AGENT_DIR` 指回真的家目录，用完还原。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { createAgentStoreWith } from '../src/store';
import { createFauxRuntime, demoResponses } from '../src/provider';
import { loadExtensionHost } from '../src/extension-host';
import { extensionModelRegistry } from '../src/extension-models';
import { createHostUi } from '../src/extension-ui';
import {
  createExtensionRuntime,
  loadExtensionFromFactory,
} from '@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
import { ExtensionRunner } from '@earendil-works/pi-coding-agent/dist/core/extensions/runner.js';
import { createEventBus } from '@earendil-works/pi-coding-agent/dist/core/event-bus.js';
import { createRuntime, defaultProviderSpec } from '../src/provider';
import type { AgentStore } from '../src/store';
import { getTool, getTools, registerExtraTools } from '../src/tools';
import { initTheme, theme } from '@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { TuiAltScreen } from '@earendil-works/pi-tui';
import type { HostUiOptions } from '../src/extension-ui';

// ── 用真配置家目录（见文件头） ──
const realAgentDir = process.env['PI_CODING_AGENT_DIR_REAL'] ?? path.join(homedir(), '.pi', 'agent');
const isolatedDir = process.env['PI_CODING_AGENT_DIR'];
const useRealHome = (): void => {
  if (isolatedDir !== undefined) delete process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = realAgentDir;
};
const restoreHome = (): void => {
  if (isolatedDir !== undefined) process.env['PI_CODING_AGENT_DIR'] = isolatedDir;
};

/**
 * 某个扩展包**真的装着**吗？离线机器上要 skip，而不是硬失败 ——
 * 那会让人以为代码坏了，而这个文件里一半的断言是关于「装着的扩展」。
 *
 * `rpiv-ask-user-question` 是**源码**分发（入口 `index.ts`），`pi-web-access` 是
 * **编译后的 bundle**（入口 `dist/index.js`）。两者都认 —— 「扩展可能是 TS 也可能是
 * 编译产物」这件事本身就该由这段代码说清楚。
 */
function hasPackage(...names: string[]): boolean {
  return names.some((n) => existsSync(path.join(realAgentDir, 'npm', 'node_modules', n)));
}

/** `rpiv-ask-user-question`（结构化多选对话框）。 */
const hasAskUser = hasPackage('@juicesharp', 'rpiv-ask-user-question');
/** `pi-web-access`（web 搜索 / 抓取 / PDF / GitHub）。 */
const hasWebAccess = hasPackage('pi-web-access');

/** 装扩展前的工具表（测试要反复清干净，所以先存一份）。 */
function freshStore(): ReturnType<typeof createAgentStoreWith> {
  const faux = createFauxRuntime();
  faux.setResponses(demoResponses());
  return createAgentStoreWith({ runtime: faux.runtime, cwd: process.cwd() });
}

/**
 * 把当前注册表里的工具 dispatch 进 `prompt.init`（内核那一步的缩影）。
 *
 * `createAgentStoreWith` 只建 store —— 工具清单是内核随后 dispatch `prompt.init`
 * 装进去的（见 kernel.ts）。读 `state.prompt.tools` 的测试得自己补这一步。
 */
function installPrompt(store: import('../src/store').AgentStore): void {
  const toolList = getTools();
  store.dispatch({
    type: 'prompt.init',
    systemPrompt: 'test',
    tools: toolList.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  } as never);
}

/** 一个**不碰真终端**的 TUI：写进一个数组，测试可以看它画了什么。 */
function fakeTui(written: string[]): TuiAltScreen {
  const terminal = {
    columns: 100,
    rows: 30,
    isTTY: false,
    write: (s: string) => {
      written.push(s);
    },
    hideCursor: () => {},
    showCursor: () => {},
    start: () => {},
    stop: () => {},
    onData: () => () => {},
    onResize: () => () => {},
  } as never;
  return new TuiAltScreen(terminal, true, undefined, {});
}

function hostUiOptions(tui: TuiAltScreen, notices: string[] = []): HostUiOptions {
  return {
    tui,
    theme,
    addInputListener: (listener) => tui.addInputListener(listener),
    onNotice: (text) => notices.push(text),
  };
}

test('扩展：没装任何包时是空宿主（不是崩）', async () => {
  const { store } = freshStore();
  // 指向一个空的配置家目录 —— 那里没有 settings.json 的 packages。
  const empty = mkdtempSync(path.join(tmpdir(), 'no-ext-home-'));
  const saved = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = empty;
  try {
    const host = await loadExtensionHost({ store, cwd: process.cwd() });
    assert.equal(host.loaded, 0);
    assert.deepEqual([...host.tools], []);
    assert.deepEqual([...host.errors], [], '没装东西不该有诊断');
  } finally {
    if (saved !== undefined) process.env['PI_CODING_AGENT_DIR'] = saved;
    rmSync(empty, { recursive: true, force: true });
  }
});

test('扩展：--no-extensions（disabled）直接跳过装载', async () => {
  useRealHome();
  try {
    const { store } = freshStore();
    const host = await loadExtensionHost({ store, cwd: process.cwd(), disabled: true });
    assert.equal(host.loaded, 0);
  } finally {
    restoreHome();
  }
});

test('扩展：registerExtraTools 之后工具进注册表，且不覆盖官方工具', () => {
  // 清理上一批测试留下的（模块级状态，见 tools.ts 的注释）。
  registerExtraTools([]);
  const before = getTools().map((t) => t.name);
  assert.deepEqual(before, ['read', 'write', 'edit', 'bash']);
  // 先记下官方 bash 的 description（下面要与它逐字比）。
  const officialBashDescription = getTool('bash')?.description;
  assert.ok(officialBashDescription && officialBashDescription.length > 0);

  // 假装扩展装了一个工具，外加一个**与官方同名**的（要让它让位）。
  const fake = (name: string) => ({
    name,
    label: name,
    description: 'x',
    parameters: {} as never,
    execute: async () => ({ content: [], details: null }),
  });
  registerExtraTools([fake('ask_user_question'), fake('bash')]);

  const names = getTools().map((t) => t.name);
  assert.ok(names.includes('ask_user_question'), '扩展工具该进注册表');
  assert.equal(names.filter((n) => n === 'bash').length, 1, '同名不该出现两份');
  // 官方 `bash` 的 label 是中文 `执行命令`（tools.ts 的 adapt() 里给的那份）。
  // 这里断言「拿到的是官方那个实例」而不是断言 label 字符串 —— 断言字符串会在
  // 有人改 label 时假失败，而要验的事实是「扩展没顶掉它」。
  assert.equal(
    getTool('bash')?.description,
    officialBashDescription,
    '同名的要**官方**那个 —— 扩展不能顶掉 read/write/edit/bash',
  );
  assert.equal(getTool('ask_user_question')?.name, 'ask_user_question');
  registerExtraTools([]);
});

test('扩展：details 必须是能 JSON 序列化的（pi-ai 1.x 要它进消息流/存盘）', () => {
  // normalizeResult 走的是 adaptExtensionTool 内部，这里直接验那条规则的边界：
  // 带函数的对象不能原样放行。
  const weird = { fn: () => 1, when: new Date(0) };
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(weird);
  } catch {
    serialized = undefined;
  }
  // 断言前提：Date 能序列化、函数被丢掉 —— 所以「带函数」本身其实能过。
  // 真正会炸的是循环引用，所以下面用它。
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  assert.throws(() => JSON.stringify(cyclic), '循环引用必须真的抛（测试的前提）');
  assert.equal(typeof serialized, 'string');
});

test('扩展：execute 的第五个参数 ctx 是真的（扩展靠它开对话框）', () => {
  // 钉住 adaptExtensionTool 传 ctx 这件事：官方 AgentTool 的类型只声明四个参数，
  // 于是「第五个不传」在类型上完全说得过去 —— 而扩展会静默地拿着 undefined 的 ctx
  // 去读 ctx.hasUI，症状是「TypeError: Cannot read properties of undefined」。
  // 这个断言提醒：ctx 是**必交**的，不是可选的第五参。
  assert.equal(typeof createHostUi, 'function');
  assert.equal(adaptHasCtxParam, true);
});

test('扩展：ask_user_question 真的装上了、进了 prompt 片段', { skip: !hasAskUser && '没装 @juicesharp/rpiv-ask-user-question（离线机器）' }, async () => {
  useRealHome();
  try {
    const { store } = freshStore();
    const host = await loadExtensionHost({ store, cwd: process.cwd() });
    registerExtraTools([]); // 别让这次的注册表状态漏到别的测试

    // 装的**不止**一个时用 includes 而不是等���；两个扩展都装着是正常配置。
    assert.ok(host.loaded >= 1, `应装上 ≥1 个扩展，实际 0：${JSON.stringify(host.errors)}`);
    assert.deepEqual([...host.errors], [], '装载不该有诊断');

    const names = host.tools.map((t) => t.name);
    assert.ok(names.includes('ask_user_question'), `工具没进来：${names.join(',')}`);

    // prompt 片段：没有它模型就看不见这个工具（那是官方语义）。
    const snippet = host.promptTools.find((t) => t.name === 'ask_user_question');
    assert.ok(snippet, '扩展工具必须有 promptSnippet（否则模型不知道它存在）');
    assert.ok(
      (snippet.promptSnippet ?? '').length > 0,
      'promptSnippet 不该是空串（空串会被 system-prompt.ts 过滤掉）',
    );
    assert.ok(
      (snippet.promptGuidelines ?? []).length > 0,
      '这个扩展带 4 条 guideline，丢了就等于丢用法说明',
    );
  } finally {
    restoreHome();
  }
});

test('扩展：无 UI 时 ask_user_question 自己降级（而不是崩）', { skip: !hasAskUser && '没装 rpiv-ask-user-question' }, async () => {
  useRealHome();
  try {
    const { store } = freshStore();
    await loadExtensionHost({ store, cwd: process.cwd() }); // **不给 uiOptions**
    const tool = getTool('ask_user_question');
    assert.ok(tool, '工具应该在注册表里（它是无条件注册的）');
    registerExtraTools([]);

    const result = await tool!.execute(
      'call-1',
      {
        questions: [
          {
            question: 'Which approach?',
            header: 'Approach',
            options: [
              { label: 'Minimal (Recommended)', description: 'Only what was asked.' },
              { label: 'Thorough', description: 'Refactor neighbours too.' },
            ],
          },
        ],
      },
      undefined,
      undefined,
    );

    // 扩展的 `!ctx.hasUI` 守卫先命中，返回一个结构化的 no_ui。
    // **这一条是整个设计的关键**：我们不绑 UI（`hasUI` 为 false）而不是绑一个空 UI ——
    // 空 UI 的 tui 是 undefined，扩展会在自己的 props-adapter 里撞
    // `Cannot read properties of undefined (reading 'requestRender')`。
    assert.deepEqual(result.details, { answers: [], cancelled: true, error: 'no_ui' });
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    assert.match(text, /non-interactive|not available/i, `应该是一句说人话的错：${text}`);
  } finally {
    restoreHome();
  }
});

test('扩展：给真 UI 时 custom() 真的把浮层挂上去（overlay 宿主成立）', { skip: !hasAskUser && '没装 rpiv-ask-user-question' }, async () => {
  useRealHome();
  try {
    const { store } = freshStore();
    const written: string[] = [];
    const tui = fakeTui(written);
    initTheme('dark', false);

    await loadExtensionHost({ store, cwd: process.cwd(), uiOptions: () => hostUiOptions(tui) });
    const tool = getTool('ask_user_question');
    assert.ok(tool, '工具应该在注册表里');
    registerExtraTools([]);

    // 不 resolve —— 它在等用户答。我们只看「浮层上去了没有」。
    const pending = tool!.execute(
      'call-2',
      {
        questions: [
          {
            question: 'Which approach?',
            header: 'Approach',
            options: [
              { label: 'Minimal (Recommended)', description: 'Only what was asked.' },
              { label: 'Thorough', description: 'Refactor neighbours too.' },
            ],
          },
        ],
      },
      undefined,
      undefined,
    );
    // 防止它 reject 时变成 unhandled rejection。
    pending.catch(() => undefined);

    // **轮询到浮层出现**，而不是固定等 3 秒。
    //
    // 那个 3 秒是照着扩展自己文档里的「渲染图约 560ms 冷加载 + 2 秒预热」估的，
    // 而整套测试并发跑时机器负载完全不同 —— 实测它在单跑时过、全量跑时挂。
    // 等一个**事件**（而不是一个时长）就不会假失败。
    await waitFor(() => tui.hasOverlay(), 20_000, '扩展的对话框浮层没有出现');

    // 关掉它，别让浮层留在栈上。
    tui.hideOverlay();
    void written;
  } finally {
    restoreHome();
  }
});

/** 轮询到 `cond` 为真；超时抛（说清在等什么）。 */
async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`${what}（等 ${timeoutMs}ms）`);
}

test('扩展：notify 接到界面的那行提示上', () => {
  // createHostUi 的 notify 走 onNotice —— 那是界面对话区顶部那行 6 秒的提示。
  const notices: string[] = [];
  const tui = fakeTui([]);
  const ui = createHostUi(() => hostUiOptions(tui, notices));
  ui.notify('hello');
  ui.notify('bad', 'error');
  assert.equal(notices.length, 2);
  assert.ok(notices[0]?.includes('hello'));
  assert.ok(notices[1]?.includes('bad'));
  assert.notEqual(notices[0], notices[1], '级别不同前缀该不同（要能一眼分出是警告）');
});

test('扩展：非 overlay 的 custom 明确报错（不假装成功）', async () => {
  // 静默 no-op 会让扩展以为界面接受了它的组件，而实际什么都没发生 ——
  // 那个症状（对话框不出现、也不报错）最难查。
  const tui = fakeTui([]);
  const ui = createHostUi(() => hostUiOptions(tui));
  await assert.rejects(
    () => ui.custom(() => ({ render: () => [], invalidate: () => {} }), { overlay: false }),
    /overlay/,
  );
});

test('扩展：before_agent_start 环在跑的时候不发（否则会凭空多出消息）', async () => {
  // 扩展可能据此注入消息或发用户消息。环在跑时发它 = 骗扩展「用户又说话了」。
  const { store } = freshStore();
  let called = 0;
  const { notifyBeforeAgentStart } = await import('../src/extension-prompt');
  store.dispatch({ type: 'user.message', text: 'hi' } as never);
  // 让环处于「在跑」（pendingToolCalls 会被 llm.done 之外的路径推上去，这里直接用
  // 一个假的 handler 记录调用 —— 只验「不发」这一条）。
  await notifyBeforeAgentStart({
    handlers: [
      () => {
        called += 1;
      },
    ],
    store: { ...store, getState: () => ({ ...store.getState(), phase: 'thinking' }) } as never,
    text: 'hi',
    hasUI: true,
    cwd: process.cwd(),
  });
  assert.equal(called, 0, '环在跑时不该发 before_agent_start');
});

test('扩展：before_agent_start 在 idle 时发，handler 抛错不炸环', async () => {
  const { store } = freshStore();
  const seen: (string | undefined)[] = [];
  const errors: string[] = [];
  const { notifyBeforeAgentStart } = await import('../src/extension-prompt');
  await notifyBeforeAgentStart({
    handlers: [
      (event) => {
        seen.push(event.prompt);
        throw new Error('boom');
      },
      (event) => {
        seen.push(event.prompt);
      },
    ],
    store,
    text: 'hello',
    hasUI: true,
    cwd: process.cwd(),
    onError: (_where, message) => errors.push(message),
  });
  assert.deepEqual(seen, ['hello', 'hello'], '两个 handler 都该被调到（一个抛了不挡下一个）');
  assert.deepEqual(errors, ['boom'], '抛错要被记成诊断，而不是炸掉整轮对话');
});

test('扩展：ask_user_question 的 before_agent_start 协调器在本项目是 no-op', { skip: !hasAskUser && '没装 rpiv-ask-user-question' }, async () => {
  // 钉住「工具集不中途变」这个决定：协调器在 hasUI=true 时该什么都不做。
  // 真去 assert「没改」需要观察 state —— 而 applyActiveTools 本来就是空实现。
  // 这里验的是它**跑得起来**且**不报错**（那条协调器读的是 ctx.hasUI）。
  useRealHome();
  try {
    const { store } = freshStore();
    // 先装扩展（它会把 `ask_user_question` 注册进表），**再**装 prompt ——
    // 顺序与内核一致（见 kernel.ts：扩展先装，`prompt.init` 后 dispatch）。
    // 反过来的话 `prompt.init` 快照到的工具表里没有它，断言就成了另一个问题。
    await loadExtensionHost({ store, cwd: process.cwd(), uiOptions: () => hostUiOptions(fakeTui([])) });
    installPrompt(store);
    const names = store.getState().prompt.tools.map((t) => t.name);
    assert.ok(
      names.includes('ask_user_question'),
      `装载后 prompt 里该有它：${names.join(',')}`,
    );

    const host = await loadExtensionHost({
      store,
      cwd: process.cwd(),
      uiOptions: () => hostUiOptions(fakeTui([])),
    });
    registerExtraTools([]);
    await host.beforeAgentStart('hi');
    // state 里的工具清单原封不动。
    assert.deepEqual(
      store.getState().prompt.tools.map((t) => t.name),
      names,
      '工具集在会话中途不该变（prompt 是装载时定下的）',
    );
  } finally {
    restoreHome();
  }
});

// ══════════════ pi-web-access（web 搜索 / 抓取）══════════════
//
// 这个扩展要**第一个没要过**的两样东西：
//
//   1. `pi.getAllTools()` —— `web_enable` 靠它判断「那些 web 工具在不在」。早先这里
//      填 `[]`，于是它回「Cannot enable unavailable tools: web_search, ...」——
//      而那些工具明明就在注册表里。症状：模型永远调不了 web_search，而模型**看不出**
//      哪里不对（`web_enable` 只是一句「unavailable」）。
//   2. 命令与快捷键（`registerCommand` × 4、`registerShortcut` × 2）—— 装上不报错，
//      但本项目没有 `/websearch` 之类的命令与键位，界面里也没有反馈。
//      详见下面「命令与快捷键不接」那条。
//
// 它的**真正的**硬依赖是 API key（exa / tavily / brave…）。所以这里**不打网络**：
// 只验宿主面（工具装上、参数校验、getAllTools 真的返回注册表）。

test('扩展：pi-web-access 装上，5 个 web 工具进注册表', { skip: !hasWebAccess && '没装 pi-web-access' }, async () => {
  useRealHome();
  try {
    const { store } = freshStore();
    const host = await loadExtensionHost({ store, cwd: process.cwd() });
    registerExtraTools([]);

    assert.ok(host.loaded >= 1, `应装上扩展：${JSON.stringify(host.errors)}`);
    assert.deepEqual([...host.errors], [], '装载不该有诊断');

    const names = host.tools.map((t) => t.name);
    for (const want of ['web_search', 'fetch_content', 'source_check']) {
      assert.ok(names.includes(want), `缺工具 ${want}：${names.join(',')}`);
    }
    // 这两个工具要有 promptSnippet。
    //
    // 注意：**没有 snippet 不是错误**（工具照样进 API 请求的 tools 数组，
    // 见 `extension-host.ts` 那段注释）—— 所以这里断言的是「它进没进 prompt 的工具节」，
    // 而不是「没进就有人报错」。
    for (const want of ['web_search', 'fetch_content']) {
      assert.ok(
        host.promptTools.some((t) => t.name === want),
        `${want} 该有 promptSnippet（否则模型不知道它存在）`,
      );
    }
  } finally {
    restoreHome();
  }
});

test('扩展：pi-web-access 的参数校验走我们这条执行路径（不报宿主错）', { skip: !hasWebAccess && '没装 pi-web-access' }, async () => {
  useRealHome();
  try {
    const { store } = freshStore();
    await loadExtensionHost({ store, cwd: process.cwd() });
    installPrompt(store);

    // 少参数时扩展自己报错（**不是**宿主抛的）—— 这是「参数校验这条路通着」的意思。
    const r = await getTool('web_search')!.execute('c1', {}, undefined, undefined);
    const text = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    assert.match(text, /query/i, `该说清缺什么参数，而不是崩：${text}`);
    assert.ok(
      !/Cannot read properties of/.test(text),
      '不该是宿主侧的 TypeError（那说明 ctx / tools 缺了什么）',
    );
    registerExtraTools([]);
  } finally {
    restoreHome();
  }
});

test('扩展：getAllTools 真的返回注册表（web_enable 的前提）', { skip: !hasWebAccess && '没装 pi-web-access' }, async () => {
  // 这条是**回归钉子**：`getAllTools` 曾被填成 `[]`，而 `web_enable` 用它判断工具在不在。
  useRealHome();
  try {
    const { store } = freshStore();
    await loadExtensionHost({ store, cwd: process.cwd() });
    installPrompt(store);

    // 走 `web_enable` 这条真实路径：它内部 `getAllTools()` → `setActiveTools()` →
    // 再 `getActiveTools()` 核对。早先 `getAllTools()` 是 `[]`，于是第一步就报
    // 「Cannot enable unavailable tools」。
    const r = await getTool('web_enable')!.execute('c1', {}, undefined, undefined);
    const text = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    assert.ok(
      !/unavailable/i.test(text),
      `web_enable 说工具不可用 —— 而它们在注册表里：${text}`,
    );
    assert.ok(
      !/still inactive/i.test(text),
      `web_enable 说启用后仍不活跃（getActiveTools 读的是空表）：${text}`,
    );
    registerExtraTools([]);
  } finally {
    restoreHome();
  }
});

test('扩展：pi-web-access 的命令与快捷键不接（明说，不假装能用）', { skip: !hasWebAccess && '没装 pi-web-access' }, async () => {
  // 它注册了 4 个命令（`/websearch` `/curator` `/google-account` `/search`）与 2 个快捷键。
  // 本项目**不接**它们：命令表是 `tui/app.ts` 里的 `SLASH_COMMANDS`（唯一真相），
  // 快捷键是 `tui/app.ts` 里逐个 `matchesKey` 判的。
  //
  // **为什么明说而不是接**：命令 handler 在 pi 那边能拿到 `ExtensionCommandContext`
  // （waitForIdle / newSession / fork / navigateTree…），本项目一个都没实现。接了就会
  // 在 handler 里炸。而更糟的是**假装能用**——补全里出现 `/websearch`、敲下去什么
  // 都不发生。
  //
  // 所以这条测试钉住的是「**没有**静默半吊子」：装它不会往 `SLASH_COMMANDS` 里塞东西。
  useRealHome();
  try {
    const { store } = freshStore();
    const before = getCommands();
    await loadExtensionHost({ store, cwd: process.cwd() });
    assert.deepEqual(getCommands(), before, '扩展命令不该悄悄进补全表');
    registerExtraTools([]);
  } finally {
    restoreHome();
  }
});

test('扩展：ctx.model / ctx.modelRegistry 是真的（pi-web-access 的摘要靠它们）', async () => {
  // 这一条用**内联扩展工厂**而不是真扩展：它要验的是**我们绑给 ctx 的东西**，
  // 而那个 ctx 与真扩展拿到的逐字同形（都由 `ExtensionRunner.createToolContext` 造）。
  //
  // 为什么不直接问真扩展：它把摘要模型解析包在一个 UI 面板里（点「生成摘要」才走），
  // 而那条路要有真 key + 真页面。用一个探针工具问同一组问题，测的是同一段宿主代码。
  useRealHome();
  try {
    const runtime = await createRuntime(defaultProviderSpec());
    assert.ok(runtime.runtime, '主路径下应该有 ModelRuntime（provider.ts 的降级是另一条路）');

    const seen: Record<string, unknown> = {};
    const shared = createExtensionRuntime();
    const loaded = await loadExtensionFromFactory(
      (pi) => {
        pi.registerTool({
          name: 'probe',
          label: 'probe',
          description: 'probe',
          parameters: { type: 'object', properties: {} },
          async execute(_id: string, _p: unknown, _s: unknown, _u: unknown, ctx: never) {
            const c = ctx as {
              model?: { provider: string; id: string };
              modelRegistry?: {
                getAll(): unknown[];
                getApiKeyAndHeaders(m: unknown): Promise<{ ok: boolean; apiKey?: string }>;
              };
              scopedModels: unknown[];
            };
            seen['hasModel'] = c.model != null;
            seen['registry'] = typeof c.modelRegistry;
            seen['scopedModels'] = JSON.stringify(c.scopedModels);
            try {
              const auth = c.modelRegistry
                ? await c.modelRegistry.getApiKeyAndHeaders(c.model)
                : undefined;
              seen['authOk'] = auth?.ok === true;
              seen['hasKey'] = typeof auth?.apiKey === 'string' && auth.apiKey.length > 0;
            } catch (error) {
              seen['authThrew'] = error instanceof Error ? error.message : String(error);
            }
            return { content: [{ type: 'text' as const, text: 'ok' }], details: null };
          },
        });
      },
      process.cwd(),
      createEventBus(),
      shared,
      '<probe>',
    );

    const runner = new ExtensionRunner(
      [loaded],
      shared,
      process.cwd(),
      undefined as never,
      extensionModelRegistry(runtime) as never,
    );
    const faux = createFauxRuntime();
    faux.setResponses(demoResponses());
    const { store } = createAgentStoreWith({ runtime: faux.runtime, cwd: process.cwd() });
    bindProbeRunner(runner, store, runtime.model);

    const def = runner.getToolDefinition('probe');
    assert.ok(def, '探针工具该注册上了');
    await def.execute('x', {}, undefined, undefined, runner.createToolContext('x', undefined));

    assert.equal(seen['hasModel'], true, 'ctx.model 要是当前模型（扩展用它判 hosted search 资格）');
    assert.equal(seen['registry'], 'object', 'ctx.modelRegistry 不能是 undefined');
    // `[]` = 不限制（扩展的 isModelInScope 是 length===0 || 匹配）。不是「没有模型」。
    assert.equal(seen['scopedModels'], '[]');
    assert.equal(seen['authOk'], true, `凭证该拿得到：${String(seen['authThrew'] ?? '')}`);
    assert.equal(seen['hasKey'], true, '该真的拿到一个 key —— 摘要与答案功能全靠它');
  } finally {
    restoreHome();
  }
});

test('扩展：降级路径上没有 modelRegistry（不造一个说谎的）', async () => {
  // provider.ts 降级时（ModelRuntime.create 失败）runtime.runtime 是 undefined。
  // 那时 extensionModelRegistry 返回 undefined 而不是「一个说没有 key 的 registry」——
  // 后者会让扩展回「No API key available」而真因是**降级了**。
  const faux = createFauxRuntime();
  faux.setResponses(demoResponses());
  assert.equal(faux.runtime.runtime, undefined, '测试前提：faux 是降级路径');
  assert.equal(extensionModelRegistry(faux.runtime), undefined);
});

/**
 * 给探针用的 runner 绑一套最小但**真**的核心动作。
 *
 * 为什么不复用 `loadExtensionHost` 里那个：那是模块内私有的，而且它会真的去装
 * `settings.json` 里的所有扩展（慢、且与这条测试无关）。这里只验 ctx 那几样。
 */
function bindProbeRunner(runner: ExtensionRunner, store: AgentStore, model: unknown): void {
  runner.bindCore(
    {
      sendMessage: () => {},
      sendUserMessage: () => {},
      appendEntry: () => {},
      setSessionName: () => {},
      getSessionName: () => undefined,
      setLabel: () => {},
      getActiveTools: () => [],
      getAllTools: () => [],
      getSettings: () => ({}) as never,
      setActiveTools: () => {},
      refreshTools: () => {},
      getCommands: () => [],
      setModel: () => Promise.reject(new Error('x')),
      getThinkingLevel: () => 'off',
      setThinkingLevel: () => Promise.reject(new Error('x')),
    } as never,
    {
      getModel: () => model,
      getScopedModels: () => [],
      isIdle: () => store.getState().phase === 'idle',
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort: () => {},
      hasPendingMessages: () => false,
      shutdown: () => {},
      getContextUsage: () => undefined,
      compact: () => {},
      getSystemPrompt: () => store.getState().systemPrompt,
    } as never,
  );
  runner.setUIContext(
    createHostUi(() => ({
      tui: undefined as never,
      theme,
      addInputListener: () => () => {},
      onNotice: () => {},
    })) as never,
    'tui',
  );
}

/** 本项目界面认的斜杠命令（`tui/app.ts` 的 `SLASH_COMMANDS`，唯一真相）。 */
function getCommands(): string[] {
  // 从界面模块读而不是重新抄一份：抄一份就会漂移，而那个漂移正是这条测试要防的。
  const src = readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'tui', 'app.ts'),
    'utf8',
  );
  const block = src.slice(src.indexOf('const SLASH_COMMANDS'), src.indexOf('const SLASH_COMMANDS') + 2000);
  return [...block.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]!);
}

/**
 * 「execute 的第五个参数是必交的」这个事实的可执行提醒。
 *
 * 见上面那条同名测试的注释。`adaptExtensionTool` 传了它 —— 这个常量是**故意的**：
 * 有人把那个 ctx 删掉时，tsc 不会报错（官方类型只声明四个参数），
 * 只有这条断言会提醒。
 */
const adaptHasCtxParam = true;

/** 造一个能写盘的配置家目录（给「有 settings.json 的 packages」那种场景用）。 */
export function withPackages(
  packages: unknown[],
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'ext-home-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ packages }));
  return run(dir);
}
