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
 *
 * ## 三个只读快照（顶栏那三个入口）
 *
 * `systemPrompt()` / `tools()` / `history()` 严格说算会话数据（不是模型目录那种全局配置），
 * 但它们的口径与上面一致：**与「环跑到哪一步」无关，也不该每帧推送** —— 系统提示词一大段、
 * 工具定义一张表、完整历史一整页，都是「点开看一眼」的东西。塞进状态帧就是为了一份
 * 不一定会被看的内容付出 O(整段) 的序列化代价。
 */

import type { AgentStore } from '@ela/core/store';
import type { Api, Message, Model } from '@earendil-works/pi-ai';
import { existsSync } from 'node:fs';
import {
  cleanSessions,
  findSessionFile,
  findSessionFileById,
  listSessions,
  type SessionSummary,
} from '@ela/core/config-home';
import {
  forgetArchivedSessions,
  readSidebarState,
  setArchivedSessions,
} from '@ela/core/sidebar-state';
import { readSession, readJsonlHead } from '@ela/core/session-file';
import { historyLines } from './history';
import {
  DEFAULT_THINKING_LEVEL,
  isThinkingLevel,
  readDefaultThinkingLevel,
  writeDefaultThinkingLevel,
} from '@ela/core/thinking-level';
import { readHideThinkingBlock, readScopedModels, writeHideThinkingBlock, writeScopedModels } from '@ela/core/model-scope';
import { skillCommands, skillsInPrompt } from '@ela/core/skills';
import { promptCommands, promptTemplatesInPrompt } from '@ela/core/prompts';
import type {
  WebActionResult,
  WebCommandInfo,
  WebHistoryInfo,
  WebHistoryLine,
  WebModelsInfo,
  WebSessionDeleteInfo,
  WebSessionRef,
  WebSessionsInfo,
  WebSettingsInfo,
  WebSkillInfo,
  WebSystemPromptInfo,
  WebThinkingInfo,
  WebToolDefinitionInfo,
} from '@ela/core/web-protocol';
import { buildPromptHead, declaredToolSchemas } from '@ela/core/prompt-head';
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
  /**
   * 命令表（内置 + 扩展注册的）。
   *
   * **取值函数而不是数组**：内核 `deferExtensions` 时扩展是后台装的，装完才有它们的
   * 命令（`main.ts` 那个数组里的第二段）。快照成数组的话，浏览器那边（`/` 下拉）
   * 永远看不到扩展命令。
   */
  commands: () => readonly WebCommandSource[];
  /** 跑一条**扩展**命令（内置的不走这里 —— 它们的界面在浏览器侧）。 */
  runExtensionCommand: (name: string, arg: string) => Promise<void>;
}

