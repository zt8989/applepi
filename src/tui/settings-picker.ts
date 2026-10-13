/**
 * TUI 的「设置」面板 —— `/settings`（与 pi 同名）。
 *
 * ## 为什么用 pi 的零件搭，而不是复用 pi 的 `SettingsSelectorComponent`
 *
 * pi 那个组件的 `SettingsConfig` / `SettingsCallbacks` 是**全字段必填**（38 行），
 * 而有二十来行对应本项目**没有的功能**：fullscreen / TUI mode、cache warming、transport、
 * HTTP idle timeout、mermaid、install telemetry、project trust、tree filter……
 * 硬填上它们只有两种结果：要么把那些功能真做一遍（那是另一个量级的工作），要么写出
 * 一个「看着能改、改了没用」的开关 —— 而这个项目里最不愿留的就是那种东西
 * （见 `model-picker.ts` 里「假成功比报错更糟」那几句）。
 *
 * 所以这里用 pi 的**同一批零件**自己拼一屏（`SettingsList` + `SteppedSubmenu` +
 * `getSettingsListTheme` + `DynamicBorder`），形状与 pi 逐行一致（列表、右值、描述行、
 * `Enter/Space to change · Esc to cancel` 那行提示），**行**只放本项目真的会照着做的：
 *
 * | 这一行 | 写哪儿 | 谁生效 |
 * | --- | --- | --- |
 * | Auto-compact | `settings.json` 的 `compaction.enabled` | 内核当场开关自动压缩（`store.ts` 的 `AutoCompact`） |
 * | Hide thinking | `hideThinkingBlock` | 与本项目 `Ctrl+T` 同一个键、同一条渲染路径 |
 * | Default thinking level per model | `modelThinkingLevels` | 换模型/启动时按它解析（`thinking-level.ts`），当前模型则当场生效 |
 *
 * ## 那一行「Default thinking level per model」是逐字照搬 pi 的
 *
 * 它是这一步存在的**主要理由**（在这之前 `modelThinkingLevels` 只能手改 settings.json）：
 * 两步选择（先选模型、再选档位），档位那一步只列**这个模型支持的**那几档，已经配过的模型
 * 多一行 `(clear override)`（回到全局默认）。连文案与排序都照抄 —— 两边同一个操作见到的话
 * 应该是同一个东西，而这种「多步列表」的自创变体只会让回来的人多学一套。
 *
 * 没有的那二十来行**不是遗漏而是结论**：它们各自对应一个本项目还没有的功能。想加时是
 * 先有那个功能、再把那一行接上来，而不是反过来。
 */
import { Container, SettingsList, type SettingItem } from '@earendil-works/pi-tui';
import type { ViewportTUI } from '@earendil-works/pi-tui';
import type { Model } from '@earendil-works/pi-ai';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { getSettingsListTheme } from '@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { DynamicBorder } from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/dynamic-border.js';
import { SteppedSubmenu } from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/settings-submenu.js';
import { composerOverlayOptions } from './composer-overlay';
import { installProjectKeybindings, keyLabel } from './keybindings';

export interface SettingsPickerOptions {
  tui: ViewportTUI;
  /** 当前模型（per-model 那一屏把它排最前并打勾）。 */
  currentModel: Model<any> | undefined;
  /** per-model 那一屏的候选模型（通常是 runtime 的可用快照）。 */
  models: readonly Model<any>[];
  /**
   * `settings.json` 的 `defaultThinkingLevel`（没有就传内置 `medium`）。
   *
   * 只用来写那句 `Revert to global default (X)` —— pi 传的也是**设置里的全局默认**，
   * 而不是当前会话那一档（两者的区别正是「清掉覆盖之后会回到哪」）。
   */
  defaultThinkingLevel: string;
  /** 当前全局覆盖表（面板自己维护一份，用来算那一行右值 `N configured`）。 */
  modelThinkingLevels: Record<string, string>;
  /** 改某个模型的覆盖。调用方负责写盘 + 若是当前模型就同步会话。 */
  onModelThinkingLevelChange(provider: string, modelId: string, level: string): void;
  /** 清掉某个模型的覆盖（回到全局默认）。 */
  onModelThinkingLevelRemove(provider: string, modelId: string): void;
  /** 思考块默认折叠吗。 */
  hideThinkingBlock: boolean;
  /** 切换折叠（调用方写盘并重画 —— 与 `Ctrl+T` 同一条路）。 */
  onHideThinkingBlockChange(hidden: boolean): void;
  /** 自动压缩开着吗；`null` = 这个装配不支持压缩，那一行不显示。 */
  autoCompact: boolean | null;
  onAutoCompactChange(enabled: boolean): void;
}

