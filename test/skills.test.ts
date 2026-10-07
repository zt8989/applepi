/**
 * Skill 接入（`src/skills.ts` + reducer/kernel/tui 的接线）。
 *
 * ## 这批盯的契约
 *
 * 1. **prompt 里真的有清单** —— skill 不进 prompt，模型压根不知道它存在，
 *    `/skill:x` 展开过去也只是多一堆没头没尾的文字。
 * 2. **目录来源正确** —— skill 从 `configHome()` 读，而它就是 pi 的 `getAgentDir()`。
 *    早先本项目另有 `REDUX_AGENT_DIR`（优先级更高）而 pi 不认它，症状是
 *    「skill 永远从真实家目录加载」：测试隔离不住，用户搬家后配置跟着走而 skill 不跟。
 *    现在只剩 `PI_CODING_AGENT_DIR` 一个变量，两边不可能分家。
 * 3. **`/skill:x` 展开成 pi 那个 XML 形状** —— 与 pi 的 `_expandSkillCommand()`
 *    逐字同形，官方 `parseSkillBlock()` 才能还原、官方渲染组件才画得出。
 * 4. **失败不吞** —— 未知 skill / 读不到文件都要看得见，不能静默。
 *
 * 全程离线：自己造临时 skill 目录，不读用户真实的 `~/.pi/agent/skills`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setupTheme } from '../src/tui/theme';
import {
  expandSkillCommand,
  loadSkillRegistry,
  skillCommands,
  skillsPrompt,
  type SkillInfo,
} from '../src/skills';
import { createAgentReducer } from '../src/reducer';
import { createInitialState } from '../src/state';
import { renderTranscript } from '../src/tui/app';
import { PI_CONFIG_DIR } from '../src/config-home';
import type { AgentState } from '../src/state';
import type { AgentAction, PromptToolDefinition } from '../src/actions';
import type { Message } from '@earendil-works/pi-ai';

setupTheme(undefined, 'dark');

/**
 * 家目录下的 skill 位置。
 *
 * **不是 `<home>/skills`** —— pi 的 `loadSkills()` 扫的是 `<agentDir>/skills`，而
 * agentDir 是 `~/.pi/agent`，所以真实位置是 `~/.pi/agent/skills`。
 * 写成 `<home>/skills` 时测试也能过（那时 agentDir 恰好等于 home），一旦 agentDir
 * 改成真形状就静默失效。
 */
function userSkillsDir(home: string): string {
  return path.join(home, PI_CONFIG_DIR, 'agent', 'skills');
}

/**
 * 造一个临时「家目录」+ 工作目录。
 *
 * **家目录按真形状摆**：`<root>/home/.pi/agent`。因为 skill 除了 `<agentDir>/skills`
 * 还会扫 `<家>/.agents/skills`（跳工具约定），而 `~` 不可重定向 —— 实现靠
 * `PI_CODING_AGENT_DIR` 的**父目录名叫 `.pi`** 推出家目录。摆成别的形状就推不出来，
 * 于是会退回真实 `~`，读到开发者自己的 55 个 skill（断言变成「这台机器上碰巧过」）。
 */
