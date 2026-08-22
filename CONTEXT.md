# CONTEXT.md

Project: a minimal **single-machine agent harness**, organized as a **pnpm workspace** (decided via /grill-with-docs, 2026-08-19; reverses the 4f15860 single-package flatten). Core is a **pure runtime skeleton with no tools** (ADR-0005).

## Glossary

- **Harness** — the minimal runtime: onion event bus + loader + built-in agent loop + session store + LLM-config resolution. **Contains no tools** (ADR-0005); all capabilities arrive as extensions.
- **Extension** — an in-process module that injects capabilities (tools, skills, memory) at runtime via `setup(api)`.
- **Hook / middleware** — lifecycle interceptors on the onion stacks: `session`, `llm`, `tool`, and `system_prompt` (ADR-0008). Can observe, veto (skip `next()`), or rewrite `ctx`.
- **Tool** — a capability registered via `api.registerTool({ name, description, parameters (zod), execute })`.
- **Reference tool** — a concrete tool shipped by the `@applepi/extensions` package as a replaceable reference implementation (not core): `bash` and `str_replace_editor`.
- **SecurityPolicy（安全策略）** — core 内置的安全机制（ADR-0009）：接口 + 默认实现。默认实现含三值级别模型（readonly/workspace/fullaccess）、提示词「Permission Level」段落、`/level`。**无运行时拦截中间件**（permissionMiddleware 已删，Q12=a）——「闸口」退化为 level 上下文保证：每个工具 execute 的 ctx 都带当前级别。可被消费者显式替换（替换即自负责）。取代旧的 **Security extension**（ADR-0007 的 `createPermissionExtension`，已随 ADR-0009 删除）。（ADR-0016 后级别存 `session.config.permissionLevel` + `general.permissionLevel`，恢复读 config 文件级联生效——`level/set` 事件与 lastEvent 恢复已删；提示词段落已随 ADR-0015 移入 bundle 共享 `permissionFragment`。）
- **baseExtension** — (superseded by ADR-0015) the former default-capability `SetupFn`; its role is reframed as the **`base` bundle** in `packages/bundle`.

## Flat system prompt / bundle / mode / app (glossary — decided via /grill-with-docs, 2026-08-21, ADR-0015)

> ADR-0015 supersedes the onion/block prompt model (ADR-0008, ADR-0010) and
> re-scopes core into deep modules. Vocabulary below is the post-ADR-0015 model.

- **Bundle（能力包）** — a self-contained capability unit. `base` = exactly `bash` + `str_replace_editor` (two tools, minimal prompt; no memory/skills/plan/goal/subagent). `standard` = a self-contained full set (its own bash/sre reusing shared tool impls, plus memory/skills/web/plan/goal/subagent/workflow/todo/ask_user). **Siblings — `standard` does not inherit `base`.** There is **no `extends`** concept. **（deepen #01 修订）** 两个 bundle 的人格串收敛为同一 minimal 文本（均 `'You are a helpful software engineer assistant.'`）；权限/能力声明段改为装配期共享 `permissionFragment`（由 `spec.tools` ∪ 已落地 capability 工具实时生成），standard 不再向模型声称未接线的 web/todo/subagent/workflow 等能力；`enableBundleSpec` 对声明但无工厂的 capability id 打 `console.warn`。
- **Mode（模式）** — the bundle a session runs under. `base`/`standard` are both bundle and mode; **mode is not a separate concept** beyond "the bundle an app hosts."
- **App（应用）** — `web`, `tui`（design-only；2026-08-22 起进入共享服务端设计，见「共享运行时服务端 / 接入端」词条）。Apps are **interfaces**, not a bundle/mode: it hosts a mode selection and overlays its own interface capabilities (web tools/env declared in `apps/web`); `tui` is modeled but not implemented. Interface axis (web/tui) × capability axis (base/standard) are orthogonal.
- **Plugin（插件）** — external, **append-only**: appends prompt fragments at the tail + registers new tools/skills; cannot reorder or remove base/standard internals. Loaded after the active bundle (extensions-dir loader).
- **Core modules（core 深模块）** — ADR-0015 splits core into single-responsibility modules wired by a thin **Harness** shell: `llm` (only `{ prompt, tools }` + history → one streamed response, SDK-hiding), `loop` (multi-turn + pause/approval/resume), `session` (jsonl + resume + a minimal append-lifecycle-event primitive), `config` (settings/provider/reasoning), `security` (permission enforcement as a **tool-execution seam**: loop queries the level and passes a level-carrying ctx to tool `execute`; tool self-determination), `trace`, and the **Harness** shell.
- **状态类能力状态文件（state capabilities, standard 批次一 #01/#04）** — `todo` / `plan` / `goal` 三个状态类 capability 的文件态统一落盘 `<workspaceRoot>/.harness/<name>.json`（workspaceRoot 取自 `session.config.workspace`，测试可经它重定向到临时目录）；工具 execute 走异步读写，`prompt()` 片段因扁平提示词每轮同步重读而同文件**同步读取**（`loadJsonSync`，小文件、try/catch 兜底）；文件按构造成立在 workspace root 内，故 workspace 级写门禁天然满足，readonly 由工具自决拒写（ADR-0009）；goal/plan 清除 = 删文件 ⇒ 片段缺席。ask_user（#03）无文件态：`ToolSpec.expectsAnswer: true` 使其暂停时前端渲染文本输入卡片（#02 approve-with-payload：答案即工具结果、execute 不被调用）。
- **Flat system prompt（扁平系统提示词）** — single buffer, no blocks/`PromptBag`/prompt middleware/onion. Pure sequential concatenation in **three hard-coded layers**: `bundle 片段 → app 接口片段 → plugin 尾部片段`; lower layers cannot rewrite upper layers. Spec-driven one-shot assembly: app picks a bundle → `{ prompt, tools }` → overlays app interface + plugin appends → hands to `llm`. Rebuild = re-read the same spec.
- **Removed from core（ADR-0015）** — `registerExtension`/`SetupFn`/`HarnessApi`/`OnionBus`/`HookStack`/onion middleware, the generic `emit` event bus, and the `system_prompt` event family. `registerExtension` survives only as an app-layer plugin loader and the shape of `packages/bundle` producers. Permission **declaration** is a bundle prompt fragment; security **enforcement** stays core. **（deepen #01 修订）** 该声明段现为 base/standard 共用（装配期 `permissionFragment`，由实际注册工具实时生成），不再逐 bundle 手写。

## Global/会话配置 (glossary — decided via /grill-with-docs, 2026-08-21, ADR-0016)

> ADR-0016 统一会话配置载体 + 全局/会话双层配置；re-scope ADR-0014 的 lastUsedModel
> 语义、ADR-0009 的 level/set 存储、composer 的 reasoning/set 覆盖；**推翻 Q13**。
> **设计与实现均已完成**（2026-08-21，随 ADR-0015 迁移落地）。

