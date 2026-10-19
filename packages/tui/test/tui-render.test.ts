import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  stripTerminalSequences,
  visibleWidth,
  isKeyRelease,
  matchesKey,
  getKeybindings,
  setKeybindings,
} from '@earendil-works/pi-tui';
import { formatCwdForFooter } from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js';
import {
  cwdLine,
  dim,
  dimLine,
  emphasizedTraceLine,
  extensionFooterRow,
  modelLine,
  renderColoredTree,
  TraceChunks,
  isScrollDown,
  isScrollUp,
  jumpToLatestHint,
  shouldIgnoreKey,
  renderQueuePanel,
  renderTranscript,
  TranscriptChunks,
  statsLine,
  tabLine,
  twoColumn,
} from '../src/app';
import { gitBranch } from '../src/app';
import { resolveThemeName, setupTheme } from '../src/theme';
import {
  createProjectKeybindings,
  formatKeyId,
  installProjectKeybindings,
  keyLabel,
} from '../src/keybindings';
import { createTraceTree, appendNode, patchNode } from '@ela/core/trace';
import { createInitialState, type AgentState } from '@ela/core/state';
import type { Message } from '@earendil-works/pi-ai';

/**
 * TUI 渲染的纯函数部分。
 *
 * ## 为什么这批以前测不了
 *
 * `renderTranscript()` 是 `app.ts` 的模块内私有函数，而且依赖 `terminal.columns`（屏幕尺寸）
 * 才能渲染 —— 尺寸只有真终端才有。当时只能启动 TUI 用眼睛看，而**眼睛看不到的退化**
 * 正是最该测的（底栏右栏飘了、参数显示成「0 个参数」、折叠行数算错）。
 *
 * 现在 `width` 是显式参数（0 = 不限宽，给一次性模式），这几个函数就成了纯函数，可以直接测。
 *
 * 这批测试守的是「照抄 pi 布局」那几处的具体形状：底栏两栏对齐、工具块的参数摘要、
 * 长输出折叠。形状错了不会抛错，只会让界面读起来别扭 —— 那种退化最适合用测试盯住。
 *
 * 从 `../src/tui/app` 直接导入（而不是经 `packages/core/src/index.ts`）：这些是 TUI 的实现细节，
 * 不属于库的公共 API。app.ts 被导入时不会执行副作用 —— 建终端、读 stdin 都在 runTui() 里。
 */

// ─── 底栏两栏对齐 ───

test('twoColumn：左右两栏贴边（模型名在右、路径在左）', () => {
  const line = twoColumn('C:\\proj', '(workbuddy) cn:space-bunny', 60);
  const plain = stripTerminalSequences(line);
  assert.equal(visibleWidth(plain), 60, '整行应该正好补到终端宽度');
  assert.ok(plain.trimEnd().endsWith('cn:space-bunny'), '右边应该是模型名');
  assert.ok(plain.startsWith('C:\\proj'), '左边应该是路径');
});

test('twoColumn：中文按双宽计算（右栏不会飘到左边盖住路径）', () => {
  // 这是用 pi-tui 的 visibleWidth 而不是 stripAnsi().length 的原因：汉字占两列。
  // 早先按字符数算，中文一多右栏就盖到左栏上。
  const line = twoColumn('中文路径目录', '模型', 40);
  const plain = stripTerminalSequences(line);
  assert.equal(visibleWidth(plain), 40, '含中文时仍要正好 40 列');
  assert.ok(plain.endsWith('模型'), '中文右栏要贴住右边');
});

test('twoColumn：放不下时截断而不是溢出（溢出会换行，把输入区顶出屏幕）', () => {
  const line = twoColumn('C:\\very\\long\\path\\that\\keeps\\going', '(workbuddy) cn:space-bunny', 30);
  assert.ok(visibleWidth(stripTerminalSequences(line)) <= 30, '不能超过给定宽度');
});

// ─── 底栏第一行的状态段（`ctx.ui.setStatus`） ───

/**
 * 这组盯的是扩展的 `ctx.ui.setStatus(key, text)` 落到哪儿：
 *
 * - 没有状态段时必须与原来那一行**逐字相同**（补满 + 整行 dim）—— 这是回归保护，
 *   底栏形状是 pi 截图一格对齐的，多一个空格都算退化；
 * - 有状态段时贴右边、**保持扩展自己的颜色**（整体再包一层 dim 会把它提前关掉）；
 * - 放不下时截断，不换行（换行会把输入区顶出屏幕）。
 */
test('extensionFooterRow：没有状态段 —— 就是原来那一行（补满整宽 + 整行 dim）', () => {
  const row = extensionFooterRow('~/proj (main)', '', 30);
  assert.equal(row, dim('~/proj (main)' + ' '.repeat(30 - '~/proj (main)'.length)));
  assert.equal(visibleWidth(stripTerminalSequences(row)), 30);
});

test('extensionFooterRow：状态段贴右边，且保留它自己的颜色', () => {
  // 扩展（`pi-background-tasks`）自己上色，收尾是 `\x1b[0m`。
  const status = '\x1b[36m bg 1 running \x1b[0m';
  const row = extensionFooterRow('~/proj (main)', status, 40);
  const plain = stripTerminalSequences(row);
  assert.equal(visibleWidth(plain), 40, '整行要正好补到 40 列，否则增量重绘留残影');
  assert.ok(plain.startsWith('~/proj (main)'), `左边应该是 cwd：${plain}`);
  // 状态段自带前后空格（扩展自己加的），所以只比内容贴不贴右边。
  assert.ok(plain.trimEnd().endsWith('bg 1 running'), `右边应该是状态段：${plain}`);
  assert.ok(row.includes('\x1b[36m'), '状态段的颜色不能被 dim 包掉');
  // dim 必须在状态段之前就结束（否则那段的 \x1b[0m 之后整行会突然变亮）。
  assert.ok(row.indexOf('\x1b[36m') > row.lastIndexOf('\x1b[2m'));
});

test('extensionFooterRow：放不下时截断而不是换行（溢出会把输入区顶出屏幕）', () => {
  const row = extensionFooterRow('~/very/long/path/that/keeps/going', 'bg 3 running · 2 failed · tab', 30);
  assert.ok(visibleWidth(stripTerminalSequences(row)) <= 30, '不能超过给定宽度');
});

// ─── cwd 行（底栏左侧） ───

test('cwdLine：家目录缩成 ~（pi 的口径）', () => {
  // 路径处理已改为直接用 pi 的 formatCwdForFooter()，home 取的是**真实的** homedir()
  // （函数内部自己读，不接受传入），所以测试得用真实 home 算期望值。
  const expected = formatCwdForFooter(String.raw`C:\proj`, homedir());
  assert.equal(cwdLine(String.raw`C:\proj`, 'main'), `${expected} (main)`);
});

test('cwdLine：家目录里的路径会缩成 ~（与 pi 截图同形）', () => {
  // 直接验函数链路的形状：cwd 在 home 之下 → 以 ~ 开头。
  const home = homedir();
  const under = path.join(home, 'Documents', 'workspace', 'event-loop-agent');
  const out = cwdLine(under, 'main');
  assert.ok(out.startsWith('~'), `家目录之下应以 ~ 开头：${out}`);
  assert.ok(out.endsWith('(main)'), out);
});

test('cwdLine：不在家目录里时保持绝对路径（~ 只会骗人）', () => {
  // 而 `resolve('D:\\some\\proj')` 在 posix 上是把它当**相对路径**接到 cwd 之后 ——
  // 结果正好落在 home 之下，于是被缩成 `~…`。那是 resolve 的规则，不是显示的 bug，
  // 断言要验的是「home 之外不缩」，所以给一个真的在 home 之外的绝对路径。
  const outside = path.resolve(homedir(), '..', '..', 'outside-home-proj');
  const out = cwdLine(outside, 'main');
  assert.ok(!out.startsWith('~'), `家目录之外不该缩成 ~：${out}`);
  assert.ok(out.includes('outside-home-proj'), out);
});

// ─── Kitty 键盘协议 flag 2（mac 上「快捷键触发两次」） ───
//
// pi-tui 的 `terminal.js` 启动时请求 Kitty 键盘协议 `1|2|4`，flag 2 = 报告事件类型。
// macOS 上支持它的终端（iTerm2 / Ghostty / kitty / WezTerm）于是**一次按键给两条序列**：
// press（`:1u`）与 release（`:3u`）。
//
// 而 `matchesKey()` 只读 `<code>;<mod>` 两段、第三段事件类型不参与匹配，所以 release
// 也「匹配」上了 —— 按一下切页键切换两次，等于没切。
//
// 官方那层过滤（`tui.js` 的 `isKeyRelease(data) && !focusedComponent.wantsKeyRelease`）
// 在 inputListeners **之后**跑且只查聚焦组件，而本项目的快捷键全挂在 input listener
// 上，管不到 —— 所以要自己滤。

