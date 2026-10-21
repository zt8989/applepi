import test from 'node:test';
import assert from 'node:assert/strict';
import { scopedKeys } from '../src/model-picker';
import { extractText, stripAssistantUsage } from '../src/remote-agent';
import { extractAttachments, withMessageAttachments, withUserAttachments } from '../src/attachments';
import { parseEditDiff } from '../src/edit-diff';
import { parseUnifiedPatch } from '../src/split-diff';
import { toolParameterFields } from '../src/context-panels';
import { formatToolDuration, resultImages } from '../src/tool-view';
import { pathBase, relativeTime } from '../src/format';
import { groupSessions, matchesQuery } from '../src/sidebar';
import {
  clampPanelWidth,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  sidebarMaxWidth,
} from '../src/panel-resize';
import { scrollDuration, shouldJump } from '../src/smooth-scroll';

/**
 * webui 的那几个**纯函数**。
 *
 * 这个包没有 DOM 测试环境（也不值得为这几个函数引一套）—— 这里只测不碰 `document`
 * 的那部分：作用域的 key 归一化、提问文本的提取。它们在浏览器里没法肉眼看出对错，
 * 错了的症状是「列表少了一堆模型」或「发出去的是空话」。
 */

test('scopedKeys：把 `provider/id[:级别]` 归一成可比较的 key', () => {
  const keys = scopedKeys(['deepseek/deepseek-v4-pro']);
  assert.ok(keys.has('deepseek/deepseek-v4-pro'));
  assert.equal(keys.has('deepseek/deepseek-v4-flash'), false);
});

test('scopedKeys：带思考级别后缀也算命中（`provider/id:high`）', () => {
  const keys = scopedKeys(['deepseek/deepseek-v4-pro:high']);
  assert.ok(keys.has('deepseek/deepseek-v4-pro'), '`/model` 的列表用不带后缀的 key 比对');
});

test('scopedKeys：模型 id 自身带冒号时不被切开（`workbuddy/cn:deepseek-v4.1-flash`）', () => {
  // 这是真会踩的那个坑：`-m cn:deepseek-v4.1-flash:high` 里，模型 id 是
  // `cn:deepseek-v4.1-flash`（带冒号），只有**最后**那段是思考级别。
  const keys = scopedKeys(['workbuddy/cn:deepseek-v4.1-flash:high']);
  assert.ok(keys.has('workbuddy/cn:deepseek-v4.1-flash'), '去掉级别后缀后要正好等于模型 id');
  // 切早了会得到 `workbuddy/cn` —— 那种 key 不该成为唯一结果（否则那个模型永远不在作用域里）。
  assert.ok(keys.has('workbuddy/cn:deepseek-v4.1-flash:high'), '原样也留着');
});

test('extractText：字符串 / `{content}` / `{content: 块}` 三种入参都抠得出文本', () => {
  assert.equal(extractText('直接是字符串'), '直接是字符串');
  assert.equal(extractText({ role: 'user', content: '字符串 content' }), '字符串 content');
  assert.equal(
    extractText({
      role: 'user-with-attachments',
      content: [
        { type: 'text', text: '第一段' },
        { type: 'image', data: 'x', mimeType: 'image/png' },
        { type: 'text', text: '第二段' },
      ],
    }),
    '第一段\n第二段',
    '图片块跳过，文本块按序拼起来',
  );
  assert.equal(extractText(undefined), '', '拿不到就给空串（调用方据此不发）');
  assert.equal(extractText({ role: 'user', content: 42 }), '');
});

// ─── 附件：发送投影（spi web-ui → 线协议）与展示投影（内核消息 → 界面） ───

