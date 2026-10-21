/**
 * 思考级别（reasoning effort）—— **解析与落盘的唯一入口**，规则逐条照抄 pi。
 *
 * 「启动时用哪一档」在 pi 那边有五条来源（命令行 / 会话文件 / settings 的 per-model 覆盖 /
 * settings 的全局默认 / 内置 `medium`）和一道 clamp（模型支持哪几档）。散在各处各写一份的
 * 症状是「启动那个档位与 `/thinking` 面板上打勾的那个不是同一个」，而且**只在配了 settings
 * 时才看得出来**。所以这里一份纯函数 + 一份 settings 读写。
 *
 * clamp 转调 pi-ai 导出的 `clampThinkingLevel`：那张「哪些档位映射成什么」的表在 pi-ai 的
 * 模型目录里，抄一份必然漂移（症状：pi 显示 high，本项目显示 low）。
 */
import {
  clampThinkingLevel,
  type Model,
  type ModelThinkingLevel,
  type ThinkingBudgets,
} from '@earendil-works/pi-ai';
import { SettingsManager } from '@earendil-works/pi-coding-agent/dist/core/settings-manager.js';
import { piAgentDir } from './pi-config';

/**
 * 全部合法档位，**顺序就是 pi 的顺序**（`EXTENDED_THINKING_LEVELS`）—— 这里只用来校验
 * 「是不是一个合法档位」，clamp 本身在 pi-ai 那边。
 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * 内置默认档位（pi 的 `core/defaults.js` 的 `DEFAULT_THINKING_LEVEL`）。
 *
 * 是 `medium` 而不是 `high` —— 「默认就是 high」是「默认 medium + 模型只认 low/high/max +
 * 往上取整」三步的结果，不是 pi 把默认写成了 high。
 */
export const DEFAULT_THINKING_LEVEL: ModelThinkingLevel = 'medium';

/** 命令行 / settings.json 里的值是不是一个合法档位。 */
export function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * 把级别 clamp 到模型支持的那几档（转调 pi-ai 的 `clampThinkingLevel`）。
 *
 * 判据是模型的 `thinkingLevelMap`：映射成 `null` 的档位**不支持**，没写这个键的默认支持
 * （`xhigh` / `max` 例外：必须显式映射）。clamp 是「从当前档位往上找第一个支持的」，所以
 * 只支持 low/high/max 的模型上 `medium` → `high`、`off` → `low`（**根本关不掉思考**）。
 *
 * 模型给不出来（没装配）时返回 `off`（与 pi 的 `if (!model) thinkingLevel = "off"` 同一句）。
 */
export function clampForModel(
  model: Model<any> | undefined,
  level: ModelThinkingLevel,
): ModelThinkingLevel {
  if (!model) return 'off';
  return clampThinkingLevel(model, level);
}

/** 「启动时用哪一档」的五条来源。全部可选 —— 缺哪条就是 pi 的下一步。 */
export interface StartupThinkingInput {
  /** 命令行 `--thinking`。给了就**最高优先**（pi 的 `options.thinkingLevel`）。 */
  cliLevel?: string | undefined;
  /**
   * 会话文件里那条 `thinking_level_change`（恢复会话时用）。
   *
   * **只有「文件里真有这个会话且有消息」时才给** —— pi 的 `hasExistingSession` 是
   * `messages.length > 0`，一个空文件不算「已有会话」。
   */
  sessionLevel?: string | undefined;
  /** `settings.json` 的 `modelThinkingLevels["provider/id"]`（per-model 覆盖）。 */
  perModelLevel?: string | undefined;
  /** `settings.json` 的 `defaultThinkingLevel`（全局默认）。 */
  defaultLevel?: string | undefined;
}