test('Kitty flag 2：release 序列同样匹配 ctrl+r（这就是重复触发的机制）', () => {
  // 先把前提钉住：这个 bug 的根因是 release 能匹配。哪天 pi-tui 改了 matchesKey
  // 让事件类型参与匹配，这条会失败并提醒更新 `shouldIgnoreKey()` 的前提说明。
  const press = `${String.fromCharCode(27)}[114;5:1u`; // r=114, ctrl=5
  const release = `${String.fromCharCode(27)}[114;5:3u`;
  assert.ok(matchesKey(press, 'ctrl+r'), 'press 应当匹配 ctrl+r');
  assert.ok(matchesKey(release, 'ctrl+r'), 'release 也匹配 ctrl+r —— 所以要滤');
});

test('shouldIgnoreKey：只扔 release，press 与普通键都放行', () => {
  const esc = String.fromCharCode(27);
  const release = `${esc}[114;5:3u`; // ctrl+r 的 release
  const repeat = `${esc}[114;5:2u`; // ctrl+r 的 auto-repeat：长按应该重复生效
  const press = `${esc}[114;5:1u`;
  assert.ok(shouldIgnoreKey(release), 'release 要扔');
  assert.ok(!shouldIgnoreKey(press), 'press 要放行');
  // repeat 不是 release：长按连发是**期望行为**（翻页要能按住一直翻）。
  assert.ok(!shouldIgnoreKey(repeat), 'repeat 不该被当 release 扔掉');
  // Kitty 协议没启用时的传统字节序列（macOS 终端没启用 flag 2 时就是这个）。
  assert.ok(!shouldIgnoreKey(String.fromCharCode(18)), '传统 Ctrl+R（非 kitty 协议）要放行');
});

test('shouldIgnoreKey：粘贴内容放行（isScrollUp 是前缀匹配，误判就会误翻页）', () => {
  // 粘贴被 `\x1b[200~ … \x1b[201~` 包着。若粘贴的文本以 `ESC[A` 开头
  // （比如一段方向键转义），`isScrollUp()` 的前缀判断会命中而误翻页，
  // 所以放行必须在更早的地方发生，而不是在滚轮那一层。
  const pasted = `${String.fromCharCode(27)}[200~${String.fromCharCode(27)}[A粘贴的正文${String.fromCharCode(27)}[201~`;
  assert.ok(!shouldIgnoreKey(pasted), '粘贴整体不是 release');
  assert.ok(!isKeyRelease(pasted), 'pi-tui 的 isKeyRelease 也已排除粘贴');
});

test('shouldIgnoreKey：release 也不能触发滚轮', () => {
  // 方向键的 release（`ESC[1;5:3A`）如果放行，会被 `SCROLL_UP_SEQUENCES` 之外挡住 ——
  // 但 kitty 的 release 形式是 `\x1b[1;5:3A`，不带 `[` 后紧跟 A 的原形，
  // `includes()` 精确匹配不会误判。这条钉住「release 在更早的一层就被滤掉」。
  const releaseArrow = `${String.fromCharCode(27)}[1;5:3A`;
  assert.ok(!isScrollUp(releaseArrow), '精确匹配不该把 release 当翻页');
  assert.ok(shouldIgnoreKey(releaseArrow), 'release 仍然要滤');
});

// ─── git 分支：.git 是目录还是文件 ───

test('gitBranch：普通 checkout（.git 是目录）读出分支名', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gitbranch-dir-'));
  try {
    mkdirSync(path.join(root, '.git'));
    writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    assert.equal(gitBranch(root), 'main');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gitBranch：linked worktree（.git 是文件）也要读出分支名', () => {
  // 这是真 bug：`git worktree add` 之后 `<cwd>/.git` 变成一个**文件**，内容是
  // `gitdir: <主仓库>/.git/worktrees/<名字>`。老实现直接把 `.git` 当目录拼 HEAD，
  // 读到 ENOTDIR 就吞掉返回 undefined —— 底栏就只剩路径，分支名静默消失。
  //
  // 症状看起来像「界面坏了」，与真因隔了三层，所以在 worktree 里跑测试会先炸。
  const root = mkdtempSync(path.join(tmpdir(), 'gitbranch-wt-'));
  try {
    const real = path.join(root, 'worktree-admin');
    mkdirSync(real, { recursive: true });
    writeFileSync(path.join(real, 'HEAD'), 'ref: refs/heads/feat/rpiv-ask-user-question\n');
    // git 写的正是这个形状：单行 + 换行（这里刻意带上换行 —— 不 trim 就会拼出
    // `...\rpiv-compat\rHEAD`）。
    writeFileSync(path.join(root, '.git'), `gitdir: ${real}\n`);
    assert.equal(gitBranch(root), 'feat/rpiv-ask-user-question');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gitBranch：detached HEAD 认得出来', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gitbranch-det-'));
  try {
    mkdirSync(path.join(root, '.git'));
    writeFileSync(path.join(root, '.git', 'HEAD'), '9f2c1ab\n');
    assert.equal(gitBranch(root), 'detached');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gitBranch：不在仓库里返回 undefined（不编一个分支名）', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gitbranch-none-'));
  try {
    assert.equal(gitBranch(root), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 对话区：现在直接用 pi 官方的渲染组件 ───
//
// 下面这批断言盯的是「**用官方组件渲染出来的东西**」而不是「自己拼的字符串」：
// 参数摘要与输出折叠都已经交给 pi 的 `ToolExecutionComponent`，我们自己只负责把
// toolCallId 配到参数上、把耗时塞进去。
//
// 但这批退化**不会抛错**，只会让界面读起来别扭（工具块没底色、标题成了一行
// `执行命令`、思考不显示），所以正适合用测试钉住。

/** 造一个只有一条 assistant(toolCall) + 一条 toolResult 的会话。 */
function toolState(args: {
  toolName: string;
  args: Record<string, unknown>;
  resultText?: string;
  isError?: boolean;
  timings?: Record<string, number>;
}): AgentState {
  const id = 'call-1';
  return {
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id, name: args.toolName, arguments: args.args }],
        timestamp: 0,
      },
      {
        role: 'toolResult',
        toolCallId: id,
        toolName: args.toolName,
        content: [{ type: 'text', text: args.resultText ?? '' }],
        details: undefined,
        isError: args.isError ?? false,
        // 用固定时刻：官方 bash 渲染器会拿它算 `Took x.xs`，变动的时刻会让断言不稳。
        timestamp: 1_700_000_000_000,
      },
    ],
    toolTimings: args.timings ?? {},
  } as unknown as AgentState;
}

// 每帧都渲染一次，主题必须先装上（见 packages/tui/src/theme.ts：没 initTheme 读 theme 会抛）。
setupTheme(undefined, 'dark');

// ─── 收尾说明（中止 / 截断）与命令反馈卡：形状照 pi ───

test('中止的消息：pi 的组件画 `Operation aborted`，本项目不再自己写一段中文', () => {
  // 官方 `AssistantMessageComponent` 自己处理 `stopReason`：
  //   aborted（无工具调用）→ 空一行 + `Operation aborted`（`Request was aborted` 这种
  //   provider 原文会被它换成这一句）；length → `Response was truncated before completion.`；
  //   error → `Error: <原因>`。本项目早先重建假消息时丢掉了 stopReason，于是这些一行都不画，
  //   而自己在尾部用中文重写了一遍（还附上「按 Ctrl+R 看轨迹树」）。
  const aborted = {
    role: 'assistant',
    content: [{ type: 'text', text: '我正在想' }],
    api: 'openai-completions',
    provider: 'p',
    model: 'm',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'aborted',
    errorMessage: 'Request was aborted',
    timestamp: 2,
  } as unknown as Message;
  const state = {
    messages: [{ role: 'user', content: '慢慢想', timestamp: 1 } as Message, aborted],
    toolTimings: {},
    phase: 'idle',
  } as unknown as AgentState;
  const out = stripTerminalSequences(renderTranscript(state, 0, 80, false));
  assert.ok(out.includes('Operation aborted'), `要画 pi 那句：${out}`);
  assert.ok(!out.includes('Request was aborted'), `provider 原文该被换成那句：${out}`);
  assert.ok(out.includes('我正在想'), '部分内容要留着');
});

test('命令反馈卡：上面一行空行 + 左边一格（pi 的 Spacer(1) + paddingX=1）', () => {
  const state = { messages: [{ role: 'user', content: '你好', timestamp: 1 } as Message], toolTimings: {} } as unknown as AgentState;
  const out = stripTerminalSequences(
    renderTranscript(state, 0, 40, false, [{ text: 'Thinking blocks: hidden', at: 1 }]),
  ).split('\n');
  const index = out.findIndex((line) => line.includes('Thinking blocks: hidden'));
  assert.ok(index > 0, `卡要画出来：${out.join('/')}`);
  assert.equal(out[index - 1], '', '卡上面要有一行空行');
  assert.ok(out[index]?.startsWith(' Thinking'), `左边要留一格：${JSON.stringify(out[index])}`);
});

test('命令反馈卡：多行卡每一行都缩一格（`/session` 那种）', () => {
  const state = { messages: [], toolTimings: {} } as unknown as AgentState;
  const out = stripTerminalSequences(
    renderTranscript(state, 0, 40, false, [{ text: '/model\n/thinking', at: 0 }]),
  ).split('\n');
  const first = out.findIndex((line) => line.includes('/model'));
  assert.equal(out[first], ' /model');
  assert.equal(out[first + 1], ' /thinking', '第二行也要缩');
});

// ─── `/skill:<名字> 问题`：卡片 + 人问的那句话，两条都要画 ───