test('extractAttachments：图片带 base64，文档只带正文；用不了的跳过', () => {
  const attachments = extractAttachments({
    role: 'user-with-attachments',
    content: '看图',
    attachments: [
      { id: 'a', type: 'image', fileName: 'shot.png', mimeType: 'image/png', size: 3, content: 'AAA', preview: 'AAA' },
      { id: 'b', type: 'document', fileName: 'spec.pdf', mimeType: 'application/pdf', size: 9, content: 'BIG', extractedText: '第一页' },
      { id: 'c', type: 'document', fileName: 'empty.pdf', mimeType: 'application/pdf', size: 0, content: '', extractedText: '   ' },
      { id: 'd', type: 'image', fileName: 'broken.png', mimeType: 'image/png', size: 0, content: '' },
    ],
  });
  assert.deepEqual(attachments.map((attachment) => attachment.fileName), ['shot.png', 'spec.pdf']);
  assert.equal(attachments[0]?.content, 'AAA', '图片的 base64 必须过线（模型要看图）');
  assert.equal(attachments[1]?.content, '', '文档原文件不过线（只留正文）');
  assert.equal(attachments[1]?.extractedText, '第一页');
  assert.deepEqual(extractAttachments('纯字符串'), []);
  assert.deepEqual(extractAttachments({ content: '没有 attachments' }), []);
});

test('withMessageAttachments：图片标签 + 文档块还原成附件格子，正文不留在气泡里', () => {
  const message = {
    role: 'user',
    content: [
      { type: 'text', text: '这张图' },
      { type: 'text', text: '[Image: shot.png]' },
      { type: 'image', data: 'AAA', mimeType: 'image/png' },
      { type: 'text', text: '\n\n[Document: spec.pdf]\n第一页' },
    ],
    timestamp: 1,
  };
  const converted = withMessageAttachments(message) as {
    role: string;
    content: string;
    attachments: { type: string; fileName: string; content: string; preview?: string; extractedText?: string }[];
  };
  assert.equal(converted.role, 'user-with-attachments');
  assert.equal(converted.content, '这张图', '标签与文档正文都不进气泡');
  assert.deepEqual(
    converted.attachments.map((attachment) => [attachment.type, attachment.fileName]),
    [
      ['image', 'shot.png'],
      ['document', 'spec.pdf'],
    ],
  );
  assert.equal(converted.attachments[0]?.preview, 'AAA', '缩略图直接用图片内容');
  assert.equal(converted.attachments[1]?.extractedText, '第一页');
  assert.equal(converted.attachments[1]?.content, '', '历史里没有原文件');
});

test('withMessageAttachments：没有附件块的消息原样返回（引用不变）', () => {
  const plain = { role: 'user', content: '你好', timestamp: 1 };
  assert.equal(withMessageAttachments(plain), plain);
  assert.equal(withUserAttachments([plain])[0], plain);

  // 用户自己打的 `[Image: …]`：后面不是图片，就不该被当成标签吃掉。
  const lookalike = {
    role: 'user',
    content: [
      { type: 'text', text: '[Image: not-a-file]' },
      { type: 'text', text: '这是我在说一句话' },
    ],
    timestamp: 2,
  };
  assert.equal(withMessageAttachments(lookalike), lookalike);
  // 用户自己打的文档前缀（没有桥加的那两个前导换行）也不动。
  const docLookalike = {
    role: 'user',
    content: [{ type: 'text', text: '[Document: x]\n正文' }],
    timestamp: 3,
  };
  assert.equal(withMessageAttachments(docLookalike), docLookalike);
});

// ─── `edit` 的 diff：分栏（unified patch）+ 单栏（展示 diff）两套解析 ───

/** pi 的 `generateDiffString()` 真会产出的那串（见 edit-diff.ts 的文件头）。 */
const RESULT_DIFF = ' 1 line1\n-2 line2\n+2 line2 changed\n 3 line3\n 4 line4\n   ...';

test('parseEditDiff：`+`/`-`/空格标记分别折成 add / del / context（内容去掉标记）', () => {
  assert.deepEqual(parseEditDiff(RESULT_DIFF), [
    { kind: 'context', text: '1 line1' },
    { kind: 'del', text: '2 line2' },
    { kind: 'add', text: '2 line2 changed' },
    { kind: 'context', text: '3 line3' },
    { kind: 'context', text: '4 line4' },
    { kind: 'skip', text: '' },
  ]);
});