- **全局配置（global config）** — `~/.applepi/settings.json`：`providers` + 新的 `general` 块。实例级；单纯基础设施（providers/密钥）永不 session 化。
- **General（通用设置）** — settings.json 的 `general: { model?, reasoningLevel?, permissionLevel? }` 块，全局默认的唯一出处（Q4/Q9=A）。顶层 `lastUsedModel`/`lastUsedLevel` 删除、无兼容读（Q17=A）。仅从「设置-通用设置」页修改；chip/胶囊**不**写它。
- **会话配置（session.config）** — 统一会话配置对象 `SessionConfig = { workspace?, mode?, model?, reasoningLevel?, permissionLevel? }`；**持久化在旁挂 `<session_id>.config.json>`**（与 jsonl 同根、同 id）；jsonl 只留审计+消息，**config 变更事件（reasoning/set、level/set）全部移除**（Q2=C/Q6=B/Q8=A）。
- **覆盖模式（override-only / diff）** — `<id>.config.json>` 只存会话内**显式改过**的值 + 身份字段（workspace/mode），**不是创建时快照**（Q10=B）：`general` 默认改动会作用于所有未覆盖该 key 的会话。
- **会话配置级联（cascade）** — `会话覆盖 ?? general 默认 ?? 内置默认`，统一公式（Q3=A）；`resolveSessionConfig` 纯函数归 core `config` 模块，`resolveLlmConfig` 收敛到同一 cascade（Q5/Q14/Q16）。
- **可变性（mutability）** — `workspace`/`mode` 构建期不可变（创建写一次）；`model`/`reasoningLevel`/`permissionLevel` 运行中可变（每次改动重写 config 文件，Q7）。
- **Model 动态默认（dynamic model default）** — model 默认层**读时计算、不存盘**：`覆盖 ?? general.model ?? 第一个可用 provider 的第一个模型`；默认 provider 被删/目录清空自动改道，无修复路径（Q16 部分/Q19=A）。
- **权限级别的家** — `permissionLevel` 归 `session.config`（覆盖）+ `general.permissionLevel`（默认）；`level/set` 事件删除，安全恢复读 session.config（Q8=A）。**取舍（接受）**：级别变更离开 append-only 审计时间线。
- **Model 会话覆盖（Q13 推翻）** — model 有会话级覆盖：chip 切模型只写 `session.config.model`；全局默认只从「设置-通用设置」改（Q4）。
- **空模型 UX（empty-model）** — cascade 无模型时：web 发送强制弹**模型选择器**、未选不发送（Q17=A）；CLI 不约束（将删除，Q20）。
- **配置存储归属** — `<id>.config.json>` 读写原语归 core `session` 模块（`SessionStore.loadConfig/saveConfig`，全量原子重写，缺失 → `{}` 不 fail fast）；级联纯函数归 `config` 模块（Q14/Q15）。
- **写路径（Q11）** — chip/胶囊写会话覆盖、设置页写全局；level 变更**保留提示词重建副作用**（重建触发归 shell/调用方，不塞进 config 纯函数）。
- **seed 顺序（Q18）** — 新建：先写身份 `{workspace, mode}` 一次、不展开覆盖值；首条消息 pre-chosen（model/reasoning/level）作为初始覆盖写入。恢复：`loadConfig()` → 内存 session.config → cascade → 重建 spec（恢复 ADR-0015 的 mode）。
- **迁移** — 旧会话无兼容回退（Q13=A，无 reasoning/set/level/set fallback）。

## Session persistence (glossary — decided via /grill-with-docs)

- **Session** — a persistent conversation bound to a `session_id`; recorded append-only to a jsonl file. **resume & session-listing are core capabilities** driven by the web UI（CLI 已删，web 是唯一接口）.
- **Session id** — uuid (v4) generated per session, reused to resume.
- **Workspace** — slug of the process cwd absolute path; the directory tier under `~/.applepi/sessions/<workspace>/`. Web 端工作区**发现仅读 `~/.applepi/sessions/.manifest.json`**（slug↔path，由 `addWorkspace` 写入），不再扫描 sessions 目录子目录（避免 test 残留污染列表）；**显示名取路径最后一段（basename）**，而选择/激活/工具 cwd 仍以完整路径为 key（ADR-0013）。
- **SessionStore** — a **core-owned** class managing the append-only jsonl for a workspace: `create`, `appendEvent`, `appendMessage`, `load` (replay → LLM message array), `list` (for `/sessions`). Lives in the **core package** (`packages/core`), so any UI can drive it.
- **Session store file** — single append-only jsonl at `~/.applepi/sessions/<workspace>/<session_id>.jsonl`. Each line is either an **event line** (`kind:"event"`) or a **message line** (`kind:"message"`); session/workspace identity lives in the file path, not in the lines (ADR-0006).
- **Event（事件）** — `kind:"event"` line recording a lifecycle record in the merged `event` field, e.g. `title/set`, `pin/set`, `notify/set`, `tool/approval-pending`, `reload/start` / `reload/end`. （`system_prompt/*` 事件族与 `skill/start|end` 已随 ADR-0015 移除；`mcp` 已随 mcp 特性删除，Q11；`type`+`phase` 合并进 `event`，ADR-0006。）**ADR-0015 起无 `emit` 事件总线**：事件由 app / 工具直接 `SessionStore.appendEvent` 写入 jsonl——`appendEvent` 就是存储原语，不存在 core 内置事件处理器。（ADR-0016 已把 `level/set`、`reasoning/set`、`mode` 等配置类状态迁入 `<id>.config.json>`，实现完成 2026-08-21；jsonl 只留审计 + 消息 + 非配置类事件。）
- **Message line** — `kind:"message"` line mirroring an LLM message (`role`: system|user|assistant|tool). The first system message is the flat system prompt (persisted at session start by the app; each turn uses a freshly-assembled prompt, ADR-0015).
- **Resume** — `/resume <id>` (core `SessionStore.load`) switches the active session to `<id>` and continues appending to its jsonl. `<id>` absent → new session.
- **Slash commands (core capability)** — registered via `Harness.registerSlashCommand(name, handler)`; core 自注册 `/level`，内置 `/config`, `/resume <id>`, `/new`, `/sessions` (list `~/.applepi/sessions/<workspace>/`), `/help`. Web drives the same core methods。（CLI REPL 及其 `/exit` 已删。）
- **Reload（重载，已随 CLI 移除）** — 原 CLI `/reload` 是 app 层插件重载（撤销插件工具 → 重扫 `extensions/` → 重建扁平提示词并按 `reload/start`+新 system+`reload/end` 持久化）。插件加载器随 CLI 删除；`reload/start|end` 事件与 `SessionStore` 的 replay 规则（最新 system 替换 message[0]）作为存储/读取原语保留。
- **System-prompt middleware（系统提示词中间件）** — **(superseded by ADR-0015, 已移除)** 曾是 extensions 挂在 `system_prompt` 洋葱栈上的中间件（ADR-0008）；现由扁平提示词取代：bundle/capability/app/插件片段顺序拼接、无中间件、无洋葱。历史表述见 ADR-0008。
- **System prompt（系统提示词）** — 扁平单一缓冲区（ADR-0015，supersedes ADR-0008/0010）：`bundle 片段 → app 接口片段 → plugin 尾部片段` 三层顺序拼接；permission 声明段是 bundle 自有片段并按级别分档。由 app 每轮用 `assembleFlatPrompt` 重读同一份 spec 组装；系统消息只在会话启动 / `/reload` 持久化一次。
- **Replay transform (read-only)** — to build the LLM message array, filter the jsonl to message lines only. If a `reload` event exists, the most-recently rebuilt system message replaces message[0]; the original jsonl is never mutated.
- **MCP** — **feature removed** (Q11). Previously `mcp_call` via `bash`+`mcp-cli`; deleted from core/extensions/agent/docs.

## LLM configuration (glossary — decided via /grill-with-docs; **multi-provider registry supersedes ADR-0004 single-provider model, see ADR-0014**)