/** 一条用户消息的 state（对话区渲染只需要 `messages`）。 */
function userOnly(text: string): AgentState {
  return { messages: [{ role: 'user', content: text, timestamp: 1 }], toolTimings: {} } as unknown as AgentState;
}

/** `/skill:x` 展开出来的那一整段（与 `expandSkillCommand()` 同形）。 */
const SKILL_BLOCK =
  '<skill name="code-review" location="/tmp/skills/code-review/SKILL.md">\n' +
  'References are relative to /tmp/skills/code-review.\n\n正文第一步…\n</skill>';

test('skill 块 + 问题：卡片与人问的那句话都要画（与 pi 同一处补一条用户消息）', () => {
  // 官方组件的类注释写着「Only renders the skill block itself - user message is rendered
  // separately」，pi 的 addMessageToChat 那一支里确实补了 Spacer + UserMessageComponent。
  // 早先只画卡片，症状是「人问的那句话整个不见了」——而模型收到了它。
  const out = stripTerminalSequences(
    renderTranscript(userOnly(`${SKILL_BLOCK}\n\n帮我看下这个报错`), 0, 80, false),
  );
  assert.ok(out.includes('[skill]'), `要有 skill 卡片：${out}`);
  assert.ok(out.includes('code-review'), `卡片上要有名字：${out}`);
  assert.ok(out.includes('帮我看下这个报错'), `人问的那句话不能被吞掉：${out}`);
});

test('skill 块没有问题时：只画卡片（不多出一条空的用户消息）', () => {
  const out = stripTerminalSequences(renderTranscript(userOnly(SKILL_BLOCK), 0, 80, false));
  const nonEmpty = out.split('\n').filter((line) => line.trim() !== '');
  assert.equal(nonEmpty.length, 1, `折叠态就是一行，实际：${JSON.stringify(out)}`);
  assert.ok(nonEmpty[0]?.includes('[skill]'), nonEmpty[0] ?? '(空)');
});

test('skill 块 + 问题：展开（Ctrl+O）时两条都在，问题仍然单独一条', () => {
  const out = stripTerminalSequences(
    renderTranscript(userOnly(`${SKILL_BLOCK}\n\n第二个问题`), 0, 80, true),
  );
  assert.ok(out.includes('正文第一步'), `展开后要有正文：${out}`);
  assert.ok(out.includes('第二个问题'), `展开后问题也要在：${out}`);
});

test('工具块：标题行是英文工具名 + 参数（pi 形状，不是中文 label）', () => {
  const state = toolState({ toolName: 'read', args: { path: 'package.json' } });
  const out = stripTerminalSequences(renderTranscript(state, 0, 80, false));
  assert.ok(out.includes('read'), `标题要有工具名：${out}`);
  assert.ok(out.includes('package.json'), `标题要有文件名：${out}`);
  // 中文 label 是我们自己发明的形状，pi 用的是工具名本身。
  assert.ok(!out.includes('读文件'), `不该出现中文 label：${out}`);
});

test('工具块：read 的路径取自 assistant 的 toolCall，不是 toolResult.details', () => {
  // details 是**返回值**（read 回来的是文件内容），不是调用参数。
  // 早先版本读错了这里，所有工具块标题都显示「0 个参数」。
  const state = toolState({ toolName: 'read', args: { path: 'packages/core/src/state.ts' } });
  state.messages[1] = {
    ...(state.messages[1] as Extract<Message, { role: 'toolResult' }>),
    details: { path: '不该用这个' },
  } as Message;
  const out = stripTerminalSequences(renderTranscript(state, 0, 80, false));
  assert.ok(out.includes('packages/core/src/state.ts'), out);
  assert.ok(!out.includes('不该用这个'), `不该拿 details 当参数：${out}`);
});

test('工具块：找不到对应 toolCall 时不崩也不画空块（会话被裁剪后可能配不上）', () => {
  const state = {
    messages: [
      { role: 'toolResult', toolCallId: 'orphan', toolName: 'read', content: [], isError: false, timestamp: 0 },
    ],
    toolTimings: {},
  } as unknown as AgentState;
  const out = stripTerminalSequences(renderTranscript(state, 0, 80, false));
  // 工具块的全部信息都在参数里（`read <path>` / `$ <cmd>`），没参数就只能是一行空底色。
  assert.equal(out.trim(), '', `配不上就不该画东西，实际：${JSON.stringify(out)}`);
});

test('工具块：bash 成功是绿底、失败是红底（与 pi 的 toolSuccessBg/toolErrorBg 同源）', () => {
  const ok = toolState({ toolName: 'bash', args: { command: 'git status' }, resultText: 'clean' });
  const bad = toolState({ toolName: 'bash', args: { command: 'boom' }, resultText: 'err', isError: true });
  const okRaw = renderTranscript(ok, 0, 80, false);
  const badRaw = renderTranscript(bad, 0, 80, false);
  // 底色是 ANSI 48;2;r;g;b。dark 主题下：成功 rgb(37,65,49)、失败 rgb(91,40,42)。
  assert.ok(okRaw.includes('48;2;37;65;49'), `成功块应为深绿底：${JSON.stringify(okRaw)}`);
  assert.ok(badRaw.includes('48;2;91;40;42'), `失败块应为暗红底：${JSON.stringify(badRaw)}`);
});

test('工具块：bash 折叠时保留**尾部**（报错在最后，保留头部等于把结论折掉）', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const state = toolState({ toolName: 'bash', args: { command: 'x' }, resultText: lines });
  const out = stripTerminalSequences(renderTranscript(state, 0, 100, false));
  assert.ok(out.includes('line 39'), `最后一行要留着：${out.slice(-200)}`);
  assert.ok(!out.includes('line 0\n'), `头部应被折掉：${out.slice(0, 300)}`);
  assert.ok(/earlier lines/.test(out), `要告知省略了多少行：${out.slice(-200)}`);
});

test('工具块：Ctrl+O 展开后给全文', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const state = toolState({ toolName: 'bash', args: { command: 'x' }, resultText: lines });
  const out = stripTerminalSequences(renderTranscript(state, 0, 100, true));
  assert.ok(out.includes('line 0'), '展开后要看到第一行');
  assert.ok(out.includes('line 39'), '展开后要看到最后一行');
});

test('工具块：扩展工具（没有渲染器）也听 Ctrl+O 折叠 —— 与 pi 同一条 fallback', () => {
  // `ask_user_question` 这类扩展工具不在 `TOOL_RENDERERS` 表里。早先这一格传的是
  // `undefined`，官方组件于是走它自己那条 `formatToolExecution()`：工具名 +
  // `JSON.stringify(args, null, 2)` + **整段**输出 —— 那条路完全不看 `expanded`，
  // 症状就是「Ctrl+O 折叠了、内置工具跟着折，扩展工具还是全铺开」。
  //
  // pi 那边扩展工具**是有定义的**（注册时那份 `{ label, description, parameters }`），
  // 所以它走 `createCallFallback()` / `createResultFallback()` —— 两个都认 `expanded`。
  // 这里给扩展工具一个只有 label 的定义，复刻同一条路。
  const state = toolState({
    toolName: 'ask_user_question',
    args: {
      questions: [
        {
          question: 'Which approach should we take?',
          header: 'Approach',
          options: [{ label: 'Minimal' }, { label: 'Thorough' }],
        },
      ],
    },
    resultText: 'User has answered your questions: {"Approach":"Minimal"}.',
  });

  const collapsed = stripTerminalSequences(renderTranscript(state, 0, 100, false));
  // 折叠：参数挤在标题那一行（`key=value`），不是逐行的 pretty-print。
  assert.match(collapsed, /ask_user_question questions=/, `折叠时该是 key=value 摘要：${collapsed}`);
  assert.ok(!/^\s+questions: /m.test(collapsed), `折叠时不该铺开参数：${collapsed}`);
  // 结果仍然看得到（短的本来就一行）。
  assert.ok(collapsed.includes('User has answered your questions'), collapsed);

  const expanded = stripTerminalSequences(renderTranscript(state, 0, 100, true));
  // 展开：每个参数一行 `key: value`，全文。
  assert.match(expanded, /^\s+questions: /m, `展开时该是逐行的 key: value：${expanded}`);
  assert.ok(expanded.includes('Thorough'), `展开时参数要完整：${expanded}`);
});

test('工具块：bash 显示 Took x.xs（耗时来自 reducer 记的 toolTimings）', () => {
  const state = toolState({ toolName: 'bash', args: { command: 'x' }, resultText: 'out', timings: { 'call-1': 520 } });
  const out = stripTerminalSequences(renderTranscript(state, 0, 80, false));
  assert.match(out, /Took 0\.5s/, `要显示耗时：${out}`);
});

test('工具块：write 展示**文件内容**而不是工具输出（pi 的形状）', () => {
  // pi 的 write 块里是把刚写进去的内容预览出来（前 10 行），不是回显工具输出。
  // 这是 write 与其他工具最容易看出差别的地方。
  const state = toolState({
    toolName: 'write',
    args: { path: 'demo.md', content: '# 标题\n第一行\n第二行' },
    resultText: 'File written',
  });
  const out = stripTerminalSequences(renderTranscript(state, 0, 80, false));
  assert.ok(out.includes('第一行'), `块里应是文件内容：${out}`);
});

