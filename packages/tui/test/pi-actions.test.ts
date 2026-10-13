import test from 'node:test';
import assert from 'node:assert/strict';
import {
  modelKey,
  nextCycleIndex,
  nextThinkingLevel,
  supportedThinkingLevels,
} from '../src/pi-actions';
import type { Model } from '@earendil-works/pi-ai';

/**
 * 「完全复用 pi」里那几条纯逻辑（循环模型下标 / 循环思考级别）。
 *
 * ## 这组测试守什么
 *
 * 这几处错了都不会报错，只会「切错一个模型」或「级别跳档」—— 而那种症状来自
 * `Ctrl+P` / `Shift+Tab`，很难联想到取模。所以逐个钉住边界：
 *
 * - 列表长度 1（取模回到自己）
 * - 当前项不在列表里（从 0 开始，与 pi 一致）
 * - 方向为负时的反向取模（不加长度会得到负数下标）
 * - 不支持的模型（thinking 应返回 undefined，而不是编一个级别）
 */

/** 造一个最小的 `Model`：只带这几个字段的模型够这些纯函数读。 */
function fakeModel(reasoning: boolean): Model<any> {
  return { provider: 'p', id: 'm', reasoning } as unknown as Model<any>;
}

test('nextCycleIndex：正向 / 反向各绕一圈，从当前项的下一个开始', () => {
  assert.equal(nextCycleIndex(3, 0, 'forward'), 1);
  assert.equal(nextCycleIndex(3, 1, 'forward'), 2);
  assert.equal(nextCycleIndex(3, 2, 'forward'), 0, '到末尾要回卷');
  assert.equal(nextCycleIndex(3, 0, 'backward'), 2, '反向从末尾回卷');
  assert.equal(nextCycleIndex(3, 2, 'backward'), 1);
});

test('nextCycleIndex：长度 1 就是它自己（取模的必然结果）', () => {
  assert.equal(nextCycleIndex(1, 0, 'forward'), 0);
  assert.equal(nextCycleIndex(1, 0, 'backward'), 0);
});

test('nextCycleIndex：当前项不在列表里（-1）从 0 开始 —— 与 pi 一致', () => {
  // pi 的 `_cycleScopedModel`：`findIndex` 得 -1 时归 0。不归 0 的直接后果是
  // 「当前模型被移出作用域之后 Ctrl+P 没反应」，看着像键坏了。
  assert.equal(nextCycleIndex(4, -1, 'forward'), 1);
  assert.equal(nextCycleIndex(4, -1, 'backward'), 3);
  assert.equal(nextCycleIndex(4, 99, 'forward'), 1, '越界同样从 0 起算');
});

test('nextCycleIndex：空列表没有可切的目标', () => {
  assert.equal(nextCycleIndex(0, 0, 'forward'), undefined);
  assert.equal(nextCycleIndex(0, -1, 'backward'), undefined);
});

test('supportedThinkingLevels：不支持 reasoning 的模型没有档位', () => {
  assert.deepEqual(supportedThinkingLevels(fakeModel(false)), []);
  assert.deepEqual(supportedThinkingLevels(undefined), []);
  // 支持 reasoning 的模型给一串非空档位（具体是哪几档由 pi-ai 决定，这里只要求非空且有序去重）。
  const levels = supportedThinkingLevels(fakeModel(true));
  assert.ok(levels.length > 0, '支持 thinking 的模型该有档位');
  assert.equal(new Set(levels).size, levels.length, '不该有重复档位');
});

test('nextThinkingLevel：不支持 thinking 时返回 undefined（不编一个级别）', () => {
  assert.equal(nextThinkingLevel(fakeModel(false), 'off'), undefined);
  assert.equal(nextThinkingLevel(undefined, 'off'), undefined);
});

test('nextThinkingLevel：当前级别是最后/第一档时双向都能走通', () => {
  const levels = supportedThinkingLevels(fakeModel(true));
  // 从第一档出发应该得到第二档（若有多档）。
  const first = levels[0] as string;
  const next = nextThinkingLevel(fakeModel(true), first);
  if (levels.length > 1) {
    assert.equal(next, levels[1]);
  } else {
    assert.equal(next, first, '只有一档时回到自己');
  }
  // 从最后一档出发回卷到第一档。
  const last = levels[levels.length - 1] as string;
  assert.equal(nextThinkingLevel(fakeModel(true), last), first);
  // 当前级别不在列表里（例如换了个能力不同的模型）→ **第一档**。
  //
  // 注意这里与 nextCycleIndex 的 -1 行为**不一样**，而那是 pi 真的不一样：
  // `cycleThinkingLevel()` 是 `levels[(index + 1) % len]`（-1 → 0），而
  // `_cycleScopedModel` 先把 -1 归 0 再 +1（-1 → 1）。统一成一条式子的症状是
  // 「Shift+Tab 跳过最便宜的那一档」（见 pi-actions.ts 的注释）。
  assert.equal(nextThinkingLevel(fakeModel(true), '不存在的档位'), first);
});

test('modelKey：用 \\0 分隔 provider 与 id（id 里可以有 /）', () => {
  // OpenRouter 的 `x/y` 形态：用 `/` 拼 key 会把两对不同模型混成同一个 ——
  // 症状是「循环时跳过一个模型」。`\0` 不会出现在 provider / id 里。
  assert.equal(modelKey({ provider: 'openrouter', id: 'x/y' }), 'openrouter\0x/y');
  assert.notEqual(
    modelKey({ provider: 'a/b', id: 'c' }),
    modelKey({ provider: 'a', id: 'b/c' }),
  );
});