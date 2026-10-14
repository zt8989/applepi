import test from 'node:test';
import assert from 'node:assert/strict';
import { scopedKeys } from '../src/model-picker';
import { extractText } from '../src/remote-agent';
import { parseEditDiff } from '../src/edit-diff';
import { parseUnifiedPatch } from '../src/split-diff';

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