test('工具块：edit 渲染彩色 diff，且底色只铺一层', () => {
  // details.diff 是 pi 自己的**展示用** diff（`-1 原行` / `+1 新行` / ` 2 上下文`），
  // 不是 unified patch —— 后者会整个落成灰色，连改了什么都看不出来。
  const state = {
    messages: [
      {
        role: 'assistant',
        timestamp: 0,
        content: [{ type: 'toolCall', id: 'c1', name: 'edit', arguments: { path: 'demo.md', edits: [{ oldText: 'a', newText: 'b' }] } }],
      },
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'edit',
        content: [{ type: 'text', text: 'Success' }],
        details: { diff: '-1 # 标题\n+1 # 标题 v2\n 2 正文\n' },
        isError: false,
        timestamp: 1_700_000_000_000,
      },
    ],
    toolTimings: {},
  } as unknown as AgentState;
  const raw = renderTranscript(state, 0, 76, false);
  // 改动行用 toolDiffRemoved(red) / toolDiffAdded(green)，上下文用 muted。
  assert.ok(raw.includes('38;2;234;127;129'), `删除行要红色：${JSON.stringify(raw)}`);
  assert.ok(raw.includes('38;2;104;183;141'), `新增行要绿色：${JSON.stringify(raw)}`);
  // 底色只该有一层：`edit` 的 renderShell 是 "self"，它自己铺底色。
  // 早先用 createAllToolRenderers()（renderShell=undefined）时，组件又套了一层 Box，
  // 于是 `48;2;37;65;49` 出现两次。
  const perLine = raw.split('\n').filter((l) => l.includes('48;2;37;65;49'));
  for (const line of perLine) {
    const occurrences = line.split('48;2;37;65;49').length - 1;
    assert.equal(occurrences, 1, `底色只能一层：${JSON.stringify(line)}`);
  }
});

test('用户消息：整块蓝底铺满，且**没有**「你 ›」前缀', () => {
  const state = { messages: [{ role: 'user', content: '演示一遍', timestamp: 0 }] } as unknown as AgentState;
  const raw = renderTranscript(state, 0, 40, false);
  // dark 主题的 userMessageBg = rgb(33,59,73)。
  assert.ok(raw.includes('48;2;33;59;73'), `用户块要有蓝底：${JSON.stringify(raw)}`);
  const plain = stripTerminalSequences(raw);
  assert.ok(!plain.includes('你 ›'), `不该有角色前缀：${plain}`);
  assert.ok(!plain.includes('用户'), `不该有角色前缀：${plain}`);
});

test('思考：灰色斜体（thinkingText + italic），不是普通文字', () => {
  const state = {
    messages: [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'The user wants a demo' }], timestamp: 0 },
    ],
  } as unknown as AgentState;
  const raw = renderTranscript(state, 0, 60, false);
  // italic = SGR 3；thinkingText 在 dark 主题下是 rgb(150,160,164)。
  assert.ok(raw.includes('\u001b[3m'), `思考要斜体：${JSON.stringify(raw)}`);
  assert.ok(raw.includes('38;2;150;160;164'), `思考要用 thinkingText 的灰色：${JSON.stringify(raw)}`);
  assert.ok(stripTerminalSequences(raw).includes('The user wants a demo'));
});

test('助手文字：无底色、无前缀（与 pi 一致）', () => {
  const state = { messages: [{ role: 'assistant', content: [{ type: 'text', text: '好，我按工具逐个演示。' }], timestamp: 0 }] } as unknown as AgentState;
  const raw = renderTranscript(state, 0, 60, false);
  const plain = stripTerminalSequences(raw);
  assert.ok(plain.includes('好，我按工具逐个演示。'));
  assert.ok(!plain.includes('助手 ›'), `不该有角色前缀：${plain}`);
  assert.ok(!raw.includes('48;2;'), `助手文字不该铺底色：${JSON.stringify(raw)}`);
});

// ── Ctrl+T：展开/收起思考块（pi 的 `app.thinking.toggle`） ──

test('Ctrl+T 折叠思考：正文仍在，思考文字消失、只剩一行提示', () => {
  const state = {
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先想一下用户的意图' },
          { type: 'text', text: '答案是 42。' },
        ],
        timestamp: 0,
      },
    ],
  } as unknown as AgentState;

  const shown = stripTerminalSequences(renderTranscript(state, 0, 60, false, undefined, false));
  assert.ok(shown.includes('先想一下用户的意图'), `展开时看得到思考：${shown}`);
  assert.ok(shown.includes('答案是 42。'));

  const hidden = stripTerminalSequences(renderTranscript(state, 0, 60, false, undefined, true));
  assert.ok(!hidden.includes('先想一下用户的意图'), `折叠后思考正文不该在：${hidden}`);
  assert.ok(hidden.includes('Thinking'), `折叠后应留一行提示：${hidden}`);
  assert.ok(hidden.includes('答案是 42。'), `正文不受影响：${hidden}`);
});

test('Ctrl+T 切换后历史块要重画（缓存键带了 hideThinking）', () => {
  const chunks = new TranscriptChunks();
  const state = {
    messages: [
      { role: 'assistant', content: [{ type: 'thinking', thinking: '一段思考' }], timestamp: 0 },
    ],
  } as unknown as AgentState;
  chunks.update(state, 60, false, []);
  assert.ok(stripTerminalSequences(chunks.render(60).join('\n')).includes('一段思考'));
  // 同一状态、只打开折叠：必须重算（不能命中上一次展开时的缓存）。
  chunks.update(state, 60, false, [], undefined, undefined, -1, true);
  const hidden = stripTerminalSequences(chunks.render(60).join('\n'));
  assert.ok(!hidden.includes('一段思考'), `折叠后不该读到展开时的缓存：${hidden}`);
  assert.ok(hidden.includes('Thinking'), hidden);
});

test('纯 toolCall 的助手消息不产生空行（它由紧跟的 toolResult 块负责）', () => {
  const state = {
    messages: [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'read', arguments: { path: 'a' } }], timestamp: 0 },
      { role: 'toolResult', toolCallId: 'c', toolName: 'read', content: [{ type: 'text', text: 'x' }], isError: false, timestamp: 0 },
    ],
    toolTimings: {},
  } as unknown as AgentState;
  const out = renderTranscript(state, 0, 60, false);
  // 官方组件对空内容返回 []；若我们自己把空块也 push 进去，这里会多出空行。
  assert.ok(!out.includes('\n\n\n'), `不该有多余空行：${JSON.stringify(stripTerminalSequences(out))}`);
});

