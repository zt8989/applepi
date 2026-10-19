/**
 * Prompt 模板（pi 的 Prompt Templates）—— 复用 pi 官方的加载器与展开函数，不自己实现一份。
 *
 * ## 这是什么
 *
 * `~/.pi/agent/prompts/*.md`（或项目 `.pi/prompts/`、pi 包里 `pi.prompts` 点名的路径）
 * 里的一个 Markdown 文件就是一个 `/` 命令：文件名是命令名，frontmatter 的 `description`
 * 进补全，正文是**发给模型的提示词**。它没有可执行行为 —— 只是把一段常写的提示词
 * 变成 `/review` 这样的短命令。
 *
 * ## 为什么直接用 `DefaultResourceLoader`
 *
 * 与 [skills.ts](skills.ts) 同一个理由：目录发现、项目/用户层级、重名谁赢、
 * pi 包清单（`settings.json` 的 `packages` → `package.json` 的 `pi.prompts`）
 * 全在 pi 的这条装载链上。自己复刻只会得到一个会漂移的副本 —— 症状是
 * 「pi 里 `/council` 能用，ela 里同一个包装了却找不到」。
 *
 * 只留 prompt：`noExtensions` / `noSkills` / `noThemes` / `noContextFiles` 全开，
 * 把扩展装载的副作用（jiti、MCP 子进程）挡在外面 —— 那是宿主自己的事
 * （见 extension-host.ts）。
 *
 * ## 展开也交给 pi
 *
 * `/review concurrency` → 正文里的 `$1` / `$@` / `${1:-默认值}` 替换规则是 pi 的
 * `expandPromptTemplate()` 实现的。参数按 shell 引号切分、替换只发生在模板正文上，
 * 这些细节抄一遍就会漂；而模板作者是按 pi 的文档写的。
 */
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { expandPromptTemplate as expandWithPi } from '@earendil-works/pi-coding-agent/dist/core/prompt-templates.js';
import type { PromptTemplate as PiPromptTemplate } from '@earendil-works/pi-coding-agent/dist/core/prompt-templates.js';
import { configHome } from './config-home';
import type { AgentState } from './state';

/** 一个 prompt 模板的形状（只留界面与展开要用的字段）。 */
export interface PromptTemplateInfo {
  /** 命令名（文件名去掉 `.md`）—— `/review` 用的就是它。 */
  name: string;
  /** 一句话描述，补全里显示；模板没写 frontmatter 时 pi 用正文第一行。 */
  description: string;
  /** `argument-hint`：补全里跟在命令名后面的参数提示（如 `[focus]`）。 */
  argumentHint?: string;
  /** 正文（已去掉 frontmatter）—— 展开时直接替换参数后发出。 */
  content: string;
  /** 模板文件的绝对路径（诊断与 `/prompts` 之类的展示用）。 */
  filePath: string;
  /** 来自哪一层：`user`（家目录）/ `project`（工作目录）/ `path`（显式路径 / 包）。 */
  scope: 'user' | 'project' | 'path';
}

/** 加载结果：清单 + 诊断（诊断是警告，不该让整次加载失败）。 */
export interface PromptRegistry {
  prompts: PromptTemplateInfo[];
  /** 加载过程中的问题（重名、frontmatter 不合法…）。界面用它提示，不抛错。 */
  diagnostics: string[];
}

/**
 * pi 的 `SourceInfo.scope` → 本项目的 scope。
 *
 * pi 三层：`user` / `project` / `temporary`（命令行显式路径与包）。界面上的第三档
 * 叫 `path`，与 `skills.ts` 的 `readScope()` 保持同一个名字。
 */
function readScope(template: PiPromptTemplate): PromptTemplateInfo['scope'] {
  const raw = template.sourceInfo?.scope;
  if (raw === 'user' || raw === 'project') return raw;
  return 'path';
}

function toInfo(template: PiPromptTemplate): PromptTemplateInfo {
  return {
    name: template.name,
    description: template.description,
    ...(template.argumentHint !== undefined ? { argumentHint: template.argumentHint } : {}),
    content: template.content,
    filePath: template.filePath,
    scope: readScope(template),
  };
}

/**
 * 加载全部 prompt 模板。
 *
 * 与 `loadSkillRegistry()` 同一条装载链（`DefaultResourceLoader`）：
 * `~/.pi/agent/prompts`、`<cwd>/.pi/prompts`、`settings.json` 里 `packages` 声明的
 * `pi.prompts`、以及（将来接 CLI 时的）显式路径。
 *
 * 加载失败只收成 diagnostics：一个写坏 frontmatter 的模板不该让界面起不来。
 */
export async function loadPromptRegistry(options: {
  cwd: string;
  paths?: readonly string[];
}): Promise<PromptRegistry> {
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    // 与 skills.ts 同一个理由：用 configHome() 而不是 pi 的 getAgentDir()，
    // 两者现在逐字相同，将来真要换路径也只改一处。
    agentDir: configHome(),
    additionalPromptTemplatePaths: [...(options.paths ?? [])],
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
  });
  try {
    await loader.reload();
  } catch (error) {
    // 目录不存在之类的情况不该让界面起不来 —— 没有模板而已。
    return {
      prompts: [],
      diagnostics: [`警告：prompt 模板加载失败：${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const { prompts, diagnostics } = loader.getPrompts();
  return {
    prompts: prompts.map(toInfo),
    diagnostics: diagnostics.map(
      (d) => `${d.type === 'collision' ? '重名' : '警告'}：${d.message}${d.path ? `（${d.path}）` : ''}`,
    ),
  };
}

/**
 * `/名字 [参数]` → 展开后的提示词。没有同名模板时**原样返回**。
 *
 * 展开规则整个交给 pi（`expandPromptTemplate()`）：`$1` / `$@` / `${1:-默认值}`、
 * shell 风格的引号切分，全与模板作者在 pi 文档里看到的一致。
 *
 * 与 `expandSkillCommand()` 同一个约定：认不出就原样返回，由调用方决定当命令处理
 * 还是报「未知命令」—— 在这里吞掉会让输入凭空消失。
 */
export function expandPromptTemplate(
  text: string,
  prompts: readonly PromptTemplateInfo[],
): string {
  return expandWithPi(text, prompts as unknown as PiPromptTemplate[]);
}

/**
 * 补全列表用的条目。
 *
 * 形状与 pi 的 `templateCommands` 一致：名字**不带**开头的斜杠（补全提供者自己加），
 * `argumentHint` 有就透传。
 */
export function promptCommands(prompts: readonly PromptTemplateInfo[]): {
  name: string;
  description: string;
  argumentHint?: string;
}[] {
  return prompts.map((p) => ({
    name: p.name,
    description: p.description,
    ...(p.argumentHint !== undefined ? { argumentHint: p.argumentHint } : {}),
  }));
}

/**
 * 当前这一轮可用的 prompt 模板。
 *
 * 读 `state.prompt.promptTemplates`（装载时由 `prompt.init` 定下）：与 skill 一样，
 * 换会话（`/new`、`/resume`）后仍然有效，而不必在界面层各存一份。
 */
export function promptTemplatesInPrompt(state: AgentState): PromptTemplateInfo[] {
  return state.prompt.promptTemplates ?? [];
}