- **LLM settings** — `~/.applepi/settings.json`, the **only** source of LLM config (process.env is no longer read, Q3=b). Schema (ADR-0014, extended by ADR-0016): a **multi-provider registry** `{ providers: Record<ProviderId, ProviderConfig>, general?: GeneralConfig }`. **No `active` field** — every provider's models are selectable. **`lastUsedModel`/`lastUsedLevel` are superseded by ADR-0016** (`general.model`/`general.reasoningLevel` default slots + session overrides). Missing file → throw (fail fast).
- **ProviderConfig** — per-provider object: `{ displayName, protocol, baseURL?, apiKeyRef, models?: ModelEntry[], builtin?: boolean }`.
  - **protocol** — one of `openai-completions` | `openai-responses` | `anthropic-messages`; selects the SDK factory (ADR-0014 §mapping). Supersedes the old `provider` field as the *runtime* discriminant.
  - **provider (legacy label)** — the old `provider` string (`openai`/`anthropic`) is **demoted to a display/grouping label only**; it no longer selects the SDK factory.
  - **apiKeyRef** — a **key name** into the secret file (see Api key reference). Derived secret name per provider: `PROVIDER_<ID_UPPER>_API_KEY`.
  - **models** — optional managed catalog `ModelEntry[] = { id, displayName }[]`. Non-empty → populates the model selector; empty → UI first calls **获取可用模型** (Q2), and any typed ID outside the catalog still sends (per-provider dashed hint).
- **Builtin provider presets (内置预设)** — `BUILTIN_PROVIDERS` in core: a **read-only** catalog (DeepSeek / OpenAI / Anthropic / Gemini / Mistral / 智谱 / 通义千问 …), each preset carrying default `protocol` + default `baseURL` + suggested default models. Presets are **not user-deletable**; user-side `settings.json` stores *enabled + custom* providers only. Custom providers (added via the 自定义提供方 modal) **are** deletable (red 删除 button).
- **Custom provider (自定义提供方)** — a user-added provider whose `ProviderId` is constrained to `^[a-z][a-z0-9-]*$` (lowercase-leading, `[a-z0-9-]`), must be unique against all ids (incl. builtins), and derives its secret name `PROVIDER_<ID_UPPER>_API_KEY`. Fields: `Provider ID` / 显示名称 / API 地址 / API 协议 / API 密钥 / 模型目录.
- **Secret file** — `~/.applepi/.env`, holds the real API keys. Parsed with the `dotenv` package (Q7=b). Each provider's real key lives under its derived `PROVIDER_<ID_UPPER>_API_KEY` name.
- **Api key reference (placeholder)** — `apiKeyRef` in a ProviderConfig is a **key name** into the secret file: `realKey = dotenv[apiKeyRef] ?? apiKeyRef` (Q1=a, preserved from ADR-0004). A real key written directly also works.
- **lastUsedModel** — **superseded by ADR-0016** (was a global single record with no per-session variant, Q13 — now reversed). Superseded form: global pre-select for new conversations, written on every model use. It became `general.model` (global default slot) + per-session override `session.config.model`.
- **/config** — slash command that re-reads settings.json + .env and rebuilds the model (Q5=c). `/reload` does **not** touch the provider. Web mirrors this via `invalidateModel()` clearing the cached `modelPromise` after any provider save (Q11).
- **Config resolution (core-owned)** — core provides the load/parse/resolve primitives (`loadSettings` / `loadDotenv` / `resolveApiKey`, or a one-shot `resolveLlmConfig`), the agent assembles the provider instance (Q4=a). `resolveLlmConfig` now resolves the *last-used* provider+model (no global `active`) and returns `protocol` alongside `provider`/`model`/`apiKey`/`baseURL`.
- **Model selector (UI)** — a **provider-grouped two-level list** (group header = provider display name in grey; items = that provider's catalog models + a free-text entry; selected item = light-grey rounded highlight), pre-selected to `lastUsedModel` (Q14, confirmed via screenshot).
- **推理等级（Reasoning level）** — 控制 LLM 思考强度的四档设定（`off | low | medium | high`，默认 `medium`），**与「权限级别（Permission level）」正交**：权限管工具行为边界，推理等级只调模型请求。持久化为**双层**（ADR-0016）：全局默认 `general.reasoningLevel`（仅从设置页改）+ 会话覆盖 `session.config.reasoningLevel`（仅从 composer 改）。写入语义：composer 芯片切换只写会话覆盖（无会话时随首条消息 pre-chosen 携带，`POST /api/chat` body 加 `reasoning`），**不污染全局默认**；解析顺序 = cascade `session.config.reasoningLevel ?? general.reasoningLevel ?? medium`。（旧 `lastUsedLevel` 顶层字段与 `reasoning/set` jsonl 事件已被 ADR-0016 取代。）协议映射（web 路由传 `protocol`+`reasoningLevel` 给 core）：openai 两协议 → `providerOptions.openai.reasoningEffort`；anthropic-messages → `providerOptions.anthropic.thinking={type:'enabled', budgetTokens: 1024/2048/4096}`；其他协议不传参（silent）。注意 @ai-sdk/openai 不代理 DeepSeek 的 `reasoning_content`（思考正文不上屏）。
- **思考过程块（Thinking block）** — assistant 消息里 `{type:'reasoning', text}` 部分，前端渲染为**默认折叠**的可展开「思考过程」块（位于回复正文上方），随消息持久化（core 在 assistant 消息中追加 reasoning part）。流式开启：`stream-loop.ts` 的 `mergeIntoDataStream` `sendReasoning: true`，客户端 `onReasoningPart` 攒 delta。
- **composer 右下角（本次)** — 合并 chip「模型名 + 思考等级」+ 独立环形用量。chip 弹层 = 推理等级四档 + 模型分组列表；环形可点，展开用量详情面板（上下文占用 + 会话累计真实 token）。真实 token 来自流式 `finish_message` part 的 `usage`（`sendUsage: true` 已开），客户端 `onFinishMessagePart` 累计；环形百分比仍是客户端估算（`estimateUsage`）。权限胶囊不动。

## Key decisions (locked)

Wiki: start at `docs/README.md` (architecture: `docs/architecture.md`; design principles: `docs/design-principles.md`). Pnpm workspace layout (workspace packages + apps):

- `packages/core` (`@applepi/core`) — the harness runtime as **single-responsibility deep modules** (llm / loop / session / config / security / trace) wired by a thin Harness shell. **No tools** (ADR-0005); **no onion/extension mechanism** (ADR-0015: `OnionBus`, `registerExtension`, `HarnessApi`, `emit`, `system_prompt` events, `PromptBag`, `buildSystemPrompt` all removed).
- `packages/bundle` (`@applepi/bundle`) — ADR-0015 能力包：`base` / `standard` 纯声明 `(env) => ({ prompt, tools, capabilities })` + app 侧装配助手 `enableBundleSpec` / `assembleFlatPrompt` / `bundleEnv`。`baseExtension` 的角色由 `base` bundle 承接（ADR-0015 reframes ADR-0005）。
- `packages/extensions` (`@applepi/extensions`) — reference tools (bash / str_replace_editor, each self-determining per level) + capability factories `createMemory` / `createSkills`（`getCapability` 注册表）。Security mechanism lives in **core** since ADR-0009 (was the security extension here, ADR-0007).
- `apps/web` (`@applepi/web`) — **唯一界面**（CLI 已删）：Next.js，每 (workspace, mode) 缓存一个 Harness，装配 bundle + capabilities、扁平提示词组装、mode 建会话时选定。

Dependency graph (one direction): `@applepi/web → @applepi/bundle → @applepi/core` 与 `@applepi/bundle → @applepi/extensions → @applepi/core`。Cross-package imports use **package names** resolved to `dist/` via each package's `exports` (Q3=a); dev/test run **build-first** (Q4=a); each package has its own `tsconfig.json` extending a shared base (Q5=a); the root `package.json` orchestrates `build`/`dev`/`test`/`verify` (Q6=a).

