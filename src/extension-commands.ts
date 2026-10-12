/**
 * 扩展的斜杠命令与快捷键。
 *
 * ## 为什么接（以及为什么之前不接）
 *
 * 早先「命令不接」的理由是：pi 的命令 handler 拿 `ExtensionCommandContext`，
 * 而那个 ctx 有 `waitForIdle` / `newSession` / `fork` / `navigateTree` /
 * `switchSession` / `reload` —— 本项目一个都没实现。接了就在 handler 里炸。
 *
 * 那个理由**过了一半**：那六个**确实**不接，但 handler 真正要的东西少得多。
 * `pi-web-access` 那四个命令（`/websearch` `/curator` `/google-account` `/search`）
 * 只用到：
 *
 * | 成员 | 用在哪 |
 * | --- | --- |
 * | `ctx.ui.notify` | 结果提示（×10） |
 * | `ctx.ui.select` | `/search` 列历史结果让用户选（×2） |
 * | `pi.sendMessage` | 把结论送回对话（×5） |
 *
 * 三个都有真的实现。于是接它不是「半吊子」。
 *
 * ## 仍然不接的六个
 *
 * `waitForIdle` / `newSession` / `fork` / `navigateTree` / `switchSession` / `reload`
 * —— 那是 pi 的**会话层**（见 [surfaces](surfaces.md)「为什么不用 pi 自己的
 * InteractiveMode」）。给它们 reject 掉，扩展要调时会说清「本项目不支持」，
 * 而不是 `undefined is not a function`（那个栈与真因隔了三层）。
 *
 * ## 命令表是**界面**的，不是内核的
 *
 * 补全列表与 `/help` 都念 `tui/app.ts` 的 `SLASH_COMMANDS`（唯一真相）。所以扩展的
 * 命令**不并进那一份**，而是走一条单独的通道：`runCommand` 找不到自己的命令时，
 * 问扩展要。理由是那份表是**常量**（补全 provider 每次 `getSuggestions` 现取），
 * 而扩展的命令要等 `loadExtensions()` 装载完才知道 —— 与 skill 命令同一种情况，
 * 那一条已经用 `commandTable()` 这个函数解决了。
 *
 * ## 快捷键：只接扩展自己声明的
 *
 * `pi.registerShortcut` 声明的是按键 + handler。`pi-web-access` 要两个
 * （`ctrl+shift+s` 审搜索结果、`ctrl+shift+w` 活动面板）。我们把它们挂到同一个
 * `tui.addInputListener` 上 —— 与内置的那几个开关（轨迹页 / 展开工具 / 中断…）并列。
 *
 * **冲突怎么办**：`handleInput` 返回 `{consume: true}` 表示吃掉了。我们**先问扩展**
 * 再走内置的 —— 于是扩展可以覆盖内置键（那是它的本意），但也**可能抢走用户的
 * 那些开关**。所以先查内置的键：它们是本项目的「开关」，被抢走的话界面看着
 * 没反应。顺序即优先级，写在这里。
 */
import type { ExtensionRunner } from '@earendil-works/pi-coding-agent/dist/core/extensions/runner.js';
import type { SlashCommand, TuiInputListener } from '@earendil-works/pi-tui';
import { matchesKey } from '@earendil-works/pi-tui';
import type { AgentStore } from './store';

/** 扩展注册的命令（我们只用到这两个字段）。 */
export interface ExtensionCommand {
  name: string;
  description?: string | undefined;
  handler: (args: string, ctx: unknown) => unknown | Promise<unknown>;
}

/** 扩展注册的快捷键。 */
export interface ExtensionShortcut {
  /** pi-tui 的 KeyId 形状（`ctrl+shift+s`）。 */
  key: string;
  description?: string | undefined;
  handler: (ctx: unknown) => unknown | Promise<unknown>;
}

export interface ExtensionCommands {
  /** 补全列表用（`/name` + 说明）。 */
  list(): readonly SlashCommand[];
  /** 界面的 `runCommand` 兜底：扩展有没有这个命令？ */
  has(name: string): boolean;
  /** 调它。抛错由界面转成一行提示。 */
  run(name: string, args: string): Promise<void>;
  /**
   * 快捷键的 raw input 钩子。**必须挂在内置键之后调**（见文件头「冲突怎么办」）。
   *
   * @param builtins 先跑内置的那几个开关；返回 true 表示已消费。
   */
  handleKey(data: string, builtins: () => boolean): Promise<boolean>;
  /**
   * 扩展声明的快捷键清单 —— `/hotkeys` 的 `Extensions` 一节要它。
   *
   * 与 pi 一样单独一节、排在最后（它的 `handleHotkeysCommand()` 也是这么做的）。
   * 这里给的是**声明值**（`ctrl+shift+s` 这种 `KeyId` 形状），不是解析后的键：
   * pi 那边的 `getShortcuts()` 拿一份 `resolvedKeybindings` 是为了做冲突检查，
   * 而本项目不做冲突检查（见文件头），所以不需要那份输入。
   */
  shortcuts(): readonly { key: string; description?: string | undefined }[];
}