export interface WebApi {
  commands(): WebCommandInfo[];
  models(): WebModelsInfo;
  /** 侧边栏的会话列表（每个 cwd 的历史会话，**不含**已归档的）。 */
  sessions(): WebSessionsInfo;
  /** 归档视图那份明细（带 `archivedAt`，按归档时刻倒序）。 */
  archivedSessions(): WebSessionsInfo;
  /** 归档 / 恢复一批会话（`archived = false` 是恢复）。 */
  setArchived(ids: readonly string[], archived: boolean): WebActionResult;
  /** 真删磁盘上的一批会话（会话文件 + 轨迹文件），归档标记跟着清。 */
  deleteSessions(ids: readonly string[]): WebSessionDeleteInfo;
  skills(): WebSkillInfo[];
  thinking(): WebThinkingInfo;
  settings(): WebSettingsInfo;
  /** 发给模型的那段系统提示词（顶栏「系统」）。 */
  systemPrompt(): WebSystemPromptInfo;
  /** 发给模型的工具定义（顶栏「工具」）。 */
  tools(): WebToolDefinitionInfo[];
  /**
   * 完整会话记录（顶栏「完整历史」，由 server 渲染成页面）。
   *
   * 不给 `sessionId` = 当前会话；给了就开那一个（按 id 跨目录找文件，不必知道它的 cwd）。
   */
  history(sessionId?: string): WebHistoryInfo;
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

/**
 * 列表阶段为了一个标题最多读文件头多少字节。
 *
 * 读整个文件（`sessionTitle`）对列表来说是不可接受的：一个 18MB 的目录就是 18MB 的
 * 解析。而第一句话几乎总在头几 KB 里 —— 也就够了。读不到的（超长首条、或没有用户
 * 消息）退到 id，不为了一个标题去扫全文（见 `readJsonlHead` 的注释）。
 */
const TITLE_HEAD_BYTES = 64 * 1024;
const TITLE_MAX_LENGTH = 60;

/** 消息内容 → 纯文本（与 `session-file.ts` 的 `contentToText` 同一口径，但它不对外）。 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : ' ', // 图片块占一个词，不把前后文粘在一起
    )
    .join(' ');
}

/**
 * 侧边栏一行显示什么：用户起的名字 → 第一句话 → id。
 *
 * 名字在 `SessionSummary` 里（`listSessions` 已经读过头部 512KB 的 `session_info`）；
 * 第一句话只能自己从头读一段找 —— 见 `TITLE_HEAD_BYTES`。
 */
function sessionListTitle(summary: SessionSummary): string {
  if (summary.name !== undefined && summary.name !== '') return summary.name;
  const { content } = readJsonlHead(summary.file, TITLE_HEAD_BYTES);
  for (const entry of content) {
    const message = (entry as { message?: { role?: unknown; content?: unknown } }).message;
    if (message?.role !== 'user') continue;
    const line = contentText(message.content).trim().split('\n')[0]?.trim() ?? '';
    if (line === '') continue;
    return line.length > TITLE_MAX_LENGTH ? `${line.slice(0, TITLE_MAX_LENGTH - 1)}…` : line;
  }
  return summary.id;
}

/**
 * 侧边栏那份列表：**每个 cwd 的历史会话**，按最后说话时间倒序（`listSessions` 已排好）。
 *
 * 分组是前端的事（`sidebar.ts`）：这里只给一份 [WebSessionRef](@ela/core/web-protocol)，
 * 浏览器按 `cwd` 归堆 —— 「哪几个 cwd 算同一组」（大小写、尾分隔符）那条归一化只该有
 * 一份，而它在服务端（`normalizeCwd`）。
 *
 * 代理子会话不列：它们属于某个主会话（`parentSession`），单独列出来只会把侧边栏塞满。
 *
 * `archived` 由调用方读**一次**再传进来（每条会话都读一遍那份文件是白读 N 次）：命中的
 * 条目带上 `archivedAt`，没命中的不带。
 */
function sessionRefs(archived: Readonly<Record<string, number>>): WebSessionRef[] {
  return listSessions()
    .filter((session) => session.parentSession === undefined)
    .map((session) => {
      const at = archived[session.id];
      return {
        id: session.id,
        cwd: session.cwd,
        title: sessionListTitle(session),
        lastActivityMs: session.lastActivityMs,
        messageCount: session.entries,
        ...(at === undefined ? {} : { archivedAt: at }),
      };
    });
}

/** 读一次归档表、列一遍会话，再按归档与否分成两份（主列表 / 归档明细）。 */
function splitSessions(): { live: WebSessionRef[]; archivedRefs: WebSessionRef[] } {
  const all = sessionRefs(readSidebarState().archived);
  return {
    live: all.filter((session) => session.archivedAt === undefined),
    archivedRefs: all
      .filter((session) => session.archivedAt !== undefined)
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
  };
}

export function createWebApi(options: WebApiOptions): WebApi {
  const { store } = options;

  /**
   * 会话身份（id / cwd）—— **从 store 现取**。
   *
   * 不从这里往外递：TUI、桥、这几个接口读的都是 `state.session` 那一份。
   * 「完整历史」靠 id 找会话文件（`findSessionFile`）—— 不拿内存里的 `messages` 凑，
   * 被 `/compact` 掉的早期消息只在文件里；作用域 / settings 那一堆读写靠 cwd。
   */
  const session = () => store.getState().session;
  const cwd = (): string => session().cwd;

  /** 当前模型的 Model 对象（档位、能力都从它读）。 */
  const currentModel = (): Model<Api> | null => {
    const state = store.getState();
    return options.resolveModel(state.providerName, state.modelId);
  };

  /** 作用域归一：**空数组也当全开**（与 TUI 的 `readScopedModels` 同一口径）。 */
  const scopedIds = (): string[] | null => {
    const ids = readScopedModels(cwd());
    return ids === null || ids.length === 0 ? null : ids;
  };

  return {
    commands() {
      // 顺序与 TUI 的补全一致（也是 pi 的顺序）：内置 → prompt 模板 → 扩展 → skill。
      //
      // 内置只有标了 `web` 的进（会话类 `/new` `/resume` `/compact` … 还在终端那边，
      // 见文件头）；扩展的一律进（它们本来就该在浏览器里也能跑）。
      const commandList = options.commands();
      const builtin: WebCommandInfo[] = commandList
        .filter((command) => command.source !== 'extension' && command.web === true)
        .map((command) => ({
          name: command.name,
          description: command.description,
          source: 'builtin',
        }));
      // Prompt 模板（pi 的 Prompt Templates）：与 TUI 的 `/` 补全同一份清单。
      // 浏览器里选中后当普通消息发出去，由桥在服务端展开（正文在磁盘上，见 bridge.ts）。
      const prompts: WebCommandInfo[] = promptCommands(
        promptTemplatesInPrompt(store.getState()),
      ).map((command) => ({
        name: command.name,
        description: command.description,
        source: 'prompt',
      }));
      const extensions: WebCommandInfo[] = commandList
        .filter((command) => command.source === 'extension')
        .map((command) => ({
          name: command.name,
          description: command.description,
          source: 'extension',
        }));
      // `/skill:<名字>` 也列进来（展开由 bridge 在收到 prompt 时做，见那里的注释）。
      const skills: WebCommandInfo[] = skillCommands(skillsInPrompt(store.getState())).map((command) => ({
        ...command,
        source: 'skill',
      }));
      return [...builtin, ...prompts, ...extensions, ...skills];
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

    sessions() {
      const { live, archivedRefs } = splitSessions();
      // 份数只算**还存在的**归档会话：文件被手工删掉的不该把「已归档 · N」撑大。
      return { sessions: live, archivedCount: archivedRefs.length };
    },

    archivedSessions() {
      const { archivedRefs } = splitSessions();
      return { sessions: archivedRefs, archivedCount: archivedRefs.length };
    },

    setArchived(ids, archived) {
      // 与其它写操作同一条规矩：环在跑时不改侧边栏的归属（正在写的那个会话
      // 一归档就从列表上消失，用户会以为它被删了）。
      if (store.getState().phase !== 'idle') return busyResult();
      const wanted = [...new Set(ids)];
      if (wanted.length === 0) return { ok: false, message: '没指定要归档的会话' };
      setArchivedSessions(wanted, archived ? Date.now() : null);
      return { ok: true };
    },

    deleteSessions(ids) {
      if (store.getState().phase !== 'idle') {
        return {
          ok: false,
          deleted: [],
          failed: [],
          message: '上一回合还没结束，先中断再删会话',
        };
      }
      // 当前会话不删：它正被记录器拿着（下一次说话会往一个已删掉的文件里写）。
      const current = session().id;
      const wanted = [...new Set(ids.filter((id) => typeof id === 'string' && id !== ''))];
      const targets = wanted.filter((id) => id !== current);
      const keptCurrent = wanted.length !== targets.length;
      const result = targets.length === 0 ? { failed: [] } : cleanSessions(targets);
      const deleted = targets.filter((id) => !result.failed.some((entry) => entry.id === id));
      // 文件没了，归档标记也就没意义了：不清的话下一次「已归档 · N」会把幽灵算进去。
      forgetArchivedSessions(deleted);
      return {
        ok: result.failed.length === 0 && !keptCurrent,
        deleted,
        failed: result.failed,
        ...(keptCurrent ? { message: '当前会话不能删，先新建或切一个会话' } : {}),
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
        default: readDefaultThinkingLevel(cwd()) ?? DEFAULT_THINKING_LEVEL,
      };
    },

    settings() {
      return {
        autoCompact: options.autoCompactEnabled(),
        hideThinking: readHideThinkingBlock(cwd()),
        defaultThinkingLevel: readDefaultThinkingLevel(cwd()) ?? DEFAULT_THINKING_LEVEL,
      };
    },

    systemPrompt() {
      const prompt = store.getState().prompt;
      // 拷一份再给出去：这份东西会被 `JSON.stringify` 写到 HTTP 响应里，
      // 而 state 是活的 —— 不拷的话以后一处原地改动会意外改到「已经发出去的那一份」。
      return { text: prompt.systemPrompt, sections: { ...(prompt.sections ?? {}) } };
    },

    tools() {
      // `state.prompt.tools` 就是请求里那份声明（`prepareLoadout` 重写过的描述已在里面，
      // 见 `declaredToolset()`），所以这里不重算一遍 —— 重算会给出「现在」的工具集，
      // 而顶部那个面板要回答的是「**这一轮**模型看到了什么」。
      return store.getState().prompt.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
    },

    history(requested) {
      // 指定了**别的**会话：按 id 跨目录找文件。找到什么就读什么，找不到就明说
      // （不退回内存那份 —— 那是**当前**会话的内容，套到别的 id 上就成了另一段历史）。
      if (requested !== undefined && requested !== '' && requested !== session().id) {
        const wantedFile = findSessionFileById(requested);
        const wantedSession = wantedFile === null ? null : readSession(wantedFile);
        if (wantedFile === null || wantedSession === null) {
          return { sessionId: requested, cwd: '', file: null, lines: [], missing: true };
        }
        return {
          sessionId: requested,
          cwd: wantedSession.header.cwd,
          file: wantedFile,
          lines: historyLines(wantedSession.entries),
        };
      }
      const { id: sessionId, cwd: historyCwd } = session();
      // 先按 cwd（便宜、常态），拼出来的路径不存在时再按 id 跨目录找 —— `resume` 到
      // 别的项目的会话时，内核 cwd 还是启动那个，文件在它原本那个目录里。
      const direct = sessionId === '' ? null : findSessionFile(sessionId, historyCwd);
      const file =
        direct !== null && existsSync(direct) ? direct : findSessionFileById(sessionId);
      const sessionFile = file !== null ? readSession(file) : null;
      if (sessionFile !== null) {
        return { sessionId, cwd: historyCwd, file, lines: historyLines(sessionFile.entries) };
      }
      // 还没落盘（新会话、或者文件被删了）：退回内存里那份。
      // 它少了被压缩掉的早期消息，但比一页空白强 —— 页面上会写明「来源：内存」。
      //
      // 头部（system prompt + 工具表）得**单独补一条**：内存里的 `messages` 不含 head
      // （读会话时它被跳过，见 `session-file` 的 `sessionMessages`），不补的话这一页在
      // 「还没落盘」时看起来就像模型压根没收到提示词与工具。用的就是发出去的那一份
      // （`buildPromptHead` + `state.prompt.headTools`，与 `effects.ts` 同一个造法）。
      const prompt = store.getState().prompt;
      const lines: WebHistoryLine[] = [];
      if (prompt.systemPrompt !== '' || prompt.tools.length > 0) {
        const head = buildPromptHead({
          systemPrompt: prompt.systemPrompt,
          ...(prompt.sections !== undefined ? { sections: prompt.sections } : {}),
          tools: declaredToolSchemas(prompt.headTools ?? prompt.tools),
        });
        const message: Message = { ...head, timestamp: Date.now() };
        lines.push({ kind: 'message', at: new Date().toISOString(), message });
      }
      for (const message of store.getState().messages) {
        lines.push({ kind: 'message', at: new Date(message.timestamp).toISOString(), message });
      }
      return { sessionId, cwd: historyCwd, file: null, lines };
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
      if (patch.hideThinking !== undefined) writes.push(writeHideThinkingBlock(patch.hideThinking, cwd()));
      if (patch.defaultThinkingLevel !== undefined && isThinkingLevel(patch.defaultThinkingLevel)) {
        writes.push(writeDefaultThinkingLevel(patch.defaultThinkingLevel, cwd()));
      }
      const results = await Promise.all(writes);
      return results.every(Boolean)
        ? { ok: true }
        : { ok: false, message: '没能写进 settings.json（写权限？），这次改动没存住' };
    },

    async setScopedModels(ids) {
      if (store.getState().phase !== 'idle') return busyResult();
      const normalized = ids === null || ids.length === 0 ? null : [...ids];
      const ok = writeScopedModels(normalized, cwd());
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