Architecture decisions are recorded as ADR-0001 (harness), ADR-0002 (session persistence: jsonl + resume + reload), ADR-0003 (workspace split), ADR-0004 (LLM config sources), ADR-0005 (reference tools + denylist → `baseExtension`), ADR-0006 (event schema slimming), ADR-0007 (permission levels: read/write scoped tool access), ADR-0008 (system prompt built on the `system_prompt` onion stack), ADR-0009 (security as tool self-determination: core-built SecurityPolicy + extension reload), and ADR-0010 (system prompt = PromptBag of three block stacks, supersedes ADR-0008); web decisions: ADR-0011 (web streaming loop + approval state machine), ADR-0012 (web stack + tracing), ADR-0013 (web workspace discovery: manifest-only + basename display), and ADR-0014 (multi-provider registry: settings.json = { providers, lastUsedModel }, protocol-selects-factory, builtin read-only presets, no in-code migration). **ADR-0015 (flat system prompt + bundle/mode/app + split core) supersedes ADR-0008 and ADR-0010, re-scopes ADR-0009 (permission declaration → bundles), and reframes ADR-0005 (`baseExtension` → `base` bundle in `packages/bundle`).** **ADR-0016 (unified session config + two-tier global/session config) supersedes the `lastUsedModel`/`lastUsedLevel` semantics of ADR-0014, moves `level/set` storage into `session.config`, and reverses the Q13 no-per-session-model decision.** See the「Flat system prompt / bundle / mode / app control」section below.

## Permission levels (designing — via /grill-with-docs, round 1)

- **Permission level（权限级别）** — 会话级**单一主级别**，统一作用于所有工具（Q2=统一，不做按工具分级）。每个级别由「可读范围 × 可写范围（修改粒度）」两个维度构成（Q1=b，「修改级别」= 修改粒度维度，不是并列第四档）。
- **Level source（级别来源）** — **superseded by ADR-0016**（原：级别状态持久化在会话 jsonl 的 `level/set` 事件中，当前级别 = replay 时最后一个 `level/set` 事件的 `payload.level`；无该事件默认 `workspace`）。ADR-0016 后：级别存 `session.config.permissionLevel` 覆盖 + `general.permissionLevel` 默认，`level/set` 事件与 lastEvent 恢复路径删除；默认仍 `workspace`。
- **Denylist 底线** — 原 denylist 黑名单（8 条危险正则）保留，作为**任何级别下都生效的绝对底线**，内嵌进新的权限中间件（Q4）；级别管「范围与写权限」，denylist 管「绝对危险命令」，正交叠加。

## Permission levels (designing — via /grill-with-docs, round 2)

- **可读 × 可写矩阵（Q5）** — 读范围一律**全盘可读**，只有写范围分级：`readonly` = 可读任意、不可写；`workspace` = 可读任意、可写限 cwd（project root）内；`fullaccess` = 可读任意、可写任意（仅受 denylist 底线约束）。
- **Project root（Q6）** — 权限语境下的「工作区」= 进程 cwd 的 **realpath**（术语定为 **project root**，与 session workspace 的目录 slug 区分）。写操作目标路径先 `realpath` 解析（解符号链接），再检查是否以 project root 为前缀；`..` 逃逸由 realpath 后的前缀检查天然覆盖。bash 侧做「写命令识别 + 路径提取」启发式（`rm/mv/cp/mkdir/touch/tee/sed -i/重定向 > >>` 等）；**识别不了目标路径的写命令一律拦截**（保守优先）。
- **级别切换（Q7）** — 级别**只能由用户在 CLI 用 `/level <readonly|workspace|fullaccess>` 切换**，写入 `level/set` 事件并立即重建系统提示词；**模型没有任何改级别的工具**（防自我提权）。权限中间件从 `session.scratch` 读当前级别，启动/恢复时由最后一个 `level/set` 事件初始化。slash 命令语义归核心（P6）。
- **工具映射（Q8）** — `bash`：readonly 下用**只读命令白名单**（`ls/cat/grep/pwd/head/tail/wc/find/stat/du/echo` 等），白名单外一律拦截；workspace 下白名单外命令按 Q6 路径规则判定。`str_replace_editor`：readonly 只放 `view`；workspace 放 `view/write/str_replace` 但路径限 project root 内；fullaccess 全放行。`memory_write` 算写（readonly 拦、workspace 若文件在 project root 内放行）；`memory_read` 算读（全级别放行）；`skill_load` 算读资源（readonly 下也放行，技能是知识注入；其写提示词能力与提示词改造一同在 R3 讨论）。

## Permission levels (designing — via /grill-with-docs, round 3)

- **提示词改造（Q9）** — 权限扩展贡献一段固定结构的「权限声明」段落（级别名 + 该级别允许/禁止行为 + project root 路径 + 按级别裁剪后的可用工具清单）；注入时机 = 会话启动/恢复/`/level` 切换后**立即重建**系统提示词（`emit('system_prompt')` 事件 → 内部 append 新 system 消息行，ADR-0002 replay 语义：最新 system 替换 message[0]；ADR-0008 演进后所有事件统一走 emit）。模型每轮「看到」权限边界，而非靠撞拦截才知道。
- **双层机制（Q10=c）** — 主路径是**注册面裁剪**：`buildToolDefs()` 按级别裁剪暴露给模型的工具与参数 schema（readonly 下 `bash` 只暴露只读白名单命令说明、`str_replace_editor` 参数枚举裁成 `['view']`），模型看不到不允许的东西；兜底是**运行时拦截**：权限中间件仍挂 priority 1000 审计最终执行（防裁剪漏洞/内层改写）。core 的 `buildToolDefs` 保持极简，只提供通用 `registerToolFilter` 钩子，不含权限语义（P1/P2）。
- **级别事件与恢复（Q11=a）** — `level/set` 事件格式：`{"kind":"event","event":"level/set","payload":{"level":"workspace"},"ts":"..."}`（沿用 ADR-0006 行结构，无 start/end 相位，原子事件）。`SessionStore` 新增 `lastEvent(name): SessionEvent | null`（扫文件取最后一个匹配事件）；恢复逻辑：`/resume` 与启动时 `const ev = await store.lastEvent('level/set'); level = ev?.payload?.level ?? 'workspace'`，写入 `session.scratch['__permissionLevel']`。存储读取原语归 core（P6），语义解析归权限扩展。
- **实现拆分（Q12）** — `packages/extensions/denylist.ts` **保留**（危险正则列表 + `denylistMiddleware` 原样导出，`check-denylist.ts` 继续用），成为权限系统的**内部底线组件**；新增 `packages/extensions/permission.ts`：导出 `permissionMiddleware`（先跑 denylist 底线、再按 `session.scratch['__permissionLevel']` 级别判定）、`createPermissionExtension()`（SetupFn：挂中间件 priority 1000 + 注册 `registerToolFilter` 裁剪器 + 注册权限声明段落 + `/level` 语义实现）。`baseExtension` 改挂 `permissionMiddleware` + `createPermissionExtension()`；新增 `apps/agent/scripts/check-permission.ts`。（注：权限声明段落最初记为 "注册权限声明 contributor"，ADR-0008 后改为挂 `system_prompt` 栈中间件，本行保留当时表述。）

## Permission levels (designing — via /grill-with-docs, round 4)