test('parseEditDiff：末尾换行不产生空行；纯空串给空数组', () => {
  assert.equal(parseEditDiff(' 1 a\n+2 b\n').length, 2);
  assert.deepEqual(parseEditDiff(''), []);
});

// ─── `split-diff.ts`：统一 patch → 左旧右新两列 ───

/** pi 的 `generateUnifiedPatch()` 真会产出的那串（`--- a` / `+++ b` / `@@`）。 */
const UNIFIED_PATCH = '--- demo.md\n+++ demo.md\n@@ -1,3 +1,3 @@\n l1\n-l2\n+l2 changed\n l3\n';

test('parseUnifiedPatch：删/增配对成一行，旧号在新号在右，上下文两边同号', () => {
  const files = parseUnifiedPatch(UNIFIED_PATCH);
  assert.ok(files, '要解析出文件');
  assert.equal(files[0]!.oldPath, 'demo.md');
  assert.equal(files[0]!.newPath, 'demo.md');
  // 行：context(l1) / line(l2 删 / l2 增) / context(l3)；hunk 头不画。
  const rows = files[0]!.rows.filter((row) => row.type === 'line');
  assert.deepEqual(rows, [
    {
      type: 'line',
      left: { lineNo: 1, text: 'l1', type: 'context' },
      right: { lineNo: 1, text: 'l1', type: 'context' },
    },
    {
      type: 'line',
      left: { lineNo: 2, text: 'l2', type: 'removed' },
      right: { lineNo: 2, text: 'l2 changed', type: 'added' },
    },
    {
      type: 'line',
      left: { lineNo: 3, text: 'l3', type: 'context' },
      right: { lineNo: 3, text: 'l3', type: 'context' },
    },
  ]);
});

test('parseUnifiedPatch：只有删没有增时右侧是空位（行号为 null）', () => {
  const files = parseUnifiedPatch('--- a\n+++ a\n@@ -1,2 +1,1 @@\n keep\n-gone\n');
  assert.ok(files);
  const rows = files[0]!.rows.filter((row) => row.type === 'line');
  assert.deepEqual(rows[1]!.left, { lineNo: 2, text: 'gone', type: 'removed' });
  assert.deepEqual(rows[1]!.right, { lineNo: null, text: '', type: 'empty' });
});

test('parseUnifiedPatch：hunk 体内以 `--- `/`+++ ` 开头的行是内容，不当文件头', () => {
  // 删除一行 `-- x`、加一行 `++ y`：前缀是 `-`/`+`，剩下的是 `- x` / `+ y`。
  const files = parseUnifiedPatch('--- a\n+++ a\n@@ -1,1 +1,1 @@\n--- x\n+++ y\n');
  assert.equal(files?.length, 1, '仍然只有一个文件');
  const rows = files[0]!.rows.filter((row) => row.type === 'line');
  assert.deepEqual(rows[0]!.left, { lineNo: 1, text: '-- x', type: 'removed' });
  assert.deepEqual(rows[0]!.right, { lineNo: 1, text: '++ y', type: 'added' });
});