/** 档位那一步里「清掉覆盖」的哨兵值（与 pi 同字面量）。 */
const CLEAR_OVERRIDE_VALUE = '__clear__';
/** pi 的档位说明文案，逐字照抄（`~1k tokens` 那种 —— 用户已经认它）。 */const THINKING_DESCRIPTIONS: Record<string, string> = {
  off: 'No reasoning',
  minimal: 'Very brief reasoning (~1k tokens)',
  low: 'Light reasoning (~2k tokens)',
  medium: 'Moderate reasoning (~8k tokens)',
  high: 'Deep reasoning (~16k tokens)',
  xhigh: 'Extra-high reasoning (~32k tokens)',
  max: 'Maximum reasoning',
};

/** `provider/id` —— per-model 覆盖的键（与 pi 的 `modelSettingKey` 同一形状）。 */
function modelKeyOf(model: Pick<Model<any>, 'provider' | 'id'>): string {
  return `${model.provider}/${model.id}`;
}

/** 那一行的右值：`none` / `N configured`（与 pi 的 `modelThinkingOverridesSummary` 同文案）。 */
function overridesSummary(overrides: Record<string, string>): string {
  const count = Object.keys(overrides).length;
  return count === 0 ? 'none' : `${count} configured`;
}

/**
 * 面板的外壳：上下两条横线 + 列表 + **键盘焦点**。
 *
 * ## 为什么要自己写这一层（而不是直接把 `SettingsList` 塞进 `showOverlay`）
 *
 * pi-tui 的焦点判据是 `"focused" in component`（`isFocusable()`）—— 而 `SettingsList`
 * 没有 `focused` 这个属性，所以直接塞进去时覆盖层拿到了焦点、按键却没人接：症状是
 * 「面板画得好好的，上下键与 Esc 全无反应，只能 `Ctrl+C` 退出」（实测过）。
 *
 * pi 那边没这个问题：它把列表放进 `editorContainer` 再 `ui.setFocus(list)`；本项目
 * 所有面板都走覆盖层，所以在这里补一个最小的可聚焦外壳。
 *
 * 鼠标/滚轮**不重写**：`Container.handleMouse` 自己按行坐标找到列表（它就是中间那个孩子）。
 */
class SettingsOverlay extends Container {
  /** pi-tui 认这个字段（`isFocusable` 就是看 `"focused" in component`）。 */
  focused = false;

  constructor(private readonly list: SettingsList) {
    super();
    this.addChild(new DynamicBorder());
    this.addChild(list);
    this.addChild(new DynamicBorder());
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }
}