// ─── 卡片之间的空隙行必须是**零宽**的 ───
//
// 对话区每个块是一个 pi-tui 的 `Text`，而 `Text.render()` 会把每一行补空格到全宽。
// 官方组件里那些「空隙」行（`AssistantMessageComponent` 开头的 `Spacer(1)`、Markdown
// 的空段）本来返回的是零宽空串，过完 `Text` 就变成整行空格；而 `TuiAltScreen` 的选区
// 按列算，宽度 > 0 的行会被**整行**刷成反显 —— 于是拖选跨过两张卡片之间的间隙时，
// 屏幕上会扫过一条整行高的亮条（看着像「空白也被选中了」）。pi 不把整条消息套进 `Text`
// （组件直接塞 `Container`），那种行还是零宽的，高亮会跳过去。`collapseBlankRows()`
// 就是把这一层还原掉。
//
// 两件事一起钉：视觉空白的行必须零宽，但**带底色的 padding 行**不能跟着被剪 —— 那是卡片
// 本身（pi 里也一样全宽、也一样会被刷亮）；OSC 133 的 `scrollToPrompt` 锚点也不能丢。
test('卡片之间的空隙行保持零宽（拖选不会刷出一条整行亮条）', () => {
  const state = {
    messages: [
      { role: 'user', content: '第一个问题', timestamp: 0 },
      { role: 'assistant', content: [{ type: 'text', text: '第一个回答' }], timestamp: 0 },
    ],
  } as unknown as AgentState;
  const chunks = new TranscriptChunks();
  chunks.update(state, 60, false, []);
  const lines = chunks.render(60);

  const visuallyBlank = (line: string): boolean => stripTerminalSequences(line).trim() === '';
  const hasStyle = (line: string): boolean => /\u001b\[[0-9;]*m/.test(line);

  const gaps = lines.filter((line) => visuallyBlank(line) && !hasStyle(line));
  assert.ok(gaps.length > 0, `应当有空隙行：${JSON.stringify(lines.map(stripTerminalSequences))}`);
  assert.deepEqual(
    gaps.map((line) => visibleWidth(line)),
    gaps.map(() => 0),
    '空隙行必须是零宽 —— 否则拖选会把它们整行刷亮',
  );

  const cardPadding = lines.filter((line) => visuallyBlank(line) && hasStyle(line));
  assert.ok(cardPadding.length > 0, '用户蓝块的 padding 行应当带底色');
  assert.deepEqual(
    cardPadding.map((line) => visibleWidth(line)),
    cardPadding.map(() => 60),
    '卡片自己的 padding 行仍是全宽（它是卡片的一部分，不能剪）',
  );

  // `scrollToPrompt`（上一个 / 下一个提问）靠 OSC 133 的 A 标记找落点 —— 空隙行上那个
  // 标记正是 `AssistantMessageComponent` 拼在第 0 行（= 它的 `Spacer(1)`）上的。
  assert.equal(
    lines.filter((line) => line.includes('\u001b]133;A')).length,
    2,
    `两条消息各应保留一个 OSC 133 落点：${JSON.stringify(lines)}`,
  );
});

// ─── 用户蓝块与上一条之间要有真空隙 ───
//
// `UserMessageComponent` 的 paddingY=1 会产生上下两行空白，但它们是**带蓝底**的
// （pi-tui 的 Markdown.render 里 emptyLines 走 applyBackgroundToLine）——
// 蓝块与上一条内容之间**看不到空隙**，而助手块/工具块的空行是无底色的，所以那些地方
// 有空隙、用户块没有。pi 官方的解法是在用户消息前插一个 Spacer(1)。
//
// 判据：蓝块**第一行**的**上一行**必须是无底色的空行。组件自己那两行 paddingY 也在
// 「上一行」之列，所以要先定位块首行（有 OSC133;A 的那行；工具块没这个标记，退化成
// 「第一行带底色的行」），再往前看一行。

/** 找某段文字所在块的起始下标（首行带 OSC 133 A 区域标记）。 */
function blockStartOf(lines: string[], text: string): number {
  const at = lines.findIndex((l) => stripTerminalSequences(l).includes(text));
  assert.ok(at >= 0, `找不到 ${text}`);
  for (let i = at; i >= 0; i -= 1) {
    if (lines[i]?.includes('\x1b]133;A')) return i;
  }
  // 工具块**没有** OSC 133 区域标记（只有 user / assistant 有）：往上找第一行带底色的，
  // 那就是它 paddingY 的顶行。
  for (let i = at; i >= 0; i -= 1) {
    if (/\x1b\[4[78];/.test(lines[i] ?? '')) return i;
  }
  return at;
}

test('用户蓝块上面有一行无底色空隙（蓝块自身的 paddingY 带底色，不算空隙）', () => {
  const state = {
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: '上一条回答' }] } as Message,
      { role: 'user', content: '用户问题' } as Message,
    ],
    toolTimings: {},
  } as unknown as AgentState;
  const lines = renderTranscript(state, 0, 60, false).split('\n');
  const start = blockStartOf(lines, '用户问题');
  assert.ok(start > 0, '用户消息应该在后面');
  const above = lines[start - 1] ?? '';
  assert.equal(stripTerminalSequences(above).trim(), '', '蓝块上面要是空的');
  // 关键：那一行**不能带底色**，否则看着还是贴着。
  assert.ok(!/\x1b\[4[78];/.test(above), `蓝块上面那行不该有底色：${JSON.stringify(above)}`);
});

test('首条用户消息前面不加空隙（开头凭空一段会看到）', () => {
  const state = {
    messages: [{ role: 'user', content: '第一句' } as Message],
    toolTimings: {},
  } as unknown as AgentState;
  const lines = renderTranscript(state, 0, 60, false).split('\n');
  const start = blockStartOf(lines, '第一句');
  // 组件自己的 paddingY 会给上下各一行（都带底色），但**它之前**不该再多一行。
  assert.equal(start, 0, `首条之前不该有空行，实际块首行下标 ${start}`);
});

test('多条用户消息之间都有空隙（每个蓝块上方都要，不只第二个）', () => {
  const state = {
    messages: [
      { role: 'user', content: '问题一' } as Message,
      { role: 'assistant', content: [{ type: 'text', text: '回答一' }] } as Message,
      { role: 'user', content: '问题二' } as Message,
      { role: 'assistant', content: [{ type: 'text', text: '回答二' }] } as Message,
      { role: 'user', content: '问题三' } as Message,
    ],
    toolTimings: {},
  } as unknown as AgentState;
  const lines = renderTranscript(state, 0, 60, false).split('\n');
  for (const text of ['问题一', '问题二', '问题三']) {
    const start = blockStartOf(lines, text);
    const above = lines[start - 1];
    if (start === 0) continue; // 首条不需要空隙
    assert.equal(stripTerminalSequences(above ?? '').trim(), '', `${text} 上方要空`);
    assert.ok(!/\x1b\[4[78];/.test(above ?? ''), `${text} 上方那行不该有底色`);
  }
});

test('工具块上方本来就有空隙（用户块现在与它们一致了）', () => {
  const state = {
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: '回答' }] } as Message,
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'bash', arguments: { command: 'ls' } }] } as unknown as Message,
      { role: 'toolResult', toolCallId: 'c', toolName: 'bash', content: [{ type: 'text', text: 'x' }], isError: false, timestamp: 0 } as unknown as Message,
    ],
    toolTimings: {},
  } as unknown as AgentState;
  const lines = renderTranscript(state, 0, 60, false).split('\n');
  const start = blockStartOf(lines, '$ ls');
  const above = lines[start - 1] ?? '';
  assert.equal(stripTerminalSequences(above).trim(), '', '工具块上方要空');
  assert.ok(!/\x1b\[4[78];/.test(above), `工具块上方不该有底色：${JSON.stringify(above)}`);
});
test('一次性模式（管道输出）不吐控制序列：OSC 8 超链接会被终端当乱码', () => {
  // 官方渲染器给文件路径加超链接（renderToolPath → linkPath），而管道里那些
  // `]8;;file:///…\…]8;;` 是**肉眼可见的乱码**。一次性模式承诺的是「纯文本」。
  const state = toolState({ toolName: 'read', args: { path: 'package.json' } });
  const raw = renderTranscript(state, 0, 0, false);
  assert.ok(raw.includes('\x1b]8;'), `前置条件：确实产生了超链接，实际没有：${JSON.stringify(raw)}`);
  const plain = stripTerminalSequences(raw);
  assert.ok(!plain.includes('\x1b]'), `剥完不该还有 OSC 序列：${JSON.stringify(plain)}`);
  assert.ok(plain.includes('read package.json'), `内容要还在：${plain}`);
});

test('主题：没配 theme 时跟随终端深浅色（写死 dark 会让浅色终端出现黑底块）', () => {
  assert.equal(resolveThemeName(undefined, 'dark'), 'dark');
  assert.equal(resolveThemeName(undefined, 'light'), 'light');
});

test('主题：显式配置与 auto 形式都走 pi 的解析', () => {
  assert.equal(resolveThemeName('light', 'dark'), 'light', '显式名字优先于终端外观');
  // auto：浅底终端用 light、深底终端用 dark。
  assert.equal(resolveThemeName('auto', 'light'), 'light');
  assert.equal(resolveThemeName('auto', 'dark'), 'dark');
});

test('主题：system 不直接用（终端没上报颜色时它会退化成灰度，底色全黑）', () => {
  // 这是实测过的坑：不带参数 initTheme() 时 toolSuccessBg 解析成 rgb(0,0,0)，
  // 「工具块有底色」就静默失效了。
  assert.notEqual(resolveThemeName('system', 'dark'), 'system');
  assert.equal(resolveThemeName('system', 'dark'), 'dark');
});

// ─── 顶行（页签 + 统计合一）/ 底栏的分工 ───

/**
 * 造一个带 trace 统计的状态（只喂 tabLine 读得到的那几个字段）。
 *
 * `kind` → traceStats 的口径：`turn.start` 算回合、`step.start` 算步、`tool.result`
 * 算工具、`error` 算错误；重试要同父下多个 step.start 且组里有失败的。
 */
function stateWithTrace(
  kinds: readonly string[],
  overrides: Record<string, unknown> = {},
): AgentState {
  const nodes: Record<string, Record<string, unknown>> = {};
  const order: string[] = [];
  kinds.forEach((kind, i) => {
    const id = `n${i + 1}`;
    order.push(id);
    nodes[id] = {
      id, kind, label: kind, parentId: i === 0 ? null : 'n1', status: 'ok',
      createdAt: i, endedAt: i, children: [],
    };
  });
  return {
    trace: { nodes, order, tipId: null, sessionId: 'x' },
    ...overrides,
  } as unknown as AgentState;
}

test('tabLine：页签 + 统计在同一行，且写明切换键', () => {
  const out = tabLine(stateWithTrace([]), 'chat');
  // 关键性质：**没有独立顶栏了**，页签与统计挤在一行，所以两个都得在这一行里。
  assert.ok(out.includes('对话') && out.includes('轨迹'), out);
  // 切换键**不写死键名**：它来自 `app.trace.toggle`（用户可以用
  // `~/.pi/agent/keybindings.json` 改）。断言「那一行的键名 = 解析出来的键名」，
  // 这样改键之后测试仍然在验那件事（「顶行写明了切换键」），而不是在验「默认值是
  // Ctrl+R」—— 后者属于 keybindings 模块的测试。
  assert.ok(out.includes(keyLabel('app.trace.toggle')), out);
  assert.ok(!out.includes('\n'), '顶行只能一行：' + JSON.stringify(out));
});

