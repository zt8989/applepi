/**
 * System prompt 构建 —— **全部交给 pi**，包括「我们自己那条规则」。
 *
 * ## 我们不写一个字
 *
 * `src/system-prompt.ts` 只做两件事：**按 pi 的规则找输入**、**调 `buildSystemPrompt`**。
 *
 * 早先这里手写三行中文（"你是编码助手 / 用工具查 / 简短直给"），后来又加了
 * `OWN_GUIDELINES = ['Always respond in the user\'s language.']`。两处都是错的：
 *
 * - 手写的 prompt 缺 `edit` 的那些坑（oldText 必须精确匹配…），而那是官方**踩过才写下**的；
 * - 更要紧的是**规则不该住在代码里** —— 它该住在文件里，那样用户能自己改。
 *
 * ## 「用用户的语言回答」现在放哪
 *
 * pi 有一套完整的文件发现机制（`resource-loader.ts`），我们原样复用：
 *
 * | 文件 | 位置 | 进哪一段 |
 * | --- | --- | --- |
 * | `SYSTEM.md` | `<cwd>/.pi/SYSTEM.md`（项目信任时）或 `~/.pi/agent/SYSTEM.md` | 顶掉 preamble |
 * | `APPEND_SYSTEM.md` | 同上两个位置 | `<addendum>` 段 |
 * | `AGENTS.md` / `AGENTS.override.md` / `CLAUDE.md` | 家目录 + 项目 + 每一层祖先目录 | `<project_context>` 段 |
 *
 * 所以「用用户的语言回答」是 `~/.pi/agent/APPEND_SYSTEM.md` 里的一行 —— 用户自己写、
 * 想改就改、不用改代码。而 `AGENTS.md` 已经是那套机制的一部分（之前就在扫，
 * 只是没人往里面写规则）。
 *
 * **为什么不给代码里留一个后门**：`promptGuidelines` 参数确实存在，留一条「项目自己的
 * 默认值」是很自然的想法。但那会让「规则在代码里」和「规则在文件里」**并存** ——
 * 用户改了文件却发现某条还在，排查时根本想不到去看代码。
 *
 * ## 一处与 pi 的差异：项目信任
 *
 * pi 的项目级 `SYSTEM.md` 需要 `settingsManager.isProjectTrusted()`（防止在不受信任的
 * 目录里被文件劫持 prompt）。我们不读项目设置，所以**不实现这个信任判断** ——
 * 项目级的 `SYSTEM.md` / `APPEND_SYSTEM.md` 一律生效。
 *
 * 这个取舍是安全的：我们跑在用户自己的机器上、工具的路径边界也只圈在 `--cwd` 里，
 * 而读一份项目内的 `.pi/SYSTEM.md` 与读同目录的 `AGENTS.md` 风险相同（后者无条件生效）。
 */
import { buildSystemPrompt, buildSystemPromptSections, type BuildSystemPromptOptions } from '@earendil-works/pi-coding-agent/dist/core/system-prompt.js';
import { loadProjectContextFiles } from '@earendil-works/pi-coding-agent/dist/core/resource-loader.js';
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { configHome, PI_CONFIG_DIR as CONFIG_DIR_NAME } from './config-home';
import { loadSkillRegistry } from './skills';
import { BUILTIN_TOOL_NAMES, selectedBuiltinToolNames } from './tools';
import type { Skill as PiSkill } from '@earendil-works/pi-coding-agent/dist/core/skills.js';
import type { SkillInfo } from './skills';

