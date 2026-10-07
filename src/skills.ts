/**
 * Skill —— 复用 pi 官方的加载器与格式，不自己实现一份。
 *
 * ## 这是什么
 *
 * 一个 skill 是一个 `SKILL.md`（带 YAML frontmatter 的 `name` + `description`），
 * 正文是给模型看的「遇到这类任务怎么做」的说明书。模型**不会自动加载**正文 ——
 * prompt 里只列一张清单（名字 + 描述 + 文件位置），任务对上号时它自己调 `read`
 * 去读那个文件。少花 token 是这一层的全部意义。
 *
 * pi 已经把整套东西做完了，而且是**主入口直接导出**的（不需要 pnpm patch）：
 *
 * ```ts
 * import { loadSkills, formatSkillsForPrompt, parseSkillBlock } from '@earendil-works/pi-coding-agent';
 * ```
 *
 * 所以这里只做三件薄薄的事：
 *
 * 1. `loadSkillRegistry()` —— 调 pi 的 `loadSkills()`，把 `Skill[]` 收进本项目的形状；
 * 2. `skillsPrompt()` —— 调 pi 的 `formatSkillsForPrompt()`，接到 system prompt 后面；
 * 3. `expandSkillCommand()` —— 调 pi 的 `parseSkillBlock()` 的**同一个** XML 形状，
 *    把 `/skill:name` 展开成 `<skill …>…</skill>`。
 *
 * 自己实现这些（扫目录、解析 frontmatter、拼 XML）只会得到一个**会漂移的副本**：
 * pi 改了 Agent Skills 标准的细节，我们这边不会跟着动。
 *
 * ## 目录（与 pi 完全一致）
 *
 * ```
 * ~/.pi/agent/skills/<name>/SKILL.md    ← 用户级
 * <cwd>/.pi/skills/<name>/SKILL.md      ← 项目级
 * ```
 *
 * 注意项目级是 `<cwd>/.pi/skills`，不是 `.claude/skills` 之类 —— 用 `getAgentDir()`
 * 与 `CONFIG_DIR_NAME` 这些**官方常量**拼，而不是手抄字符串（理由同 config-home.ts）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  formatSkillsForPrompt,
  loadSkills,
  parseSkillBlock,
  type Skill as PiSkill,
} from '@earendil-works/pi-coding-agent';
import { stripFrontmatter } from '@earendil-works/pi-coding-agent/dist/utils/frontmatter.js';
import { configHome } from './config-home';
import type { AgentState } from './state';

/** 一个 skill 的形状（与 pi 的 `Skill` 对齐，但只留我们要用的字段）。 */
export interface SkillInfo {
  /** 唯一名（小写字母、数字、连字符）—— `/skill:<name>` 用的就是它。 */
  name: string;
  /** 一句话描述，模型靠它判断「这个任务要不要读这个文件」。 */
  description: string;
  /** SKILL.md 的绝对路径（`location`，模型拿去 read）。 */
  filePath: string;
  /** 目录（SKILL.md 的父目录）—— 正文里的相对路径按它解析。 */
  baseDir: string;
  /**
   * `disable-model-invocation: true` → **不进 prompt**。
   *
   * 它只能被 `/skill:<name>` 显式调用。这是 skill 作者自己声明的
   * 「别让模型自己想起来用我」（比如只有人能触发的危险操作）。
   */
  disableModelInvocation: boolean;
  /** 来自哪一层：`user`（家目录）/ `project`（工作目录）/ `path`（命令行 --skill）。 */
  scope: 'user' | 'project' | 'path';
}

/** 加载结果：清单 + 诊断（诊断是警告，不该让整次加载失败）。 */
export interface SkillRegistry {
  skills: SkillInfo[];
  /** 加载过程中的问题（重名、frontmatter 不合法…）。界面用它提示，不抛错。 */
  diagnostics: string[];
}

/**
 * pi 的 `Skill.sourceInfo` → 本项目的 scope。
 *
 * pi 用的是 `createSyntheticSourceInfo(path, { source, scope, baseDir })`，
 * 字段都在 `sourceInfo` 上；老版本可能只有 `source`。两个都读，读不到就当 `path`
 * （最保守：反正是命令行显式给的）。
 */
