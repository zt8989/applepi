/**
 * `/` 命令在浏览器侧的执行。
 *
 * ## 分工
 *
 * 命令表由服务端给（`GET /api/commands`，与 TUI 的补全同一份 —— 加命令只改一处）。
 * 这里只负责**怎么把一条命令变成界面动作**：
 *
 * | 命令 | 浏览器里怎么做 |
 * | --- | --- |
 * | `/model` | 弹已有的模型选择器；`/model <id>` 直接 POST |
 * | `/thinking` | 弹档位列表；带参数直接 POST |
 * | `/settings` | 设置面板（常规 / 模型 / 技能 / 子代理 / 插件 / MCP）；这一条落在「常规」 |
 * | `/scoped-models` | 同一个设置面板的「模型」分区（可用模型 / 作用域） |
 * | `/skills` | 同一个设置面板的「技能」分区（只读清单，可点开看详情） |
 * | 扩展命令 | `POST /api/command`（服务端跑） |
 * | `/skill:<名字>` | **不走这里** —— 当普通消息发出去，服务端展开成 `<skill>` 块 |
 * | `/模板名 [参数]` | **不走这里** —— 命令表里 `source: 'prompt'` 的那些当普通消息发出，由服务端展开（正文在磁盘上） |
 * | 未命中的 `/xxx` | **不走这里** —— 返回 false，当普通消息发给模型（与 pi 一致，不报错） |
 *
 * 会话类命令（`/new` `/resume` `/compact` `/session` …）服务端**不下发**，所以这里也不认
 * —— 前端只做服务端说能做的。
 */

import { elaApi } from './api';
import { openModal, type ModalRow } from './modal';
import { openSettingsPanel } from './settings-panel';

export interface CommandContext {
  /** 顶部提示行（与开场诊断同一处）。 */
  notice(text: string, tone?: 'info' | 'warn' | 'error'): void;
  /** 打开模型选择器（`model-picker.ts`，目录从 `/api/models` 现取）。 */
  openModelPicker(): void;
}

/** 拆一条 `/命令 参数…`。开头不是 `/` 就给 `null`（= 当普通消息发）。 */
export function parseCommand(text: string): { name: string; arg: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const [name = '', ...rest] = trimmed.slice(1).split(/\s+/);
  return name === '' ? null : { name, arg: rest.join(' ') };
}

/** 回执里 `ok: false` 的 `message` 直接当一行警示。 */
function report(result: { ok: boolean; message?: string | undefined }, ctx: CommandContext, okText?: string): void {
  if (!result.ok) {
    ctx.notice(result.message ?? '操作失败', 'warn');
    return;
  }
  if (okText !== undefined) ctx.notice(okText);
}

async function runThinking(arg: string, ctx: CommandContext): Promise<void> {
  const info = await elaApi.thinking();
  if (arg.trim() !== '') {
    report(await elaApi.setThinking(arg.trim()), ctx, `思考级别 → ${arg.trim()}`);
    return;
  }
  const modal = openModal({ title: '思考级别', footer: '↑↓ 选择 · Enter 切换 · Esc 关闭' });
  const rows = (): ModalRow[] =>
    info.levels.map((level) => ({
      label: level,
      ...(level === info.current ? { mark: '✓', active: true } : { mark: ' ' }),
      ...(level === info.default ? { hint: '默认' } : {}),
      onPick: () => {
        void elaApi.setThinking(level).then((result) => {
          modal.close();
          report(result, ctx, `思考级别 → ${level}`);
        });
      },
    }));
  modal.setRows(rows());
}

/** 跑一条命令。返回 `true` = 已处理（**不要**再当消息发给模型）。 */
export async function runCommand(name: string, arg: string, ctx: CommandContext): Promise<boolean> {
  switch (name) {
    case 'model':
      if (arg.trim() === '') {
        ctx.openModelPicker();
        return true;
      }
      report(await elaApi.setModel(arg.trim()), ctx, `模型 → ${arg.trim()}`);
      return true;
    case 'thinking':
      await runThinking(arg, ctx);
      return true;
    case 'settings':
      openSettingsPanel({ tab: 'general', notice: ctx.notice });
      return true;
    case 'scoped-models':
      openSettingsPanel({ tab: 'models', notice: ctx.notice });
      return true;
    case 'skills':
      openSettingsPanel({ tab: 'skills', notice: ctx.notice });
      return true;
    default: {
      // 只有**扩展命令**走服务端执行；其余未命中的 `/xxx`（prompt 模板、`/new` 这类
      // 只在终端里实现的命令、以及 `/etc/hosts` 这样的普通输入）一律返回 false ——
      // 当普通消息发给模型。命令层不能把未命中的输入报错或吞掉（与 pi 一致）。
      //
      // 名字与扩展命令撞车时**扩展优先**（与 pi 的「扩展命令先执行」一致）；
      // 与内置命令撞车时到不了这里（switch 上面已经接住了）。
      const commands = await elaApi.commands();
      const isExtension = commands.some(
        (command) => command.name === name && command.source === 'extension',
      );
      if (!isExtension) {
        return false;
      }
      // 扩展命令：服务端跑（它可能发消息、改 prompt、调工具）。
      const result = await elaApi.runCommand(name, arg);
      report(result, ctx);
      return true;
    }
  }
}