/** 一份 prompt 装配需要的全部输入。 */
export interface PromptInputs {
  /** 工作目录：官方工具用它做路径边界检查，`<cwd>` 段也用它。 */
  cwd: string;
  /** 工具定义：取它们的 `promptSnippet` / `promptGuidelines`。 */
  tools: readonly PromptToolLike[];
  /** 装进来的 skill（进 `<skills>` 段）。 */
  skills?: readonly SkillInfo[] | undefined;
  /**
   * 显式的自定义前言（`--system`）。
   *
   * 给它就**顶掉** pi 的 preamble（官方语义：`customPrompt` = replaces the default
   * prefix）。但 tools / rules / project_context / cwd 那些段照旧拼上 ——
   * 官方那个行为是对的：「我是这个项目的专用助手」不该顺带丢掉工具怎么用。
   *
   * **优先级低于文件**：`SYSTEM.md` 存在时用它（那是 pi 的规范，用户能自己改）。
   */
  customPrompt?: string | undefined;
  /**
   * 追加到 `<addendum>` 段的文字。
   *
   * 同样**优先级低于文件**：`APPEND_SYSTEM.md` 存在时用它。
   *
   * 为什么不留「代码里的默认规则」：那会让规则在代码与文件两处并存，用户改了文件
   * 却发现某条还在 —— 排查时根本想不到去看代码。
   */
  appendPrompt?: string | undefined;
  /**
   * 额外的 XML 段（`<tag>` 包住），键是 tag 名。
   *
   * MCP 的 `mcp_servers` 段就是这么进来的（扩展自己算好、写进
   * `before_agent_start` 的 `systemPromptOptions.sections`）。空对象 = 没有额外段。
   */
  sections?: Record<string, string> | undefined;
}

/** 只需要工具定义上的两个字段，不依赖官方的完整 ToolDefinition 类型。 */
export interface PromptToolLike {
  name: string;
  promptSnippet?: string | undefined;
  promptGuidelines?: readonly string[] | undefined;
}

/**
 * 从官方工具定义上取出 snippet / guideline。
 *
 * 为什么用 `create*ToolDefinition()` 而不是 `create*Tool()`：`create*Tool()` 返回的是
 * `AgentTool`，它**不带** `promptSnippet` / `promptGuidelines`（那是给 prompt 用的
 * 扩展点，只在 `ToolDefinition` 上）。而 TUI 那边本来就用的是 `create*ToolDefinition()`
 * —— 同一个实例，不额外建。
 *
 * ## 只取**开着**的那些 —— 与 `tools.ts` 的 `getTools()` 同源
 *
 * 这里是 prompt 侧那份清单。若它与「真能跑的表」不一致，后果很具体：
 * prompt 告诉了模型 `grep` 怎么用，而工具表里没有 `grep` —— 模型一调就回
 * 「未知工具」，而日志里**看不到任何异常**（工具是按名字查表，查不到就是查不到）。
 * 反过来（表里有、prompt 不说）只是模型不知道有它，不算坏。
 *
 * 所以开关走 `selectedBuiltinToolNames()` —— 与 `getTools()` **同一个函数**。
 * 不是「两份各自读 settings.json 碰巧一致」，那种一致性只在没改配置时成立，
 * 而它一破就是静默的（见 `tools.ts` 里那个函数的注释）。
 */
export function promptToolsFrom(cwd: string): PromptToolLike[] {
  const factory: Record<string, (dir: string) => ToolDefinition<any, any>> = {
    read: createReadToolDefinition,
    write: createWriteToolDefinition,
    edit: createEditToolDefinition,
    bash: createBashToolDefinition,
    powershell: createPowerShellToolDefinition,
    grep: createGrepToolDefinition,
    find: createFindToolDefinition,
    ls: createLsToolDefinition,
  };
  const selected = selectedBuiltinToolNames(cwd);
  const definitions = BUILTIN_TOOL_NAMES.map((name) =>
    selected.has(name) ? factory[name]?.(cwd) : undefined,
  ).filter((d): d is ToolDefinition<any, any> => d !== undefined);
  return definitions.map((d) => ({
    name: d.name,
    ...(d.promptSnippet !== undefined ? { promptSnippet: d.promptSnippet } : {}),
    ...(d.promptGuidelines !== undefined ? { promptGuidelines: [...d.promptGuidelines] } : {}),
  }));
}

