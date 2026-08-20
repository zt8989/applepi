# CONTEXT.md

Project: a minimal **single-machine agent harness**, organized as a **pnpm workspace** (decided via /grill-with-docs, 2026-08-19; reverses the 4f15860 single-package flatten). Core is a **pure runtime skeleton with no tools** (ADR-0005).

## Glossary

- **Harness** — the minimal runtime: onion event bus + loader + built-in agent loop + session store + LLM-config resolution. **Contains no tools** (ADR-0005); all capabilities arrive as extensions.
- **Extension** — an in-process module that injects capabilities (tools, skills, memory) at runtime via `setup(api)`.
- **Hook / middleware** — lifecycle interceptors on the onion stacks: `session`, `llm`, `tool`, and `system_prompt` (ADR-0008). Can observe, veto (skip `next()`), or rewrite `ctx`.
- **Tool** — a capability registered via `api.registerTool({ name, description, parameters (zod), execute })`.
- **Reference tool** — a concrete tool shipped by the `@applepi/extensions` package as a replaceable reference implementation (not core): `bash` and `str_replace_editor`.
- **SecurityPolicy（安全策略）** — core 内置的安全机制（ADR-0009）：接口 + 默认实现。默认实现含三值级别模型（readonly/workspace/fullaccess）、`level/set` 事件 + lastEvent 恢复、提示词「Permission Level」段落、`/level`。**无运行时拦截中间件**（permissionMiddleware 已删，Q12=a）——「闸口」退化为 level 上下文保证：每个工具 execute 的 ctx 都带当前级别。可被消费者显式替换（替换即自负责）。取代旧的 **Security extension**（ADR-0007 的 `createPermissionExtension`，已随 ADR-0009 删除）。
- **baseExtension** — a single `SetupFn` from `@applepi/extensions` that registers the reference tools (`bash`, `str_replace_editor`) + memory/skills. No security wiring since ADR-0009 — security is a core mechanism, not an extension.

## Session persistence (glossary — decided via /grill-with-docs)

- **Session** — a persistent conversation bound to a `session_id`; recorded append-only to a jsonl file. The CLI runs a REPL; **resume & session-listing are core capabilities**, so a future web UI reuses the same core (CLI is just one interface).
- **Session id** — uuid (v4) generated per session, printed at start, reused to resume.
- **Workspace** — slug of the process cwd absolute path; the directory tier under `~/.applepi/sessions/<workspace>/`. Web 端工作区**发现仅读 `~/.applepi/sessions/.manifest.json`**（slug↔path，由 `addWorkspace`/CLI 写入），不再扫描 sessions 目录子目录（避免 test 残留污染列表）；**显示名取路径最后一段（basename）**，而选择/激活/工具 cwd 仍以完整路径为 key（ADR-0013）。
- **SessionStore** — a **core-owned** class managing the append-only jsonl for a workspace: `create`, `appendEvent`, `appendMessage`, `load` (replay → LLM message array), `list` (for `/sessions`). Lives in the **core package** (`packages/core`), not the agent, so any UI can drive it.
- **Session store file** — single append-only jsonl at `~/.applepi/sessions/<workspace>/<session_id>.jsonl`. Each line is either an **event line** (`kind:"event"`) or a **message line** (`kind:"message"`); session/workspace identity lives in the file path, not in the lines (ADR-0006).
- **Event（事件）** — `kind:"event"` line recording a lifecycle span in the merged `event` field with embedded phase, e.g. `system_prompt/start` / `system_prompt/end`, `skill/start` / `skill/end`, `reload/start` / `reload/end`. (No `tool_subagent` — out of scope, Q1; `mcp` removed with the mcp feature, Q11; `type`+`phase` merged into `event`, ADR-0006.) **All events are published through the single `emit(event, payload)` entry** — `system_prompt` is handled in core (rebuild + persist), other events fall back to writing an event line; there are no per-event API methods (ADR-0008 amendment).
- **Message line** — `kind:"message"` line mirroring an LLM message (`role`: system|user|assistant|tool). The first system message is the system prompt.
- **Resume** — `/resume <id>` (core `SessionStore.load`) switches the active session to `<id>` and continues appending to its jsonl. `<id>` absent → new session.
- **Slash commands (core capability, not CLI-only)** — `/reload`, `/resume <id>`, `/new`, `/sessions` (list `~/.applepi/sessions/<workspace>/`), `/help`, `/exit`. A future web UI drives the same core methods.
- **REPL** — the CLI REPL reads one user turn per line (Enter submits); multi-line via `/paste` or shell heredoc. Ctrl-D / `/exit` quits.
- **Reload** — `/reload` slash command: full harness reset (new Harness, **preserving `session.scratch` + `session.history`**), re-register `baseExtension` (reference tools + security extension) + `loadExtensionsFromDir`, then rebuild the system prompt; emits a `reload` event.
- **System-prompt middleware（系统提示词中间件）** — extensions mount on the `system_prompt` onion stack via `api.use('system_prompt', mw)`; middleware push sections into `ctx.promptParts` (and their label into `ctx.sections`) on entry, and may rewrite the array (ADR-0008). The system prompt is assembled by `buildSystemPrompt()` from all sections (base + extensions). Replaces the old `addSystemPromptContributor` API (Q10=c, superseded by ADR-0008) and the `llm`-middleware skills injection before it. On reload the middleware are re-registered and the prompt rebuilt.
- **System prompt** — message[0]; composed of base instructions + extension sections (via the `system_prompt` stack, ADR-0008). Rebuilt at session start and on `/reload`.
- **Replay transform (read-only)** — to build the LLM message array, filter the jsonl to message lines only. If a `reload` event exists, the most-recently rebuilt system message replaces message[0]; the original jsonl is never mutated.
- **MCP** — **feature removed** (Q11). Previously `mcp_call` via `bash`+`mcp-cli`; deleted from core/extensions/agent/docs.