function readScope(skill: PiSkill): SkillRegistry['skills'][number]['scope'] {
  const info = skill.sourceInfo as unknown as { scope?: string; source?: string } | undefined;
  const raw = info?.scope ?? info?.source;
  if (raw === 'user' || raw === 'project') return raw;
  return 'path';
}

function toInfo(skill: PiSkill): SkillInfo {
  return {
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    disableModelInvocation: skill.disableModelInvocation,
    scope: readScope(skill),
  };
}

/**
 * 加载全部 skill（用户级 + 项目级）。
 *
 * 诊断**不是错误**：一个 skill 的 frontmatter 写坏了，不该让其他 skill 全部不可用
 * —— 所以只收集起来交给界面提示，加载继续。
 *
 * `paths` 是额外的显式路径（文件或目录），对应 pi 的 `--skill`；我们从命令行收。
 */
export function loadSkillRegistry(options: { cwd: string; paths?: readonly string[] }): SkillRegistry {
  let result: { skills: PiSkill[]; diagnostics: { type: string; message: string; path?: string }[] };
  try {
    result = loadSkills({
      cwd: options.cwd,
      // **必须用 `configHome()` 而不是 pi 的 `getAgentDir()`**（两者现在逐字相同）。
      // 用 configHome() 是为了「以后若真要换路径，只改一处」：现在 configHome() 就是
      // getAgentDir() 的转发，所以两者不可能分家；一旦有人改了 configHome()，
      // 这里跟着走，而不是静默指向别处。
      agentDir: configHome(),
      skillPaths: [...(options.paths ?? [])],
      includeDefaults: true,
    });
  } catch (error) {
    // 目录不存在之类的情况不该让界面起不来 —— 没有 skill 而已。
    return {
      skills: [],
      diagnostics: [`skill 加载失败：${error instanceof Error ? error.message : String(error)}`],
    };
  }
  return {
    skills: result.skills.map(toInfo),
    diagnostics: result.diagnostics.map(
      (d) => `${d.type === 'collision' ? '重名' : '警告'}：${d.message}${d.path ? `（${d.path}）` : ''}`,
    ),
  };
}

/**
 * 把 skill 清单接在 system prompt 后面。
 *
 * 用 pi 的 `formatSkillsForPrompt()` —— 它按 Agent Skills 标准的 XML 形状输出
 * （`<available_skills><skill><name>…`），模型侧的 prompt 训练就是这个形状。
 * 自己拼一个近似形状会出现「模型认得清你写的、认不清标准写法」的怪现象。
 *
 * `disableModelInvocation` 的 skill 由 pi 那边过滤掉（不进 prompt）。
 *
 * `fileReadTool` 要与**实际注册的工具**对上：pi 用它决定提示模型用 `read` 还是
 * `bash` 去读文件。我们总是有 `read`，所以传 `'read'`。
 */
export function skillsPrompt(skills: readonly SkillInfo[]): string {
  if (skills.length === 0) return '';
  // pi 要的是它自己的 Skill 形状 —— 这里把我们的字段映射回去（都是必需字段）。
  const asPi = skills.map(
    (s): PiSkill =>
      ({
        name: s.name,
        description: s.description,
        filePath: s.filePath,
        baseDir: s.baseDir,
        disableModelInvocation: s.disableModelInvocation,
        // scope/baseDir 的其余字段本项目不用；`sourceInfo` 仅用于显示，不填。
      }) as unknown as PiSkill,
  );
  return formatSkillsForPrompt(asPi, 'read');
}

