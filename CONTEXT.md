# CONTEXT.md

Project: a minimal **single-machine agent harness**, organized as a **pnpm workspace** (decided via /grill-with-docs, 2026-08-19; reverses the 4f15860 single-package flatten). Core is a **pure runtime skeleton with no tools** (ADR-0005).

## Glossary

- **Harness** — the minimal runtime: onion event bus + loader + built-in agent loop + session store + LLM-config resolution. **Contains no tools** (ADR-0005); all capabilities arrive as extensions.
- **Extension** — an in-process module that injects capabilities (tools, skills, memory) at runtime via `setup(api)`.
- **Hook / middleware** — lifecycle interceptors on the onion stacks: `session`, `llm`, `tool`, and `system_prompt` (ADR-0008). Can observe, veto (skip `next()`), or rewrite `ctx`.
- **Tool** — a capability registered via `api.registerTool({ name, description, parameters (zod), execute })`.
- **Reference tool** — a concrete tool shipped by the `@applepi/extensions` package as a replaceable reference implementation (not core): `bash` and `str_replace_editor`.
- **Security extension** — the permission-level system (ADR-0007), shipped by `@applepi/extensions` as `createPermissionExtension` (middleware + tool cropper + prompt section + `/level`) plus the embedded **denylist floor** (`DENY`, the old `denylistMiddleware`). Its "outermost" property is a **registration convention**: mount at priority 1000 (as `baseExtension` does) so the onion exit phase audits the final command after inner rewrites. See ADR-0005 (Q3=A) + ADR-0007.
- **baseExtension** — a single `SetupFn` from `@applepi/extensions` that registers the reference tools and mounts `denylistMiddleware` outermost (priority 1000); one call reproduces the default capability set.

## Session persistence (glossary — decided via /grill-with-docs)

- **Session** — a persistent conversation bound to a `session_id`; recorded append-only to a jsonl file. The CLI runs a REPL; **resume & session-listing are core capabilities**, so a future web UI reuses the same core (CLI is just one interface).
- **Session id** — uuid (v4) generated per session, printed at start, reused to resume.
- **Workspace** — slug of the process cwd absolute path; the directory tier under `~/.applepi/sessions/<workspace>/`.
- **SessionStore** — a **core-owned** class managing the append-only jsonl for a workspace: `create`, `appendEvent`, `appendMessage`, `load` (replay → LLM message array), `list` (for `/sessions`). Lives in the **core package** (`packages/core`), not the agent, so any UI can drive it.
- **Session store file** — single append-only jsonl at `~/.applepi/sessions/<workspace>/<session_id>.jsonl`. Each line is either an **event line** (`kind:"event"`) or a **message line** (`kind:"message"`); session/workspace identity lives in the file path, not in the lines (ADR-0006).
- **Event** — `kind:"event"` line recording a lifecycle span in the merged `event` field with embedded phase, e.g. `system_prompt/start` / `system_prompt/end`, `skill/start` / `skill/end`, `reload/start` / `reload/end`. (No `tool_subagent` — out of scope, Q1; `mcp` removed with the mcp feature, Q11; `type`+`phase` merged into `event`, ADR-0006.)
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
- `packages/extensions` (`@applepi/extensions`) — reference extensions: reference tools (bash / str_replace_editor) + security extension (permission levels incl. denylist floor, ADR-0007) + `baseExtension` + memory / skills (mcp removed, Q11)
- `apps/agent` (`@applepi/agent`) — the local agent: `main.ts` wires core + extensions + a provider and runs the REPL; `extensions/` holds local `*.ext.ts`; `scripts/` holds the key-free verification checks

Dependency graph (one direction): `@applepi/agent → @applepi/extensions → @applepi/core`. Cross-package imports use **package names** resolved to `dist/` via each package's `exports` (Q3=a); dev/test run **build-first** (Q4=a); each package has its own `tsconfig.json` extending a shared base (Q5=a); the root `package.json` orchestrates `build`/`dev`/`test`/`verify` (Q6=a).

Architecture decisions are recorded as ADR-0001 (harness), ADR-0002 (session persistence: jsonl + resume + reload), ADR-0003 (workspace split), ADR-0004 (LLM config sources), ADR-0005 (reference tools + denylist → `baseExtension`), ADR-0006 (event schema slimming), ADR-0007 (permission levels: read/write scoped tool access), and ADR-0008 (system prompt built on the `system_prompt` onion stack).

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