/** 打开设置面板；返回关闭函数（与 `openModelPicker` 同一形状）。 */
export function openSettingsPicker(options: SettingsPickerOptions): () => void {
  const { tui } = options;

  // 装键位表到 pi-tui 全局 —— 与其它面板同一句理由：`SettingsList` / `SelectSubmenu`
  // 读的是全局键位（`tui.select.*`），不装的话上下键与 Esc 会**静默失效**。
  installProjectKeybindings();

  // 面板自己维护一份覆盖表：`(clear override)` 之后那一行右值要立刻变成 `none`，
  // 而写盘是异步的 —— 重读 settings 会读到旧值。
  const overrides: Record<string, string> = { ...options.modelThinkingLevels };
  const defaultModelByKey = new Map(options.models.map((model) => [modelKeyOf(model), model]));
  const currentModelKey = options.currentModel ? modelKeyOf(options.currentModel) : undefined;

  const items: SettingItem[] = [];

  // pi 的顺序：Auto-compact 在最前，然后 Hide thinking，再是 per-model 档位。
  if (options.autoCompact !== null) {
    items.push({
      id: 'autocompact',
      label: 'Auto-compact',
      description: 'Automatically compact context when it gets too large',
      currentValue: options.autoCompact ? 'true' : 'false',
      values: ['true', 'false'],
    });
  }
  items.push({
    id: 'hide-thinking',
    label: 'Hide thinking',
    description: 'Hide thinking blocks in assistant responses',
    currentValue: options.hideThinkingBlock ? 'true' : 'false',
    values: ['true', 'false'],
  });
  items.push({
    id: 'model-thinking',
    label: 'Default thinking level per model',
    description: `Override the default thinking level for specific models. ${keyLabel('app.thinking.cycle')} cycles in-session.`,
    currentValue: overridesSummary(overrides),
    submenu: (_currentValue, done) => {
      const steps = [
        {
          key: 'model',
          title: 'Per-Model Thinking Level',
          description: 'Select a model to configure',
          options: () => {
            // 排序与 pi 一致：当前模型置顶，其余按 `provider/id` 排 —— 列表有 1500 条时
            // 「我要改的那个」总在第一个位置，不必搜。
            const sorted = [...options.models].sort((a, b) => {
              const aKey = modelKeyOf(a);
              const bKey = modelKeyOf(b);
              if (aKey === currentModelKey) return -1;
              if (bKey === currentModelKey) return 1;
              return aKey.localeCompare(bKey);
            });
            if (sorted.length === 0) {
              return [
                {
                  value: '',
                  label: 'No models available',
                  description: 'Log in to a provider or configure an API key first',
                },
              ];
            }
            return sorted.map((model) => ({
              value: modelKeyOf(model),
              label: `${model.id} [${model.provider}]${overrides[modelKeyOf(model)] !== undefined ? ` · ${overrides[modelKeyOf(model)]}` : ''}`,
            }));
          },
          preselect: () => currentModelKey,
          searchable: true,
          layout: { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 46 },
        },
        {
          key: 'level',
          title: (ctx: Record<string, string>) => {
            const selected = defaultModelByKey.get(ctx['model'] ?? '');
            return `Thinking Level for ${selected ? `${selected.id} [${selected.provider}]` : (ctx['model'] ?? '')}`;
          },
          description: 'Select default thinking level for this model',
          options: (ctx: Record<string, string>) => {
            const selected = defaultModelByKey.get(ctx['model'] ?? '');
            if (!selected) return [];
            // 只列**这个模型支持的**档位 —— 把模型不认的档位写进 settings 只会在下次
            // 启动时被 clamp 掉，用户以为存下了别的。
            const levels = selected.reasoning ? getSupportedThinkingLevels(selected) : ['off'];
            const active = overrides[ctx['model'] ?? ''];
            const list = levels.map((level) => ({
              value: level,
              label: `${level === active ? '✓ ' : '  '}${level}`,
              ...(THINKING_DESCRIPTIONS[level] === undefined
                ? {}
                : { description: THINKING_DESCRIPTIONS[level] }),
            }));
            if (active !== undefined) {
              list.push({
                value: CLEAR_OVERRIDE_VALUE,
                label: '  (clear override)',
                description: `Revert to global default (${options.defaultThinkingLevel})`,
              });
            }
            return list;
          },
          preselect: (ctx: Record<string, string>) => overrides[ctx['model'] ?? ''],
        },
      ];
      // `loop: true` 与 pi 一致：配完一个模型回到「选模型」那一步，连着配好几个不用重开面板。
      return new SteppedSubmenu(
        steps as never,
        (selections: Record<string, string>) => {
          const model = defaultModelByKey.get(selections['model'] ?? '');
          if (!model) return;
          const key = modelKeyOf(model);
          const level = selections['level'];
          if (level === undefined) return;
          if (level === CLEAR_OVERRIDE_VALUE) {
            options.onModelThinkingLevelRemove(model.provider, model.id);
            delete overrides[key];
            return;
          }
          options.onModelThinkingLevelChange(model.provider, model.id, level);
          overrides[key] = level;
        },
        () => {
          // Esc 关掉子菜单时才回写那一行的右值（与 pi 同一处：`done(summary())`）。
          done(overridesSummary(overrides));
        },
        { loop: true },
      );
    },
  });

  const list = new SettingsList(items, 10, getSettingsListTheme(), (id, newValue) => {
    switch (id) {
      case 'autocompact':
        options.onAutoCompactChange(newValue === 'true');
        break;
      case 'hide-thinking':
        options.onHideThinkingBlockChange(newValue === 'true');
        break;
      default:
        // `model-thinking` 走的是 `submenu` + `done(selectedValue)` 那条路，
        // 值在打开子菜单时就地生效 —— 这里不该再有分支。
        break;
    }
  }, () => {
    close();
    tui.requestRender();
  });

  // 与 pi 的 `SettingsSelectorComponent` 同一层壳：上下两条横线夹住列表，
  // 再盖住 composer（与 `/model` / `/thinking` 同一份参数）。
  const overlay = new SettingsOverlay(list);

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    handle?.hide();
  }

  const handle = tui.showOverlay(overlay, composerOverlayOptions());

  return close;
}