- **Slash 命令归属（Q13=a）** — core 增加通用扩展点 `HarnessApi.registerSlashCommand(name, handler)`（一个 map + 查询方法）；`/level` 由 permission 扩展注册，main.ts 的 switch 改为「先查扩展注册命令、再查内置命令」。纯机制、无权限语义（P1/P2），slash 语义归核心（P6，未来 web UI 复用）。
- **Tool filter 签名（Q14=b）** — `type ToolFilter = (toolName: string, def: { description; parameters }) => { description; parameters } | null`；null = 不暴露，返回新 def = 改写（readonly 下把 `str_replace_editor` schema 裁成只有 `view`）。filter 按注册顺序串联，任一 filter 返回 null 即不可复活。`buildToolDefs()` 遍历工具时依次应用所有 filter。
- **边界收尾（Q15）** — 权限级别**只约束工具行为 + 权限声明段落**；其他系统提示词段落（skills 注入、base）不受级别影响。`memory_write`/`skill_load` 按**工具名分类**为写/读（memory_write 目标文件是扩展固定的 `harness-memory.json`，在 project root 内，workspace 放行、readonly 拦、fullaccess 放行；skill_load 算读，全级别放行）。
- **验证与文档（Q16）** — check-permission.ts 验证 5 条：默认 workspace + 提示词声明、readonly 拦截（write/白名单外 bash）、workspace 路径前缀（root 内放行、/tmp 拦）、fullaccess 放行但 denylist 底线仍拦、`/level` 切换后事件写入 + 提示词重建 + lastEvent 恢复。ADR-0007 记录全部决策。

## System prompt blocks (decided — via /grill-with-docs, Q1–Q17, ADR-0010)

- **System prompt block（提示词分块）** — 系统提示词的规范组成单元。固定 3 块，规范顺序：`base`（系统提示词）→ `permission`（权限）→ `skills`（技能）（Q2/Q16）。顺序是**结构性保证**：每块挂在**各自的中间件栈**上（Q5），构建时按规范顺序依次装配——与注册顺序/priority 无关（SecurityPolicy 即使最先安装也只写 `permission` 块，天然落在第二）。
- **Block stack（块栈）** — 块名 = 栈名，统一加 `prompt/` 前缀（Q6=a/Q16）：`HookStack` 变为 `session | llm | tool | prompt/base | prompt/permission | prompt/skills`，`system_prompt` 栈删除；`api.use('prompt/base', mw)` 与 `bag.set('base', ...)` 共享短块名。
- **PromptBag（提示词袋）** — 构建上下文里替代 `promptParts: string[]` 的结构（Q5）：对象含 3 个数组（每块一个）+ `set(block, array | (old) => new)` 方法，第一参为块短名、第二参为数组或旧值→新值更新函数。**写入只走 `set`**（Q7=b，无直接数组变异）；updater 的 `old` = **本块**旧数组（Q14=a），块间互不可见。
- **Rebuild-all semantics（全量重建语义）** — 任一块事件触发时**重建全部 3 块**并持久化一条完整 system 消息（Q4）；块事件 `system_prompt/<block>`（Q9=a）只是语义化触发点，不是增量重建入口；`system_prompt` 保留为全量入口（启动 / `/reload` / `/new`，Q12=a）。
- **Sections（构建期块列表）** — `buildSystemPrompt()` 仍返回 `{ prompt, sections }`，`sections` = **非空的块名列表**（按规范顺序，Q10）；`system_prompt/start|end` 事件对与持久化路径不变。
- **Base 块内容（Q13/Q17）** — `BASE_SYSTEM_PROMPT` 只留「你是谁 + 怎么用」；「You have two reference tools」句删除且**不恢复**——工具信息只走 tool defs（Vercel SDK），系统提示词不再承载工具清单（`tools` 块已删除，Q16/Q17=b）。
- **Veto 语义（Q15=a）** — 分块后 veto **块内有效**（跳过该块后续中间件）、**跨块 veto 消失**；持久化照旧不受 veto 影响（ADR-0008 Q6 不变）。

## Security model (designing — via /grill-with-docs, round 1)

- **威胁模型（Q1=a）** — 安全**只防「模型越权」**：扩展全可信（zero-isolation，信任边界同 ADR-0005，不因本轮改变）。防恶意扩展 = OS 级隔离，不在本决策范围。
- **安全职责模型（Q2=c）** — **工具声明安全语义，统一层执行审计**：ToolSpec 增加安全声明（读/写/mixed + 写目标提取器），permission 中间件 / 注册面裁剪 / denylist 全部基于声明工作，**按工具名特判消失**（`checkTool` 的 bash/sre/memory_write 硬编码退化为内置工具的默认声明）。未声明工具的默认策略待定（Q5）。
- **安全机制归属（Q3=b + 补充）** — **permission 由 core 内置**：core 强制保证 tool 栈最外层审计位存在，权限级别模型 / permissionMiddleware / ToolFilter / 权限声明段落 / `/level` 内聚进 core，不再是 `@applepi/extensions` 的可选扩展。部分逆转 ADR-0005（"安全移出 core"），本质是「注册约定 → core 机制」的演进，需 ADR-0009 记录。

## Security model (designing — via /grill-with-docs, round 2)

- **安全语义载体（Q4）** — **不引入 ToolSpec 声明字段**。工具/扩展在 execute 时从上下文读取当前 permission level（readonly / workspace / fullaccess 三值），**自行判断并约束自身行为**（动态组合）：bash 在 readonly 自限只读命令、str_replace_editor 自限 view 等。Q2=c 由此细化成形：「上下文注入 → 工具自决」，统一层不再认识任何工具。
- **注册与默认策略（Q5）** — **不需要申请 / 声明 / 注册期校验**。上下文天然携带当前 permission，工具运行时读取并动态组合。无默认拦截策略；安全强度 = 每个工具的自决程度（Q1=a 扩展可信的推论，后果确认见 Q11）。
- **特判逻辑去向（Q6=a）** — `permission.ts` 的 checkBash / checkSre / checkTool / cropTool 等按工具名特判**全部从统一层移除**，逻辑迁入工具自身（bash 的命令分析、sre 的 path 检查、各自的面裁剪）；core 内置 permission 不再认识任何具体工具名。面裁剪执行机制的留废见 Q8，denylist 底线去向见 Q9。
- **内置形态（Q7=b）** — core 提供 **SecurityPolicy 接口 + 默认实现**（级别模型 / level 状态与事件 / 上下文注入 / 底线审计 / 提示词段落 / `/level`），默认挂载不可绕（Q3=b）；消费者可显式替换策略，替换即自负责。默认实现的具体组成见 Q10/Q12。

## Security model (designing — via /grill-with-docs, round 3)

- **注册面裁剪（Q8=b）** — **取消 ToolFilter 参数级裁剪**：已注册工具不按 level 裁剪参数 schema，模型看到完整工具面；违规行为靠工具 execute 运行时拒绝。工具**集合**级的注册面切换由「扩展重建」机制承担（见下）。
- **denylist 底线（Q9=a）** — `DENY` 正则迁入 **bash 工具自身**（execute 前先跑，任何 level 生效）；core 不再持有任何工具特定规则。
- **级别骨架（Q10=a）** — 三值级别模型、`level/set` 事件 + lastEvent 恢复、提示词「Permission Level」段落、`/level` 命令，全部归 core 内置默认 SecurityPolicy；替换策略 = 骨架整体替换。
- **保护强度（Q11=a）** — 确认 readonly 为「君子协定」：不读 level 的工具在 readonly 下仍全权执行，core 不兜底。统一层的运行时拦截角色大幅退场。
- **运行时闸口（Q12=a）** — **撤销 permissionMiddleware**（priority 1000 的 entry/exit 审计）；「闸口」退化为「level 上下文保证」：core 保证每个工具 execute 的 ctx 带当前 level。
- **扩展重建机制（补充，形态待定）** — 为实现动态 Permission，引入**扩展加载/卸载机制**：扩展 setup 时注册的工具被 core **记录**；重建时**卸载全部注册产物**，扩展以当前 level 重新 setup 注入新工具集。触发时机 / 卸载形态 / 与现有 `/reload` 的关系待定（Q13–Q17）。

