# 08: TUI slash 命令全集

**What to build:** TUI 内会话全生命周期：六个 core 内置 slash 命令映射（`/new standard|base` 缺省 standard、`/resume <id>`、`/sessions`、`/config`、`/level`、`/help`）+ `/exit`；命令映射抽成纯函数（输入 → 动作+参数校验）单测；会话切换后消息流重新 hydrate。v1 不做 web 专属操作（置顶/重命名/归档/搜索）——列表只读展示标题。

**Blocked by:** 05（契约冻结点）。

**Status:** ready-for-agent

- [ ] 六内置命令全部可用（走服务端 API 对应语义：`/level` 写 session.config、`/resume` 切会话等）；`/new` mode 参数校验（base|standard，非法拒绝）
- [ ] 命令映射纯函数单测（含非法命令、缺参、mode 校验）
- [ ] 会话切换后消息流正确 hydrate；`/sessions` 展示工作区会话（标题只读）
- [ ] 手工 E2E：/new standard → 对话 → /sessions → /resume → /level 往返
- [ ] `pnpm -r verify` 绿