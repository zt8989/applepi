# 架构（Architecture）

> 状态：持续更新（初版 2026-08-18/19 经 `/grill-me` / `/grill-with-docs` 多轮访谈锁定；2026-08-20 纳入 web 双接口、流式 loop、工具批准、Langfuse 埋点，对应 ADR-0011 / ADR-0012；2026-08-21 纳入并实现 ADR-0015——core 深模块拆分 + 扁平 system_prompt + bundle/mode/app 重塑，见 [§1.6](architecture/01-overview.md#16-adr-0015-最终形态扁平-system_prompt--bundlemodeapp)；2026-08-22 纳入 deepen #01–#05 修订与 ADR-0016 双层配置同步；2026-08-22 纳入并实现 ADR-0017——共享运行时服务端 + web/tui 双接入端，见 [§9](architecture/09-server-web-tui.md)；2026-08-22 改为 **Wiki 导航式分块**：本页仅保留总览与导航，各章拆入 `docs/architecture/`）。
> 本页是系统设计的**导航入口**：全景图在下，各章按块阅读，细节与决策依据见各 ADR（ADR-0001 ~ ADR-0018）。

## 架构全景

```
┌──────────────────────────┐   ┌──────────────────────────┐
│ apps/web (@applepi/web)  │   │ apps/tui (@applepi/tui)   │
│ 页面壳（Next.js，3010）   │   │ 终端界面（Ink 7，Claude   │
│ 仅前端，/api/* 由        │   │ Code 风格）：流式、批准、   │
│ rewrites() 代理到服务端   │   │ slash 命令                  │
└────────────┬─────────────┘   └────────────┬──────────────┘
             │  HTTP（127.0.0.1:3210，相同  │
             │  /api/* 契约；先启动者拉起、 │
             │  后启动者 attach，心跳租约    │
┌────────────┴─────────────────────────────┴──────────────┐
│ packages/server (@applepi/server)  —— 共享运行时服务端    │
│ 每 (workspace, mode) Harness 缓存 · 扁平提示词组装 ·      │
│ 全部 agent API（chat/approve/session/workspaces/files/    │
│ config/pick-folder/heartbeat）                            │
└───────────────▲─────────────────────────────────────────┘
                │ 依赖：server → bundle（→extension/core）
┌───────────────┴─────────────────────────────────────────┐
│ packages/bundle  (@applepi/bundle)                       │
│ base / standard 能力包：纯声明 (env) => ({ prompt, tools }) │
│ + enableBundleSpec / assembleFlatPrompt（装配助手）       │
└───────────────▲─────────────────────────────────────────┘
┌───────────────┴─────────────────────────────────────────┐
│ packages/extension  (@applepi/extension)               │
│ 参考工具 bash / str_replace_editor + 能力工厂             │
│ memory/skills/todo/plan/goal/ask_user + 共享状态文件助手  │
└───────────────▲─────────────────────────────────────────┘
                │ 依赖：extension → core（单向）
┌───────────────┴─────────────────────────────────────────┐
│ packages/core  (@applepi/core)  —— 深模块 + 薄 Harness 壳 │
│ llm(stream) · loop · session · config ·                  │
│ security · trace                                         │
└─────────────────────────────────────────────────────────┘
```

依赖方向（ADR-0003，ADR-0015，ADR-0017）：`server → bundle → core` 与
`bundle → extension → core`；`web → server`、`tui → server`（均走 HTTP，客户端不
再直接依赖 core/bundle——web 页面壳仅前端，`/api/*` 由 `rewrites()` 代理到服务端
端口 3210）。能力集由**服务端**在运行时装配到 Harness 壳上（详见 [§3](architecture/03-capability-assembly.md)、[§9](architecture/09-server-web-tui.md)）。
跨包引用一律用包名（`@applepi/core` 等），解析到各包 `dist/`。

## 分块导航

| 分块 | 主题 | 要点 | 相关 ADR |
|---|---|---|---|
| [01 概览](architecture/01-overview.md) | 系统全貌：深模块 + Harness 壳、模块划分、ADR-0015 最终形态 | bundle/mode/app/plugin 四概念；扁平提示词三层；core 收敛清单 | 0015 |
| [02 核心运行时](architecture/02-core-runtime.md) | `@applepi/core` 七个深模块职责 | llm/loop/session/config/security/trace/Harness；「核心无工具」 | 0005, 0009, 0015 |
| [03 能力装配](architecture/03-capability-assembly.md) | bundle / capability / plugin 三层装配（服务端持有） | 装配流程；状态类能力文件态；工具注册 | 0015, 0017 |
| [04 扁平系统提示词](architecture/04-flat-system-prompt.md) | 单一扁平缓冲区，三层顺序拼接 | permissionFragment；系统消息持久化 | 0015（supersedes 0008/0010） |
| [05 内置 Agent Loop](architecture/05-agent-loop.md) | 流式 loop + 暂停/恢复状态机 | 轮次编排；auto 内联 / ask 暂停；jsonl 即 loop 状态 | 0011, 0015 |
| [06 工具映射](architecture/06-tools-ai-sdk.md) | ToolSpec（zod）→ AI SDK `tool()` | 注册时转换，无 execute 暴露 | 0015 |
| [07 安全模型](architecture/07-security.md) | readonly/workspace/fullaccess + 工具自决 | denylist 底线；级别持久化到 `session.config`；`/level` | 0007, 0009, 0015, 0016 |
| [08 会话持久化](architecture/08-session-persistence.md) | append-only jsonl + replay + resume | 行 schema；SessionStore 原语；**jsonl 事件模型（lifecycle events：turn/tool_call/tool_result/system_prompt 四族 + 未闭合区间推导）**；slash 命令 | 0002, 0006, 0016, 0018 |
| [09 界面与服务端](architecture/09-server-web-tui.md) | 共享运行时服务端 + web/tui 双接入端 | 心跳租约；流式 loop / 工具批准；工作区；观测性 | 0011, 0012, 0017 |
| [10 LLM 配置](architecture/10-llm-config.md) | settings.json multi-provider + 双层配置 | general 块；级联公式；`.env` 密钥 | 0004, 0014, 0016 |
| [11 仓库布局](architecture/11-repo-layout.md) | 包/应用/脚本/文档结构 | build-first；`pnpm verify` | 0003 |
| [12 待确认项](architecture/12-open-questions.md) | 未决问题清单 | SessionContext 结构等 | — |

## 术语

术语与已锁定决策的单一事实来源是仓库根 `CONTEXT.md`；各 ADR 见 `docs/adr/`。