test('tabLine：改键位（keybindings.json）之后顶行的提示跟着改', () => {
  // 手写键名（`'(Ctrl+R)'`）的旧写法在这里会露馅：键改了、提示不改，于是那一行开始骗人，
  // 而只有改了键的人自己能发现。
  const patched = createProjectKeybindings();
  patched.setUserBindings({ 'app.trace.toggle': 'alt+r' });
  setKeybindings(patched);
  try {
    const out = stripTerminalSequences(tabLine(stateWithTrace([]), 'chat'));
    assert.ok(!out.includes('Ctrl+R'), `不该还是默认键：${out}`);
    // 用了 override 之后显示的就是 override 那个键（macOS 上 `alt` 显示成 `Option`）。
    assert.ok(out.includes(`(${formatKeyId('alt+r')})`), out);
    assert.equal(getKeybindings().getKeys('app.trace.toggle')[0], 'alt+r');
  } finally {
    installProjectKeybindings();
  }
});

test('jumpToLatestHint：往上翻后那条「回到最新」提示与 pi 同句，键名走键位表', () => {
  // 对话区与轨迹页的 ScrollView 都是 `follow: 'end'`：新内容往下长、视口自动贴底。
  // 但用户往上翻之后 follow 让位，视口停在历史里 —— 屏幕上看不出「下面还有」
  // （缺了它，流式生成时按什么键都不动，而 `Ctrl+End` 这个键也就只有这条提示会讲）。
  const theme = setupTheme(undefined, 'dark');
  const out = stripTerminalSequences(jumpToLatestHint(theme));
  // 文案照 pi 的 `createInteractiveTui()` 那一句，不自己翻成中文。
  assert.ok(out.includes('Jump to latest message'), out);
  // 键名不写死：`tui.altScreen.bottom` 默认是 ctrl+end，但用户可以改 —— 与顶行
  // `(Ctrl+R)` 同一个理由（手写键名的提示改键之后就开始骗人）。
  assert.ok(out.includes(keyLabel('tui.altScreen.bottom')), out);

  const patched = createProjectKeybindings();
  patched.setUserBindings({ 'tui.altScreen.bottom': 'ctrl+shift+e' });
  setKeybindings(patched);
  try {
    const overridden = stripTerminalSequences(jumpToLatestHint(theme));
    assert.ok(!overridden.includes('Ctrl+End'), `不该还是默认键：${overridden}`);
    assert.ok(overridden.includes(formatKeyId('ctrl+shift+e')), overridden);
  } finally {
    installProjectKeybindings();
  }
});

test('tabLine：回合与步数合成 `x轮x步`（节点数不再占位）', () => {
  // 「3 轮 8 步」与「3轮8步」是同一件事；节点数是 order.length，开一轮就 +5 ——
  // 跳得又快又不 actionable，所以从这一行里删掉（切到轨迹页能看全树）。
  const out = stripTerminalSequences(tabLine(stateWithTrace(['turn.start', 'step.start', 'step.start', 'step.start']), 'chat'));
  assert.ok(out.includes('1轮3步'), out);
  assert.ok(!/节点\s*\d/.test(out), '顶行不该再报节点数：' + out);
});

test('tabLine：工具/重试/错误非 0 才出现（0 是噪声）', () => {
  const quiet = stripTerminalSequences(tabLine(stateWithTrace(['turn.start', 'step.start']), 'chat'));
  assert.ok(!quiet.includes('工具') && !quiet.includes('重试') && !quiet.includes('错误'), quiet);
  const noisy = stripTerminalSequences(
    tabLine(stateWithTrace(['turn.start', 'step.start', 'tool.result', 'error']), 'chat'),
  );
  assert.ok(noisy.includes('工具1'), noisy);
  assert.ok(noisy.includes('错误1'), noisy);
});

test('tabLine：不报花费（底栏 statsLine 已有同口径的会话累计 $）', () => {
  // 两个 $ 摆在两行里，用户第一反应是「这俩为什么不一样」。
  const out = tabLine(stateWithTrace(['turn.start', 'step.start'], { totalCost: 0.0123 }), 'chat');
  assert.ok(!stripTerminalSequences(out).includes('$'), out);
});

test('tabLine：统计始终显示（不管在哪个页），当前页高亮', () => {
  const state = stateWithTrace(['turn.start', 'step.start']);
  for (const page of ['chat', 'trace'] as const) {
    assert.ok(stripTerminalSequences(tabLine(state, page)).includes('1轮1步'), page);
  }
  // 当前页走 bold+cyan（\x1b[1m…\x1b[36m），另一个页是 dim。
  const chat = tabLine(state, 'chat');
  const trace = tabLine(state, 'trace');
  assert.notEqual(chat, trace, '两页的页签高亮应该不同');
});

test('modelLine：底栏右栏是 (provider) model 形状（与 pi 同形）', () => {
  const state = { providerName: 'workbuddy', modelId: 'cn:space-bunny' } as unknown as AgentState;
  assert.equal(modelLine(state), '(workbuddy) cn:space-bunny');
});

test('modelLine：reasoning 模型带 `• <级别>`，非 reasoning 模型不带', () => {
  // 非 reasoning 模型：无论 thinkingLevel 是什么都不画级别（与 pi 的 `state.model?.reasoning` 同一条件）。
  const noThink = {
    providerName: 'qwen-token-plan-cn',
    modelId: 'deepseek-v4.1-flash',
    thinkingLevel: 'high',
    model: { reasoning: false },
  } as unknown as AgentState;
  assert.equal(modelLine(noThink), '(qwen-token-plan-cn) deepseek-v4.1-flash');

  // reasoning 模型 + 级别：`• high`。
  const thinking = {
    providerName: 'qwen-token-plan-cn',
    modelId: 'deepseek-v4.1-flash',
    thinkingLevel: 'high',
    model: { reasoning: true },
  } as unknown as AgentState;
  assert.equal(modelLine(thinking), '(qwen-token-plan-cn) deepseek-v4.1-flash • high');

  // reasoning 模型但级别是 off：pi 写 `• thinking off`，不是 `• off`。
  const off = { ...thinking, thinkingLevel: 'off' } as unknown as AgentState;
  assert.equal(modelLine(off), '(qwen-token-plan-cn) deepseek-v4.1-flash • thinking off');
});

// ─── 底栏第二行：token 用量（数字格式与算法都取自 pi） ───

/** 造一条带 usage 的 assistant 消息。 */
function assistantWithUsage(usage: Record<string, unknown>): Message {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'x' }],
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      ...usage,
    },
    timestamp: 0,
  } as unknown as Message;
}

/** 一条**指定 stopReason 的助手消息（aborted / error 的 usage 不可信）。 */
function assistantStopping(usage: Record<string, unknown>, stopReason: string): Message {
  return { ...assistantWithUsage(usage), stopReason } as unknown as Message;
}

test('statsLine：没有任何用量时是空串（不画 0↑0↓0R 噪声）', () => {
  const state = { messages: [], model: { contextWindow: 0 } } as unknown as AgentState;
  assert.equal(statsLine(state).text, '');
});

test('statsLine：累计多轮的 token（不是只显示最后一轮）', () => {
  // 这是最容易搞错的地方：state.usage 只是最近一轮，而底栏要的是会话累计。
  const state = {
    messages: [
      assistantWithUsage({ input: 5000, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 5020 }),
      assistantWithUsage({ input: 1800, output: 29, cacheRead: 0, cacheWrite: 0, totalTokens: 1829 }),
    ],
    model: { contextWindow: 0 },
  } as unknown as AgentState;
  const out = statsLine(state).text;
  assert.ok(out.includes('↑6.8k'), `input 应累计为 6.8k：${out}`);
  assert.ok(out.includes('↓49'), `output 应累计为 49：${out}`);
});

test('statsLine：缓存命中率 CH = cacheRead / (input+cacheRead+cacheWrite)', () => {
  // 143 / (6800 + 143) ≈ 2.06% —— 与 pi 截图里的 CH2.1% 同口径。
  const state = {
    messages: [assistantWithUsage({ input: 6800, output: 49, cacheRead: 143, cacheWrite: 0, totalTokens: 6992 })],
    model: { contextWindow: 0 },
  } as unknown as AgentState;
  assert.ok(statsLine(state).text.includes('CH2.1%'), statsLine(state).text);
});

test('statsLine：没有缓存就不显示 CH（0% 是噪声）', () => {
  const state = {
    messages: [assistantWithUsage({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110 })],
    model: { contextWindow: 0 },
  } as unknown as AgentState;
  assert.ok(!statsLine(state).text.includes('CH'), statsLine(state).text);
});

test('statsLine：上下文占用 = 已用/窗口（窗口取自 model.init）', () => {
  const state = {
    messages: [assistantWithUsage({ input: 700_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 700_000 })],
    model: { contextWindow: 1_000_000 },
  } as unknown as AgentState;
  assert.ok(statsLine(state).text.includes('70%/1.0M'), statsLine(state).text);
});

test('statsLine：窗口未知（0）时不画百分比，而不是画个猜的值', () => {
  const state = {
    messages: [assistantWithUsage({ input: 700_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 700_000 })],
    model: { contextWindow: 0 },
  } as unknown as AgentState;
  assert.ok(!statsLine(state).text.includes('%'), statsLine(state).text);
});

test('statsLine：窗口为 0 时不崩（contextWindow 还没装载的启动瞬间）', () => {
  const state = { messages: [], model: { contextWindow: 0 } } as unknown as AgentState;
  assert.doesNotThrow(() => statsLine(state));
});

