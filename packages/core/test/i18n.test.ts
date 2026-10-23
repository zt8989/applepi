/**
 * i18n（`src/i18n.ts`）—— 界面文案的唯一出口。
 *
 * 只钉三件事：默认中文（`ELA_LANG` 可切英文）、`{name}` 占位替换、缺 key 当编程
 * 错误抛（拼错 key 比在界面上显示 key 本身更糟，测试当场抓住）。
 * 文案本身在 `state.ts` / `stream.ts` / `app.ts` 的测试里各自覆盖，这里不重复。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getLang, setLang, t } from '../src/i18n';
import { stopCauseText } from '../src/state';

test('默认中文；停止原因都有一句人话', () => {
  assert.equal(getLang(), 'zh');
  assert.equal(stopCauseText('timeout'), '大模型调用超时');
  assert.equal(stopCauseText('user'), '用户手动中断');
});

test('切英文后同一批 key 换一种语言', () => {
  setLang('en');
  try {
    assert.equal(stopCauseText('timeout'), 'LLM call timed out');
    assert.equal(t('thinking.label'), 'Thinking…');
  } finally {
    setLang('zh');
  }
  assert.equal(stopCauseText('timeout'), '大模型调用超时');
});

test('占位替换：{name} 换成参数，不认识的占位原样留下', () => {
  assert.equal(
    t('timeout.withDuration', { duration: '2m00s' }),
    '大模型调用超时（2m00s）',
  );
  assert.ok(t('assistant.abortedWithReason', { reason: 'x' }).includes('x'));
});

test('缺少 key 是编程错误：直接抛', () => {
  assert.throws(() => t('no.such.key'), /\[i18n\] 缺少文案 key/);
});