/**
 * 解析启动档位（**不含 clamp** —— clamp 要模型，而模型在装配之后才有）。
 *
 * 顺序与 pi 的 `core/sdk.js:120-142` 逐条一致：
 * 1. `--thinking`；
 * 2. 会话里有 `thinking_level_change` → 用它；
 * 3. 会话**存在但没有那条记录** → `defaultThinkingLevel ?? medium`；
 * 4. 以上都还没有 → per-model 覆盖；
 * 5. 还没有 → `defaultThinkingLevel ?? medium`。
 *
 * 第 3 步就短路了（照抄 pi 的一个怪处）：于是「老会话 + 配了 per-model 覆盖」时用的是全局
 * 默认而不是 per-model。改了它，症状是「同一个会话在 pi 与本项目里恢复出来的档位不一样」。
 *
 * 非法值（手改过 settings.json / 会话文件）当作「没给」，退到下一级。
 */
export function resolveStartupThinkingLevel(input: StartupThinkingInput): ModelThinkingLevel {
  if (isThinkingLevel(input.cliLevel)) return input.cliLevel;
  if (isThinkingLevel(input.sessionLevel)) return input.sessionLevel;
  if (input.sessionLevel !== undefined) {
    // 会话在那、但没有合法的档位记录（老会话 / 值被改坏）→ 全局默认。
    return defaultWithFallback(input.defaultLevel);
  }
  if (isThinkingLevel(input.perModelLevel)) return input.perModelLevel;
  return defaultWithFallback(input.defaultLevel);
}

/**
 * 换模型之后用哪一档（pi 的 `_getThinkingLevelForModelSwitch` + clamp）。
 *
 * 顺序：作用域里给这个模型写死的档位 → per-model 覆盖 → 全局默认 → **当前这一档**
 * （照抄 pi：模型没配过时级别带着走，不会顺手改成 `medium`）。
 *
 * 最后必须 clamp 到新模型支持的那几档：否则会发出一个 provider 拒收的 reasoning 值。
 */
export function thinkingLevelForModelSwitch(
  model: Model<any> | undefined,
  input: {
    /** 作用域条目上写的档位（`ScopedModelItem.thinkingLevel`）。 */
    scopedLevel?: string | undefined;
    perModelLevel?: string | undefined;
    defaultLevel?: string | undefined;
    /** 换之前的那一档（`state.model.thinkingLevel`）。 */
    current: ModelThinkingLevel;
  },
): ModelThinkingLevel {
  const requested = isThinkingLevel(input.scopedLevel)
    ? input.scopedLevel
    : isThinkingLevel(input.perModelLevel)
      ? input.perModelLevel
      : isThinkingLevel(input.defaultLevel)
        ? input.defaultLevel
        : isThinkingLevel(input.current)
          ? input.current
          : DEFAULT_THINKING_LEVEL;
  return clampForModel(model, requested);
}

/** `defaultThinkingLevel ?? medium`（非法值当没给）。 */
function defaultWithFallback(defaultLevel: string | undefined): ModelThinkingLevel {
  return isThinkingLevel(defaultLevel) ? defaultLevel : DEFAULT_THINKING_LEVEL;
}

/**
 * 读 `settings.json` 的 `defaultThinkingLevel`（**原文，不校验**）。
 *
 * 读不到返回 `undefined` → 当作「没配过」，退到下一级来源。
 */
export function readDefaultThinkingLevel(cwd: string = process.cwd()): string | undefined {
  try {
    return SettingsManager.create(cwd, piAgentDir()).getDefaultThinkingLevel();
  } catch {
    return undefined;
  }
}

/** 读 per-model 覆盖 `modelThinkingLevels["provider/id"]`（原文，不校验）。 */
export function readModelThinkingLevel(
  provider: string,
  modelId: string,
  cwd: string = process.cwd(),
): string | undefined {
  try {
    return SettingsManager.create(cwd, piAgentDir()).getModelThinkingLevel(provider, modelId);
  } catch {
    return undefined;
  }
}

/**
 * 读**全部** per-model 覆盖（`/settings` 面板那一行要报「配了几个」）。
 *
 * 读不到返回 `{}`：空对象与「没配过」在面板上是同一句 `none`，返回 `undefined` 会让调用方
 * 多一个分支。
 */
