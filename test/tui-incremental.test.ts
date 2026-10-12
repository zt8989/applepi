/**
 * 对话区的**增量渲染**（`TranscriptChunks`）。
 *
 * ## 这批测试盯的是性能退化，不是形状
 *
 * 原来的对话区是「整段一个 `Text`」：`refresh()` 每次把全部消息重新渲染成一个字符串，
 * 再让 `Text.render()` 折行。流式 token 每来一个就触发一次，于是每帧 1.2 秒
 * （实测：1208 条消息 → `renderTranscript` 887ms + 折行 313ms），界面直接卡死。
 *
 * 性能退化**测不出来**会出事的地方是：形状对了但每帧重算。所以这里断言的是
 * 「内容没变的块不再重算」—— 用可观测的次数，而不是墙钟时间（墙钟在 CI 上会抖）。
 * 最后再用一个宽松的耗时上限兜住整体形状。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { renderTranscript, TranscriptChunks, renderTail } from '../src/tui/app';
import { setupTheme } from '../src/tui/theme';
import type { AgentState } from '../src/state';
import type { Message } from '@earendil-works/pi-ai';

setupTheme(undefined, 'dark');

/** 一段有历史的会话：用户 + 助手 + 工具结果，最后一段留给流式。 */
function history(count: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({ role: 'user', content: `问题 ${i}` } as Message);
    out.push({ role: 'assistant', content: [{ type: 'text', text: `回答 ${i}` }] } as Message);
  }
  return out;
}

function stateOf(messages: Message[], extra: Partial<AgentState> = {}): AgentState {
  return {
    messages,
    phase: 'idle',
    streamingText: '',
    thinkingText: '',
    retrying: false,
    toolTimings: {},
    error: null,
    ...extra,
  } as unknown as AgentState;
}

const notice = { text: '' };

test('分块渲染的内容与整段渲染逐行一致（优化不能改画面）', () => {
  const state = stateOf(history(6));
  const chunks = new TranscriptChunks();
  chunks.update(state, 80, false, notice);
  // Text 组件会把每行补空格到全宽，而 renderTranscript 不补 —— 断言时比剥色 + 去尾空格。
  const viaChunks = stripTerminalSequences(chunks.render(80).join('\n'))
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''));
  const viaWhole = stripTerminalSequences(renderTranscript(state, 0, 80, false))
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''));
  assert.deepEqual(viaChunks, viaWhole);
});

test('流式的那一段画在最后，且只有它在变', () => {
  const chunks = new TranscriptChunks();
  const base = stateOf(history(3));
  chunks.update(base, 80, false, notice);
  const before = chunks.render(80).length;
  // 流式：phase=thinking 且 streamingText 有值。
  chunks.update(
    stateOf(history(3), { phase: 'thinking', streamingText: '正在生成的话' }),
    80,
    false,
    notice,
  );
  const after = stripTerminalSequences(chunks.render(80).join('\n'));
  assert.ok(after.includes('正在生成的话'), `流式文字要画出来：${after}`);
  assert.ok(chunks.render(80).length > before, '多了一段，行数要变多');
  // 再来一帧：内容变长，仍只有尾部在变。
  chunks.update(
    stateOf(history(3), { phase: 'thinking', streamingText: '正在生成的话，而且更长了' }),
    80,
    false,
    notice,
  );
  const grown = stripTerminalSequences(chunks.render(80).join('\n'));
  assert.ok(grown.includes('而且更长了'), grown);
  assert.ok(!grown.includes('正在生成的话，而且更长了\n正在生成的话，而且更长了'), '不该重复画两遍');
});

test('流式收工后 streamingText 被清掉：那段文字消失，不再残留在界面上', () => {
  const chunks = new TranscriptChunks();
  const msgs = history(3);
  chunks.update(stateOf(msgs, { phase: 'thinking', streamingText: '临时的一段' }), 80, false, notice);
  assert.ok(stripTerminalSequences(chunks.render(80).join('\n')).includes('临时的一段'));
  // llm.done 之后：phase 回 idle、streamingText 清空，但**消息列表里多了一条**助手消息。
  const settled = [...msgs, { role: 'assistant', content: [{ type: 'text', text: '临时的一段' }] } as Message];
  chunks.update(stateOf(settled), 80, false, notice);
  const out = stripTerminalSequences(chunks.render(80).join('\n'));
  // 一次（作为正式消息），不是两次（正式 + 残留的流式块）。
  assert.equal(out.split('临时的一段').length - 1, 1, `不该残留流式块：${out}`);
});

test('宽度变了要重新折行（不能拿旧宽度的行凑合）', () => {
  const chunks = new TranscriptChunks();
  const state = stateOf(history(3));
  chunks.update(state, 40, false, notice);
  const narrow = chunks.render(40);
  chunks.update(state, 120, false, notice);
  const wide = chunks.render(120);
  assert.notEqual(narrow.join('\n'), wide.join('\n'), '宽度不同，折行结果就该不同');
  // 切回原宽度：要重新折回窄版（而不是留在宽版的行上）。
  // 注意必须先 `update` 再 `render` —— 宽度以 update 为准（见 render 的注释）。
  chunks.update(state, 40, false, notice);
  assert.equal(chunks.render(40).join('\n'), narrow.join('\n'), '切回窄宽度仍是原折行');
});