## LLM configuration (glossary — decided via /grill-with-docs)

- **LLM settings** — `~/.applepi/settings.json`, the **only** source of LLM config (process.env is no longer read, Q3=b). Schema (Q2=a): `{ provider, model, apiKey, baseURL? }` (`baseURL` overrides the API endpoint, forwarded to the SDK provider factory). Missing file → defaults (`openai` / `gpt-4o-mini`).
- **Secret file** — `~/.applepi/.env`, holds the real API keys. Parsed with the `dotenv` package (Q7=b).
- **Api key reference (placeholder)** — the `apiKey` value in settings.json is treated as a **key name** into the secret file: `realKey = dotenv[apiKey] ?? apiKey` (Q1=a). Default value = the provider's canonical env name (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`); a real key written directly also works.
- **/config** — slash command that re-reads settings.json + .env and rebuilds the model (Q5=c). `/reload` does **not** touch the provider.
- **Config resolution (core-owned)** — core provides the load/parse/resolve primitives (`loadSettings` / `loadDotenv` / `resolveApiKey`, or a one-shot `resolveLlmConfig`), the agent assembles the provider instance (Q4=a).

## Key decisions (locked)

Wiki: start at `docs/README.md` (architecture: `docs/architecture.md`; design principles: `docs/design-principles.md`). Pnpm workspace layout (three workspace packages, Q1=b/Q2=b):

- `packages/core` (`@applepi/core`) — the harness runtime (onion bus, loader, built-in loop, session store, config). **No tools** (ADR-0005).
- `packages/extensions` (`@applepi/extensions`) — reference extensions: reference tools (bash / str_replace_editor, each self-determining per level) + memory / skills + `baseExtension`. Security mechanism lives in **core** since ADR-0009 (was the security extension here, ADR-0007).
- `apps/agent` (`@applepi/agent`) — the local agent: `main.ts` wires core + extensions + a provider and runs the REPL; `extensions/` holds local `*.ext.ts`; `scripts/` holds the key-free verification checks

Dependency graph (one direction): `@applepi/agent → @applepi/extensions → @applepi/core`. Cross-package imports use **package names** resolved to `dist/` via each package's `exports` (Q3=a); dev/test run **build-first** (Q4=a); each package has its own `tsconfig.json` extending a shared base (Q5=a); the root `package.json` orchestrates `build`/`dev`/`test`/`verify` (Q6=a).

