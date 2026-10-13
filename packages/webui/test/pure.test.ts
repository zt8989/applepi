import test from 'node:test';
import assert from 'node:assert/strict';
import { scopedKeys } from '../src/model-picker';
import { extractText } from '../src/remote-agent';

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