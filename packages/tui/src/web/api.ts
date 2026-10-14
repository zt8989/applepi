/**
 * 浏览器侧要的**非会话数据与动作** —— HTTP 接口（`/api/*`）的服务端实现。
 *
 * ## 为什么这些走 HTTP，而不是继续塞进 WebSocket 状态帧
 *
 * 它们与「环跑到哪一步」无关：模型目录、命令表、作用域、settings 在一次会话里
 * 基本不变，按需取就行。塞进 `hello` / `state` 的坏处是前端把服务端的事实**抄了一份**
 * （改了 TUI 那边，浏览器还拿着旧快照）。
 *
 * 而会话本身（消息流、流式文本、工具状态）仍然走 WebSocket —— 那一份必须是推送的，
 * 因为它在秒级变化，且要「先状态后事件」。
 *
 * ## 浏览器侧只是「多一个入口」，不是第二套逻辑
 *
 * 每个方法都落到内核或 `settings.json`（与 TUI 的 `/model`、`/thinking`、`/settings`
 * 面板同一批函数）。所以「换模型」在终端和浏览器里改的是同一处，不会两边不一致。
 *
 * 返回 `WebActionResult` 而不是抛错：写盘失败、找不到模型这些是**用户要看的信息**，
 * 不是异常（与 TUI 的 `notify(yellow(...))` 同一口径）。
 */

import type { AgentStore } from '@ela/core/store';
import type { Api, Model } from '@earendil-works/pi-ai';
import {
  DEFAULT_THINKING_LEVEL,
  isThinkingLevel,
  readDefaultThinkingLevel,
  writeDefaultThinkingLevel,
} from '@ela/core/thinking-level';
import { readHideThinkingBlock, readScopedModels, writeHideThinkingBlock, writeScopedModels } from '@ela/core/model-scope';
import { skillCommands, skillsInPrompt } from '@ela/core/skills';
import type {
  WebActionResult,
  WebCommandInfo,
  WebModelsInfo,
  WebSettingsInfo,
  WebSkillInfo,
  WebThinkingInfo,
} from '@ela/core/web-protocol';
import { supportedThinkingLevels } from '../pi-actions';
import { modelRefs } from './bridge';

/**
 * 命令表里的一行。
 *
 * 两份合成这一张表：TUI 的 `SLASH_COMMANDS`（带 `web` 标记）与扩展注册的命令
 * （`source: 'extension'`，一律进接口 —— 扩展的命令在浏览器里也能跑）。
 */
export interface WebCommandSource {
  name: string;
  description: string;
  /** 浏览器里也能跑（非会话类）。不标 = 终端专有。 */
  web?: boolean | undefined;
  source?: 'builtin' | 'extension' | undefined;
}

export interface WebApiOptions {
  store: AgentStore;
  cwd: string;
  /** 可用模型快照（与 TUI 的 `/model` 面板同一份）。 */
  modelCatalog: () => readonly Model<Api>[];
  /** 按 provider/id 解析模型对象；解析不到给 `null`。 */
  resolveModel: (provider: string, id: string) => Model<Api> | null;
  /** 换模型（内核的 `setModel()`）。 */
  setModel: (provider: string, id: string) => boolean;
  /** 自动压缩开关；`null` = 这个装配不支持。 */
  autoCompactEnabled: () => boolean | null;
  setAutoCompactEnabled: (enabled: boolean) => void;
  /** 内置命令表（TUI 的 `SLASH_COMMANDS`）—— 标了 `web` 的才进接口。 */
  commands: readonly WebCommandSource[];
  /** 跑一条**扩展**命令（内置的不走这里 —— 它们的界面在浏览器侧）。 */
  runExtensionCommand: (name: string, arg: string) => Promise<void>;
}

export interface WebApi {
  commands(): WebCommandInfo[];
  models(): WebModelsInfo;
  skills(): WebSkillInfo[];
  thinking(): WebThinkingInfo;
  settings(): WebSettingsInfo;
  setModel(arg: string): WebActionResult;
  setThinking(level: string): WebActionResult;
  setSettings(patch: {
    autoCompact?: boolean;
    hideThinking?: boolean;
    defaultThinkingLevel?: string;
  }): Promise<WebActionResult>;
  setScopedModels(ids: readonly string[] | null): Promise<WebActionResult>;
  /** 跑一条扩展命令（`/api/command`）。 */
  runCommand(name: string, arg: string): Promise<WebActionResult>;
}

/** 「环在跑」时不能改的东西，统一回这一句（与 TUI 各面板同一口径）。 */
function busyResult(): WebActionResult {
  return { ok: false, message: '上一回合还没结束，先中断再改' };
}