export function readAllModelThinkingLevels(cwd: string = process.cwd()): Record<string, string> {
  try {
    return { ...SettingsManager.create(cwd, piAgentDir()).getAllModelThinkingLevels() };
  } catch {
    return {};
  }
}

/**
 * 读 `settings.json` 的 `thinkingBudgets`（各档 token 预算）。
 *
 * 只有 `minimal` / `low` / `medium` / `high` 四档（`xhigh` / `max` 取预算时归成 `high`）。
 * 思考与正文共一个 `max_tokens`，没有预算时一轮重度思考能把整个回复吃光。
 *
 * 非法值（手改过：字符串、负数、NaN）**逐项丢掉**而不是整个字段作废 —— 丢一项只少一个
 * 预算，整个作废会让另外三项也失效。
 *
 * 与 pi 同一步：**开局读一次**，所以聊到一半手改 settings.json 不会生效。
 */
export function readThinkingBudgets(cwd: string = process.cwd()): ThinkingBudgets | undefined {
  let raw: unknown;
  try {
    raw = SettingsManager.create(cwd, piAgentDir()).getThinkingBudgets();
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== 'object') return undefined;
  const budgets: ThinkingBudgets = {};
  for (const level of ['minimal', 'low', 'medium', 'high'] as const) {
    const value = (raw as Record<string, unknown>)[level];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      budgets[level] = Math.floor(value);
    }
  }
  return Object.keys(budgets).length > 0 ? budgets : undefined;
}

/**
 * 写 `defaultThinkingLevel`（`/thinking` 面板里的 `Ctrl+S`）。
 *
 * 落的是**用户请求的那一档，不是 clamp 之后的那一档**（与 pi 的 `persist: true` 一致）。
 * 写之前 clamp 的话，换模型再换回来时用户存的那一档就被永久改写了 —— 用户以为存的是
 * medium，盘上却是 high。下次启动会再 clamp 一次，结果一样。
 *
 * `await flush()` 的理由见 `writeHideThinkingBlock`：pi 的 `save()` 是入队异步写。
 */
export async function writeDefaultThinkingLevel(
  level: ModelThinkingLevel,
  cwd: string = process.cwd(),
): Promise<boolean> {
  return writeSetting(cwd, (settings) => settings.setDefaultThinkingLevel(level));
}

/** 写 per-model 覆盖（pi 的 `/settings` 里那一条；`Ctrl+S` 存的是全局默认）。 */
export async function writeModelThinkingLevel(
  provider: string,
  modelId: string,
  level: ModelThinkingLevel,
  cwd: string = process.cwd(),
): Promise<boolean> {
  return writeSetting(cwd, (settings) => settings.setModelThinkingLevel(provider, modelId, level));
}

/**
 * 删掉某个模型的覆盖（`/settings` 面板里的 `(clear override)`）。
 *
 * 与 pi 的 `removeModelThinkingLevel` 同义：删到空了就把整个 `modelThinkingLevels` 键
 * 也去掉（pi 也是这么干的），否则盘上会留一个空对象 —— 那是「配过又清光」的痕迹，
 * 下次有人读它时得先判空。
 */
export async function removeModelThinkingLevel(
  provider: string,
  modelId: string,
  cwd: string = process.cwd(),
): Promise<boolean> {
  return writeSetting(cwd, (settings) => settings.removeModelThinkingLevel(provider, modelId));
}

/** 写一份 settings 并等它真的落盘。失败（没权限 / 坏文件）返回 `false`，不抛。 */
async function writeSetting(
  cwd: string,
  mutate: (settings: SettingsManager) => void,
): Promise<boolean> {
  try {
    const settings = SettingsManager.create(cwd, piAgentDir());
    mutate(settings);
    await settings.flush();
    return settings.drainErrors().length === 0;
  } catch {
    return false;
  }
}