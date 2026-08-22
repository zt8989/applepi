# 08: TUI slash 命令全集

**What to build:** TUI 内会话全生命周期：六个 core 内置 slash 命令映射（`/new standard|base` 缺省 standard、`/resume <id>`、`/sessions`、`/config`、`/level`、`/help`）+ `/exit`；命令映射抽成纯函数（输入 → 动作+参数校验）单测；会话切换后消息流重新 hydrate。v1 不做 web 专属操作（置顶/重命名/归档/搜索）——列表只读展示标题。

**Blocked by:** 05（契约冻结点）。

**Status:** resolved

- [x] 六内置命令全部可用：`/new [base|standard]`（新会话、清空上下文、mode 只随新会话请求）、`/resume <id>`（GET hydrate → 重建历史 + 续会话）、`/sessions`（当前 cwd 工作区会话列表，标题只读）、`/config`（模型/provider/推理档）、`/level <level>`（PATCH 会话 config，校验三值）、`/help`、`/exit`
- [x] 命令映射纯函数单测（commands.mjs 2 项：六命令映射 + 非法形态 error 化），非法命令/缺参不抛错、给具体提示
- [x] 会话切换 hydrate 正确（用户/助手文本 + 工具调用/结果折叠进历史）
- [x] `pnpm -r verify` 绿（22 套件 EXIT 0）
- 手工 E2E（真实终端往返）留待用户环境