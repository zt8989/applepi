/**
 * `/reload`（`Kernel.reload()`）—— 与 pi 的 `AgentSession.reload()` 同一个语义：
 * 收掉旧扩展激活（`session_shutdown{reason:'reload'}`）→ 重装新实例 → `session_start{reason:'reload'}`，
 * 再重读 settings / skill / prompt 模板 / 上下文文件，把结果装回 state。
 *
 * 这组测试钉四件事：
 * 1. **同一个会话上也真的重装**（不是只重发事件）—— 旧实例收到 shutdown、新实例接手；
 * 2. 磁盘上新增的 skill / prompt 模板 / AGENTS.md 在 reload 后**进 prompt**（不重启）；
 * 3. 环在跑时拒绝（`ok:false`），不把正在等的流交给已 shutdown 的宿主；
 * 4. 会话已经开树之后再 reload，`prompt.init` 走**热重载**那条路（追加新的 prompt 节点，不改写旧节点）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createKernel } from '../src/kernel';
import { waitForIdle } from '../src/store';

/** 探针：每次扩展实例一个自增代号；记下 session_start / session_shutdown。 */
const PROBE_SOURCE = `
export default function (pi) {
  const g = globalThis;
  g.__reloadEvents = g.__reloadEvents ?? [];
  g.__reloadInstances = (g.__reloadInstances ?? 0) + 1;
  const instance = g.__reloadInstances;
  pi.on('session_start', (event) => {
    g.__reloadEvents.push('start:' + event.reason + ':' + instance);
  });
  pi.on('session_shutdown', (event) => {
    g.__reloadEvents.push('shutdown:' + event.reason + ':' + instance);
  });
}
`;

type ProbeGlobal = {
  __reloadEvents?: string[];
  __reloadInstances?: number;
};

function writeSkill(cwd: string, name: string, description: string): void {
  const dir = path.join(cwd, '.pi/skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n${name} 正文\n`,
  );
}