- **提示词改造（Q9）** — 权限扩展贡献一段固定结构的「权限声明」段落（级别名 + 该级别允许/禁止行为 + project root 路径 + 按级别裁剪后的可用工具清单）；注入时机 = 会话启动/恢复/`/level` 切换后**立即重建**系统提示词（走 `emitSystemPrompt` 流程 append 新 system 消息行，ADR-0002 replay 语义：最新 system 替换 message[0]）。模型每轮「看到」权限边界，而非靠撞拦截才知道。
- **双层机制（Q10=c）** — 主路径是**注册面裁剪**：`buildToolDefs()` 按级别裁剪暴露给模型的工具与参数 schema（readonly 下 `bash` 只暴露只读白名单命令说明、`str_replace_editor` 参数枚举裁成 `['view']`），模型看不到不允许的东西；兜底是**运行时拦截**：权限中间件仍挂 priority 1000 审计最终执行（防裁剪漏洞/内层改写）。core 的 `buildToolDefs` 保持极简，只提供通用 `registerToolFilter` 钩子，不含权限语义（P1/P2）。
- **级别事件与恢复（Q11=a）** — `level/set` 事件格式：`{"kind":"event","event":"level/set","payload":{"level":"workspace"},"ts":"..."}`（沿用 ADR-0006 行结构，无 start/end 相位，原子事件）。`SessionStore` 新增 `lastEvent(name): SessionEvent | null`（扫文件取最后一个匹配事件）；恢复逻辑：`/resume` 与启动时 `const ev = await store.lastEvent('level/set'); level = ev?.payload?.level ?? 'workspace'`，写入 `session.scratch['__permissionLevel']`。存储读取原语归 core（P6），语义解析归权限扩展。
- **实现拆分（Q12）** — `packages/extensions/denylist.ts` **保留**（危险正则列表 + `denylistMiddleware` 原样导出，`check-denylist.ts` 继续用），成为权限系统的**内部底线组件**；新增 `packages/extensions/permission.ts`：导出 `permissionMiddleware`（先跑 denylist 底线、再按 `session.scratch['__permissionLevel']` 级别判定）、`createPermissionExtension()`（SetupFn：挂中间件 priority 1000 + 注册 `registerToolFilter` 裁剪器 + 注册权限声明段落 + `/level` 语义实现）。`baseExtension` 改挂 `permissionMiddleware` + `createPermissionExtension()`；新增 `apps/agent/scripts/check-permission.ts`。（注：权限声明段落最初记为 "注册权限声明 contributor"，ADR-0008 后改为挂 `system_prompt` 栈中间件，本行保留当时表述。）

## Permission levels (designing — via /grill-with-docs, round 4)

- **Slash 命令归属（Q13=a）** — core 增加通用扩展点 `HarnessApi.registerSlashCommand(name, handler)`（一个 map + 查询方法）；`/level` 由 permission 扩展注册，main.ts 的 switch 改为「先查扩展注册命令、再查内置命令」。纯机制、无权限语义（P1/P2），slash 语义归核心（P6，未来 web UI 复用）。
- **Tool filter 签名（Q14=b）** — `type ToolFilter = (toolName: string, def: { description; parameters }) => { description; parameters } | null`；null = 不暴露，返回新 def = 改写（readonly 下把 `str_replace_editor` schema 裁成只有 `view`）。filter 按注册顺序串联，任一 filter 返回 null 即不可复活。`buildToolDefs()` 遍历工具时依次应用所有 filter。
- **边界收尾（Q15）** — 权限级别**只约束工具行为 + 权限声明段落**；其他系统提示词段落（skills 注入、base）不受级别影响。`memory_write`/`skill_load` 按**工具名分类**为写/读（memory_write 目标文件是扩展固定的 `harness-memory.json`，在 project root 内，workspace 放行、readonly 拦、fullaccess 放行；skill_load 算读，全级别放行）。
- **验证与文档（Q16）** — check-permission.ts 验证 5 条：默认 workspace + 提示词声明、readonly 拦截（write/白名单外 bash）、workspace 路径前缀（root 内放行、/tmp 拦）、fullaccess 放行但 denylist 底线仍拦、`/level` 切换后事件写入 + 提示词重建 + lastEvent 恢复。ADR-0007 记录全部决策。