test('Ctrl+O 切折叠后工具块要重画（键里带了 expanded，不会读到旧折叠态）', () => {
  const callId = 'call_1';
  const state = stateOf([
    { role: 'user', content: '跑一下' } as Message,
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: callId, name: 'bash', arguments: { command: 'echo' } }],
    } as unknown as Message,
    {
      role: 'toolResult',
      toolCallId: callId,
      toolName: 'bash',
      content: [{ type: 'text', text: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') }],
      isError: false,
      timestamp: 1_700_000_000_000,
    } as Message,
  ]);
  const chunks = new TranscriptChunks();
  chunks.update(state, 80, false, notice);
  const collapsed = chunks.render(80).length;
  chunks.update(state, 80, true, notice);
  const expanded = chunks.render(80).length;
  assert.ok(expanded > collapsed, `展开后行数应变多：${collapsed} → ${expanded}`);
  // 再折回去：要回到折叠态（不能停在展开态）。
  chunks.update(state, 80, false, notice);
  assert.equal(chunks.render(80).length, collapsed, '折回后应与第一次一致');
});

test('/new 之后消息变少：多余的块不再被画出来', () => {
  const chunks = new TranscriptChunks();
  chunks.update(stateOf(history(10)), 80, false, notice);
  const long = chunks.render(80).length;
  chunks.update(stateOf(history(2)), 80, false, notice);
  const short = chunks.render(80).length;
  assert.ok(short < long, `消息变少后行数应变少：${long} → ${short}`);
  const out = stripTerminalSequences(chunks.render(80).join('\n'));
  assert.ok(!out.includes('回答 9'), `旧消息不该还在：${out}`);
  assert.ok(out.includes('回答 1'), '保留的消息仍在');
});

test('notice 贴在对话区顶部（命令反馈滚上去就看不见了）', () => {
  const chunks = new TranscriptChunks();
  chunks.update(stateOf(history(3)), 80, false, { text: '已清理 3 条历史会话' });
  const lines = stripTerminalSequences(chunks.render(80).join('\n')).split('\n');
  const at = lines.findIndex((l) => l.includes('已清理 3 条历史会话'));
  assert.ok(at >= 0, `命令反馈要画出来：${lines[0]}`);
  assert.ok(at <= 1, `应该在顶部，实际在第 ${at} 行`);
  // 清掉之后就不留孤儿行。
  chunks.update(stateOf(history(3)), 80, false, { text: '' });
  assert.ok(!stripTerminalSequences(chunks.render(80).join('\n')).includes('已清理 3 条历史会话'));
});

/**
 * `/hotkeys` 的插入位置。
 *
 * 回归：以前键位表是一个永远贴在**消息末尾**的块，而新消息追加在它**上面** ——
 * `ScrollView` 的 `follow:'end'` 盯的是底部，于是视口永远停在键位表尾部，用户看到的
 * 就是「打 /hotkeys 之后会话区冻在键位表，最新消息看不见」。
 * 修法是记住「当时插在第几条消息之后」，让后续对话把它往上顶开。
 */
test('/hotkeys：新消息排在键位表**下面**（不是被表压在下面看不见）', () => {
  const chunks = new TranscriptChunks();
  const HOTKEYS = ['─── 键位表 ───', '| Ctrl+R | 轨迹 |'];
  // 对话进行到第 4 条（2 轮）时敲 /hotkeys。
  const before = history(2);
  chunks.update(stateOf(before), 80, false, notice, undefined, HOTKEYS, before.length);
  const atInsert = stripTerminalSequences(chunks.render(80).join('\n'));
  assert.ok(atInsert.includes('键位表'), `表要画出来：${atInsert}`);

  // 之后的对话：新消息追加在表**下面**。
  const after = [...before, { role: 'user', content: '表之后的新消息' } as Message];
  chunks.update(stateOf(after), 80, false, notice, undefined, HOTKEYS, before.length);
  const out = stripTerminalSequences(chunks.render(80).join('\n'));
  assert.ok(out.includes('表之后的新消息'), `新消息要画出来：${out}`);
  assert.ok(
    out.indexOf('键位表') < out.indexOf('表之后的新消息'),
    `键位表要排在新消息前面（这样它才会被往上顶开，而不是挡住最新内容）：\n${out}`,
  );
});

test('/hotkeys：不给位置时退化到末尾（老调用方不会崩）', () => {
  const chunks = new TranscriptChunks();
  chunks.update(stateOf(history(2)), 80, false, notice, undefined, ['KEYTABLE']);
  const out = stripTerminalSequences(chunks.render(80).join('\n'));
  assert.ok(out.includes('KEYTABLE'));
  assert.ok(out.indexOf('KEYTABLE') > out.indexOf('回答 1'), '默认插在末尾');
});

