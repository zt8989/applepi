/**
 * 「完全复用 pi 的键位」里那几条**纯逻辑**的动作助手（循环模型 / 循环思考级别）。
 *
 * 单独一个文件是为了能测：语义不难但**边界**不少（作用域里只有一个模型时不该动、当前模型不在作用域里
 * 时从哪开始、负方向怎么取模、级别只认模型支持的那几档），抽成纯函数就能逐个钉住而不必起整个 TUI。
 * `app.ts` 那边只剩「调它，然后把结果发给内核 / 写进 settings」的接线。
 *
 * 与 pi 的对应：`nextCycleIndex` ↔ `_cycleScopedModel` / `_cycleAvailableModel`，`nextThinkingLevel` ↔
 * `cycleThinkingLevel()`（连「当前档位不在列表里时从头一个开始」那个怪处也一样）。
 */
import type { Model } from '@earendil-works/pi-ai';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';

/** 循环方向。与 pi 的 `cycleModel(direction)` 同名同义。 */
export type CycleDirection = 'forward' | 'backward';

/**
 * 在列表里按方向取下一个下标。列表空 → `undefined`（没有可切的目标）。
 *
 * ## 为什么「当前不在列表里」从 0 开始
 *
 * 与 pi 一致：当前模型可能刚刚被移出作用域（用户在 `/scoped-models` 里禁用了它），
 * 那时 `findIndex` 得 -1，pi 把它归 0 —— 「从头开始循环」。反过来（不归 0 就返回
 * undefined）会让「禁用当前模型之后 Ctrl+P 没反应」，看着像键坏了。
 *
 * ## 为什么列表长度 1 也返回它自己
 *
 * 取模天然如此（`(0+1)%1 = 0`）。**调用方**决定要不要因此提示「作用域里只有一个模型」
 * —— 这一层不做「≤1 就拒绝」的判断，因为「1 个模型」在两种调用里含义不同：
 * 作用域循环里它是「没得切」，而单独看它只是「下一个还是它」。策略留给上层。
 */
export function nextCycleIndex(
  length: number,
  currentIndex: number,
  direction: CycleDirection,
): number | undefined {
  if (length <= 0) return undefined;
  const start = currentIndex >= 0 && currentIndex < length ? currentIndex : 0;
  return direction === 'forward' ? (start + 1) % length : (start - 1 + length) % length;
}

/**
 * 当前模型支持的全部思考级别（有序，从低到高）。模型缺 `reasoning` → 空数组。
 *
 * `getSupportedThinkingLevels` 是 pi-ai 的导出（pi 的 `getAvailableThinkingLevels()`
 * 就是转调它）—— 不自己维护一张「哪些模型支持哪几档」的表，那份表在 pi 那边会漂移。
 */
export function supportedThinkingLevels(model: Model<any> | undefined): string[] {
  if (!model || !model.reasoning) return [];
  return [...getSupportedThinkingLevels(model)];
}

/**
 * 下一个思考级别。不支持 thinking（或没有档位）→ `undefined`。
 *
 * ## 为什么**不**用 `nextCycleIndex`（两者确实不一样）
 *
 * pi 的 `cycleThinkingLevel()` 是 `levels[(currentIndex + 1) % levels.length]`：当前档位不在
 * 列表里时 `currentIndex` 是 -1，而 `(-1 + 1) % n === 0` —— **从头一个开始**。
 * 而 `_cycleScopedModel` / `_cycleAvailableModel` 先把 -1 归 0 再 +1（于是从**第二个**开始）。
 * 两个动作在 pi 里真的不同，所以这里各用一条式子；统一用 `nextCycleIndex` 的症状是
 * 「当前档位不被这个模型支持时（比如刚从只认 medium 的模型换到只认 low/high/max 的），
 * Shift+Tab 会跳过最便宜的那一档」。
 */
export function nextThinkingLevel(
  model: Model<any> | undefined,
  current: string,
): string | undefined {
  const levels = supportedThinkingLevels(model);
  if (levels.length === 0) return undefined;
  const index = levels.indexOf(current);
  return levels[(index + 1) % levels.length];
}

/**
 * 按 `provider\0id` 找当前模型在列表里的下标（`-1` = 不在列表里）。
 *
 * 用 `\0` 做分隔而不是 `/`：model id 里**可以**有 `/`（OpenRouter 的 `x/y` 形态），
 * 而 provider 名不会。`/` 拼 key 会把 `a/b` + `c` 与 `a` + `b/c` 混成同一个 ——
 * 症状是「循环时跳过一个模型」，很难查。
 */
export function modelKey(model: Pick<Model<any>, 'provider' | 'id'>): string {
  return `${model.provider}\0${model.id}`;
}