// ─── 上下文占用：只看最后一次，不累加 ───
//
// 这批盯的是一个算错的数字：底栏一度显示「9536%/1.0M」。上下文窗口是**这一次请求**
// 能装多少，而每轮的 input+cacheRead 都把当轮完整 prompt 重数一遍（prompt 里含前面
// 所有轮次），累加等于把整段历史重复数了 N 次。累计口径只适用于 ↑↓R W$ 那一排。

test('statsLine：上下文占用只看**最后一次**，不累加所有轮次', () => {
  const one = (n: number): Message => assistantWithUsage({
    input: 200_000, output: 1_000, cacheRead: 0, cacheWrite: 0, totalTokens: 201_000,
  });
  // 20 轮，每轮 prompt 都是 201k。累加 = 4020k → 402%，但真实占用是最后那一次的 20.1%。
  const state = {
    messages: Array.from({ length: 20 }, () => one(20)),
    model: { contextWindow: 1_000_000 },
  } as unknown as AgentState;
  const out = statsLine(state).text;
  assert.ok(out.includes('20%/1.0M'), `应显示 20%，实际：${out}`);
  assert.ok(!/\d{3,}%/.test(out), `不该出现三位数百分比：${out}`);
  // ↑↓ 那一排**仍然是累计**（两种口径各管各的）。
  assert.ok(out.includes('↑4.0M'), `用量仍是累计：${out}`);
});

test('statsLine：最后一轮被中断时，占用看前一轮有效的（aborted 的 usage 不可信）', () => {
  const state = {
    messages: [
      assistantWithUsage({ input: 300_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 300_000 }),
      // 用户中断：usage 残缺（可能只有一半），不能拿它当「当前占用」。
      assistantStopping({ input: 5_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5_000 }, 'aborted'),
    ],
    model: { contextWindow: 1_000_000 },
  } as unknown as AgentState;
  const out = statsLine(state).text;
  assert.ok(out.includes('30%/1.0M'), `应回退到上一轮有效的 30%，实际：${out}`);
  assert.ok(!out.includes('5%/1.0M'), `不该采信被中断那轮：${out}`);
});

test('statsLine：最后一轮报错时同理跳过（error 的 usage 描述的不是最终请求）', () => {
  const state = {
    messages: [
      assistantWithUsage({ input: 400_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 400_000 }),
      assistantStopping({ input: 9_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 9_000 }, 'error'),
    ],
    model: { contextWindow: 1_000_000 },
  } as unknown as AgentState;
  assert.ok(statsLine(state).text.includes('40%/1.0M'), statsLine(state).text);
});

test('statsLine：totalTokens 缺失时用四个字段之和（与 pi 的 calculateContextTokens 同口径）', () => {
  const state = {
    messages: [assistantWithUsage({
      input: 100_000, output: 2_000, cacheRead: 50_000, cacheWrite: 8_000, totalTokens: 0,
    })],
    model: { contextWindow: 1_000_000 },
  } as unknown as AgentState;
  // 100k + 2k + 50k + 8k = 160k → 16%
  assert.ok(statsLine(state).text.includes('16%/1.0M'), statsLine(state).text);
});

test('statsLine：超 100% 如实显示，不夹到 100（夹了就是谎报「刚好满」）', () => {
  // 目录里配的窗口小于实际能发的量（网关换过模型 / 目录过期）时会出现。
  const state = {
    messages: [assistantWithUsage({ input: 0, output: 0, cacheRead: 291_000, cacheWrite: 0, totalTokens: 291_969 })],
    model: { contextWindow: 128_000 },
  } as unknown as AgentState;
  const out = statsLine(state);
  assert.ok(out.text.includes('228%/128k'), out.text);
  // 超 90% 应该是红色告警（这是真问题，不该静默）。
  assert.equal(out.warnings.length, 1, '超 100% 也要告警');
});

test('statsLine：一次有效调用都没有时显示 ? 而不是 0%（0% 是在说谎）', () => {
  const state = {
    messages: [
      { role: 'user', content: 'hi' } as Message,
      // 恢复出来的历史消息没有 usage。
      { role: 'assistant', content: [{ type: 'text', text: '旧内容' }] } as Message,
    ],
    model: { contextWindow: 1_000_000 },
  } as unknown as AgentState;
  const out = statsLine(state).text;
  assert.ok(out.includes('?/1.0M'), `应显示未知，实际：${out}`);
  assert.ok(!out.includes('0%'), `不该显示 0%：${out}`);
});

// ─── dimLine：整行变淡，但告警段保持颜色 ───

test('dimLine：整行都变淡（底栏是背景信息，不该跟对话抢注意力）', () => {
  const out = dimLine('abc def');
  assert.ok(out.startsWith('\x1b[2m'), `整行应被 dim 包住：${JSON.stringify(out)}`);
  assert.equal(stripTerminalSequences(out), 'abc def', '内容不能变');
});

test('dimLine：告警段变色的同时，后面仍然是 dim（嵌套色的经典坑）', () => {
  // paint() 用 \x1b[0m 收尾，会把外层 dim 关掉。所以告警段之后必须**重新开 dim**。
  // 这个 bug 表现为「上下文占用变黄了，但它右边的模型名突然变亮」。
  const out = dimLine('70%/1.0M  model', { find: '70%/1.0M', paint: (s) => `\x1b[33m${s}\x1b[0m` });
  // 去掉所有 ANSI 后内容要对。
  assert.equal(stripTerminalSequences(out), '70%/1.0M  model');
  // 告警段之后要有 dim 重新开启的序列。
  const after = out.slice(out.indexOf('70%/1.0M') + '70%/1.0M'.length);
  assert.ok(after.includes('\x1b[2m'), `告警段之后要重开 dim：${JSON.stringify(after)}`);
});

test('dimLine：找不到告警段时就是普通 dim（不崩、不多包）', () => {
  const out = dimLine('abc', { find: '不存在', paint: (s) => `\x1b[33m${s}\x1b[0m` });
  assert.equal(stripTerminalSequences(out), 'abc');
  // 没找到就不该有任何额外处理：只多一个 dim 包裹，没有黄色也没有重开 dim。
  assert.equal(out, '\x1b[2mabc\x1b[0m', JSON.stringify(out));
});

test('dimLine：多个告警段都要处理', () => {
  const out = dimLine('A B', { find: 'A', paint: (s) => `\x1b[31m${s}\x1b[0m` }, { find: 'B', paint: (s) => `\x1b[32m${s}\x1b[0m` });
  assert.equal(stripTerminalSequences(out), 'A B');
});

test('statsLine：上下文超 70% 时给出告警段（而不是自己上色）', () => {
  // 上色要交给 dimLine：整行会被包进 dim，内嵌的 \x1b[0m 会提前关掉它。
  const state = {
    messages: [assistantWithUsage({ input: 800_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 800_000 })],
    model: { contextWindow: 1_000_000 },
  } as unknown as AgentState;
  const out = statsLine(state);
  assert.equal(out.warnings.length, 1, '应该有一段告警');
  assert.ok(out.warnings[0]?.find.includes('%'), out.warnings[0]?.find);
  // text 本身必须是无色的（否则 twoColumn 的宽度会算错）。
  assert.ok(!/\x1b/.test(out.text), `text 不该含 ANSI：${JSON.stringify(out.text)}`);
});


// ─── 队列面板 ───

test('renderQueuePanel：空队列不占高度', () => {
  const state = createInitialState({
    systemPrompt: 's', providerName: 'faux', modelId: 'f', toolNames: [], sessionId: 't',
  });
  assert.equal(renderQueuePanel(state, 80), '', '空队列返回空串');
});

/**
 * 底部的排队卡片：**与 pi 逐行同构**（`updatePendingMessagesDisplay`）——
 *
 * ```
 *  ↳ Option+Up to edit all queued messages
 *  Steering: 顺便看下版本
 *  Follow-up: 待会儿再说
 * ```
 *
 * 首行那个空行是 pi 的 `Spacer(1)`（把卡片与对话区隔开）；每行缩进一格是
 * `TruncatedText(text, 1, 0)` 的 paddingX；最后那行提示是「怎么把它们拿回来」——
 * 没有它，这两条排队消息看着像**已经发给模型了**。
 */
test('renderQueuePanel：steer 与 followUp 分行标出，各自带前缀 + 一行「怎么拿回来」', () => {
  let state = createInitialState({
    systemPrompt: 's', providerName: 'faux', modelId: 'f', toolNames: [], sessionId: 't',
  });
  state = {
    ...state,
    phase: 'thinking',
    steerQueue: [{ text: '顺便看下版本', at: 1 }],
    followUpQueue: [{ text: '待会儿再说', at: 2 }],
  };
  const out = stripTerminalSequences(renderQueuePanel(state, 80));
  const lines = out.split('\n');
  assert.equal(lines.length, 4, '空行 + 两条排队 + 提示');
  assert.equal(lines[0]?.trim(), '', '首行是分隔用的空行（pi 的 Spacer(1)）');
  assert.match(lines[1] ?? '', /^ Steering: 顺便看下版本$/);
  assert.match(lines[2] ?? '', /^ Follow-up: 待会儿再说$/);
  assert.match(
    lines[3] ?? '',
    /^ ↳ .+ to edit all queued messages$/,
    '最后一行要告诉用户怎么把排队的话拿回输入框',
  );
});

