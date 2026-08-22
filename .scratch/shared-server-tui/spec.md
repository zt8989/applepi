# Spec: 共享运行时服务端 + Web/TUI 双接入端（ADR-0017）

> 来源：/grill-with-docs 3 轮（2026-08-22），Q1–Q5 / R2Q1–R2Q6 / R3Q1–R3Q4 全部敲定，ADR-0017 记录。
> 状态：**ready-for-agent**（票 01 server 抽取 + web 壳改造、票 02 TUI v1、票 03 生命周期精化）。
> 测试缝：服务端 = 请求级 `fetch(app.request)` + `streamTextCall` 注入缝；TUI = 纯函数（协议解析/命令映射）单测，Ink 组件不单测。

## Problem Statement

终端第二界面缺失 + 运行时重复。`tui` 自 ADR-0015 起 design-only；web 是唯一接入端且后端（harness 缓存 + 全部 agent API）内嵌在 Next.js 进程里。若直接实现 TUI，必然出现「每界面一套后端」——两个进程争抢 `~/.applepi` 状态。需求：一个共享运行时进程（服务端），web 与 TUI 都是接入端；先启动者拉起服务端，后启动者 attach，不复制后端。

## Solution

- **服务端（server）**：新包 `packages/server`，Hono，固定 localhost 端口（默认 3210）绑 127.0.0.1，无鉴权。持有每 (workspace, mode) harness 缓存 + 会话/工作区/配置操作 + 全部 agent API（现 web 路由与 `lib/server.ts` 整体迁入，搬移优先、重构后置）。
- **接入（attach）**：共享小函数「探测（`/api/health`）→ 拉起（spawn detached，日志 `~/.applepi/server.log`）→ attach」；撞端口 EADDRINUSE 自愈（探测重试）；`APPLEPI_PORT` 覆盖。
- **Web 壳**：保留 Next.js 只做页面，删后端与 API 路由，`next.config` `rewrites()` 代理 `/api/*` → 服务端；浏览器同源、CORS 不开、前端代码零改动。
- **TUI v1**：`apps/tui`，Ink 5；工作区 = 启动 cwd（注册 manifest）；六内置 slash + `/exit`；Enter 发送 / Shift+Enter 换行；行内批准（y/n）+ ask_user 文本回答；Ctrl-C = fetch abort 中断当前段；线协议不变（自写 data-stream 解析器）。
- **生命周期**：心跳租约，无客户端 5 分钟自退、SIGINT 立即退。
- **并发语义**：attach = hydrate（`GET /api/session` 全量刷新），v1 无跨端实时互推。

## User Stories

1. 作为终端用户，我在项目目录运行 `applepi tui`，它能直接开始与当前目录的模型对话（Claude Code 风格），所以我不需要离开终端。
2. 作为终端用户，对话以流式逐 token 渲染，工具调用在行内展示，所以我能看到模型实时思考与执行过程。
3. 作为终端用户，工具要执行写类操作时终端行内询问 y/n，我批准后才执行，所以安全语义与 web 一致。
4. 作为终端用户，模型通过 ask_user 向我提问时，终端出现文本输入让我的回答作为工具结果回填，所以信息不足时我能直接供给答案。
5. 作为终端用户，我可用 `/new standard|base`、`/resume <id>`、`/sessions`、`/config`、`/level`、`/help`、`/exit` 完成会话全生命周期，所以核心操作不离开键盘。
6. 作为多界面用户，我先启动 TUI，再打开 web 页面——页面直接可用且与 TUI 共用同一运行时，所以不会出现两个后端互相踩状态。
7. 作为多界面用户，我先启动 web，再跑 TUI——TUI 同样直接 attach 已运行的服务端，所以「谁先启动谁拉起」完全对称。
8. 作为终端用户，我在流式生成中按 Ctrl-C，当前段立即中止且不留下半截状态，所以误触发送时可以及时打断。
9. 作为维护者，web 的对话/批准/会话/工作区行为在抽取后保持不变（全绿回归），所以重构不引入行为漂移。
10. 作为开发者，服务端路由可用 `fetch(app.request)` 在无浏览器、无真实模型的条件下做请求级测试（假 LLM 注入），所以回归验证快且稳定。
11. 作为终端用户，工作区 = 我启动 TUI 的目录，`/sessions` 列出该目录下的会话、`/resume` 继续，所以与 Claude Code「在当前目录干活」的心智一致。
12. 作为终端用户，TUI 退出后服务端不影响 web 继续使用；web 关闭后 TUI 单独挂着时服务端也不会立刻死（5 分钟心跳宽限），所以单一入口退出不至于误杀共享运行时。

## Implementation Decisions

- **包划分**：`packages/server` 依赖 `@applepi/core`/`@applepi/bundle`/`@applepi/extensions`；`apps/tui` 只依赖服务端 HTTP（+ 共享 attach 助手，建议放 `packages/server` 或独立 `packages/client`——实施 grill 定）；`apps/web` 仅页面壳。
- **路由迁移**：`/api/health`（新增）、`/api/chat`、`/api/chat/approve`、`/api/session`（GET/PATCH）、`/api/workspaces`、`/api/files`、`/api/config*`、`/api/pick-folder`——按现有语义迁移，线格式与请求/响应契约不变。
- **流式实现**：服务端继续用 `runLoopStreamSegment` + AI SDK data-stream 写；`streamTextCall` 注入缝供测试；`APPLEPI_PORT` 环境变量。
- **TUI 结构**：入口 `pnpm tui` → ensure server → attach；Ink 组件（输入区/消息流/批准行）；纯函数模块（data-stream 行解析、slash 命令路由、cwd→manifest 注册）。
- **脚本**：`pnpm serve` / `pnpm dev`（web） / `pnpm tui`。
- **v1 明确不做**：diff 视图、多窗格、会话管理面板、工作区选择 UI、跨端实时互推、中断恢复。

## Testing Decisions

- 服务端：请求级测试（`fetch(app.request)`，Hono 真 HTTP 环）；假 LLM = `streamTextCall` 注入（先例：core stream-loop.mjs）；关键回归 = web 对话/批准/会话侧栏经代理走服务端后行为不变（手工 E2E + 现有 web 测试）。
- TUI：data-stream 解析器与 slash 命令映射为纯函数（Node assert 单测，先例：web display.test.ts）；Ink 组件不单测（R2Q6）。
- 端到端：`pnpm dev` 起页面 + `pnpm tui` 同跑，两个客户端 attach 同一服务端手工验证。

## Out of Scope

- 生产静态导出与同域托管（web 壳后续票）。CORS 配置（rewrites 代理后不需要）。
- TUI 的 Claude Code 高级特性（diff 视图等）。跨端实时互推。多机/多用户、鉴权。
- core/bundle/extensions 的任何改造。
- 服务端内部重构（搬移优先）——重构机会单独走 deepen。

## Further Notes

- 与 ADR 关系：实现 ADR-0017；该 ADR re-scope ADR-0015「web 唯一界面」措辞与 `remove-cli-loop` 后续（web-only）；tui 由 design-only 升格。
- 依赖图变化：`server → bundle/extensions/core`；`web → server`（HTTP）；`tui → server`（HTTP）+ attach 助手。
- 实施阶段建议先 01（web 行为不变全绿）→ 02（TUI 闭环）→ 03（租约精化，可并入 02 收尾）。