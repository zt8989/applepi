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
import { renderTranscript, TranscriptChunks, renderTail, TraceChunks, workingStatusText } from '../src/tui/app';
import { createTraceTree, appendNode, patchNode, renderTree, traceStats, type TraceTree } from '../src/trace';
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

const noCards: { text: string; at: number }[] = [];

/** 轨迹块渲染出来的行（剔色 + 去空行）—— 与 tui-render.test.ts 里那个同形。 */
function linesOf(chunks: TraceChunks, width = 80): string[] {
  return stripTerminalSequences(chunks.render(width).join('\n'))
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '');
}

test('分块渲染的内容与整段渲染逐行一致（优化不能改画面）', () => {
  const state = stateOf(history(6));
  const chunks = new TranscriptChunks();
  chunks.update(state, 80, false, noCards);
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
  chunks.update(base, 80, false, noCards);
  const before = chunks.render(80).length;
  // 流式：phase=thinking 且 streamingText 有值。
  chunks.update(
    stateOf(history(3), { phase: 'thinking', streamingText: '正在生成的话' }),
    80,
    false,
    noCards,
  );
  const after = stripTerminalSequences(chunks.render(80).join('\n'));
  assert.ok(after.includes('正在生成的话'), `流式文字要画出来：${after}`);
  assert.ok(chunks.render(80).length > before, '多了一段，行数要变多');
  // 再来一帧：内容变长，仍只有尾部在变。
  chunks.update(
    stateOf(history(3), { phase: 'thinking', streamingText: '正在生成的话，而且更长了' }),
    80,
    false,
    noCards,
  );
  const grown = stripTerminalSequences(chunks.render(80).join('\n'));
  assert.ok(grown.includes('而且更长了'), grown);
  assert.ok(!grown.includes('正在生成的话，而且更长了\n正在生成的话，而且更长了'), '不该重复画两遍');
});

test('流式收工后 streamingText 被清掉：那段文字消失，不再残留在界面上', () => {
  const chunks = new TranscriptChunks();
  const msgs = history(3);
  chunks.update(stateOf(msgs, { phase: 'thinking', streamingText: '临时的一段' }), 80, false, noCards);
  assert.ok(stripTerminalSequences(chunks.render(80).join('\n')).includes('临时的一段'));
  // llm.done 之后：phase 回 idle、streamingText 清空，但**消息列表里多了一条**助手消息。
  const settled = [...msgs, { role: 'assistant', content: [{ type: 'text', text: '临时的一段' }] } as Message];
  chunks.update(stateOf(settled), 80, false, noCards);
  const out = stripTerminalSequences(chunks.render(80).join('\n'));
  // 一次（作为正式消息），不是两次（正式 + 残留的流式块）。
  assert.equal(out.split('临时的一段').length - 1, 1, `不该残留流式块：${out}`);
});

test('宽度变了要重新折行（不能拿旧宽度的行凑合）', () => {
  const chunks = new TranscriptChunks();
  const state = stateOf(history(3));
  chunks.update(state, 40, false, noCards);
  const narrow = chunks.render(40);
  chunks.update(state, 120, false, noCards);
  const wide = chunks.render(120);
  assert.notEqual(narrow.join('\n'), wide.join('\n'), '宽度不同，折行结果就该不同');
  // 切回原宽度：要重新折回窄版（而不是留在宽版的行上）。
  // 注意必须先 `update` 再 `render` —— 宽度以 update 为准（见 render 的注释）。
  chunks.update(state, 40, false, noCards);
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
  chunks.update(state, 80, false, noCards);
  const collapsed = chunks.render(80).length;
  chunks.update(state, 80, true, noCards);
  const expanded = chunks.render(80).length;
  assert.ok(expanded > collapsed, `展开后行数应变多：${collapsed} → ${expanded}`);
  // 再折回去：要回到折叠态（不能停在展开态）。
  chunks.update(state, 80, false, noCards);
  assert.equal(chunks.render(80).length, collapsed, '折回后应与第一次一致');
});

test('/new 之后消息变少：多余的块不再被画出来', () => {
  const chunks = new TranscriptChunks();
  chunks.update(stateOf(history(10)), 80, false, noCards);
  const long = chunks.render(80).length;
  chunks.update(stateOf(history(2)), 80, false, noCards);
  const short = chunks.render(80).length;
  assert.ok(short < long, `消息变少后行数应变少：${long} → ${short}`);
  const out = stripTerminalSequences(chunks.render(80).join('\n'));
  assert.ok(!out.includes('回答 9'), `旧消息不该还在：${out}`);
  assert.ok(out.includes('回答 1'), '保留的消息仍在');
});