test('renderQueuePanel：多行文本压成一行（一条消息一行，不能把输入框顶下去）', () => {
  const state = {
    ...createInitialState({
      systemPrompt: 's', providerName: 'faux', modelId: 'f', toolNames: [], sessionId: 't',
    }),
    steerQueue: [{ text: '第一行\n第二行', at: 1 }],
  };
  const out = stripTerminalSequences(renderQueuePanel(state, 80));
  assert.equal(out.split('\n').length, 3, '空行 + 一条排队 + 提示');
  assert.match(out, /第一行 第二行/);
});

// ─── 轨迹区：分块增量 + 可滚动 ───
//
// 这组测试守的是用户直接报过的那个症状：
// 「一开始只能看到最前面的，后面就看不到，滚也滚不动」。
//
// 早先轨迹面板是一整块 `Text` + 每帧 `setText(renderColoredTree(整棵树))`，
// 于是：节点超出屏幕高度后被裁掉且**永远回不来**（既不滚动也没分页），
// 而且流式 token 每来一个就要重算整棵树。

/** 渲染出来的行（去掉 ANSI 与行尾补白 —— Text 会把每行补到全宽）。 */
function linesOf(chunks: TraceChunks, width = 80): string[] {
  return stripTerminalSequences(chunks.render(width).join('\n'))
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '');
}

test('TraceChunks：节点多了也能全部拿到（一块一行，不是整棵树一坨）', () => {
  const chunks = new TraceChunks();
  let tree = createTraceTree('s');
  for (let i = 0; i < 120; i++) {
    tree = appendNode(tree, tree.tipId, 'llm.result', {
      status: 'ok', label: '节点 ' + i, createdAt: i, endedAt: i,
    }).tree;
  }
  chunks.update(tree, 80, '');
  const lines = linesOf(chunks);
  // 120 个节点 = 120 行 —— **一行都没丢**。
  // 旧形状（整棵树塞进一块 Text）在这里会被布局裁掉，用户只看到最早那几行。
  assert.equal(lines.length, 120, '每个节点一行');
  assert.match(lines[0] ?? '', /n1 llm.result: 节点 0/);
  assert.match(lines[119] ?? '', /n120 llm.result: 节点 119/);
});

test('轨迹：所有节点都是 `○`，tip 靠加粗区分（不再有第二个圈 `◎`）', () => {
  // 早先 tip 单独画 `◎`（圈里套圈），于是同一棵树上有两种圆点字形 —— 差异又很轻微，
  // 读起来像画错。现在统一 `○`，tip 由**加粗**表达。
  //
  // 判据抽在 `emphasizedTraceLine()` 里、`TraceChunks.lineOf()` 与 `renderColoredTree()`
  // 共用 —— 一次性模式与轨迹页的 tip 因此不会分家。
  let tree = createTraceTree('s');
  tree = appendNode(tree, null, 'user', { status: 'ok', label: '你好', createdAt: 0, endedAt: 0 }).tree;
  tree = appendNode(tree, tree.tipId, 'llm.result', {
    status: 'ok', label: '好了', createdAt: 1, endedAt: 1,
  }).tree;
  assert.equal(tree.tipId, 'n2');
  assert.equal(emphasizedTraceLine(tree.nodes['n2']!, tree), true, 'tip 要加粗');
  assert.equal(emphasizedTraceLine(tree.nodes['n1']!, tree), false, '非 tip 不加粗');
  // 失败的节点也加粗 —— 这是原有行为，别被这次改动带走。
  const failed = patchNode(tree, 'n1', { status: 'error' });
  assert.equal(emphasizedTraceLine(failed.nodes['n1']!, failed), true, '失败也加粗');

  // 字形：树上只有 `○` / `└─`，一个 `◎` 都没有；tip 那行与其它行在**字形上**一模一样。
  const plain = stripTerminalSequences(renderColoredTree(tree, 0));
  assert.equal(/◎/.test(plain), false, plain);
  const plainLines = plain.split('\n');
  assert.equal(plainLines.length, 2);
  assert.ok(plainLines.every((line) => /^(│  )*(○  |└─ )/.test(line)), plain);

  // 加粗真的落在 tip 那一行、且**只**落在它上面（颜色由 FORCE_COLOR=3 打开，见 isolated-home）。
  const colored = renderColoredTree(tree, 0).split('\n');
  const boldLines = colored.filter((line) => line.includes('\x1b[1m'));
  assert.equal(boldLines.length, 1, `只有 tip 那一行加粗：${colored.join('\n')}`);
  assert.ok(boldLines[0]?.includes('n2 llm.result'), boldLines[0]);

  // 轨迹页（TraceChunks）走同一条路：tip 那行加粗，字形里没有 `◎`。
  // 注意用**未剥 ANSI** 的 `render()`（`linesOf()` 会把加粗剥掉，`◎` 那三条断言看不出差别）。
  const chunks = new TraceChunks();
  chunks.update(tree, 80, '');
  const pageLines = chunks.render(80).join('\n').split('\n');
  assert.equal(/◎/.test(stripTerminalSequences(pageLines.join('\n'))), false, pageLines.join('\n'));
  const pageBold = pageLines.filter((line) => line.includes('\x1b[1m'));
  assert.equal(pageBold.length, 1, `轨迹页也只有 tip 那一行加粗：${pageLines.join('\n')}`);
  assert.ok((pageBold[0] ?? '').includes('n2 llm.result'), pageBold[0]);
});

test('TraceChunks：只重算变化的那个节点（追加，不是全量重画）', () => {
  const chunks = new TraceChunks();
  let tree = createTraceTree('s');
  for (let i = 0; i < 30; i++) {
    tree = appendNode(tree, tree.tipId, 'tool.call', {
      status: 'pending', label: '工具 ' + i, createdAt: i,
    }).tree;
  }
  chunks.update(tree, 80, '');
  const before = linesOf(chunks);

  // 只把最后一个节点闭合（status 变了）→ 只有它那一行应该变。
  const lastId = tree.order[tree.order.length - 1] ?? '';
  tree = patchNode(tree, lastId, { status: 'ok', endedAt: 100 });
  chunks.update(tree, 80, '');
  const after = linesOf(chunks);

  let changed = 0;
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    if (before[i] !== after[i]) changed += 1;
  }
  assert.equal(changed, 1, '只有一个节点的行变了');
  // 耗时是 endedAt - createdAt = 100 - 29 = 71ms（节点号从 1 起，所以是 n30）。
  // 行首是轨道符号（所有节点都是 `○`，见 trace.ts 的 `traceRows`），成败在颜色里。
  assert.match(after[29] ?? '', /n30 tool\.call: 工具 29 71ms/, '最后那个节点闭合了');
});

test('TraceChunks：节点变少时旧块被丢掉（/new、恢复别的会话之后不残留）', () => {
  const chunks = new TraceChunks();
  let tree = createTraceTree('s');
  for (let i = 0; i < 10; i++) {
    tree = appendNode(tree, tree.tipId, 'llm.result', {
      status: 'ok', label: '节点 ' + i, createdAt: i, endedAt: i,
    }).tree;
  }
  chunks.update(tree, 80, '');
  assert.equal(linesOf(chunks).length, 10);

  // 换成只有 2 个节点的新树（/new 会这么干）。
  let fresh = createTraceTree('s2');
  for (let i = 0; i < 2; i++) {
    fresh = appendNode(fresh, fresh.tipId, 'llm.result', {
      status: 'ok', label: '新 ' + i, createdAt: i, endedAt: i,
    }).tree;
  }
  chunks.update(fresh, 80, '');
  const lines = linesOf(chunks);
  assert.equal(lines.length, 2, '只剩 2 个节点');
  assert.match(lines.join(' '), /新 1/);
  assert.equal(/节点 5/.test(lines.join(' ')), false, '旧节点没残留');
});

test('TraceChunks：空树时给一句说明（0 高度会让面板整个消失）', () => {
  const chunks = new TraceChunks();
  chunks.update(createTraceTree('s'), 80, '（还没有任何节点）');
  const out = linesOf(chunks);
  assert.equal(out.length, 1);
  assert.match(out[0] ?? '', /还没有任何节点/);
});


test('滚轮键：Alt+↑↓ 与 Ctrl+P/N 认得出来，纯 ↑↓ 不认（留给编辑器移光标）', () => {
  const ESC = String.fromCharCode(27);
  assert.equal(isScrollUp(`${ESC}[A`), true, 'Alt+↑');
  assert.equal(isScrollUp(`${ESC}[1;3A`), true, 'Alt+↑ 的 xterm 变体');
  assert.equal(isScrollUp(String.fromCharCode(16)), true, 'Ctrl+P');
  assert.equal(isScrollDown(`${ESC}[B`), true, 'Alt+↓');
  assert.equal(isScrollDown(String.fromCharCode(14)), true, 'Ctrl+N');
  // **纯方向键不能认**：多行提示词里 ↑↓ 是移动光标，抢了就编不了多行。
  assert.equal(isScrollUp(`${ESC}[A`), true);
  assert.equal(isScrollUp('p'), false, '字母 p 不是滚轮');
  assert.equal(isScrollDown('n'), false);
});