/**
 * 找到 `SYSTEM.md` / `APPEND_SYSTEM.md`（pi 的规范，优先级与官方一致）。
 *
 * ## 优先级（照抄官方 `discoverSystemPromptFile`）
 *
 * 1. `<cwd>/.pi/SYSTEM.md` —— 项目级
 * 2. `~/.pi/agent/SYSTEM.md` —— 全局
 * 3. 都没有 → undefined
 *
 * **与 pi 的唯一差异**：官方还要求 `settingsManager.isProjectTrusted()` 才认项目级那份
 * （防止在不受信任的目录里被文件劫持 prompt）。我们不读项目设置，所以不实现那个判断 ——
 * 见文件头的「一处与 pi 的差异」。
 *
 * 项目目录名用官方常量 `CONFIG_DIR_NAME`（= `.pi`），不手写字符串：pi 改了我们不会
 * 静默地指向别处。
 */
function findSystemFile(cwd: string, filename: 'SYSTEM.md' | 'APPEND_SYSTEM.md'): string | undefined {
  const project = path.join(cwd, CONFIG_DIR_NAME, filename);
  if (existsSync(project)) return project;
  const global = path.join(configHome(), filename);
  return existsSync(global) ? global : undefined;
}

/**
 * 读一个 prompt 文件。
 *
 * **读不出来时返回 undefined 而不是路径本身**：官方 `resolvePromptInput` 读失败时会把
 * **路径本身**当作提示词内容（`return input`）—— 那意味着模型会收到一串路径当指令。
 * 我们不跟这一点。
 */
function readPromptFile(file: string | undefined): string | undefined {
  if (file === undefined) return undefined;
  try {
    return readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    // 读不了就当没有：宁可少一条规则，也不要把一串路径当成 prompt 送进模型。
    return undefined;
  }
}

/** 找到的 prompt 文件（给界面显示「规则是从哪读到的」用）。 */
export interface PromptFileSources {
  system?: { path: string } | undefined;
  append?: { path: string } | undefined;
}

export function promptFileSources(cwd: string): PromptFileSources {
  const system = findSystemFile(cwd, 'SYSTEM.md');
  const append = findSystemFile(cwd, 'APPEND_SYSTEM.md');
  return {
    ...(system !== undefined ? { system: { path: system } } : {}),
    ...(append !== undefined ? { append: { path: append } } : {}),
  };
}

/**
 * 「哪几个文件进了 prompt 的上下文」—— 开场 `[Context]` 那一节的清单。
 *
 * 与 `buildPromptOptions()` **同一个来源**（同样的三个函数）否则界面报的与模型收到
 * 可能分家，而症状是「界面上说有 AGENTS.md，可模型显然不知道里面写了什么」。
 *
 * 顺序与 pi 一致（system prompt 源 → append 源 → AGENTS.md 家目录/项目/祖先）。
 */
export function contextFilePaths(cwd: string): string[] {
  const sources = promptFileSources(cwd);
  return [
    ...(sources.system !== undefined ? [sources.system.path] : []),
    ...(sources.append !== undefined ? [sources.append.path] : []),
    ...loadProjectContextFiles({ cwd, agentDir: configHome() }).map((f) => f.path),
  ];
}

/**
 * 把 pi 的 skill 映射成它 `buildSystemPrompt` 认的形状。
 *
 * 与 `skills.ts` 里的 `toInfo()` 互逆：那边把 pi 的 `Skill` 收成本项目的 `SkillInfo`，
 * 这里再映回去。形状一样是因为中间那层 `SkillInfo` 是本项目自己的字段名。
 */
function toPiSkills(skills: readonly SkillInfo[]): PiSkill[] {
  return skills.map(
    (s) =>
      ({
        name: s.name,
        description: s.description,
        filePath: s.filePath,
        baseDir: s.baseDir,
        disableModelInvocation: s.disableModelInvocation,
        // scope/baseDir 的其余字段本项目不用；`sourceInfo` 仅用于显示，不填。
      }) as unknown as PiSkill,
  );
}

/**
 * 装配给 pi 的选项（不含文件发现的默认值处理）。
 *
 * 拆出来是因为内核与界面都要看到「到底有哪些段」—— 回放 / 排障时能直接念出段的键。
 */