test('命令反馈卡钉进对话流：随会话走，不再是贴顶一行', () => {
  // 对齐 pi 的 `showStatus`：反馈是 chatContainer 里的一节（addChild），
  // 位置在**当时的消息边界**上，之后的对话把它往上顶。
  const chunks = new TranscriptChunks();
  const before = history(3);
  chunks.update(stateOf(before), 80, false, [{ text: '已清理 3 条历史会话', at: before.length }]);
  const lines = stripTerminalSequences(chunks.render(80).join('\n')).split('\n');
  const at = lines.findIndex((l) => l.includes('已清理 3 条历史会话'));
  assert.ok(at >= 0, `命令反馈要画出来：${lines.join('\n')}`);
  // 钉在末尾（当时没有更晚的消息）。
  const lastMsg = lines.findIndex((l) => l.includes('回答 2'));
  assert.ok(at > lastMsg, `反馈排在最后一条消息之后：第 ${at} 行（最后消息在第 ${lastMsg} 行）`);

  // 之后又有了新对话：卡留在原位（在旧消息之后、新消息之前），被往上顶开。
  const after = [...before, { role: 'user', content: '卡之后的新消息' } as Message];
  chunks.update(stateOf(after), 80, false, [{ text: '已清理 3 条历史会话', at: before.length }]);
  const out = stripTerminalSequences(chunks.render(80).join('\n'));
  assert.ok(
    out.indexOf('已清理 3 条历史会话') < out.indexOf('卡之后的新消息'),
    `卡要被新消息顶到上面（这才是「随会话滚走」）：\n${out}`,
  );
});

test('连续反馈（中间没有新对话）在同一张卡上覆盖，不刷屏', () => {
  // 这就是「换模型 → 切思考级别」这类连续配置变更：`at` 没变，应是同一张卡。
  const chunks = new TranscriptChunks();
  const msgs = history(2);
  chunks.update(stateOf(msgs), 80, false, [{ text: 'Model: deepseek', at: msgs.length }]);
  chunks.update(stateOf(msgs), 80, false, [{ text: 'Thinking level: high', at: msgs.length }]);
  const out = stripTerminalSequences(chunks.render(80).join('\n'));
  assert.ok(out.includes('Thinking level: high'), `新反馈要画出来：${out}`);
  assert.ok(!out.includes('Model: deepseek'), `旧反馈被覆盖，不该还留一行：${out}`);

  // 中间插过新对话之后，下一句反馈会另起一张卡（旧卡留在历史里）。
  const grown = [...msgs, { role: 'user', content: '又问了一句' } as Message];
  chunks.update(stateOf(grown), 80, false, [
    { text: 'Model: deepseek', at: msgs.length },
    { text: 'Thinking level: high', at: grown.length },
  ]);
  const two = stripTerminalSequences(chunks.render(80).join('\n'));
  assert.ok(two.includes('Model: deepseek'), `旧卡应留在历史里：${two}`);
  assert.ok(two.includes('Thinking level: high'), two);
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
  chunks.update(stateOf(before), 80, false, noCards, undefined, HOTKEYS, before.length);
  const atInsert = stripTerminalSequences(chunks.render(80).join('\n'));
  assert.ok(atInsert.includes('键位表'), `表要画出来：${atInsert}`);

  // 之后的对话：新消息追加在表**下面**。
  const after = [...before, { role: 'user', content: '表之后的新消息' } as Message];
  chunks.update(stateOf(after), 80, false, noCards, undefined, HOTKEYS, before.length);
  const out = stripTerminalSequences(chunks.render(80).join('\n'));
  assert.ok(out.includes('表之后的新消息'), `新消息要画出来：${out}`);
  assert.ok(
    out.indexOf('键位表') < out.indexOf('表之后的新消息'),
    `键位表要排在新消息前面（这样它才会被往上顶开，而不是挡住最新内容）：\n${out}`,
  );
});

test('/hotkeys：不给位置时退化到末尾（老调用方不会崩）', () => {
  const chunks = new TranscriptChunks();
  chunks.update(stateOf(history(2)), 80, false, noCards, undefined, ['KEYTABLE']);
  const out = stripTerminalSequences(chunks.render(80).join('\n'));
  assert.ok(out.includes('KEYTABLE'));
  assert.ok(out.indexOf('KEYTABLE') > out.indexOf('回答 1'), '默认插在末尾');
});

