/**
 * Prompt 模板接入（`packages/core/src/prompts.ts` + 首发横幅 / 补全 / 提交的接线）。
 *
 * ## 这批盯的契约
 *
 * 1. **目录来源与 pi 一致** —— `~/.pi/agent/prompts`（`user`）与 `<cwd>/.pi/prompts`
 *    （`project`）都要扫到。自己拼目录列表的话，pi 升级后两边会静默分家。
 * 2. **frontmatter 的三个字段都读对** —— `description` 进补全、`argument-hint` 进补全、
 *    body 才是展开后发出去的内容（frontmatter 不能漏进 prompt）。
 * 3. **展开规则交给 pi** —— `$1` / `$@` / `${1:-默认值}` 与 shell 引号切分逐字同形；
 *    未知名字原样返回（调用方据此当普通输入发送，不能吞掉输入）。
 * 4. **补全条目的形状与 pi 的 `templateCommands` 一致** —— 名字不带斜杠。
 *
 * 全程离线：自己造临时家目录与项目目录，不读用户真实的 `~/.pi/agent/prompts`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  expandPromptTemplate,
  loadPromptRegistry,
  promptCommands,
  promptTemplatesInPrompt,
  type PromptTemplateInfo,
} from '@ela/core/prompts';
import { createAgentReducer } from '@ela/core/reducer';
import { createInitialState, type AgentState } from '@ela/core/state';
import type { AgentAction } from '@ela/core/actions';
import type { SkillInfo } from '@ela/core/skills';
import { routeSlashInput } from '../src/app';

/**
 * 造一个临时「家目录 + 工作目录」并在其中跑一段测试。
 *
 * **两个环境变量都要改**（与 `skills.test.ts` 同一个理由）：`PI_CODING_AGENT_DIR`
 * （用户级 prompts 的位置）与 `HOME`（pi 的 `getHomeDir()` 读它）。只改前者的话，
 * 后几条路径仍会指向开发者真实家目录 —— 而且这个测试会往那个目录写、再删掉。
 */