/**
 * 装命令与快捷键。
 *
 * @param runner     扩展运行时（造 `ctx` 用）
 * @param store      本项目的 store（`sendMessage` 往里 dispatch）
 * @param onError    handler 抛错时的去处（界面那张命令反馈卡）
 * @param onMessage  `pi.sendMessage` 的落点 —— 界面把它当用户消息发出去
 */
export function installExtensionCommands(options: {
  runner: ExtensionRunner;
  store: AgentStore;
  onError(where: string, message: string): void;
  onMessage(text: string): void;
  canSend: () => boolean;
  /**
   * 扩展声明的快捷键。
   *
   * **从 `loadExtensions()` 的返回值里取，不走 `runner.getShortcuts()`** ——
   * 那个方法要一份 `resolvedKeybindings`（pi 的 keybindings 配置文件解析结果），
   * 而本项目**不读** pi 的 `settings.json` keybindings 段（那是 pi 应用层的事）。
   * 给它 `{}` 的话它会解出**一套默认键**，而那些键与本项目界面自己的键位表
   * 没关系 —— 症状是「按了没反应」而配置里明明写着一个键。
   *
   * 扩展声明的 `shortcut` 本身已经是 pi-tui 的 `KeyId` 形状（`ctrl+shift+s`），
   * 所以直接喂 `matchesKey` 就好。
   */
  shortcuts: readonly { shortcut: string; description?: string; handler: (ctx: unknown) => unknown }[];
}): ExtensionCommands {
  const commands = new Map<string, ExtensionCommand>();
  const shortcuts: ExtensionShortcut[] = options.shortcuts.map((s) => ({
    key: s.shortcut,
    ...(s.description !== undefined ? { description: s.description } : {}),
    handler: s.handler as ExtensionShortcut['handler'],
  }));

  /** pi 那边命令是 `runner.getRegisteredCommands()`（带 sourceInfo 那些）。 */
  const refresh = (): void => {
    commands.clear();
    for (const c of options.runner.getRegisteredCommands()) {
      commands.set(c.name, {
        name: c.name,
        ...(c.description !== undefined ? { description: c.description } : {}),
        handler: c.handler as ExtensionCommand['handler'],
      });
    }
  };
  refresh();

  const makeCtx = (): unknown => {
    // 命令 context 只需要 `ui`（+ 几个只读的）。那六个会话操作**不给** ——
    // `createCommandContext()` 会把它们全填上「cancelled: true」或 no-op，
    // 那比 undefined 更坏：扩展会以为「fork 被用户取消了」而继续往下走。
    //
    // 所以这里**不调** `createCommandContext()`，自己给一个只有 ui 的窄 ctx。
    return {
      ui: (options.runner.getUIContext() ?? {}) as unknown,
      hasUI: options.runner.hasUI(),
      isIdle: () => options.store.getState().phase === 'idle',
      cwd: process.cwd(),
      model: undefined,
    };
  };

  return {
    list: () =>
      [...commands.values()].map((c) => ({
        name: c.name,
        ...(c.description !== undefined ? { description: c.description } : {}),
      })),

    shortcuts: () =>
      shortcuts.map((s) => ({
        key: s.key,
        ...(s.description !== undefined ? { description: s.description } : {}),
      })),

    has: (name) => commands.has(name),

    run: async (name, args) => {
      const command = commands.get(name);
      if (!command) throw new Error(`未知命令 /${name}`);
      // 环在跑的时候不能跑命令：扩展的 handler 常常要 `pi.sendMessage` 把结果送回对话，
      // 而那时环正在等 token —— 中途插消息会让 `state.messages` 与「这一轮的请求」对不上。
      if (!options.canSend()) {
        throw new Error('上一回合还没结束，等它跑完再执行这个命令');
      }
      await command.handler(args, makeCtx());
    },

    handleKey: async (data, builtins) => {
      // 内置的先走（那几个开关被扩展抢走的话，界面看着「按了没反应」）。
      if (builtins()) return true;
      for (const shortcut of shortcuts) {
        if (!matchesKey(data, shortcut.key as never)) continue;
        await shortcut.handler(makeCtx());
        return true;
      }
      return false;
    },
  };
}