Architecture decisions are recorded as ADR-0001 (harness), ADR-0002 (session persistence: jsonl + resume + reload), ADR-0003 (workspace split), ADR-0004 (LLM config sources), ADR-0005 (reference tools + denylist → `baseExtension`), ADR-0006 (event schema slimming), ADR-0007 (permission levels: read/write scoped tool access), ADR-0008 (system prompt built on the `system_prompt` onion stack), ADR-0009 (security as tool self-determination: core-built SecurityPolicy + extension reload), and ADR-0010 (system prompt = PromptBag of three block stacks, supersedes ADR-0008); web decisions: ADR-0011 (web streaming loop + approval state machine), ADR-0012 (web stack + tracing), ADR-0013 (web workspace discovery: manifest-only + basename display).

## Permission levels (designing — via /grill-with-docs, round 1)

- **Permission level（权限级别）** — 会话级**单一主级别**，统一作用于所有工具（Q2=统一，不做按工具分级）。每个级别由「可读范围 × 可写范围（修改粒度）」两个维度构成（Q1=b，「修改级别」= 修改粒度维度，不是并列第四档）。
- **Level source（级别来源）** — 级别状态持久化在会话 jsonl 的 `level/set` 事件中；当前级别 = replay 时**最后一个** `level/set` 事件的 `payload.level`；无任何该事件时默认 `workspace`（Q3）。
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

- **Web Chat 界面（web chat interface）** — 继 CLI 之后的第二个 harness 界面：Next.js App Router（`apps/web`，`@applepi/web`，端口 3000）+ assistant-ui 0.15 primitives（ExternalStoreRuntime 适配器，Tailwind v4）+ Vercel AI SDK v4 数据流协议（`createDataStreamResponse` + `processDataStream`）。复用同一 core（Harness + runLoopStreamSegment + SessionStore），与 CLI 共享事件总线、安全策略、工具链。个人本地工具，无鉴权。
- **流式 loop（streaming loop）** — core 新增 `runLoopStreamSegment`（`streamText` 变体，token 级分段流 + 暂停/恢复状态机，ADR-0011）；CLI 的 `runLoop`（generateText）原样保留。
- **工具批准（tool approval）** — web 会话对工具执行采用**前端批准**：`ToolSpec.approval`（`auto`/`ask`/按参数函数，缺省 `ask`）分类；`ask` 工具暂停并持久化 `tool/approval-pending` 事件；`POST /api/chat/approve` 从暂停点续跑（**不重跑 LLM**，jsonl 即 loop 状态）。读类自动执行（memory_read / skill_load / view / bash 只读命令），写/执行类须批准；**拒绝 = 工具结果回填模型**（模型可自愈）。CLI 语义不变。
- **工作区选择器（workspace picker）** — 页面可**选择已有工作区或手动添加**（`GET|POST /api/workspaces`，manifest 记录 slug↔path）；`session.config.workspace` 决定工具 cwd 与 project root（`workspaceRoot(ctx)`）；切换后 resume 该工作区最近会话（无则新建），选择持久化 localStorage。`GET /api/session` 刷新恢复 + 重新浮出待批卡片。
- **Trace（可观测性追踪）** — 埋点位于 **core 层**（`trace.ts`：每轮一条 trace + 每条 LLM 调用一个 generation 带 token usage + 每工具一个 span），CLI 与 web 双端自动受益；目标 **Langfuse Cloud**（`~/.applepi/.env` 的 `LANGFUSE_BASE_URL` / `PUBLIC_KEY` / `SECRET_KEY`，ADR-0004 约定；未配置则为 no-op）。

> **Confirmed — 2026-08-20（Q1–Q13 全部敲定，ADR-0011 记录流式 loop + 批准状态机，ADR-0012 记录技术栈 + 埋点；round 2 将 Langfuse 从自建改为云端）。**
>
> **Implementation — complete（2026-08-20）**：core 新增 `stream-loop.ts`（`runLoopStreamSegment` / `executeApprovedTool` / `classifyApproval` / `pendingToolCalls`）、`trace.ts`（getTracer/flushTraces）、`ToolSpec.approval`、`workspaceRoot`（isInsideProjectRoot 支持 root 覆盖）；extensions 五工具加 approval 分类 + 跟随 workspace root；`apps/web`（assistant-ui + Tailwind v4 + 四个 API 路由 + 批准卡片 + 工作区选择器，ExternalStoreRuntime 适配器）；根脚本 `dev:web`。E2E 验证：分段流暂停 → 批准执行 → 续跑自动读工具 → 最终文本；拒绝回填模型自愈；会话水合；mismatch 守卫。全部 build / test / 检查通过。

