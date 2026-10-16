import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPromptOptions, buildSystemPromptText, promptFileSources, promptToolsFrom } from '../src/system-prompt';
import { defaultSystemPrompt } from '../src/kernel';

/**
 * System prompt —— 拼装**全部交给 pi 的 `buildSystemPrompt`**。
 *
 * ## 这组测试守的是什么
 *
 * 早先这里手写三行中文（"你是编码助手 / 用工具查 / 简短直给"）。那不是"风格不同"，
 * 是**信息缺失**：模型不知道 `edit` 的 `oldText` 必须精确匹配、不知道多处改动该用一次
 * 调用、也不知道这个项目的 `AGENTS.md` 写了什么 —— 而那些都是踩坑换来的经验。
 *
 * 所以测试要盯住的不是「文案长什么样」，而是**几段该在**：
 *   - 工具的 `promptSnippet` / `promptGuidelines`（来自官方工具定义）；
 *   - `AGENTS.md`（用户级 + 项目级）；
 *   - `cwd`；
 *   - skill 清单；
 *   - 我们自己加的那条规则（用用户的语言回答）。
 *
 * 文案本身**故意不断言** —— 那是 pi 的事，它改了文案不算我们坏。
 */

async function withCwd<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'prompt-'));
  return fn(cwd);
}

test('工具的 promptSnippet 进 <tools> 段（官方工具定义上的那两个字段）', async () => {
  await withCwd(async (cwd) => {
    const prompt = buildSystemPromptText({ cwd, tools: promptToolsFrom(cwd) });
    assert.match(prompt, /<tools>/);
    // 这几条是官方写在工具定义里的，改了就说明我们没读对字段。
    assert.match(prompt, /- read: Read file contents/);
    assert.match(prompt, /- write: Create or overwrite files/);
    assert.match(prompt, /- bash: Execute bash commands/);
    assert.match(prompt, /- edit: Make precise file edits with exact text replacement/);
  });
});

test('工具的 promptGuidelines 进 <rules> 段（edit 的坑全在里面）', async () => {
  await withCwd(async (cwd) => {
    const prompt = buildSystemPromptText({ cwd, tools: promptToolsFrom(cwd) });
    assert.match(prompt, /<rules>/);
    // 这几条是官方**踩过坑**才写下来的：模型不知道就会把 oldText 写成一整段、
    // 或者对同一个文件连发多次 edit。手写 prompt 等于把这些经验全扔掉。
    assert.match(prompt, /oldText must match exactly/);
    assert.match(prompt, /one edit call with multiple entries/);
    assert.match(prompt, /Use read to examine files instead of cat or sed/);
  });
});

test('AGENTS.md 进 <project_context>（项目级那份）', async () => {
  await withCwd(async (cwd) => {
    await writeFile(
      path.join(cwd, 'AGENTS.md'),
      '# 本项目约定\n\n- 提交前必须跑测试\n',
      'utf8',
    );
    const prompt = buildSystemPromptText({ cwd, tools: promptToolsFrom(cwd) });
    assert.match(prompt, /<project_context>/);
    assert.match(prompt, /提交前必须跑测试/, '项目自己的约定要进 prompt');
  });
});

test('cwd 段无条件有（模型要知道自己站在哪）', async () => {
  await withCwd(async (cwd) => {
    const prompt = buildSystemPromptText({ cwd, tools: promptToolsFrom(cwd) });
    assert.match(prompt, /<cwd>/);
    assert.ok(prompt.includes(cwd.replace(/\\/g, '/')), 'cwd 的路径要在里面');
  });
});

test('没有 SYSTEM.md / APPEND_SYSTEM.md 时，代码里**一条规则都不加**', async () => {
  await withCwd(async (cwd) => {
    const prompt = buildSystemPromptText({ cwd, tools: promptToolsFrom(cwd) });
    // 早先这里硬塞过一条 "Always respond in the user's language."。现在它属于
    // `APPEND_SYSTEM.md` 的内容 —— **文件里没有就不该有**。
    assert.ok(
      !prompt.includes("Always respond in the user's language"),
      '规则不该住在代码里（用户要能自己改，就得放在文件里）',
    );
    assert.ok(
      !prompt.includes('<addendum>'),
      '没写 APPEND_SYSTEM.md 就不该有空段',
    );
  });
});

test('skill 清单进 <skills> 段（由 pi 拼，不是我们自己接在尾巴上）', async () => {
  await withCwd(async (cwd) => {
    const prompt = buildSystemPromptText({
      cwd,
      tools: promptToolsFrom(cwd),
      skills: [
        {
          name: 'demo',
          description: 'demo 的说明',
          filePath: '/x/SKILL.md',
          baseDir: '/x',
          disableModelInvocation: false,
          scope: 'user',
        },
      ],
    });
    assert.match(prompt, /<skills>/);
    assert.match(prompt, /<available_skills>/);
    assert.match(prompt, /<name>demo<\/name>/);
  });
});

