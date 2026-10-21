/**
 * 扩展的斜杠命令与快捷键。
 *
 * 命令 handler 拿到的是 `ExtensionCommandContext`，其中六个成员（`waitForIdle` /
 * `newSession` / `fork` / `navigateTree` / `switchSession` / `reload`）属于 pi 的**会话层**，
 * 本项目不接：给它们 reject 掉，扩展调时会收到「本项目不支持」，而不是
 * `undefined is not a function`。实际扩展只要 `ctx.ui.notify` / `ctx.ui.select` /
 * `pi.sendMessage`，三个都有真实现。
 *
 * 命令表是**界面**的（`tui/app.ts` 的 `SLASH_COMMANDS`），扩展命令**不并进去**：
 * 那份表是常量，而扩展命令要等 `loadExtensions()` 才知道，所以走单独通道 ——
 * `runCommand` 找不到自己的命令时才问扩展。
 *
 * 快捷键只接扩展自己声明的（`pi.registerShortcut`），挂在同一个 `tui.addInputListener` 上，
 * 与内置开关并列。**先跑内置键**：`handleInput` 返回 `{consume: true}` 就是吃掉，
 * 让扩展优先的话它会抢走本项目的开关，界面看着「按了没反应」。顺序即优先级。
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
   * 快捷键的 raw input 钩子。**必须挂在内置键之后调**（见文件头）。
   *
   * @param builtins 先跑内置的那几个开关；返回 true 表示已消费。
   */
  handleKey(data: string, builtins: () => boolean): Promise<boolean>;
  /**
   * 扩展声明的快捷键清单 —— `/hotkeys` 的 `Extensions` 一节要它，单独一节、排在最后。
   *
   * 给的是**声明值**（`ctrl+shift+s` 这种 `KeyId` 形状），不是解析后的键。
   */
  shortcuts(): readonly { key: string; description?: string | undefined }[];
}

/**
 * 装命令与快捷键。
 *
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
   * **从 `loadExtensions()` 的返回值里取，不走 `runner.getShortcuts()`** —— 后者要一份
   * `resolvedKeybindings`（pi 配置的解析结果），给 `{}` 它会解出一套与本项目无关的默认键，
   * 症状是「按了没反应」而配置里明明写着一个键。
   *
   * 声明值本身已是 pi-tui 的 `KeyId` 形状，直接喂 `matchesKey` 即可。
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
    // 只给 `ui` 与几个只读项。那六个会话操作也不给：`createCommandContext()` 会把它们
    // 全填上「cancelled: true」或 no-op，比 undefined 更坏 —— 扩展会以为「fork 被取消了」
    // 而继续往下走。
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
      // 环在跑的时候不能跑命令：handler 常要 `pi.sendMessage` 把结果送回对话，而那时环
      // 正在等 token —— 中途插消息会让 `state.messages` 与这一轮的请求对不上。
      if (!options.canSend()) {
        throw new Error('上一回合还没结束，等它跑完再执行这个命令');
      }
      await command.handler(args, makeCtx());
    },

    handleKey: async (data, builtins) => {
      // 内置的先走：那几个开关被扩展抢走的话，界面看着「按了没反应」。
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
