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
 * | `/settings` | 三项：自动压缩 / 隐藏思考块 / 默认思考级别（原位切换） |
 * | `/scoped-models` | 勾选列表，勾一下存一次 |
 * | `/skills` | 纯文本弹窗（**唯一一条 pi 没有的命令**，理由见 TUI 的 `SLASH_COMMANDS`） |
 * | 扩展命令 | `POST /api/command`（服务端跑） |
 * | `/skill:<名字>` | **不走这里** —— 当普通消息发出去，服务端展开成 `<skill>` 块 |
 *
 * 会话类命令（`/new` `/resume` `/compact` `/session` …）服务端**不下发**，所以这里也不认
 * —— 前端只做服务端说能做的。
 */

import { elaApi } from './api';
import { openModal, type ModalRow } from './modal';

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

/** 弹一个纯文本弹窗（`/skills` 与扩展的只读输出）。 */
function showText(title: string, text: string, footer = 'Esc 关闭'): void {
  const modal = openModal({ title, footer });
  modal.setText(text === '' ? '（空）' : text);
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

async function openSettings(ctx: CommandContext): Promise<void> {
  const modal = openModal({ title: '设置', footer: '↑↓ 选择 · Enter 切换 · Esc 关闭' });
  const draw = async (): Promise<void> => {
    const info = await elaApi.settings();
    const rows: ModalRow[] = [];
    if (info.autoCompact !== null) {
      rows.push({
        label: '自动压缩',
        mark: info.autoCompact ? '✓' : ' ',
        hint: '上下文快满时自动摘要',
        onPick: () => {
          void elaApi.setSettings({ autoCompact: !info.autoCompact }).then((result) => {
            report(result, ctx);
            void draw();
          });
        },
      });
    }
    rows.push({
      label: '隐藏思考块',
      mark: info.hideThinking ? '✓' : ' ',
      onPick: () => {
        void elaApi.setSettings({ hideThinking: !info.hideThinking }).then((result) => {
          report(result, ctx);
          void draw();
        });
      },
    });
    rows.push({
      label: '默认思考级别',
      hint: info.defaultThinkingLevel,
      onPick: () => {
        void chooseDefaultThinking(info.defaultThinkingLevel, ctx);
      },
    });
    modal.setRows(rows);
  };
  await draw();
}

/** 选「默认思考级别」（写 settings.json 的 `defaultThinkingLevel`）。 */
async function chooseDefaultThinking(current: string, ctx: CommandContext): Promise<void> {
  const info = await elaApi.thinking();
  const modal = openModal({ title: '默认思考级别', footer: '↑↓ 选择 · Enter 保存 · Esc 取消' });
  modal.setRows(
    info.levels.map((level) => ({
      label: level,
      ...(level === current ? { mark: '✓', active: true } : { mark: ' ' }),
      onPick: () => {
        void elaApi.setSettings({ defaultThinkingLevel: level }).then((result) => {
          modal.close();
          report(result, ctx, `默认思考级别 → ${level}`);
        });
      },
    })),
  );
}

async function openScopedModels(ctx: CommandContext): Promise<void> {
  const info = await elaApi.models();
  const all = info.models.map((model) => `${model.provider}/${model.id}`);
  // `scoped === null` = 全开 → 一开始全勾上。
  const enabled = new Set(info.scoped ?? all);
  let query = '';

  const saveScope = async (): Promise<void> => {
    const ids = all.filter((key) => enabled.has(key));
    // 全选 = 「全开」（`null`），与 TUI 的 `normalizeEnabled()` 同一个口径。
    report(await elaApi.setScopedModels(ids.length === all.length ? null : ids), ctx);
  };

  function draw(): void {
    const needle = query.trim().toLowerCase();
    modal.setRows(
      info.models
        .filter((model) => {
          if (needle === '') return true;
          return (
            model.id.toLowerCase().includes(needle) ||
            model.name.toLowerCase().includes(needle) ||
            model.provider.toLowerCase().includes(needle)
          );
        })
        .map((model) => {
          const key = `${model.provider}/${model.id}`;
          const isCurrent = model.provider === info.current?.provider && model.id === info.current.id;
          return {
            label: model.id,
            mark: enabled.has(key) ? '✓' : ' ',
            hint: isCurrent ? '当前' : model.provider,
            ...(isCurrent ? { active: true } : {}),
            onPick: () => {
              if (enabled.has(key)) enabled.delete(key);
              else enabled.add(key);
              void saveScope().then(draw);
            },
          };
        }),
    );
  }

  const modal = openModal({
    title: '模型作用域（Ctrl+P 循环的候选集）',
    footer: '↑↓ 选择 · Enter 勾选/取消 · Esc 关闭（勾一下即保存）',
    searchPlaceholder: '搜索模型…',
    onSearch: (value) => {
      query = value;
      draw();
    },
  });
  draw();
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
      await openSettings(ctx);
      return true;
    case 'scoped-models':
      await openScopedModels(ctx);
      return true;
    case 'skills': {
      const skills = await elaApi.skills();
      showText(
        'Skills',
        skills.map((skill) => `${skill.name}（${skill.scope}）\n  ${skill.description}\n  ${skill.filePath}`).join('\n\n'),
        'Esc 关闭',
      );
      return true;
    }
    default: {
      // 扩展命令：服务端跑（它可能发消息、改 prompt、调工具）。内置的没命中说明
      // 那个名字只存在于终端那边 —— 说清楚，别静默。
      const result = await elaApi.runCommand(name, arg);
      report(result, ctx);
      return true;
    }
  }
}