/**
 * `/skill:<name> [参数]` → `<skill …>正文…</skill>` + 参数。
 *
 * ## 为什么展开成 XML 而不是直接把文件内容当用户消息
 *
 * 模型看到的是「一段任务相关的说明书」，而**调用者是人**（在输入框打了命令）。
 * 若把它当普通用户消息，模型会以为那是人说的话；展开成 `<skill>` 块 + 正文，
 * 语义上就是「参考资料」—— 与 pi 的 `_expandSkillCommand()` 完全同形，
 * `parseSkillBlock()` 也能把它还原（界面渲染成可折叠的 skill 块）。
 *
 * 正文要 `stripFrontmatter()`：frontmatter 是给装载器看的元数据（name/description），
 * 发给模型是噪声，而且 `description` 已经在清单里出现过一次。
 *
 * 未知 skill 名**原样返回**（不报错、不吞掉）：让用户看到「`/skill:xxx` 没有展开」
 * 比静默失败好 —— 静默的话用户会以为命令没生效。
 */
export function expandSkillCommand(text: string, skills: readonly SkillInfo[]): string {
  if (!text.startsWith('/skill:')) return text;
  const spaceIndex = text.indexOf(' ');
  const name = spaceIndex === -1 ? text.slice('/skill:'.length) : text.slice('/skill:'.length, spaceIndex);
  const args = spaceIndex === -1 ? '' : text.slice(spaceIndex + 1).trim();
  const skill = skills.find((s) => s.name === name);
  if (!skill) return text;
  let content: string;
  try {
    content = stripFrontmatter(readFileSync(skill.filePath, 'utf-8')).trim();
  } catch (error) {
    // 读不到就把原因留在原地，别把命令吞了 —— 用户要看得见失败。
    return `${text}\n（skill "${name}" 读取失败：${error instanceof Error ? error.message : String(error)}）`;
  }
  // 与 pi 的 `_expandSkillCommand()` 逐字同形：`References are relative to …` 那行
  // 是给模型的路径解析指令，parseSkillBlock 的正则也依赖这个块的形状。
  const block =
    `<skill name="${skill.name}" location="${skill.filePath}">\n` +
    `References are relative to ${skill.baseDir}.\n\n${content}\n</skill>`;
  return args ? `${block}\n\n${args}` : block;
}

/**
 * 从一条用户消息里认出「这是不是一个 skill 块」。
 *
 * pi 的 `parseSkillBlock()` 用正则匹配整个消息（要求**整条**就是那个块），
 * 所以只适用于 `/skill:x` 展开后那条没有别的话的消息。我们这里宽松一点：
 * 允许块后面还跟着话（用户在命令后面补了参数、或继续追问），取**开头**那个块。
 *
 * @returns 块的起止行号（`[start, end)`），认不出就 null
 */
export function findSkillBlock(message: string): { start: number; end: number } | null {
  const match = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>/.exec(message);
  if (!match || match.index !== 0) return null;
  const consumed = match[0].length;
  const rest = message.slice(consumed);
  // pi 的形状：`</skill>` 之后要么什么都没有，要么是 `\n\n` + 剩余内容。
  if (rest !== '' && !/^\n\n/.test(rest)) return null;
  const start = message.split('\n').length - 1;
  const end = start + match[0].split('\n').length;
  return { start, end };
}

/**
 * 解析成界面能画的形状（复用 pi 的 `parseSkillBlock`，保证与官方渲染组件对得上）。
 */
export function parseSkillMessage(message: string): ReturnType<typeof parseSkillBlock> {
  return parseSkillBlock(message);
}

/**
 * 这个 skill 集合对当前 state 是否可用。
 *
 * 之所以要有这个判断：system prompt 是在 `prompt.init` 时定下来的，而 skill
 * 可能**晚于**它被加载（`/reload`、新会话）。所以界面调用 `/skill:x` 前要确认
 * 它在这一轮里真的进了 prompt —— 否则模型压根不知道有这个 skill，展开过去也白搭。
 */
export function skillsInPrompt(state: AgentState): SkillInfo[] {
  return state.prompt.skills ?? [];
}

/** 补全列表用的条目（与 pi 的 skill 命令列表同形：`skill:<name>` + 描述）。 */
export function skillCommands(skills: readonly SkillInfo[]): {
  name: string;
  description: string;
}[] {
  return skills
    // `disable-model-invocation` 的 skill 仍可显式调用，所以**要**列出来
    // —— pi 也是这么做的（它的 skillCommands 遍历全部 skill）。
    .map((s) => ({ name: `skill:${s.name}`, description: s.description }));
}