test('parseUnifiedPatch：不是 patch 的文本给 null', () => {
  assert.equal(parseUnifiedPatch('随便一段中文\n没有 @@ 头'), null);
  assert.equal(parseUnifiedPatch(''), null);
});
test('toolParameterFields：JSON Schema 摊成参数表（必填 / 枚举 / 数组 / 联合类型 / $ref）', () => {
  // 顶栏「工具」面板右侧那一段：参数名、类型、必填、可选值、默认值。
  // 工具的 schema 来自扩展（typebox 各种写法都有），所以这里钉的是「看不懂的降级成
  // unknown 而不是抛」以及几种真会遇到的形状。
  const fields = toolParameterFields({
    type: 'object',
    required: ['path'],
    properties: {
      path: { type: 'string', description: '文件路径' },
      mode: { type: 'string', enum: ['replace', 'append'], default: 'replace' },
      lines: { type: 'array', items: { type: 'string' } },
      timeout: { anyOf: [{ type: 'number' }, { type: 'null' }] },
      options: { $ref: '#/$defs/Options' },
    },
  });

  assert.deepEqual(fields.map((field) => field.name), [
    'path',
    'mode',
    'lines',
    'timeout',
    'options',
  ]);
  assert.equal(fields[0]?.required, true);
  assert.equal(fields[0]?.type, 'string');
  assert.equal(fields[0]?.description, '文件路径');
  assert.equal(fields[1]?.required, false);
  assert.equal(fields[1]?.allowedValues, 'replace, append');
  assert.equal(fields[1]?.defaultValue, 'replace');
  assert.equal(fields[2]?.type, 'string[]');
  assert.equal(fields[3]?.type, 'number | null');
  assert.equal(fields[4]?.type, 'Options', '`$ref` 取最后一段当类型名');
});

test('toolParameterFields：不是对象 schema 就给空表（不抛）', () => {
  assert.deepEqual(toolParameterFields(undefined), []);
  assert.deepEqual(toolParameterFields(null), []);
  assert.deepEqual(toolParameterFields('字符串'), []);
  assert.deepEqual(toolParameterFields({ type: 'object' }), []);
});

test('formatToolDuration：秒 / 分 / 小时三档', () => {
  // 工具卡上那个 `1.2s`。与 Pi Web 的 formatToolDuration 同一个口径。
  assert.equal(formatToolDuration(0), '0.0s');
  assert.equal(formatToolDuration(1234), '1.2s');
  assert.equal(formatToolDuration(59_900), '59.9s');
  assert.equal(formatToolDuration(60_000), '1m 0s');
  assert.equal(formatToolDuration(65_400), '1m 5s');
  assert.equal(formatToolDuration(3_723_000), '1h 2m 3s');
});

test('stripAssistantUsage：只剥助手消息的 usage，其余原样且不改原数组', () => {
  // pi-web-ui 会给每条带 usage 的助手消息渲染一行 `↑186 ↓1.2k R164k`；
  // 那个口径与底栏（服务端算的 statsLine）不同，所以界面不要它。
  const usage = { input: 186, output: 1200, cacheRead: 164_000 };
  const messages = [
    { role: 'user', content: '嗨' },
    { role: 'assistant', content: [], usage },
    { role: 'toolResult', toolCallId: 'c1', content: [], usage },
  ];
  const stripped = stripAssistantUsage(messages);
  assert.equal((stripped[0] as { usage?: unknown }).usage, undefined, '本来就没有 usage');
  assert.equal((stripped[1] as { usage?: unknown }).usage, undefined, '助手消息的 usage 被抹掉');
  assert.equal(
    (stripped[2] as { usage?: unknown }).usage,
    usage,
    '工具结果不动（`assistant-message` 只读助手消息）',
  );
  assert.equal(messages[1]!.usage, usage, '剥的是拷贝，原数组一个字节不动');
});


// ─── 侧边栏那几块（`src/format.ts` / `src/sidebar.ts`）──

test('relativeTime：分钟 / 小时 / 天 / 月 / 年各一档，认不出来就不显示', () => {
  const now = Date.UTC(2026, 0, 10, 12, 0, 0);
  assert.equal(relativeTime(now - 10_000, now), '刚刚');
  assert.equal(relativeTime(now - 5 * 60_000, now), '5 分钟前');
  assert.equal(relativeTime(now - 3 * 3_600_000, now), '3 小时前');
  assert.equal(relativeTime(now - 2 * 86_400_000, now), '2 天前');
  assert.equal(relativeTime(now - 40 * 86_400_000, now), '1 个月前');
  assert.equal(relativeTime(now - 400 * 86_400_000, now), '1 年前');
  // 0 / NaN（「还没落盘」那条会话）给空串，不是「1970 年前」。
  assert.equal(relativeTime(0, now), '');
  assert.equal(relativeTime(Number.NaN, now), '');
  // 未来一点（浏览器与服务的时钟差）算「刚刚」，不算负数分钟。
  assert.equal(relativeTime(now + 60_000, now), '刚刚');
});