async function withSkills(
  build: (home: string, cwd: string) => Promise<void>,
): Promise<{ home: string; cwd: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'skills-home-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  await mkdir(path.join(home, PI_CONFIG_DIR, 'agent'), { recursive: true });
  await mkdir(cwd, { recursive: true });
  const previous = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = path.join(home, PI_CONFIG_DIR, 'agent');
  try {
    await build(home, cwd);
    return { home, cwd };
  } finally {
    if (previous === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previous;
    await rm(root, { recursive: true, force: true });
  }
}

/** 写一个 skill（目录里放 SKILL.md）。 */
async function writeSkill(dir: string, name: string, body: string): Promise<void> {
  await mkdir(path.join(dir, name), { recursive: true });
  await writeFile(
    path.join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} 的说明\n---\n\n${body}\n`,
    'utf8',
  );
}

test('扫 ~/.agents/skills（跳工具约定 —— 用户装 skill 通常在这儿）', async () => {
  // 这条是**真实 bug 的回归**：第一版只调 loadSkills()，而它只扫
  // <agentDir>/skills 与 <cwd>/.pi/skills —— **不扫** `~/.agents/skills`。而 pi 自己
  // 是扫的（package-manager.js 的 collectSkillEntries 那条路径）。实测一台机器上
  // 55 个 skill 全在 ~/.agents/skills、而 ~/.pi/agent/skills 根本不存在，于是症状是
  // 「一个 skill 都没有」：开场没列表、`/` 补全里也没有。
  await withSkills(async (home, cwd) => {
    await writeSkill(path.join(home, '.agents', 'skills'), 'agents-level', '家目录 .agents');
    const registry = loadSkillRegistry({ cwd });
    assert.deepEqual(
      registry.skills.map((s) => s.name),
      ['agents-level'],
      `~/.agents/skills 要能被扫到，实际：${registry.skills.map((s) => s.name).join(',')}`,
    );
    assert.equal(registry.skills[0]?.scope, 'user');
  });
});

test('扫 cwd 向上每一层的 .agents/skills（到 home 为止）', async () => {
  await withSkills(async (home, cwd) => {
    // cwd 自己这一层 + 上到 home 的中间层。
    await writeSkill(path.join(cwd, '.agents', 'skills'), 'at-cwd', '就在 cwd');
    const registry = loadSkillRegistry({ cwd });
    assert.ok(
      registry.skills.some((s) => s.name === 'at-cwd'),
      `cwd 自己的 .agents 要能被扫到：${registry.skills.map((s) => s.name).join(',')}`,
    );
    assert.equal(registry.skills.find((s) => s.name === 'at-cwd')?.scope, 'project');
  });
});

test('不会顺着祖先链一路扫到开发者真实家目录（cwd 不在 home 下时）', async () => {
  // 回归：上界早先只认「正好等于 home」，而测试的 cwd 是 <root>/project、home 是
  // <root>/home —— cwd 不是 home 的子目录，于是向上永远碰不到 home，循环走到盘符根，
  // 扫到了 C:\Users\<名>\.agents\skills（实测 55 个）。断言变成「这台机器上碰巧过」。
  await withSkills(async (home, cwd) => {
    assert.ok(!cwd.startsWith(home + path.sep), '本测试的前提就是 cwd 不在 home 下');
    await writeSkill(userSkillsDir(home), 'only-mine', '只该看到我自己的');
    const registry = loadSkillRegistry({ cwd });
    assert.deepEqual(
      registry.skills.map((s) => s.name),
      ['only-mine'],
      `扫到了不该看到的：${registry.skills.map((s) => s.name).join(',')}`,
    );
  });
});

test('重名时先到先得（用户级胜过 .agents），并给诊断', async () => {
  await withSkills(async (home, cwd) => {
    await writeSkill(userSkillsDir(home), 'dup', '来自 .pi/agent');
    await writeSkill(path.join(home, '.agents', 'skills'), 'dup', '来自 .agents');
    const registry = loadSkillRegistry({ cwd });
    const dup = registry.skills.filter((s) => s.name === 'dup');
    assert.equal(dup.length, 1, '同名只应留一个');
    assert.ok(dup[0]?.filePath.includes('.pi'), `应保留先到的（.pi/agent）：${dup[0]?.filePath}`);
    assert.ok(
      registry.diagnostics.some((d) => d.includes('dup')),
      `重名要给诊断：${registry.diagnostics.join('; ')}`,
    );
  });
});

test('skill 从家目录与工作目录两处都能加载，且标出层级', async () => {
  await withSkills(async (home, cwd) => {
    await writeSkill(userSkillsDir(home), 'user-skill', '用户级');
    await writeSkill(path.join(cwd, '.pi', 'skills'), 'project-skill', '项目级');
    const registry = loadSkillRegistry({ cwd });
    const byName = new Map(registry.skills.map((s) => [s.name, s]));
    assert.deepEqual(
      [...byName.keys()].sort(),
      ['project-skill', 'user-skill'],
      '两层都要在',
    );
    assert.equal(byName.get('user-skill')?.scope, 'user');
    assert.equal(byName.get('project-skill')?.scope, 'project');
    assert.equal(registry.diagnostics.length, 0, registry.diagnostics.join('; '));
  });
});

test('skill 与配置读同一个家目录（configHome 就是 pi 的 getAgentDir）', async () => {
  // 这条是回归：早先本项目另有 REDUX_AGENT_DIR 且优先级高于 pi 的那个，而 pi 的
  // getAgentDir() 不认它 —— 于是设了临时家目录也拦不住 skill 从真实家目录加载。
  await withSkills(async (home, cwd) => {
    await writeSkill(userSkillsDir(home), 'isolated-skill', '只在临时家目录里');
    const registry = loadSkillRegistry({ cwd });
    assert.deepEqual(
      registry.skills.map((s) => s.name),
      ['isolated-skill'],
      '不该看到临时家目录以外的 skill',
    );
    assert.ok(
      registry.skills[0]?.filePath.startsWith(home),
      `路径应在临时家目录下，实际 ${registry.skills[0]?.filePath}`,
    );
  });
});

test('没有 skill 时是空清单（不是报错）', async () => {
  await withSkills(async (_home, cwd) => {
    const registry = loadSkillRegistry({ cwd });
    assert.deepEqual(registry.skills, []);
    assert.equal(skillsPrompt(registry.skills), '', '空清单不该往 prompt 里塞任何东西');
  });
});

test('prompt 末尾接上清单，且是 Agent Skills 标准的 XML 形状', async () => {
  await withSkills(async (home, cwd) => {
    await writeSkill(userSkillsDir(home), 'demo', '正文');
    const registry = loadSkillRegistry({ cwd });
    const block = skillsPrompt(registry.skills);
    assert.ok(block.includes('<available_skills>'), block);
    assert.ok(block.includes('<name>demo</name>'), block);
    // 位置与工具名：模型要靠 description 判断该不该 read 那个文件。
    assert.ok(block.includes('demo 的说明'), `清单要带 description：${block}`);
    // 正文件**不进 prompt**（省 token 的全部意义就在这里）。
    assert.ok(!block.includes('正文'), '正文不该出现在清单里');
  });
});

test('disable-model-invocation 的 skill 不进 prompt（但仍可显式调用）', async () => {
  await withSkills(async (home, cwd) => {
    const dir = path.join(userSkillsDir(home), 'hidden');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'SKILL.md'),
      '---\nname: hidden\ndescription: 不给模型自动用\ndisable-model-invocation: true\n---\n\n正文\n',
      'utf8',
    );
    const registry = loadSkillRegistry({ cwd });
    assert.equal(registry.skills.length, 1, '还是加载了');
    assert.equal(skillsPrompt(registry.skills), '', '但不该出现在 prompt 里');
    // 显式调用要能列出来（pi 也是这么做的）。
    assert.deepEqual(
      skillCommands(registry.skills).map((c) => c.name),
      ['skill:hidden'],
    );
  });
});

test('/skill:x 展开成 pi 的 XML 形状（官方 parseSkillBlock 能还原）', async () => {
  await withSkills(async (home, cwd) => {
    await writeSkill(userSkillsDir(home), 'demo', '第一步做什么');
    const registry = loadSkillRegistry({ cwd });
    const expanded = expandSkillCommand('/skill:demo', registry.skills);
    const { parseSkillBlock } = await import('@earendil-works/pi-coding-agent');
    const block = parseSkillBlock(expanded);
    assert.ok(block, `官方 parseSkillBlock 要能认：${expanded}`);
    assert.equal(block.name, 'demo');
    assert.ok(block.content.includes('第一步做什么'), block.content);
    // frontmatter 不能发给模型（name/description 已经在清单里了）。
    assert.ok(!block.content.includes('description'), `不该带 frontmatter：${block.content}`);
    // 相对路径按 skill 目录解析 —— 这行是给模型的指令，官方形状里有它。
    assert.ok(block.content.includes('References are relative to'), block.content);
  });
});

test('/skill:x 带参数时，参数跟在块后面', async () => {
  await withSkills(async (home, cwd) => {
    await writeSkill(userSkillsDir(home), 'demo', '正文');
    const registry = loadSkillRegistry({ cwd });
    const expanded = expandSkillCommand('/skill:demo 帮我评审这段', registry.skills);
    assert.ok(expanded.endsWith('帮我评审这段'), expanded);
    // 参数不该被吸进 skill 块里。
    const { parseSkillBlock } = await import('@earendil-works/pi-coding-agent');
    assert.ok(!parseSkillBlock(expanded)?.content.includes('帮我评审这段'));
  });
});

test('未知 skill 原样返回（不静默吞掉命令）', async () => {
  await withSkills(async (_home, cwd) => {
    const registry = loadSkillRegistry({ cwd });
    assert.equal(expandSkillCommand('/skill:根本没有', registry.skills), '/skill:根本没有');
    // 非 skill 命令也原样返回。
    assert.equal(expandSkillCommand('/sessions', registry.skills), '/sessions');
    assert.equal(expandSkillCommand('普通问题', registry.skills), '普通问题');
  });
});

test('skill 文件读不到时把原因留在原地（用户要看得见失败）', () => {
  const broken: SkillInfo[] = [
    {
      name: 'broken',
      description: 'x',
      // 指向不存在的路径
      filePath: path.join(tmpdir(), 'no-such-skill-xyz', 'SKILL.md'),
      baseDir: path.join(tmpdir(), 'no-such-skill-xyz'),
      disableModelInvocation: false,
      scope: 'path',
    },
  ];
  const out = expandSkillCommand('/skill:broken', broken);
  assert.ok(out.startsWith('/skill:broken'), `原命令要留着：${out}`);
  assert.ok(out.includes('读取失败'), `要说清失败原因：${out}`);
});

/** 一个够 reducer 用的初始状态（init 段只认这些字段）。 */
function seedState(systemPrompt: string): AgentState {
  return createInitialState({ systemPrompt, providerName: 'p', modelId: 'm', toolNames: [] });
}

/** reducer 的返回值可能是 `AgentState | Loop<AgentState>`（有 effect 时），这里收窄。 */
function reduce(reducer: ReturnType<typeof createAgentReducer>, state: AgentState, action: AgentAction): AgentState {
  return reducer(state, action) as AgentState;
}

test('prompt.init 把清单拼进 systemPrompt，并落进 state', () => {
  const reducer = createAgentReducer({});
  const skills: SkillInfo[] = [
    {
      name: 'demo',
      description: 'demo 的说明',
      filePath: '/x/SKILL.md',
      baseDir: '/x',
      disableModelInvocation: false,
      scope: 'user',
    },
  ];
  const tools: PromptToolDefinition[] = [];
  const state = reduce(reducer, seedState('基础提示'), {
    type: 'prompt.init', systemPrompt: '基础提示', tools, skills,
  } as AgentAction);
  assert.ok(state.systemPrompt.startsWith('基础提示'), '基础提示要保留');
  assert.ok(state.systemPrompt.includes('<available_skills>'), '清单要接在后面');
  assert.deepEqual(state.prompt.skills, skills, '清单要落进 state（界面要念它）');
});

test('prompt.init 不带 skills 时原样保留 prompt（旧轨迹回放路径）', () => {
  const reducer = createAgentReducer({});
  const state = reduce(reducer, seedState('基础提示'), {
    type: 'prompt.init', systemPrompt: '基础提示', tools: [],
  } as AgentAction);
  assert.equal(state.systemPrompt, '基础提示');
  assert.equal(state.prompt.skills, undefined, '没装就该是 undefined（区别于「装了但为空」）');
});

test('skill 清单在轨迹树上可见（有 skill 才有节点）', () => {
  const reducer = createAgentReducer({});
  const withSkillsState = reduce(reducer, seedState('x'), {
      type: 'prompt.init',
      systemPrompt: 'x',
      tools: [],
      skills: [
        {
          name: 'demo',
          description: 'd',
          filePath: '/x/SKILL.md',
          baseDir: '/x',
          disableModelInvocation: false,
          scope: 'user',
        },
      ],
  } as AgentAction);
  assert.ok(
    withSkillsState.trace.order.some((id) => withSkillsState.trace.nodes[id]?.kind === 'prompt.skills'),
    '树上要有 prompt.skills 节点',
  );
  const without = reduce(reducer, seedState('x'), {
    type: 'prompt.init', systemPrompt: 'x', tools: [],
  } as AgentAction);
  assert.ok(
    !without.trace.order.some((id) => without.trace.nodes[id]?.kind === 'prompt.skills'),
    '零 skill 不该建空节点',
  );
});

test('skill 块在界面上画成可折叠块（不是蓝底用户消息）', async () => {
  await withSkills(async (home, cwd) => {
    await writeSkill(userSkillsDir(home), 'demo', '评审要点在这里');
    const registry = loadSkillRegistry({ cwd });
    const expandedText = expandSkillCommand('/skill:demo', registry.skills);
    const state = {
      messages: [{ role: 'user', content: expandedText } as Message],
      toolTimings: {},
    } as unknown as AgentState;

    const collapsed = renderTranscript(state, 0, 70, false);
    assert.ok(collapsed.includes('demo'), `折叠态要能看到 skill 名：${collapsed}`);
    assert.ok(
      !collapsed.includes('评审要点在这里'),
      `折叠态不该露出正文：${collapsed}`,
    );
    // 不该是用户蓝底（蓝底 = 用户说的话，而这是参考资料）。
    const userBlock = renderTranscript(
      { messages: [{ role: 'user', content: '普通问题' } as Message], toolTimings: {} } as unknown as AgentState,
      0,
      70,
      false,
    );
    assert.ok(
      !collapsed.includes('48;2;33;59;73') || userBlock.includes('48;2;33;59;73'),
      'skill 块不该用用户蓝底',
    );
    // 展开后（Ctrl+O）能看到正文。
    const opened = renderTranscript(state, 0, 70, true);
    assert.ok(opened.includes('评审要点在这里'), `展开后要有正文：${opened}`);
  });
});