## Security model (designing — via /grill-with-docs, round 4)

- **卸载形态（Q13=b）** — core 自动跟踪**注册作用域**：`registerTool` / `use` / `registerSlashCommand` 的记录自动归属「当前 setup 的扩展」，重建时 core 按扩展撤销全部注册；扩展无感，只需 setup 时读 level 注册合适工具。
- **触发时机（Q14=b + 补充）** — 事件驱动，**分两级**：
  - `level/set`（`/level`）→ **轻量**：只重建系统提示词（权限声明段落），**不卸载工具** —— Level 只是权限大小变化，工具 execute 自决即时生效（每轮读 scratch）
  - 扩展新增/删除（`/reload`）→ **重量**：卸载全部注册产物 → 重读扩展目录 → 重新 setup 注入 → 重建提示词
- **注册面与自决（Q15=a 细化）** — 工具**集合** = f(扩展集合)，由 reload 管理；工具**行为** = f(level)，由 execute 自决。**所有工具无论 level 保持注册**（readonly 下 `memory_write` 仍可见，被调用时 execute 自决拒绝 + 提示词声明告知模型不可用）。
- **`/reload` 重定义（Q17=a）** — 不再 new Harness：= 扩展卸载 + 重注入 + 提示词重建，保留 `session.scratch` / `history`。与 `/level` 共享「扩展环境变化」概念但动作不同：level 轻（提示词重建）、扩展增删重（卸载+重注入）。
- **外部副作用管理（useEffect，补充）** — 扩展副作用分两类：harness 知道的（`registerTool` / `use` / `registerSlashCommand`，由注册作用域 Q13=b 自动撤销）与 **harness 不知道的外部副作用**（定时器 / fs watcher / 子进程 / HTTP server 等扩展自建资源）。新增 `api.useEffect(fn: () => (() => void) | void)`：setup 时**同步执行** fn，返回的 cleanup 归入当前 setup 作用域；可多次调用。reload 重建顺序：① 调用全部 cleanup（先释放外部资源）→ ② 撤销注册 → ③ 重新读目录 + setup → ④ 重建提示词。cleanup 抛错按软隔离处理（捕获、不中断重建）。副作用不得依赖跨 reload 的进程级状态。

> **Confirmed — 2026-08-19（Q1–Q23 全部敲定，ADR-0009 记录；supersedes ADR-0007 的双层机制与 ADR-0005 的安全移出 core 部分）。**
>
> **Implementation — complete（2026-08-19）**：`extensions/permission.ts` 与 `denylist.ts` 已删除（DENY 并入 `tools/bash.ts`）；core 新增 `security.ts`（SecurityPolicy 接口 + 默认实现 + `getPermissionLevel` / `isInsideProjectRoot` 原语）与注册作用域/reload（`harness.reloadExtensions` + `api.useEffect`）；bash / str_replace_editor / memory 在 execute 内自决；`registerToolFilter` / `ToolFilter` 移除；`baseExtension` 瘦身；`check-permission.ts` → `check-security.ts`。全部 build / test / check 通过。

## Web interface (confirmed — via /grill-with-docs, 2026-08-20, rounds 1–3; ADR-0011 + ADR-0012)

- **Web Chat 界面（web chat interface）** — harness **唯一界面**：Next.js App Router（`apps/web`，`@applepi/web`，端口 3010）+ assistant-ui 0.15 primitives（ExternalStoreRuntime 适配器，Tailwind v4）+ Vercel AI SDK v4 数据流协议（`createDataStreamResponse` + `processDataStream`）。复用同一 core（Harness + runLoopStreamSegment + SessionStore），共享安全策略、工具链。个人本地工具，无鉴权。原 CLI（`apps/agent`）已删除。
- **流式 loop（streaming loop）** — core 提供**唯一** agent loop：`runLoopStreamSegment`（`streamText` 变体，token 级分段流 + 暂停/恢复状态机，ADR-0011）。CLI 的非流式 `runLoop`（generateText）已随 CLI 删除。
- **工具批准（tool approval）** — web 会话对工具执行采用**前端批准**：`ToolSpec.approval`（`auto`/`ask`/按参数函数，缺省 `ask`）分类；`ask` 工具暂停并持久化 `tool/approval-pending` 事件；`POST /api/chat/approve` 从暂停点续跑（**不重跑 LLM**，jsonl 即 loop 状态）。读类自动执行（memory_read / skill_load / view / bash 只读命令），写/执行类须批准；**拒绝 = 工具结果回填模型**（模型可自愈）。
- **工作区选择器（workspace picker）** — 页面可**选择已有工作区或手动添加**（`GET|POST /api/workspaces`，manifest 记录 slug↔path）；`session.config.workspace` 决定工具 cwd 与 project root（`workspaceRoot(ctx)`）；切换后 resume 该工作区最近会话（无则新建），选择持久化 localStorage。`GET /api/session` 刷新恢复 + 重新浮出待批卡片。
- **Trace（可观测性追踪）** — 埋点位于 **core 层**（`trace.ts`：每轮一条 trace + 每条 LLM 调用一个 generation 带 token usage + 每工具一个 span），**web（唯一界面）自动受益**；目标 **Langfuse Cloud**（`~/.applepi/.env` 的 `LANGFUSE_BASE_URL` / `PUBLIC_KEY` / `SECRET_KEY`，ADR-0004 约定；未配置则为 no-op）。

> **Confirmed — 2026-08-20（Q1–Q13 全部敲定，ADR-0011 记录流式 loop + 批准状态机，ADR-0012 记录技术栈 + 埋点；round 2 将 Langfuse 从自建改为云端）。**
>
> **Implementation — complete（2026-08-20）**：core 新增 `stream-loop.ts`（`runLoopStreamSegment` / `executeApprovedTool` / `classifyApproval` / `pendingToolCalls`）、`trace.ts`（getTracer/flushTraces）、`ToolSpec.approval`、`workspaceRoot`（isInsideProjectRoot 支持 root 覆盖）；extensions 五工具加 approval 分类 + 跟随 workspace root；`apps/web`（assistant-ui + Tailwind v4 + 四个 API 路由 + 批准卡片 + 工作区选择器，ExternalStoreRuntime 适配器）；根脚本 `dev:web`。E2E 验证：分段流暂停 → 批准执行 → 续跑自动读工具 → 最终文本；拒绝回填模型自愈；会话水合；mismatch 守卫。全部 build / test / 检查通过。

## Web UI shell (confirmed — via /grill-with-docs, 2026-08-20; base-style redesign)

复刻 assistant-ui playground base 壳视觉（两栏、外层圆角白卡、极简线性图标、中性配色、克制圆角/阴影），并做产品化适配：