test('pathBase：取末段，尾斜杠不算，取不到就原样回', () => {
  assert.equal(pathBase('/Users/me/proj'), 'proj');
  assert.equal(pathBase('/Users/me/proj/'), 'proj');
  assert.equal(pathBase('C:\\Users\\me\\proj'), 'proj');
  assert.equal(pathBase('/'), '/');
  assert.equal(pathBase(''), '');
});

const session = (id: string, cwd: string, lastActivityMs: number) => ({
  id,
  cwd,
  title: id,
  lastActivityMs,
  messageCount: 1,
});

test('groupSessions：按 cwd 归堆，组内与组间都按最后说话时间倒序', () => {
  const groups = groupSessions([
    session('a-old', '/work/a', 100),
    session('b-new', '/work/b', 900),
    session('a-new', '/work/a', 500),
  ]);
  assert.deepEqual(groups.map((group) => group.cwd), ['/work/b', '/work/a'], '组按各自最新那条排');
  assert.deepEqual(groups[1]!.sessions.map((s) => s.id), ['a-new', 'a-old'], '组内也倒序');
  // 时间一样时按 id 兜底（否则顺序随目录遍历，每次刷新都在跳）。
  const tied = groupSessions([session('z', '/work/a', 100), session('a', '/work/a', 100)]);
  assert.deepEqual(tied[0]!.sessions.map((s) => s.id), ['a', 'z']);
  // cwd 缺失的会话也有一堆（不能丢）。
  assert.deepEqual(groupSessions([session('x', '', 1)]).map((group) => group.cwd), ['（未知目录）']);
});

test('matchesQuery：标题 / cwd / id 三个面都能命中，空查询全过', () => {
  const one = { ...session('sess-1', '/work/alpha', 1), title: '修一个 bug' };
  assert.ok(matchesQuery(one, ''));
  assert.ok(matchesQuery(one, 'BUG'), '大小写不敏感');
  assert.ok(matchesQuery(one, 'alpha'));
  assert.ok(matchesQuery(one, 'sess-1'));
  assert.equal(matchesQuery(one, 'beta'), false);
});

/**
 * 工具结果里的图片（`read` 读图）。
 *
 * 这段是「看起来对、其实错」的那类：拼错一处 MIME 或漏掉 base64 前缀，浏览器给的
 * 不是报错而是一张破图 —— 而它只在有人真去读图的时候才出现。
 */
test('resultImages：图像块拼成 data URL，非图像块 / 空 data 一律跳过', () => {
  const images = resultImages({
    content: [
      { type: 'text', text: 'Read image file [image/png]' },
      { type: 'image', data: 'AAAABBBB', mimeType: 'image/png' },
      { type: 'image', data: '', mimeType: 'image/jpeg' },
      { type: 'text', text: '后面还有一句' },
    ],
  });
  assert.equal(images.length, 1, '空的 data 不画（否则是个 src="data:;base64," 的破图）');
  assert.equal(images[0]?.src, 'data:image/png;base64,AAAABBBB');
  assert.equal(images[0]?.alt, 'image/png');

  // 没有 mimeType 时按 png 兜底（pi 的 ImageContent 一定有它，但别因为缺一个字段就丢图）。
  assert.equal(resultImages({ content: [{ type: 'image', data: 'X' }] })[0]?.src, 'data:image/png;base64,X');
  assert.deepEqual(resultImages(undefined), [], '还没结果时没有图');
  assert.deepEqual(resultImages({ content: [] }), []);
});

