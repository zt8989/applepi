import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import path from 'node:path';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { formatCwdForFooter } from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js';
import {
  cwdLine,
  dim,
  dimLine,
  modelLine,
  renderTranscript,
  statsLine,
  statusLine,
  twoColumn,
} from '../src/tui/app';
import { resolveThemeName, setupTheme } from '../src/tui/theme';
import type { AgentState } from '../src/state';
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
 * 从 `../src/tui/app` 直接导入（而不是经 `src/index.ts`）：这些是 TUI 的实现细节，
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
  // D: 盘肯定不在 C:\Users\... 之下（除非有人把 home 设成 D 根）。
  const out = cwdLine(String.raw`D:\some\proj`, 'main');
  assert.ok(!out.startsWith('~'), `家目录之外不该缩成 ~：${out}`);
  assert.ok(out.includes('some'), out);
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

// 每帧都渲染一次，主题必须先装上（见 src/tui/theme.ts：没 initTheme 读 theme 会抛）。
setupTheme(undefined, 'dark');

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
  const state = toolState({ toolName: 'read', args: { path: 'src/state.ts' } });
  state.messages[1] = {
    ...(state.messages[1] as Extract<Message, { role: 'toolResult' }>),
    details: { path: '不该用这个' },
  } as Message;
  const out = stripTerminalSequences(renderTranscript(state, 0, 80, false));
  assert.ok(out.includes('src/state.ts'), out);
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

// ─── 顶栏 / 底栏的分工 ───

test('statusLine：顶栏只讲轨迹（模型信息已挪到底栏）', () => {
  const state = { trace: { nodes: {}, order: [], tipId: null, sessionId: 'x' } } as unknown as AgentState;
  const out = statusLine(state);
  assert.ok(out.includes('轨迹'), `顶栏应该讲轨迹：${out}`);
});

test('modelLine：底栏右栏是 (provider) model 形状（与 pi 同形）', () => {
  const state = { providerName: 'workbuddy', modelId: 'cn:space-bunny' } as unknown as AgentState;
  assert.equal(modelLine(state), '(workbuddy) cn:space-bunny');
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