- **布局**：外层灰底 + 圆角白卡（桌面）两栏；移动端侧栏折叠为抽屉。
- **侧栏树**：品牌「applepi π」→ 新对话 → 「空间 (N)」汇总头 → 按工作区分组的会话树（folder + ⌄ 折叠，默认展开，每工作区 5 条 + 查看更多；活跃会话浅色高亮，hover 显示 bell/archive/⋯ 动作：重命名 / 置顶 / 导出 jsonl / 通知标志）。会话元数据：`title/set`（缺省取首条 user 消息截断 40 字）、`pin/set`、`notify/set` 事件；归档 = 移入 `.archive/` 子目录。
- **composer 脚部**：composer 大圆角框（输入 + `+`/mic/圆形发送）；框下独立一行胶囊 —— **工作区胶囊仅在首屏新会话空态出现**（选好工作区后归属该会话，不再显示）；**权限胶囊常驻**（只读/工作区/完全访问，改级别 = 写 `level/set`，与 core `/level` 同语义；新会话首条消息可带预选级别）。
- **工作区下拉**：搜索 + 文件夹列表 + 「新建工作空间」（内联路径）+「打开本地文件夹」（**macOS 原生目录选择**：浏览器 showDirectoryPicker 拿不到绝对路径，改由服务端 osascript `choose folder` 返回真实路径；非 macOS 降级为路径输入）。
- 不做建议 chips（用户明确不需要）；placeholder「发送消息…（/ 调用技能或指令）」；主区标题 = 活跃会话标题 / 空态「新对话」。

> **Implementation — complete（2026-08-20）**：`apps/web` 重构（sidebar / workspace-dropdown / composer-footer / chat-ui / approval-tool 重画；icons 内联 SVG）；服务端新增 `/api/pick-folder`、`/api/session` GET 支持 `format=jsonl` 导出 + level/title 返回、PATCH（rename/pin/unpin/archive/unarchive/notify/level）；`/api/workspaces` 富化（每会话 title/ts/pinned/notify）；`/api/chat` 首条消息支持 `level`。E2E 验证：rename/pin/archive/unarchive/export/level 全部通过。构建 + verify 全绿。

## Web 二期（confirmed — 2026-08-20；F1 会话搜索 / F2 @引用文件 / F3 通知推送）

一期壳之上的三个增量，全部采纳推荐方案：

- **F1 会话搜索** — 侧栏「空间 (N)」头下方加搜索框；输入时跨**所有工作区**按会话标题实时过滤，扁平展示（标题 + 所属工作区小字 + 相对时间），清空恢复树状分组。纯前端、零外部依赖。
- **F2 @引用文件** — 走**路径引用**（非内容注入）：composer 输入 `@` 触发文件建议下拉（基于当前工作区）；后端新增 `GET /api/files`（受工作区根约束的安全递归列举，跳过 `.git`/`node_modules`/`.next` 等大目录，限深度 10 / 遍历预算 6000 / 返回 60 条）；选中注入路径 chip，发送时把引用路径作为结构化前缀（`用户引用了以下文件：\n- <path>`）拼入 user 消息，LLM/工具据此自行读取——既不膨胀上下文也能引用大文件。`chat-store` 新增 `references`/`addReference`/`removeReference`/`send`（发送前拼前缀并清空引用）。
- **F3 通知推送** — 会话出现 pending 批准请求时：若已授权则弹**浏览器桌面通知**（`Notification` API，首次发送时在用户手势内 `requestPermission`），否则降级**页面内 toast**（5s 自动消失）。客户端监听 `pending` 变化触发。

> **Implementation — complete（2026-08-20）**：`sidebar.tsx`（搜索框 + `SearchRow` 扁平结果）、`chat-ui.tsx`（自管理 textarea composer，`@` 检测 + 建议下拉 + 引用 chip + 发送走 `store.send`；`pending` 监听触发桌面通知/toast）、`/api/files/route.ts` 新增、`chat-store.ts` 加 `references`/`send`。`tsc` 全绿；`/api/files` E2E 验证过滤与跳过大目录正确。

## composer 右下角：模型 + 思考等级 + 环形用量（confirmed — 2026-08-20，via /grill-with-docs 3 轮）

合并 chip（模型名 + 思考等级）+ 独立环形用量（参考 DSH GUI 形态）。决策：chip/环形/权限胶囊三者分离（权限不动）；思考等级四档 `off/low/medium/high`（Q2=b）、真实接线到请求参数（Q3=a/Q12 协议映射）、持久化「全局 `lastUsedLevel`（默认 medium）+ 会话 `reasoning/set` 覆盖」（Q4=a+b/Q11/Q17）；环形 = 上下文占用（估算），用量面板另显会话累计真实 token（Q14=c/Q20）；思考内容上屏为默认折叠「思考过程」块并随消息持久化（Q13=b/Q18/Q19）。术语见「推理等级 / 思考过程块 / composer 右下角」条目。

> **Implementation — complete（待 verify）**：core `config.ts`（`ReasoningLevel`/`REASONING_LEVELS`/`DEFAULT_REASONING_LEVEL`/`lastUsedLevel`/`resolveLlmConfig.reasoningLevel`）、`stream-loop.ts`（`reasoningProviderOptions` + `providerOptions` 注入 + `sendReasoning:true` + assistant 消息追加 reasoning part）、`index.ts` 导出；web server（`saveLastUsedLevel`/`sessionReasoningLevel`/`reasoning` session action/`getProviders.lastUsedLevel`）、路由（新增 `/api/config/last-used-level`；`/api/chat`、`/api/chat/approve` 传 protocol+reasoningLevel + 新会话 pre-chosen；`/api/config` 返回 reasoningLevel；`/api/session` GET 返 reasoning）；client（`chat-store` 加 `reasoning`/`setReasoning`/`globalReasoning`/`usage`/`onReasoningPart`/`onFinishMessagePart` 累计）、`chat-ui`（`ModelChip`/`UsageRing`/`UsageDetailPanel`/`ThinkingBlock`）、`settings-modal`（推理等级全局默认行）。

## Flat system prompt / bundle / mode / app (confirmed — 2026-08-21, via /grill-with-docs 8 轮; ADR-0015)

> 术语见上文「Flat system prompt / bundle / mode / app (glossary)」条目。**设计（ADR-0015）+ 实现均已完成。**

- **目标** — applepi/harness 核心（+ packages），apps 为应用层。
- **无分块扁平提示词** — 取消三个块栈 `prompt/base|permission|skills`（ADR-0010）与洋葱中间件；单一扁平缓冲区 = `bundle 片段 → app 接口片段 → plugin 尾部片段` 三层顺序拼接（下层不可改写上层）。`system_prompt` 由 spec 驱动一次性拼装：app 建会话时选 bundle → `{ prompt, tools }` → 叠加接口片段与插件 → 交给 `llm`。重建 = 重新读同一份 spec。
- **无特权打包** — permission **声明段**进 bundle（base/standard **共用同一**装配期 `permissionFragment`（deepen #01），由实际注册工具实时生成——不再各自手写、不再声称未接线能力；deepen #01 前为 base/standard **各自声明**）；security **强制机制**（级别模型/ctx 注入/工具自决）仍留 core、作为工具执行缝上的 adapter，不写提示词文案。
- **Bundle/Mode/App** — `base`（仅 bash+sre 两工具 + 极简提示词）= `standard`（自包含全集，**不继承 base**，人格收敛为 minimal（同串，deepen #01））是兄弟 bundle；`mode` = 被 app 托管的 bundle（base/standard 既是 bundle 也是 mode）；`web`/`tui` 是 **app**（接口，不是 bundle/mode），tui 只设计不实现；接口轴 × 能力轴正交。**无 `extends`**。
- **插件只是追加** — 外部插件 = 追加型能力：尾部追加 prompt 片段 + 注册新工具/技能，不可重排/删除 base/standard 内部；沿用 extensions 目录 loader，跑在当前 bundle 之后。
- **core 拆分为深模块** — `llm`(仅提示词+工具→一段流式响应) / `loop`(多回合+暂停/批准/恢复) / `session`(jsonl+resume+最简追加生命周期事件原语) / `config` / `security`(工具执行缝) / `trace` + 薄 `Harness` 壳。**从 core 移除**：`registerExtension`/`SetupFn`/`HarnessApi`/`OnionBus`/`HookStack`/洋葱中间件/`emit` 事件总线/`system_prompt` 事件族。`registerExtension` 仅作为 app 层插件加载器与 bundle 生产者形态残存。
- **模式选择** — 仅在新建会话时选（web 新对话下拉），非热切换、非 `mode/set` 事件；记入 `session.config.mode`（构建期、会话内不可变），恢复时按它重建 spec。
- **打包** — 新建 `packages/bundle`（`base`/`standard` 纯声明 `(env)=>{prompt,tools}`）；`packages/extensions` 保留参考工具实现；`packages/core` 变为模块集；`apps/*` 为应用。
- **supersedes** — ADR-0015 推翻 ADR-0008/0010；重划 ADR-0009（声明段→bundle）；reframe ADR-0005（`baseExtension`→`base` bundle）。

