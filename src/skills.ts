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
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path, { dirname, resolve } from 'node:path';
import {
  formatSkillsForPrompt,
  loadSkills,
  loadSkillsFromDir,
  parseSkillBlock,
  type Skill as PiSkill,
} from '@earendil-works/pi-coding-agent';
import { stripFrontmatter } from '@earendil-works/pi-coding-agent/dist/utils/frontmatter.js';
import { configHome, PI_CONFIG_DIR } from './config-home';
import { ENV_AGENT_DIR as PI_CODING_AGENT_DIR_ENV } from '@earendil-works/pi-coding-agent/dist/config.js';
import type { AgentState } from './state';

/**
 * 跳工具的 skill 目录名（Agent Skills 约定）。
 *
 * **手写字符串**：pi 自己没导出这个常量（它只在 `package-manager.js` 里拼路径），
 * 而这个目录名是跨工具的公开约定（`https://agentskills.io`），不是 pi 的内部实现 ——
 * 与 pi 的私有常量不同，跟着它变反而危险。
 */
const AGENTS_DIR = '.agents';

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
 * 加载全部 skill。
 *
 * ## 扫哪几个目录（这一段是本文件最要紧的部分）
 *
 * `loadSkills()` 这个便捷函数**只扫两个目录**：`<家目录>/skills` 与
 * `<cwd>/.pi/skills`。而 pi 自己**还扫第三个**：
 *
 * ```
 * ~/.agents/skills/          ← 跳工具的通用约定（Agent Skills）
 * <祖先目录>/.agents/skills/  ← 向上找到 git 仓库根为止
 * ```
 *
 * pi 里走的是 `package-manager.js` 的私有函数 `collectSkillEntries` +
 * `collectAncestorAgentsSkillDirs`（未导出）。**用户那一层最常见**：实际测过，
 * 一个真机器上 55 个 skill 全在 `~/.agents/skills/`，而 `~/.pi/agent/skills`
 * 根本不存在 —— 于是照 `loadSkills()` 的默认行为写，症状是「一个 skill 都没有」：
 * 开场没有列表、`/` 补全里也没有 skill。
 *
 * 所以这里**显式补扫**那些目录，用的是**已导出的** `loadSkillsFromDir()`
 * （它与私有的 `collectSkillEntries` 规则相同：找 `SKILL.md`、认 gitignore、
 * 目录里有 SKILL.md 就不再往下递归）。
 *
 * ## 为什么不 pnpm patch 把那两个私有函数放出来
 *
 * patch 能改文件，但这里要改的是**运行时的资源发现语义**（多扫哪几个目录、
 * 什么条件下扫），不是 `exports` 字段。patch 一旦被 pnpm 重新生成或上游升级就丢，
 * 而丢掉的症状是「skill 又全没了」—— 静默退化。为一个已经有等价公开 API 的
 * 需求去改 vendor 语义，不划算。
 *
 * ## 诊断不是错误
 *
 * 一个 skill 的 frontmatter 写坏了，不该让其他 skill 全部不可用 —— 诊断收集起来
 * 交给界面提示，加载继续。
 */
