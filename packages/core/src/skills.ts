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
 * import { DefaultResourceLoader, parseSkillBlock } from '@earendil-works/pi-coding-agent';
 * ```
 *
 * 所以这里只做两件薄薄的事：
 *
 * 1. `loadSkillRegistry()` —— 调 pi 的 `DefaultResourceLoader`，**目录发现、去重、重名
 *    判定全部照抄它的结果**；我们只把 `Skill[]` 收进本项目的形状；
 * 2. `expandSkillCommand()` —— 调 pi 的 `parseSkillBlock()` 的**同一个** XML 形状，
 *    把 `/skill:name` 展开成 `<skill …>…</skill>`。
 *
 * **「把清单接进 prompt」这件事不再在这里做** —— 它是 pi 的 `buildSystemPrompt` 拼的
 * `<skills>` 段（见 [system-prompt.ts](system-prompt.ts)）。早先这里是
 * `skillsPrompt()`：接在基础 prompt 尾巴上一段**裸文本**（模型分不清那是系统规则还是
 * 用户说话），而且与内核那处拼法各拼一遍 —— 迟早漂移，症状是「清单出现两次」。
 *
 * ## 为什么是 `DefaultResourceLoader`，而不是 `loadSkills()`
 *
 * 早先这里自己拼目录列表、自己按名字去重，理由是 `loadSkills()` 只扫
 * `<agentDir>/skills` 与 `<cwd>/.pi/skills` 两处。那样写的症状有两个，都在真机上出现过：
 *
 * 1. **重名的赢家与 pi 不一样**。pi 的加载顺序是「项目 `.pi` → 项目 `.agents` →
 *    用户 `.pi/agent` → 用户 `.agents`」（`package-manager.js` 的 addResources），
 *    而这里按「用户 → 项目」的直觉顺序扫 —— 于是同一个重名 skill，pi 用项目那份，
 *    我们用用户那份。清单里名字一样、正文却不是一个文件。
 * 2. **`.agents` 下的裸 Markdown 读不到**。pi 在 `agents` 模式下把子目录里的 `*.md`
 *    当作 skill（`collectSkillEntries`），我们调的 `loadSkillsFromDir()` 只认 `SKILL.md`。
 *
 * 自己复刻这套（目录、`.gitignore`、`mode: pi|agents`、按文件路径去重再按名字判重）
 * 只会得到一个**会漂移的副本**。`DefaultResourceLoader` 就是 pi 自己用来装资源的那一层，
 * 用它 = 与 pi 逐字同行为，不用跟着上游改。
 *
 * 代价：它是 `async` 的（pi 的 PackageManager 是异步接口），所以
 * `loadSkillRegistry()` 也成了 `async`。
 */
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DefaultResourceLoader,
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
  /**
   * 正文里相对路径按它解析 —— **与 pi 同一口径**。
   *
   * 注意它不是 SKILL.md 的父目录，而是 pi 记在 `sourceInfo.baseDir` 上的那一层
   * （`~/.pi/agent` / `<cwd>/.pi` / `<家>/.agents`）。`expandSkillCommand()`
   * 写的 `References are relative to …` 与 pi 逐字一致靠的就是它。
   */
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
 * pi 的 `Skill.sourceInfo.scope` → 本项目的 scope。
 *
 * pi 三层：`user`（家目录）/ `project`（工作目录及其祖先）/ `temporary`（命令行
 * `--skill` 给的）。我们界面上的第三档叫 `path`，所以只换这一个名字。
 */
function readScope(skill: PiSkill): SkillInfo['scope'] {
  const raw = skill.sourceInfo?.scope;
  if (raw === 'user' || raw === 'project') return raw;
  return 'path';
}

function toInfo(skill: PiSkill): SkillInfo {
  return {
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    // pi 把「相对路径按哪儿解析」记在 sourceInfo.baseDir 上（`.pi` / `.agents`
    // 这一层），而不是 SKILL.md 的父目录 —— 与 pi 的 `References are relative to …`
    // 逐字一致（见 expandSkillCommand）。取不到才退回父目录。
    baseDir: skill.sourceInfo?.baseDir ?? skill.baseDir ?? dirname(skill.filePath),
    disableModelInvocation: skill.disableModelInvocation,
    scope: readScope(skill),
  };
}

/**
 * 加载全部 skill —— **目录发现、去重、重名判定全部交给 pi 的 `DefaultResourceLoader`**。
 *
 * 那正是 pi 自己装资源用的那一层（`~/.pi/agent` 用户级、`<cwd>/.pi` 项目级、
 * `<cwd>` 及祖先的 `.agents/skills`、`<家>/.agents/skills`），所以「有哪些 skill」
 * 与「重名谁赢」与 pi 逐字相同 —— 而这两个恰好是最容易悄悄分家的地方（见文件头）。
 *
 * `noExtensions` / `noPromptTemplates` / `noThemes` / `noContextFiles` 全开：这里只要
 * skill。pi 的 loader 顺手把别的资源也装了，关掉它们既省事也避免把扩展加载的副作用
 * 拖进来（那是宿主自己的事，见 extension-host.ts）。
 *
 * 项目信任：**不传 `resolveProjectTrust`**，于是 pi 的 `SettingsManager` 走它自己的
 * 默认（信任）。这与本文件早先的行为一致（项目级 skill 无条件加载）—— 见
 * system-prompt.ts 文件头那条「一处与 pi 的差异：项目信任」。
 *
 * ## 诊断不是错误
 *
 * 一个 skill 的 frontmatter 写坏了、或两个目录重名，不该让其他 skill 全部不可用 ——
 * pi 把这两类都收进 `diagnostics`，我们原样转成界面能读的一行，加载继续。
 */
export async function loadSkillRegistry(options: {
  cwd: string;
  paths?: readonly string[];
}): Promise<SkillRegistry> {
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    // **用 `configHome()` 而不是 pi 的 `getAgentDir()`**（两者现在逐字相同）。
    // 用 configHome() 是为了「以后若真要换路径，只改一处」：现在 configHome() 就是
    // getAgentDir() 的转发，所以两者不可能分家；一旦有人改了 configHome()，
    // 这里跟着走，而不是静默指向别处。
    agentDir: configHome(),
    additionalSkillPaths: [...(options.paths ?? [])],
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  try {
    await loader.reload();
  } catch (error) {
    // 目录不存在之类的情况不该让界面起不来 —— 没有 skill 而已。
    return {
      skills: [],
      diagnostics: [`警告：skill 加载失败：${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const { skills, diagnostics } = loader.getSkills();
  return {
    skills: skills.map(toInfo),
    diagnostics: diagnostics.map(
      (d) => `${d.type === 'collision' ? '重名' : '警告'}：${d.message}${d.path ? `（${d.path}）` : ''}`,
    ),
  };
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