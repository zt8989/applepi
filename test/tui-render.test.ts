import test from 'node:test';
import assert from 'node:assert/strict';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import {
  cwdLine,
  foldOutput,
  modelLine,
  statusLine,
  toolArgs,
  twoColumn,
} from '../src/tui/app';
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

test('cwdLine：短路径原样显示', () => {
  assert.equal(cwdLine('C:\\proj', 'main'), 'C:\\proj (main)');
});

test('cwdLine：长路径从中间省略（保留最后两级，那才是定位信息）', () => {
  // 阈值是 48 列，所以这条得真的够长（早先的测试数据只有 33 字符，根本没触发省略，
  // 断言失败时容易误以为是省略逻辑坏了）。
  const out = cwdLine('C:\\a\\very\\long\\chain\\of\\dirs\\final\\nested\\project', 'main');
  assert.ok(out.includes('…'), `应该被省略过：${out}`);
  assert.ok(out.includes('nested\\project'), `最后两级要留着：${out}`);
});

test('cwdLine：不在 git 仓库时没有 (branch) 后缀', () => {
  assert.equal(cwdLine('C:\\proj', undefined), 'C:\\proj');
});

// ─── 长输出折叠（pi 的 `... (N earlier lines, ctrl+o to expand)`） ───

const FOLD_LIMIT = 12;

test('foldOutput：不超折叠阈值时原样返回', () => {
  const text = Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n');
  assert.equal(foldOutput(text, false), text);
});

test('foldOutput：超长时折起，并写明省略了多少行与怎么展开', () => {
  const text = Array.from({ length: 31 }, (_, i) => `line ${i}`).join('\n');
  const out = foldOutput(text, false);
  assert.ok(out.includes(`${31 - FOLD_LIMIT} earlier lines`), `省略行数要写对：${out.slice(-60)}`);
  assert.ok(out.includes('ctrl+o to expand'), '必须告诉用户怎么展开');
  assert.ok(out.startsWith('line 0'), '前几行要留着');
  assert.ok(!out.includes('line 30'), '被折掉的行不该出现');
});

test('foldOutput：expanded=true 时给全文并报总行数（用户要知道到底有多长）', () => {
  const text = Array.from({ length: 31 }, (_, i) => `line ${i}`).join('\n');
  const out = foldOutput(text, true);
  assert.ok(out.includes('line 30'), '展开后要看到最后一行');
  assert.ok(out.includes('共 31 行'));
});

// ─── 工具块标题的参数摘要 ───

test('toolArgs：参数取自 assistant 的 toolCall，不是 toolResult.details', () => {
  // details 是**返回值**（read 回来的是文件内容），不是调用参数。
  // 早先版本读错了这里，所有工具块标题都显示「0 个参数」。
  const state = {
    messages: [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'src/state.ts' } }], timestamp: 0 },
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'read',
        content: [{ type: 'text', text: '文件内容' }],
        details: { path: '不该用这个' },
        isError: false,
        timestamp: 0,
      },
    ],
  } as unknown as AgentState;
  const result = state.messages[1] as Extract<Message, { role: 'toolResult' }>;
  assert.equal(toolArgs(state, result), 'src/state.ts');
});

test('toolArgs：bash 显示命令、read/write 显示路径（pi 标题行就是文件名）', () => {
  const mk = (id: string, args: Record<string, unknown>) => {
    const state = {
      messages: [
        { role: 'assistant', content: [{ type: 'toolCall', id, name: 't', arguments: args }], timestamp: 0 },
        { role: 'toolResult', toolCallId: id, toolName: 't', content: [], isError: false, timestamp: 0 },
      ],
    } as unknown as AgentState;
    return toolArgs(state, state.messages[1] as Extract<Message, { role: 'toolResult' }>);
  };
  assert.equal(mk('c1', { command: 'ls -la' }), 'ls -la');
  assert.equal(mk('c2', { path: 'a/b.txt', content: 'x' }), 'a/b.txt', '有 path 就用 path');
});

test('toolArgs：没有可识别字段时退化成参数个数', () => {
  const state = {
    messages: [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 't', arguments: { foo: 1, bar: 2 } }], timestamp: 0 },
      { role: 'toolResult', toolCallId: 'c', toolName: 't', content: [], isError: false, timestamp: 0 },
    ],
  } as unknown as AgentState;
  assert.equal(
    toolArgs(state, state.messages[1] as Extract<Message, { role: 'toolResult' }>),
    '2 个参数',
  );
});

test('toolArgs：参数过长截断（标题行不能占满整行）', () => {
  const state = {
    messages: [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'bash', arguments: { command: 'x'.repeat(200) } }], timestamp: 0 },
      { role: 'toolResult', toolCallId: 'c', toolName: 'bash', content: [], isError: false, timestamp: 0 },
    ],
  } as unknown as AgentState;
  const out = toolArgs(state, state.messages[1] as Extract<Message, { role: 'toolResult' }>);
  assert.ok(out.length <= 91, `应该截断，实际 ${out.length}`);
  assert.ok(out.endsWith('…'));
});

test('toolArgs：找不到对应 toolCall 时不崩（会话被裁剪后可能配不上）', () => {
  const state = {
    messages: [
      { role: 'toolResult', toolCallId: 'orphan', toolName: 'read', content: [], isError: false, timestamp: 0 },
    ],
  } as unknown as AgentState;
  assert.equal(
    toolArgs(state, state.messages[0] as Extract<Message, { role: 'toolResult' }>),
    '',
    '配不上就留空，不显示「0 个参数」这种废话',
  );
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