## Web UI shell (confirmed — via /grill-with-docs, 2026-08-20; base-style redesign)

复刻 assistant-ui playground base 壳视觉（两栏、外层圆角白卡、极简线性图标、中性配色、克制圆角/阴影），并做产品化适配：

- **布局**：外层灰底 + 圆角白卡（桌面）两栏；移动端侧栏折叠为抽屉。
- **侧栏树**：品牌「applepi π」→ 新对话 → 「空间 (N)」汇总头 → 按工作区分组的会话树（folder + ⌄ 折叠，默认展开，每工作区 5 条 + 查看更多；活跃会话浅色高亮，hover 显示 bell/archive/⋯ 动作：重命名 / 置顶 / 导出 jsonl / 通知标志）。会话元数据：`title/set`（缺省取首条 user 消息截断 40 字）、`pin/set`、`notify/set` 事件；归档 = 移入 `.archive/` 子目录。
- **composer 脚部**：composer 大圆角框（输入 + `+`/mic/圆形发送）；框下独立一行胶囊 —— **工作区胶囊仅在首屏新会话空态出现**（选好工作区后归属该会话，不再显示）；**权限胶囊常驻**（只读/工作区/完全访问，改级别 = 写 `level/set` + 重建提示词，与 CLI `/level` 同语义；新会话首条消息可带预选级别）。
- **工作区下拉**：搜索 + 文件夹列表 + 「新建工作空间」（内联路径）+「打开本地文件夹」（**macOS 原生目录选择**：浏览器 showDirectoryPicker 拿不到绝对路径，改由服务端 osascript `choose folder` 返回真实路径；非 macOS 降级为路径输入）。
- 不做建议 chips（用户明确不需要）；placeholder「发送消息…（/ 调用技能或指令）」；主区标题 = 活跃会话标题 / 空态「新对话」。

> **Implementation — complete（2026-08-20）**：`apps/web` 重构（sidebar / workspace-dropdown / composer-footer / chat-ui / approval-tool 重画；icons 内联 SVG）；服务端新增 `/api/pick-folder`、`/api/session` GET 支持 `format=jsonl` 导出 + level/title 返回、PATCH（rename/pin/unpin/archive/unarchive/notify/level）；`/api/workspaces` 富化（每会话 title/ts/pinned/notify）；`/api/chat` 首条消息支持 `level`。E2E 验证：rename/pin/archive/unarchive/export/level 全部通过。构建 + verify 全绿。

## Web 二期（confirmed — 2026-08-20；F1 会话搜索 / F2 @引用文件 / F3 通知推送）

一期壳之上的三个增量，全部采纳推荐方案：

- **F1 会话搜索** — 侧栏「空间 (N)」头下方加搜索框；输入时跨**所有工作区**按会话标题实时过滤，扁平展示（标题 + 所属工作区小字 + 相对时间），清空恢复树状分组。纯前端、零外部依赖。
- **F2 @引用文件** — 走**路径引用**（非内容注入）：composer 输入 `@` 触发文件建议下拉（基于当前工作区）；后端新增 `GET /api/files`（受工作区根约束的安全递归列举，跳过 `.git`/`node_modules`/`.next` 等大目录，限深度 10 / 遍历预算 6000 / 返回 60 条）；选中注入路径 chip，发送时把引用路径作为结构化前缀（`用户引用了以下文件：\n- <path>`）拼入 user 消息，LLM/工具据此自行读取——既不膨胀上下文也能引用大文件。`chat-store` 新增 `references`/`addReference`/`removeReference`/`send`（发送前拼前缀并清空引用）。
- **F3 通知推送** — 会话出现 pending 批准请求时：若已授权则弹**浏览器桌面通知**（`Notification` API，首次发送时在用户手势内 `requestPermission`），否则降级**页面内 toast**（5s 自动消失）。客户端监听 `pending` 变化触发。

> **Implementation — complete（2026-08-20）**：`sidebar.tsx`（搜索框 + `SearchRow` 扁平结果）、`chat-ui.tsx`（自管理 textarea composer，`@` 检测 + 建议下拉 + 引用 chip + 发送走 `store.send`；`pending` 监听触发桌面通知/toast）、`/api/files/route.ts` 新增、`chat-store.ts` 加 `references`/`send`。`tsc` 全绿；`/api/files` E2E 验证过滤与跳过大目录正确。