test('给了 customPrompt：顶掉默认前缀，tools/rules/docs 三段随之消失（官方语义）', async () => {
  await withCwd(async (cwd) => {
    const withCustom = buildSystemPromptText({
      cwd,
      tools: promptToolsFrom(cwd),
      customPrompt: '我是本项目的专用助手。',
    });
    assert.ok(withCustom.startsWith('我是本项目的专用助手。'));
    // 官方 `customPrompt` 的定义是 "replaces the default prefix" —— 而默认前缀
    // **包含** tools/rules/docs 三段。这不是我们丢的，是官方语义。
    assert.ok(!withCustom.includes('<rules>'), '默认前缀被顶掉了，rules 段随之没有');
    assert.ok(!withCustom.includes('<tools>'));
    // 但**无条件**的那几段还在：cwd、AGENTS.md。
    assert.match(withCustom, /<cwd>/);
  });
});

test('不给 customPrompt：走完整的默认前缀（tools + rules + docs）', async () => {
  await withCwd(async (cwd) => {
    const prompt = buildSystemPromptText({ cwd, tools: promptToolsFrom(cwd) });
    assert.match(prompt, /<tools>/);
    assert.match(prompt, /<rules>/);
    assert.match(prompt, /<docs>/);
  });
});

test('没有 snippet 的工具**不进 prompt**（官方语义：不告诉模型它存在）', () => {
  const cwd = process.cwd();
  const options = buildPromptOptions({
    cwd,
    tools: [
      { name: 'read', promptSnippet: 'Read file contents' },
      { name: 'mystery', promptGuidelines: ['一条规则'] }, // 没有 snippet
    ],
  });
  assert.deepEqual(options.selectedTools, ['read'], '没 snippet 的不进 selectedTools');
});

test('buildPromptOptions **不传** promptGuidelines（我们自己一条规则都不加）', () => {
  const options = buildPromptOptions({
    cwd: process.cwd(),
    tools: [{ name: 'read', promptSnippet: 's', promptGuidelines: ['官方规则'] }],
  });
  assert.equal(
    options.promptGuidelines,
    undefined,
    '规则该住在文件里（SYSTEM.md / APPEND_SYSTEM.md），代码里一条都不加（连空数组都不传）',
  );
  assert.deepEqual(options.toolGuidelines?.['read'], ['官方规则'], '官方工具自己的规则照旧');
});

test('SYSTEM.md：存在时顶掉 preamble（pi 的规范，优先于 --system）', async () => {
  await withCwd(async (cwd) => {
    const { mkdir, writeFile: write } = await import('node:fs/promises');
    await mkdir(path.join(cwd, '.pi'), { recursive: true });
    await write(path.join(cwd, '.pi', 'SYSTEM.md'), '我是这个项目的专用助手。', 'utf8');
    const prompt = buildSystemPromptText({
      cwd,
      tools: promptToolsFrom(cwd),
      customPrompt: '命令行给的那句',
    });
    assert.ok(
      prompt.startsWith('我是这个项目的专用助手。'),
      `文件优先于参数。实际开头：${prompt.slice(0, 120)}`,
    );
    assert.ok(!prompt.includes('命令行给的那句'), '参数被文件盖掉了');
    // 官方语义：顶掉的是**整个默认前缀**（tools/rules/docs）。
    assert.ok(!prompt.includes('<rules>'));
    assert.match(prompt, /<cwd>/);
  });
});

test('APPEND_SYSTEM.md：进 <addendum> 段（规则放这里，不用改代码）', async () => {
  await withCwd(async (cwd) => {
    const { mkdir, writeFile: write } = await import('node:fs/promises');
    await mkdir(path.join(cwd, '.pi'), { recursive: true });
    await write(
      path.join(cwd, '.pi', 'APPEND_SYSTEM.md'),
      "Always respond in the user's language.",
      'utf8',
    );
    const prompt = buildSystemPromptText({ cwd, tools: promptToolsFrom(cwd) });
    assert.match(prompt, /<addendum>/);
    assert.match(prompt, /Always respond in the user's language\./);
    // **默认前缀还在**（APPEND_SYSTEM 是追加，不是顶掉）。
    assert.match(prompt, /<rules>/, 'APPEND_SYSTEM 不该顶掉默认前缀');
    assert.match(prompt, /<tools>/);
  });
});

test('promptFileSources 报告规则是从哪读到的（界面要能告诉用户）', async () => {
  await withCwd(async (cwd) => {
    const { mkdir, writeFile: write } = await import('node:fs/promises');
    await mkdir(path.join(cwd, '.pi'), { recursive: true });
    await write(path.join(cwd, '.pi', 'APPEND_SYSTEM.md'), 'x', 'utf8');
    const sources = promptFileSources(cwd);
    assert.equal(sources.append?.path, path.join(cwd, '.pi', 'APPEND_SYSTEM.md'));
    assert.equal(sources.system, undefined, '没写 SYSTEM.md 就不该有');
  });
});

test('promptFileSources：两个都没有时是空（不是路径字符串）', async () => {
  await withCwd(async (cwd) => {
    const sources = promptFileSources(cwd);
    assert.equal(sources.system, undefined);
    assert.equal(sources.append, undefined);
  });
});

test('defaultSystemPrompt() 给的是 pi 拼的那一份（不再有手写中文）', async () => {
  const prompt = await defaultSystemPrompt(process.cwd());
  assert.match(prompt, /<rules>/, '默认走完整前缀');
  assert.match(prompt, /<tools>/);
  // 早先这里是「你是一个编码助手…」那三行。现在不该再出现。
  assert.ok(
    !prompt.includes('你是一个编码助手'),
    '手写的那句中文不该回来了',
  );
});