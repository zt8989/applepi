/**
 * MCP + codemode 的接入测试。
 *
 * ## 两层，分开测
 *
 * 1. **注册表层**（`tools.ts` 的 exposure）：`direct` / `codemode` / `deferred` / `hidden`
 *    各自进不进「声明给模型」、能不能从脚本调。这一层纯内存、无进程。
 * 2. **整条链路**：真的起一个 MCP stdio 服务器（`packages/core/test/fixtures/fake-mcp-server.mjs`，
 *    离线、进程内），走内核装载 → `session_start` → 服务器连上 → 工具注册 →
 *    codemode 脚本调用。用**真的** MCP 客户端与真的 codemode 沙箱，假的只有服务器那一端。
 *
 * 为什么不 mock 掉 MCP 客户端：这条链路的风险全在接缝上 —— 工具**动态注册**进来的时机
 * （`refreshTools` 重扫）、`executeTool` 的门（MCP 靠它等服务器）、`outputSchema` 让脚本
 * 拿到对象而不是字符串。mock 掉客户端这些一个都验不到。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../src/kernel';
import { configHome } from '../src/config-home';
import {
  activeToolNames,
  callableTools,
  declaredToolset,
  getCallableTool,
  registeredToolInfos,
  registerToolEntries,
  resetToolRegistryForTest,
  setActiveToolNames,
} from '../src/tools';
import type { AgentTool } from '../src/agent-tool';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

// 注册表是**模块级**的（`tools.ts`），激活集也在那里。
// 一个进程里只该有一个内核，但测试里会建好几个 —— 所以每个用例前清一次，
// 不然上一个内核激活过的状态会漏给下一个（真出现过：第二个用例的 codemode 不生效）。
test.beforeEach(() => resetToolRegistryForTest());

function fakeTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `${name} description`,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text', text: `${name} ok` }], details: null }),
  };
}

test('exposure：codemode / deferred 不进声明但能从脚本调，hidden 两处都不进', () => {
  resetToolRegistryForTest();
  registerToolEntries([
    { tool: fakeTool('plain'), exposure: 'direct' },
    { tool: fakeTool('script_only'), exposure: 'codemode' },
    { tool: fakeTool('lazy'), exposure: 'deferred' },
    { tool: fakeTool('gone'), exposure: 'hidden' },
  ]);
  const cwd = process.cwd();
  const declared = declaredToolset(cwd).tools.map((t) => t.name);
  assert.ok(declared.includes('plain'), 'direct 该声明给模型');
  assert.ok(!declared.includes('script_only'), 'codemode 工具不该出现在模型工具表里');
  assert.ok(!declared.includes('lazy'), 'deferred 工具不该出现在模型工具表里');
  assert.ok(!declared.includes('gone'), 'hidden 不该声明');

  const callable = callableTools(cwd).map((t) => t.name);
  assert.ok(callable.includes('plain'));
  assert.ok(callable.includes('script_only'), 'codemode 工具必须能从脚本调');
  assert.ok(callable.includes('lazy'), 'deferred 归入 codemode —— 也该能调');
  assert.ok(!callable.includes('gone'));
  assert.equal(getCallableTool('script_only', cwd)?.name, 'script_only');
  resetToolRegistryForTest();
});

test('exposure：`+codemode` 名字激活后它才进声明（defaultActive:false）', () => {
  resetToolRegistryForTest();
  registerToolEntries([{ tool: fakeTool('codemode'), exposure: 'model-only', defaultActive: false }]);
  const cwd = process.cwd();
  assert.ok(!activeToolNames(cwd).has('codemode'), '默认不激活');
  setActiveToolNames([...activeToolNames(cwd), 'codemode']);
  assert.ok(declaredToolset(cwd).tools.some((t) => t.name === 'codemode'), '激活后才声明');
  resetToolRegistryForTest();
});

test('exposure：会话中途 setActiveToolNames 也生效（loader 工具靠这条）', () => {
  // 早先这里钉的是「窗口关了就拒绝」——那条不变式换了：工具集中途可变，前提是
  // 变化会被**声明**出去（`agent.run` 的 diff，见 prompt-head.test.ts）。
  resetToolRegistryForTest();
  registerToolEntries([{ tool: fakeTool('x'), exposure: 'model-only', defaultActive: false }]);
  assert.ok(!declaredToolset(process.cwd()).tools.some((t) => t.name === 'x'), '默认不激活');
  setActiveToolNames(['x']);
  assert.ok(
    declaredToolset(process.cwd()).tools.some((t) => t.name === 'x'),
    '中途激活要立刻体现在声明里',
  );
  resetToolRegistryForTest();
});

test('装载：`+codemode` 让模型看到 codemode，描述里列着能调的工具', async (t) => {
  const home = configHome();
  const settingsPath = path.join(home, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ defaultTools: ['+codemode'] }));
  t.after(() => rmSync(settingsPath, { force: true }));
  const workdir = mkdtempSync(path.join(tmpdir(), 'ela-codemode-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const kernel = await createKernel({
    provider: 'faux',
    demo: true,
    cwd: workdir,
    traceDir: null,
  });
  t.after(() => kernel.dispose());

  const names = kernel.store.getState().prompt.tools.map((tool) => tool.name);
  assert.ok(names.includes('codemode'), `该声明 codemode，实际：${names.join(',')}`);
  // `mode: "on"`（默认）下，codemode 的描述**不重复列**已经声明的直调工具；
  // 而是给那些工具各自的描述**追加**一句「从脚本怎么调」（pi 的 `describeScriptCall`）。
  const bash = kernel.store.getState().prompt.tools.find((tool) => tool.name === 'bash');
  assert.match(
    bash?.description ?? '',
    /Codemode: `tools\.bash\(args\)`/,
    'codemode 激活时直调工具的描述该被加上脚本调用的说明',
  );
  const codemode = kernel.store.getState().prompt.tools.find((tool) => tool.name === 'codemode');
  assert.ok(codemode, 'codemode 该在声明里');
  // 没有 codemode / deferred 暴露的工具时，它的描述里没有 `Nested tools:` 一节（那是给
  // 那些工具的）—— 这里钉住这个形状，免得以后误以为「描述没被 prepareLoadout 改过」。
  assert.ok(!/Nested tools:/.test(codemode?.description ?? ''), '直调工具不该进 codemode 的 Nested tools');
});

test('exposure：`prepareLoadout` 的 hiddenDeclarations 真的从声明里去掉，但仍可调', () => {
  resetToolRegistryForTest();
  const hiddenHook = () => ({ hiddenDeclarations: ['other'] as readonly string[] });
  registerToolEntries([
    { tool: fakeTool('orchestrator'), exposure: 'model-only', prepareLoadout: hiddenHook },
    { tool: fakeTool('other'), exposure: 'direct' },
  ]);
  const cwd = process.cwd();
  const declared = declaredToolset(cwd);
  const declaredNames = declared.tools.map((t) => t.name);
  assert.ok(declaredNames.includes('orchestrator'));
  assert.ok(!declaredNames.includes('other'), '被隐藏声明的工具不该进声明');
  assert.ok(declared.hidden.has('other'));
  assert.ok(
    callableTools(cwd).some((t) => t.name === 'other'),
    '被隐藏声明的工具仍要能从脚本调（那是隐藏声明、不是禁用）',
  );
  resetToolRegistryForTest();
});

test('装载：`codemode.mode: "only"` 把直调工具从声明里藏掉、列进 codemode 描述', async (t) => {
  const home = configHome();
  const settingsPath = path.join(home, 'settings.json');
  writeFileSync(
    settingsPath,
    JSON.stringify({ defaultTools: ['+codemode'], codemode: { mode: 'only' } }),
  );
  t.after(() => rmSync(settingsPath, { force: true }));
  const workdir = mkdtempSync(path.join(tmpdir(), 'ela-codemode-only-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const kernel = await createKernel({ provider: 'faux', demo: true, cwd: workdir, traceDir: null });
  t.after(() => kernel.dispose());

  const tools = kernel.store.getState().prompt.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ['codemode'], 'only 模式下只声明 codemode');
  assert.match(tools[0]?.description ?? '', /Nested tools:/, 'hidden 的工具要列进 codemode 描述');
  assert.match(tools[0]?.description ?? '', /bash/, 'bash 该在脚本能调的清单里');
});

test('MCP：服务器工具按 codemode 暴露，脚本能调、模型看不到', async (t) => {
  const home = configHome();
  const mcpPath = path.join(home, 'mcp.json');
  writeFileSync(
    mcpPath,
    JSON.stringify({
      mcpServers: { fake: { command: process.execPath, args: [FIXTURE] } },
    }),
  );
  t.after(() => rmSync(mcpPath, { force: true }));
  const workdir = mkdtempSync(path.join(tmpdir(), 'ela-mcp-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const kernel = await createKernel({
    provider: 'faux',
    demo: true,
    cwd: workdir,
    traceDir: null,
  });
  t.after(() => kernel.dispose());

  const state = kernel.store.getState();
  // 1) 配置里有 codemode 暴露的服务器 → codemode 被自动激活（MCP 扩展做的）。
  assert.ok(
    state.prompt.tools.some((tool) => tool.name === 'codemode'),
    'MCP 的 codemode 暴露该把 codemode 激活',
  );
  // 2) MCP 工具**不**进模型的工具表（这就是 codemode 暴露的意义）。
  assert.ok(
    !state.prompt.tools.some((tool) => tool.name.startsWith('mcp__')),
    'MCP 工具不该出现在模型工具表里',
  );
  // 3) `mcp_servers` 段进了 system prompt（否则模型不知道有这个服务器）。
  assert.match(state.prompt.systemPrompt, /mcp_servers/, 'prompt 里该有 mcp_servers 段');
  assert.match(state.prompt.systemPrompt, /mcp__fake/, 'mcp_servers 段该列出服务器命名空间');

  // 4) 脚本调服务器工具。走**与环同一条**的路：先发 `tool_call` 门（MCP 在这里等服务器），
  //    再执行 codemode。服务器是后台连的，所以这一步同时验了「等待」。
  const code = "const r = await tools.mcp__fake__echo({ text: 'hi' }); return r;";
  const gate = await kernel.extensions.beforeToolCall('c1', 'codemode', { code });
  assert.equal(gate.block, undefined);
  const codemode = kernel.store.getState().prompt.tools.find((tool) => tool.name === 'codemode');
  assert.ok(codemode, 'codemode 必须在声明的工具里');

  const { getTool } = await import('../src/tools');
  const tool = getTool('codemode', workdir);
  assert.ok(tool, '注册表里该有 codemode');
  const result = await tool.execute('c1', { code }, undefined, undefined);
  const text = result.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
  assert.match(text, /Script completed/, `脚本该跑成功：${text}`);
  assert.match(text, /echo: hi/, `脚本该拿到服务器返回：${text}`);

  // 5) 工具确实注册进了注册表，且暴露方式是**不声明给模型**的。
  //
  // 注意这里是 `deferred` 而不是 `codemode`：pi 的 MCP 扩展会把配置里的 `codemode`
  // 经 `toToolExposure()` 映射成 `deferred` 注册（两者对模型都是「不声明」，
  // 差别只在 tool_search 能不能装载它）。本项目不装 tool_search，所以对我们就只有
  // 「脚本能调、模型看不见」这一件事；`mcp_servers` 段里写的仍是配置的 `codemode`。
  const info = registeredToolInfos(workdir).find((entry) => entry.name === 'mcp__fake__echo');
  assert.ok(info, 'MCP 工具该在注册表里');
  assert.equal(info?.exposure, 'deferred');
  assert.equal(info?.namespace?.name, 'mcp__fake');
});
test('装载：`+tool_search` 能把 deferred 工具搜出来，下一轮就声明给模型', async (t) => {
  // `tool_search` 是 pi 的内置扩展（本项目也装）：BM25 搜 `codemode` / `deferred` 暴露
  // 的工具，命中的走 `setActiveTools()` 装载。早先本项目不装它（「工具集装载时定死」），
  // 那条理由在工具集可变 + 声明链路之后不成立了 —— 这条测试钉住整条路真的通。
  const home = configHome();
  const settingsPath = path.join(home, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ defaultTools: ['+tool_search'] }));
  t.after(() => rmSync(settingsPath, { force: true }));
  const mcpPath = path.join(home, 'mcp.json');
  writeFileSync(
    mcpPath,
    JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [FIXTURE] } } }),
  );
  t.after(() => rmSync(mcpPath, { force: true }));
  const workdir = mkdtempSync(path.join(tmpdir(), 'ela-toolsearch-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const kernel = await createKernel({ provider: 'faux', demo: true, cwd: workdir, traceDir: null });
  t.after(() => kernel.dispose());

  const names = (): string[] => kernel.store.getState().prompt.tools.map((tool) => tool.name);
  assert.ok(names().includes('tool_search'), `该声明 tool_search，实际：${names().join(',')}`);
  assert.ok(
    !names().includes('mcp__fake__echo'),
    'MCP 工具（deferred）默认不进声明 —— 否则搜索工具就没意义了',
  );

  // 服务器是**后台**连的：先走一次 `tool_call` 门（与环同一个门）等它连上 ——
  // 门只看 codemode 脚本点了哪个服务器，所以这里给一段「点名它」的脚本。
  // 不等的话搜的是空表，症状是 `No matching tools found.`（看起来像搜索坏了）。
  await kernel.extensions.beforeToolCall('c0', 'codemode', {
    code: "const r = await tools.mcp__fake__echo({ text: 'warm' }); return r;",
  });
  const { registeredToolInfos } = await import('../src/tools');
  assert.ok(
    registeredToolInfos(workdir).some((entry) => entry.name === 'mcp__fake__echo'),
    '门走完之后服务器该连上、工具该进注册表',
  );

  const { getTool } = await import('../src/tools');
  const search = getTool('tool_search', workdir);
  assert.ok(search, '注册表里该有 tool_search');
  const result = await search.execute('s1', { query: 'echo' });
  const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  assert.match(text, /Loaded 1 tool/, `该搜到那个 MCP 工具：${text}`);

  assert.ok(names().includes('mcp__fake__echo'), '搜到之后它进当前声明');

  // 而「进声明」这件事要真的变成一条 `toolsAdded` —— 模型下一轮才知道它能直接调。
  kernel.store.dispatch({ type: 'agent.run' } as never);
  const added = kernel.store
    .getState()
    .messages.filter((message) => message.role === 'system')
    .flatMap((message) => (message.role === 'system' ? (message.toolsAdded ?? []) : []))
    .map((tool) => tool.name);
  assert.ok(added.includes('mcp__fake__echo'), `声明增量里该有它：${added.join(',')}`);
});