export function buildPromptOptions(inputs: PromptInputs): BuildSystemPromptOptions {
  const toolSnippets: Record<string, string> = {};
  const toolGuidelines: Record<string, string[]> = {};
  const selectedTools: string[] = [];
  for (const tool of inputs.tools) {
    // 没有 snippet 的工具**不进 prompt 列表**（官方语义：那就是「不告诉模型它存在」）。
    if (tool.promptSnippet === undefined || tool.promptSnippet === '') continue;
    selectedTools.push(tool.name);
    toolSnippets[tool.name] = tool.promptSnippet;
    if (tool.promptGuidelines !== undefined && tool.promptGuidelines.length > 0) {
      toolGuidelines[tool.name] = [...tool.promptGuidelines];
    }
  }
  // 文件优先于参数（pi 的规范）：用户在 SYSTEM.md 里写的比命令行传的更「近」。
  const systemFile = readPromptFile(findSystemFile(inputs.cwd, 'SYSTEM.md'));
  const appendFile = readPromptFile(findSystemFile(inputs.cwd, 'APPEND_SYSTEM.md'));
  const appendParts = [appendFile, inputs.appendPrompt].filter(
    (part): part is string => part !== undefined && part.trim() !== '',
  );
  return {
    cwd: inputs.cwd,
    selectedTools,
    toolSnippets,
    toolGuidelines,
    // **不传 promptGuidelines**：我们自己一条规则都不加（文件里有）。
    appendSystemPrompt: appendParts.join('\n\n'),
    // AGENTS.md：pi 的项目上下文。家目录（~）+ 项目 + 祖先目录，是官方那套扫描规则。
    contextFiles: loadProjectContextFiles({ cwd: inputs.cwd, agentDir: configHome() }),
    skills: toPiSkills(inputs.skills ?? []),
    ...(inputs.sections !== undefined && Object.keys(inputs.sections).length > 0
      ? { sections: inputs.sections }
      : {}),
    ...((systemFile ?? inputs.customPrompt) !== undefined &&
    (systemFile ?? inputs.customPrompt) !== ''
      ? { customPrompt: (systemFile ?? inputs.customPrompt) as string }
      : {}),
  };
}

/**
 * prompt 的两份形态：渲染好的整段文本 + 它的分段。
 *
 * 两份都从**同一份 options** 出来，所以「分段渲染出来」与 `text` 逐字节相同。
 */
export interface PromptParts {
  /** 渲染好的整段文本 —— 就是今天发给模型的那段（`buildSystemPrompt` 的输出）。 */
  text: string;
  /**
   * 分段（段名 → 渲染后的文本；`preamble` 是唯一不带 tag 的段）。
   *
   * ## 为什么要单独留一份
   *
   * pi 的 transcript 是**增量**的：后来的 system 消息按**段名** patch（`sections: {
   * preamble: …, skills: null }`），而不是重发整段。只有拿得到「当初那几段」，
   * 中途的 prompt 变更才可能做到「只把变了的段追加成新消息、已有消息一个字节不动」
   * ——而那正是前缀缓存能活下来的原因（见 `prompt-head.ts`）。
   *
   * 只存渲染后的整段的话，中途任何一个字节的变更都得整段重发，缓存必断。
   */
  sections: Record<string, string>;
}

/**
 * 装配 prompt 的两份形态。
 *
 * @param loadSkills 是否顺带扫 skill 目录。回放 / 测试里传 false ——
 *   目录内容可能已经变了，重扫得到的是**另一个** prompt（那时应该用落盘的那份）。
 */
export function buildPromptParts(inputs: PromptInputs & { loadSkills?: boolean }): PromptParts {
  const skills =
    inputs.skills ?? (inputs.loadSkills === true ? loadSkillRegistry({ cwd: inputs.cwd }).skills : []);
  const options = buildPromptOptions({ ...inputs, skills });
  return { text: buildSystemPrompt(options), sections: buildSystemPromptSections(options) };
}

/**
 * 拼出完整的 system prompt 文本（发给模型的那一整段）。
 */
export function buildSystemPromptText(inputs: PromptInputs & { loadSkills?: boolean }): string {
  return buildPromptParts(inputs).text;
}