test('banner 是常驻的（开场那节永不消失），与命令反馈卡分开', () => {
  // 回归：开场那节原先走 notify() + 30 秒，于是用户往上翻找刚才那条提示时它已经没了。
  // 而「我装了哪些 skill」正是要反复对照着打 `/skill:x` 的东西。
  const chunks = new TranscriptChunks();
  chunks.update(stateOf(history(3)), 80, false, [], { text: '[Skills]\ndemo, other' });
  const withBanner = stripTerminalSequences(chunks.render(80).join('\n'));
  assert.ok(withBanner.includes('[Skills]'), `banner 要画出来：${withBanner}`);
  assert.ok(withBanner.includes('demo, other'), withBanner);
  // 反馈卡清空**不该**带走 banner —— 两者是独立的槽位。
  chunks.update(stateOf(history(3)), 80, false, [{ text: '一条命令反馈', at: 6 }], { text: '[Skills]\ndemo, other' });
  const both = stripTerminalSequences(chunks.render(80).join('\n'));
  assert.ok(both.includes('[Skills]'), `反馈卡出现后 banner 仍在：${both}`);
  assert.ok(both.includes('一条命令反馈'), `反馈卡也要在：${both}`);
  // banner 在**顶部**（开场那节），反馈卡在对话流末尾 —— banner 在前。
  assert.ok(
    both.indexOf('[Skills]') < both.indexOf('一条命令反馈'),
    `顺序：banner（顶部）在反馈卡（末尾）之前\n${both}`,
  );
  // 不给 banner 也不该崩（没装 skill 的会话）。
  const bare = new TranscriptChunks();
  bare.update(stateOf(history(2)), 80, false, []);
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
  chunks.update(state, width, false, noCards);
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

test('renderTail：用户中止只说一句 `Operation aborted`（不再提示去看轨迹）', () => {
  // 以前这一支是「■ 用户手动中断：LLM 调用已中断（轨迹节点 n7）」+「已按你的要求停下…」，
  // 而小结里还跟着一句「按 Ctrl+R 看轨迹树」—— 用户自己按的停止，却像被报了个错，
  // 还顺手推销了一次轨迹页。pi 只有一句 `Operation aborted`（在 assistant 消息的末尾）。
  // 这一支是「没有任何 assistant 消息可画」的那种中止（流挂住时按 Esc 走 `llm.failed`）。
  const state = stateOf(history(1), {
    phase: 'idle',
    error: 'LLM 调用已中断',
    stopCause: 'user',
    stopCauseDetail: '用户手动中断',
    stopReason: 'aborted',
    errorNodeId: 'n7',
  });
  const out = stripTerminalSequences(renderTail(state, 80).join('\n'));
  assert.ok(out.includes('Operation aborted'), `要与 pi 同一句：${out}`);
  assert.ok(!out.includes('Ctrl+R'), `不该再提示看轨迹：${out}`);
  assert.ok(!out.includes('用户手动中断'), `不再重复一遍原因：${out}`);
  assert.ok(!out.includes('n7'), `也不再报轨迹节点：${out}`);
});

// ── 工作状态（画在 composer 上框线上，与 pi 同位置） ──
//
// `workingStatusText()` 是那个**从 state 现推**的纯函数：思考中 / 压缩中 / 重试 三个状态
// 都比它一处算。早先是一串 if/else 加一个 `lastLoaderMessage` 变量手工收尾，漏一处的
// 症状是「圈一直转」或「文案洇在那儿」—— 现推就不会有那种账。
//
// 为什么重试那句**不再**在 `renderTail` 里：它与另两个一样是工作状态，pi 把它们都放在
// 上框线上。放两处就是同一件事报两遍。

test('workingStatusText：三种状态各自映射到上框线那句', () => {
  assert.equal(workingStatusText(stateOf(history(1))), undefined, '空闲 → 不画');
  assert.equal(
    workingStatusText(stateOf(history(1), { phase: 'thinking' })),
    '思考中…',
    '生成中 → 思考中…',
  );
  assert.equal(
    workingStatusText(stateOf(history(1), { compacting: true } as Partial<AgentState>)),
    '压缩中…',
    '压缩中 → 压缩中…（压缩时 phase 是 idle，所以单看 phase 是看不到它的）',
  );
  assert.match(
    workingStatusText(
      stateOf(history(1), {
        phase: 'thinking',
        retrying: true,
        llmAttempts: 2,
        maxLlmAttempts: 3,
      } as Partial<AgentState>),
    ) ?? '',
    /正在重试（第 2\/3 次尝试）/,
    '重试 → 带第 N/M 次那句',
  );
});

test('workingStatusText：重试 > 压缩 > 生成（重试时带的是信息量最大的那句）', () => {
  const both = stateOf(history(1), {
    phase: 'thinking',
    compacting: true,
    retrying: true,
    llmAttempts: 1,
    maxLlmAttempts: 2,
  } as Partial<AgentState>);
  assert.match(workingStatusText(both) ?? '', /正在重试/, '三个都真时优先说重试');
});

test('renderTail 里不再画重试那行（它搬到了 composer 的上框线）', () => {
  const state = stateOf(history(1), {
    phase: 'thinking',
    retrying: true,
    llmAttempts: 2,
    maxLlmAttempts: 2,
  } as Partial<AgentState>);
  assert.ok(
    !renderTail(state, 80).join('\n').includes('重试'),
    '重试提示只该在 composer 上框线那一处（见 workingStatusText）',
  );
});

test('性能：流式时每帧只重画尾部（1200 条历史，每帧必须在 16ms 预算内）', () => {
  const chunks = new TranscriptChunks();
  const history400 = history(400);
  chunks.update(stateOf(history400), 100, false, noCards);
  const frames = 30;
  const started = Date.now();
  for (let i = 0; i < frames; i += 1) {
    chunks.update(
      stateOf(history400, { phase: 'thinking', streamingText: `片段 ${i}` }),
      100,
      false,
      noCards,
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
  chunks.update(state, 100, false, noCards);
  chunks.render(100);
  const first = Date.now() - firstStarted;

  const secondStarted = Date.now();
  chunks.update(state, 100, false, noCards);
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

// ══════════════════════ 轨迹侧的增量与复杂度 ══════════════════════

/**
 * 一批「同一父下的 step」—— 这是重试链与「一轮里并行工具」的形状。
 *
 * 之所以专门造这个形状：旧的 `traceStats()` / `renderTree()` 在这上面退化成 O(k²)
 * （对每个节点把整组兄弟扫一遍）。而 `refresh()` 是每个流式 token 一次的 ——
 * 长会话下每个 token 都为这个付钱，界面就卡了。
 */
function traceWithSiblingSteps(steps: number): TraceTree {
  let tree = createTraceTree('s');
  const root = appendNode(tree, null, 'turn.start', { status: 'pending', label: '回合', createdAt: 0 });
  tree = root.tree;
  for (let i = 0; i < steps; i += 1) {
    tree = appendNode(tree, root.node.id, 'step.start', {
      status: 'pending', label: `第 ${i + 1} 步`, createdAt: i,
    }).tree;
  }
  return tree;
}

test('轨迹：节点数翻倍，traceStats 耗时不该翻两番（O(N²) 回归）', () => {
  // 先用小的把 JIT 烘一下，否则第一次调用的编译开销会淹掉信号。
  traceStats(traceWithSiblingSteps(50));

  const timeFor = (steps: number): number => {
    const tree = traceWithSiblingSteps(steps);
    const started = performance.now();
    for (let i = 0; i < 10; i += 1) traceStats(tree);
    return performance.now() - started;
  };

  const small = timeFor(200);
  const large = timeFor(800);
  // 节点变 4 倍。线性应该是 ~4 倍，旧的 O(N²) 是 ~16 倍。
  // 阈值取 8 倍（远低于 16），留足 CI 抖动的余量，又足以抓住 O(N²)。
  assert.ok(
    large < Math.max(small * 8, 5),
    `200 节点 ${small.toFixed(2)}ms → 800 节点 ${large.toFixed(2)}ms：增长太快，像 O(N²)`,
  );
});

test('轨迹：节点数翻倍，renderTree 耗时不该翻两番（O(N²) 回归）', () => {
  renderTree(traceWithSiblingSteps(50));

  const timeFor = (steps: number): number => {
    const tree = traceWithSiblingSteps(steps);
    const started = performance.now();
    // 25 次而不是 5 次：换掉分叉缩进之后 `renderTree` 快了一截（800 节点单次 ~0.3ms），
    // 5 次的总时长落到「毫秒级的噪声」里 —— 并行跑整个测试集时会被 GC 与调度淹没，
    // 于是改成偶发失败的假警报。多跑几次把信号抬出噪声（阀值相对值不变）。
    for (let i = 0; i < 25; i += 1) renderTree(tree);
    return performance.now() - started;
  };

  const small = timeFor(200);
  const large = timeFor(800);
  assert.ok(
    large < Math.max(small * 8, 5),
    `200 节点 ${small.toFixed(2)}ms → 800 节点 ${large.toFixed(2)}ms：增长太快，像 O(N²)`,
  );
});

test('TraceChunks：节点一个字没动时，一帧不做任何重算（含 Intl.Segmenter）', () => {
  const tree = traceWithSiblingSteps(400);
  const chunks = new TraceChunks();
  chunks.update(tree, 100, '');

  // 同一棵**树对象**再 update 一次：所有节点引用都没变。
  // 旧版这里会把 400 个节点全部重新 `lineOf()`（每一步都走分词）——
  // 新版应当直接跳过，只走一遍循环。
  const started = performance.now();
  for (let i = 0; i < 50; i += 1) chunks.update(tree, 100, '');
  const perFrame = (performance.now() - started) / 50;

  // 真正的判据不是墙钟而是「不重算」：拿一次冷 update 比。
  const cold = new TraceChunks();
  const coldStarted = performance.now();
  cold.update(tree, 100, '');
  const coldMs = performance.now() - coldStarted;

  // 热帧应该比冷帧便宜很多（冷帧要算 400 行）。留 5 倍余量。
  assert.ok(
    perFrame * 5 < Math.max(coldMs, 2),
    `热帧 ${perFrame.toFixed(3)}ms 相对冷帧 ${coldMs.toFixed(2)}ms 没有明显变便宜：没跳过未变节点`,
  );
});

test('TraceChunks：只改一个节点时，只有那一个块被重画', () => {
  let tree = traceWithSiblingSteps(60);
  const chunks = new TraceChunks();
  chunks.update(tree, 80, '');
  const before = stripTerminalSequences(chunks.render(80).join('\n')).split('\n');

  // 闭合中间那个节点（造出一个新对象）。
  const midId = tree.order[30] ?? '';
  tree = patchNode(tree, midId, { status: 'ok', endedAt: 123 });
  chunks.update(tree, 80, '');
  const after = stripTerminalSequences(chunks.render(80).join('\n')).split('\n');

  let changed = 0;
  for (let i = 0; i < Math.min(before.length, after.length); i += 1) {
    if (before[i] !== after[i]) changed += 1;
  }
  assert.equal(changed, 1, '只有一个节点的行变了');
});

// 增量的判据是「节点对象引用」。一旦树**变短再变长**，同一个下标可能换了一个节点 ——
// 这时引用变了就该重算（否则会画上一个节点的行）。这条钉住那个回退路径。
test('TraceChunks：树变短再变长时，同一位置的块会重算而不是留下旧节点的行', () => {
  const chunks = new TraceChunks();

  // 先 5 个节点。
  let long = traceWithSiblingSteps(5);
  chunks.update(long, 80, '');
  assert.match(linesOf(chunks).join(' '), /第 5 步/, '先有 5 个节点');

  // 换成只有 2 个节点的新树 —— 块数组该被截到 2。
  let short = createTraceTree('s2');
  const root = appendNode(short, null, 'turn.start', { status: 'pending', label: '新树', createdAt: 0 });
  short = root.tree;
  for (let i = 0; i < 2; i += 1) {
    short = appendNode(short, root.node.id, 'step.start', { status: 'pending', label: `短 ${i}`, createdAt: i }).tree;
  }
  chunks.update(short, 80, '');
  const shrunk = linesOf(chunks).join(' ');
  assert.equal(/第 5 步/.test(shrunk), false, '旧节点不残留');
  assert.match(shrunk, /短 1/);

  // 再变长（新树里同一个下标是不同的节点对象）—— 应该把新节点画出来。
  short = appendNode(short, root.node.id, 'step.start', { status: 'pending', label: '又长出来', createdAt: 9 }).tree;
  chunks.update(short, 80, '');
  assert.match(linesOf(chunks).join(' '), /又长出来/, '变长后新节点要画出来');
  assert.equal(/短 9|第 5 步/.test(linesOf(chunks).join(' ')), false, '没有凭空多出的旧节点');
});