> **Confirmed — 2026-08-21（Q1–Q8 全部敲定，ADR-0015 记录；本阶段不实现）。**
>
> **Implementation — complete（2026-08-21）**：core 移除洋葱/扩展机制（`bus.ts`/`OnionBus`/`registerExtension`/`HarnessApi`/`emit`/`system_prompt` 事件族/`PromptBag`/`buildSystemPrompt`/`attachSession` 中间件全删；`index.ts` 导出同步），`llm` 深模块去洋葱、`loop`/`stream-loop` 直接走 `harness.executeTool`（工具执行缝）；`security.ts` 去 `install`/`buildPermissionSection`（声明段→bundle），`SecurityPolicy` 只留 restore，新增 `applyPermissionLevel`，core 壳自注册 `/level`；`packages/bundle` 完成（`base`/`standard` 权限声明段按级别分档 + `enableBundleSpec`/`assembleFlatPrompt`/`bundleEnv` 装配助手）；`packages/extensions` 工厂改 capability 形态（`createMemory`/`createSkills` -> `{id,prompt,tools}` + `getCapability`），`base.ts`/`baseExtension` 删除；agent 重写（`--mode base|standard` 默认 standard、扁平提示词每轮重读 spec、`plugins.ts` 插件加载器、`hello.ext.ts` 改插件形态、memory/skills.ext.ts 删除、六个 check 重写、`check-soft-isolation` 随洋葱删除）；web 重写（每 (workspace, mode) 缓存 Harness + `sessionMode`/`session.config.mode` + `mode` 事件行构建期记录 + 扁平提示词 `buildSystemPrompt` + level action 走 `applyPermissionLevel` + 新会话 mode 下拉）。**`session.config.mode` 持久化取舍**：为支持恢复时重建 spec，mode 在建会话时写一次 `mode` 事件行（非热切换 `mode/set`；ADR-0016 设计将把会话身份迁入 `<id>.config.json>`，届时替换）。全仓 `pnpm -r verify` 绿（core 17/8/8 + extensions 25 + bundle 5 + 六个 agent check）。
> **后续（2026-08-21，web-only）**：CLI（`apps/agent`）与非流式 `loop.ts`/`runLoop` 已删除——web 成为唯一接口。移除 `Llm.generate`/`LlmGenerateOpts`/`LlmCall`、`Harness.run`/`RunOpts`、六个 check-*.ts 与插件加载器；core 只保留流式 `runLoopStreamSegment`；`verify` = build + 各包测试。见 to-tickets `remove-cli-loop`（01 删 CLI → 02 删 runLoop → 03 文档 web-only）。

## 共享运行时服务端 / 接入端 (glossary — confirmed, via /grill-with-docs, 2026-08-22, 3 轮; ADR-0017)

- **服务端（Server）** — 独立的共享运行时进程（新包 `packages/server`）：持有每 (workspace, mode) 一个 Harness 的缓存、会话/工作区/配置操作与全部 agent API（现 web 路由与 `apps/web/lib/server.ts` 整体迁入）。Hono，固定 localhost 端口（默认 3210），只绑 `127.0.0.1`；无鉴权（与现状同信任模型）。
- **接入端（Client / interface）** — web 与 tui：接入服务端的界面。**先启动者拉起服务端（spawn detached），后启动者凭固定端口探测（`/api/health`）直接 attach**，不重复启动运行时。
- **TUI（终端界面，设计中）** — 模拟 Claude Code 的终端接入端（Ink 5）：多行输入、`/` 命令、内联工具批准（含 ask_user 文本回答）、流式渲染。会话/工作区语义沿用 core。
- **Web（web 壳，设计中）** — 保留 Next.js 只做页面壳：agent API 路由移入服务端，客户端请求指服务端端口。
- **心跳租约（heartbeat lease）** — 服务端生命周期：对已接入客户端心跳计数，无客户端超时（5 分钟）自动退出；SIGINT 立即退。
- **attach = hydrate** — 接入端打开会话即全量刷新（`GET /api/session`），v1 无跨端实时互推；同一会话双端并发由用户自担。
- **线协议不变（R2Q1）** — 流式段响应保持 AI SDK data-stream 线格式（`0:`/`2:`/`9:`/`d:`），web 客户端零改动，TUI 自写同格式解析器；Ctrl-C/断开 = fetch abort → 服务端中止当前段，v1 无中断恢复。
- **TUI 工作区 = 启动 cwd（R2Q2）** — 自动注册进 manifest；`/new` `/resume` `/sessions` 均作用于该工作区；v1 无工作区选择 UI。
- **TUI 命令面（R2Q3）** — core 六内置（`/new standard|base` 缺省 standard、`/resume <id>`、`/sessions`、`/config`、`/level`、`/help`）+ `/exit`；web 专属操作（置顶/重命名/归档/搜索）v1 为零，列表只读展示标题。
- **TUI 键位（R2Q4）** — Enter 发送、Shift+Enter 换行、空输入不发。
- **编排脚本（R2Q5）** — `pnpm serve`（只起服务端）/ `pnpm dev`（web 壳，自动 ensure server）/ `pnpm tui`（自动 ensure server）；`APPLEPI_PORT` 覆盖默认 3210。「探测→拉起→attach」是共享小函数。
- **服务端测试缝（R2Q6）** — 请求级 `fetch(app.request)`（Hono，真 HTTP 环）+ `streamTextCall` 注入缝（假 LLM，与 core 同风格）；TUI 协议解析/命令映射抽纯函数单测，Ink 组件不单测。
- **Web 壳代理（R3Q1）** — Next `rewrites()` 代理 `/api/*` → 127.0.0.1:3210，浏览器保持同源、CORS 不开、前端代码零改动。
- **拉起与日志（R3Q2）** — spawn detached 跑包内 dist 入口；日志 `~/.applepi/server.log`；撞端口（并发同时拉起）EADDRINUSE 后自愈：探测重试一次即接入。
- **TUI v1 范围（R3Q3）** — 核心会话体验：流式对话、行内批准（y/n）、ask_user 文本回答、六 slash、cwd 工作区、Ctrl-C 中断；无 diff 视图/多窗格/会话管理面板。
- **ADR-0017（R3Q4）** — 记录「web 唯一界面 + 内嵌后端」翻转为「独立共享服务端 + web/tui 双接入端」；tui 由 design-only 升格为实现中。
