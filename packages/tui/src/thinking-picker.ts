/**
 * TUI 的「思考级别」弹窗 —— `/thinking` 打开（或 `/thinking <级别>` 直接切）。
 *
 * ## 为什么直接用 pi 官方的 `ThinkingSelectorComponent`
 *
 * 与 `/model`（见 `model-picker.ts`）**同一个理由**：这个面板的交互面窄，但每一条都要与
 * pi 对齐才有意义 —— 当前那一档打勾、`Ctrl+S` 存默认、`· default` 标记、模糊搜索、
 * 底部那行按键提示、每一档的说明文案（`Deep reasoning (~16k tokens)` 那种）：
 *
 * ```text
 *   ────────────────────────────────────────────────
 *   Thinking Level
 *
 *   Shift+Tab cycles thinking levels in-session
 *
 *   > 搜索…
 *   ✓ high        Deep reasoning (~16k tokens) · default
 *     low         Light reasoning (~2k tokens)
 *     max         Maximum reasoning
 *
 *   Enter to select · Ctrl+S to set as default · Escape to cancel
 *   ────────────────────────────────────────────────
 * ```
 *
 * 复刻它要抄一份档位说明表 + 模糊搜索 + 打勾/默认标记，而那张说明表在 pi 那边会漂移。
 *
 * ## `Ctrl+S` 落的是哪一档
 *
 * pi 的 `selectThinkingLevel(level, persist)` → `session.setThinkingLevel(level, {persist})`
 * → `settingsManager.setDefaultThinkingLevel(level)`：写的是**用户请求的那一档**（不 clamp）。
 * 本项目同一处：`onSelectAsDefault` 交给调用方去写 `defaultThinkingLevel`（见
 * `thinking-level.ts` 的 `writeDefaultThinkingLevel`）。
 *
 * ## 与 `/model` 面板的两处不同
 *
 * 1. **`Shift+Tab` 不落盘**（pi 的 `cycleThinkingLevel()` 没带 `persist`），只有这个
 *    面板里的 `Ctrl+S` 才存默认 —— 所以这里没有「循环」的接线。
 * 2. 换档位**不需要内核出手**：`thinking.changed` 只改 state 里的一个字段（不像换模型要
 *    重装能力与窗口），所以调用方直接 dispatch。
 */
import { ThinkingSelectorComponent } from '@earendil-works/pi-coding-agent';
import type { ViewportTUI } from '@earendil-works/pi-tui';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import { installProjectKeybindings } from './keybindings';
import { composerOverlayOptions } from './composer-overlay';
import { DEFAULT_THINKING_LEVEL, isThinkingLevel } from '@ela/core/thinking-level';

export interface ThinkingPickerOptions {
  tui: ViewportTUI;
  /** 当前这一档 —— 面板据此打勾、并把它预选中。 */
  current: string;
  /**
   * 这个模型支持的档位（`pi-actions.ts` 的 `supportedThinkingLevels`）。
   *
   * 空数组时**调用方不该开这个面板**（官方组件会画一个没有选项的空框），
   * 而应该报「当前模型不支持 thinking」。判断留在调用方：那一句提示的位置只有一个。
   */
  levels: readonly string[];
  /**
   * `settings.json` 的 `defaultThinkingLevel`（没有就是内置 `medium`）—— 面板用它标
   * `· default`。与 pi 的 `getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL` 同一句。
   */
  defaultLevel: string | undefined;
  /** 选中（`Enter`）：换这一档，**不**写 settings。 */
  onSelect(level: ModelThinkingLevel): void;
  /** `Ctrl+S`：换这一档**并**写进 `settings.json` 的 `defaultThinkingLevel`。 */
  onSelectAsDefault(level: ModelThinkingLevel): void;
}

/** 打开思考级别弹窗；返回关闭函数（与 `openModelPicker` 同一形状）。 */
export function openThinkingPicker(options: ThinkingPickerOptions): () => void {
  const { tui } = options;

  // 装键位表到 pi-tui 全局 —— 与 model-picker / session-picker 同一句理由：
  // 这个组件读的是 `app.thinking.save`（`Ctrl+S`）与 `app.thinking.cycle`（那行提示里的键名），
  // 而 pi-tui 自带那份里没有它们，不装的话「Ctrl+S 存默认」**静默失效**、
  // 提示里那半句键名变成空串。
  installProjectKeybindings();

  // 组件要的类型是 pi-agent-core 的 `ThinkingLevel`，与 pi-ai 的 `ModelThinkingLevel`
  // 是同一个联合的各一份声明 —— 传不进去只能强转（与 model-picker 里 `tui as never`
  // 同一类「两份同名类型」的摩擦，不是真类型错误）。
  const selector = new ThinkingSelectorComponent(
    (isThinkingLevel(options.current) ? options.current : DEFAULT_THINKING_LEVEL) as never,
    [...options.levels] as never,
    (level) => {
      close();
      options.onSelect(level as ModelThinkingLevel);
    },
    () => {
      close();
      tui.requestRender();
    },
    (level) => {
      close();
      options.onSelectAsDefault(level as ModelThinkingLevel);
    },
    (options.defaultLevel ?? DEFAULT_THINKING_LEVEL) as never,
  );

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    handle?.hide();
  }

  // 覆盖层：与 `/model` / `/scoped-models` 同一份参数（盖住 composer，不居中浮窗）。
  // 这个面板比模型面板矮得多，不需要限高（`composerOverlayOptions()` 本来也不给上限）。
  const handle = tui.showOverlay(selector, composerOverlayOptions());

  return close;
}