async function withProject(
  build: (cwd: string, agentDir: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'prompts-home-'));
  const home = path.join(root, 'home');
  const agentDir = path.join(home, '.pi', 'agent');
  const cwd = path.join(root, 'project');
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const prevAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const prevHome = process.env['HOME'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  process.env['HOME'] = home;
  try {
    await build(cwd, agentDir);
  } finally {
    if (prevAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = prevAgentDir;
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    await rm(root, { recursive: true, force: true });
  }
}

/** 写一个模板文件（filename 即命令名）。 */
async function writeTemplate(
  dir: string,
  name: string,
  frontmatter: string,
  body: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.md`), `${frontmatter}\n${body}\n`, 'utf8');
}

async function loadBoth(cwd: string): Promise<PromptTemplateInfo[]> {
  const { prompts, diagnostics } = await loadPromptRegistry({ cwd });
  assert.deepEqual(diagnostics, [], `不该有诊断：${diagnostics.join('；')}`);
  return prompts;
}

test('扫 ~/.pi/agent/prompts（用户级）与 <cwd>/.pi/prompts（项目级）', async () => {
  await withProject(async (cwd, agentDir) => {
    await writeTemplate(
      path.join(agentDir, 'prompts'),
      'council',
      '---\ndescription: Run a council\nargument-hint: "<question>"\n---',
      'Council protocol body.',
    );
    await writeTemplate(
      path.join(cwd, '.pi', 'prompts'),
      'review-loop',
      '---\ndescription: Review loop\n---',
      'Review loop body.',
    );
    const prompts = await loadBoth(cwd);
    const byName = new Map(prompts.map((p) => [p.name, p]));
    assert.equal(byName.get('council')?.scope, 'user');
    assert.equal(byName.get('council')?.argumentHint, '<question>');
    assert.equal(byName.get('review-loop')?.scope, 'project');
    // frontmatter 不能漏进正文：正文是展开后直接发给模型的那段。
    assert.equal(byName.get('review-loop')?.content.trim(), 'Review loop body.');
  });
});

test('展开参数：与 pi 同一套 $1 / $@ / ${1:-默认值} 规则', async () => {
  const prompts: PromptTemplateInfo[] = [
    {
      name: 'review',
      description: 'Review',
      argumentHint: '[focus]',
      content: 'Review the changes. Focus on ${1:-correctness}. Extra: $@',
      filePath: '/tmp/review.md',
      scope: 'user',
    },
  ];
  assert.equal(
    expandPromptTemplate('/review', prompts),
    'Review the changes. Focus on correctness. Extra: ',
  );
  assert.equal(
    expandPromptTemplate('/review "API compatibility"', prompts),
    'Review the changes. Focus on API compatibility. Extra: API compatibility',
  );
  // 引号里带空格是一个参数（shell 风格切分，pi 的 parseCommandArgs）。
  assert.match(
    expandPromptTemplate('/review "API compatibility"', prompts),
    /Focus on API compatibility/,
  );
  // 未知名字原样返回 —— 调用方据此当普通输入发送。
  assert.equal(expandPromptTemplate('/nope x', prompts), '/nope x');
  // 不是斜杠开头的一律不动。
  assert.equal(expandPromptTemplate('review', prompts), 'review');
});

test('补全条目：名字不带斜杠，argumentHint 有就透传', async () => {
  const prompts: PromptTemplateInfo[] = [
    {
      name: 'council',
      description: 'Run a council',
      argumentHint: '<question>',
      content: '',
      filePath: '/tmp/council.md',
      scope: 'path',
    },
    {
      name: 'parallel-review',
      description: 'Parallel review',
      content: '',
      filePath: '/tmp/parallel-review.md',
      scope: 'path',
    },
  ];
  assert.deepEqual(promptCommands(prompts), [
    { name: 'council', description: 'Run a council', argumentHint: '<question>' },
    { name: 'parallel-review', description: 'Parallel review' },
  ]);
});

test('routeSlashInput：skill → 模板 → 命令 → 未命中当普通输入', async () => {
  await withProject(async (cwd, agentDir) => {
    const skillDir = path.join(agentDir, 'skills', 'demo');
    const skillFile = path.join(skillDir, 'SKILL.md');
    await mkdir(skillDir, { recursive: true });
    await writeFile(skillFile, '---\nname: demo\ndescription: 演示\n---\n\n正文。\n', 'utf8');
    const skills: SkillInfo[] = [
      {
        name: 'demo',
        description: '演示',
        filePath: skillFile,
        baseDir: path.join(agentDir, 'skills'),
        disableModelInvocation: false,
        scope: 'user',
      },
    ];
    const prompts: PromptTemplateInfo[] = [
      {
        name: 'council',
        description: 'Run a council',
        content: 'Council on ${1:-这个问题}。',
        filePath: path.join(agentDir, 'prompts', 'council.md'),
        scope: 'user',
      },
      // 名字与内置命令撞车：命令优先，模板不展开（与 pi 一致）。
      {
        name: 'skills',
        description: 'shadowed',
        content: '不该走到这里',
        filePath: path.join(agentDir, 'prompts', 'skills.md'),
        scope: 'user',
      },
    ];
    const isCommand = (name: string): boolean => name === 'skills' || name === 'ext-thing';

    const skillRoute = routeSlashInput('/skill:demo 帮我看看', skills, prompts, isCommand);
    assert.equal(skillRoute.kind, 'skill');
    assert.match(skillRoute.kind === 'skill' ? skillRoute.text : '', /^<skill name="demo"/);

    assert.deepEqual(routeSlashInput('/council 要不要拆包', skills, prompts, isCommand), {
      kind: 'template',
      text: 'Council on 要不要拆包。',
    });
    assert.deepEqual(routeSlashInput('/skills', skills, prompts, isCommand), { kind: 'command' });
    assert.deepEqual(routeSlashInput('/ext-thing', skills, prompts, isCommand), { kind: 'command' });

    // **未命中的 `/xxx` 不是错误**：当普通用户输入发送（含 `/文件名` 这类）。
    assert.deepEqual(routeSlashInput('/etc/hosts', skills, prompts, isCommand), { kind: 'message' });
    assert.deepEqual(routeSlashInput('/文件名 看看', skills, prompts, isCommand), { kind: 'message' });
    assert.deepEqual(routeSlashInput('/skill:nope 你好', skills, prompts, isCommand), {
      kind: 'message',
    });
  });
});

test('prompt.init 把模板与诊断装进 state（开场横幅与补全都读它）', async () => {
  const reducer = createAgentReducer({});
  /** 一个够 reducer 用的初始状态（与 skills.test.ts 同一个形状）。 */
  const seed = createInitialState({ systemPrompt: 'S', providerName: 'p', modelId: 'm', toolNames: [] });
  /** reducer 的返回值可能是 `AgentState | Loop<AgentState>`，这里收窄。 */
  const reduce = (state: AgentState, action: AgentAction): AgentState =>
    reducer(state, action) as AgentState;
  const prompts: PromptTemplateInfo[] = [
    {
      name: 'council',
      description: 'Run a council',
      content: 'body',
      filePath: '/tmp/council.md',
      scope: 'path',
    },
  ];
  const state = reduce(seed, {
    type: 'prompt.init',
    systemPrompt: 'S',
    tools: [],
    skills: [],
    promptTemplates: prompts,
    promptDiagnostics: ['重名：/council（/a.md、/b.md）'],
  } as AgentAction);
  assert.deepEqual(promptTemplatesInPrompt(state), prompts);
  assert.deepEqual(state.prompt.promptDiagnostics, ['重名：/council（/a.md、/b.md）']);

  // 换会话（`/new`）时 prompt 块带着走 —— 模板不该在对话重置后凭空消失。
  const reset = reduce(state, { type: 'conversation.reset', sessionId: 'next' } as AgentAction);
  assert.deepEqual(promptTemplatesInPrompt(reset), prompts);
});
