/**
 * 扩展的两件「接缝」：**本地扩展目录的发现** 与 **agent 生命周期事件**。
 *
 * 这两件事都是给 pi 生态里的「状态类扩展」用的 —— 最具体的例子是 Orca 给 pi 装的
 * 托管扩展（`~/.pi/agent/extensions/orca-*.ts`）：它们靠 `pi.on('agent_start' | …)`
 * 把状态 POST 回 Orca。只读 `settings.json` 的 `packages` 装不到它们，只发
 * `session_start` 也不足以让 Orca 知道「在干活 / 干完了」。
 *
 * 所以这里用**探针扩展**（一个真文件，走 `loadExtensions`）验三件事：
 *
 * 1. 发现顺序与 pi 一致：项目本地 → 全局 → `packages`；
 * 2. `ExtensionHost.emitLifecycle()` 真的把事件送到扩展的 handler 上；
 * 3. 环自己会发这些事件（相位级的 `agent_start` / `agent_end` / `agent_settled`，
 *    以及 effect 侧的 `message_end` / `tool_execution_start` / `tool_execution_end`）。
 *
 * ## 为什么用真文件而不是内联工厂
 *
 * 验的是「发现」这条路径本身 —— 内联工厂绕过了它。文件也不复杂：一个默认导出、
 * 往 `globalThis` 里记事件名。与 `extension-host.test.ts` 的取舍一致（用真扩展，
 * 因为 jiti 的虚拟模块只有走 `loadExtensions` 才有）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentStoreWith, waitForIdle } from '../src/store';
import { createFauxRuntime } from '../src/provider';
import { loadExtensionHost } from '../src/extension-host';
import { createKernel } from '../src/kernel';
import type { ExtensionLifecycleEvent } from '../src/extension-events';

/** 探针扩展源码：把收到的事件名（与 `toolName`）推进 `globalThis.__probeEvents`。 */
const PROBE_SOURCE = `
export default function (pi) {
  const g = globalThis;
  g.__probeEvents = g.__probeEvents ?? [];
  const record = (event) => {
    g.__probeEvents.push(event.type + (event.toolName ? ':' + event.toolName : ''));
  };
  // session_start 额外记一件 Orca 命门的事：那一刻 ctx.sessionManager.getSessionFile()
  // 能不能报出一个路径（它只在这一刻被读一次，之后不再刷新）。
  pi.on('session_start', (_event, ctx) => {
    const file = ctx?.sessionManager?.getSessionFile?.();
    g.__probeEvents.push('session_start:' + (typeof file === 'string' && file.length > 0 ? 'file' : 'nofile'));
  });
  for (const name of [
    'agent_start',
    'agent_end',
    'agent_settled',
    'message_end',
    'tool_execution_start',
    'tool_execution_end',
    'model_select',
  ]) {
    pi.on(name, (event) => record(event));
  }
}
`;

function probeEvents(): string[] {
  return ((globalThis as { __probeEvents?: string[] }).__probeEvents ??= []);
}

/** 在临时家目录里落一个探针扩展，并把它设为 `PI_CODING_AGENT_DIR`。 */
function withProbeHome(run: (agentDir: string, reset: () => void) => Promise<void>): Promise<void> {
  const agentDir = mkdtempSync(path.join(tmpdir(), 'ext-lifecycle-home-'));
  const extensions = path.join(agentDir, 'extensions');
  mkdirSync(extensions, { recursive: true });
  writeFileSync(path.join(extensions, 'probe.ts'), PROBE_SOURCE);
  const saved = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  const reset = (): void => {
    (globalThis as { __probeEvents?: string[] }).__probeEvents = [];
  };
  reset();
  return run(agentDir, reset).finally(() => {
    if (saved !== undefined) process.env['PI_CODING_AGENT_DIR'] = saved;
    else delete process.env['PI_CODING_AGENT_DIR'];
    // 扩展的 jiti 缓存按 cwd 分桶；临时目录删掉不影响下一次（用的是新目录）。
    rmSync(agentDir, { recursive: true, force: true });
  });
}