export function createWebApi(options: WebApiOptions): WebApi {
  const { store, cwd } = options;

  /** 当前模型的 Model 对象（档位、能力都从它读）。 */
  const currentModel = (): Model<Api> | null => {
    const state = store.getState();
    return options.resolveModel(state.providerName, state.modelId);
  };

  /** 作用域归一：**空数组也当全开**（与 TUI 的 `readScopedModels` 同一口径）。 */
  const scopedIds = (): string[] | null => {
    const ids = readScopedModels(cwd);
    return ids === null || ids.length === 0 ? null : ids;
  };

  return {
    commands() {
      // 扩展的命令一律进（它们本来就该在浏览器里也能跑）；内置的只有标了 `web` 的进
      // —— 会话类（`/new` `/sessions` `/compact` …）还在终端那边，见文件头。
      // `/skill:<名字>` 也列进来（展开由 bridge 在收到 prompt 时做，见那里的注释）。
      const builtin: WebCommandInfo[] = options.commands
        .filter((command) => command.source === 'extension' || command.web === true)
        .map((command) => ({
          name: command.name,
          description: command.description,
          source: command.source ?? 'builtin',
        }));
      const skills: WebCommandInfo[] = skillCommands(skillsInPrompt(store.getState())).map((command) => ({
        ...command,
        source: 'skill',
      }));
      return [...builtin, ...skills];
    },

    models() {
      const state = store.getState();
      return {
        models: modelRefs(options.modelCatalog()),
        scoped: scopedIds(),
        current:
          state.providerName === '' || state.modelId === ''
            ? null
            : { provider: state.providerName, id: state.modelId },
      };
    },

    skills() {
      return skillsInPrompt(store.getState()).map((skill) => ({
        name: skill.name,
        scope: skill.scope,
        description: skill.description,
        filePath: skill.filePath,
      }));
    },

    thinking() {
      return {
        current: store.getState().thinkingLevel,
        levels: supportedThinkingLevels(currentModel() ?? undefined),
        default: readDefaultThinkingLevel(cwd) ?? DEFAULT_THINKING_LEVEL,
      };
    },

    settings() {
      return {
        autoCompact: options.autoCompactEnabled(),
        hideThinking: readHideThinkingBlock(cwd),
        defaultThinkingLevel: readDefaultThinkingLevel(cwd) ?? DEFAULT_THINKING_LEVEL,
      };
    },

    setModel(arg) {
      const wanted = arg.trim();
      if (wanted === '') return { ok: false, message: '用法：/model <模型 id 或 provider/id>' };
      const state = store.getState();
      if (state.phase !== 'idle') return busyResult();
      const exact = options
        .modelCatalog()
        .find((model) => model.id === wanted || `${model.provider}/${model.id}` === wanted);
      if (exact === undefined) return { ok: false, message: `找不到模型 ${wanted}` };
      const ok = options.setModel(String(exact.provider), exact.id);
      return ok ? { ok: true } : { ok: false, message: `换不了 ${wanted}：当前配置里没这个模型` };
    },

    setThinking(level) {
      if (store.getState().phase !== 'idle') return busyResult();
      const levels = supportedThinkingLevels(currentModel() ?? undefined);
      if (levels.length === 0) return { ok: false, message: '当前模型不支持思考' };
      const wanted = level.trim().toLowerCase();
      const hit = levels.find((candidate) => candidate.toLowerCase() === wanted);
      if (hit === undefined) {
        return { ok: false, message: `Unknown thinking level "${level}". Available levels: ${levels.join(', ')}.` };
      }
      if (!isThinkingLevel(hit)) return { ok: false, message: `不认识的思考级别：${hit}` };
      store.dispatch({ type: 'thinking.changed', level: hit });
      return { ok: true };
    },

    async setSettings(patch) {
      if (store.getState().phase !== 'idle') return busyResult();
      if (patch.autoCompact !== undefined) options.setAutoCompactEnabled(patch.autoCompact);
      const writes: Promise<boolean>[] = [];
      if (patch.hideThinking !== undefined) writes.push(writeHideThinkingBlock(patch.hideThinking, cwd));
      if (patch.defaultThinkingLevel !== undefined && isThinkingLevel(patch.defaultThinkingLevel)) {
        writes.push(writeDefaultThinkingLevel(patch.defaultThinkingLevel, cwd));
      }
      const results = await Promise.all(writes);
      return results.every(Boolean)
        ? { ok: true }
        : { ok: false, message: '没能写进 settings.json（写权限？），这次改动没存住' };
    },

    async setScopedModels(ids) {
      if (store.getState().phase !== 'idle') return busyResult();
      const normalized = ids === null || ids.length === 0 ? null : [...ids];
      const ok = writeScopedModels(normalized, cwd);
      return ok
        ? { ok: true }
        : { ok: false, message: '没能写进 settings.json（写权限？），作用域没变' };
    },

    async runCommand(name, arg) {
      try {
        await options.runExtensionCommand(name, arg);
        return { ok: true };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
