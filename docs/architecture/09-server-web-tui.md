# 9. 界面与共享运行时服务端（ADR-0017）

> [08 会话持久化 ←](08-session-persistence.md) · [索引](../architecture.md) · [10 LLM 配置 →](10-llm-config.md)

**ADR-0017（2026-08-22 起）**：agent
运行时后端不再内嵌于任何界面——独立的**共享运行时服务端**（`packages/server`，
Hono，默认 `127.0.0.1:3210`，只绑 lo、无鉴权）持有全部 harness 缓存与 agent API；
`web` 与 `tui` 都是**接入端**。启动顺序统一为「探测（`GET /api/health`）→ 拉起
（spawn detached，日志 `~/.applepi/server.log`）→ attach」：先启动者拉起服务端，
后启动者直接 attach（同一端口，`APPLEPI_PORT` 可覆盖）；生命周期 = **心跳租约**
（`POST /api/heartbeat` 续命，无客户端超时默认 5 分钟自退，`APPLEPI_IDLE_TIMEOUT_MS`
可调，0=禁用；SIGINT 立即退）。线协议保持 AI SDK data-stream 不变。

- **Web 壳（`apps/web`，`@applepi/web`）** — 保留 Next.js 只做**页面壳**（3010）：
  agent API 全部迁入服务端，`next.config` `rewrites()` 代理 `/api/*` → 3210（浏览器
  同源、零 CORS、前端代码零改动）；`pnpm dev` 先 ensure server 再起页面。
- **TUI（`apps/tui`，`@applepi/tui`）** — Ink 7 终端界面（Claude Code 风格）：
  底部输入（Enter 发送 / Shift+Enter 换行）、流式渲染（自写 data-stream 解析器）、
  行内工具批准（y/n）与 ask_user 文本回答（approve-with-payload）、六内置 slash 命令
  （`/new [base|standard]` `/resume <id>` `/sessions` `/config` `/level` `/help`
  `/exit`）、Ctrl-C 中断当前段 / 空闲退出；工作区 = 启动 cwd（自动注册 manifest）。
  协议解析器与命令映射为纯函数（单测），Ink 组件不单测（R2Q6）。非 TTY 优雅降级。
- **服务端（`packages/server`）** — 全部 agent API：`/api/chat`（流式段 +
  `ChatSeam` 测试注入缝）、`/api/chat/approve`（暂停/恢复 + approve-with-payload）、
  `/api/session`、`/api/workspaces`、`/api/files`、`/api/config*`、`/api/pick-folder`、
  `/api/health`、`/api/heartbeat`。

## 9.1 流式 loop（streaming loop, ADR-0011）

core 的 `runLoopStreamSegment`：`streamText` 变体，token 级分段流 + **暂停/恢复
状态机**。web 分段流，遇到需批准的 `ask` 工具暂停、批准后从 jsonl 持久化的暂停点续跑
（**不重跑 LLM**，jsonl 即 loop 状态，见 P13）。

## 9.2 工具批准（tool approval, ADR-0011）

web 会话对工具执行采用**前端批准**：

- `ToolSpec.approval`（`auto` / `ask` / 按参数函数，缺省 `ask`）分类；
- `ask` 工具暂停——其 `tool_call` 开放区间即待审批状态（ADR-0018，无专门事件）；
  `POST /api/chat/approve` 扫描未闭合区间校验后从暂停点续跑；
- 读类（`memory_read` / `skill_load` / `view` / bash 只读命令）自动执行，写/执行类须批准；
- **拒绝 = 工具结果回填模型**（模型可自愈）。

## 9.3 工作区选择器与会话动作

- 页面可选择已有工作区或手动添加（`GET|POST /api/workspaces`，manifest 记录
  slug↔path；历史 CLI 建的 workspace 经 `unslugWorkspace` 反解回填真实路径，避免 slug
  被 `path.resolve` 污染 cwd）；
- `session.config.workspace` 决定工具 cwd 与 project root（`workspaceRoot(ctx)`）；
  切换后 resume 该工作区最近会话（无则新建）；