test('扩展发现：项目本地 → 全局 → settings packages（与 pi 同序）', async () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), 'ext-order-home-'));
  const projectDir = mkdtempSync(path.join(tmpdir(), 'ext-order-project-'));
  const saved = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  try {
    // 全局：一个直接文件 + 一个子目录（`index.ts`）+ 一个包（settings 里点名）。
    mkdirSync(path.join(agentDir, 'extensions', 'subdir'), { recursive: true });
    writeFileSync(path.join(agentDir, 'extensions', 'global.ts'), 'export default function () {}\n');
    writeFileSync(path.join(agentDir, 'extensions', 'subdir', 'index.ts'), 'export default function () {}\n');
    writeFileSync(path.join(agentDir, 'pkg.ts'), 'export default function () {}\n');
    writeFileSync(
      path.join(agentDir, 'settings.json'),
      JSON.stringify({ packages: [path.join(agentDir, 'pkg.ts')] }),
    );
    // 项目本地。
    mkdirSync(path.join(projectDir, '.pi', 'extensions'), { recursive: true });
    writeFileSync(path.join(projectDir, '.pi', 'extensions', 'project.ts'), 'export default function () {}\n');

    const faux = createFauxRuntime();
    const { store } = createAgentStoreWith({ runtime: faux.runtime, cwd: projectDir });
    const host = await loadExtensionHost({ builtins: false, store, cwd: projectDir });
    assert.deepEqual([...host.errors], [], '四个入口都该装成功');

    const basenames = host.entries.map((entry) => path.basename(entry.path));
    // 顺序是语义（同名工具先到先得），但**同一个目录内部**的先后是 `readdirSync` 的顺序
    // （pi 也不排序，见 `discoverExtensionsInDir` 的注释）。所以这里钉两边：项目本地第一、
    // packages 最后，中间两个是全局目录里发现的那两个（内部顺序不钉）。
    assert.equal(basenames[0], 'project.ts', '项目本地在最前');
    assert.equal(basenames.at(-1), 'pkg.ts', 'settings packages 在最后');
    assert.deepEqual(
      new Set(basenames.slice(1, -1)),
      new Set(['global.ts', 'index.ts']),
      '中间那几个是全局 <agentDir>/extensions/ 里发现的',
    );
  } finally {
    if (saved !== undefined) process.env['PI_CODING_AGENT_DIR'] = saved;
    else delete process.env['PI_CODING_AGENT_DIR'];
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('emitLifecycle：内核发的事件真的到扩展的 handler 上', async () => {
  await withProbeHome(async () => {
    const faux = createFauxRuntime();
    const { store } = createAgentStoreWith({ runtime: faux.runtime, cwd: process.cwd() });
    const host = await loadExtensionHost({ builtins: false, store, cwd: process.cwd() });
    assert.deepEqual([...host.errors], [], '探针扩展该装成功');

    const events: ExtensionLifecycleEvent[] = [
      { type: 'agent_start' },
      { type: 'message_end', message: { role: 'assistant', content: [], timestamp: 0 } as never },
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: {} },
      { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', isError: false },
      { type: 'agent_end', messages: [] },
      { type: 'agent_settled' },
      {
        type: 'model_select',
        model: { provider: 'faux', id: 'fake' },
        previousModel: { provider: 'faux', id: 'other' },
        source: 'set',
      },
    ];
    for (const event of events) host.emitLifecycle(event);
    // `runner.emit` 是 async（handler 可能 await），但 handler 的同步部分在调用那一刻就跑完了。
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(
      probeEvents(),
      [
        'agent_start',
        'message_end',
        'tool_execution_start:bash',
        'tool_execution_end:bash',
        'agent_end',
        'agent_settled',
        'model_select',
      ],
      '事件的顺序与调用顺序一致（handler 是同步记的）',
    );
    host.dispose();
  });
});

test('环自己会发：session_start / agent_start / message_end / tool_execution_* / agent_end / agent_settled', async () => {
  await withProbeHome(async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'ext-lifecycle-cwd-'));
    try {
      const kernel = await createKernel({
        provider: 'faux',
        demo: true,
        cwd,
        traceDir: null,
      });
      try {
        // 装载那一刻就发了 `session_start`（MCP 与状态扩展都靠它），且那一刻已经能报出
        // 会话文件路径 —— 状态类扩展只在这一刻读一次 `getSessionFile()`（Orca 命门）。
        assert.ok(
          probeEvents().includes('session_start:file'),
          `装载后应先有 session_start 且能报出会话文件，实际：${probeEvents().join(',')}`,
        );
        kernel.store.dispatch({ type: 'user.message', text: '算一下' });
        await waitForIdle(kernel.store);
        // 等一拍，让 effect 里 fire-and-forget 的那些 emitLifecycle 都落到 handler。
        await new Promise((resolve) => setTimeout(resolve, 10));

        const seen = probeEvents();
        // demo 脚本：先调 bash 工具、再复述 → 两条助手消息 + 一次工具执行。
        for (const expected of [
          'agent_start',
          'message_end',
          'tool_execution_start:bash',
          'tool_execution_end:bash',
          'agent_end',
          'agent_settled',
        ]) {
          assert.ok(seen.includes(expected), `缺事件 ${expected}，实际：${seen.join(',')}`);
        }
        // 顺序钉住这一次：agent_start 在最前，agent_end/agent_settled 在最后。
        assert.equal(seen[0], 'session_start:file');
        assert.equal(seen[1], 'agent_start');
        assert.deepEqual(seen.slice(-2), ['agent_end', 'agent_settled']);

        // 生命周期事件**也记进了轨迹**：它们是 action（`extension.lifecycle`），
        // reducer 落成 kind 为 `extension.event` 的注释节点（不推进 tip）。
        //
        // 但**只有没专属节点的相位级三条**才落 —— `message_end` 已在 `llm.result` 上，
        // `tool_execution_*` 已在 `tool.call` / `tool.result` 上，不重复记。
        const trace = kernel.store.getState().trace;
        const allKinds = trace.order.map((id) => trace.nodes[id]?.kind);
        const labels = trace.order
          .filter((id) => trace.nodes[id]?.kind === 'extension.event')
          .map((id) => trace.nodes[id]?.label);
        assert.deepEqual(labels, ['agent_start', 'agent_end', 'agent_settled']);
        // 工具与助手消息的「记录」在那两条专属节点上，而不是 `extension.event`。
        assert.ok(allKinds.includes('tool.call') && allKinds.includes('tool.result'));
        assert.ok(allKinds.filter((k) => k === 'llm.result').length >= 2, '两条助手消息各一个 llm.result');
        // 注释节点不推进 tip：tip 仍然是最后那条真正发生的事（turn.end）。
        assert.equal(trace.nodes[trace.tipId ?? '']?.kind, 'turn.end');
      } finally {
        kernel.dispose();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test('extension.lifecycle：只有没专属节点的事件才落注释节点，且不推进 tip', () => {
  const faux = createFauxRuntime();
  const { store } = createAgentStoreWith({ runtime: faux.runtime, cwd: process.cwd() });
  const traceKinds = (): string[] => {
    const tree = store.getState().trace;
    return tree.order.map((id) => tree.nodes[id]?.kind ?? '');
  };
  assert.equal(store.getState().trace.tipId, null, '空树没有 tip');

  // 相位级：没有别的节点记它们 → 落 `extension.event`。
  store.dispatch({ type: 'extension.lifecycle', event: { type: 'agent_start' } });
  // 工具 / 消息 / 模型：已经有 `tool.call` / `tool.result` / `llm.result` / `model.changed`
  // 这些信息更全的专属节点 → 不再重复记。
  store.dispatch({
    type: 'extension.lifecycle',
    event: { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', isError: true },
  });
  store.dispatch({
    type: 'extension.lifecycle',
    event: { type: 'model_select', model: { provider: 'a', id: 'b' }, previousModel: { provider: 'a', id: 'c' }, source: 'set' },
  });

  assert.deepEqual(traceKinds(), ['extension.event'], '只有 agent_start 落节点');
  // 注释节点**不推进 tip**（它是「内核告诉了扩展什么」，不是「发生过的一件事」）。
  assert.equal(store.getState().trace.tipId, null, '注释不该推进 tip');
});