/**
 * 侧边栏宽度的夹取（`panel-resize.ts`）。
 *
 * 这几个错了的症状都不明显：夹错下限是「怎么也拖不窄」，夹错上限是「一把拖到满屏」，
 * 而脏值（`NaN`）漏过去会让 `flex-basis` 变成非法值 —— 侧边栏直接不见了，控制台里
 * 一句报错都没有。所以这里专门盯边界与脏值。
 */
test('clampPanelWidth：夹进 [min, max]，并取整', () => {
  assert.equal(clampPanelWidth(300, 180, 480), 300);
  assert.equal(clampPanelWidth(100, 180, 480), 180, '比下限窄 → 下限');
  assert.equal(clampPanelWidth(900, 180, 480), 480, '比上限宽 → 上限');
  assert.equal(clampPanelWidth(311.6, 180, 480), 312, '取整（半像素宽会让中缝发虚）');
});

test('clampPanelWidth：NaN / Infinity 落回下限，而不是写进去', () => {
  // `Math.min(NaN, 480)` 还是 NaN —— 漏过去就是 flex-basis: NaNpx，侧边栏消失。
  assert.equal(clampPanelWidth(Number.NaN, 180, 480), 180);
  assert.equal(clampPanelWidth(Number.POSITIVE_INFINITY, 180, 480), 480);
  assert.equal(clampPanelWidth(Number.NEGATIVE_INFINITY, 180, 480), 180);
});

test('clampPanelWidth：上限比下限还小时下限优先（不会夹出一个负宽度）', () => {
  assert.equal(clampPanelWidth(500, 200, 120), 200);
});

test('sidebarMaxWidth：宽屏取库上限，窄屏给主区留出最小宽度', () => {
  assert.equal(sidebarMaxWidth(1600), SIDEBAR_MAX_WIDTH, '够宽时就是 480');
  assert.equal(sidebarMaxWidth(1200), SIDEBAR_MAX_WIDTH);
  // 800 - 360 = 440：比 480 小，所以按视口算。
  assert.equal(sidebarMaxWidth(800), 440);
  assert.equal(sidebarMaxWidth(700), 340);
});

test('sidebarMaxWidth：连最小宽度都放不下时也不返回负数', () => {
  // 300 - 360 < 0。负值的 flex-basis 非法，浏览器当 0 —— 看起来像「拖没了」。
  assert.equal(sidebarMaxWidth(300), SIDEBAR_MIN_WIDTH);
  assert.equal(sidebarMaxWidth(0), SIDEBAR_MIN_WIDTH);
});

/**
 * 平滑滚动动画的两个判据（`smooth-scroll.ts`）。
 *
 * 它们错了的症状都很「手感」而不报错：时长不封顶会拖成幻灯，`shouldJump` 判宽了
 * 就看不到动画、判窄了切会话时会从顶部滚半天。
 */
test('scrollDuration：近处短、远处长，但有上限', () => {
  assert.equal(scrollDuration(0), 0.14, '原地不动也要有个起点时长');
  assert.ok(scrollDuration(400) > scrollDuration(100), '越远越久');
  assert.equal(scrollDuration(100_000), 0.45, '再远也封在 0.45s');
  assert.equal(scrollDuration(-800), scrollDuration(800), '向上跳与向下跳同一口径');
});

test('shouldJump：超过一屏半就直接定位，否则播动画', () => {
  const viewport = 600;
  assert.equal(shouldJump(100, viewport), false, '一屏内的增量该有动画');
  assert.equal(shouldJump(900, viewport), false, '刚好 1.5 屏：仍然播');
  assert.equal(shouldJump(1200, viewport), true, '超过 1.5 屏（打开 / 切换会话）直接跳');
  assert.equal(shouldJump(-2000, viewport), true, '往回跳同样是大跳');
});
