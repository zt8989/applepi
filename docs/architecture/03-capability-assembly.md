# 3. 能力装配：bundle / capability / plugin（ADR-0015，ADR-0017 后由服务端持有）

> [02 核心运行时 ←](02-core-runtime.md) · [索引](../architecture.md) · [04 扁平系统提示词 →](04-flat-system-prompt.md)

能力注入不属于 core（历史机制见 ADR-0015）。能力
由 **bundle**（核心能力集）、**capability 工厂**（memory/skills/todo/plan/goal/
ask_user）与 **plugin**（外部追加）三层构成，全部由 **共享运行时服务端**
（ADR-0017：`packages/server` 的 `getHarness`/`bindSession`/`enableBundleSpec`，
从 web 的 `lib/server.ts` 迁入）装配到 Harness 壳上；web/tui 只消费 `GET|POST
/api/...` 契约，不再做装配。

- **Bundle（能力包）** — `packages/bundle` 的 `base` / `standard`：纯声明
  `(env) => ({ prompt, tools })`，无 side effect、无 core/onion 访问。建会话时选
  一个（mode），`enableBundleSpec(harness, spec)` 注册其工具。
- **Capability（能力）** — `@applepi/extension` 的能力工厂（`createMemory` /
  `createSkills` / `createTodo` / `createPlan` / `createGoal` / `createAskUser`）
  返回 `{ id, prompt(env, session), tools }`。bundle 的 `capabilities` 声明 id 清单，
  服务端用 `getCapability(id)` 解析、注册工具并每轮把 `prompt(env, session)` 片段并入
  扁平提示词。尚无工厂的 id（web/subagent/workflow，批次二/三待 grill）被跳过——
  声明可多于实现，`enableBundleSpec` 打 `console.warn`。状态类能力（todo/plan/goal）
  文件态统一落盘 `<workspaceRoot>/.harness/<name>.json`（`state-file.ts` 助手），
  ask_user 走 `ToolSpec.expectsAnswer`（答案即工具结果）。
- **Plugin（插件）** — ADR-0015 定义的外部追加型能力（尾部追加 prompt 片段 + 注册
  新工具/技能，不可重排/删除 bundle 内部）。web / 服务端当前未挂插件目录。

**装配流程（服务端）**：选取 mode → `makeBundleSpec(mode, { cwd, workspace, level })`
→ `enableBundleSpec`（注册 bundle + capability 工具）→ 用
`assembleFlatPrompt(harness, spec, { app, plugins })` 拼出扁平提示词 =
`[...bundle.prompt, ...capabilities.prompt, ...app 接口片段, ...插件尾部]`，交给
`harness.llm` / `loop`。重建 = 重读同一份 spec（无动态中间件）。

**工具注册**：`harness.registerTool(spec)`（重复名抛错）/ `unregisterTool` /
`getTools` / `buildToolDefs`（委托 `llm`，模型侧只看 `{ description, parameters }`）。