- **mode（ADR-0015 + ADR-0016）**：会话按 mode（base/standard）缓存独立 Harness
  （工具集不可变）；新会话把 `mode` 作为构建期身份写一次 `<id>.config.json>`
  （`bindSession` → `saveConfig({ workspace, mode })`）；
  恢复走 `sessionMode` / `Harness.resume` 读 config 文件重建匹配 spec；
- 会话动作 API（`PATCH /api/session`）：rename / pin / unpin / archive / unarchive /
  notify / level / reasoning / model；`GET /api/session?format=jsonl` 导出；
  rename/pin/unpin/notify 写旁挂 `<id>.meta.json`（ADR-0018，last-wins，
  jsonl 只留消息 + 过程事件）；级别切换走
  core `applyPermissionLevel`（写 `session.config.permissionLevel` 覆盖到
  `<id>.config.json>`，ADR-0016；扁平提示词下一轮自带上新级别，无重建），
  与 core `/level` 同语义；reasoning/model 同样写会话覆盖。

## 9.4 可观测性（Langfuse trace, ADR-0012）

埋点位于 **core 层**（`trace.ts`）：每轮一条 trace + 每条 LLM 调用一个 generation
（带 token usage）+ 每工具一个 span；**web 与 TUI 自动受益**，目标 **Langfuse
Cloud**（`~/.applepi/.env` 的 `LANGFUSE_BASE_URL` / `PUBLIC_KEY` / `SECRET_KEY`），
未配置则为 no-op（见 P14）。

## 9.5 Web UI 壳（base 风格复刻）

复刻 assistant-ui playground base 壳视觉：外层灰底圆角白卡两栏（移动端抽屉）；
侧栏 = 品牌 + 新对话 +「空间(N)」+ 按工作区分组的会话树（folder+⌄折叠、5 条 +
查看更多、活跃高亮、hover 三件套）；composer 大圆角框 + 框下胶囊行（工作区胶囊仅
空态新会话出现、权限胶囊常驻）；会话/工具/批准卡片统一 base 审美。视觉 faithfully
跟随、产品 delta 显式记录（见 P15 与 CONTEXT.md「Web UI shell」段）。

## 9.6 二期增量（会话搜索 / @引用文件 / 通知推送）

一期壳之上的三个增量（2026-08-20）：

- **会话搜索**：侧栏「空间(N)」头下搜索框，跨工作区按标题实时过滤，扁平展示（标题 + 所属工作区 + 时间），清空恢复树。纯前端、零依赖。
- **@引用文件（路径引用）**：`GET /api/files`（受工作区根约束的安全递归列举，跳过 `.git`/`node_modules`/`.next` 等大目录，限深度 10 / 遍历预算 6000 / 返回 60 条）支持 `@` 触发路径输入 + 建议；选中注入路径 chip，发送时把引用路径作为结构化前缀（`用户引用了以下文件：\n- <path>`）拼入 user 消息，LLM/工具据此读取——走路径引用而非内容注入，避免上下文膨胀。`chat-store` 新增 `references`/`addReference`/`removeReference`/`send`（发送前拼前缀并清空引用）。
- **通知推送**：会话出现 pending 批准时，已授权弹浏览器桌面通知（`Notification` API，首次发送时在用户手势内 `requestPermission`），否则降级页面内 toast（5s 自动消失）。客户端监听 `pending` 变化触发。

> 见 CONTEXT.md「Web 二期」段与 `apps/web`（`sidebar.tsx` / `chat-ui.tsx` / `chat-store.ts` / `app/api/files/route.ts`）。

## 9.7 纯展示逻辑（deepen #04）

组件只做渲染，纯逻辑与标签常量集中在 `apps/web/lib/display.ts`（无 React
运行时依赖，可用 plain node 单测）：`estimateUsage` / `contextLimit` /
`formatTokens` / `textOf`（含共享 `toText` 转发）与 `LEVEL_META` /
`REASONING_META` / `MODES` 标签常量。`contextLimit` 与模型配置就近摆放；
`chat-ui` / `composer-footer` / `settings-modal` / `sidebar` 只引用常量与渲染。