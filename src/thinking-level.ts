/**
 * 思考级别（reasoning effort）—— **解析与落盘的唯一入口**，规则逐条照抄 pi。
 *
 * ## 为什么单独一个文件
 *
 * 「启动时用哪一档」在 pi 那边是 `core/sdk.js:84-142` 那二十来行，看着简单，其实有五条
 * 来源（命令行 / 会话文件 / settings 的 per-model 覆盖 / settings 的全局默认 / 内置
 * `medium`）和一道 clamp（模型支持哪几档）。散在 `tui.ts` / `kernel.ts` / 界面里各写一份
 * 的症状是「启动那个档位与 `/thinking` 面板上打勾的那个不是同一个」——而且**只在配了
 * settings 时才看得出来**，极难归因。所以这里一份纯函数 + 一份 settings 读写。
 *
 * ## 与 pi 的对应关系
 *
 * | 这里的 | pi 的 |
 * | --- | --- |
 * | `resolveStartupThinkingLevel` | `core/sdk.js:120-142`（`createAgentSession` 里那段） |
 * | `thinkingLevelForModelSwitch` | `AgentSession._getThinkingLevelForModelSwitch` + `setThinkingLevel` 的 clamp |
 * | `clampForModel` | pi-ai 的 `clampThinkingLevel`（**转调，不自己实现**） |
 * | `writeDefaultThinkingLevel` | `SettingsManager.setDefaultThinkingLevel`（`/thinking` 里 `Ctrl+S`） |
 * | `readModelThinkingLevel` | `SettingsManager.getModelThinkingLevel`（`/settings` 的 per-model 覆盖） |
 *
 * clamp 直接用 pi-ai 导出的那个函数而不是自己写一遍：那张「哪些档位映射成什么」的表在
 * pi-ai 的模型目录里，抄一份必然漂移，而漂移的症状是「pi 显示 high，本项目显示 low」。
 */
import {
  clampThinkingLevel,
  type Model,
  type ModelThinkingLevel,
} from '@earendil-works/pi-ai';
import { SettingsManager } from '@earendil-works/pi-coding-agent/dist/core/settings-manager.js';
import { piAgentDir } from './pi-config';

/**
 * 全部合法档位，**顺序就是 pi 的顺序**（`EXTENDED_THINKING_LEVELS`）。
 *
 * 顺序有意义：clamp 是「先往上找、找不到再往下找」，而 pi-ai 内部按同一顺序排；这里排错
 * 会让「非法值」的校验通过（顺序本身不影响 clamp，因为 clamp 在 pi-ai 那边）。
 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * 内置默认档位（pi 的 `core/defaults.js` 的 `DEFAULT_THINKING_LEVEL`）。
 *
 * 是 `medium` 而不是 `high` —— 「默认就是 high」是「默认 medium + 模型只认 low/high/max +
 * 向上取整」三步的结果（见 `clampForModel` 的注释），不是 pi 把默认写成了 high。
 */
export const DEFAULT_THINKING_LEVEL: ModelThinkingLevel = 'medium';

/** 命令行 / settings.json 里的值是不是一个合法档位。 */
export function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * 把级别 clamp 到模型支持的那几档（pi-ai 的 `clampThinkingLevel`）。
 *
 * ## 为什么 `medium` 会变成 `high`
 *
 * 判据是模型的 `thinkingLevelMap`：映射成 `null` 的档位**不支持**，没写这个键的档位默认
 * **支持**（`xhigh` / `max` 例外：必须显式映射）。例如 `qwen-token-plan-cn/deepseek-v4.1-flash`
 * 是 `{off:null, minimal:null, low:'low', medium:null, high:'high', xhigh:null, max:'max'}`：
 * 支持集 = `low` / `high` / `max`，而 clamp 是「从当前档位往上找第一个支持的」，
 * 于是 `medium` → `high`、`off` → `low`（**这个模型上根本关不掉思考**）。
 *
 * 模型给不出来（没装配）时返回 `off` —— 与 pi 的 `if (!model) thinkingLevel = "off"` 同一句。
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
 *
 * 1. `--thinking`；
 * 2. 会话里有 `thinking_level_change` → 用它；
 * 3. 会话**存在但没有那条记录** → `defaultThinkingLevel ?? medium`；
 * 4. 以上都还没有 → per-model 覆盖；
 * 5. 还没有 → `defaultThinkingLevel ?? medium`。
 *
 * ## 为什么第 3 步就短路了（照抄 pi 的一个怪处）
 *
 * 第 3 步已经给了一个值，于是第 4 步的 per-model 覆盖**不会被看到** —— 也就是说
 * 「老会话（早先的版本没写过 thinking 条目）+ 配了 per-model 覆盖」时，pi 用的是全局默认
 * 而不是 per-model。这是 pi 的实际行为，照抄：改了它，症状是「同一个会话在 pi 与本项目里
 * 恢复出来的档位不一样」，而那正是本文件要消灭的那类分歧。
 *
 * 非法值（手改过 settings.json / 会话文件）当作「没给」—— 不抛，退到下一级。
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
 * 顺序：作用域里给这个模型写死的档位（`/scoped-models` 的 `p/i:high`）→ per-model 覆盖 →
 * 全局默认 → **当前这一档**（照抄 pi：模型没配过时级别**带着走**，不会顺手改成 `medium`）。
 * 最后 clamp 到新模型支持的那几档 —— 换到一个不支持当前档位的模型时必须夹，否则会发出
 * 一个 provider 拒收的 reasoning 值。
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

// ─── settings.json 那一侧（与 `model-scope.ts` 的 `enabledModels` 同一份 settings） ───

/**
 * 读 `settings.json` 的 `defaultThinkingLevel`（**原文，不校验**）。
 *
 * 读不到（没配过 / 文件坏了 / 没权限）返回 `undefined`：级别是可选功能，读不出来就当
 * 「没配过」，退到下一级来源 —— 与 `readHideThinkingBlock` 同一处理。
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
 * 写 `defaultThinkingLevel`（`/thinking` 面板里的 `Ctrl+S`）。
 *
 * 落的是**用户请求的那一档，不是 clamp 之后的那一档** —— 与 pi 的
 * `setThinkingLevel(level, { persist: true })` 一致（它 `setDefaultThinkingLevel(level)` 传的是
 * 请求值）。所以在 `deepseek-v4.1-flash` 上「存 medium」等于「存 high」：下次启动会再 clamp
 * 一次，结果一样。**不**在写之前 clamp：那样换个模型再换回来时，用户存的那一档就被永久
 * 改写了（用户以为存的是 medium，盘上却是 high）。
 *
 * async + `flush()` 的理由与 `writeHideThinkingBlock` 同一句：pi 的 `save()` 是入队异步写，
 * 不等它落盘的话，调用方紧接着读会读到旧值，而写失败也拿不到。
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