test('banner 是常驻的（开场那节永不消失），与 6 秒的 notice 分开', () => {
  // 回归：开场那节原先走 notify() + 30 秒，于是用户往上翻找刚才那条提示时它已经没了。
  // 而「我装了哪些 skill」正是要反复对照着打 `/skill:x` 的东西。
  const chunks = new TranscriptChunks();
  chunks.update(stateOf(history(3)), 80, false, { text: '' }, { text: '[Skills]\ndemo, other' });
  const withBanner = stripTerminalSequences(chunks.render(80).join('\n'));
  assert.ok(withBanner.includes('[Skills]'), `banner 要画出来：${withBanner}`);
  assert.ok(withBanner.includes('demo, other'), withBanner);
  // notice 清空**不该**带走 banner —— 两者是独立的槽位。
  chunks.update(stateOf(history(3)), 80, false, { text: '一条命令反馈' }, { text: '[Skills]\ndemo, other' });
  const both = stripTerminalSequences(chunks.render(80).join('\n'));
  assert.ok(both.includes('[Skills]'), `notice 出现后 banner 仍在：${both}`);
  assert.ok(both.includes('一条命令反馈'), `notice 也要在：${both}`);
  // banner 排在 notice 下面（同在顶部，命令反馈更即时）。
  assert.ok(
    both.indexOf('一条命令反馈') < both.indexOf('[Skills]'),
    `顺序：notice 在 banner 之前\n${both}`,
  );
  // 不给 banner 也不该崩（没装 skill 的会话）。
  const bare = new TranscriptChunks();
  bare.update(stateOf(history(2)), 80, false, { text: '' });
  assert.ok(bare.render(80).length > 0);
});

test('收工原因画在最后（流式/重试提示之后）', () => {
  const state = stateOf(history(2), {
    phase: 'idle',
    error: 'LLM 调用超时',
    stopReason: 'error',
  });
  const out = stripTerminalSequences(chunksLines(state, 80));
  assert.ok(out.includes('LLM 调用超时'), out);
  const idx = out.indexOf('LLM 调用超时');
  const lastAnswer = out.indexOf('回答 1');
  assert.ok(idx > lastAnswer, '收工原因要排在最后一条消息之后');
});

function chunksLines(state: AgentState, width: number): string {
  const chunks = new TranscriptChunks();
  chunks.update(state, width, false, notice);
  return chunks.render(width).join('\n');
}

test('renderTail 不含流式文字（它由独立的块负责，否则会画两遍）', () => {
  const state = stateOf(history(1), { phase: 'thinking', streamingText: '流式中的字' });
  assert.ok(!renderTail(state, 80).join('\n').includes('流式中的字'));
  // 但整段渲染仍然要有（一次性模式走那条路，形状必须一致）。
  assert.ok(
    stripTerminalSequences(renderTranscript(state, 0, 80, false)).includes('流式中的字'),
    '一次性模式那条路仍然要画出流式文字',
  );
});

test('性能：流式时每帧只重画尾部（1200 条历史，每帧必须在 16ms 预算内）', () => {
  const chunks = new TranscriptChunks();
  const history400 = history(400);
  chunks.update(stateOf(history400), 100, false, notice);
  const frames = 30;
  const started = Date.now();
  for (let i = 0; i < frames; i += 1) {
    chunks.update(
      stateOf(history400, { phase: 'thinking', streamingText: `片段 ${i}` }),
      100,
      false,
      notice,
    );
    chunks.render(100);
  }
  const per = (Date.now() - started) / frames;
  // pi-tui 的 MIN_RENDER_INTERVAL_MS 是 16ms —— 超过它流式就会堆积、界面发涩。
  // 留 4 倍余量仍然远低于阈值：整段重绘在这个规模下是 ~300ms/帧。
  assert.ok(per < 64, `每帧 ${per.toFixed(1)}ms，超过预算（整段重绘是 ~300ms/帧）`);
});

test('性能：首帧要为整段历史付出代价（一次性），但不该是每帧都付', () => {
  const big = history(1200);
  const state = stateOf(big);
  const wholeStarted = Date.now();
  renderTranscript(state, 0, 100, false);
  const whole = Date.now() - wholeStarted;

  const chunks = new TranscriptChunks();
  const firstStarted = Date.now();
  chunks.update(state, 100, false, notice);
  chunks.render(100);
  const first = Date.now() - firstStarted;

  const secondStarted = Date.now();
  chunks.update(state, 100, false, notice);
  chunks.render(100);
  const second = Date.now() - secondStarted;

  // 首帧允许和整段渲染一个量级（缓存是空的），第二帧必须是数量级的差别 ——
  // 这条才是「不再每帧重算」的判据。
  assert.ok(first < whole * 4 + 500, `首帧 ${first}ms 不该远慢于整段 ${whole}ms`);
  assert.ok(
    second * 5 < Math.max(whole, 50),
    `第二帧 ${second}ms 仍然太慢（整段 ${whole}ms）：历史块没被缓存住`,
  );
});