function writePrompt(cwd: string, name: string, description: string): void {
  const dir = path.join(cwd, '.pi/prompts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.md`), `---\ndescription: ${description}\n---\n${name} $1\n`);
}

/** 起一个真内核；跑完清理临时家目录 / cwd。 */
async function withKernel(
  run: (
    kernel: Awaited<ReturnType<typeof createKernel>>,
    paths: { cwd: string },
  ) => Promise<void>,
): Promise<void> {
  const agentDir = mkdtempSync(path.join(tmpdir(), 'reload-home-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'reload-cwd-'));
  mkdirSync(path.join(agentDir, 'extensions'), { recursive: true });
  writeFileSync(path.join(agentDir, 'extensions', 'probe.ts'), PROBE_SOURCE);
  const saved = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  delete (globalThis as ProbeGlobal).__reloadEvents;
  delete (globalThis as ProbeGlobal).__reloadInstances;
  try {
    const kernel = await createKernel({ provider: 'faux', demo: true, cwd, traceDir: null });
    try {
      await run(kernel, { cwd });
    } finally {
      await kernel.dispose();
    }
  } finally {
    if (saved !== undefined) process.env['PI_CODING_AGENT_DIR'] = saved;
    else delete process.env['PI_CODING_AGENT_DIR'];
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

function events(): string[] {
  return (globalThis as ProbeGlobal).__reloadEvents ?? [];
}

test('/reload：旧实例 session_shutdown{reload} → 新实例 session_start{reload}', async () => {
  await withKernel(async (kernel) => {
    assert.deepEqual(events(), ['start:startup:1'], '装载时一发');

    const report = await kernel.reload();
    assert.equal(report.ok, true);
    assert.deepEqual(report.diagnostics, [], '重载本身不该留诊断');
    assert.deepEqual(
      events(),
      ['start:startup:1', 'shutdown:reload:1', 'start:reload:2'],
      '即使会话没变也要换新实例（只重发事件就是 pi-background-tasks 报 activation_conflict 的那条路）',
    );

    // 再 reload 一次：继续换实例（不是复用第二个）。
    await kernel.reload();
    assert.deepEqual(events(), [
      'start:startup:1',
      'shutdown:reload:1',
      'start:reload:2',
      'shutdown:reload:2',
      'start:reload:3',
    ]);
  });
});

test('/reload：磁盘上新增的 skill / prompt 模板 / AGENTS.md 立刻进 prompt', async () => {
  await withKernel(async (kernel, { cwd }) => {
    // 起手：只有 alpha skill、hello 模板、第一版 AGENTS.md。
    writeSkill(cwd, 'alpha', '第一版 skill');
    writePrompt(cwd, 'hello', '打招呼');
    writeFileSync(path.join(cwd, 'AGENTS.md'), '第一版项目约定\n');

    await kernel.reload();
    const initial = kernel.store.getState();
    assert.deepEqual(
      initial.prompt.skills?.map((skill) => skill.name),
      ['alpha'],
      'reload 会把刚写下的 alpha 读进来',
    );
    assert.ok(initial.prompt.systemPrompt.includes('第一版项目约定'));

    // 会话中途改磁盘（用户在另一个编辑器里编辑）—— 不重启也能生效。
    writeSkill(cwd, 'beta', '新增 skill');
    writePrompt(cwd, 'bye', '再见');
    writeFileSync(path.join(cwd, 'AGENTS.md'), '第二版项目约定\n');

    const report = await kernel.reload();
    assert.equal(report.ok, true);
    const state = kernel.store.getState();
    assert.deepEqual(
      state.prompt.skills?.map((skill) => skill.name).sort(),
      ['alpha', 'beta'],
    );
    assert.deepEqual(
      state.prompt.promptTemplates?.map((prompt) => prompt.name).sort(),
      ['bye', 'hello'],
    );
    assert.ok(state.prompt.systemPrompt.includes('第二版项目约定'), 'AGENTS.md 重读了');
    assert.ok(!state.prompt.systemPrompt.includes('第一版项目约定'), '旧上下文不该留在 prompt 里');
    assert.ok((state.prompt.tools?.length ?? 0) > 0, '工具声明还在（重载不该把工具表清空）');
  });
});

test('/reload：环在跑的时候拒绝（不把正在等的流交给已 shutdown 的宿主）', async () => {
  await withKernel(async (kernel) => {
    kernel.store.dispatch({ type: 'user.message', text: '跑一轮' });
    // 刚 dispatch 完相位已经不是 idle（reducer 立刻换相位，LLM 是异步的）。
    const report = await kernel.reload();
    assert.equal(report.ok, false);
    assert.match(report.message ?? '', /还没结束/);
    assert.deepEqual(events(), ['start:startup:1'], '拒绝时一点都没动扩展激活');
    await waitForIdle(kernel.store, 20_000);
  });
});

test('/reload：已经开树之后走 prompt.init 的热重载路径（追加节点，不改写旧的）', async () => {
  await withKernel(async (kernel, { cwd }) => {
    writeFileSync(path.join(cwd, 'AGENTS.md'), '第一版项目约定\n');
    kernel.store.dispatch({ type: 'user.message', text: '第一句' });
    await waitForIdle(kernel.store, 20_000);

    const promptNodesBefore = kernel.store
      .getState()
      .trace.order.filter((id) => kernel.store.getState().trace.nodes[id]?.kind === 'prompt.base')
      .length;
    assert.equal(promptNodesBefore, 1, '第一条消息补了装载节点');

    writeFileSync(path.join(cwd, 'AGENTS.md'), '第二版项目约定\n');
    await kernel.reload();

    const after = kernel.store.getState();
    const promptNodesAfter = after.trace.order.filter(
      (id) => after.trace.nodes[id]?.kind === 'prompt.base',
    ).length;
    assert.equal(promptNodesAfter, 2, '热重载追加一条新的 prompt 节点（旧节点是历史，不改写）');
    assert.ok(after.prompt.systemPrompt.includes('第二版项目约定'));
    // 对话消息没被动过（prompt 变更只改「下一轮发什么」，不重写历史）。
    assert.equal(after.messages.filter((message) => message.role === 'user').length, 1);
  });
});