export function loadSkillRegistry(options: { cwd: string; paths?: readonly string[] }): SkillRegistry {
  const skills: PiSkill[] = [];
  const diagnostics: { type: string; message: string; path?: string }[] = [];
  /** 按 name 去重（先到先得，与 pi 的行为一致：用户级优先于 .agents）。 */
  const seen = new Map<string, string>();
  const add = (result: { skills: PiSkill[]; diagnostics: typeof diagnostics }, scope?: SkillInfo['scope']): void => {
    diagnostics.push(...result.diagnostics);
    for (const skill of result.skills) {
      if (seen.has(skill.name)) {
        diagnostics.push({
          type: 'collision',
          message: `name "${skill.name}" collision`,
          path: skill.filePath,
        });
        continue;
      }
      seen.set(skill.name, skill.filePath);
      skills.push(scope ? ({ ...skill, scope } as PiSkill) : skill);
    }
  };

  // 1) pi 自己的两个默认目录（<家目录>/skills 与 <cwd>/.pi/skills）。
  try {
    add(
      loadSkills({
        cwd: options.cwd,
        // **必须用 `configHome()` 而不是 pi 的 `getAgentDir()`**（两者现在逐字相同）。
        // 用 configHome() 是为了「以后若真要换路径，只改一处」：现在 configHome() 就是
        // getAgentDir() 的转发，所以两者不可能分家；一旦有人改了 configHome()，
        // 这里跟着走，而不是静默指向别处。
        agentDir: configHome(),
        skillPaths: [...(options.paths ?? [])],
        includeDefaults: true,
      }),
    );
  } catch (error) {
    // 目录不存在之类的情况不该让界面起不来 —— 没有 skill 而已。
    diagnostics.push({
      type: 'warning',
      message: `skill 加载失败：${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // 2) `~/.agents/skills` —— 跳工具的通用约定。**用户装 skill 通常装在这儿**。
  //
  // `home` 走 `agentsHome()` 而不是直接 `os.homedir()`：`~` 不可重定向，
  // 测试就隔离不掉（会读到开发者真实家目录里的 55 个 skill，断言变成“测试机上
  // 碰巧过了”）。`PI_CODING_AGENT_DIR` 指向临时目录时，`~/.agents` 取它的父目录 ——
  // 也就是「家目录本身」搬家时，这个目录跟着走，与 pi 的行为一致。
  const userAgentsHome = agentsHomeDir();
  add(scanDir(path.join(userAgentsHome, AGENTS_DIR, 'skills'), 'user'));
  // 3) 从 cwd 向上每一层的 `.agents/skills`，到 git 仓库根为止（与 pi 一致）。
  for (const dir of ancestorAgentsSkillDirs(options.cwd)) {
    if (resolve(dir) === resolve(path.join(userAgentsHome, AGENTS_DIR, 'skills'))) continue;
    add(scanDir(dir, 'project'));
  }

  return {
    skills: skills.map(toInfo),
    diagnostics: diagnostics.map(
      (d) => `${d.type === 'collision' ? '重名' : '警告'}：${d.message}${d.path ? `（${d.path}）` : ''}`,
    ),
  };
}

/**
 * `~/.agents` 所在的家目录。
 *
 * `PI_CODING_AGENT_DIR` 默认是 `<家>/.pi/agent`。设了它就以它为准，没设就是真的 `~`。
 *
 * ## 为什么要这条间接
 *
 * `~` 不可重定向，而 `.agents/skills` 恰恰是真实用户装 skill 的地方（实测一台机器上
 * 55 个全在那儿）。不隔离的话，测试会读到开发者真实家目录，断言变成「这台机器上
 * 碰巧过」—— 而且换个环境就红。
 *
 * ## 怎么推出家目录
 *
 * **认形状而不是猜**：真实形状是 `<家>/.pi/agent`（`PI_CONFIG_DIR` 与 `agent` 两段），
 * 所以家目录是它的**上两级**。若 agentDir 的父目录不叫 `.pi`（例如测试把它指到
 * `<临时>/home`），那它**自身**就是家目录 —— 此时只上一级。
 *
 * 早先写过两个错版本：「只上一次 dirname」（于是认成 `<家>/.pi`，`.agents` 落进 `.pi`
 * 里，真实用户的 55 个 skill 一个都扫不到），以及「两级 + 认不出就退回 `~`」——
 * 后者更糟：退回 `~` 意味着测试会读到开发者真实家目录，断言变成「这台机器上碰巧过」。
 *
 * 现在的规则没有「退回 `~`」这个分支：认得出 `.pi` 就两级，认不出就一级。两者都不会
 * 跑到真实 `~` 去（只有变量没设时才用 `~`）。
 */
function agentsHomeDir(): string {
  const agentDir = process.env[PI_CODING_AGENT_DIR_ENV];
  // 没设 → 真 `~`（用户正常情况，也是 pi 的行为）。
  if (!agentDir) return os.homedir();
  const resolved = path.resolve(agentDir);
  // 父目录叫 `.pi` → 上两级才是家目录；否则 agentDir 本身就是家目录 → 上一级。
  return path.basename(path.dirname(resolved)) === PI_CONFIG_DIR
    ? path.dirname(path.dirname(resolved))
    : path.dirname(resolved);
}

/** 扫一个目录（不存在就当空）。异常一律降级成诊断，不往上抛。 */
function scanDir(dir: string, scope: SkillInfo['scope']): {
  skills: PiSkill[];
  diagnostics: { type: string; message: string; path?: string }[];
} {
  if (!existsSync(dir)) return { skills: [], diagnostics: [] };
  try {
    const result = loadSkillsFromDir({ dir, source: scope });
    // `source` 只影响 pi 内部记的 sourceInfo；scope 我们自己定（见上面的 add）。
    return {
      skills: result.skills,
      diagnostics: result.diagnostics as { type: string; message: string; path?: string }[],
    };
  } catch (error) {
    return {
      skills: [],
      diagnostics: [
        { type: 'warning', message: `扫 ${dir} 失败：${error instanceof Error ? error.message : String(error)}` },
      ],
    };
  }
}

/**
 * 从 `startDir` 向上每一层目录的 `.agents/skills`。
 *
 * ## 上界为什么要加一层
 *
 * pi 的 `collectAncestorAgentsSkillDirs()` 上界是 **git 仓库根**。但 `gitRoot` 为 null
 * 时（cwd 不在任何仓库里 —— 临时目录、用户直接开一个新目录），那个循环会**一直走到盘符
 * 根**：于是 `C:\Users\<名>\AppData\Local\Temp\某临时目录\project` 会扫到
 * `C:\Users\<名>\.agents\skills`，也就是开发者自己家目录里的 55 个 skill。
 *
 * 症状不报错，只是「测试机上碰巧过」+ 换个环境就红。
 *
 * 所以取**家目录**作上界，而不是 pi 的 git 根。
 *
 * 真实项目里 git 根在 cwd 与家目录之间，所以这个上界**不改变**pi 在项目里的行为 ——
 * 它只是剪掉「越界到盘符根」那段危险的尾巴（不在仓库里时 pi 会一路走到 `C:\`，
 * 于是 `Temp\某目录\project` 会扫到 `C:\Users\<名>\.agents\skills`，也就是开发者自己
 * 家目录里的 skill）。
 *
 * 要用仓库根**以上**的 `.agents`（monorepo 里子目录想用上层共享 skill）请显式
 * `--skill`，不做隐式 —— 隐式扫到用户家目录这件事的失败模式是「测试机上碰巧过」。
 */
function ancestorAgentsSkillDirs(startDir: string): string[] {
  const dirs: string[] = [];
  const home = resolve(agentsHomeDir());
  let dir = resolve(startDir);
  // cwd 常常**不在家目录下面**（容器 / CI / 临时目录跑测试），这时向上永远碰不到 home，
  // 循环会一直走到盘符根 —— 而 `C:\Users\<名>\.agents\skills` 里可能有几十个 skill，
  // 于是测试读到开发者自己的家目录。判据是「走到 home **或** home 不在祖先链上」。
  const homeIsAncestor = dir === home || dir.startsWith(home + path.sep);
  for (;;) {
    dirs.push(path.join(dir, AGENTS_DIR, 'skills'));
    if (dir === home || !homeIsAncestor) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/** 向上找 `.git` 所在的目录（没有就是 null）。 */
function findGitRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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